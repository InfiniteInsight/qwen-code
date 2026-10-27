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
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { createSessionWorktreeResetRoute } from './sessionWorktreeReset.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/**
 * The happy path runs a real `DaemonClient` against the stub, so the request
 * the daemon receives is built by the SDK's own `resetWorktreeSession` and the
 * release by its own `detachSession`. That is what makes these tests evidence:
 * a hand-built fake could pass while sending a body the daemon would reject.
 */
async function mountGateway(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post(
    '/session/:id/worktree-reset',
    createSessionWorktreeResetRoute(daemon),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';

function recorder() {
  const entries: Array<Record<string, unknown>> = [];
  const audit = {
    record: async (e: Record<string, unknown>) => {
      entries.push(e);
    },
  } as unknown as AuditRecorder;
  return { audit, entries };
}

/** A daemon that answers with a chosen outcome, for the verdicts a live stub
 * cannot produce (the pool having dropped the session, a release failing). */
function fakeDaemon(
  behaviour: {
    result?: unknown;
    thrown?: unknown;
    detachThrows?: boolean;
  } = {},
): SessionDaemon {
  return {
    resetWorktreeSession: async () => {
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return behaviour.result ?? { sessionId: SID };
    },
    detachSession: async () => {
      if (behaviour.detachThrows) throw new Error('detach failed');
    },
  } as unknown as SessionDaemon;
}

function fakeReq(
  opts: { params?: Record<string, string> } = {},
): express.Request {
  return {
    params: opts.params ?? { id: SID },
    query: {},
    body: {},
    rcClient: { id: 'tok_test' },
  } as unknown as express.Request;
}

function fakeRes(): express.Response & { code?: number; body?: unknown } {
  const res = {
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res as unknown as express.Response & { code?: number; body?: unknown };
}

async function callRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  sessionId: string = SID,
) {
  const res = fakeRes();
  await createSessionWorktreeResetRoute(daemon, audit)(
    fakeReq({ params: { id: sessionId } }),
    res,
    () => undefined,
  );
  return { status: res.code, body: res.body as Record<string, unknown> };
}

async function reset(
  url: string,
  sessionId: string,
): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${url}/session/${sessionId}/worktree-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe('POST /session/:id/worktree-reset', () => {
  it('relays the replacement id, not the one that was posted', async () => {
    // The whole point of the route and the easiest thing a relay gets wrong:
    // the body is the replacement's create-shape response, so it names a
    // DIFFERENT session. A gateway that echoed the URL id would leave the page
    // watching a conversation that no longer owns the checkout.
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await reset(url, SID);
    expect(out.status).toBe(200);
    expect(stub.lastWorktreeReset?.sessionId).toBe(SID);
    expect(typeof out.body.sessionId).toBe('string');
    expect(out.body.sessionId).not.toBe(SID);
    expect(out.body.supersededSessionId).toBe(SID);
    expect(out.body.changedIdentity).toBe(true);
  });

  it('releases the owner-style registration the transfer mints', async () => {
    // The other half, and the one that leaks silently if forgotten. A fresh
    // transfer registers an owner-style client id on the replacement and
    // nothing detaches it, so a caller that will not keep using it must
    // release it here or the replacement never reaches idle cleanup.
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await reset(url, SID);
    expect(out.status).toBe(200);
    // Exactly one release, naming the replacement and the id the transfer
    // returned - not the superseded session, which would detach the wrong
    // conversation and still leak this one.
    expect(stub.detachCalls).toHaveLength(1);
    expect(stub.detachCalls[0]?.sessionId).toBe(out.body.sessionId);
    expect(typeof stub.detachCalls[0]?.clientId).toBe('string');
    expect(stub.detachCalls[0]?.clientId).toBeTruthy();
    expect(out.body.registrationReleased).toBe(true);
  });

  it('does not hand the minted registration to the caller', async () => {
    // It has just been released, so forwarding it would offer the page a
    // client id that cannot address anything.
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await reset(url, SID);
    expect(out.status).toBe(200);
    expect(out.body.clientId).toBeUndefined();
    expect(JSON.stringify(out.body)).not.toContain('client-owner-style');
  });

  it('releases nothing when the transfer was an idempotent resume', async () => {
    // The second half of the protocol: resuming an already committed transfer
    // returns the same id and no client id, so there is no registration to
    // release. A route that called detach anyway would be guessing.
    stub = await startStubDaemon({
      workspaceCwd: '/proj',
      worktreeResetResult: { sessionId: 's-committed-earlier' },
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await reset(url, SID);
    expect(out.status).toBe(200);
    expect(stub.detachCalls).toHaveLength(0);
    expect(out.body.registrationReleased).toBe(true);
    expect(out.body.changedIdentity).toBe(true);
  });

  it('reports a committed transfer as done when its release fails', async () => {
    // The checkout really did move, so retracting the success would be the
    // bigger lie. What the route may not do is hide the leftover, because the
    // leftover is the leak: hence a 200 that says the release did not happen.
    stub = await startStubDaemon({
      workspaceCwd: '/proj',
      detachStatusCode: 500,
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await reset(url, SID);
    expect(out.status).toBe(200);
    expect(out.body.registrationReleased).toBe(false);
    // And the transfer itself still named the replacement, so the caller can
    // re-run the reset: the committed transfer resumes idempotently and the
    // second attempt is the one that gets to detach.
    expect(out.body.sessionId).not.toBe(SID);
    expect(stub.detachCalls).toHaveLength(1);
  });

  it('tells the three 409 codes apart, because only one clears on retry', async () => {
    // Collapsing these would be the specific harm: one is "wait and try
    // again", one is "this does not apply", and one is "a retry returns the
    // same answer and a person has to look". The daemon sends no reason on the
    // wire, so the code is all this surface has to distinguish them with.
    const unsupported = await callRoute(
      fakeDaemon({
        thrown: new DaemonHttpError(
          409,
          { error: 'Conflict', code: 'worktree_reset_unsupported' },
          'x',
        ),
      }),
    );
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.code).toBe('worktree_reset_unsupported');

    const active = await callRoute(
      fakeDaemon({
        thrown: new DaemonHttpError(
          409,
          { error: 'Conflict', code: 'worktree_reset_active' },
          'x',
        ),
      }),
    );
    expect(active.status).toBe(409);
    expect(active.body.code).toBe('worktree_reset_active');

    const invalid = await callRoute(
      fakeDaemon({
        thrown: new DaemonHttpError(
          409,
          { error: 'Conflict', code: 'worktree_reset_invalid_state' },
          'x',
        ),
      }),
    );
    expect(invalid.status).toBe(409);
    expect(invalid.body.code).toBe('worktree_reset_invalid_state');

    // Three different strings, and the copy that must NOT invite a retry says
    // so out loud.
    expect(
      new Set([unsupported.body.error, active.body.error, invalid.body.error])
        .size,
    ).toBe(3);
    expect(unsupported.body.error).not.toBe(active.body.error);
    expect(invalid.body.error).toContain('a retry returns the same answer');
    expect(active.body.error).toContain('try again');
  });

  it('reads a rejection without asking what class the error is', async () => {
    // `DaemonHttpError` has three distinct identities in this build (separate
    // import and require copies of the daemon entry plus a third from the
    // root), so an `instanceof` guard is a coin flip on which door the thrower
    // came through, and it fails SILENTLY by falling to a plausible fallback.
    // A plain object carrying the same fields must produce the same verdict.
    const structural = await callRoute(
      fakeDaemon({
        thrown: {
          status: 409,
          body: { error: 'Conflict', code: 'worktree_reset_active' },
        },
      }),
    );
    expect(structural.status).toBe(409);
    expect(structural.body.code).toBe('worktree_reset_active');
  });

  it('reports a bare 404 as a conversation that is not loaded', async () => {
    // On a session route a 404 is not evidence the conversation is deleted;
    // the same shape also answers for an owning workspace mid drain, which is
    // reversible.
    const out = await callRoute(
      fakeDaemon({
        thrown: new DaemonHttpError(404, { error: 'Not Found' }, 'x'),
      }),
    );
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: 'This conversation is not answering right now',
      code: 'session_not_loaded',
    });
  });

  it('says session_not_loaded when the pool no longer holds the session', async () => {
    const out = await callRoute(
      fakeDaemon({ thrown: new UnknownSessionError(SID) }),
    );
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: 'Open this conversation before resetting its checkout',
      code: 'session_not_loaded',
    });
  });

  it('passes a daemon rejection that is not in the taxonomy through', async () => {
    const out = await callRoute(
      fakeDaemon({ thrown: new DaemonHttpError(429, {}, 'slow down') }),
    );
    expect(out.status).toBe(429);
    expect(out.body).toEqual({
      error: 'Daemon rejected the checkout handover',
      code: 'daemon_rejected',
    });
  });

  it('falls through to 502 for a daemon failure that is not a verdict', async () => {
    const out = await callRoute(
      fakeDaemon({ thrown: new DaemonHttpError(500, {}, 'boom') }),
    );
    expect(out.status).toBe(502);
    expect(out.body).toEqual({
      error: 'Daemon unavailable',
      code: 'daemon_unavailable',
    });
  });

  it('rejects a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await reset(url, 'not-an-id');
    expect(out.status).toBe(404);
    expect(out.body.code).toBe('session_not_found');
    // A malformed id must never spawn a replacement conversation.
    expect(stub.lastWorktreeReset).toBeUndefined();
  });

  it('sends no workspace of its own, so the daemon uses the owning one', async () => {
    // The route deliberately reads no cwd from the caller and adds none: a
    // caller-named workspace could aim a transfer at a daemon that does not
    // own the checkout. What proves that is the body the daemon received.
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await reset(url, SID);
    expect(out.status).toBe(200);
    const sent = stub.lastWorktreeReset?.body as Record<string, unknown>;
    expect(sent).toEqual({});
    expect(sent.cwd).toBeUndefined();
    expect(sent.workspaceCwd).toBeUndefined();
  });

  it('audits both ids, because the event is one conversation becoming another', async () => {
    const { audit, entries } = recorder();
    const out = await callRoute(
      fakeDaemon({
        result: { sessionId: 's-replacement-9', clientId: 'client-x' },
      }),
      audit,
    );
    expect(out.status).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'session_worktree_reset',
      actorTokenId: 'tok_test',
      target: SID,
      detail: { replacementSessionId: 's-replacement-9' },
    });
    // The minted client id is a registration, not a fact about the event. It
    // has no business in a record that outlives it.
    const row = JSON.stringify(entries[0]);
    expect(row).not.toContain('client-x');
  });

  it('audits a refusal that never became a transfer', async () => {
    // Nothing was written, so nothing is recorded: a rejected handover leaves
    // the checkout where it was, and a row for it would read as if it moved.
    const { audit, entries } = recorder();
    const out = await callRoute(
      fakeDaemon({
        thrown: new DaemonHttpError(
          409,
          { error: 'Conflict', code: 'worktree_reset_active' },
          'x',
        ),
      }),
      audit,
    );
    expect(out.status).toBe(409);
    expect(entries).toHaveLength(0);
  });
});
