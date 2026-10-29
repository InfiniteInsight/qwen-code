/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Usage ingestion for cost tracking (`add-cost-tracking`: "Ingest priced rows" +
 * "`usage_tick` SSE event"). On each `session_update` that carries a usage block,
 * the ingester prices it against the current rate table, writes a `usage_events`
 * row attributed to the originating client (+ bridge sub-actor), and schedules a
 * coalesced `usage_tick` with the session's running totals.
 *
 * The ingest path is ADDITIVE: it neither modifies, drops, nor delays the SSE
 * frame to subscribers (callers invoke {@link UsageIngester.ingest} alongside the
 * normal relay, never in its place).
 *
 * `extractUsage` reads the runtime frame shape `data.update._meta.usage`. The
 * cached-token key was re-pinned against the EMITTER, not the serve demo:
 * `createTranscriptUsageUpdate` (packages/acp-bridge/src/transcript-replay.ts)
 * writes `cachedReadTokens` from `cachedContentTokenCount`, and the cli,
 * web-shell and sdk readers all read that same name. The `cacheReadInputTokens`
 * spelling this file used to lead with belongs to a DIFFERENT payload
 * (protocol.ts), so leading with it left `tokensCached` at 0 on every live frame.
 *
 * The model id is not in `_meta` at all: `buildUpdateMeta` emits only `usage`,
 * `timestamp` and `qwenTranscript`, and the live usage object is exactly
 * `{inputTokens, outputTokens, totalTokens, cachedReadTokens}`. So the id comes
 * from OUTSIDE the frame: the caller passes it via `ingest(..., { modelId })`,
 * resolved per session by `SessionModelCache` and handed over by `UsageFeeder`
 * (see usageFeeder.ts for why the ingester itself stays synchronous and pure).
 * A model id the frame does carry still wins, so a daemon that starts emitting
 * one is believed over the cache. Qwen-Code-Remote#160 / #181.
 */

import type { RateTableHolder } from './rateTable.js';
import { priceUsage } from './rateTable.js';
import type { UsageStore } from './usageStore.js';

/** What `extractUsage` pulls from a usage-bearing `session_update`. */
export interface ExtractedUsage {
  modelServiceId?: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  stage: string | null;
}

/** Attribution captured from the originating request for this session's turn. */
export interface UsageAttribution {
  attributionTokenId: string;
  subActor: string | null;
}

/** The `usage_tick` SSE payload. */
export interface UsageTick {
  sessionId: string;
  /** Running session cost total in microcents (integer). */
  costMicrocentsSesTotal: number;
  /** Current prompt cost total in microcents (integer). */
  costMicrocentsPromptTotal: number;
  tokensInTotal: number;
  tokensOutTotal: number;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return '';
}

/**
 * Pull a usage block out of a `session_update` frame's `data`, or `null` when the
 * frame carries no usage. Reads `data.update._meta.usage` (the runtime shape) and
 * is tolerant of camelCase/snake_case token spellings.
 *
 * Gated to `agent_message_chunk` — the ONE update type the serve demo reads usage
 * on (at message end). Other frames may ALSO carry a usage block (e.g. a `result`
 * message in protocol.ts), and counting both would double-charge the same turn; so
 * usage is taken only from the confirmed locus, never every frame that happens to
 * carry `_meta.usage`.
 */
