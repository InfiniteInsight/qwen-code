/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Glue between the session-event pump and the usage ingester
 * (Qwen-Code-Remote#160 / #181): it owns the "which model" problem so
 * {@link UsageIngester.ingest} can stay synchronous and pure.
 *
 * Design choice: QUEUE, do not make the pump await. The pump's `onEvent` runs
 * inline in the per-session subscribe loop, so resolving the model there (a
 * `/context` round trip, possibly a transcript read) would stall the stream, and
 * the stream is the thing the user is watching. Instead a usage frame whose model
 * is not yet known is parked in a small per-session queue (bounded, with a
 * deadline) and the ingester is called later with the id as plain data. The
 * ingester therefore never learns that models are asynchronous, and tests drive it
 * with literals. The one cost is that a queued row is written a moment late; it
 * keeps its arrival `ts` and its arrival attribution so that is invisible in the
 * data.
 *
 * A frame that cannot be matched to a model (no source answers, the deadline
 * passes, or the queue overflows) is NOT discarded: it is written with an empty
 * model id, i.e. unpriced and visibly so, and one audit row says how many. The
 * tokens still count and `qwen-rc usage reprice` can price the row later from the
 * transcript. Silently dropping a cost row is worse than recording it unpriced.
 */

import {
  extractUsage,
  type IngestOptions,
  type UsageAttribution,
} from './ingester.js';
import type { SessionModelCache } from './sessionModelCache.js';

export interface UsageFeederDeps {
  cache: SessionModelCache;
  ingester: {
    ingest(
      sessionId: string,
      data: unknown,
      attribution: UsageAttribution,
      opts?: IngestOptions,
    ): unknown;
  };
  attributionFor: (sessionId: string) => UsageAttribution;
  now: () => number;
  /** How long a frame may wait for its model id (default 10 s). */
  maxWaitMs?: number;
  /** Frames parked per session before the oldest is written unpriced (default 64). */
  maxQueuePerSession?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Called once per batch of frames written without a model id. */
  onUnresolved?: (sessionId: string, count: number) => void;
}

interface Queued {
  data: unknown;
  attribution: UsageAttribution;
  ts: number;
}

interface Pending {
  frames: Queued[];
  timer: unknown;
}

export class UsageFeeder {
  private readonly deps: UsageFeederDeps;
  private readonly pending = new Map<string, Pending>();

  constructor(deps: UsageFeederDeps) {
    this.deps = deps;
  }

  /** Feed every pump frame here. Never throws, never blocks. */
  onEvent(sessionId: string, ev: { type: string; data: unknown }): void {
    const { cache } = this.deps;
    if (ev.type === 'model_switched') {
      const id = (ev.data as { modelId?: unknown } | null)?.modelId;
      if (typeof id === 'string' && id.trim()) cache.set(sessionId, id.trim());
      return;
    }
    if (ev.type === 'session_closed') {
      cache.forget(sessionId);
      return;
    }
    // First sight of a session: start seeding now, even if this frame carries no
    // usage, so the id is usually there by the time the first turn ends.
    if (cache.get(sessionId) === undefined) void cache.ensure(sessionId);

    const usage = extractUsage(ev.data);
    if (!usage) return;
    const attribution = this.deps.attributionFor(sessionId);
    const known = cache.get(sessionId);
    const queued = this.pending.get(sessionId);
    // Order is kept per session: if anything is already parked, this frame joins
    // the queue even when the id has just become known.
    if (!queued && (usage.modelId || known !== undefined)) {
      this.ingestNow(sessionId, ev.data, attribution, known ?? '');
      return;
    }
    this.enqueue(sessionId, {
      data: ev.data,
      attribution,
      ts: this.deps.now(),
    });
  }

  private ingestNow(
    sessionId: string,
    data: unknown,
    attribution: UsageAttribution,
    modelId: string,
    ts?: number,
  ): void {
    try {
      this.deps.ingester.ingest(sessionId, data, attribution, {
        modelId,
        ...(ts !== undefined ? { ts } : {}),
      });
    } catch {
      /* ingestion is best-effort; one bad row must not lose the rest */
    }
  }

  private enqueue(sessionId: string, frame: Queued): void {
    let p = this.pending.get(sessionId);
    if (!p) {
      const schedule =
        this.deps.schedule ?? ((fn, ms) => unrefTimer(setTimeout(fn, ms)));
      p = { frames: [], timer: undefined };
      const entry = p;
      this.pending.set(sessionId, entry);
      entry.timer = schedule(
        () => this.drain(sessionId, ''),
        this.deps.maxWaitMs ?? 10_000,
      );
      void this.deps.cache.ensure(sessionId).then(
        (id) => this.drain(sessionId, id ?? ''),
        () => this.drain(sessionId, ''),
      );
    }
    p.frames.push(frame);
    const max = this.deps.maxQueuePerSession ?? 64;
    if (p.frames.length > max) {
      const oldest = p.frames.shift() as Queued;
      this.ingestNow(sessionId, oldest.data, oldest.attribution, '', oldest.ts);
      this.deps.onUnresolved?.(sessionId, 1);
    }
  }

  /** Write every parked frame for the session with `modelId` ('' = unresolved). */
  private drain(sessionId: string, modelId: string): void {
    const p = this.pending.get(sessionId);
    if (!p) return;
    this.pending.delete(sessionId);
    (this.deps.cancel ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(p.timer);
    for (const f of p.frames) {
      this.ingestNow(sessionId, f.data, f.attribution, modelId, f.ts);
    }
    if (!modelId && p.frames.length > 0) {
      this.deps.onUnresolved?.(sessionId, p.frames.length);
    }
  }
}

function unrefTimer(t: NodeJS.Timeout): NodeJS.Timeout {
  t.unref?.();
  return t;
}
