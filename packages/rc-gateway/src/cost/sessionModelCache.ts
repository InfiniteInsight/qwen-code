/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-session "which model is this conversation running" cache for cost tracking
 * (Qwen-Code-Remote#160 / #181). The usage frame the daemon emits carries no model
 * id, so the gateway keeps its own:
 *
 *   - SEED on first sight of a session from the daemon's `/context`
 *     (`state.models`, the entry flagged `isCurrent`), falling back to the session
 *     transcript (`readSessionModel`) when the daemon cannot be read;
 *   - MAINTAIN from `model_switched` frames ({@link SessionModelCache.set}).
 *
 * `get` is synchronous so the hot path stays cheap; `ensure` is the async seed,
 * deduplicated per session. A failed seed is remembered for a short backoff so a
 * dead daemon is not asked again on every frame.
 */

export interface SessionModelCacheDeps {
  /** The daemon's `/session/:id/context` reduced to a model id (or null/throw). */
  fromContext: (sessionId: string) => Promise<string | null>;
  /** The transcript's last assistant model (or null/throw). */
  fromTranscript: (sessionId: string) => Promise<string | null>;
  now: () => number;
  /** How long a failed seed suppresses a retry (default 30 s). */
  failureBackoffMs?: number;
  /** Cap on remembered sessions; the oldest is evicted (default 2000). */
  maxSessions?: number;
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function currentOf(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  for (const m of list) {
    if (
      m &&
      typeof m === 'object' &&
      (m as { isCurrent?: unknown }).isCurrent
    ) {
      const id = nonEmpty((m as { modelId?: unknown }).modelId);
      if (id) return id;
    }
  }
  return null;
}

/**
 * Pull the current model id out of a `DaemonSessionContextStatus`. `state.models`
 * is typed `unknown` in the SDK and is seen in four shapes: a `currentModelId`
 * field, a `current: { modelId }` object, `providers[].models[]`, and a flat or
 * `availableModels` list; the entry flagged `isCurrent` is the answer in the list
 * shapes.
 */
export function modelIdFromContext(ctx: unknown): string | null {
  if (!ctx || typeof ctx !== 'object') return null;
  const state = (ctx as { state?: unknown }).state;
  if (!state || typeof state !== 'object') return null;
  const models = (state as { models?: unknown }).models;
  if (!models || typeof models !== 'object') return null;
  if (Array.isArray(models)) return currentOf(models);
  const m = models as {
    currentModelId?: unknown;
    current?: unknown;
    providers?: unknown;
    availableModels?: unknown;
  };
  const direct =
    nonEmpty(m.currentModelId) ??
    nonEmpty((m.current as { modelId?: unknown } | null | undefined)?.modelId);
  if (direct) return direct;
  if (Array.isArray(m.providers)) {
    for (const p of m.providers) {
      const id = currentOf((p as { models?: unknown } | null)?.models);
      if (id) return id;
    }
  }
  return currentOf(m.availableModels);
}

export class SessionModelCache {
  private readonly deps: SessionModelCacheDeps;
  private readonly known = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly failedAt = new Map<string, number>();
  /** Bumped by set/forget so a seed that lost the race does not overwrite. */
  private readonly generation = new Map<string, number>();

  constructor(deps: SessionModelCacheDeps) {
    this.deps = deps;
  }

  get(sessionId: string): string | undefined {
    return this.known.get(sessionId);
  }

  /** Record the current model (a `model_switched` frame). */
  set(sessionId: string, modelId: string): void {
    this.bump(sessionId);
    this.known.delete(sessionId); // re-insert so eviction order tracks recency
    this.known.set(sessionId, modelId);
    this.failedAt.delete(sessionId);
    this.evict();
  }

  forget(sessionId: string): void {
    this.bump(sessionId);
    this.known.delete(sessionId);
    this.failedAt.delete(sessionId);
    this.generation.delete(sessionId);
  }

  /**
   * The session's model, seeding it if unknown. Resolves null when no source
   * could name one (also served from the failure backoff without a new read).
   */
  ensure(sessionId: string): Promise<string | null> {
    const have = this.known.get(sessionId);
    if (have !== undefined) return Promise.resolve(have);
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const failed = this.failedAt.get(sessionId);
    const backoff = this.deps.failureBackoffMs ?? 30_000;
    if (failed !== undefined && this.deps.now() - failed < backoff) {
      return Promise.resolve(null);
    }
    const startedGen = this.generation.get(sessionId) ?? 0;
    const p = this.seed(sessionId)
      .then((id) => {
        if ((this.generation.get(sessionId) ?? 0) !== startedGen) {
          // A switch (or forget) landed while we were reading: it is newer.
          return this.known.get(sessionId) ?? null;
        }
        if (id) {
          this.known.set(sessionId, id);
          this.failedAt.delete(sessionId);
          this.evict();
        } else {
          this.failedAt.set(sessionId, this.deps.now());
        }
        return id;
      })
      .finally(() => {
        this.inFlight.delete(sessionId);
      });
    this.inFlight.set(sessionId, p);
    return p;
  }

  private async seed(sessionId: string): Promise<string | null> {
    try {
      const id = nonEmpty(await this.deps.fromContext(sessionId));
      if (id) return id;
    } catch {
      /* fall through to the transcript */
    }
    try {
      return nonEmpty(await this.deps.fromTranscript(sessionId));
    } catch {
      return null;
    }
  }

  private bump(sessionId: string): void {
    this.generation.set(sessionId, (this.generation.get(sessionId) ?? 0) + 1);
  }

  private evict(): void {
    const max = this.deps.maxSessions ?? 2000;
    while (this.known.size > max) {
      const oldest = this.known.keys().next().value as string;
      this.known.delete(oldest);
      this.generation.delete(oldest);
    }
  }
}
