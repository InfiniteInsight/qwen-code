/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { DebouncedReloader } from './debouncedReloader.js';

/** A manual fake timer: `flush()` runs the latest scheduled (non-cancelled) one. */
function fakeTimers() {
  let next = 1;
  const cbs = new Map<number, () => void>();
  return {
    schedule: (fn: () => void) => {
      const id = next++;
      cbs.set(id, fn);
      return id;
    },
    cancel: (h: unknown) => {
      cbs.delete(h as number);
    },
    flush() {
      const entries = [...cbs.entries()];
      cbs.clear();
      for (const [, fn] of entries) fn();
    },
    armed: () => cbs.size,
  };
}

describe('DebouncedReloader (generic, over an arbitrary value type)', () => {
  it('debounces many triggers into one reload and applies the loaded value', async () => {
    const t = fakeTimers();
    let loads = 0;
    const applied: string[] = [];
    const r = new DebouncedReloader<string>({
      load: async () => {
        loads++;
        return `v${loads}`;
      },
      apply: (v) => applied.push(v),
      onReloaded: () => {},
      onError: () => {},
      schedule: t.schedule,
      cancel: t.cancel,
    });
    r.trigger();
    r.trigger();
    r.trigger();
    expect(t.armed()).toBe(1);
    t.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(1);
    expect(applied).toEqual(['v1']);
  });

  it('on a failed load calls onError and does NOT apply (previous value retained)', async () => {
    const t = fakeTimers();
    let applied = false;
    let errored: unknown;
    const r = new DebouncedReloader<number>({
      load: async () => {
        throw new Error('bad');
      },
      apply: () => {
        applied = true;
      },
      onReloaded: () => {},
      onError: (e) => {
        errored = e;
      },
      schedule: t.schedule,
      cancel: t.cancel,
    });
    r.trigger();
    t.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toBe(false);
    expect((errored as Error).message).toBe('bad');
  });
});

/**
 * A virtual clock: `advance(ms)` moves time forward and fires every timer that
 * comes due, in order. Lets a test replay a writer that never stops.
 */
function virtualClock() {
  let nowMs = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => nowMs,
    schedule: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: nowMs + ms, fn });
      return id;
    },
    cancel: (h: unknown) => {
      timers.delete(h as number);
    },
    /** Advance time, letting async reloads settle after each fired timer. */
    async advance(ms: number) {
      const end = nowMs + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        nowMs = Math.max(nowMs, due[1].at);
        due[1].fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      nowMs = end;
    },
  };
}

describe('DebouncedReloader reload bounds (issue #156)', () => {
  const make = (
    clock: ReturnType<typeof virtualClock>,
    bounds: { minIntervalMs?: number; maxWaitMs?: number },
  ) => {
    const runs: number[] = [];
    const r = new DebouncedReloader<number>({
      load: async () => runs.length,
      apply: () => runs.push(clock.now()),
      onReloaded: () => {},
      onError: () => {},
      debounceMs: 250,
      schedule: clock.schedule,
      cancel: clock.cancel,
      now: clock.now,
      ...bounds,
    });
    return { r, runs };
  };

  it('a burst of 20 writes inside one second applies exactly once', async () => {
    const clock = virtualClock();
    const { r, runs } = make(clock, { minIntervalMs: 2000, maxWaitMs: 5000 });
    for (let i = 0; i < 20; i++) {
      r.trigger();
      await clock.advance(50);
    }
    await clock.advance(10_000);
    expect(runs).toHaveLength(1);
  });

  it('a writer that never pauses cannot starve the reload, and cannot spin it', async () => {
    const clock = virtualClock();
    const { r, runs } = make(clock, { minIntervalMs: 2000, maxWaitMs: 5000 });
    // A write every 100 ms for 60 s: always inside the 250 ms debounce window.
    for (let i = 0; i < 600; i++) {
      r.trigger();
      await clock.advance(100);
    }
    await clock.advance(10_000);
    // Not starved: it runs. Not spinning: never closer than the min interval,
    // and never more often than the max wait forces it.
    expect(runs.length).toBeGreaterThan(5);
    expect(runs.length).toBeLessThanOrEqual(13);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]! - runs[i - 1]!).toBeGreaterThanOrEqual(2000);
    }
  });

  it('a lone write after a long quiet period still reloads after the plain debounce', async () => {
    const clock = virtualClock();
    const { r, runs } = make(clock, { minIntervalMs: 2000, maxWaitMs: 5000 });
    await clock.advance(60_000);
    r.trigger();
    await clock.advance(250);
    expect(runs).toEqual([60_250]);
  });

  it('two writes closer than the min interval apart are spaced, not dropped', async () => {
    const clock = virtualClock();
    const { r, runs } = make(clock, { minIntervalMs: 2000, maxWaitMs: 5000 });
    r.trigger();
    await clock.advance(300); // first run at 250
    r.trigger(); // second edit 300 ms in
    await clock.advance(5000);
    expect(runs).toHaveLength(2);
    expect(runs[1]! - runs[0]!).toBeGreaterThanOrEqual(2000);
  });

  it('without bounds the behavior is unchanged (plain trailing debounce)', async () => {
    const clock = virtualClock();
    const { r, runs } = make(clock, {});
    r.trigger();
    await clock.advance(300);
    r.trigger();
    await clock.advance(300);
    expect(runs).toHaveLength(2);
  });
});
