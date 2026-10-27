/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { createSessionRenameRoute } from './sessionRename.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { AuditRecorder } from '../auditLog.js';

const SESS = '11111111111111111111111111111111';

interface Captured {
  status?: number;
  body?: Record<string, unknown>;
}

function fakeRes(): { res: Response; captured: Captured } {
  const captured: Captured = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, captured };
}

function recorder() {
  const entries: Array<Record<string, unknown>> = [];
  const audit = {
    record: async (e: Record<string, unknown>) => {
      entries.push(e);
    },
  } as unknown as AuditRecorder;
  return { audit, entries };
}

/**
 * `effective` is what the daemon answers, deliberately separate from the name
 * the route was asked to set. Every test that leaves it unset gets the sent name
 * back, which is the ordinary case; the ones that set it are checking that the
 * reply is the daemon's verdict and not an echo of the request.
 */
function fakeDaemon(
  behaviour: { effective?: Record<string, unknown>; thrown?: unknown } = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  const daemon = {
    updateSessionMetadata: async (
      sessionId: string,
      metadata: Record<string, unknown>,
      clientId?: string,
    ) => {
      calls.push({ sessionId, metadata, clientId });
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return behaviour.effective ?? { displayName: metadata.displayName };
    },
  } as unknown as SessionDaemon;
  return { daemon, calls };
}

async function call(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  params: Record<string, string> = { id: SESS },
  body: unknown = { displayName: 'Fix the flaky test' },
): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = {
    params,
    body,
    rcClient: { id: 'tok_test' },
  } as unknown as Request;
  await createSessionRenameRoute(daemon, audit)(req, res, () => {});
  return captured;
}

describe('PATCH /session/:id/metadata (#110)', () => {
  it('renames and audits, reporting the daemon effective name', async () => {
    const { daemon, calls } = fakeDaemon();
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      displayName: 'Fix the flaky test',
    });
    expect(calls[0]).toMatchObject({
      sessionId: SESS,
      metadata: { displayName: 'Fix the flaky test' },
    });
    expect(entries[0]).toMatchObject({
      action: 'session_renamed',
      actorTokenId: 'tok_test',
      target: SESS,
    });
  });

  it('reports the name the daemon holds, not the name that was sent', async () => {
    // The route's own reply is `{ sessionId, ...effective }`. A gateway that
    // echoed its request would tell the page a title the daemon never agreed
    // to, and the page has no other way to check.
    const { daemon } = fakeDaemon({ effective: { displayName: 'Trimmed' } });
    const out = await call(
      daemon,
      undefined,
      { id: SESS },
      {
        displayName: '  Trimmed  ',
      },
    );
    expect(out.status).toBe(200);
    expect(out.body?.['displayName']).toBe('Trimmed');
  });

  it('does not invent a title when the daemon answers an empty one', async () => {
    const { daemon } = fakeDaemon({ effective: {} });
    const out = await call(daemon);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ sessionId: SESS });
  });

  it('refuses pr instead of dropping it', async () => {
    // The daemon accepts `pr` on the same call and writes pull-request links. A
    // caller whose pr was quietly ignored would believe links had been saved.
    const { daemon, calls } = fakeDaemon();
    const out = await call(
      daemon,
      undefined,
      { id: SESS },
      {
        displayName: 'A title',
        pr: { number: 7 },
      },
    );
    expect(out.status).toBe(400);
    expect(out.body?.['code']).toBe('pr_not_supported');
    expect(calls).toHaveLength(0);
  });

  it('refuses a name over 200 characters without truncating it', async () => {
    // The daemon slices at 256 and the child refuses above 200 without awaiting
    // the write, so 201 to 256 renames the live view and never reaches the
    // transcript this page's list reads. Truncating would store a different
    // title than the one typed, so the only honest answer is a refusal.
    const { daemon, calls } = fakeDaemon();
    const long = 'x'.repeat(201);
    const out = await call(
      daemon,
      undefined,
      { id: SESS },
      {
        displayName: long,
      },
    );
    expect(out.status).toBe(400);
    expect(out.body?.['code']).toBe('display_name_too_long');
    expect(out.body?.['maxLength']).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('accepts a name at exactly the ceiling', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(
      daemon,
      undefined,
      { id: SESS },
      {
        displayName: 'x'.repeat(200),
      },
    );
    expect(out.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['an empty body', {}],
    ['a null body', null],
    ['a name that is not a string', { displayName: 7 }],
    ['a missing name', { note: 'oops' }],
  ])('refuses %s with 400, not 500', async (_label, body) => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, undefined, { id: SESS }, body);
    expect(out.status).toBe(400);
    expect(out.body?.['code']).toBe('invalid_metadata');
    expect(calls).toHaveLength(0);
  });

  it('answers 404 for a malformed session id before any daemon call', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, undefined, { id: 'not-a-session-id' });
    expect(out.status).toBe(404);
    expect(out.body?.['code']).toBe('session_not_found');
    expect(calls).toHaveLength(0);
  });

  it('answers 404 when the session is not loaded', async () => {
    // Both shapes reach this route: the pool's own error when it holds no
    // record of the id, and the daemon 404 marshalled by the SDK.
    for (const thrown of [
      new UnknownSessionError('no such session'),
      new DaemonHttpError(404, { code: 'session_not_found' }, 'gone'),
    ]) {
      const { daemon } = fakeDaemon({ thrown });
      const { audit, entries } = recorder();
      const out = await call(daemon, audit);
      expect(out.status).toBe(404);
      expect(out.body?.['code']).toBe('session_not_found');
      expect(entries[0]).toMatchObject({
        action: 'session_rename_failed',
        detail: { reason: 'not_found' },
      });
    }
  });

  it('answers 400 when the daemon rejects the title itself', async () => {
    // A blank or control-character name is the daemon's rule, so its 400 has to
    // arrive as a 400. Left to the generic catch it would read as the gateway
    // losing its daemon, which sends the reader chasing the wrong thing.
    const { daemon } = fakeDaemon({
      thrown: new DaemonHttpError(
        400,
        { code: 'invalid_metadata', field: 'displayName' },
        'displayName must not be blank',
      ),
    });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(400);
    expect(out.body?.['code']).toBe('invalid_metadata');
    expect(JSON.stringify(out.body)).not.toContain('must not be blank');
    expect(entries[0]).toMatchObject({
      action: 'session_rename_failed',
      detail: { reason: 'rejected' },
    });
  });

  it('answers 502 on a transport failure without echoing the daemon message', async () => {
    const { daemon } = fakeDaemon({
      thrown: new DaemonHttpError(
        500,
        { code: 'boom' },
        'ECONNREFUSED 127.0.0.1:4180 /home/evan/.qwen/workspaces/secret',
      ),
    });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(502);
    expect(out.body?.['code']).toBe('daemon_unavailable');
    expect(JSON.stringify(out.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(out.body)).not.toContain('secret');
    expect(entries[0]).toMatchObject({
      action: 'session_rename_failed',
      detail: { reason: 'daemon_unavailable' },
    });
  });

  it('audits the rename without recording the title text', async () => {
    const { daemon } = fakeDaemon();
    const { audit, entries } = recorder();
    await call(daemon, audit, { id: SESS }, { displayName: 'Project Falcon' });
    expect(JSON.stringify(entries)).not.toContain('Project Falcon');
  });
});

