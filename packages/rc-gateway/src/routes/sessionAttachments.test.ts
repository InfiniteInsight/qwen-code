/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import {
  createAttachmentListRoute,
  createAttachmentReadRoute,
  createAttachmentRemoveRoute,
  createAttachmentUploadRoute,
  DAEMON_ATTACHMENT_ITEM_BYTES,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  MAX_CONFIGURABLE_ATTACHMENT_BYTES,
  effectiveAttachmentLimit,
  createAttachmentLimitResolver,
  gateJsonBody,
  createRawAttachmentBody,
  parseMaxAttachmentBytes,
  sendAttachmentError,
} from './sessionAttachments.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/**
 * Mounts the two routes behind the same parser arrangement the real server
 * uses (`gateJsonBody(express.json())` ahead of everything), because the
 * arrangement is itself load-bearing: mounted bare, an uploaded JSON file
 * would be parsed and drained before this family's raw parser saw it.
 */
async function mountGateway(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  maxBytes: number | (() => Promise<number>) = DAEMON_ATTACHMENT_ITEM_BYTES,
): Promise<string> {
  const app = express();
  app.use(gateJsonBody(express.json()));
  app.post(
    '/session/:id/attachments',
    createRawAttachmentBody(maxBytes),
    createAttachmentUploadRoute(daemon, audit),
  );
  app.get('/session/:id/attachments', createAttachmentListRoute(daemon));
  app.get(
    '/session/:id/attachments/:attachmentId',
    createAttachmentReadRoute(daemon),
  );
  app.delete(
    '/session/:id/attachments/:attachmentId',
    createAttachmentRemoveRoute(daemon, audit),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A daemon stand-in that records the call and answers on command, for the
 * verdicts a live client cannot produce (a shaped refusal, a thrown error). */
function fakeDaemon(
  behavior: 'throw' | 'ok' = 'ok',
  err?: unknown,
): {
  daemon: SessionDaemon;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const record = (kind: string, args: unknown[]) => {
    calls.push({ kind, args });
  };
  const boom = () => {
    if (behavior === 'throw') throw err ?? new Error('daemon down');
  };
  return {
    calls,
    daemon: {
      uploadSessionAttachment: async (...args: unknown[]) => {
        record('upload', args);
        boom();
        return { attachmentId: 'att-x', name: args[2] };
      },
      listSessionAttachments: async (...args: unknown[]) => {
        record('list', args);
        boom();
        return [{ attachmentId: 'att-x', name: 'log.txt' }];
      },
      readSessionAttachment: async (...args: unknown[]) => {
        record('read', args);
        boom();
        return { data: 'cmF3IHN0dWZm', mimeType: 'text/plain' };
      },
      removeSessionAttachment: async (...args: unknown[]) => {
        record('remove', args);
        boom();
        return true;
      },
    } as unknown as SessionDaemon,
  };
}

/** A daemon-shaped refusal: the fs envelope with its own numeric status. */
function refusal(status: number, body: unknown): Error {
  return Object.assign(new Error('daemon refused'), { status, body });
}

async function postRaw(
  base: string,
  url: string,
  body: BodyInit,
  contentType: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': contentType },
  });
  return { status: res.status, body: await jsonOf(res) };
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

describe('POST /session/:id/attachments', () => {
  it('carries the file, its name and its media type through to the daemon', async () => {
    stub = await startStubDaemon();
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await postRaw(
      base,
      '/session/s-1/attachments?name=crash.log',
      'hello from the phone',
      'text/plain',
    );

    expect(res.status).toBe(201);
    // The reference is the daemon's, relayed rather than re-described. The id
    // is the stored name itself (`attachmentId: name`,
    // acp-bridge/src/sessionAttachments.ts:590), so a gateway that minted its
    // own identifier would fail this rather than pass on it.
    const attachment = res.body['attachment'] as Record<string, unknown>;
    expect(attachment['attachmentId']).toBe('crash.log');

    expect(stub.lastAttachmentUpload).toEqual({
      name: 'crash.log',
      contentType: 'text/plain',
      byteLength: 'hello from the phone'.length,
    });
  });

  it('uploads a file whose own media type is application/json intact', async () => {
    // The reason `gateJsonBody` exists. Mounted bare, the JSON parser claims
    // this request by header, drains the stream, and the upload arrives empty
    // or hangs; nothing about the response would say so.
    stub = await startStubDaemon();
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const payload = JSON.stringify({ level: 'error', msg: 'stack trace' });
    const res = await postRaw(
      base,
      '/session/s-1/attachments?name=report.json',
      payload,
      'application/json',
    );

    expect(res.status).toBe(201);
    expect(stub.lastAttachmentUpload).toEqual({
      name: 'report.json',
      contentType: 'application/json',
      byteLength: payload.length,
    });
  });

  it('refuses a missing name with 400 and never reaches the daemon', async () => {
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon);

    const res = await postRaw(
      base,
      '/session/s-1/attachments',
      'x',
      'text/plain',
    );

    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('invalid_query');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses an empty body with 400', async () => {
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon);

    const res = await postRaw(
      base,
      '/session/s-1/attachments?name=empty.txt',
      new Uint8Array(0),
      'application/octet-stream',
    );

    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('empty_body');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses an oversize file with 413 before buffering it', async () => {
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon);

    // One byte past the client's own 8 MiB ceiling. The parser refuses it, so
    // the daemon is never asked and the caller learns the real reason.
    const res = await postRaw(
      base,
      '/session/s-1/attachments?name=big.bin',
      new Uint8Array(8 * 1024 * 1024 + 1),
      'application/octet-stream',
    );

    expect(res.status).toBe(413);
    expect(res.body['code']).toBe('attachment_too_large');
    expect(fake.calls).toHaveLength(0);
  });

  it('relays the daemon refusal, its status and its kind included', async () => {
    const fake = fakeDaemon(
      'throw',
      refusal(413, {
        errorKind: 'payload_too_large',
        error: 'the daemon says no',
        hint: 'send it in chunks',
      }),
    );
    const base = await mountGateway(fake.daemon);

    const res = await postRaw(
      base,
      '/session/s-1/attachments?name=ok.txt',
      'hello',
      'text/plain',
    );

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: 'the daemon says no',
      code: 'payload_too_large',
      hint: 'send it in chunks',
    });
  });

  it('maps a bare 404 to 502 attachments_unsupported', async () => {
    // No fs envelope means the daemon predates the attachment routes, which is
    // a capability gap rather than an answer about a file.
    const fake = fakeDaemon('throw', refusal(404, { error: 'not found' }));
    const base = await mountGateway(fake.daemon);

    const res = await postRaw(
      base,
      '/session/s-1/attachments?name=ok.txt',
      'hello',
      'text/plain',
    );

    expect(res.status).toBe(502);
    expect(res.body['code']).toBe('attachments_unsupported');
  });

  it('maps a transport failure to 502 daemon_unavailable', async () => {
    const fake = fakeDaemon('throw', new Error('socket hang up'));
    const base = await mountGateway(fake.daemon);

    const res = await postRaw(
      base,
      '/session/s-1/attachments?name=ok.txt',
      'hello',
      'text/plain',
    );

    expect(res.status).toBe(502);
    expect(res.body['code']).toBe('daemon_unavailable');
  });

  it('audits a accepted upload against the session, not the file name', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const audit = {
      record: (entry: Record<string, unknown>) => {
        rows.push(entry);
      },
    } as unknown as AuditRecorder;
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon, audit);

    await postRaw(
      base,
      '/session/s-7/attachments?name=secret-diagram.png',
      'hello',
      'image/png',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ action: 'attachment_uploaded', target: 's-7' });
    // The name is the uploader's own text and stays out of the record.
    expect(JSON.stringify(rows)).not.toContain('secret-diagram');
  });

  it('audits nothing when the upload failed', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const audit = {
      record: (entry: Record<string, unknown>) => {
        rows.push(entry);
      },
    } as unknown as AuditRecorder;
    const fake = fakeDaemon('throw', new Error('socket hang up'));
    const base = await mountGateway(fake.daemon, audit);

    await postRaw(
      base,
      '/session/s-1/attachments?name=ok.txt',
      'hello',
      'text/plain',
    );

    expect(rows).toHaveLength(0);
  });
});

