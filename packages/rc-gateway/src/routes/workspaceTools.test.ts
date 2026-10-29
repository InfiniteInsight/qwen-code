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
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-ws-tools-'));
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

function toggle(
  baseUrl: string,
  token: string,
  name: string,
  enabled: unknown,
) {
  return fetch(
    `${baseUrl}/rc/workspace/tools/${encodeURIComponent(name)}/enable`,
    {
      method: 'POST',
      headers: authed(token),
      body: JSON.stringify({ enabled }),
    },
  );
}

describe('POST /rc/workspace/tools/:name/enable', () => {
  it('write token → 403 scope_required, daemon not called', async () => {
    const ctx = await setup();
    const res = await toggle(ctx.baseUrl, ctx.writeToken, 'WebFetch', false);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_required');
    expect(ctx.stub.lastToolToggleBody).toBeUndefined();
  });

  it('owner token disables a tool → 200, audit row {toolName, enabled}', async () => {
    const ctx = await setup();
    const res = await toggle(ctx.baseUrl, ctx.ownerToken, 'WebFetch', false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ toolName: 'WebFetch', enabled: false });
    expect(ctx.stub.lastToolToggleName).toBe('WebFetch');
    expect(ctx.stub.lastToolToggleBody).toEqual({ enabled: false });

    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_tool_enabled',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toEqual({ toolName: 'WebFetch', enabled: false });
  });

  it('owner token re-enables a tool → 200 with enabled true', async () => {
    const ctx = await setup();
    const res = await toggle(ctx.baseUrl, ctx.ownerToken, 'Bash', true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ toolName: 'Bash', enabled: true });
  });

  it('non-boolean enabled → 400 invalid_enabled_flag (no daemon call)', async () => {
    const ctx = await setup();
    const res = await toggle(ctx.baseUrl, ctx.ownerToken, 'Bash', 'nope');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_enabled_flag');
    expect(ctx.stub.lastToolToggleBody).toBeUndefined();
  });

  it('missing enabled → 400 invalid_enabled_flag (no daemon call)', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/tools/Bash/enable`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_enabled_flag');
  });

  it('daemon 400 passes through unchanged (daemon-side validation)', async () => {
    const ctx = await setup({
      toolToggleStatusByName: { WebFetch: 400 },
      toolToggleBody: {
        code: 'unknown_tool',
        error: 'Tool WebFetch is not a known built-in tool',
      },
    });
    const res = await toggle(ctx.baseUrl, ctx.ownerToken, 'WebFetch', false);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('unknown_tool');
    expect(body.error).toBe('Tool WebFetch is not a known built-in tool');
  });

  it('per-name status override applies to the targeted tool only', async () => {
    const ctx = await setup({
      toolToggleStatusByName: { WebFetch: 400 },
      toolToggleBody: { code: 'unknown_tool', error: 'nope' },
    });
    const bad = await toggle(ctx.baseUrl, ctx.ownerToken, 'WebFetch', false);
    expect(bad.status).toBe(400);
    const ok = await toggle(ctx.baseUrl, ctx.ownerToken, 'Bash', false);
    expect(ok.status).toBe(200);
  });

  it('daemon 404 → 502 tools_unsupported', async () => {
    const ctx = await setup({ toolToggleStatus: 404 });
    const res = await toggle(ctx.baseUrl, ctx.ownerToken, 'Bash', false);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('tools_unsupported');
  });

  it('daemon transport failure → 502 daemon_unavailable (no audit row)', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await toggle(ctx.baseUrl, ctx.ownerToken, 'Bash', false);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_tool_enabled',
    );
    expect(rows).toHaveLength(0);
  });
});

describe('GET /rc/workspace/tools', () => {
  function getCatalog(ctx: Ctx, token?: string) {
    return fetch(`${ctx.baseUrl}/rc/workspace/tools`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  it("write token → 200 with the daemon catalog plus each tool's state", async () => {
    const ctx = await setup();
    const res = await getCatalog(ctx, ctx.writeToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      v: 1,
      tools: [
        {
          name: 'web_fetch',
          displayName: 'Web Fetch',
          disabled: false,
          source: 'builtin',
          state: 'on',
        },
        {
          name: 'write_file',
          displayName: 'Write File',
          disabled: true,
          source: 'builtin',
          state: 'disabled',
        },
      ],
    });
  });

  it('owner token → 200 (owner implies write)', async () => {
    const ctx = await setup();
    const res = await getCatalog(ctx, ctx.ownerToken);
    expect(res.status).toBe(200);
    expect((await res.json()).v).toBe(1);
  });

  it('session:read token → 403 scope_required', async () => {
    const ctx = await setup();
    const { token: readToken } = await ctx.store.issue(['session:read'], 'r');
    const res = await getCatalog(ctx, readToken);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_required');
  });

  it('no token → 401', async () => {
    const ctx = await setup();
    const res = await getCatalog(ctx);
    expect(res.status).toBe(401);
  });

  it('custom catalog (MCP entry) passes through with its state', async () => {
    const ctx = await setup({
      workspaceToolsResult: {
        v: 1,
        tools: [{ name: 'mcp__search__lookup', disabled: true, source: 'mcp' }],
      },
    });
    const res = await getCatalog(ctx, ctx.writeToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      v: 1,
      tools: [
        {
          name: 'mcp__search__lookup',
          disabled: true,
          source: 'mcp',
          state: 'disabled',
        },
      ],
    });
  });

  it('daemon 404 → 502 tools_unsupported', async () => {
    const ctx = await setup({ workspaceToolsStatus: 404 });
    const res = await getCatalog(ctx, ctx.writeToken);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('tools_unsupported');
  });

  it('daemon transport failure → 502 daemon_unavailable', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await getCatalog(ctx, ctx.writeToken);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('read-only: no workspace_tool_enabled audit row', async () => {
    const ctx = await setup();
    const res = await getCatalog(ctx, ctx.writeToken);
    expect(res.status).toBe(200);
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_tool_enabled',
    );
    expect(rows).toHaveLength(0);
  });
});

/**
 * #141. `todo_write` and `list_directory` are opt-in built-ins: registered
 * only when `tools.todoWrite.enabled` / `tools.listDirectory.enabled` is
 * true, so the `tools.disabled` list cannot turn them on. The listing names
 * the gate and the enable route writes it.
 */
describe('opt-in built-in tools (#141)', () => {
  const entry = (name: string, disabled = false) => ({
    name,
    displayName: name,
    disabled,
    source: 'builtin' as const,
  });
  const settingsOf = (todo: boolean, ls: boolean) => ({
    v: 1,
    settings: [
      { key: 'tools.todoWrite.enabled', values: { effective: todo } },
      { key: 'tools.listDirectory.enabled', values: { effective: ls } },
    ],
    disabledTools: [],
  });
  const fixture = (over: {
    todo?: boolean;
    ls?: boolean;
    todoDisabled?: boolean;
  }) => ({
    workspaceToolsResult: {
      v: 1,
      tools: [
        entry('list_directory'),
        entry('todo_write', over.todoDisabled ?? false),
        entry('web_fetch'),
        entry('write_file', true),
      ],
    },
    workspaceSettingsResult: settingsOf(over.todo ?? false, over.ls ?? true),
  });

  async function getTools(ctx: Ctx) {
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/tools`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      tools: Array<{
        name: string;
        state: string;
        optIn?: { setting: string; enabled: boolean };
      }>;
    };
  }

  it('listing marks todo_write opt-in with its setting path; a plain tool is on, a listed one disabled', async () => {
    const ctx = await setup(fixture({}));
    const { tools } = await getTools(ctx);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.todo_write.state).toBe('optIn');
    expect(by.todo_write.optIn).toEqual({
      setting: 'tools.todoWrite.enabled',
      enabled: false,
    });
    expect(by.web_fetch.state).toBe('on');
    expect(by.web_fetch.optIn).toBeUndefined();
    expect(by.write_file.state).toBe('disabled');
  });

  it('an opt-in tool whose setting is on reads on and still names its setting', async () => {
    const ctx = await setup(fixture({}));
    const { tools } = await getTools(ctx);
    const ls = tools.find((t) => t.name === 'list_directory')!;
    expect(ls.state).toBe('on');
    expect(ls.optIn).toEqual({
      setting: 'tools.listDirectory.enabled',
      enabled: true,
    });
  });

  it('a workspace-disabled opt-in tool reads disabled, whatever its setting', async () => {
    const ctx = await setup(fixture({ todoDisabled: true }));
    const { tools } = await getTools(ctx);
    const todo = tools.find((t) => t.name === 'todo_write')!;
    expect(todo.state).toBe('disabled');
    expect(todo.optIn?.enabled).toBe(false);
  });

  it('a settings read that fails fails the listing instead of calling a gated tool on', async () => {
    const ctx = await setup({ ...fixture({}), workspaceSettingsStatus: 500 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/tools`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('enabling todo_write writes tools.todoWrite.enabled=true at workspace scope, alone, and says new conversations', async () => {
    const ctx = await setup(fixture({}));
    const res = await toggle(ctx.baseUrl, ctx.ownerToken, 'todo_write', true);
    expect(res.status).toBe(200);
    expect(ctx.stub.setSettingBodies).toEqual([
      { scope: 'workspace', key: 'tools.todoWrite.enabled', value: true },
    ]);
    // Not in the disabled list, so that list is not touched.
    expect(ctx.stub.lastToolToggleBody).toBeUndefined();
    const body = await res.json();
    expect(body).toMatchObject({
      toolName: 'todo_write',
      enabled: true,
      optIn: {
        setting: 'tools.todoWrite.enabled',
        appliesTo: 'new_sessions',
        daemonReloadRequired: false,
      },
    });
    expect(typeof body.optIn.note).toBe('string');
    expect(body.optIn.note).toMatch(/new conversation/i);
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_tool_enabled',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({
      toolName: 'todo_write',
      enabled: true,
      setting: 'tools.todoWrite.enabled',
    });
  });

  it('enabling an opt-in tool that is also in the disabled list clears the list as well', async () => {
    const ctx = await setup(fixture({ todoDisabled: true }));
    const res = await toggle(ctx.baseUrl, ctx.ownerToken, 'todo_write', true);
    expect(res.status).toBe(200);
    expect(ctx.stub.lastToolToggleName).toBe('todo_write');
    expect(ctx.stub.lastToolToggleBody).toEqual({ enabled: true });
    expect(ctx.stub.setSettingBodies).toEqual([
      { scope: 'workspace', key: 'tools.todoWrite.enabled', value: true },
    ]);
  });

  it('disabling an opt-in tool flips the setting back to false and leaves the disabled list alone', async () => {
    const ctx = await setup(fixture({ todo: true }));
    const res = await toggle(ctx.baseUrl, ctx.ownerToken, 'todo_write', false);
    expect(res.status).toBe(200);
    expect(ctx.stub.setSettingBodies).toEqual([
      { scope: 'workspace', key: 'tools.todoWrite.enabled', value: false },
    ]);
    expect(ctx.stub.lastToolToggleBody).toBeUndefined();
    expect((await res.json()).enabled).toBe(false);
  });

  it('list_directory is gated by tools.listDirectory.enabled the same way', async () => {
    const ctx = await setup(fixture({ ls: false }));
    const res = await toggle(
      ctx.baseUrl,
      ctx.ownerToken,
      'list_directory',
      true,
    );
    expect(res.status).toBe(200);
    expect(ctx.stub.setSettingBodies).toEqual([
      { scope: 'workspace', key: 'tools.listDirectory.enabled', value: true },
    ]);
  });

  it('a plain built-in still goes only through the disabled list: no settings write, same body', async () => {
    const ctx = await setup(fixture({}));
    const res = await toggle(ctx.baseUrl, ctx.ownerToken, 'web_fetch', false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ toolName: 'web_fetch', enabled: false });
    expect(ctx.stub.lastToolToggleBody).toEqual({ enabled: false });
    expect(ctx.stub.setSettingBodies).toEqual([]);
  });

  it('a daemon refusal of the settings write passes through with its code', async () => {
    const ctx = await setup({
      ...fixture({}),
      setWorkspaceSettingStatus: 403,
      setWorkspaceSettingBody: {
        code: 'untrusted_workspace',
        error: 'Workspace is not trusted.',
      },
    });
    const res = await toggle(ctx.baseUrl, ctx.ownerToken, 'todo_write', true);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('untrusted_workspace');
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_tool_enabled',
    );
    expect(rows).toHaveLength(0);
  });

  it('an under-scoped caller never reaches the settings write', async () => {
    const ctx = await setup(fixture({}));
    const res = await toggle(ctx.baseUrl, ctx.writeToken, 'todo_write', true);
    expect(res.status).toBe(403);
    expect(ctx.stub.setSettingBodies).toEqual([]);
  });
});

describe('workspace target (rc-workspace-scoping, #28)', () => {
  it('toggle POST rejects a non-string workspace with 400 invalid_workspace (no daemon call)', async () => {
    const ctx = await setup();
    for (const workspace of [42, true, null, ['x'], { cwd: '/x' }]) {
      const res = await fetch(
        `${ctx.baseUrl}/rc/workspace/tools/WebFetch/enable`,
        {
          method: 'POST',
          headers: authed(ctx.ownerToken),
          body: JSON.stringify({ enabled: false, workspace }),
        },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_workspace');
    }
    expect(ctx.stub.lastToolToggleBody).toBeUndefined();
  });

  it('catalog GET rejects a repeated (array) workspace query param with 400 invalid_workspace', async () => {
    // 404 stub status proves the daemon was never reached: a daemon call
    // would surface as 502 tools_unsupported, not the parse 400.
    const ctx = await setup({ workspaceToolsStatus: 404 });
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/tools?workspace=a&workspace=b`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_workspace');
    expect(body.error).toBe('Invalid workspace target');
  });

  it('catalog GET accepts a valid non-default workspace target', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/tools?workspace=${encodeURIComponent('/proj/a')}`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(200);
  });

  it('toggle POST for a non-default target audits detail.workspace', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/tools/WebFetch/enable`,
      {
        method: 'POST',
        headers: authed(ctx.ownerToken),
        body: JSON.stringify({ enabled: false, workspace: '/proj/a' }),
      },
    );
    expect(res.status).toBe(200);
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_tool_enabled',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({
      toolName: 'WebFetch',
      enabled: false,
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
        async setWorkspaceToolEnabled(toolName, enabled) {
          return { toolName, enabled };
        },
        async workspaceToolsCatalog() {
          return { v: 1, tools: [] };
        },
        async workspaceSettings() {
          return { v: 1, settings: [], disabledTools: [] };
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

  it('toggle POST for a new workspace at pool cap → 503 workspace_pool_full (default target unaffected)', async () => {
    const ctx = await setupPoolAtCap();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/tools/WebFetch/enable`,
      {
        method: 'POST',
        headers: authed(ctx.ownerToken),
        body: JSON.stringify({ enabled: false, workspace: '/proj/b' }),
      },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('workspace_pool_full');
    expect(body.error).toBe('Workspace daemon pool is full (max 1)');
    // The default workspace is not pooled — it stays reachable at cap.
    const ok = await fetch(`${ctx.baseUrl}/rc/workspace/tools`, {
      headers: authed(ctx.writeToken),
    });
    expect(ok.status).toBe(200);
  });
});
