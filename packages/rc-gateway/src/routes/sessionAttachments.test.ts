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
  createAttachmentUploadRoute,
  gateJsonBody,
  rawAttachmentBody,
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
): Promise<string> {
  const app = express();
  app.use(gateJsonBody(express.json()));
  app.post(
    '/session/:id/attachments',
    rawAttachmentBody,
    createAttachmentUploadRoute(daemon, audit),
  );
  app.get('/session/:id/attachments', createAttachmentListRoute(daemon));
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
    // The reference is the daemon's, relayed rather than re-described.
    const attachment = res.body['attachment'] as Record<string, unknown>;
    expect(attachment['attachmentId']).toBe('att-1');

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
    expect(body['attachments']).toEqual([
      { attachmentId: 'att-1', name: 'log.txt', size: 12 },
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
