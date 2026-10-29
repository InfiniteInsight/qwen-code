/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rate-table layer for cost tracking (`add-cost-tracking`: "Rate table format and
 * reload" + the pricing half of "Ingest priced rows"). Pure parsing + cost
 * computation, plus a thin hot-reloader built on the shared
 * {@link DebouncedReloader} — so the bug-prone money math and the parse-failure /
 * lookup-miss semantics are unit-tested without a daemon, a SQLite store, or fs.
 *
 * The table maps `(modelServiceId, modelId)` to per-million-token cent prices.
 * `computeCostCents` returns `null` (NOT 0) on a lookup miss so the ingester can
 * record `cost_cents = NULL` and audit `rate_table_miss` — an unpriced model must
 * be visibly unpriced, never silently free.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DebouncedReloader,
  type DebouncedReloaderOptions,
} from '../reload/debouncedReloader.js';

/** One model's per-million-token prices, in the table's currency cents. */
export interface RateEntry {
  modelServiceId: string;
  modelId: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedReadPerMTok: number;
}

export interface RateTable {
  currencyLabel: string;
  /** Service id assumed when a usage event carries none. */
  defaultModelServiceId?: string;
  models: RateEntry[];
}

/** Token counts from a `session_update` usage block. */
export interface UsageTokens {
  in: number;
  out: number;
  cached: number;
}

/** `~/.qwen/rc/model-rates.yaml` — the operator-managed rate table path. */
export function rateTablePath(home: string = homedir()): string {
  return join(home, '.qwen', 'rc', 'model-rates.yaml');
}

/**
 * Built-in default table (Qwen models pre-populated), used when no file exists so
 * cost tracking works out of the box. Prices are placeholders in USD cents per
 * million tokens; the operator overrides them in the YAML file.
 */
export const DEFAULT_RATE_TABLE: RateTable = {
  currencyLabel: 'USD',
  defaultModelServiceId: 'qwen',
  models: [
    {
      modelServiceId: 'qwen',
      modelId: 'qwen3-coder-plus',
      inputPerMTok: 200,
      outputPerMTok: 800,
      cachedReadPerMTok: 20,
    },
    {
      modelServiceId: 'qwen',
      modelId: 'qwen3-coder-flash',
      inputPerMTok: 30,
      outputPerMTok: 120,
      cachedReadPerMTok: 3,
    },
  ],
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function reqString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`rate table: entry missing string "${key}"`);
  }
  return v;
}

function reqNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (!isFiniteNumber(v) || v < 0) {
    throw new Error(`rate table: entry "${key}" must be a non-negative number`);
  }
  return v;
}

/**
 * Parse + validate a rate-table YAML document. THROWS on any structural problem
 * (missing `currencyLabel`, `models` not an array, an entry missing a required
 * field) so a hot-reload retains the previous table and audits the parser error.
 */
export function parseRateTable(text: string): RateTable {
  const doc = parseYaml(text) as unknown;
  if (!doc || typeof doc !== 'object') {
    throw new Error('rate table: top-level document must be a mapping');
  }
  const root = doc as Record<string, unknown>;
  if (typeof root['currencyLabel'] !== 'string' || !root['currencyLabel']) {
    throw new Error('rate table: missing string "currencyLabel"');
  }
  if (!Array.isArray(root['models'])) {
    throw new Error('rate table: "models" must be an array');
  }
  const models: RateEntry[] = root['models'].map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`rate table: models[${i}] must be a mapping`);
    }
    const e = raw as Record<string, unknown>;
    return {
      modelServiceId: reqString(e, 'modelServiceId'),
      modelId: reqString(e, 'modelId'),
      inputPerMTok: reqNumber(e, 'inputPerMTok'),
      outputPerMTok: reqNumber(e, 'outputPerMTok'),
      cachedReadPerMTok: reqNumber(e, 'cachedReadPerMTok'),
    };
  });
  const defaultModelServiceId =
    typeof root['defaultModelServiceId'] === 'string'
      ? root['defaultModelServiceId']
      : undefined;
  return {
    currencyLabel: root['currencyLabel'],
    defaultModelServiceId,
    models,
  };
}

/**
 * Drop one trailing `(provider)` group from a model id. The live daemon names
 * models `flint(openai)` / `qwen3.8-flash-next-trtllm(openai)`: the base id plus
 * the auth/provider it was reached through. Returns the id unchanged when there is
 * no such suffix, or when stripping would leave nothing.
 */
export function stripProviderSuffix(modelId: string): string {
  const stripped = modelId.replace(/\s*\([^()]*\)\s*$/, '');
  return stripped.length > 0 ? stripped : modelId;
}

/** Which pass of {@link lookupRateMatch} found the entry. */
export type RateMatchKind = 'exact' | 'stripped';

export interface RateMatch {
  entry: RateEntry;
  /** `<modelServiceId>/<modelId>` of the table entry that matched. */
  rateKey: string;
  via: RateMatchKind;
}

/**
 * Find the entry for `(modelServiceId, modelId)`, applying the default service.
 * Pass 1 is an exact match on the id as given; pass 2 retries with the
 * `(provider)` suffix stripped, so one table entry (`flint`) prices every
 * provider spelling of that model. The result says which pass matched.
 */
export function lookupRateMatch(
  table: RateTable,
  modelServiceId: string | undefined,
  modelId: string,
): RateMatch | undefined {
  const service = modelServiceId || table.defaultModelServiceId;
  if (!service || !modelId) return undefined;
  const exact = table.models.find(
    (m) => m.modelServiceId === service && m.modelId === modelId,
  );
  if (exact) {
    return {
      entry: exact,
      rateKey: `${exact.modelServiceId}/${exact.modelId}`,
      via: 'exact',
    };
  }
  const base = stripProviderSuffix(modelId);
  if (base === modelId) return undefined;
  const hit = table.models.find(
    (m) => m.modelServiceId === service && m.modelId === base,
  );
  return hit
    ? {
        entry: hit,
        rateKey: `${hit.modelServiceId}/${hit.modelId}`,
        via: 'stripped',
      }
    : undefined;
}

