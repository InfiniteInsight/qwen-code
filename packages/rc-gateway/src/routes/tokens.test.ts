/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TokenStore } from '../tokenStore.js';
import { ConnectionRegistry } from '../connectionRegistry.js';
import { bearerResolve, requireScope } from '../auth.js';
import { OWNER, SESSION_READ, APPROVE, WRITE, BRIDGE } from '../scopes.js';
import {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
  createRevokeAllTokensRoute,
  type TokenRevokedHook,
} from './tokens.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}
let audit: AuditRecorder & { calls: AuditEntry[] };

let server: Server | undefined;
let store: TokenStore;
let registry: ConnectionRegistry;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rc-tok-')), 'tokens.json');
  store = await TokenStore.open(path);
  registry = new ConnectionRegistry();
  audit = fakeAudit();
});

async function mount(onTokenRevoked?: TokenRevokedHook): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(bearerResolve(store, audit));
  app.get(
    '/rc/tokens',
    requireScope(OWNER, audit),
    createListTokensRoute(store),
  );
  app.post(
    '/rc/tokens',
    requireScope(OWNER, audit),
    createMintTokenRoute(store, audit),
  );
  app.delete(
    '/rc/tokens/:id',
    requireScope(OWNER, audit),
    createRevokeTokenRoute(store, registry, audit, onTokenRevoked),
  );
  app.post(
    '/rc/tokens/revoke-all',
    requireScope(OWNER, audit),
    createRevokeAllTokensRoute(store, registry, audit, onTokenRevoked),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('/rc/tokens routes', () => {
  it('GET lists tokens for an owner (metadata only)', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    await store.issue([SESSION_READ], 'phone');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('tokenHash');
  });

  it('GET is forbidden for a session:read-only token', async () => {
    const weak = await store.issue([SESSION_READ], 'phone');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      headers: { Authorization: `Bearer ${weak.token}` },
    });
    expect(res.status).toBe(403);
  });

  it('POST mints a scoped token an owner is allowed to grant', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ scopes: [SESSION_READ], label: 'minted' }),
    });
    expect(res.status).toBe(200);
    const { token, scopes } = (await res.json()) as {
      token: string;
      scopes: string[];
    };
    expect(scopes).toEqual([SESSION_READ]);
    expect(store.resolve(`Bearer ${token}`)).not.toBeNull();
  });

  it('POST rejects an unknown scope with 400', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ scopes: ['session:write'] }),
    });
    expect(res.status).toBe(400);
  });

  it('POST clamps: cannot grant a scope the caller lacks', async () => {
    const owner = await store.issue([OWNER], 'owner-no-read');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ scopes: [SESSION_READ] }),
    });
    expect(res.status).toBe(403);
  });

  it('POST: an OWNER can grant `bridge` (not held) and the token gets the expanded bundle', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    expect(owner).toBeDefined();
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ scopes: [BRIDGE], label: 'tg-bridge' }),
    });
    expect(res.status).toBe(200);
    const { token, scopes, id } = (await res.json()) as {
      token: string;
      scopes: string[];
      id: string;
    };
    // Expanded, deduped bundle — bridge marker retained, plus the functional trio.
    expect([...scopes].sort()).toEqual(
      [BRIDGE, SESSION_READ, APPROVE, WRITE].sort(),
    );
    // The PERSISTED token carries the bundle (so flat includes()/scopesFor work).
    expect(store.scopesFor(id)?.sort()).toEqual(
      [BRIDGE, SESSION_READ, APPROVE, WRITE].sort(),
    );
    expect(store.resolve(`Bearer ${token}`)).not.toBeNull();
    // Audit reflects the granted (expanded) set, not the bare request.
    const minted = audit.calls.find((c) => c.action === 'token_minted');
    expect((minted?.detail as { scopes: string[] }).scopes.sort()).toEqual(
      [BRIDGE, SESSION_READ, APPROVE, WRITE].sort(),
    );
  });

  it('POST: a NON-owner (write+approve, no owner) is refused `bridge` with 403', async () => {
    // Even holding approve+write, you cannot mint a bridge token without owner.
    const weak = await store.issue([WRITE, APPROVE, SESSION_READ], 'phone');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${weak.token}`,
      },
      body: JSON.stringify({ scopes: [BRIDGE] }),
    });
    // requireScope(OWNER) gates the route, so a non-owner is 403 before the
    // grant logic — proving bridge is never reachable without owner.
    expect(res.status).toBe(403);
  });

  it('an OWNER token does NOT itself carry the `bridge` marker (not implied by owner)', async () => {
    const owner = await store.issue(
      [OWNER, SESSION_READ, APPROVE, WRITE],
      'owner',
    );
    expect(store.scopesFor(owner.id)).not.toContain(BRIDGE);
  });

  it('DELETE revokes a token (204) and evicts its registered streams', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const victim = await store.issue([SESSION_READ], 'victim');
    const ctrl = new AbortController();
    registry.register(victim.id, ctrl);
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens/${victim.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(204);
    expect(ctrl.signal.aborted).toBe(true);
    expect(store.resolve(`Bearer ${victim.token}`)).toBeNull();
  });

  it('DELETE an unknown id returns 404', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens/nope`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(404);
  });

  it('records token_minted on a successful mint', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const url = await mount();
    await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ scopes: [SESSION_READ], label: 'minted' }),
    });
    const minted = audit.calls.find((c) => c.action === 'token_minted');
    expect(minted).toBeDefined();
    expect(minted!.actorTokenId).toBe(owner.id);
  });

  it('records token_revoked on a successful revoke', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const victim = await store.issue([SESSION_READ], 'victim');
    const url = await mount();
    await fetch(`${url}/rc/tokens/${victim.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const revoked = audit.calls.find((c) => c.action === 'token_revoked');
    expect(revoked).toBeDefined();
    expect(revoked!.target).toBe(victim.id);
  });
});

describe('POST /rc/tokens/revoke-all', () => {
  it('revokes all tokens and returns 200 with revokedIds', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const b = await store.issue([SESSION_READ], 'b');
    const c = await store.issue([SESSION_READ], 'c');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens/revoke-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedIds: string[] };
    // All three tokens are revoked (owner included since no except)
    expect(body.revokedIds.sort()).toEqual([owner.id, b.id, c.id].sort());
  });

  it('revoke-all with { except: "self" } spares the caller\'s token', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const b = await store.issue([SESSION_READ], 'b');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens/revoke-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ except: 'self' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedIds: string[] };
    expect(body.revokedIds).toEqual([b.id]);
    // owner token still resolves
    expect(store.resolve(`Bearer ${owner.token}`)).not.toBeNull();
    // b is revoked
    expect(store.resolve(`Bearer ${b.token}`)).toBeNull();
  });

  it('revoke-all evicts registered connections for each revoked token', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const b = await store.issue([SESSION_READ], 'b');
    const ctrlB = new AbortController();
    registry.register(b.id, ctrlB);
    const url = await mount();
    await fetch(`${url}/rc/tokens/revoke-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({}),
    });
    expect(ctrlB.signal.aborted).toBe(true);
  });

  it('revoke-all records one token_revoked audit entry per revoked token', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const b = await store.issue([SESSION_READ], 'b');
    const url = await mount();
    await fetch(`${url}/rc/tokens/revoke-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ except: 'self' }),
    });
    const revokedCalls = audit.calls.filter(
      (c) => c.action === 'token_revoked',
    );
    expect(revokedCalls).toHaveLength(1);
    expect(revokedCalls[0].target).toBe(b.id);
    expect(revokedCalls[0].actorTokenId).toBe(owner.id);
  });

  it('revoke-all is forbidden for a non-owner token (403)', async () => {
    const weak = await store.issue([SESSION_READ], 'phone');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens/revoke-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${weak.token}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('revoke-all with no tokens returns 200 and empty revokedIds', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    // revoke everything first so only the caller's token might remain but we
    // use except:self and there is only the owner — empty result.
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens/revoke-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ except: 'self' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedIds: string[] };
    expect(body.revokedIds).toEqual([]);
  });
});

describe('#205 revoke cascade hook', () => {
  const countsFor =
    (
      map: Record<string, { subscriptions: number; devices: number }>,
    ): TokenRevokedHook =>
    async (ids) =>
      new Map(ids.map((id) => [id, map[id]!] as const));

  it('DELETE calls the hook once with the id, after the revoke, and puts counts (only) on the audit row', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const victim = await store.issue([SESSION_READ], 'victim');
    const calls: string[][] = [];
    const url = await mount(async (ids) => {
      calls.push([...ids]);
      // The token is already dead and evicted by the time the cascade runs.
      expect(store.resolve(`Bearer ${victim.token}`)).toBeNull();
      return new Map([[victim.id, { subscriptions: 2, devices: 1 }]]);
    });
    const res = await fetch(`${url}/rc/tokens/${victim.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(204);
    expect(calls).toEqual([[victim.id]]);
    const rows = audit.calls.filter((c) => c.action === 'token_revoked');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toBe(victim.id);
    expect(rows[0]!.detail).toEqual({ subscriptions: 2, devices: 1 });
  });

  it('DELETE of an unknown id never runs the hook', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    let ran = false;
    const url = await mount(async () => {
      ran = true;
    });
    const res = await fetch(`${url}/rc/tokens/nope`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(404);
    expect(ran).toBe(false);
  });

  it('revoke-all calls the hook ONCE with every revoked id and writes one counted row per token', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const b = await store.issue([SESSION_READ], 'b');
    const c = await store.issue([SESSION_READ], 'c');
    const calls: string[][] = [];
    const counts = countsFor({
      [owner.id]: { subscriptions: 0, devices: 0 },
      [b.id]: { subscriptions: 1, devices: 0 },
      [c.id]: { subscriptions: 0, devices: 3 },
    });
    const url = await mount(async (ids) => {
      calls.push([...ids]);
      return counts(ids);
    });
    const res = await fetch(`${url}/rc/tokens/revoke-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedIds: string[] };
    expect(Object.keys(body)).toEqual(['revokedIds']);
    expect(calls).toHaveLength(1);
    expect([...calls[0]!].sort()).toEqual([owner.id, b.id, c.id].sort());
    const byTarget = new Map(
      audit.calls
        .filter((a) => a.action === 'token_revoked')
        .map((a) => [a.target, a.detail] as const),
    );
    expect(byTarget.get(b.id)).toEqual({ subscriptions: 1, devices: 0 });
    expect(byTarget.get(c.id)).toEqual({ subscriptions: 0, devices: 3 });
  });

  it('revoke-all with except:self leaves the caller out of the cascade', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const b = await store.issue([SESSION_READ], 'b');
    const calls: string[][] = [];
    const url = await mount(async (ids) => {
      calls.push([...ids]);
    });
    await fetch(`${url}/rc/tokens/revoke-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ except: 'self' }),
    });
    expect(calls).toEqual([[b.id]]);
    // A hook that returns nothing leaves the audit row without a detail.
    const row = audit.calls.find((a) => a.action === 'token_revoked');
    expect(row!.detail).toBeUndefined();
  });

  it('revoke-all with nothing to revoke does not run the hook', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    let ran = false;
    const url = await mount(async () => {
      ran = true;
    });
    await fetch(`${url}/rc/tokens/revoke-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ except: 'self' }),
    });
    expect(ran).toBe(false);
  });
});
