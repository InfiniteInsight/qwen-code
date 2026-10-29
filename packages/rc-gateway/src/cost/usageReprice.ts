/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen-rc usage reprice` (Qwen-Code-Remote#160 / #181): a one-shot backfill for
 * the rows the pre-fix ingester wrote with `model_id = ''` and a NULL cost. For
 * each such row the model is resolved from the session transcript, and the row is
 * priced with the same {@link priceUsage} the live ingester uses (cached tokens
 * split out, `(provider)` suffix fallback).
 *
 * Caveat, stated in the CLI output too: the transcript names the model of the
 * session's MOST RECENT assistant turn, so a session that switched models
 * mid-conversation has its older rows priced at the final model. That is an
 * approximation, but a labelled one (the row's `rate_key` / `rate_match` say what
 * priced it), and better than the NULL it replaces.
 *
 * Pure apart from the injected store and resolver, so it is tested against a
 * fixture db with a fake resolver.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSessionModel } from '../idle/transcriptTail.js';
import { findSessionChatsDir } from '../sessions/chatsPath.js';
import { priceUsage, type RateTable } from './rateTable.js';
import type { UsageStore } from './usageStore.js';

export interface RepriceArgs {
  dryRun: boolean;
  /** Alternative usage db (default `~/.qwen/rc/usage.db`). */
  dbPath: string | undefined;
  /** Look transcripts up here first instead of scanning every project dir. */
  chatsDir: string | undefined;
}

export interface RepriceReport {
  /** Candidate rows examined (empty model id or null cost). */
  scanned: number;
  /** Rows whose empty model id was filled from a transcript. */
  modelFilled: number;
  /** Rows that now have a cost. */
  repriced: number;
  /** Rows with a model id but no matching rate-table entry. */
  stillUnpriced: number;
  /** Rows whose session transcript gave no model. */
  noModel: number;
  /** Rows that need a write (what a dry run says it WOULD update). */
  wouldUpdate: number;
  /** Rows actually written (always 0 on a dry run). */
  updated: number;
  dryRun: boolean;
}

export function defaultUsageDbPath(): string {
  return join(homedir(), '.qwen', 'rc', 'usage.db');
}

function readFlag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

/** Parse `usage reprice [--dry-run] [--db <path>] [--chats-dir <dir>]`. */
export function parseRepriceArgs(argv: string[]): RepriceArgs {
  return {
    dryRun: argv.includes('--dry-run'),
    dbPath: readFlag(argv, 'db'),
    chatsDir: readFlag(argv, 'chats-dir'),
  };
}

export type ModelResolver = (sessionId: string) => Promise<string | null>;

/** Resolve a session's model from its transcript (explicit dir, else a scan). */
export function createTranscriptModelResolver(
  opts: {
    chatsDir?: string;
    env?: Record<string, string | undefined>;
  } = {},
): ModelResolver {
  return async (sessionId) => {
    if (opts.chatsDir) {
      const m = await readSessionModel(opts.chatsDir, sessionId);
      if (m) return m;
    }
    const dir = await findSessionChatsDir(sessionId, opts.env);
    return dir ? readSessionModel(dir, sessionId) : null;
  };
}

export async function repriceUsage(
  store: UsageStore,
  rates: RateTable,
  resolveModel: ModelResolver,
  opts: { dryRun: boolean },
): Promise<RepriceReport> {
  const candidates = store.repriceCandidates();
  const report: RepriceReport = {
    scanned: candidates.length,
    modelFilled: 0,
    repriced: 0,
    stillUnpriced: 0,
    noModel: 0,
    wouldUpdate: 0,
    updated: 0,
    dryRun: opts.dryRun,
  };
  const models = new Map<string, string | null>();
  const fixes: Array<{
    id: number;
    modelId: string;
    costMicrocents: number | null;
    rateKey: string | null;
    rateMatch: 'exact' | 'stripped' | null;
  }> = [];

  for (const row of candidates) {
    let modelId = row.modelId;
    let filled = false;
    if (!modelId) {
      if (!models.has(row.sessionId)) {
        let m: string | null = null;
        try {
          m = await resolveModel(row.sessionId);
        } catch {
          m = null;
        }
        models.set(row.sessionId, m);
      }
      const resolved = models.get(row.sessionId);
      if (!resolved) {
        report.noModel++;
        continue;
      }
      modelId = resolved;
      filled = true;
    }
    const priced = priceUsage(
      rates,
      row.modelServiceId || undefined,
      modelId,
      row,
    );
    if (filled) report.modelFilled++;
    if (priced) report.repriced++;
    else report.stillUnpriced++;
    // Nothing to change: no new model id and still no price.
    if (!filled && !priced) continue;
    fixes.push({
      id: row.id,
      modelId,
      costMicrocents: priced?.costMicrocents ?? null,
      rateKey: priced?.rateKey ?? null,
      rateMatch: priced?.rateMatch ?? null,
    });
  }

  report.wouldUpdate = fixes.length;
  if (!opts.dryRun && fixes.length > 0) {
    store.transaction(() => {
      for (const f of fixes) store.applyReprice(f.id, f);
    });
    report.updated = fixes.length;
  }
  return report;
}

/** Plain-text summary for the CLI. */
export function formatRepriceReport(r: RepriceReport): string {
  return [
    r.dryRun ? 'usage reprice (DRY RUN, nothing written):' : 'usage reprice:',
    `  rows examined            ${r.scanned}`,
    `  model id filled in       ${r.modelFilled}`,
    `  now priced               ${r.repriced}`,
    `  model but no rate entry  ${r.stillUnpriced}`,
    `  no model in transcript   ${r.noModel}`,
    r.dryRun
      ? `  rows that would change   ${r.wouldUpdate}`
      : `  rows updated             ${r.updated}`,
    "Note: a transcript names the session's latest model, so rows from a session",
    'that switched models mid-conversation are priced at the final one.',
  ].join('\n');
}
