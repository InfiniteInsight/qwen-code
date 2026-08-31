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
import { DaemonPool } from '../daemonPool.js';
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

describe('workspace target (rc-workspace-scoping, #28)', () => {
  it('GET rejects a repeated (array) workspace query param with 400 invalid_workspace', async () => {
    // 404 stub status proves the daemon was never reached: a daemon call
    // would surface as 502 settings_unsupported, not the parse 400.
    const ctx = await setup({ workspaceSettingsStatus: 404 });
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/settings?workspace=a&workspace=b`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_workspace');
    expect(body.error).toBe('Invalid workspace target');
  });

  it('GET accepts a valid non-default workspace target', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/settings?workspace=${encodeURIComponent('/proj/a')}`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(200);
  });

  it('GET with an empty workspace string still targets the default', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/settings?workspace=`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
  });
});

describe('workspace target — pool at cap (rc-workspace-scoping, #28)', () => {
  /**
   * A real DaemonPool wired in as the gateway's `daemon` dep: cap of 1
   * with one busy entry (a live session → not evictable), so a NEW
   * workspace target cannot be spawned — the routes must map
   * WorkspacePoolFullError to 503 `workspace_pool_full`, not 502.
   */
  async function setupPoolAtCap(): Promise<{
    baseUrl: string;
    writeToken: string;
  }> {
    const pool = new DaemonPool({
      defaultDaemon: {
        async capabilities() {
          return { workspaceCwd: '/home/evan' };
        },
        async workspaceSettings() {
          return { v: 1, warnings: [], settings: [], disabledTools: [] };
        },
      } as unknown as DaemonClient,
      defaultWorkspaceCwd: '/home/evan',
      maxDaemons: 1,
      idleReapMs: 999_999_999,
      spawn: async (cwd) => ({
        client: {
          async createOrAttachSession() {
            return {
              sessionId: `${cwd}-s`,
              workspaceCwd: cwd,
              attached: false,
            };
          },
        } as unknown as DaemonClient,
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    // Occupy the single pool slot with a busy entry (a live session).
    await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });

    const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
    const { token: writeToken } = await store.issue(['write'], 'w');
    const gw = createGatewayApp({
      daemon: pool,
      store,
      pairing: new PairingService(),
      auditPath,
    });
    server = await new Promise((resolve) => {
      const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, writeToken };
  }

  it('GET ?workspace=<new cwd> at pool cap → 503 workspace_pool_full (default target unaffected)', async () => {
    const ctx = await setupPoolAtCap();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/settings?workspace=${encodeURIComponent('/proj/b')}`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('workspace_pool_full');
    expect(body.error).toBe('Workspace daemon pool is full (max 1)');
    // The default workspace is not pooled — it stays reachable at cap.
    const ok = await fetch(`${ctx.baseUrl}/rc/workspace/settings`, {
      headers: authed(ctx.writeToken),
    });
    expect(ok.status).toBe(200);
  });
});