describe('GET /session/:id/attachments', () => {
  it('returns the daemon list untouched', async () => {
    stub = await startStubDaemon();
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await fetch(base + '/session/s-9/attachments');
    const body = await jsonOf(res);

    expect(res.status).toBe(200);
    // The four fields the store builds per entry (:840-846), in its own order:
    // upload order keyed on mtime. There is no `name` field to read; the name
    // IS the attachmentId.
    expect(body['attachments']).toEqual([
      {
        type: 'resource',
        attachmentId: 'log.txt',
        mimeType: 'text/plain',
        size: 12,
      },
    ]);
    expect(stub.lastAttachmentListSessionId).toBe('s-9');
  });

  it('maps a bare 404 to 502 attachments_unsupported', async () => {
    const fake = fakeDaemon('throw', refusal(404, { error: 'no route' }));
    const base = await mountGateway(fake.daemon);

    const res = await fetch(base + '/session/s-1/attachments');
    const body = await jsonOf(res);

    expect(res.status).toBe(502);
    expect(body['code']).toBe('attachments_unsupported');
  });

  it('relays a shaped refusal', async () => {
    const fake = fakeDaemon(
      'throw',
      refusal(403, { errorKind: 'trust_required', error: 'not trusted' }),
    );
    const base = await mountGateway(fake.daemon);

    const res = await fetch(base + '/session/s-1/attachments');
    const body = await jsonOf(res);

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: 'not trusted', code: 'trust_required' });
  });
});

