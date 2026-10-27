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
import { createSessionResourcesRoute } from './sessionResources.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/**
 * Same footing as the stats test: the relay path runs a real `DaemonClient`
 * against the stub, so the request the daemon receives is built by the SDK
 * rather than by this file.
 */
async function mountGateway(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.get('/session/:id/resources', createSessionResourcesRoute(daemon));
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
    sessionResources: async () => {
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
  await createSessionResourcesRoute(daemon)(req, res, () => {});
  return { status: res.code, body: res.body };
}

type ResourcesBody = {
  sessionId: string;
  skills: { skills: Array<Record<string, unknown>> };
  mcp: {
    servers: Array<Record<string, unknown>>;
    clientCount: number;
    clientBudget: number;
    budgetMode: string;
  };
};

describe('GET /session/:id/resources', () => {
  it('relays the loaded skills and MCP servers untouched', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/resources`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResourcesBody;
    // Nothing is re-derived on the way through: every name and number is the
    // daemon's, including the disabled ones it chose to report.
    expect(body.sessionId).toBe(SID);
    expect(body.skills.skills.map((s) => s.name)).toEqual([
      'pdf',
      'quiet-skill',
    ]);
    expect(body.skills.skills[1]).toMatchObject({
      level: 'bundled',
      modelInvocable: false,
      disabledReason: 'default',
    });
    expect(body.mcp.servers.map((s) => s.name)).toEqual([
      'playwright',
      'sleepy',
    ]);
    expect(body.mcp.servers[1]).toMatchObject({
      mcpStatus: 'disconnected',
      transport: 'sse',
      disabled: true,
    });
    expect(body.mcp.clientCount).toBe(2);
    expect(body.mcp.clientBudget).toBe(4);
    expect(body.mcp.budgetMode).toBe('enforce');
  });

  it('passes through the absence of the authentication fields without filling it in', async () => {
    // The type says these name-keyed fields are always absent on this route and
    // that a consumer must not read their absence as a negative authentication
    // state (sdk-typescript/src/daemon/types.ts:2526-2533). This asserts the
    // relay neither invents them nor replaces them with its own verdict, which
    // is what would let a page claim a working server is unauthorised.
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/resources`);
    const server = ((await res.json()) as ResourcesBody).mcp.servers[0];
    for (const field of [
      'hasOAuthTokens',
      'requiresAuth',
      'authenticationState',
      'authenticationError',
    ]) {
      expect(server).not.toHaveProperty(field);
    }
  });

  it('carries the watched id through to the daemon', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    await fetch(`${url}/session/${SID}/resources`);
    expect(stub.lastResourcesSessionId).toBe(SID);
  });

  it('404s a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/zzz-not-a-valid-id/resources`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
    // The local check is only real if nothing left the process.
    expect(stub.lastResourcesSessionId).toBeUndefined();
  });

  it('relays a daemon 404 as a missing conversation, not a missing capability', async () => {
    // `session_resources` is advertised since v1, so there is no daemon version
    // without this route. The recap read's `recap_unsupported` must NOT be
    // copied here: doing so would report a gone conversation as an old daemon.
    stub = await startStubDaemon({ resourcesStatusCode: 404 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/resources`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
  });

  it('says session_not_loaded when the pool no longer holds the session', async () => {
    // The pool drops its session-to-daemon map when a session dies, and this
    // payload is built from a live session's Config, so there is nothing to
    // report. A 404 would tell the operator to stop looking for a conversation
    // that is still on disk.
    const out = await callRoute(
      fakeDaemon({ thrown: new UnknownSessionError(SID) }),
    );
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: 'Open this conversation before reading its resources',
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
