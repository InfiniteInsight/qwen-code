/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server-level proof for `GET /rc/llama-swap`, mounted through the REAL
 * `createGatewayApp` (real TokenStore/PairingService/requireScope(OWNER)
 * mount, real stub daemon over HTTP — though this route never calls the
 * daemon). Mirrors the harness in `routes/peers.integration.test.ts`. Proves
 * both states of the conditional mount: `llamaSwapProbe` set → 200 with the
 * probe's body; `llamaSwapProbe` omitted → 404 (route not registered at
 * all, not a 503).
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from './server.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import type { LlamaSwapStatusResponse } from './llama-swap/llamaSwapStatus.js';

let server: Server | undefined;
let runtimeBase: string;
let stub: StubDaemon | undefined;

async function boot(llamaSwapProbe?: () => Promise<LlamaSwapStatusResponse>) {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-llama-swap-'));
  stub = await startStubDaemon();
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
  const { token: owner } = await store.issue(['owner'], 'o');
  const gw = createGatewayApp({
    daemon,
    store,
    pairing: new PairingService(),
    auditPath: join(runtimeBase, 'audit.log'),
    llamaSwapProbe,
  });
  server = await new Promise<Server>((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/rc/llama-swap`;
  return { owner, url };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  if (runtimeBase) await rm(runtimeBase, { recursive: true, force: true });
});

describe('GET /rc/llama-swap', () => {
  it('owner gets 200 with the probe body when llamaSwapProbe is set', async () => {
    const body: LlamaSwapStatusResponse = {
      available: true,
      models: [{ id: 'qwen3-32b', aliases: ['qwen3'], loaded: true }],
    };
    const { owner, url } = await boot(async () => body);
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(body);
  });

  it('404s (route not mounted) when llamaSwapProbe is absent', async () => {
    const { owner, url } = await boot(undefined);
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(r.status).toBe(404);
  });
});
