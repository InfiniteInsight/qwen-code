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

  it('write token → 200 with the daemon catalog, unchanged', async () => {
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
        },
        {
          name: 'write_file',
          displayName: 'Write File',
          disabled: true,
          source: 'builtin',
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

  it('custom catalog (MCP entry) passes through unchanged', async () => {
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
      tools: [{ name: 'mcp__search__lookup', disabled: true, source: 'mcp' }],
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
