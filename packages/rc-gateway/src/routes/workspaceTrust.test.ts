/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-ws-trust-'));
  auditPath = join(runtimeBase, 'audit.log');
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  await rm(runtimeBase, { recursive: true, force: true });
});

interface Ctx {
  baseUrl: string;
  stub: StubDaemon;
  writeToken: string;
  ownerToken: string;
  store: TokenStore;
}

async function setup(
  stubOpts: Parameters<typeof startStubDaemon>[0] = {},
): Promise<Ctx> {
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
    store,
  };
}

function authed(token: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function auditRows(): Promise<Array<Record<string, unknown>>> {
  const dateKey = new Date().toISOString().slice(0, 10);
  let text: string;
  try {
    text = await readFile(join(runtimeBase, `audit-${dateKey}.log`), 'utf8');
  } catch (err) {
    // No record was ever written → the file does not exist yet.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('GET /rc/workspace/trust', () => {
  it('write token reads the v1 status → 200 passthrough', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      v: 1,
      effective: { state: 'trusted', source: 'explicit' },
    });
  });

  it('?statusVersion=2 is passed through to the daemon', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/trust?statusVersion=2`,
      {
        headers: authed(ctx.writeToken),
      },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).v).toBe(2);
  });

  it('?statusVersion=3 → 400 invalid_status_version (no daemon call)', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/trust?statusVersion=3`,
      {
        headers: authed(ctx.writeToken),
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_status_version');
    expect(body.allowed).toEqual([1, 2]);
  });

  it('daemon 404 → 502 trust_unsupported', async () => {
    const ctx = await setup({ workspaceTrustStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('trust_unsupported');
  });
});

describe('POST /rc/workspace/trust/request', () => {
  it('write token → 403 scope_required, daemon not called', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust/request`, {
      method: 'POST',
      headers: authed(ctx.writeToken),
      body: JSON.stringify({ desiredState: 'untrusted' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_required');
    expect(ctx.stub.lastTrustRequestBody).toBeUndefined();
  });

  it('owner token → 202 passthrough, audit row with desiredState', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust/request`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({
        desiredState: 'trusted',
        reason: 'CI sandbox',
      }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      accepted: true,
      desiredState: 'trusted',
      requiresOperatorAction: true,
    });
    expect(ctx.stub.lastTrustRequestBody).toEqual({
      desiredState: 'trusted',
      reason: 'CI sandbox',
    });

    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_trust_requested',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toEqual({
      desiredState: 'trusted',
      reason: 'CI sandbox',
    });
  });

  it('reason is omitted from the daemon body and audit when absent', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust/request`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({ desiredState: 'untrusted' }),
    });
    expect(res.status).toBe(202);
    expect(ctx.stub.lastTrustRequestBody).toEqual({
      desiredState: 'untrusted',
    });
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_trust_requested',
    );
    expect(rows[0].detail).toEqual({ desiredState: 'untrusted' });
  });

  it('unknown desiredState → 400 invalid_desired_state (no daemon call)', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust/request`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({ desiredState: 'maybe' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_desired_state');
    expect(body.allowed).toEqual(['trusted', 'untrusted']);
    expect(ctx.stub.lastTrustRequestBody).toBeUndefined();
  });

  it('non-string reason → 400 invalid_reason (no daemon call)', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust/request`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({ desiredState: 'trusted', reason: 42 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_reason');
    expect(ctx.stub.lastTrustRequestBody).toBeUndefined();
  });

  it('daemon 403 (folder_trust_disabled) passes through with its message', async () => {
    const ctx = await setup({
      trustRequestStatus: 403,
      trustRequestErrorBody: {
        code: 'folder_trust_disabled',
        error: 'Folder trust is disabled on this daemon',
      },
    });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust/request`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({ desiredState: 'trusted' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('folder_trust_disabled');
    expect(body.error).toBe('Folder trust is disabled on this daemon');
  });

  it('daemon transport failure → 502 daemon_unavailable (no audit row)', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust/request`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({ desiredState: 'trusted' }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_trust_requested',
    );
    expect(rows).toHaveLength(0);
  });
});

describe('workspace target (rc-workspace-scoping, #28)', () => {
  it('GET rejects a repeated (array) workspace query param with 400 invalid_workspace', async () => {
    // 404 stub status proves the daemon was never reached: a daemon call
    // would surface as 502 trust_unsupported, not the parse 400.
    const ctx = await setup({ workspaceTrustStatus: 404 });
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/trust?workspace=a&workspace=b`,
      {
        headers: authed(ctx.writeToken),
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_workspace');
    expect(body.error).toBe('Invalid workspace target');
  });

  it('GET accepts a valid non-default workspace target', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/trust?workspace=${encodeURIComponent('/proj/a')}`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(200);
  });

  it('GET with an empty workspace string still targets the default', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust?workspace=`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
  });

  it('POST rejects a non-string workspace with 400 invalid_workspace (no daemon call)', async () => {
    const ctx = await setup();
    for (const workspace of [42, true, null, ['x'], { cwd: '/x' }]) {
      const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust/request`, {
        method: 'POST',
        headers: authed(ctx.ownerToken),
        body: JSON.stringify({ desiredState: 'trusted', workspace }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_workspace');
    }
    expect(ctx.stub.lastTrustRequestBody).toBeUndefined();
  });

  it('POST for a non-default target audits detail.workspace', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust/request`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({
        desiredState: 'trusted',
        workspace: '/proj/a',
      }),
    });
    expect(res.status).toBe(202);
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_trust_requested',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({
      desiredState: 'trusted',
      workspace: '/proj/a',
    });
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
    ownerToken: string;
  }> {
    const pool = new DaemonPool({
      defaultDaemon: {
        async capabilities() {
          return { workspaceCwd: '/home/evan' };
        },
        async workspaceTrust() {
          return {
            v: 1,
            effective: { state: 'trusted', source: 'explicit' },
          };
        },
        async requestWorkspaceTrustChange() {
          return {
            accepted: true,
            desiredState: 'trusted',
            requiresOperatorAction: true,
          };
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
    const { token: ownerToken } = await store.issue(['owner'], 'o');
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
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      writeToken,
      ownerToken,
    };
  }

  it('POST for a new workspace at pool cap → 503 workspace_pool_full (default target unaffected)', async () => {
    const ctx = await setupPoolAtCap();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/trust/request`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({ desiredState: 'trusted', workspace: '/proj/b' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('workspace_pool_full');
    expect(body.error).toBe('Workspace daemon pool is full (max 1)');
    // The default workspace is not pooled — it stays reachable at cap.
    const ok = await fetch(`${ctx.baseUrl}/rc/workspace/trust`, {
      headers: authed(ctx.writeToken),
    });
    expect(ok.status).toBe(200);
  });
});