export function extractUsage(data: unknown): ExtractedUsage | null {
  if (!data || typeof data !== 'object') return null;
  const update = (data as { update?: unknown }).update ?? data;
  if (!update || typeof update !== 'object') return null;
  if (
    (update as { sessionUpdate?: unknown }).sessionUpdate !==
    'agent_message_chunk'
  ) {
    return null; // only price the assistant message-chunk usage (no double-count)
  }
  const meta = (update as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object') return null;
  const usage = (meta as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const tokensIn = num(u['inputTokens'] ?? u['input_tokens']);
  const tokensOut = num(u['outputTokens'] ?? u['output_tokens']);
  // `cachedReadTokens` first: it is what the daemon emits. The other two are a
  // different payload's spelling, kept as aliases, and were previously the only
  // names read here, which is why every live row stored tokens_cached = 0.
  const tokensCached = num(
    u['cachedReadTokens'] ??
      u['cacheReadInputTokens'] ??
      u['cache_read_input_tokens'],
  );
  // No usage signal at all → treat as a non-usage frame.
  if (tokensIn === 0 && tokensOut === 0 && tokensCached === 0) return null;
  const m = meta as Record<string, unknown>;
  return {
    modelServiceId:
      firstString(m['modelServiceId'], m['model_service_id']) || undefined,
    modelId: firstString(m['modelId'], m['model'], m['model_id']),
    tokensIn,
    tokensOut,
    tokensCached,
    stage: firstString(m['stage']) || null,
  };
}

/**
 * Coalesces `usage_tick` emission to at most one per `windowMs` (default 500) per
 * session: the first tick for an idle session emits immediately on the next turn
 * of the event loop; further ticks within the window are collapsed into a single
 * trailing emit carrying the LATEST totals. Timer is injected for tests.
 */
export class UsageTickCoalescer {
  private readonly windowMs: number;
  private readonly emit: (tick: UsageTick) => void;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (h: unknown) => void;
  /** sessionId → latest pending tick + its armed timer. */
  private readonly pending = new Map<
    string,
    { tick: UsageTick; timer: unknown }
  >();

  constructor(opts: {
    emit: (tick: UsageTick) => void;
    windowMs?: number;
    schedule?: (fn: () => void, ms: number) => unknown;
    cancel?: (h: unknown) => void;
  }) {
    this.emit = opts.emit;
    this.windowMs = opts.windowMs ?? 500;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Record the latest totals for a session and (re)arm the trailing emit. */
  push(tick: UsageTick): void {
    const existing = this.pending.get(tick.sessionId);
    if (existing) {
      existing.tick = tick; // keep latest; timer already armed
      return;
    }
    // Set the entry BEFORE arming the timer: a synchronous timer (tests) would
    // otherwise flush before the entry exists and emit nothing.
    const entry: { tick: UsageTick; timer: unknown } = {
      tick,
      timer: undefined,
    };
    this.pending.set(tick.sessionId, entry);
    entry.timer = this.schedule(
      () => this.flush(tick.sessionId),
      this.windowMs,
    );
  }

  private flush(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    this.pending.delete(sessionId);
    this.emit(entry.tick);
  }

  /** Cancel all pending timers (shutdown). */
  stop(): void {
    for (const { timer } of this.pending.values()) this.cancel(timer);
    this.pending.clear();
  }
}

export interface UsageIngesterDeps {
  rates: RateTableHolder;
  store: UsageStore;
  coalescer: UsageTickCoalescer;
  /** Monotonic-ish wall clock (injected for tests). */
  now: () => number;
  /** Audit hook for a rate-table lookup miss (`rate_table_miss`). */
  onRateMiss?: (
    modelServiceId: string | undefined,
    modelId: string,
    sessionId: string,
  ) => void;
  /**
   * Collapse window for `onRateMiss`: one report per (session, modelId) per
   * window (default one hour). The unpriced ROWS are still written every time;
   * only the audit noise is collapsed (632 identical rows in the live log).
   */
  rateMissWindowMs?: number;
}

/** Optional per-call context for {@link UsageIngester.ingest}. */
export interface IngestOptions {
  /** The session's model id, from outside the frame (the frame has none). */
  modelId?: string;
  /** When the frame was observed, if earlier than now (a queued event). */
  ts?: number;
}

/**
 * Prices + persists usage rows and drives `usage_tick`. Holds per-session prompt
 * accumulators (reset by {@link notePromptBoundary}) so a tick can report the
 * current prompt's cost alongside the session lifetime cost.
 */
export class UsageIngester {
  private readonly deps: UsageIngesterDeps;
  /** sessionId → cost microcents accumulated since the last prompt boundary. */
  private readonly promptTotals = new Map<string, number>();
  /** `sessionId\0modelId` → when a rate miss was last reported. */
  private readonly missReportedAt = new Map<string, number>();

  constructor(deps: UsageIngesterDeps) {
    this.deps = deps;
  }

  /** A new prompt starts a fresh per-prompt cost accumulator for the session. */
  notePromptBoundary(sessionId: string): void {
    this.promptTotals.set(sessionId, 0);
  }

  /**
   * Ingest a `session_update` frame's `data`. No-op when the frame carries no
   * usage. Returns the row's cost in microcents (or null on a rate-table miss) for
   * tests; production callers ignore the return.
   */
  ingest(
    sessionId: string,
    data: unknown,
    attribution: UsageAttribution,
    opts: IngestOptions = {},
  ): number | null | undefined {
    const usage = extractUsage(data);
    if (!usage) return undefined;
    const modelId = usage.modelId || opts.modelId || '';
    const table = this.deps.rates.current();
    // The stored row keeps the reported totals; `priceUsage` splits the cached
    // subset out of the input before pricing (see its comment).
    const priced = priceUsage(table, usage.modelServiceId, modelId, usage);
    const costMicrocents = priced ? priced.costMicrocents : null;
    if (costMicrocents === null) this.reportRateMiss(sessionId, usage, modelId);
    this.deps.store.record({
      sessionId,
      ts: opts.ts ?? this.deps.now(),
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      tokensCached: usage.tokensCached,
      costMicrocents,
      modelServiceId: usage.modelServiceId ?? table.defaultModelServiceId ?? '',
      modelId,
      attributionTokenId: attribution.attributionTokenId,
      subActor: attribution.subActor,
      stage: usage.stage,
      rateKey: priced?.rateKey ?? null,
      rateMatch: priced?.rateMatch ?? null,
    });
    const promptTotal =
      (this.promptTotals.get(sessionId) ?? 0) + (costMicrocents ?? 0);
    this.promptTotals.set(sessionId, promptTotal);
    const totals = this.deps.store.sessionTotals(sessionId);
    this.deps.coalescer.push({
      sessionId,
      costMicrocentsSesTotal: totals.costMicrocentsSesTotal,
      costMicrocentsPromptTotal: promptTotal,
      tokensInTotal: totals.tokensInTotal,
      tokensOutTotal: totals.tokensOutTotal,
    });
    return costMicrocents;
  }

  private reportRateMiss(
    sessionId: string,
    usage: ExtractedUsage,
    modelId: string,
  ): void {
    const hook = this.deps.onRateMiss;
    if (!hook) return;
    const now = this.deps.now();
    const window = this.deps.rateMissWindowMs ?? 3_600_000;
    const key = `${sessionId}\0${modelId}`;
    const last = this.missReportedAt.get(key);
    if (last !== undefined && now - last < window) return;
    if (this.missReportedAt.size >= 4096) {
      for (const [k, at] of this.missReportedAt) {
        if (now - at >= window) this.missReportedAt.delete(k);
      }
      if (this.missReportedAt.size >= 4096) this.missReportedAt.clear();
    }
    this.missReportedAt.set(key, now);
    hook(usage.modelServiceId, modelId, sessionId);
  }
}
