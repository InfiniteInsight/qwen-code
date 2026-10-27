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
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-ws-diag-'));
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

describe('GET /rc/workspace/env', () => {
  it('write token reads the environment → 200 with the daemon cells relayed', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/env`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.v).toBe(1);
    expect(body.cells.map((c: { name: string }) => c.name)).toEqual([
      'node',
      'os',
      'HTTPS_PROXY',
      'ANTHROPIC_API_KEY',
    ]);
  });

  it('a secret env_var arrives with presence and no value, relayed that way', async () => {
    // The daemon guarantees a value is ALWAYS omitted for kind='env_var'
    // (types.ts:3067). This pins that the relay neither adds one nor reads the
    // cell differently: presence is the whole fact about a secret on this
    // route. If a future edit synthesized `value: ''` for absent fields, the
    // page could start printing a blank where a secret is, which reads as
    // "no key set" to someone whose key is set.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/env`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    const secret = body.cells.find(
      (c: { kind: string }) => c.kind === 'env_var',
    );
    expect(secret.present).toBe(true);
    expect(secret).not.toHaveProperty('value');
  });

  it('the daemon hint on a degraded cell survives the relay', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/env`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    const proxy = body.cells.find(
      (c: { name: string }) => c.name === 'HTTPS_PROXY',
    );
    expect(proxy.status).toBe('warning');
    expect(proxy.hint).toBe('no proxy configured for this workspace');
  });

  it('owner token can read (owner ⊃ write)', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/env`, {
      headers: authed(ctx.ownerToken),
    });
    expect(res.status).toBe(200);
  });

  it('a read-scope token is refused: these cells are host facts', async () => {
    // The floor is the decision, so it gets a test rather than a comment. The
    // daemon calls env and preflight reconnaissance vectors
    // (workspace-status.ts:381), and #107 puts host facts on the write side.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/env`, {
      headers: authed(ctx.readToken),
    });
    expect(res.status).toBe(403);
    // The body code is `scope_required` (src/auth.ts:239); `scope_denied` is
    // the audit ACTION, not the response code. Pinned because the two names
    // differ by intent and are easy to swap.
    expect((await res.json()).code).toBe('scope_required');
  });

  it('daemon 404 → 502 env_unsupported', async () => {
    const ctx = await setup({ workspaceEnvStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/env`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('env_unsupported');
    expect(body.error).toBe(
      'Daemon does not support workspace environment read',
    );
  });

  it('daemon transport failure → 502 daemon_unavailable', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/env`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('rejects a repeated (array) workspace query param with 400 invalid_workspace', async () => {
    // 404 stub status proves the daemon was never reached: a daemon call would
    // surface as 502 env_unsupported, not the parse 400.
    const ctx = await setup({ workspaceEnvStatus: 404 });
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/env?workspace=a&workspace=b`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_workspace');
  });
});

describe('GET /rc/workspace/preflight', () => {
  it('write token reads the checks → 200 with every cell, failures included', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/preflight`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // A failing check is the most useful row on the page, so nothing here is
    // filtered for being an error. Order is the daemon's.
    expect(
      body.cells.map((c: { kind: string; status: string }) => [
        c.kind,
        c.status,
      ]),
    ).toEqual([
      ['node_version', 'ok'],
      ['ripgrep', 'warning'],
      ['auth', 'error'],
    ]);
  });

  it('the errors array is relayed, not merged into cells', async () => {
    // `errors` is a separate field on the envelope (types.ts:3107). Folding it
    // into cells would invent a kind the daemon never named, and dropping it
    // would hide the one row that says a probe timed out.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/preflight`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    expect(body.errors).toEqual([
      { kind: 'egress', status: 'error', error: 'probe timed out' },
    ]);
    expect(body.cells.some((c: { kind: string }) => c.kind === 'egress')).toBe(
      false,
    );
  });

  it('an unknown status and kind from a newer daemon are relayed verbatim', async () => {
    const ctx = await setup({
      workspacePreflightResult: {
        v: 1,
        workspaceCwd: '/proj',
        initialized: true,
        acpChannelLive: false,
        cells: [
          {
            kind: 'tape_drive',
            status: 'recalibrating',
            locality: 'daemon',
          },
        ],
      },
    });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/preflight`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cells[0].kind).toBe('tape_drive');
    expect(body.cells[0].status).toBe('recalibrating');
  });

  it('daemon 404 → 502 preflight_unsupported, not the env verdict', async () => {
    // The two routes share their failure code path, so a copy-paste of one
    // code into the other is a real risk and gets pinned separately.
    const ctx = await setup({ workspacePreflightStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/preflight`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('preflight_unsupported');
    expect(body.error).toBe('Daemon does not support workspace preflight read');
  });

  it('a read-scope token is refused here too', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/preflight`, {
      headers: authed(ctx.readToken),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_required');
  });

  it('daemon transport failure → 502 daemon_unavailable', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/preflight`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('accepts a valid non-default workspace target', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/preflight?workspace=${encodeURIComponent('/proj/a')}`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(200);
  });
});
