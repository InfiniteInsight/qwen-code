/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SQLite-backed `usage_events` store for cost tracking (`add-cost-tracking`:
 * "Ingest priced rows" + "/rc/usage aggregation" + the `prune` CLI). One row per
 * usage-bearing `session_update`, attributed to the originating client token (and
 * a bridge sub-actor when present). Indexed for the common group-by windows.
 *
 * Like {@link SearchIndex}, this is a NATIVE `better-sqlite3` consumer; the daemon
 * loads it dynamically so a missing native build disables cost tracking rather
 * than breaking the gateway (mirrors the search-index isolation). A NULL
 * `cost_microcents` records an unpriced (rate-table-miss) row — visibly unpriced.
 *
 * Costs are stored as INTEGER microcents (1 cent = 1 000 000 microcents) to avoid
 * floating-point accumulation errors and allow exact integer arithmetic at write
 * time. Presentation-layer helpers in {@link usageQuery} convert back to cents.
 */

import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/** A row to insert. `costMicrocents` is null on a rate-table miss. `ts` is unix ms. */
export interface UsageRowInput {
  sessionId: string;
  ts: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Cost in microcents (1 cent = 1 000 000 microcents), or null on miss. */
  costMicrocents: number | null;
  modelServiceId: string;
  modelId: string;
  attributionTokenId: string;
  subActor: string | null;
  stage: string | null;
  /** `<service>/<modelId>` of the rate-table entry that priced the row, if any. */
  rateKey?: string | null;
  /** Whether that entry matched the id as given or with its `(provider)` suffix stripped. */
  rateMatch?: 'exact' | 'stripped' | null;
}

/** A stored row `qwen-rc usage reprice` may want to fix. */
export interface RepriceCandidate {
  id: number;
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  modelServiceId: string;
  modelId: string;
  costMicrocents: number | null;
}

/** Running totals for a session (the `usage_tick` payload's source). */
export interface SessionTotals {
  /** Sum of cost in microcents (NULL rows count as 0). */
  costMicrocentsSesTotal: number;
  tokensInTotal: number;
  tokensOutTotal: number;
  tokensCachedTotal: number;
}

export type GroupBy = 'session' | 'client' | 'sub_actor' | 'model';

export interface AggregateQuery {
  sinceMs: number;
  untilMs: number;
  groupBy: GroupBy;
  /** When set, only rows with this attribution token id (scope filtering). */
  attributionTokenId?: string;
  /** When set, only rows with this exact sub_actor (the CLI `--sub-actor`). */
  subActor?: string;
}

export interface AggregateRow {
  key: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Sum of cost in microcents for this group. */
  costMicrocents: number;
}

const GROUP_COLUMN: Record<GroupBy, string> = {
  session: 'session_id',
  client: 'attribution_token_id',
  sub_actor: 'sub_actor',
  model: "model_service_id || '/' || model_id",
};

/**
 * Bring a pre-existing `usage_events` table up to the current cost column.
 *
 * Costs were once stored as `cost_cents REAL` and are now
 * `cost_microcents INTEGER` (see the header note: integers avoid float drift
 * when summing millions of rows). `CREATE TABLE IF NOT EXISTS` does nothing to
 * a table that already exists, so every gateway whose DB predates the rename
 * kept the old column — and every `/rc/usage` request failed outright with
 * `SqliteError: no such column: cost_microcents`. The cost surface was dead on
 * exactly the long-lived installs that had usage worth reading.
 *
 * Idempotent: a fresh DB already has the new column and is left alone, and a
 * DB with neither column (not ours) is not touched either.
 */
export function migrateCostColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(usage_events)`).all() as Array<{
    name: string;
  }>;
  const names = new Set(cols.map((c) => c.name));
  if (names.has('cost_microcents') || !names.has('cost_cents')) return;

  // ALTER ADD + UPDATE rather than a table rebuild: it is a single pass, it
  // keeps the row ids stable, and the old column is left in place so a
  // rollback to an older gateway still reads its own data.
  db.exec(`ALTER TABLE usage_events ADD COLUMN cost_microcents INTEGER`);
  db.exec(
    `UPDATE usage_events
        SET cost_microcents = CAST(ROUND(cost_cents * 1000000) AS INTEGER)
      WHERE cost_cents IS NOT NULL`,
  );
}

/**
 * Add the `rate_key` / `rate_match` columns (which table entry priced a row, and
 * by which pass) to a db that predates them. Idempotent.
 */
export function migrateRateKeyColumns(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(usage_events)`).all() as Array<{
    name: string;
  }>;
  const names = new Set(cols.map((c) => c.name));
  if (names.size === 0) return;
  if (!names.has('rate_key')) {
    db.exec(`ALTER TABLE usage_events ADD COLUMN rate_key TEXT`);
  }
  if (!names.has('rate_match')) {
    db.exec(`ALTER TABLE usage_events ADD COLUMN rate_match TEXT`);
  }
}

export class UsageStore {
  private constructor(private readonly db: Database.Database) {}

