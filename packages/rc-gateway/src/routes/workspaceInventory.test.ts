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
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-ws-inv-'));
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

describe('GET /rc/workspace/skills', () => {
  it('write token reads skills → 200 with the daemon list relayed in order', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/skills`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.v).toBe(1);
    expect(body.skills.map((sk: { name: string }) => sk.name)).toEqual([
      'review',
      'pdf',
    ]);
  });

  it('a disabled skill survives with its disabledReason, not filtered out', async () => {
    // A disabled skill is still an installed skill, and `disabledReason` is the
    // only field that says why it is off. A relay that dropped non-ok entries
    // would make the machine look like it had fewer skills than it does, which
    // is the direction that hides a skill someone switched off on purpose.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/skills`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    const off = body.skills.find((sk: { name: string }) => sk.name === 'pdf');
    expect(off.status).toBe('disabled');
    expect(off.disabledReason).toBe('default');
  });

  it('a skill installedPath is relayed, because redaction is not this gateway job', async () => {
    // The host path is why this route sits at WRITE rather than being scrubbed
    // on the way through. The gateway is a relay with a scope gate in front of
    // it; inventing a redactor here would mean the gateway knows which fields
    // are sensitive better than the daemon does, and it would silently break a
    // caller that needs the path.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/skills`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    const on = body.skills.find((sk: { name: string }) => sk.name === 'review');
    expect(on.installedPath).toBe('/proj/.qwen/skills/review/SKILL.md');
  });

  it('owner token reads skills too (owner is a superset of write)', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/skills`, {
      headers: authed(ctx.ownerToken),
    });
    expect(res.status).toBe(200);
  });

  it('read token → 403, these are host facts not conversation names', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/skills`, {
      headers: authed(ctx.readToken),
    });
    expect(res.status).toBe(403);
    // The body code is `scope_required` (src/auth.ts:239); `scope_denied` is
    // the audit ACTION, not what the response says.
    expect((await res.json()).code).toBe('scope_required');
  });

  it('daemon 404 → 502 skills_unsupported', async () => {
    const ctx = await setup({ workspaceSkillsStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/skills`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('skills_unsupported');
  });

  it('daemon crash → 502 daemon_unavailable', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/skills`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('a non-string workspace target → 400 invalid_workspace', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/skills?workspace=a&workspace=b`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_workspace');
  });
});

describe('GET /rc/workspace/providers', () => {
  it('write token reads providers → 200 with the daemon list relayed', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/providers`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.providers.map((pv: { authType: string }) => pv.authType),
    ).toEqual(['anthropic', 'qwen-oauth']);
    expect(body.current.modelId).toBe('claude-sonnet-4');
  });

  it('a provider baseUrl and envKey survive the relay untouched', async () => {
    // These two are the reason this read is the most identifying of the three:
    // where model traffic goes and which variable pays for it. They are relayed
    // because the gate is the scope, not a field list.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/providers`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    const model = body.providers[0].models[0];
    expect(model.baseUrl).toBe('https://api.anthropic.com');
    expect(model.envKey).toBe('ANTHROPIC_API_KEY');
  });

  it('a provider hint and an empty models list both survive', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/providers`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    const second = body.providers[1];
    expect(second.status).toBe('warning');
    expect(second.hint).toBe('token expires soon');
    expect(second.models).toEqual([]);
  });

  it('read token → 403 scope_required', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/providers`, {
      headers: authed(ctx.readToken),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_required');
  });

  it('daemon 404 → 502 providers_unsupported, not the skills verdict', async () => {
    // Three routes, three verdicts. A shared code would hide which half of the
    // inventory an older daemon can actually serve.
    const ctx = await setup({ workspaceProvidersStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/providers`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('providers_unsupported');
    expect(body.code).not.toBe('skills_unsupported');
  });

  it('daemon crash → 502 daemon_unavailable', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/providers`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });
});

describe('GET /rc/workspace/hooks', () => {
  it('write token reads hooks → 200 with the daemon list relayed', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/hooks`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hooks.map((hk: { eventName: string }) => hk.eventName)).toEqual(
      ['PreToolUse', 'Stop'],
    );
  });

  it('the envelope disabled flag is relayed, not folded into the entries', async () => {
    // `disabled` is workspace-wide and sits on the envelope
    // (DaemonWorkspaceHooksStatus, types.ts:5487). A page that inferred it from
    // the entries could not tell "every hook is off" apart from "hooks are
    // globally off", which are different states to act on.
    const ctx = await setup({
      workspaceHooksResult: {
        v: 1,
        workspaceCwd: '/proj',
        initialized: true,
        disabled: true,
        hooks: [],
        events: {},
      },
    });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/hooks`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    expect(body.disabled).toBe(true);
    expect(body.hooks).toEqual([]);
  });

  it('the events map is relayed as its own field', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/hooks`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    expect(body.events.PreToolUse.description).toBe('before a tool runs');
    expect(body.events.Stop.matcherKind).toBeUndefined();
  });

  it('a hook config arrives with its command and a masked env value, unchanged', async () => {
    // The daemon masks env VALUES and leaves the key names, and never masks
    // `command` (packages/cli/src/acp-integration/acpAgent.ts:2549). The relay
    // passes both through. What it must not do is treat the mask as content or
    // strip the key names, since a caller showing "GUARD_TOKEN is configured"
    // is showing something true.
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/hooks`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    const hook = body.hooks[0];
    expect(hook.config.command).toBe('python3 tools/guard.py');
    expect(hook.config.env.GUARD_TOKEN).toBe('[redacted]');
    expect(hook.enabled).toBe(true);
  });

  it('a disabled hook entry survives', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/hooks`, {
      headers: authed(ctx.writeToken),
    });
    const body = await res.json();
    expect(body.hooks[1].enabled).toBe(false);
    expect(body.hooks[1].matcher).toBeUndefined();
  });

  it('read token → 403 scope_required', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/hooks`, {
      headers: authed(ctx.readToken),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_required');
  });

  it('daemon 404 → 502 hooks_unsupported', async () => {
    const ctx = await setup({ workspaceHooksStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/hooks`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('hooks_unsupported');
  });

  it('daemon crash → 502 daemon_unavailable', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/hooks`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('a valid non-default workspace target → 200', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/hooks?workspace=%2Fother%2Fproj`,
      { headers: authed(ctx.writeToken) },
    );
    expect(res.status).toBe(200);
  });
});
