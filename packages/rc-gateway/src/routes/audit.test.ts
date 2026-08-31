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
import { createAuditQueryRoute } from './audit.js';

let server: Server | undefined;
let store: TokenStore;
let audit: AuditLog;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-auditq-'));
  store = await TokenStore.open(join(dir, 'tokens.json'));
  let clock = 0;
  audit = new AuditLog(join(dir, 'audit.log'), () => ++clock);
});

async function mount(): Promise<string> {
  const app = express();
  app.use(bearerResolve(store, audit));
  app.get(
    '/rc/audit',
    requireScope(OWNER, audit),
    createAuditQueryRoute(audit),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('GET /rc/audit', () => {
  it('returns recorded entries to an owner (newest-first)', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    await audit.record({ action: 'token_minted', target: 'x' });
    await audit.record({ action: 'token_revoked', target: 'x' });
    const url = await mount();
    const res = await fetch(`${url}/rc/audit`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ action: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].action).toBe('token_revoked');
  });

  it('honors the action filter', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    await audit.record({ action: 'token_minted', target: 'x' });
    await audit.record({ action: 'token_revoked', target: 'x' });
    const url = await mount();
    const res = await fetch(`${url}/rc/audit?action=token_minted`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const rows = (await res.json()) as Array<{ action: string }>;
    expect(rows.every((r) => r.action === 'token_minted')).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it('honors the shareId filter (unions actorTokenId)', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    await audit.record({ action: 'share_created', detail: { shareId: 'sh9' } });
    await audit.record({ action: 'permission_voted', actorTokenId: 'sh9' });
    await audit.record({ action: 'session_attached', actorTokenId: 'other' });
    const url = await mount();
    const res = await fetch(`${url}/rc/audit?shareId=sh9`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const rows = (await res.json()) as Array<{ action: string }>;
    expect(rows.map((r) => r.action).sort()).toEqual([
      'permission_voted',
      'share_created',
    ]);
  });

  it('honors the tool and rule filters (issue #32)', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    await audit.record({
      action: 'policy_decision',
      detail: { tool: 'execute', ruleId: 'rule-a' },
    });
    await audit.record({
      action: 'policy_decision',
      detail: { tool: 'edit', ruleId: 'rule-b' },
    });
    await audit.record({
      action: 'permission_voted',
      detail: { outcome: 'allow' },
    });
    const url = await mount();

    const byTool = (await (
      await fetch(`${url}/rc/audit?tool=execute`, {
        headers: { Authorization: `Bearer ${owner.token}` },
      })
    ).json()) as Array<{ detail?: { tool?: string; ruleId?: string } }>;
    expect(byTool).toHaveLength(1);
    expect(byTool[0].detail).toMatchObject({
      tool: 'execute',
      ruleId: 'rule-a',
    });

    const byRule = (await (
      await fetch(`${url}/rc/audit?rule=rule-b`, {
        headers: { Authorization: `Bearer ${owner.token}` },
      })
    ).json()) as Array<{ detail?: { tool?: string } }>;
    expect(byRule).toHaveLength(1);
    expect(byRule[0].detail?.tool).toBe('edit');

    const none = (await (
      await fetch(`${url}/rc/audit?rule=rule-c`, {
        headers: { Authorization: `Bearer ${owner.token}` },
      })
    ).json()) as unknown[];
    expect(none).toEqual([]);
  });

  it('forbids a non-owner token', async () => {
    const weak = await store.issue([SESSION_READ], 'phone');
    const url = await mount();
    const res = await fetch(`${url}/rc/audit`, {
      headers: { Authorization: `Bearer ${weak.token}` },
    });
    expect(res.status).toBe(403);
  });
});