  /** Open (creating if needed) the usage db; dir 0700, file 0600. */
  static open(dbPath: string): UsageStore {
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
    const db = new Database(dbPath);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      /* best-effort */
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS usage_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         session_id TEXT NOT NULL,
         ts INTEGER NOT NULL,
         tokens_in INTEGER NOT NULL,
         tokens_out INTEGER NOT NULL,
         tokens_cached INTEGER NOT NULL,
         cost_microcents INTEGER,
         model_service_id TEXT NOT NULL,
         model_id TEXT NOT NULL,
         attribution_token_id TEXT NOT NULL,
         sub_actor TEXT,
         stage TEXT
       )`,
    );
    migrateCostColumn(db);
    migrateRateKeyColumns(db);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events (ts)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events (session_id, ts)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_usage_attr ON usage_events (attribution_token_id, ts)`,
    );
    return new UsageStore(db);
  }

  /** Insert one usage row. */
  record(row: UsageRowInput): void {
    this.db
      .prepare(
        `INSERT INTO usage_events (
           session_id, ts, tokens_in, tokens_out, tokens_cached, cost_microcents,
           model_service_id, model_id, attribution_token_id, sub_actor, stage,
           rate_key, rate_match
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.sessionId,
        row.ts,
        row.tokensIn,
        row.tokensOut,
        row.tokensCached,
        row.costMicrocents !== null ? Math.round(row.costMicrocents) : null,
        row.modelServiceId,
        row.modelId,
        row.attributionTokenId,
        row.subActor,
        row.stage,
        row.rateKey ?? null,
        row.rateMatch ?? null,
      );
  }

  /**
   * Rows that carry no model id or no cost: the ones the pre-#181 ingester wrote
   * (`model_id = ''`, `cost_microcents NULL`) plus any later rate-table miss.
   * Oldest first, so a report is stable.
   */
  repriceCandidates(): RepriceCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, tokens_in, tokens_out, tokens_cached,
                model_service_id, model_id, cost_microcents
           FROM usage_events
          WHERE model_id = '' OR cost_microcents IS NULL
          ORDER BY id`,
      )
      .all() as Array<{
      id: number;
      session_id: string;
      tokens_in: number;
      tokens_out: number;
      tokens_cached: number;
      model_service_id: string;
      model_id: string;
      cost_microcents: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      tokensCached: r.tokens_cached,
      modelServiceId: r.model_service_id,
      modelId: r.model_id,
      costMicrocents: r.cost_microcents,
    }));
  }

  /** Apply a repricing to one row, inside the caller's transaction if any. */
  applyReprice(
    id: number,
    fix: {
      modelId: string;
      costMicrocents: number | null;
      rateKey: string | null;
      rateMatch: 'exact' | 'stripped' | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE usage_events
            SET model_id = ?, cost_microcents = ?, rate_key = ?, rate_match = ?
          WHERE id = ?`,
      )
      .run(
        fix.modelId,
        fix.costMicrocents !== null ? Math.round(fix.costMicrocents) : null,
        fix.rateKey,
        fix.rateMatch,
        id,
      );
  }

  /** Run `fn` in one transaction (all-or-nothing batch updates). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Cumulative totals for a session (NULL costs count as 0). */
  sessionTotals(sessionId: string): SessionTotals {
    const r = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(cost_microcents), 0) AS cost,
           COALESCE(SUM(tokens_in), 0) AS tin,
           COALESCE(SUM(tokens_out), 0) AS tout,
           COALESCE(SUM(tokens_cached), 0) AS tcached
         FROM usage_events WHERE session_id = ?`,
      )
      .get(sessionId) as {
      cost: number;
      tin: number;
      tout: number;
      tcached: number;
    };
    return {
      costMicrocentsSesTotal: r.cost,
      tokensInTotal: r.tin,
      tokensOutTotal: r.tout,
      tokensCachedTotal: r.tcached,
    };
  }

  /**
   * Aggregate priced rows in `[sinceMs, untilMs]` grouped by `groupBy`. A NULL
   * `sub_actor` groups under the empty key when grouping by sub_actor. Rows are
   * ordered by descending cost so the highest-cost keys come first.
   */
  aggregate(q: AggregateQuery): AggregateRow[] {
    const col = GROUP_COLUMN[q.groupBy];
    const params: unknown[] = [q.sinceMs, q.untilMs];
    let where = 'ts >= ? AND ts <= ?';
    if (q.attributionTokenId !== undefined) {
      where += ' AND attribution_token_id = ?';
      params.push(q.attributionTokenId);
    }
    if (q.subActor !== undefined) {
      where += ' AND sub_actor = ?';
      params.push(q.subActor);
    }
    const rows = this.db
      .prepare(
        `SELECT
           ${col} AS key,
           COALESCE(SUM(tokens_in), 0) AS tin,
           COALESCE(SUM(tokens_out), 0) AS tout,
           COALESCE(SUM(tokens_cached), 0) AS tcached,
           COALESCE(SUM(cost_microcents), 0) AS cost
         FROM usage_events
         WHERE ${where}
         GROUP BY ${col}
         ORDER BY cost DESC`,
      )
      .all(...params) as Array<{
      key: string | null;
      tin: number;
      tout: number;
      tcached: number;
      cost: number;
    }>;
    return rows.map((r) => ({
      key: r.key ?? '',
      tokensIn: r.tin,
      tokensOut: r.tout,
      tokensCached: r.tcached,
      costMicrocents: r.cost,
    }));
  }

  /** Delete rows with `ts < beforeMs`; returns the number removed. */
  prune(beforeMs: number): number {
    const info = this.db
      .prepare(`DELETE FROM usage_events WHERE ts < ?`)
      .run(beforeMs);
    return info.changes;
  }

  close(): void {
    this.db.close();
  }
}
