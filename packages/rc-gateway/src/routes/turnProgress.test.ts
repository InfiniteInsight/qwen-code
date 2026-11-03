/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createTurnProgressMeter } from './turnProgress.js';

/** A clock the test advances by hand, so a gap is exactly the number it claims. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe('createTurnProgressMeter', () => {
  it('reports nothing at all for a turn that never observed a frame', () => {
    // The 200 path: the daemon answered with a parsed result, so no
    // subscription was opened and no frame exists. An empty summary means
    // "not measured". Emitting `{ frames: 0, maxGapMs: 0 }` would instead
    // assert that the turn was loud throughout, which is the opposite fact, and
    // a reader sizing a quiet-period window from it would be lied to.
    const clock = fakeClock();
    const meter = createTurnProgressMeter(clock.now);
    clock.advance(600_000);
    expect(meter.summary()).toEqual({});
  });

  it('counts the silence before the first frame, because that is the wedge shape', () => {
    // A turn that emits nothing until its terminal frame is the turn a future
    // window has to catch. Reporting `maxGapMs: 0` here, or omitting the gap
    // because "there is only one frame", would score that turn as the quietest
    // possible one, which is backwards.
    const clock = fakeClock();
    const meter = createTurnProgressMeter(clock.now);
    clock.advance(45_000);
    meter.observe();
    expect(meter.summary()).toEqual({ frames: 1, maxGapMs: 45_000 });
  });

  it('keeps the longest gap of several, not the last one', () => {
    const clock = fakeClock();
    const meter = createTurnProgressMeter(clock.now);
    for (const gapMs of [10, 400, 20, 90]) {
      clock.advance(gapMs);
      meter.observe();
    }
    expect(meter.summary()).toEqual({ frames: 4, maxGapMs: 400 });
  });

  it('counts the frames, because a gap means nothing without them', () => {
    // A 40-minute gap on a turn that streamed 900 frames first is a different
    // fact from a 40-minute gap on a turn that produced three frames total. The
    // two numbers are only readable next to each other.
    const clock = fakeClock();
    const meter = createTurnProgressMeter(clock.now);
    clock.advance(1);
    for (let i = 0; i < 7; i += 1) meter.observe();
    expect(meter.summary()).toEqual({ frames: 7, maxGapMs: 1 });
  });

  it('rounds the fractional monotonic reading to whole ms', () => {
    // `performance.now()` answers with fractions. A duration carried into a
    // hash-chained audit file as 12.600000000000001 is noise for a reader who
    // is counting minutes.
    let t = 0;
    const meter = createTurnProgressMeter(() => t);
    t += 12.6;
    meter.observe();
    expect(meter.summary()).toEqual({ frames: 1, maxGapMs: 13 });
  });

  it('cannot be dragged negative by a clock that stepped backwards', () => {
    // The default clock is `performance.now()` precisely so this cannot happen
    // from NTP or a DST change. Asserted anyway, because a negative value in
    // the tail of the recorded distribution would read as an impossibly quiet
    // turn and pull any window computed from it the wrong way.
    const clock = fakeClock();
    const meter = createTurnProgressMeter(clock.now);
    clock.advance(1_000);
    meter.observe();
    clock.advance(-500);
    meter.observe();
    expect(meter.summary()).toEqual({ frames: 2, maxGapMs: 1_000 });
  });
});
