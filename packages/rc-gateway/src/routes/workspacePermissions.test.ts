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
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-ws-permissions-'));
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

describe('/rc/workspace/permissions', () => {
  it('write token GETs the rule lists → 200 passthrough', async () => {
    const ctx = await setup({
      workspacePermissionsResult: {
        v: 1,
        user: ['user-rule'],
        workspace: ['ws-rule'],
        merged: ['user-rule', 'ws-rule'],
        isTrusted: true,
      },
    });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: ['user-rule'],
      workspace: ['ws-rule'],
      merged: ['user-rule', 'ws-rule'],
    });
  });

  it('owner token can GET (owner ⊃ write)', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      headers: authed(ctx.ownerToken),
    });
    expect(res.status).toBe(200);
  });

  it('write token POST → 403 scope_required, daemon not called', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      method: 'POST',
      headers: authed(ctx.writeToken),
      body: JSON.stringify({
        scope: 'workspace',
        ruleType: 'allow',
        rules: ['Bash(ls:*)'],
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_required');
    expect(ctx.stub.lastPermissionRulesBody).toBeUndefined();
  });

  it('owner token POST → 200, rules replaced, audit row with rules', async () => {
    const ctx = await setup();
    const rules = ['Bash(ls:*)', 'Read(**)'];
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({ scope: 'workspace', ruleType: 'allow', rules }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ merged: rules, isTrusted: true });
    // The daemon received the full replacement list.
    expect(ctx.stub.lastPermissionRulesBody).toEqual({
      scope: 'workspace',
      ruleType: 'allow',
      rules,
    });

    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_permission_rules_set',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toEqual({
      scope: 'workspace',
      ruleType: 'allow',
      rules,
    });
  });

  it('unknown scope → 400 invalid_scope with allowed list (no daemon call)', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({
        scope: 'global',
        ruleType: 'allow',
        rules: ['Bash(ls:*)'],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_scope');
    expect(body.allowed).toEqual(['user', 'workspace']);
    expect(ctx.stub.lastPermissionRulesBody).toBeUndefined();
  });

  it('unknown ruleType → 400 invalid_rule_type (no daemon call)', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({
        scope: 'workspace',
        ruleType: 'permit',
        rules: ['Bash(ls:*)'],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_rule_type');
    expect(body.allowed).toEqual(['allow', 'ask', 'deny']);
    expect(ctx.stub.lastPermissionRulesBody).toBeUndefined();
  });

  it('non-array / blank rules → 400 invalid_rules (no daemon call)', async () => {
    const ctx = await setup();
    for (const rules of [{}, ['Bash(ls:*)', '   ']]) {
      const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
        method: 'POST',
        headers: authed(ctx.ownerToken),
        body: JSON.stringify({ scope: 'user', ruleType: 'deny', rules }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_rules');
    }
    expect(ctx.stub.lastPermissionRulesBody).toBeUndefined();
  });

  it('daemon 409 passes through unchanged (permission_session_required)', async () => {
    const ctx = await setup({
      setPermissionRulesStatus: 409,
      workspacePermissionsErrorBody: {
        code: 'permission_session_required',
        error: 'No live session can receive the update',
      },
    });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({
        scope: 'workspace',
        ruleType: 'ask',
        rules: ['Edit(**)'],
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('permission_session_required');
    expect(body.error).toBe('No live session can receive the update');
  });

  it('daemon 403 with no human message → generic fallback error', async () => {
    const ctx = await setup({
      setPermissionRulesStatus: 403,
      workspacePermissionsErrorBody: { code: 'untrusted_workspace' },
    });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({
        scope: 'workspace',
        ruleType: 'allow',
        rules: ['Bash(ls:*)'],
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('untrusted_workspace');
    expect(body.error).toBe('Daemon rejected the request');
  });

  it('daemon 404 → 502 permissions_unsupported', async () => {
    const ctx = await setup({ workspacePermissionsStatus: 404 });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('permissions_unsupported');
  });

  it('daemon transport failure → 502 daemon_unavailable (no audit row)', async () => {
    const ctx = await setup();
    await ctx.stub.crash();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
    const rows = (await auditRows()).filter(
      (r) => r.action === 'workspace_permission_rules_set',
    );
    expect(rows).toHaveLength(0);
  });
});

describe('/rc/workspace/permissions — optimistic concurrency', () => {
  // Stable daemon shape (with `.rules` objects, not bare arrays) so the
  // version hash is computed from the real fields the gateway reads.
  const basePermissions = {
    v: 1,
    user: { path: '/proj', rules: { allow: ['Bash(ls:*'], ask: [], deny: [] } },
    workspace: {
      path: '/proj',
      rules: { allow: ['Bash(cat:*'], ask: [], deny: [] },
    },
    merged: { allow: ['Bash(ls:*', 'Bash(cat:*'], ask: [], deny: [] },
    isTrusted: true,
  };

  it('GET includes a stable version hash', async () => {
    const ctx = await setup({ workspacePermissionsResult: basePermissions });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      headers: authed(ctx.writeToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  it('POST without baseVersion is accepted (backward compatible)', async () => {
    const ctx = await setup({ workspacePermissionsResult: basePermissions });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({
        scope: 'workspace',
        ruleType: 'allow',
        rules: ['Bash(rm:*)'],
      }),
    });
    expect(res.status).toBe(200);
    expect(ctx.stub.lastPermissionRulesBody).toEqual({
      scope: 'workspace',
      ruleType: 'allow',
      rules: ['Bash(rm:*)'],
    });
  });

  it('POST with stale baseVersion → 409 stale_base, daemon not called', async () => {
    const ctx = await setup({ workspacePermissionsResult: basePermissions });
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({
        scope: 'workspace',
        ruleType: 'allow',
        rules: ['Bash(rm:*)'],
        baseVersion: 'definitely-not-the-current-hash',
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('stale_base');
    expect(typeof body.currentVersion).toBe('string');
    // The daemon's setWorkspacePermissionRules was never called — the
    // stale base caused the request to be rejected before the mutation.
    expect(ctx.stub.lastPermissionRulesBody).toBeUndefined();
  });

  it('POST with correct baseVersion → 200, daemon called, no audit clobber', async () => {
    const ctx = await setup({ workspacePermissionsResult: basePermissions });
    // First GET to obtain the current version hash.
    const getRes = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      headers: authed(ctx.writeToken),
    });
    const { version } = (await getRes.json()) as { version: string };
    expect(version.length).toBeGreaterThan(0);

    // POST with the fresh baseVersion — should succeed.
    const rules = ['Bash(rm:*)'];
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      method: 'POST',
      headers: authed(ctx.ownerToken),
      body: JSON.stringify({
        scope: 'workspace',
        ruleType: 'allow',
        rules,
        baseVersion: version,
      }),
    });
    expect(res.status).toBe(200);
    expect(ctx.stub.lastPermissionRulesBody).toEqual({
      scope: 'workspace',
      ruleType: 'allow',
      rules,
    });
    // The POST response carries a version (of the post-mutation state).
    const postBody = await res.json();
    expect(typeof postBody.version).toBe('string');
  });

  it('POST with non-string baseVersion → 400 invalid_base_version', async () => {
    const ctx = await setup({ workspacePermissionsResult: basePermissions });
    for (const baseVersion of [123, true, null, [], {}]) {
      const res = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
        method: 'POST',
        headers: authed(ctx.ownerToken),
        body: JSON.stringify({
          scope: 'workspace',
          ruleType: 'allow',
          rules: ['Bash(ls:*)'],
          baseVersion,
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_base_version');
    }
    expect(ctx.stub.lastPermissionRulesBody).toBeUndefined();
  });

  it('version is stable across transient fields (isTrusted, merged)', async () => {
    // The stub serves `opts.workspacePermissionsResult` by reference, so
    // mutating it between requests simulates a daemon state change.
    const permissions = {
      ...basePermissions,
      user: {
        ...basePermissions.user,
        rules: { ...basePermissions.user.rules },
      },
    };
    const ctx = await setup({ workspacePermissionsResult: permissions });

    const v1 = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      headers: authed(ctx.writeToken),
    }).then((r) => r.json() as Promise<{ version: string }>);

    // Flipping isTrusted (a derived field) must NOT change the version.
    permissions.isTrusted = false;
    permissions.merged = { allow: [], ask: [], deny: [] };

    const v2 = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      headers: authed(ctx.writeToken),
    }).then((r) => r.json() as Promise<{ version: string }>);

    expect(v2.version).toBe(v1.version);
  });

  it('version changes when a persisted rule list changes', async () => {
    const permissions = {
      ...basePermissions,
      user: {
        ...basePermissions.user,
        rules: { ...basePermissions.user.rules },
      },
    };
    const ctx = await setup({ workspacePermissionsResult: permissions });

    const v1 = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      headers: authed(ctx.writeToken),
    }).then((r) => r.json() as Promise<{ version: string }>);

    // Mutate the user rules — a persisted field that IS covered by the hash.
    permissions.user.rules.allow = ['Bash(rm:*)'];

    const v2 = await fetch(`${ctx.baseUrl}/rc/workspace/permissions`, {
      headers: authed(ctx.writeToken),
    }).then((r) => r.json() as Promise<{ version: string }>);

    expect(v2.version).not.toBe(v1.version);
  });
});
