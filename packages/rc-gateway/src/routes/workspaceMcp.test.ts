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
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-ws-mcp-'));
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

function postMcp(baseUrl: string, token: string, body: unknown) {
  return fetch(`${baseUrl}/rc/workspace/mcp/servers`, {
    method: 'POST',
    headers: authed(token),
    body: JSON.stringify(body),
  });
}

describe('GET /rc/workspace/mcp', () => {
  it('write token reads the MCP status → 200 passthrough', async () => {
    const ctx = await setup({
      workspaceMcpResult: {
        v: 1,
        workspaceCwd: '/stub/workspace',
        initialized: true,
        servers: [{ name: 'memory', status: 'connected' }],
        clientCount: 1,
      },
    });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/mcp`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      servers: [{ name: 'memory', status: 'connected' }],
    });
  });

  it('daemon 404 → 502 mcp_unsupported', async () => {
    const ctx = await setup({ workspaceMcpStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/mcp`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('mcp_unsupported');
  });

  it('daemon transport failure → 502 daemon_unavailable', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/mcp`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });
});

describe('POST /rc/workspace/mcp/reload', () => {
  it('write token → 403 scope_required, daemon not called', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/mcp/reload`, {
      method: 'POST',
      headers: authed(ctx.writeToken),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_required');
    expect(ctx.stub.lastMcpReloadBody).toBeUndefined();
  });

  it('owner token → 200, audit row with no detail', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/mcp/reload`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });

    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_mcp_reloaded',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toBeUndefined();
  });

  it('daemon 404 → 502 mcp_unsupported (no audit row)', async () => {
    const ctx = await setup({ mcpReloadStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/mcp/reload`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('mcp_unsupported');
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_mcp_reloaded',
    );
    expect(rows).toHaveLength(0);
  });
});

describe('POST /rc/workspace/mcp/servers', () => {
  it('write token → 403 scope_required, daemon not called', async () => {
    const ctx = await setup();
    const res = await postMcp(ctx.baseUrl, ctx.writeToken, {
      operation: 'set',
      name: 'memory',
      config: { command: 'npx', args: ['-y', 'memory-mcp'] },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_required');
    expect(ctx.stub.lastSetSettingBody).toBeUndefined();
  });

  it('owner token sets a server → 200, config forwarded, audit carries NAME ONLY', async () => {
    const ctx = await setup();
    const config = {
      command: 'npx',
      args: ['-y', 'memory-mcp'],
      env: { MEMORY_API_TOKEN: 'super-secret-token' },
    };
    const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
      operation: 'set',
      name: 'memory',
      config,
    });
    expect(res.status).toBe(200);

    // The daemon received the full config plus the mutation metadata.
    expect(ctx.stub.lastSetSettingBody).toEqual({
      scope: 'workspace',
      key: 'mcpServers',
      value: config,
      mcpServerMutation: { operation: 'set', name: 'memory' },
    });

    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_mcp_server_set',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toEqual({ name: 'memory' });
    // Credential material must never reach the audit log.
    const raw = JSON.stringify(rows[0]);
    expect(raw).not.toContain('super-secret-token');
    expect(raw).not.toContain('memory-mcp');
  });

  it('owner token removes a server → 200, value is {} (non-null), audit name only', async () => {
    const ctx = await setup();
    const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
      operation: 'remove',
      name: 'memory',
      config: { command: 'should-be-ignored' },
    });
    expect(res.status).toBe(200);
    expect(ctx.stub.lastSetSettingBody).toEqual({
      scope: 'workspace',
      key: 'mcpServers',
      value: {},
      mcpServerMutation: { operation: 'remove', name: 'memory' },
    });
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_mcp_server_removed',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toEqual({ name: 'memory' });
  });

  it('unknown operation → 400 invalid_operation (no daemon call)', async () => {
    const ctx = await setup();
    const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
      operation: 'restart',
      name: 'memory',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_operation');
    expect(body.allowed).toEqual(['set', 'remove']);
    expect(ctx.stub.lastSetSettingBody).toBeUndefined();
  });

  it('blank / non-string name → 400 invalid_server_name (no daemon call)', async () => {
    const ctx = await setup();
    for (const name of ['', '   ', 42]) {
      const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
        operation: 'remove',
        name,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_server_name');
    }
    expect(ctx.stub.lastSetSettingBody).toBeUndefined();
  });

  it('set with non-object config → 400 invalid_config (no daemon call)', async () => {
    const ctx = await setup();
    for (const config of [null, 'stdio', ['array']]) {
      const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
        operation: 'set',
        name: 'memory',
        config,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_config');
    }
    expect(ctx.stub.lastSetSettingBody).toBeUndefined();
  });

  it('remove with a non-object config is accepted (config is ignored)', async () => {
    const ctx = await setup();
    const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
      operation: 'remove',
      name: 'memory',
      config: 'whatever',
    });
    expect(res.status).toBe(200);
  });

  it('daemon 400 passes through unchanged', async () => {
    const ctx = await setup({
      setWorkspaceSettingStatus: 400,
      setWorkspaceSettingBody: {
        code: 'mcp_config_invalid',
        error: 'Server config failed schema validation',
      },
    });
    const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
      operation: 'set',
      name: 'memory',
      config: { command: 'npx' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('mcp_config_invalid');
    expect(body.error).toBe('Server config failed schema validation');
  });

  it('daemon 404 → 502 mcp_unsupported (no audit row)', async () => {
    const ctx = await setup({ setWorkspaceSettingStatus: 404 });
    const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
      operation: 'set',
      name: 'memory',
      config: { command: 'npx' },
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('mcp_unsupported');
    const rows = (await auditRows()).filter(
      (r) =>
        r.action === 'workspace_mcp_server_set' ||
        r.action === 'workspace_mcp_server_removed',
    );
    expect(rows).toHaveLength(0);
  });

  it('daemon transport failure → 502 daemon_unavailable (no audit row)', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
      operation: 'set',
      name: 'memory',
      config: { command: 'npx' },
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
    const rows = (await auditRows()).filter(
      (r) =>
        r.action === 'workspace_mcp_server_set' ||
        r.action === 'workspace_mcp_server_removed',
    );
    expect(rows).toHaveLength(0);
  });
});

