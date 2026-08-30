/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';

let server: Server | undefined;
let runtimeBase: string;
let auditPath: string;
let stub: StubDaemon | undefined;

beforeEach(async () => {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-ws-settings-'));
  auditPath = join(runtimeBase, 'audit.log');
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  await rm(runtimeBase, { recursive: true, force: true });
});

async function setup(stubOpts: Parameters<typeof startStubDaemon>[0] = {}) {
  stub = await startStubDaemon(stubOpts);
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
  const { token: writeToken } = await store.issue(['write'], 'w');
  const { token: ownerToken } = await store.issue(['owner'], 'o');

  const gw = createGatewayApp({
    daemon,
    store,
    pairing: new PairingService(),
    auditPath,
  });

  server = await new Promise((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stub,
    writeToken,
    ownerToken,
  };
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('GET /rc/workspace/settings', () => {
  it('write token reads the settings → 200 passthrough with disabledTools', async () => {
    const ctx = await setup({
      workspaceSettingsResult: {
        v: 1,
        warnings: [],
        settings: [],
        disabledTools: ['WebFetch'],
      },
    });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/settings`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      v: 1,
      disabledTools: ['WebFetch'],
    });
  });

  it('owner token can read (owner ⊃ write)', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/settings`, {
      headers: authed(ctx.ownerToken),
    });
    expect(res.status).toBe(200);
  });

  it('daemon 404 → 502 settings_unsupported', async () => {
    const ctx = await setup({ workspaceSettingsStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/settings`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('settings_unsupported');
  });

  it('daemon transport failure → 502 daemon_unavailable', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/settings`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });
});
