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
import { createSessionContextUsageRoute } from './sessionContextUsage.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

async function mountGateway(daemon: DaemonClient): Promise<string> {
  const app = express();
  app.get('/session/:id/context-usage', createSessionContextUsageRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';

describe('GET /session/:id/context-usage', () => {
  it('relays the fill the footer needs (totalTokens against contextWindowSize)', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/context-usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      usage: { totalTokens: number; contextWindowSize: number };
    };
    expect(body.sessionId).toBe(SID);
    expect(body.usage.totalTokens).toBe(65536);
    expect(body.usage.contextWindowSize).toBe(262144);
  });

  it('does not ask the daemon for the detail lists by default', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/context-usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usage: { showDetails: boolean; builtinTools: unknown[] };
    };
    // The stub echoes the flag it was asked for, so false here is proof the
    // gateway did not forward a detail request the caller never made.
    expect(body.usage.showDetails).toBe(false);
    expect(body.usage.builtinTools).toEqual([]);
  });

  it('passes ?detail=true through to the daemon', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/context-usage?detail=true`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usage: { showDetails: boolean } };
    expect(body.usage.showDetails).toBe(true);
  });

  it('404s a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/zzz-not-a-valid-id/context-usage`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ contextUsageStatusCode: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/context-usage`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('daemon_unavailable');
  });
});
