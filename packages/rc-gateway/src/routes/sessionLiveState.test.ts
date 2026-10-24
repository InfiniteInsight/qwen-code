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
import { WorkspacePoolFullError, type SessionDaemon } from '../daemonPool.js';
import { createSessionLiveStateRoute } from './sessionLiveState.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/**
 * The route calls the pool method `getSessionLiveState`; a bare `DaemonClient`
 * names that same call `getWorkspaceSessionLiveState`. The adapter delegates to
 * a real client rather than standing in for one, so the URL the daemon receives
 * is still the one the SDK built, which is the thing worth proving.
 */
function relayThroughClient(client: DaemonClient): SessionDaemon {
  return {
    getSessionLiveState: (workspaceCwd?: string) =>
      client.getWorkspaceSessionLiveState(
        workspaceCwd ?? '/default/proj',
      ) as unknown as Promise<unknown>,
  } as unknown as SessionDaemon;
}

async function mountGateway(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.get('/rc/sessions/live-state', createSessionLiveStateRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function getJson(
  base: string,
  url: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + url);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** A daemon that records what it was called with, for the target and the
 * thrown verdicts a live client cannot produce. */
function fakeDaemon(behaviour: { result?: unknown; thrown?: unknown } = {}): {
  daemon: SessionDaemon;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const daemon = {
    getSessionLiveState: async (workspaceCwd?: string) => {
      calls.push([workspaceCwd]);
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return behaviour.result ?? { v: 1, sessions: [] };
    },
  } as unknown as SessionDaemon;
  return { daemon, calls };
}

/** Start the stub and hand back both it and a client pointed at it. */
async function liveStub(
  opts: Parameters<typeof startStubDaemon>[0] = {},
): Promise<SessionDaemon> {
  stub = await startStubDaemon(opts);
  return relayThroughClient(new DaemonClient({ baseUrl: stub.baseUrl }));
}

describe('workspace session live-state (#111)', () => {
  it('relays the snapshot with the version tokens of the daemon intact', async () => {
    const daemon = await liveStub();
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(base, '/rc/sessions/live-state');
    expect(status).toBe(200);
    // `v` and `catalogVersion` are equality tokens a caller compares against
    // the snapshot it already holds, so they must arrive exactly as issued.
    expect(body['v']).toBe(1);
    expect(body['catalogVersion']).toEqual({ generation: 'g-1', revision: 7 });
  });

  it('carries every live session field, including the two waiting flags', async () => {
    const daemon = await liveStub();
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(base, '/rc/sessions/live-state');
    expect(status).toBe(200);
    const sessions = body['sessions'] as Array<Record<string, unknown>>;
    expect(sessions[0]).toEqual({
      sessionId: 's-live',
      clientCount: 2,
      hasActivePrompt: true,
      activeWorkState: 'active',
      isWaitingForPermission: false,
      isWaitingForUserQuestion: false,
      updatedAt: '2026-10-24T20:00:00.000Z',
    });
  });

  it('leaves an absent activeWorkState absent for an older daemon', async () => {
    // The field is documented absent against an older daemon. Filling it in
    // here would report a verdict the daemon never gave.
    const daemon = await liveStub({
      liveStateResult: {
        v: 1,
        catalogVersion: { generation: 'g-2', revision: 1 },
        sessions: [
          {
            sessionId: 's-old',
            clientCount: 1,
            hasActivePrompt: false,
            isWaitingForPermission: false,
            isWaitingForUserQuestion: false,
          },
        ],
      },
    });
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(base, '/rc/sessions/live-state');
    expect(status).toBe(200);
    const sessions = body['sessions'] as Array<Record<string, unknown>>;
    expect('activeWorkState' in sessions[0]).toBe(false);
    expect('updatedAt' in sessions[0]).toBe(false);
  });

  it('names the requested workspace on the daemon', async () => {
    const daemon = await liveStub();
    const base = await mountGateway(daemon);
    const { status } = await getJson(
      base,
      '/rc/sessions/live-state?workspace=%2Fother%2Fproj',
    );
    expect(status).toBe(200);
    expect(stub!.lastLiveStateWorkspace).toBe('/other/proj');
  });

  it('hands the workspace target to the pool as its argument', async () => {
    const { daemon, calls } = fakeDaemon();
    const base = await mountGateway(daemon);
    const { status } = await getJson(
      base,
      '/rc/sessions/live-state?workspace=%2Fother%2Fproj',
    );
    expect(status).toBe(200);
    expect(calls[0]).toEqual(['/other/proj']);
  });

  it('passes no target when the caller named none', async () => {
    const { daemon, calls } = fakeDaemon();
    const base = await mountGateway(daemon);
    const { status } = await getJson(base, '/rc/sessions/live-state');
    expect(status).toBe(200);
    // `undefined` is the pool signal for the default workspace, not a path.
    expect(calls[0]).toEqual([undefined]);
  });

  it('refuses a repeated workspace param rather than guessing', async () => {
    const { daemon, calls } = fakeDaemon();
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(
      base,
      '/rc/sessions/live-state?workspace=%2Fa&workspace=%2Fb',
    );
    expect(status).toBe(400);
    expect(body['code']).toBe('invalid_workspace');
    // The guard has to run before the daemon is touched, not after.
    expect(calls).toEqual([]);
  });

  it('calls a daemon that advertises the tag without the route unsupported', async () => {
    // The daemon note says released builds advertise
    // `workspace_session_live_state` WITHOUT serving this route, so a bare 404
    // is the expected answer from exactly such a build, and it is not a
    // transport failure: a caller must be able to stop polling it.
    const daemon = await liveStub({ liveStateStatus: 404 });
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(base, '/rc/sessions/live-state');
    expect(status).toBe(502);
    expect(body['code']).toBe('live_state_unsupported');
  });

  it('relays a 404 that does carry an error kind as itself', async () => {
    const daemon = await liveStub({
      liveStateStatus: 404,
      liveStateErrorBody: { errorKind: 'workspace_unknown', error: 'no such' },
    });
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(base, '/rc/sessions/live-state');
    expect(status).toBe(404);
    expect(body['code']).toBe('workspace_unknown');
  });

  it('relays the per workspace trust refusal instead of flattening it', async () => {
    // The route stays subject to the trust check even when the tag is
    // advertised. Flattening a 403 into a 502 would tell a caller to give up on
    // a workspace it could use once granted.
    const daemon = await liveStub({
      liveStateStatus: 403,
      liveStateErrorBody: { errorKind: 'workspace_untrusted', error: 'no' },
    });
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(base, '/rc/sessions/live-state');
    expect(status).toBe(403);
    expect(body['code']).toBe('workspace_untrusted');
  });

  it('reports an unreachable daemon as unavailable, not unsupported', async () => {
    // A transport death carries no HTTP status at all. Reading it as a missing
    // route would make the caller stop polling a daemon that is merely
    // restarting, which is the opposite of the right answer.
    const { daemon } = fakeDaemon({
      thrown: Object.assign(new Error('fetch failed'), { name: 'TypeError' }),
    });
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(base, '/rc/sessions/live-state');
    expect(status).toBe(502);
    expect(body['code']).toBe('daemon_unavailable');
  });

  it('answers 503 when a non default workspace cannot be spawned', async () => {
    const { daemon } = fakeDaemon({ thrown: new WorkspacePoolFullError(3) });
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(
      base,
      '/rc/sessions/live-state?workspace=%2Fother%2Fproj',
    );
    expect(status).toBe(503);
    expect(body['code']).toBe('workspace_pool_full');
  });
});