describe('GET /session/:id/attachments/:attachmentId', () => {
  it('relays the stored bytes and the daemon media type untouched', async () => {
    // A media type the gateway could not plausibly have chosen on its own, so
    // an exact match here is evidence of a relay rather than of a re-description.
    stub = await startStubDaemon({
      attachmentReadBody: 'the bytes the phone sent',
      attachmentReadContentType: 'image/png',
    });
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await fetch(base + '/session/s-9/attachments/att-1');
    const body = await jsonOf(res);

    expect(res.status).toBe(200);
    // The pair arrives exactly as the daemon framed it: the gateway neither
    // decodes the payload nor substitutes its own media type.
    expect(body).toEqual({
      data: Buffer.from('the bytes the phone sent').toString('base64'),
      mimeType: 'image/png',
    });
    expect(stub.lastAttachmentRead).toEqual({
      sessionId: 's-9',
      attachmentId: 'att-1',
    });
  });

  it('decodes to the bytes that were stored, not to a re-framed copy', async () => {
    // The base64 has to survive the trip unchanged in both directions: what a
    // viewer hands back to the daemon has to be the file that went in.
    stub = await startStubDaemon({ attachmentReadBody: 'round trip' });
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await fetch(base + '/session/s-9/attachments/att-1');
    const body = await jsonOf(res);

    const data = body['data'] as string;
    expect(Buffer.from(data, 'base64').toString()).toBe('round trip');
    expect(body['mimeType']).toBe('application/octet-stream');
  });

  it('passes the session and the attachment id through as separate arguments', async () => {
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon);

    await fetch(base + '/session/s-42/attachments/att-77');

    expect(fake.calls).toEqual([{ kind: 'read', args: ['s-42', 'att-77'] }]);
  });

  it('maps a bare 404 to 502 attachments_unsupported', async () => {
    // The shared verdict: a daemon with no attachment route at all is a
    // capability gap, not an answer about the file it was asked for.
    const fake = fakeDaemon('throw', refusal(404, { error: 'no route' }));
    const base = await mountGateway(fake.daemon);

    const res = await fetch(base + '/session/s-1/attachments/att-1');
    const body = await jsonOf(res);

    expect(res.status).toBe(502);
    expect(body['code']).toBe('attachments_unsupported');
  });

  it('relays a shaped refusal', async () => {
    const fake = fakeDaemon(
      'throw',
      refusal(403, { errorKind: 'trust_required', error: 'not trusted' }),
    );
    const base = await mountGateway(fake.daemon);

    const res = await fetch(base + '/session/s-1/attachments/att-1');
    const body = await jsonOf(res);

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: 'not trusted', code: 'trust_required' });
  });

  it('maps a transport failure to 502 daemon_unavailable', async () => {
    const fake = fakeDaemon('throw', new Error('socket hang up'));
    const base = await mountGateway(fake.daemon);

    const res = await fetch(base + '/session/s-1/attachments/att-1');
    const body = await jsonOf(res);

    expect(res.status).toBe(502);
    expect(body['code']).toBe('daemon_unavailable');
  });

  it('audits nothing, because a read names neither a path nor a payload', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const audit = {
      record: (entry: Record<string, unknown>) => {
        rows.push(entry);
      },
    } as unknown as AuditRecorder;
    stub = await startStubDaemon();
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
      audit,
    );

    const res = await fetch(base + '/session/s-9/attachments/att-1');

    expect(res.status).toBe(200);
    expect(rows).toHaveLength(0);
  });
});