// Separate fixture on purpose. The block above drives a hand-rolled daemon;
// these drive a real DaemonClient, so the method name, the HTTP verb, the path
// and the error shape are whatever the shipped SDK actually does rather than
// whatever this file assumes. `tsconfig.json` excludes test files, so nothing
// else in the build can catch a pool method that names no SDK call.
describe('PATCH /session/:id/metadata against a real client', () => {
  let server: Server | undefined;
  let stub: StubDaemon | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (stub) await stub.close();
    stub = undefined;
  });

  async function mount(stubOpts: Parameters<typeof startStubDaemon>[0] = {}) {
    stub = await startStubDaemon(stubOpts);
    const app = express();
    app.use(express.json());
    app.patch(
      '/session/:id/metadata',
      createSessionRenameRoute(new DaemonClient({ baseUrl: stub!.baseUrl })),
    );
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async function patch(
    base: string,
    sessionId: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}/session/${sessionId}/metadata`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  }

  it('sends the name through the SDK and returns the daemon answer', async () => {
    const base = await mount();
    const out = await patch(base, SESS, { displayName: 'Nightly triage' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      displayName: 'Nightly triage',
    });
    // What actually left the gateway, read off the stub: the SDK's own body,
    // which is the only proof the field name matches the daemon route.
    expect(stub?.lastMetadataBody).toEqual({ displayName: 'Nightly triage' });
  });

  it('returns the daemon name when it differs from what was sent', async () => {
    const base = await mount({
      metadataResult: { displayName: 'Stored name' },
    });
    const out = await patch(base, SESS, { displayName: 'Typed name' });
    expect(out.status).toBe(200);
    expect(out.body?.['displayName']).toBe('Stored name');
  });

  it('maps a daemon with no metadata route to 404, not 502', async () => {
    // A daemon predating this route answers 404, and the bridge answers 404 for
    // a session it has not loaded. Both are "not here", not "the gateway is broken".
    const base = await mount({
      metadataStatus: 404,
      metadataBody: { error: 'no route', code: 'session_not_found' },
    });
    const out = await patch(base, SESS, { displayName: 'Any name' });
    expect(out.status).toBe(404);
    expect(out.body?.['code']).toBe('session_not_found');
  });

  it('maps a daemon refusal of the name to 400', async () => {
    const base = await mount({
      metadataStatus: 400,
      metadataBody: { code: 'invalid_metadata', field: 'displayName' },
    });
    const out = await patch(base, SESS, { displayName: '   ' });
    expect(out.status).toBe(400);
    expect(out.body?.['code']).toBe('invalid_metadata');
  });

  it('maps a daemon fault to 502 without echoing its message', async () => {
    const base = await mount({
      metadataStatus: 500,
      metadataBody: { error: 'ECONNREFUSED /home/evan/.qwen/secret-workspace' },
    });
    const out = await patch(base, SESS, { displayName: 'Any name' });
    expect(out.status).toBe(502);
    expect(out.body?.['code']).toBe('daemon_unavailable');
    expect(JSON.stringify(out.body)).not.toContain('secret-workspace');
  });
});
