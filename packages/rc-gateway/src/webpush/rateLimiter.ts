/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Default per-subscription push cap when a subscription sets no `maxPerHour`. */
export const DEFAULT_MAX_PER_HOUR = 30;

/**
 * Per-subscription hourly reserve for critical kinds (#169). Once the shared
 * `maxPerHour` budget is spent, a critical push (a permission prompt, a dead or
 * crashed session) spends this reserve instead of being dropped, so 30 turn
 * endings can no longer silence a `permission.required` for an hour. Small on
 * purpose: it is a floor for the pushes that need a human, not a second budget
 * a runaway loop can drain into the device.
 */
export const CRITICAL_RESERVE_PER_HOUR = 10;

const HOUR_MS = 3_600_000;

interface SubWindow {
  /** Epoch-ms of each counted send within the rolling hour. */
  hits: number[];
  /** True while the subscription is currently at/over its cap (for firstDrop). */
  dropping: boolean;
}

/** Outcome of {@link PushRateLimiter.tryConsume}. */
export interface RateLimitResult {
  /** True if the send is under the cap (and was counted); false → caller drops. */
  allowed: boolean;
  /**
   * True ONLY on the transition INTO the rate-limited state (the first drop of a
   * burst). The caller audits `push_rate_limited` only when this is true, so a
   * 1000-event/sec storm produces ONE audit row, not 1000 — the rate limit must
   * not move the flood into the audit log.
   */
  firstDrop: boolean;
}

/**
 * Per-subscription rolling-window push rate limiter (anti-fatigue, NOT security).
 * In-memory only: a restart resets the counters, which is the FAIL-OPEN
 * direction (a limiter glitch must never SUPPRESS a notification — at worst a
 * small burst of extra pushes). Every method is pure/total (no I/O, never
 * throws), so the notifier's gate needs no try/catch to preserve fail-open.
 */
export class PushRateLimiter {
  private readonly subs = new Map<string, SubWindow>();
  /** Critical-kind reserve windows, spent only once the shared cap is full. */
  private readonly reserve = new Map<string, SubWindow>();

  /**
   * Record a send if the subscription is under `maxPerHour` within the rolling
   * hour ending at `nowMs`. Returns `{ allowed, firstDrop }`: `allowed` false
   * means the caller should DROP this push; `firstDrop` is true only on the
   * transition into the at-cap state (audit only then).
   */
  tryConsume(
    subId: string,
    maxPerHour: number,
    nowMs: number,
  ): RateLimitResult {
    return take(this.subs, subId, maxPerHour, nowMs);
  }

  /**
   * {@link tryConsume} for a critical kind. While the subscription is under its
   * shared `maxPerHour` it spends that budget, exactly as before. Once the
   * shared cap is full it spends the separate `reserve` window instead, so the
   * critical push bypasses the cap but is still capped itself. `firstDrop` then
   * marks the transition into an exhausted RESERVE. A spill into the reserve
   * leaves the shared window's drop state alone, so the next ordinary drop
   * still audits as the transition it is.
   */
  tryConsumeCritical(
    subId: string,
    maxPerHour: number,
    reservePerHour: number,
    nowMs: number,
  ): RateLimitResult {
    const shared = pruned(this.subs, subId, nowMs);
    if (shared.hits.length < maxPerHour) {
      shared.hits.push(nowMs);
      shared.dropping = false;
      return { allowed: true, firstDrop: false };
    }
    return take(this.reserve, subId, reservePerHour, nowMs);
  }

  /**
   * Read-only count of how many more events fit under `maxPerHour` within the
   * rolling hour ending at `nowMs`, WITHOUT consuming a slot. Used by the idle
   * `/suggest status` endpoint to report `remainingThisHour`. Pure (clamped to
   * `[0, maxPerHour]`; prunes a local copy so it never mutates the window).
   */
  remaining(subId: string, maxPerHour: number, nowMs: number): number {
    const cutoff = nowMs - HOUR_MS;
    const entry = this.subs.get(subId);
    const live = entry ? entry.hits.filter((t) => t > cutoff).length : 0;
    return Math.max(0, maxPerHour - live);
  }

  /**
   * Give back ONE slot that {@link tryConsume} counted at `atMs`, because the
   * work it paid for never happened (#169: an idle-suggestion model call that
   * failed). A no-op when nothing was counted at that instant, so a stray or
   * repeated refund can never mint budget the caller did not spend.
   */
  refund(subId: string, atMs: number): void {
    const entry = this.subs.get(subId);
    if (!entry) return;
    const i = entry.hits.lastIndexOf(atMs);
    if (i !== -1) entry.hits.splice(i, 1);
  }

  /** Forget a subscription's windows, reserve included (e.g. on unsubscribe). */
  forget(subId: string): void {
    this.subs.delete(subId);
    this.reserve.delete(subId);
  }
}

/** The subscription's window in `map`, pruned to the hour ending at `nowMs`. */
function pruned(
  map: Map<string, SubWindow>,
  subId: string,
  nowMs: number,
): SubWindow {
  const cutoff = nowMs - HOUR_MS;
  const entry = map.get(subId) ?? { hits: [], dropping: false };
  // Prune instants that have aged out of the rolling window.
  entry.hits = entry.hits.filter((t) => t > cutoff);
  map.set(subId, entry);
  return entry;
}

/** Count a send against `map`'s window if it is under `cap`. */
function take(
  map: Map<string, SubWindow>,
  subId: string,
  cap: number,
  nowMs: number,
): RateLimitResult {
  const entry = pruned(map, subId, nowMs);
  if (entry.hits.length >= cap) {
    const firstDrop = !entry.dropping;
    entry.dropping = true;
    return { allowed: false, firstDrop };
  }
  entry.hits.push(nowMs);
  entry.dropping = false;
  return { allowed: true, firstDrop: false };
}
