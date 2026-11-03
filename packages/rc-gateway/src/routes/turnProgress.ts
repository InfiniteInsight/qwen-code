/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-turn progress accounting for `POST /session/:id/prompt`
 * (openspec change `add-turn-progress-signal`, task 1.2).
 *
 * The gateway's per-turn ceiling is absolute because the gateway cannot tell a
 * working turn from a wedged one: it learns a turn is alive only by holding one
 * promise, and the frames a turn emits reach it only while it is awaiting that
 * promise. A quiet-period window keyed on that blindness would abort a turn
 * parked inside one long tool call that streams nothing, which is a worse
 * failure than the ceiling it would replace.
 *
 * So nothing here enforces anything. It records, per turn, how many frames the
 * wait observed and the longest interval between two consecutive frames, and
 * those numbers ride the `detail` of the audit row the turn already writes. The
 * window is chosen later, from the distribution this builds, and until then the
 * absolute ceiling from `promptTimeout.ts` stays the only bound.
 *
 * The clock is injectable and defaults to `performance.now()`, a monotonic
 * source: a wall clock that steps backwards under NTP would otherwise record a
 * negative gap, or hide a real one.
 */

/** What a meter reports about one turn, in the shape `detail` takes. */
export interface TurnProgressSummary {
  frames?: number;
  maxGapMs?: number;
}

export interface TurnProgressMeter {
  /**
   * Called once per event frame the prompt wait observes. Takes no argument on
   * purpose: it stays assignable to a `(frameType: string) => void` observer
   * while making it impossible to record frame content, which is the rule every
   * other key in this `detail` already follows.
   */
  observe(): void;
  /**
   * The turn's numbers, or `{}` for a turn that observed no frame at all. A
   * turn the daemon answered without a subscription has no gap, and storing a
   * gap of zero for it would say "this turn never went quiet" about a turn
   * nobody ever saw a frame from.
   *
   * `maxGapMs` on a one-frame turn is the wait for that first frame, not zero.
   * Skipping it would report a clean gap for the shape that matters most: a
   * turn that emits nothing at all until its terminal frame, which is the wedged
   * turn a future window has to catch. The turn's start is therefore the first
   * sign of progress, and the terminal frame is a frame like any other, so the
   * last recorded interval ends at completion.
   */
  summary(): TurnProgressSummary;
}

export function createTurnProgressMeter(
  now: () => number = () => performance.now(),
): TurnProgressMeter {
  let frames = 0;
  // Seeded at construction, not at zero: `observe()` treats the turn's start as
  // the first sign of progress, so a turn that emits nothing until its terminal
  // frame records the real leading silence. Left at zero this would report the
  // process's whole uptime as that turn's gap, and one such row would poison
  // the distribution the window is meant to be chosen from.
  let lastAt = now();
  let maxGapMs: number | undefined;

  return {
    observe(): void {
      const at = now();
      const gapMs = at - lastAt;
      if (maxGapMs === undefined || gapMs > maxGapMs) maxGapMs = gapMs;
      lastAt = at;
      frames += 1;
    },
    summary(): TurnProgressSummary {
      if (frames === 0) return {};
      return maxGapMs === undefined
        ? { frames }
        : { frames, maxGapMs: Math.round(maxGapMs) };
    },
  };
}
