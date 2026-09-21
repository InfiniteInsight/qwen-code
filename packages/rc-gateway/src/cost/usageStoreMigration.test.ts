/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { UsageStore } from './usageStore.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-usage-migrate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A usage DB exactly as an older gateway wrote it: `cost_cents REAL`. */
function writeLegacyDb(path: string, rows: Array<{ cents: number | null }>) {
  const db = new Database(path);
  db.exec(
    `CREATE TABLE usage_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id TEXT NOT NULL,
       ts INTEGER NOT NULL,
       tokens_in INTEGER NOT NULL,
       tokens_out INTEGER NOT NULL,
       tokens_cached INTEGER NOT NULL,
       cost_cents REAL,
       model_service_id TEXT NOT NULL,
       model_id TEXT NOT NULL,
       attribution_token_id TEXT NOT NULL,
       sub_actor TEXT,
       stage TEXT
     )`,
  );
  const ins = db.prepare(
    `INSERT INTO usage_events
       (session_id, ts, tokens_in, tokens_out, tokens_cached, cost_cents,
        model_service_id, model_id, attribution_token_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [i, r] of rows.entries()) {
    ins.run('sess-1', 1_000 + i, 10, 5, 0, r.cents, 'svc', 'model-a', 'tkn-1');
  }
  db.close();
}

describe('UsageStore legacy cost_cents migration', () => {
  it('opens a legacy DB and aggregates instead of throwing', () => {
    // Before the migration this threw
    // `SqliteError: no such column: cost_microcents` on every read, which
    // took out /rc/usage entirely on long-lived installs.
    const path = join(dir, 'usage.db');
    writeLegacyDb(path, [{ cents: 1.5 }, { cents: 0.25 }]);

    const store = UsageStore.open(path);
    const totals = store.sessionTotals('sess-1');

    // 1 cent = 1_000_000 microcents.
    expect(totals.costMicrocentsSesTotal).toBe(1_750_000);
    expect(totals.tokensInTotal).toBe(20);
  });

  it('leaves NULL costs null rather than converting them to zero', () => {
    // A NULL cost means "rate-table miss", which is a different fact from
    // "this cost nothing". Collapsing the two would silently invent a price.
    const path = join(dir, 'usage.db');
    writeLegacyDb(path, [{ cents: null }, { cents: 2 }]);

    UsageStore.open(path);

    const db = new Database(path);
    const rows = db
      .prepare(`SELECT cost_microcents FROM usage_events ORDER BY id`)
      .all() as Array<{ cost_microcents: number | null }>;
    db.close();

    expect(rows[0].cost_microcents).toBeNull();
    expect(rows[1].cost_microcents).toBe(2_000_000);
  });

  it('is idempotent — reopening does not double-convert', () => {
    const path = join(dir, 'usage.db');
    writeLegacyDb(path, [{ cents: 3 }]);

    UsageStore.open(path);
    const again = UsageStore.open(path);

    expect(again.sessionTotals('sess-1').costMicrocentsSesTotal).toBe(
      3_000_000,
    );
  });

  it('does not touch a fresh DB', () => {
    const path = join(dir, 'usage.db');
    const store = UsageStore.open(path);
    store.record({
      sessionId: 'sess-2',
      ts: 1,
      tokensIn: 1,
      tokensOut: 1,
      tokensCached: 0,
      costMicrocents: 500,
      modelServiceId: 'svc',
      modelId: 'model-a',
      attributionTokenId: 'tkn-1',
      subActor: null,
      stage: null,
    });

    const db = new Database(path);
    const cols = (
      db.prepare(`PRAGMA table_info(usage_events)`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    db.close();

    expect(cols).toContain('cost_microcents');
    expect(cols).not.toContain('cost_cents');
    expect(store.sessionTotals('sess-2').costMicrocentsSesTotal).toBe(500);
  });
});
