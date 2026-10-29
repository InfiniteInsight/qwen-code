/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WriteResult } from './client.js';

/**
 * The bridge-local mirror of gateway sub-actor bans (#168). A banned chat
 * user's messages and votes are dropped here without a gateway round trip.
 *
 * Before, each runner kept a plain Set that only grew: a ban lifted on the
 * gateway (`DELETE /rc/bridges/:id/ban/:subActor`) never reached the bridge,
 * so the user stayed silenced until a restart, and every 403 was cached as a
 * ban, including `scope_required` and `session_locked`, which silenced every
 * user of a mis-scoped bridge token. Now an entry expires after
 * {@link BAN_CACHE_TTL_MS} (the next write then asks the gateway again, and a
 * standing ban re-caches itself), the cache is bounded, and only a 403 with
 * code `sub_actor_banned` counts as a ban ({@link isSubActorBan}).
 */

/** How long a cached ban holds before the gateway is asked again. */
export const BAN_CACHE_TTL_MS = 5 * 60_000;
/** Most sub-actors held at once; past it the oldest entry is dropped. */
export const BAN_CACHE_MAX = 1024;

/** The surface the dispatchers use (a plain Set satisfies it, for tests). */
export interface BanCacheLike {
  has(subActor: string): boolean;
  add(subActor: string): unknown;
}

export class BanCache implements BanCacheLike {
  /** subActor → expiry (ms). Map order is insertion order: oldest first. */
  private readonly until = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? BAN_CACHE_TTL_MS;
    this.max = opts.max ?? BAN_CACHE_MAX;
    this.now = opts.now ?? Date.now;
  }

  has(subActor: string): boolean {
    const expires = this.until.get(subActor);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.until.delete(subActor);
      return false;
    }
    return true;
  }

  /** Cache (or refresh) a ban; drops the oldest entries past the cap. */
  add(subActor: string): this {
    this.until.delete(subActor); // re-insert at the end (newest)
    this.until.set(subActor, this.now() + this.ttlMs);
    while (this.until.size > this.max) {
      const oldest = this.until.keys().next().value;
      if (oldest === undefined) break;
      this.until.delete(oldest);
    }
    return this;
  }

  get size(): number {
    return this.until.size;
  }
}

/**
 * Whether a gateway answer means the sub-actor is banned: a 403 whose JSON
 * `code` is `sub_actor_banned` (auth.ts enforceSubActorBan). Any other 403
 * (`scope_required`, `session_locked`) is a refusal to report, not a ban.
 */
export function isSubActorBan(r: WriteResult): boolean {
  return (
    r.status === 403 &&
    (r.body as { code?: unknown } | undefined)?.code === 'sub_actor_banned'
  );
}
