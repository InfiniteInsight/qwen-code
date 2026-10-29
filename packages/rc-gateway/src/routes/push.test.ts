/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RcScope } from '../scopes.js';
import { OWNER, SESSION_READ, SHARE } from '../scopes.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { VapidStore } from '../webpush/vapid.js';
import { PushStore } from '../pushStore.js';
import { TokenStore } from '../tokenStore.js';
import { PushSender, type PushTransport } from '../webpush/sender.js';
import { PushNotifier } from '../webpush/notifier.js';
import type { PushPayload } from '../webpush/payload.js';
import { PushEndpointPolicy } from '../webpush/endpointPolicy.js';
import { createPushRouter } from './push.js';

let server: Server | undefined;
let vapid: VapidStore;
let store: PushStore;
let tokens: TokenStore;
let notifier: PushNotifier;
let sent: Array<{ endpoint: string; payload: PushPayload }>;
let audit: AuditRecorder & { calls: AuditEntry[] };
let client: { id: string; scopes: RcScope[]; sessionLockId?: string };
// Registration-time DNS is stubbed: every name resolves to one public address,
// so the tests exercise the policy without touching the network.
let policy: PushEndpointPolicy | undefined;

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-pushroute-'));
  vapid = await VapidStore.open(join(dir, 'vapid.json'));
  store = await PushStore.open(join(dir, 'push.json'));
  tokens = await TokenStore.open(join(dir, 'tokens.json'));
  audit = fakeAudit();
  sent = [];
  const transport: PushTransport = async (sub, payloadJson) => {
    sent.push({
      endpoint: sub.endpoint,
      payload: JSON.parse(payloadJson) as PushPayload,
    });
    return { statusCode: 201 };
  };
  const sender = new PushSender(vapid, store, audit, {
    transport,
    backoffMs: [0, 0, 0, 0, 0],
    sleep: async () => {},
  });
  notifier = new PushNotifier(tokens, store, sender);
  client = { id: 'tokA', scopes: [SESSION_READ] };
  policy = new PushEndpointPolicy({
    resolve: async () => [{ address: '142.250.80.10', family: 4 }],
  });
});

async function mount(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = client;
    next();
  });
  app.use(
    '/rc/push',
    createPushRouter(
      vapid,
      store,
      notifier,
      audit,
      policy ? { endpointPolicy: policy } : {},
    ),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const VALID_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/secret-endpoint-1',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
};