describe('DELETE /session/:id/attachments/:attachmentId', () => {
  it('removes the file the daemon confirms it removed', async () => {
    stub = await startStubDaemon();
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await fetch(base + '/session/s-9/attachments/att-1', {
      method: 'DELETE',
    });
    const body = await jsonOf(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({ removed: true });
    expect(stub.lastAttachmentRemove).toEqual({
      sessionId: 's-9',
      attachmentId: 'att-1',
    });
  });

  it('keeps a second tap a 200 when the daemon found nothing to remove', async () => {
    // The daemon answered, it did not refuse. Reporting that as a fault would
    // tell the caller something broke when all that happened is that the file
    // was already gone.
    stub = await startStubDaemon({ attachmentRemoveResult: false });
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await fetch(base + '/session/s-9/attachments/att-1', {
      method: 'DELETE',
    });
    const body = await jsonOf(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({ removed: false });
  });

  it('audits the deletion against the session, not the file id', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const audit = {
      record: (entry: Record<string, unknown>) => {
        rows.push(entry);
      },
    } as unknown as AuditRecorder;
    stub = await startStubDaemon();
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
      audit,
    );

    const res = await fetch(base + '/session/s-7/attachments/att-9', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ action: 'attachment_removed', target: 's-7' });
    // The id is the daemon's own key and says nothing a reader could act on.
    expect(JSON.stringify(rows)).not.toContain('att-9');
  });

  it('audits nothing when the removal failed', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const audit = {
      record: (entry: Record<string, unknown>) => {
        rows.push(entry);
      },
    } as unknown as AuditRecorder;
    const fake = fakeDaemon('throw', new Error('socket hang up'));
    const base = await mountGateway(fake.daemon, audit);

    await fetch(base + '/session/s-1/attachments/att-1', {
      method: 'DELETE',
    });

    expect(rows).toHaveLength(0);
  });

  it('relays a shaped refusal without auditing it', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const audit = {
      record: (entry: Record<string, unknown>) => {
        rows.push(entry);
      },
    } as unknown as AuditRecorder;
    const fake = fakeDaemon(
      'throw',
      refusal(409, {
        errorKind: 'attachment_in_use',
        error: 'the file is open',
        hint: 'stop the run first',
      }),
    );
    const base = await mountGateway(fake.daemon, audit);

    const res = await fetch(base + '/session/s-1/attachments/att-1', {
      method: 'DELETE',
    });
    const body = await jsonOf(res);

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error: 'the file is open',
      code: 'attachment_in_use',
      hint: 'stop the run first',
    });
    expect(rows).toHaveLength(0);
  });

  it('maps a bare 404 to 502 attachments_unsupported', async () => {
    stub = await startStubDaemon({
      attachmentRemoveStatus: 404,
      attachmentRemoveErrorBody: { error: 'no route' },
    });
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await fetch(base + '/session/s-9/attachments/att-1', {
      method: 'DELETE',
    });
    const body = await jsonOf(res);

    expect(res.status).toBe(502);
    expect(body['code']).toBe('attachments_unsupported');
  });
});

