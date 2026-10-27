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
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-ws-ctx-'));
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
  const { token: readToken } = await store.issue(['read'], 'r');
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
    readToken,
    writeToken,
    ownerToken,
  };
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}
describe('GET /rc/workspace/memory', () => {
  it('write token reads memory -> 200 with the file list relayed in order', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/memory`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.v).toBe(1);
    expect(body.files.map((f: { path: string }) => f.path)).toEqual([
      '/proj/QWEN.md',
      '/home/dev/.qwen/QWEN.md',
    ]);
  });

  it('the global-scope entry survives with its host path, not filtered out', async () => {
    // The global file sits outside the bound workspace. The relay's job is the
    // list of which context files exist and how big they are, so dropping the
    // global entry would understate the machine, and rewriting its path would
    // make a workspace file look like the global one.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/memory`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    const global = body.files.find(
      (f: { scope: string }) => f.scope === 'global',
    );
    expect(global.path).toBe('/home/dev/.qwen/QWEN.md');
    expect(global.bytes).toBe(980);
  });

  it('the envelope counts survive', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/memory`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    expect(body.fileCount).toBe(2);
    expect(body.totalBytes).toBe(5190);
    expect(body.ruleCount).toBe(14);
    expect(body.initialized).toBe(true);
  });

  it('the relay never asks the daemon for file content', async () => {
    // The load-bearing one. DaemonWorkspaceMemoryFile.content is present only
    // when the caller passed includeContent, and the SDK records that the flag
    // is the only way to read the global file, which the file routes refuse
    // (packages/sdk-typescript/src/daemon/DaemonClient.ts:2614). So the guard is
    // "we never ask": the pool method takes no options, and the flag is not
    // reachable from the wire. Asserting the recorded daemon query is what makes
    // this a check rather than a hope.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/memory`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    expect(ctx.stub.lastMemoryQuery?.['content']).toBeUndefined();
    const body = await res.json();
    for (const file of body.files) {
      expect(file.content).toBeUndefined();
    }
  });

  it("a caller's own content query param does not become a daemon flag", async () => {
    // Same guard from the hostile side: someone guessing the daemon's flag name
    // has to find that the gateway has no path that forwards it.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/memory?content=true`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    expect(ctx.stub.lastMemoryQuery?.['content']).toBeUndefined();
  });

  it('read token -> 403 scope_required', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/memory`, {
      headers: authed(ctx.readToken),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_required');
  });

  it('owner token reads memory (owner implies write)', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/memory`, {
      headers: authed(ctx.ownerToken),
    });
    expect(res.status).toBe(200);
  });

  it('daemon 404 -> 502 memory_unsupported, not the sibling verdict', async () => {
    const ctx = await setup({ workspaceMemoryStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/memory`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    const code = (await res.json()).code;
    expect(code).toBe('memory_unsupported');
    expect(code).not.toBe('agents_unsupported');
  });

  it('daemon crash -> 502 daemon_unavailable', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/memory`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('an array workspace param -> 400 invalid_workspace', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/memory?workspace=%2Fa&workspace=%2Fb`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_workspace');
  });

  it('a valid non-default workspace target -> 200', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/memory?workspace=%2Fother%2Fproj`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(200);
    // No assertion on what the daemon saw. The pool resolves a non-default
    // target by choosing WHICH pooled client answers, not by forwarding a
    // `workspace` query, so the recorded query carries no target and the
    // sibling tests assert the status only.
  });
});

describe('GET /rc/workspace/agents', () => {
  it('write token reads agents -> 200 with the list relayed in order', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/agents`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.v).toBe(1);
    expect(body.agents.map((a: { name: string }) => a.name)).toEqual([
      'reviewer',
      'Explore',
    ]);
  });

  it('the builtin entry survives with no filePath', async () => {
    // A builtin has no definition file. A relay or page that assumed every
    // entry carries filePath would drop it, and the reader would conclude the
    // agent does not exist.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/agents`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    const builtin = body.agents.find(
      (a: { isBuiltin: boolean }) => a.isBuiltin === true,
    );
    expect(builtin.name).toBe('Explore');
    expect(builtin.level).toBe('builtin');
    expect(builtin.filePath).toBeUndefined();
  });

  it('filePath passes through untouched', async () => {
    // A host path, and the fact that puts this read on the write side of #107.
    // The relay neither rebases nor truncates it: a caller that cannot see which
    // file defines an agent cannot act on the list.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/agents`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    expect(body.agents[0].filePath).toBe('/proj/.qwen/agents/reviewer.md');
  });

  it('the tool, MCP and hook name lists survive', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/agents`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    expect(body.agents[0].tools).toEqual(['read_file', 'grep_search']);
    expect(body.agents[0].mcpServerNames).toEqual(['memory']);
    expect(body.agents[0].hookEvents).toEqual(['PreToolUse']);
    expect(body.agents[0].model).toBe('qwen3.6-plus');
  });

  it('read token -> 403 scope_required', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/agents`, {
      headers: authed(ctx.readToken),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_required');
  });

  it('daemon 404 -> 502 agents_unsupported, not the sibling verdict', async () => {
    const ctx = await setup({ workspaceAgentsStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/agents`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    const code = (await res.json()).code;
    expect(code).toBe('agents_unsupported');
    expect(code).not.toBe('memory_unsupported');
  });

  it('daemon crash -> 502 daemon_unavailable', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/agents`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('an array workspace param -> 400 invalid_workspace', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/agents?workspace=%2Fa&workspace=%2Fb`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_workspace');
  });

  it('a valid non-default workspace target -> 200', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/agents?workspace=%2Fother%2Fproj`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(200);
  });
});