describe('push routes', () => {
  it('GET /vapid returns the application server key', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/push/vapid`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applicationServerKey: string };
    expect(body.applicationServerKey).toBe(vapid.getApplicationServerKey());
  });

  it('POST /subscribe with a valid subscription returns 201 and audits', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: VALID_SUB }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBeTruthy();
    expect(store.get(id)).toBeDefined();

    const sub = audit.calls.find((c) => c.action === 'push_subscribed');
    expect(sub).toBeDefined();
    expect(sub!.detail).toEqual({ subscriptionId: id });
    // The endpoint (a sensitive capability URL) must never reach the audit log.
    expect(JSON.stringify(audit.calls)).not.toContain(VALID_SUB.endpoint);
  });

  it('POST /subscribe with a malformed body (missing keys.auth) returns 400', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/x',
          keys: { p256dh: 'p' },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_subscription');
  });

  it('GET /subscriptions lists only the callers own', async () => {
    const url = await mount();
    await store.add('tokA', VALID_SUB);
    await store.add('tokB', {
      endpoint: 'https://push.example.com/other',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const res = await fetch(`${url}/rc/push/subscriptions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscriptions: Array<{ id: string; tokenId?: string }>;
    };
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].tokenId).toBeUndefined();
  });

  it('GET /subscriptions?all=true requires owner (403 for non-owner)', async () => {
    const url = await mount();
    await store.add('tokA', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions?all=true`);
    expect(res.status).toBe(403);
  });

  it('GET /subscriptions?all=true as owner returns all with tokenId', async () => {
    client = { id: 'admin', scopes: [SESSION_READ, OWNER] };
    const url = await mount();
    await store.add('tokA', VALID_SUB);
    await store.add('tokB', {
      endpoint: 'https://push.example.com/other',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const res = await fetch(`${url}/rc/push/subscriptions?all=true`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscriptions: Array<{ id: string; tokenId: string }>;
    };
    expect(body.subscriptions).toHaveLength(2);
    expect(body.subscriptions.map((s) => s.tokenId).sort()).toEqual([
      'tokA',
      'tokB',
    ]);
  });

  it('DELETE own subscription returns 204 and audits without the endpoint', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(store.get(rec.id)).toBeUndefined();
    const un = audit.calls.find((c) => c.action === 'push_unsubscribed');
    expect(un).toBeDefined();
    expect(un!.detail).toEqual({ subscriptionId: rec.id });
    expect(JSON.stringify(audit.calls)).not.toContain(VALID_SUB.endpoint);
  });

  it('DELETE another tokens subscription as non-owner returns 404 (hide existence)', async () => {
    const url = await mount();
    const rec = await store.add('tokB', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(store.get(rec.id)).toBeDefined();
  });

  it('DELETE another tokens subscription as owner returns 204', async () => {
    client = { id: 'admin', scopes: [SESSION_READ, OWNER] };
    const url = await mount();
    const rec = await store.add('tokB', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(store.get(rec.id)).toBeUndefined();
  });

  it('DELETE an unknown id returns 404', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/push/subscriptions/nope`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('GET /subscriptions includes prefs for each entry (own)', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    await store.setPrefs(rec.id, ['task.completed']);
    const res = await fetch(`${url}/rc/push/subscriptions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscriptions: Array<{ id: string; prefs?: string[] }>;
    };
    expect(body.subscriptions[0].prefs).toEqual(['task.completed']);
  });

  it('GET /subscriptions?all=true includes prefs (owner)', async () => {
    client = { id: 'admin', scopes: [SESSION_READ, OWNER] };
    const url = await mount();
    const rec = await store.add('tokB', VALID_SUB);
    await store.setPrefs(rec.id, ['permission.required']);
    const res = await fetch(`${url}/rc/push/subscriptions?all=true`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscriptions: Array<{ id: string; prefs?: string[] }>;
    };
    expect(body.subscriptions[0].prefs).toEqual(['permission.required']);
  });

  it('PATCH own subscription sets prefs -> 200 and GET shows them', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: ['task.completed'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; prefs?: string[] };
    expect(body.id).toBe(rec.id);
    expect(body.prefs).toEqual(['task.completed']);

    const pu = audit.calls.find((c) => c.action === 'push_prefs_updated');
    expect(pu).toBeDefined();
    expect(pu!.detail).toEqual({ subscriptionId: rec.id });
    expect(JSON.stringify(audit.calls)).not.toContain(VALID_SUB.endpoint);

    const list = await fetch(`${url}/rc/push/subscriptions`);
    const lb = (await list.json()) as {
      subscriptions: Array<{ id: string; prefs?: string[] }>;
    };
    expect(lb.subscriptions[0].prefs).toEqual(['task.completed']);
  });

  it('PATCH with prefs:null clears prefs (receive-all); body has no prefs', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    await store.setPrefs(rec.id, ['task.completed']);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; prefs?: string[] };
    expect(body.id).toBe(rec.id);
    expect('prefs' in body).toBe(false);
    expect(store.get(rec.id)!.prefs).toBeUndefined();
  });

  it('PATCH sets quietHours -> 200 and GET shows it', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    const qh = { from: '23:00', to: '07:00', timezone: 'UTC' };
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quietHours: qh }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quietHours?: unknown };
    expect(body.quietHours).toEqual(qh);
    expect(store.get(rec.id)!.quietHours).toEqual(qh);

    const list = await fetch(`${url}/rc/push/subscriptions`);
    const lb = (await list.json()) as {
      subscriptions: Array<{ quietHours?: unknown }>;
    };
    expect(lb.subscriptions[0].quietHours).toEqual(qh);
  });

  it('PATCH quietHours:null clears the window', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    await store.setQuietHours(rec.id, {
      from: '23:00',
      to: '07:00',
      timezone: 'UTC',
    });
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quietHours: null }),
    });
    expect(res.status).toBe(200);
    expect(store.get(rec.id)!.quietHours).toBeUndefined();
  });

  it('PATCH {quietHours} leaves existing prefs intact (field independence)', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    await store.setPrefs(rec.id, ['task.completed']);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quietHours: { from: '00:00', to: '06:00', timezone: 'UTC' },
      }),
    });
    expect(res.status).toBe(200);
    // prefs untouched (a quietHours-only PATCH must not wipe prefs).
    expect(store.get(rec.id)!.prefs).toEqual(['task.completed']);
  });

  it('PATCH {prefs} leaves existing quietHours intact (field independence)', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    const qh = { from: '00:00', to: '06:00', timezone: 'UTC' };
    await store.setQuietHours(rec.id, qh);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: ['permission.required'] }),
    });
    expect(res.status).toBe(200);
    expect(store.get(rec.id)!.quietHours).toEqual(qh);
    expect(store.get(rec.id)!.prefs).toEqual(['permission.required']);
  });

  it('PATCH malformed quietHours -> 400 invalid_quiet_hours', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quietHours: { from: '9am', to: '5pm', timezone: 'UTC' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('invalid_quiet_hours');
    expect(store.get(rec.id)!.quietHours).toBeUndefined();
  });

  it('mixed PATCH with valid prefs + malformed quietHours -> 400 and prefs are NOT partially committed', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    await store.setPrefs(rec.id, ['task.completed']); // pre-existing prefs
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prefs: ['permission.required'],
        quietHours: { from: 'nope', to: '07:00', timezone: 'UTC' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('invalid_quiet_hours');
    // The whole request is rejected: prefs must be untouched (not narrowed).
    expect(store.get(rec.id)!.prefs).toEqual(['task.completed']);
    expect(store.get(rec.id)!.quietHours).toBeUndefined();
    // A rejected request emits no update audit.
    expect(audit.calls.some((c) => c.action === 'push_prefs_updated')).toBe(
      false,
    );
  });

  it('PATCH sets maxPerHour -> 200 and GET shows it (cycle 46)', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPerHour: 10 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { maxPerHour?: unknown };
    expect(body.maxPerHour).toBe(10);
    expect(store.get(rec.id)!.maxPerHour).toBe(10);
    const list = await fetch(`${url}/rc/push/subscriptions`);
    const lb = (await list.json()) as {
      subscriptions: Array<{ maxPerHour?: unknown }>;
    };
    expect(lb.subscriptions[0].maxPerHour).toBe(10);
  });

  it('PATCH maxPerHour:null clears the cap', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    await store.setMaxPerHour(rec.id, 5);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPerHour: null }),
    });
    expect(res.status).toBe(200);
    expect(store.get(rec.id)!.maxPerHour).toBeUndefined();
  });

  it('PATCH out-of-range / non-integer maxPerHour -> 400 invalid_max_per_hour', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    for (const bad of [0, 241, 1.5, -3, 'x']) {
      const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxPerHour: bad }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe('invalid_max_per_hour');
    }
    expect(store.get(rec.id)!.maxPerHour).toBeUndefined(); // never applied
  });

  it('mixed PATCH valid maxPerHour + malformed quietHours -> 400, maxPerHour NOT partially committed', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxPerHour: 12,
        quietHours: { from: 'nope', to: '07:00', timezone: 'UTC' },
      }),
    });
    expect(res.status).toBe(400);
    expect(store.get(rec.id)!.maxPerHour).toBeUndefined(); // all-or-nothing
  });

  it('PATCH another tokens id as non-owner with a quietHours body -> 404 (existence hidden before validation)', async () => {
    const url = await mount();
    const rec = await store.add('tokB', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quietHours: { from: '1', to: '2', timezone: 'x' },
      }),
    });
    expect(res.status).toBe(404);
  });

  it('PATCH another tokens id as non-owner -> 404 (hide existence)', async () => {
    const url = await mount();
    const rec = await store.add('tokB', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: ['task.completed'] }),
    });
    expect(res.status).toBe(404);
  });

  it('PATCH another tokens id with a malformed body as non-owner -> 404 (existence hidden before validation)', async () => {
    const url = await mount();
    const rec = await store.add('tokB', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: 'not-an-array' }),
    });
    expect(res.status).toBe(404);
  });

  it('PATCH another tokens id as owner -> 200', async () => {
    client = { id: 'admin', scopes: [SESSION_READ, OWNER] };
    const url = await mount();
    const rec = await store.add('tokB', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: ['task.completed'] }),
    });
    expect(res.status).toBe(200);
    expect(store.get(rec.id)!.prefs).toEqual(['task.completed']);
  });

  it('PATCH an unknown id -> 404', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/push/subscriptions/nope`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: [] }),
    });
    expect(res.status).toBe(404);
  });

  it('PATCH own subscription with a non-array prefs -> 400 invalid_prefs', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: 'task.completed' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_prefs');
  });

  it('PATCH own subscription with non-string array elements -> 400 invalid_prefs', async () => {
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: ['ok', 5] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_prefs');
  });

  it('POST /test as a non-owner returns 403', async () => {
    // client is session:read only (no owner) by default.
    const url = await mount();
    const res = await fetch(`${url}/rc/push/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('insufficient_scope');
    expect(sent).toHaveLength(0);
  });

  it('POST /test as owner with 1 sub returns 200 {sent:1} and dispatches a task.completed', async () => {
    // Mint a real token so notifier.scopesFor(client.id) resolves; the route's
    // owner gate reads req.rcClient.scopes (separate from the token's scopes).
    const t = await tokens.issue([SESSION_READ, OWNER], 'owner');
    client = { id: t.id, scopes: [SESSION_READ, OWNER] };
    const url = await mount();
    await store.add(t.id, {
      endpoint: 'https://push.example.com/owner-sub',
      keys: { p256dh: 'p', auth: 'a' },
    });

    const res = await fetch(`${url}/rc/push/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-9' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: number };
    expect(body.sent).toBe(1);

    expect(sent).toHaveLength(1);
    expect(sent[0].endpoint).toBe('https://push.example.com/owner-sub');
    expect(sent[0].payload.kind).toBe('task.completed');
    expect(sent[0].payload.sessionId).toBe('sess-9');
  });
});

