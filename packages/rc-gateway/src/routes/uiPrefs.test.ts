/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { createUiPrefsRouter } from './uiPrefs.js';
import { DEFAULT_STAMP_ZONE, UiPrefsStore } from '../uiPrefsStore.js';

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

let dir: string;
let store: UiPrefsStore;
let audit: ReturnType<typeof fakeAudit>;
let server: Server | undefined;
let base: string;

// The real mount gets req.rcClient from requireScope; a route test supplies it
// the same way the sibling route tests do. Mutable so one mount can answer as
// two different tokens, which is what proves the keying.
let currentClient: { id: string };

async function mount(client: { id: string }) {
  currentClient = client;
  audit = fakeAudit();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { rcClient?: unknown }).rcClient = currentClient;
    next();
  });
  app.use('/rc/ui-prefs', createUiPrefsRouter(store, audit));
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  server = s;
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function get(as?: string) {
  if (as) currentClient = { id: as };
  const res = await fetch(`${base}/rc/ui-prefs/`);
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

async function put(body: unknown, as?: string) {
  if (as) currentClient = { id: as };
  const res = await fetch(`${base}/rc/ui-prefs/`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rc-uiprefs-route-'));
  store = await UiPrefsStore.open(join(dir, 'ui-prefs.json'));
});
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /rc/ui-prefs', () => {
  it('reports the default zone as the effective one, marked unsaved', async () => {
    await mount({ id: 'tok_a' });
    const { status, json } = await get();
    expect(status).toBe(200);
    // The client is told what it will actually see, so it never has to
    // reproduce the default to render correctly.
    expect(json).toEqual({ stampZone: DEFAULT_STAMP_ZONE, saved: false });
  });

  it('marks the zone saved once the token has chosen one', async () => {
    await mount({ id: 'tok_a' });
    await put({ stampZone: 'Asia/Tokyo' });
    const { json } = await get();
    expect(json).toEqual({ stampZone: 'Asia/Tokyo', saved: true });
  });
});

describe('PUT /rc/ui-prefs', () => {
  it('sets a zone, returns the effective body, and audits it', async () => {
    await mount({ id: 'tok_a' });
    const { status, json } = await put({ stampZone: 'Asia/Tokyo' });
    expect(status).toBe(200);
    expect(json).toEqual({ stampZone: 'Asia/Tokyo', saved: true });
    expect(audit.calls.map((c) => c.action)).toEqual(['ui_prefs_set']);
    expect(audit.calls[0].detail).toEqual({ stampZone: 'Asia/Tokyo' });
  });

  it('null clears back to the default rather than to no stamp', async () => {
    await mount({ id: 'tok_a' });
    await put({ stampZone: 'Asia/Tokyo' });

    const { status, json } = await put({ stampZone: null });
    expect(status).toBe(200);
    expect(json).toEqual({ stampZone: DEFAULT_STAMP_ZONE, saved: false });
  });

  it('rejects a missing stampZone key rather than treating it as a clear', async () => {
    await mount({ id: 'tok_a' });
    await put({ stampZone: 'Asia/Tokyo' });

    // A client that meant to change the zone and got a 200 would believe it had,
    // so an absent field is a 400 and the saved value stays put.
    const { status, json } = await put({});
    expect(status).toBe(400);
    expect(json).toMatchObject({ code: 'invalid_zone' });
    expect(store.get('tok_a').stampZone).toBe('Asia/Tokyo');
  });

  it('rejects a non-string, non-null value', async () => {
    await mount({ id: 'tok_a' });
    const { status, json } = await put({ stampZone: 42 });
    expect(status).toBe(400);
    expect(json).toMatchObject({ code: 'invalid_zone' });
    expect(store.get('tok_a')).toEqual({});
  });

  it('rejects an unusable zone name and leaves the store untouched', async () => {
    await mount({ id: 'tok_a' });
    await put({ stampZone: 'Asia/Tokyo' });

    const { status, json } = await put({ stampZone: 'Mars/Olympus_Mons' });
    expect(status).toBe(400);
    expect(json).toMatchObject({ code: 'invalid_zone' });
    // The rejected write must not blank what was already saved.
    expect(store.get('tok_a').stampZone).toBe('Asia/Tokyo');
    const after = await get();
    expect(after.json).toEqual({ stampZone: 'Asia/Tokyo', saved: true });
  });

  it('does not audit a write that was rejected', async () => {
    await mount({ id: 'tok_a' });
    await put({ stampZone: 'Mars/Olympus_Mons' });
    expect(audit.calls).toHaveLength(0);
  });
});

describe('per-token keying', () => {
  it("one token cannot read or overwrite another token's zone", async () => {
    await mount({ id: 'phone' });
    await put({ stampZone: 'Asia/Tokyo' });

    // A second paired token on the same gateway sees the default, not the
    // phone's choice — which is the whole reason this is keyed per token.
    const other = await get('laptop');
    expect(other.json).toEqual({ stampZone: DEFAULT_STAMP_ZONE, saved: false });

    // And writing as the laptop leaves the phone's record alone.
    await put({ stampZone: 'Europe/Berlin' }, 'laptop');
    expect(store.get('phone').stampZone).toBe('Asia/Tokyo');
    expect(store.get('laptop').stampZone).toBe('Europe/Berlin');

    const back = await get('phone');
    expect(back.json).toEqual({ stampZone: 'Asia/Tokyo', saved: true });
  });
});
