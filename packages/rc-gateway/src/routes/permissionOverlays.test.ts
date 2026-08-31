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
import { AuditLog } from '../auditLog.js';
import { bearerResolve, requireScope } from '../auth.js';
import { OWNER, SESSION_READ } from '../scopes.js';
import { OVERLAY_CAP, PermissionOverlayStore } from '../policy/overlays.js';
import { createPermissionOverlayRoutes } from './permissionOverlays.js';

let server: Server | undefined;
let store: TokenStore;
let audit: AuditLog;
let overlays: PermissionOverlayStore;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-overlays-'));
  store = await TokenStore.open(join(dir, 'tokens.json'));
  let clock = 0;
  audit = new AuditLog(join(dir, 'audit.log'), () => ++clock);
  overlays = new PermissionOverlayStore();
});

/** Mounts the three routes behind requireScope(OWNER) — the production posture. */
async function mount(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(bearerResolve(store, audit));
  const routes = createPermissionOverlayRoutes(overlays, { audit });
  app.get('/rc/permission-overlays', requireScope(OWNER, audit), routes.get);
  app.post('/rc/permission-overlays', requireScope(OWNER, audit), routes.post);
  app.delete(
    '/rc/permission-overlays/:id',
    requireScope(OWNER, audit),
    routes.remove,
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function post(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}/rc/permission-overlays`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

describe('/rc/permission-overlays', () => {
  it('POST 201 creates an overlay, normalizes the tool, and audits it', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const url = await mount();
    const before = Date.now();
    const out = await post(url, owner.token, {
      action: 'deny',
      ttlSeconds: 300,
      tool: 'web_fetch',
      sessionId: 's1',
      reason: 'while I test',
    });
    expect(out.status).toBe(201);
    const ov = out.json['overlay'] as Record<string, unknown>;
    expect(ov['tool']).toBe('fetch'); // normalized via the loader's alias map
    expect(ov['sessionId']).toBe('s1');
    expect(ov['action']).toBe('deny');
    expect(ov['reason']).toBe('while I test');
    expect(ov['id']).toMatch(/^overlay-/);
    const expiresAt = ov['expiresAt'] as number;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);

    const set = (await audit.query({ action: 'permission_overlay_set' }))[0];
    expect(set).toBeDefined();
    expect(set?.actorTokenId).toBe(owner.id);
    expect(set?.detail).toMatchObject({
      overlayId: ov['id'],
      sessionId: 's1',
      tool: 'fetch',
      action: 'deny',
      ttlSeconds: 300,
      reason: 'while I test',
    });
  });

  it('POST 400 invalid_action (unknown or missing)', async () => {
    const owner = await store.issue([OWNER], 'owner');
    const url = await mount();
    for (const body of [
      { action: 'yes', ttlSeconds: 60 },
      { ttlSeconds: 60 },
    ]) {
      const out = await post(url, owner.token, body);
      expect(out.status).toBe(400);
      expect(out.json['code']).toBe('invalid_action');
    }
    expect(overlays.list()).toHaveLength(0);
  });

  it('POST 400 invalid_ttl (0, 24h+1, non-integer, non-number, missing)', async () => {
    const owner = await store.issue([OWNER], 'owner');
    const url = await mount();
    const bad = [0, 86_401, 1.5, '300'];
    for (const ttlSeconds of bad) {
      const out = await post(url, owner.token, {
        action: 'deny',
        ttlSeconds,
      });
      expect(out.status).toBe(400);
      expect(out.json['code']).toBe('invalid_ttl');
    }
    const out = await post(url, owner.token, { action: 'deny' });
    expect(out.status).toBe(400);
    expect(out.json['code']).toBe('invalid_ttl');
  });

  it('POST 400 invalid_tool (empty string, unknown name, non-string)', async () => {
    const owner = await store.issue([OWNER], 'owner');
    const url = await mount();
    for (const tool of ['', 'bogus_tool', 42]) {
      const out = await post(url, owner.token, {
        action: 'deny',
        ttlSeconds: 60,
        tool,
      });
      expect(out.status).toBe(400);
      expect(out.json['code']).toBe('invalid_tool');
    }
  });

  it('POST 400 invalid_session (empty string, non-string)', async () => {
    const owner = await store.issue([OWNER], 'owner');
    const url = await mount();
    for (const sessionId of ['', 42]) {
      const out = await post(url, owner.token, {
        action: 'deny',
        ttlSeconds: 60,
        sessionId,
      });
      expect(out.status).toBe(400);
      expect(out.json['code']).toBe('invalid_session');
    }
  });

  it('POST 400 invalid_reason (over the 200-char cap); an empty reason is dropped, not an error', async () => {
    const owner = await store.issue([OWNER], 'owner');
    const url = await mount();
    const out = await post(url, owner.token, {
      action: 'deny',
      ttlSeconds: 60,
      reason: 'x'.repeat(201),
    });
    expect(out.status).toBe(400);
    expect(out.json['code']).toBe('invalid_reason');

    const ok = await post(url, owner.token, {
      action: 'deny',
      ttlSeconds: 60,
      reason: '',
    });
    expect(ok.status).toBe(201);
    expect(ok.json['overlay']).not.toHaveProperty('reason');
  });

  it('POST 409 too_many_overlays when the cap is reached', async () => {
    const owner = await store.issue([OWNER], 'owner');
    const url = await mount();
    const nowMs = Date.now();
    for (let i = 0; i < OVERLAY_CAP; i++) {
      overlays.add({ action: 'deny', expiresAt: nowMs + 3_600_000 }, nowMs);
    }
    const out = await post(url, owner.token, {
      action: 'deny',
      ttlSeconds: 60,
    });
    expect(out.status).toBe(409);
    expect(out.json['code']).toBe('too_many_overlays');
  });

  it('GET lists active overlays (newest-first); empty store → empty list', async () => {
    const owner = await store.issue([OWNER], 'owner');
    const url = await mount();

    const empty = await fetch(`${url}/rc/permission-overlays`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ overlays: [] });

    const a = await post(url, owner.token, { action: 'deny', ttlSeconds: 60 });
    const b = await post(url, owner.token, { action: 'allow', ttlSeconds: 60 });
    const res = await fetch(`${url}/rc/permission-overlays`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overlays: Array<Record<string, unknown>>;
    };
    expect(body.overlays).toHaveLength(2);
    expect(body.overlays[0]['id']).toBe(
      (b.json['overlay'] as Record<string, unknown>)['id'],
    );
    expect(body.overlays[1]['id']).toBe(
      (a.json['overlay'] as Record<string, unknown>)['id'],
    );
  });

  it('DELETE revokes (200, audited) and is then 404 overlay_not_found', async () => {
    const owner = await store.issue([OWNER], 'owner');
    const url = await mount();
    const created = await post(url, owner.token, {
      action: 'deny',
      ttlSeconds: 60,
    });
    const id = (created.json['overlay'] as Record<string, unknown>)['id'];

    const res = await fetch(`${url}/rc/permission-overlays/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, overlayId: id });

    const revoked = (
      await audit.query({ action: 'permission_overlay_revoked' })
    )[0];
    expect(revoked?.detail).toMatchObject({ overlayId: id });

    const again = await fetch(`${url}/rc/permission-overlays/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(again.status).toBe(404);
    expect((await again.json()) as Record<string, unknown>).toMatchObject({
      code: 'overlay_not_found',
    });
  });

  it('all routes are owner-scoped: a session:read token gets 403', async () => {
    const weak = await store.issue([SESSION_READ], 'phone');
    const url = await mount();
    const get = await fetch(`${url}/rc/permission-overlays`, {
      headers: { Authorization: `Bearer ${weak.token}` },
    });
    expect(get.status).toBe(403);
    const out = await post(url, weak.token, { action: 'deny', ttlSeconds: 60 });
    expect(out.status).toBe(403);
    const del = await fetch(`${url}/rc/permission-overlays/overlay-x`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${weak.token}` },
    });
    expect(del.status).toBe(403);
  });

  it('unauthenticated requests get 401', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/permission-overlays`);
    expect(res.status).toBe(401);
  });
});