describe('DELETE forgets the rate-limit window', () => {
  it('invokes notifier.forgetRateLimit with the removed subscription id', async () => {
    const spy = vi.spyOn(notifier, 'forgetRateLimit');
    const url = await mount();
    const rec = await store.add('tokA', VALID_SUB);
    const res = await fetch(`${url}/rc/push/subscriptions/${rec.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(spy).toHaveBeenCalledWith(rec.id);
    spy.mockRestore();
  });

  it('does NOT forget anything when the DELETE 404s (unknown id)', async () => {
    const spy = vi.spyOn(notifier, 'forgetRateLimit');
    const url = await mount();
    const res = await fetch(`${url}/rc/push/subscriptions/nope`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('#165 subscribe endpoint policy (blind SSRF)', () => {
  async function subscribe(
    url: string,
    endpoint: string,
  ): Promise<{ status: number; body: { code?: string; reason?: string } }> {
    const res = await fetch(`${url}/rc/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } },
      }),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as {
        code?: string;
        reason?: string;
      },
    };
  }

  it.each([
    ['https://internal-host:8443/x', 'port'],
    ['https://internal-host/x', 'host_not_allowed'],
    ['https://10.0.0.5/x', 'non_public_address'],
    ['https://127.0.0.1/x', 'non_public_address'],
    ['https://[::1]/x', 'non_public_address'],
    ['http://fcm.googleapis.com/fcm/send/x', 'not_https'],
  ])(
    'refuses %s with 400 invalid_push_endpoint and stores nothing',
    async (endpoint, reason) => {
      const url = await mount();
      const { status, body } = await subscribe(url, endpoint);
      expect(status).toBe(400);
      expect(body.code).toBe('invalid_push_endpoint');
      expect(body.reason).toBe(reason);
      expect(store.listAll()).toHaveLength(0);
    },
  );

  it('refuses a host that resolves to a private address at registration', async () => {
    policy = new PushEndpointPolicy({
      allowedHostSuffixes: null,
      resolve: async () => [{ address: '192.168.1.100', family: 4 }],
    });
    const url = await mount();
    const { status, body } = await subscribe(
      url,
      'https://looks-public.example.net/x',
    );
    expect(status).toBe(400);
    expect(body.reason).toBe('non_public_address');
    expect(store.listAll()).toHaveLength(0);
  });

  it('with no policy passed, the route still refuses a private literal (secure default)', async () => {
    policy = undefined;
    const url = await mount();
    const { status, body } = await subscribe(url, 'https://10.0.0.5:8443/x');
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_push_endpoint');
    expect(store.listAll()).toHaveLength(0);
  });

  it('refuses oversized keys', async () => {
    const url = await mount();
    const res = await fetch(`${url}/rc/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: VALID_SUB.endpoint,
          keys: { p256dh: 'p'.repeat(4096), auth: 'a' },
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(store.listAll()).toHaveLength(0);
  });

  it('a share (session-locked) token cannot register push (403)', async () => {
    client = {
      id: 'shareA',
      scopes: [SESSION_READ, SHARE],
      sessionLockId: 's1',
    };
    const url = await mount();
    const { status, body } = await subscribe(url, VALID_SUB.endpoint);
    expect(status).toBe(403);
    expect(body.code).toBe('insufficient_scope');
    expect(store.listAll()).toHaveLength(0);
  });

  it('a paired read-only token still can (push stays at session:read)', async () => {
    client = { id: 'reader', scopes: [SESSION_READ] };
    const url = await mount();
    const { status } = await subscribe(url, VALID_SUB.endpoint);
    expect(status).toBe(201);
    expect(store.listFor('reader')).toHaveLength(1);
  });
});

describe('#165 per-token subscription cap', () => {
  async function subscribeN(url: string, prefix: string, n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const res = await fetch(`${url}/rc/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: {
            endpoint: `https://fcm.googleapis.com/fcm/send/${prefix}-${i}`,
            keys: { p256dh: 'p', auth: 'a' },
          },
        }),
      });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { id: string }).id);
    }
    return ids;
  }

  it('keeps at most 8 per token, evicting the oldest, auditing and forgetting it', async () => {
    const spy = vi.spyOn(notifier, 'forgetRateLimit');
    const url = await mount();
    const ids = await subscribeN(url, 'dev', 9);
    const mine = store.listFor('tokA').map((r) => r.id);
    expect(mine).toHaveLength(8);
    expect(mine).not.toContain(ids[0]);
    expect(mine).toContain(ids[8]);
    expect(spy).toHaveBeenCalledWith(ids[0]);
    const evicted = audit.calls.find(
      (c) =>
        c.action === 'push_unsubscribed' &&
        (c.detail as { reason?: string }).reason === 'cap_evicted',
    );
    expect(evicted?.detail).toEqual({
      subscriptionId: ids[0],
      reason: 'cap_evicted',
    });
    spy.mockRestore();
  });

  it("the cap is per token: another token's subscriptions are untouched", async () => {
    for (let i = 0; i < 8; i++) {
      await store.add('tokB', {
        endpoint: `https://fcm.googleapis.com/fcm/send/b-${i}`,
        keys: { p256dh: 'p', auth: 'a' },
      });
    }
    const url = await mount();
    await subscribeN(url, 'a', 9);
    expect(store.listFor('tokB')).toHaveLength(8);
    expect(store.listFor('tokA')).toHaveLength(8);
  });
});