describe('the configurable size limit (#196)', () => {
  it('reads the limit it is given for both the parser and the 413 text', async () => {
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon, undefined, 1000);

    const ok = await postRaw(
      base,
      '/session/s-1/attachments?name=a.bin',
      new Uint8Array(1000),
      'application/octet-stream',
    );
    expect(ok.status).toBe(201);

    const over = await postRaw(
      base,
      '/session/s-1/attachments?name=a.bin',
      new Uint8Array(1001),
      'application/octet-stream',
    );
    expect(over.status).toBe(413);
    expect(over.body['code']).toBe('attachment_too_large');
    expect(String(over.body['error'])).toContain('1000');
    // Refused at the boundary: the daemon never saw the second one.
    expect(fake.calls.filter((c) => c['kind'] === 'upload')).toHaveLength(1);
  });

  it('accepts a body above the old 8 MiB when the limit was raised', async () => {
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon, undefined, 12 * 1024 * 1024);
    const res = await postRaw(
      base,
      '/session/s-1/attachments?name=photo.jpg',
      new Uint8Array(9 * 1024 * 1024),
      'image/jpeg',
    );
    expect(res.status).toBe(201);
  });

  it("answers the SDK's own RangeError as 413, not as a dead daemon", () => {
    let status = 0;
    let body: unknown;
    const res = {
      headersSent: false,
      status(n: number) {
        status = n;
        return this;
      },
      json(b: unknown) {
        body = b;
        return this;
      },
    };
    sendAttachmentError(
      res as unknown as Parameters<typeof sendAttachmentError>[0],
      new RangeError('Session attachments must not exceed 8 MiB'),
    );
    expect(status).toBe(413);
    expect((body as { code: string }).code).toBe('attachment_too_large');
  });
});

