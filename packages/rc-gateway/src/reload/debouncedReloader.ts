/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Injected timer surface (defaults to the global timers; faked in tests). */
type Schedule = (fn: () => void, ms: number) => unknown;
type Cancel = (handle: unknown) => void;

export interface DebouncedReloaderOptions<T> {
  /** Re-read the resource. May reject (malformed file) → previous value retained. */
  load: () => Promise<T>;
  /**
   * Apply a freshly-loaded value. SHOULD be synchronous so a reload is atomic
   * relative to an in-flight consumer await-boundary (e.g. the policy enforcer's
   * `setPolicy` and the notifier's `setRouting` are both sync field swaps that a
   * reload landing mid-handler can't tear).
   */
  apply: (value: T) => void;
  /** Called after a successful apply (e.g. audit `<thing>_reloaded`). */
  onReloaded: (value: T) => void;
  /** Called when a reload FAILS (old value retained); e.g. audit the error. */
  onError: (err: unknown) => void;
  /** Debounce window in ms (default 250 — spec). */
  debounceMs?: number;
  /**
   * Floor between the START of one reload and the start of the next (default 0,
   * off). A watched file the model itself can write (issue #156) must not be
   * able to make the gateway reload, and audit, as fast as it can write.
   */
  minIntervalMs?: number;
  /**
   * Ceiling on how long a pending change may wait behind further changes
   * (default unbounded). Without it a writer that never pauses for the debounce
   * window postpones the reload forever. The min interval still applies.
   */
  maxWaitMs?: number;
  /** Clock for the two bounds above (defaults to `Date.now`; faked in tests). */
  now?: () => number;
  schedule?: Schedule;
  cancel?: Cancel;
}

/**
 * Debounced hot-reloader for a single watched resource. `trigger()` (called by a
 * filesystem watcher) coalesces rapid edits into a single reload `debounceMs`
 * later. A reload that throws/rejects RETAINS the previous value (apply is never
 * called) and reports via `onError` — a running gateway must never crash or
 * widen because the operator saved a half-typed edit. Every method is total
 * (never throws to the caller).
 *
 * Generalizes the original {@link PolicyReloader} so the routing reloader (and any
 * future config) reuses the exact debounce/coalesce/retain-on-error machinery
 * rather than re-deriving its subtle in-flight semantics.
 */
export class DebouncedReloader<T> {
  private readonly load: () => Promise<T>;
  private readonly apply: (value: T) => void;
  private readonly onReloaded: (value: T) => void;
  private readonly onError: (err: unknown) => void;
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly schedule: Schedule;
  private readonly cancel: Cancel;

  private timer: unknown = undefined;
  private running = false;
  /** A trigger arrived while a reload was in flight → run exactly once more. */
  private pending = false;
  /** When the last reload started (for the min interval). */
  private lastRunAt: number | undefined = undefined;
  /** When the oldest not-yet-run change arrived (for the max wait). */
  private firstPendingAt: number | undefined = undefined;

  constructor(opts: DebouncedReloaderOptions<T>) {
    this.load = opts.load;
    this.apply = opts.apply;
    this.onReloaded = opts.onReloaded;
    this.onError = opts.onError;
    this.debounceMs = opts.debounceMs ?? 250;
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.maxWaitMs = opts.maxWaitMs ?? Number.POSITIVE_INFINITY;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Note a filesystem change; (re)arm the debounce timer. */
  trigger(): void {
    const now = this.now();
    this.firstPendingAt ??= now;
    if (this.timer !== undefined) this.cancel(this.timer);
    // Trailing debounce, but never later than the max wait since the oldest
    // pending change, and never sooner than the min interval after the last
    // reload started. The floor wins over the ceiling: bounding the rate is
    // the point.
    const ceiling = Math.max(0, this.firstPendingAt + this.maxWaitMs - now);
    const floor =
      this.lastRunAt === undefined
        ? 0
        : Math.max(0, this.lastRunAt + this.minIntervalMs - now);
    const delay = Math.max(floor, Math.min(this.debounceMs, ceiling));
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.run();
    }, delay);
  }

  /** Cancel any pending reload (shutdown). */
  stop(): void {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
  }

  private async run(): Promise<void> {
    // Coalesce a trigger that lands while a reload is already awaiting load():
    // remember it and re-run exactly once after this pass, so the last edit wins
    // without overlapping reloads.
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    this.lastRunAt = this.now();
    this.firstPendingAt = undefined;
    try {
      const value = await this.load();
      try {
        this.apply(value);
        this.onReloaded(value);
      } catch (err) {
        // apply/onReloaded should be total; guard anyway so the reloader stays
        // total even if a callback throws.
        this.onError(err);
      }
    } catch (err) {
      // load() rejected (malformed/unreadable) → retain the previous value.
      this.onError(err);
    } finally {
      this.running = false;
    }
    if (this.pending) {
      this.pending = false;
      // With a min interval the follow-up goes back through the bounded timer
      // instead of starting immediately; unbounded keeps the original behavior.
      if (this.minIntervalMs > 0) this.trigger();
      else await this.run();
    }
  }
}
