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
import { createSessionTurnCurrentRoute } from './sessionTurnCurrent.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/**
 * The relay path runs a real `DaemonClient` against the stub, so the URL the
 * daemon receives is built by the SDK's own `getCurrentSessionTurn` and not by
 * the test: a gateway-invented method name would be undefined here.
 */
async function mountGateway(
  daemon: Pick<SessionDaemon, 'getCurrentSessionTurn'>,
): Promise<string> {
  const app = express();
  app.get('/session/:id/turns/current', createSessionTurnCurrentRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';

// A real BridgeTurnStatus for a running turn (packages/acp-bridge
// bridgeTypes.ts): no phase, no tool list, only identity and clock.
const RUNNING = {
  sessionId: SID,
  state: 'running',
  promptId: 'prompt-7',
  promptText: 'refactor the widget factory',
  queuedAt: 1_767_225_600_000,
  startedAt: 1_767_225_601_500,
};

function fakeDaemon(thrown: unknown): Pick<SessionDaemon, 'getCurrentSessionTurn'> {
  return {
    getCurrentSessionTurn: async () => {
      throw thrown;
    },
  };
}

describe('GET /session/:id/turns/current', () => {
  it('relays the running turn the daemon reported, field for field', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj', currentTurn: RUNNING });
    const url = await mountGateway(new DaemonClient({ baseUrl: stub.baseUrl }));

    const res = await fetch(`${url}/session/${SID}/turns/current`);
    expect(res.status).toBe(200);
    // Untouched: the daemon owns this vocabulary, and a re-summary would drop
    // whatever it adds next.
    expect(await res.json()).toEqual(RUNNING);
    expect(stub.currentTurnReads).toBe(1);
  });

  it('relays an idle session as the daemon says it, not as an error', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const url = await mountGateway(new DaemonClient({ baseUrl: stub.baseUrl }));

    const res = await fetch(`${url}/session/${SID}/turns/current`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: SID, state: 'idle' });
  });

  it('rejects a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const url = await mountGateway(new DaemonClient({ baseUrl: stub.baseUrl }));

    const res = await fetch(`${url}/session/not-an-id/turns/current`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      'session_not_found',
    );
    expect(stub.currentTurnReads).toBe(0);
  });

  it('reports a daemon that predates the route as unsupported, not as a missing session', async () => {
    stub = await startStubDaemon({
      workspaceCwd: '/proj',
      currentTurnStatusCode: 404,
    });
    const url = await mountGateway(new DaemonClient({ baseUrl: stub.baseUrl }));

    const res = await fetch(`${url}/session/${SID}/turns/current`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe(
      'turns_unsupported',
    );
  });

  it('keeps a daemon session_not_found a 404', async () => {
    const url = await mountGateway(
      fakeDaemon(
        new DaemonHttpError(
          404,
          { error: 'gone', code: 'session_not_found' },
          'gone',
        ),
      ),
    );
    const res = await fetch(`${url}/session/${SID}/turns/current`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      'session_not_found',
    );
  });

  it('says session_not_loaded when the pool no longer holds the session', async () => {
    const url = await mountGateway(fakeDaemon(new UnknownSessionError(SID)));
    const res = await fetch(`${url}/session/${SID}/turns/current`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      'session_not_loaded',
    );
  });

  it('falls through to 502 for a daemon failure that is not a verdict', async () => {
    const url = await mountGateway(
      fakeDaemon(new DaemonHttpError(500, {}, 'boom')),
    );
    const res = await fetch(`${url}/session/${SID}/turns/current`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Daemon unavailable',
      code: 'daemon_unavailable',
    });
  });
});
