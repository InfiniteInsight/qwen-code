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
import { createSessionStatsRoute } from './sessionStats.js';

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
 * the daemon receives is built by the SDK rather than by this file. That is the
 * difference between proving the roll-up arrives and proving only that this
 * file passes a call to something.
 */
async function mountGateway(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.get('/session/:id/stats', createSessionStatsRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';

/**
 * A daemon that answers with a chosen outcome, for the verdicts a live client
 * cannot produce - chiefly `UnknownSessionError`, which the pool raises before
 * any request leaves the process.
 */
function fakeDaemon(
  behaviour: { result?: unknown; thrown?: unknown } = {},
): SessionDaemon {
  return {
    sessionStats: async () => {
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return behaviour.result ?? {};
    },
  } as unknown as SessionDaemon;
}

async function callRoute(
  daemon: SessionDaemon,
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
  const req = { params } as unknown as express.Request;
  await createSessionStatsRoute(daemon)(req, res, () => {});
  return { status: res.code, body: res.body };
}

describe('GET /session/:id/stats', () => {
  it('relays the roll-up the panel reads, untouched', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      promptCount: number;
      durationMs: number;
      models: Record<string, { tokens: { total: number } }>;
      tools: { totalCalls: number; totalFail: number };
      files: { totalLinesAdded: number; totalLinesRemoved: number };
    };
    // Nothing is re-derived on the way through: every number is the stub's.
    expect(body.sessionId).toBe(SID);
    expect(body.promptCount).toBe(7);
    expect(body.durationMs).toBe(5_400_000);
    expect(body.models['qwen3-coder:30b'].tokens.total).toBe(128_000);
    expect(body.tools.totalCalls).toBe(12);
    expect(body.tools.totalFail).toBe(2);
    expect(body.files).toEqual({ totalLinesAdded: 140, totalLinesRemoved: 22 });
  });

  it('carries the watched id through to the daemon', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    await fetch(`${url}/session/${SID}/stats`);
    expect(stub.lastStatsSessionId).toBe(SID);
  });

  it('404s a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/zzz-not-a-valid-id/stats`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
    // The local check is only real if nothing left the process.
    expect(stub.lastStatsSessionId).toBeUndefined();
  });

  it('relays a daemon 404 as a missing conversation, not a missing capability', async () => {
    // `session_stats` is advertised since v1, so there is no daemon version
    // without this route. The recap read's `recap_unsupported` must NOT be
    // copied here: doing so would report a gone conversation as an old daemon.
    stub = await startStubDaemon({ statsStatusCode: 404 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/stats`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
  });

  it('says session_not_loaded when the pool no longer holds the session', async () => {
    // The pool drops its session-to-daemon map when a session dies, while the
    // roll-up is built from data on disk. A 404 here would tell the operator
    // to stop looking for a conversation that is still there.
    const out = await callRoute(
      fakeDaemon({ thrown: new UnknownSessionError(SID) }),
    );
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: 'Open this conversation before reading its stats',
      code: 'session_not_loaded',
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
});
