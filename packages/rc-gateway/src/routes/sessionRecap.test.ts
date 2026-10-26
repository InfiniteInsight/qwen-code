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
import { createSessionRecapRoute } from './sessionRecap.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/**
 * The relay path runs a real `DaemonClient` against the stub, so the request
 * the daemon receives is built by the SDK's own `recapSession` rather than by
 * the test. That is the difference between proving the daemon was asked about
 * the watched conversation and proving only that this file called something.
 */
async function mountGateway(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.post('/session/:id/recap', createSessionRecapRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';
// Text the daemon derived from the conversation. It must never reach the audit
// record, so it has to be something a passing assertion can search for.
const SECRET_RECAP =
  'decided to halt the anodising line pending a vendor reply';

function recorder() {
  const entries: Array<Record<string, unknown>> = [];
  const audit = {
    record: async (e: Record<string, unknown>) => {
      entries.push(e);
    },
  } as unknown as AuditRecorder;
  return { audit, entries };
}

/** A daemon that answers with a chosen outcome, for the verdicts a live
 * client cannot produce (the pool having dropped the session). */
function fakeDaemon(
  behaviour: { result?: unknown; thrown?: unknown } = {},
): SessionDaemon {
  return {
    recapSession: async () => {
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return behaviour.result ?? { sessionId: SID, recap: SECRET_RECAP };
    },
  } as unknown as SessionDaemon;
}

async function callRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  params: Record<string, string> = { id: SID },
) {
  const res = {
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  } as unknown as express.Response & { code?: number; body?: unknown };
  const req = {
    params,
    query: {},
    rcClient: { id: 'tok_test' },
  } as unknown as express.Request;
  await createSessionRecapRoute(daemon, audit)(req, res, () => {});
  return { status: res.code, body: res.body };
}

describe('POST /session/:id/recap', () => {
  it('relays the recap pair the daemon served', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/recap`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The pair arrives as the daemon wrote it. A gateway that re-stamped the
    // session id, or replaced a sentence with its own summary, would leave the
    // reader unable to tell which conversation the sentence describes.
    expect(body.sessionId).toBe(SID);
    expect(typeof body.recap).toBe('string');
    expect((body.recap as string).length).toBeGreaterThan(0);
  });

  it('asks the daemon about the session the caller named', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/recap`, { method: 'POST' });
    expect(res.status).toBe(200);
    // What the daemon was actually asked about. Anything else here means the
    // gateway recapped a different conversation than the one in the URL.
    expect(stub.lastRecapSessionId).toBe(SID);
  });

  it('keeps a null recap a 200, not a failure', async () => {
    // The core helper is best-effort: a conversation too short to summarise,
    // an unextractable answer and a model failure all answer `recap: null`.
    // The gateway cannot tell those apart, so it relays the pair untouched
    // rather than inventing an error the daemon did not raise.
    stub = await startStubDaemon({
      workspaceCwd: '/proj',
      recapResult: { sessionId: SID, recap: null },
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/recap`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.recap).toBeNull();
  });

  it('reports an old daemon as unsupported, not as a missing conversation', async () => {
    // A daemon from before this route existed answers 404. Saying
    // `session_not_found` would send the reader to look for a conversation
    // that is still there.
    stub = await startStubDaemon({
      workspaceCwd: '/proj',
      recapStatusCode: 404,
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/recap`, { method: 'POST' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('recap_unsupported');
  });

  it('rejects a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/not-an-id/recap`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('session_not_found');
    // A malformed id must never cost a model call.
    expect(stub.lastRecapSessionId).toBeUndefined();
  });

  it('says session_not_loaded when the pool no longer holds the session', async () => {
    const out = await callRoute(
      fakeDaemon({ thrown: new UnknownSessionError(SID) }),
    );
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: 'Open this conversation before asking for its recap',
      code: 'session_not_loaded',
    });
  });

  it('passes a daemon rejection that is not a missing route through', async () => {
    // The daemon refusing the request (rate limit inside the daemon, bad
    // session state) is its verdict, not the gateway's.
    const out = await callRoute(
      fakeDaemon({ thrown: new DaemonHttpError(429, {}, 'slow down') }),
    );
    expect(out.status).toBe(429);
    expect(out.body).toEqual({
      error: 'Daemon rejected the recap request',
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

  it('audits the sentence by naming the session, never the sentence', async () => {
    const { audit, entries } = recorder();
    const out = await callRoute(fakeDaemon(), audit);
    expect(out.status).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'session_recap_generated',
      actorTokenId: 'tok_test',
      target: SID,
    });
    // The summary is a reduction of the conversation. The record may say that
    // one was produced and about which session; it may not carry what it said.
    expect(JSON.stringify(entries[0])).not.toContain(SECRET_RECAP);
  });

  it('writes no audit row when the daemon had nothing to say', async () => {
    // `recap: null` is not an achievement worth recording, and a row per
    // failed attempt would be a record of the model being unreliable rather
    // than of anyone having read anything.
    const { audit, entries } = recorder();
    const out = await callRoute(
      fakeDaemon({ result: { sessionId: SID, recap: null } }),
      audit,
    );
    expect(out.status).toBe(200);
    expect(entries).toHaveLength(0);
  });
});