describe('parseMaxAttachmentBytes', () => {
  it('defaults to 25 MiB when unset', () => {
    expect(DEFAULT_MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(parseMaxAttachmentBytes('--max-attachment-bytes', undefined)).toBe(
      undefined,
    );
  });

  it('accepts a positive integer up to 100 MiB inclusive', () => {
    expect(parseMaxAttachmentBytes('--max-attachment-bytes', '1')).toBe(1);
    expect(parseMaxAttachmentBytes('--max-attachment-bytes', '104857600')).toBe(
      MAX_CONFIGURABLE_ATTACHMENT_BYTES,
    );
  });

  it.each(['0', '-5', '1.5', 'abc', '', '104857601', '1e3', ' '])(
    'rejects %j',
    (raw) => {
      expect(() =>
        parseMaxAttachmentBytes('--max-attachment-bytes', raw),
      ).toThrow(/--max-attachment-bytes/);
    },
  );
});

describe('effectiveAttachmentLimit', () => {
  it("never promises more than the daemon's own per-file cap", () => {
    expect(effectiveAttachmentLimit(undefined)).toBe(
      Math.min(DEFAULT_MAX_ATTACHMENT_BYTES, DAEMON_ATTACHMENT_ITEM_BYTES),
    );
    expect(effectiveAttachmentLimit(1000)).toBe(1000);
    expect(effectiveAttachmentLimit(MAX_CONFIGURABLE_ATTACHMENT_BYTES)).toBe(
      DAEMON_ATTACHMENT_ITEM_BYTES,
    );
  });
});

describe('effectiveAttachmentLimit follows the daemon-advertised cap', () => {
  const MIB = 1024 * 1024;

  it('holds the configured limit to the cap the daemon advertises', () => {
    expect(effectiveAttachmentLimit(undefined, 32 * MIB)).toBe(
      DEFAULT_MAX_ATTACHMENT_BYTES,
    );
    expect(effectiveAttachmentLimit(64 * MIB, 32 * MIB)).toBe(32 * MIB);
    expect(effectiveAttachmentLimit(undefined, 2 * MIB)).toBe(2 * MIB);
    expect(effectiveAttachmentLimit(1000, 32 * MIB)).toBe(1000);
  });

  it('falls back to 8 MiB when the daemon advertises nothing usable', () => {
    for (const bad of [undefined, 0, -1, Number.NaN, 1.5]) {
      expect(effectiveAttachmentLimit(64 * MIB, bad)).toBe(8 * MIB);
    }
  });
});

describe('createAttachmentLimitResolver', () => {
  const MIB = 1024 * 1024;
  const caps = (cap?: number) =>
    ({
      features: [],
      ...(cap === undefined
        ? {}
        : { limits: { maxSessionAttachmentItemBytes: cap } }),
    }) as never;

  it('reads the cap from the daemon capabilities and caches it', async () => {
    let calls = 0;
    const resolve = createAttachmentLimitResolver(64 * MIB, async () => {
      calls += 1;
      return caps(32 * MIB);
    });
    expect(await resolve()).toBe(32 * MIB);
    expect(await resolve()).toBe(32 * MIB);
    expect(calls).toBe(1);
  });

  it('re-reads after the cache expires, so a restarted daemon is followed', async () => {
    let now = 0;
    let cap = 16 * MIB;
    const resolve = createAttachmentLimitResolver(
      64 * MIB,
      async () => caps(cap),
      { ttlMs: 1000, now: () => now },
    );
    expect(await resolve()).toBe(16 * MIB);
    cap = 24 * MIB;
    now = 999;
    expect(await resolve()).toBe(16 * MIB);
    now = 1001;
    expect(await resolve()).toBe(24 * MIB);
  });

  it('uses 8 MiB for an old daemon that advertises nothing', async () => {
    const resolve = createAttachmentLimitResolver(64 * MIB, async () => caps());
    expect(await resolve()).toBe(8 * MIB);
  });

  it('keeps the last known cap when a later read fails, and uses 8 MiB if there never was one', async () => {
    let now = 0;
    let fail = false;
    const resolve = createAttachmentLimitResolver(
      64 * MIB,
      async () => {
        if (fail) throw new Error('down');
        return caps(32 * MIB);
      },
      { ttlMs: 10, now: () => now },
    );
    expect(await resolve()).toBe(32 * MIB);
    fail = true;
    now = 100;
    expect(await resolve()).toBe(32 * MIB);

    const never = createAttachmentLimitResolver(64 * MIB, async () => {
      throw new Error('down');
    });
    expect(await never()).toBe(8 * MIB);
  });
});

describe('createRawAttachmentBody with a resolved limit', () => {
  it('accepts a body above 8 MiB when the resolver reports a larger cap', async () => {
    const fake = fakeDaemon();
    const base = await mountGateway(
      fake.daemon,
      undefined,
      (async () => 12 * 1024 * 1024) as never,
    );
    const res = await postRaw(
      base,
      '/session/s-1/attachments?name=photo.jpg',
      new Uint8Array(9 * 1024 * 1024),
      'image/jpeg',
    );
    expect(res.status).toBe(201);
  });

  it('refuses above the resolved cap and names that number', async () => {
    const fake = fakeDaemon();
    const base = await mountGateway(
      fake.daemon,
      undefined,
      (async () => 1000) as never,
    );
    const res = await postRaw(
      base,
      '/session/s-1/attachments?name=a.bin',
      new Uint8Array(1001),
      'application/octet-stream',
    );
    expect(res.status).toBe(413);
    expect(String(res.body['error'])).toContain('1000');
    expect(fake.calls.filter((c) => c['kind'] === 'upload')).toHaveLength(0);
  });
});