describe('POST /rc/workspace/mcp/servers — optimistic concurrency', () => {
  // Server shape with the full persisted fields the mcpVersion hash reads,
  // plus transient fields that MUST be excluded from the hash.
  const baseMcp = {
    v: 1,
    workspaceCwd: '/stub/workspace',
    initialized: true,
    servers: [
      {
        name: 'memory',
        mcpStatus: 'connected',
        transport: 'stdio',
        configOrigin: 'workspace_settings',
        disabled: false,
        disabledReason: undefined,
        config: { command: 'npx', args: ['-y', 'memory-mcp'] },
        hasOAuthTokens: false,
        requiresAuth: false,
        approvalState: 'approved',
        authenticationState: 'authenticated',
        authenticationError: undefined,
        resourceCount: 5,
      },
    ],
    clientCount: 1,
  };

  it('GET includes a version hash', async () => {
    const ctx = await setup({ workspaceMcpResult: baseMcp });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/mcp`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  it('POST with stale baseVersion → 409 stale_base, daemon not called', async () => {
    const ctx = await setup({ workspaceMcpResult: baseMcp });
    const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
      operation: 'set',
      name: 'memory',
      config: { command: 'uvx', args: ['memory-mcp'] },
      baseVersion: 'stale-hash',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('stale_base');
    expect(typeof body.currentVersion).toBe('string');
    // The daemon's setWorkspaceSetting was never called — the stale base
    // caused the request to be rejected before the mutation.
    expect(ctx.stub.lastSetSettingBody).toBeUndefined();
  });

  it('POST with correct baseVersion → 200, server mutated', async () => {
    const ctx = await setup({ workspaceMcpResult: baseMcp });
    // First GET to obtain the current version hash.
    const getRes = await fetch(`${ctx.baseUrl}/rc/workspace/mcp`, {
      headers: authed(ctx.writeToken),
    });
    const { version } = (await getRes.json()) as { version: string };
    expect(version.length).toBeGreaterThan(0);

    // POST with the fresh baseVersion — should succeed.
    const config = { command: 'uvx', args: ['memory-mcp'] };
    const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
      operation: 'set',
      name: 'memory',
      config,
      baseVersion: version,
    });
    expect(res.status).toBe(200);
    expect(ctx.stub.lastSetSettingBody).toMatchObject({
      scope: 'workspace',
      key: 'mcpServers',
      value: config,
      mcpServerMutation: { operation: 'set', name: 'memory' },
    });
  });

  it('POST with non-string baseVersion → 400 invalid_base_version', async () => {
    const ctx = await setup({ workspaceMcpResult: baseMcp });
    for (const baseVersion of [42, true, null, [], {}]) {
      const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
        operation: 'set',
        name: 'memory',
        config: { command: 'npx' },
        baseVersion,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_base_version');
    }
    expect(ctx.stub.lastSetSettingBody).toBeUndefined();
  });

  it('version is stable across transient fields (mcpStatus, clientCount)', async () => {
    // The stub serves `opts.workspaceMcpResult` by reference, so mutating
    // the object between requests simulates a daemon state change.
    const mcp = JSON.parse(JSON.stringify(baseMcp));
    const ctx = await setup({ workspaceMcpResult: mcp });

    const v1 = await fetch(`${ctx.baseUrl}/rc/workspace/mcp`, {
      headers: authed(ctx.writeToken),
    }).then((r) => r.json() as Promise<{ version: string }>);

    // Flipping transient connection/runtime fields must NOT change the hash.
    mcp.servers[0].mcpStatus = 'reconnecting';
    mcp.servers[0].hasOAuthTokens = true;
    mcp.clientCount = 99;

    const v2 = await fetch(`${ctx.baseUrl}/rc/workspace/mcp`, {
      headers: authed(ctx.writeToken),
    }).then((r) => r.json() as Promise<{ version: string }>);

    expect(v2.version).toBe(v1.version);
  });

  it('version changes when a persisted server field changes', async () => {
    const mcp = JSON.parse(JSON.stringify(baseMcp));
    const ctx = await setup({ workspaceMcpResult: mcp });

    const v1 = await fetch(`${ctx.baseUrl}/rc/workspace/mcp`, {
      headers: authed(ctx.writeToken),
    }).then((r) => r.json() as Promise<{ version: string }>);

    // Toggling `disabled` is a persisted field covered by the hash.
    mcp.servers[0].disabled = true;

    const v2 = await fetch(`${ctx.baseUrl}/rc/workspace/mcp`, {
      headers: authed(ctx.writeToken),
    }).then((r) => r.json() as Promise<{ version: string }>);

    expect(v2.version).not.toBe(v1.version);
  });
});

describe('workspace target (rc-workspace-scoping, #28)', () => {
  it('GET rejects a repeated (array) workspace query param with 400 invalid_workspace', async () => {
    // 404 stub status proves the daemon was never reached: a daemon call
    // would surface as 502 mcp_unsupported, not the parse 400.
    const ctx = await setup({ workspaceMcpStatus: 404 });
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/mcp?workspace=a&workspace=b`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_workspace');
    expect(body.error).toBe('Invalid workspace target');
  });

  it('GET accepts a valid non-default workspace target', async () => {
    const ctx = await setup({
      workspaceMcpResult: {
        v: 1,
        workspaceCwd: '/proj/a',
        initialized: true,
        servers: [],
        clientCount: 0,
      },
    });
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/mcp?workspace=${encodeURIComponent('/proj/a')}`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).workspaceCwd).toBe('/proj/a');
  });

  it('GET with an empty workspace string still targets the default', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/mcp?workspace=`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
  });

  it('reload POST rejects a non-string workspace with 400 invalid_workspace (no daemon call)', async () => {
    const ctx = await setup();
    for (const workspace of [42, true, null, ['x'], { cwd: '/x' }]) {
      const res = await fetch(`${ctx.baseUrl}/rc/workspace/mcp/reload`, {
        method: 'POST',
        headers: authed(ctx.ownerToken),
        body: JSON.stringify({ workspace }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_workspace');
    }
    expect(ctx.stub.lastMcpReloadBody).toBeUndefined();
  });

  it('reload POST for a non-default target audits detail.workspace', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/mcp/reload`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({ workspace: '/proj/a' }),
    });
    expect(res.status).toBe(200);
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_mcp_reloaded',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({ workspace: '/proj/a' });
  });

  it('servers POST for a non-default target audits name + workspace', async () => {
    const ctx = await setup();
    const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
      operation: 'set',
      name: 'memory',
      config: { command: 'npx', args: ['-y', 'memory-mcp'] },
      workspace: '/proj/a',
    });
    expect(res.status).toBe(200);
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_mcp_server_set',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({ name: 'memory', workspace: '/proj/a' });
  });

  it('servers POST rejects a non-string workspace with 400 invalid_workspace (no daemon call)', async () => {
    const ctx = await setup();
    const res = await postMcp(ctx.baseUrl, ctx.ownerToken, {
      operation: 'set',
      name: 'memory',
      config: { command: 'npx' },
      workspace: 42,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_workspace');
    expect(ctx.stub.lastSetSettingBody).toBeUndefined();
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
        async workspaceMcp() {
          return {
            v: 1,
            workspaceCwd: '/home/evan',
            initialized: true,
            servers: [],
            clientCount: 0,
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

  it('GET ?workspace=<new cwd> at pool cap → 503 workspace_pool_full (default target unaffected)', async () => {
    const ctx = await setupPoolAtCap();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/mcp?workspace=${encodeURIComponent('/proj/b')}`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('workspace_pool_full');
    expect(body.error).toBe('Workspace daemon pool is full (max 1)');
    // The default workspace is not pooled — it stays reachable at cap.
    const ok = await fetch(`${ctx.baseUrl}/rc/workspace/mcp`, {
      headers: authed(ctx.writeToken),
    });
    expect(ok.status).toBe(200);
  });

  it('reload POST for a new workspace at pool cap → 503 workspace_pool_full', async () => {
    const ctx = await setupPoolAtCap();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/mcp/reload`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({ workspace: '/proj/b' }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('workspace_pool_full');
  });
});

describe('GET /rc/workspaces (rc-workspace-scoping, #28)', () => {
  it('lists the default cwd (capabilities) plus the pool-held workspaces', async () => {
    // A plain DaemonClient has no workspaces() member → reads as [].
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspaces`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      default: '/stub/workspace',
      workspaces: [],
    });
  });

  it('session:read token → 403 scope_required (WRITE floor)', async () => {
    const ctx = await setup();
    const { token: readToken } = await ctx.store.issue(['session:read'], 'r');
    const res = await fetch(`${ctx.baseUrl}/rc/workspaces`, {
      headers: authed(readToken),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_required');
  });

  it('daemon down → 502 daemon_unavailable', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspaces`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });
});