/** Find the entry for `(modelServiceId, modelId)`, applying the default service. */
export function lookupRate(
  table: RateTable,
  modelServiceId: string | undefined,
  modelId: string,
): RateEntry | undefined {
  return lookupRateMatch(table, modelServiceId, modelId)?.entry;
}

/** Token counts exactly as the daemon reports them (`inputTokens` INCLUDES cached). */
export interface ReportedTokens {
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
}

export interface PricedUsage {
  costMicrocents: number;
  rateKey: string;
  rateMatch: RateMatchKind;
}

/**
 * Price a usage block as the daemon reports it, or `null` on a lookup miss.
 *
 * The daemon's `inputTokens` is `promptTokenCount`, which already CONTAINS the
 * cached subset, so the input rate applies to `inputTokens - cachedReadTokens` and
 * the cached rate to the cached part: charging the full input AND the cached read
 * would bill those tokens twice. Clamped at zero because a malformed frame could
 * report more cached than input, and a negative bill is worse than a zero one.
 * Shared by the live ingester and `qwen-rc usage reprice` so there is one formula.
 */
export function priceUsage(
  table: RateTable,
  modelServiceId: string | undefined,
  modelId: string,
  tokens: ReportedTokens,
): PricedUsage | null {
  const match = lookupRateMatch(table, modelServiceId, modelId);
  if (!match) return null;
  const pricedIn = Math.max(0, tokens.tokensIn - tokens.tokensCached);
  const e = match.entry;
  return {
    costMicrocents: Math.round(
      pricedIn * e.inputPerMTok +
        tokens.tokensOut * e.outputPerMTok +
        tokens.tokensCached * e.cachedReadPerMTok,
    ),
    rateKey: match.rateKey,
    rateMatch: match.via,
  };
}

/**
 * Compute the cost in currency cents for a usage block, or `null` on a lookup
 * miss. `cents = (in*input + out*output + cached*cachedRead) / 1e6`.
 */
export function computeCostCents(
  table: RateTable,
  modelServiceId: string | undefined,
  modelId: string,
  usage: UsageTokens,
): number | null {
  const entry = lookupRate(table, modelServiceId, modelId);
  if (!entry) return null;
  return (
    (usage.in * entry.inputPerMTok +
      usage.out * entry.outputPerMTok +
      usage.cached * entry.cachedReadPerMTok) /
    1_000_000
  );
}

/**
 * Compute the cost in INTEGER microcents (1 cent = 1 000 000 microcents) for a
 * usage block, or `null` on a lookup miss. Uses integer arithmetic at the end
 * (Math.round) to avoid floating-point accumulation errors in the store.
 *
 * Formula: microcents = round((in*input + out*output + cached*cachedRead) / 1e6 * 1e6)
 *                     = round(in*input + out*output + cached*cachedRead)
 * (The /1e6 * 1e6 for the per-million pricing cancels to a simple round of the
 *  raw weighted token sum.)
 */
export function computeCostMicrocents(
  table: RateTable,
  modelServiceId: string | undefined,
  modelId: string,
  usage: UsageTokens,
): number | null {
  const entry = lookupRate(table, modelServiceId, modelId);
  if (!entry) return null;
  // token_count * rate_per_MTok / 1e6 cents * 1e6 microcents/cent
  // = token_count * rate_per_MTok (the 1e6 factors cancel exactly)
  return Math.round(
    usage.in * entry.inputPerMTok +
      usage.out * entry.outputPerMTok +
      usage.cached * entry.cachedReadPerMTok,
  );
}

/** Read + parse the rate-table file; rejects if unreadable or malformed. */
export async function loadRateTableFile(path: string): Promise<RateTable> {
  const text = await readFile(path, 'utf8');
  return parseRateTable(text);
}

/** A swappable holder so consumers always read the latest table after a reload. */
export class RateTableHolder {
  private table: RateTable;
  constructor(initial: RateTable) {
    this.table = initial;
  }
  current(): RateTable {
    return this.table;
  }
  set(table: RateTable): void {
    this.table = table;
  }
}

export interface RateTableReloaderDeps {
  /** Audit hook for a parse/reload failure (`rate_table_parse_failed`). */
  onParseFailed: (message: string) => void;
  /** Optional: called after a successful reload (e.g. log the new currency). */
  onReloaded?: (table: RateTable) => void;
  debounceMs?: number;
  schedule?: DebouncedReloaderOptions<RateTable>['schedule'];
  cancel?: DebouncedReloaderOptions<RateTable>['cancel'];
}

/**
 * Build a debounced hot-reloader that swaps `holder` on a valid edit and, on a
 * parse failure, RETAINS the current table and reports the error via
 * `onParseFailed` (spec: "Parse error keeps old table" + audit
 * `rate_table_parse_failed`). Reuses the shared {@link DebouncedReloader}.
 */
export function createRateTableReloader(
  path: string,
  holder: RateTableHolder,
  deps: RateTableReloaderDeps,
): DebouncedReloader<RateTable> {
  return new DebouncedReloader<RateTable>({
    load: () => loadRateTableFile(path),
    apply: (table) => holder.set(table),
    onReloaded: (table) => deps.onReloaded?.(table),
    onError: (err) =>
      deps.onParseFailed(err instanceof Error ? err.message : String(err)),
    debounceMs: deps.debounceMs ?? 250,
    schedule: deps.schedule,
    cancel: deps.cancel,
  });
}
