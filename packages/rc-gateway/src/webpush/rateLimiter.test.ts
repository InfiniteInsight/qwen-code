/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  PushRateLimiter,
  DEFAULT_MAX_PER_HOUR,
  CRITICAL_RESERVE_PER_HOUR,
} from './rateLimiter.js';

const T0 = 1_000_000;
const HOUR = 3_600_000;

describe('PushRateLimiter', () => {
  it('allows up to the cap then drops (spec: maxPerHour 5, 6th dropped)', () => {
    const rl = new PushRateLimiter();
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(rl.tryConsume('s1', 5, T0 + i)); // 6 events within the hour
    }
    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results[5].allowed).toBe(false); // the 6th is dropped
  });

  it('audits only the TRANSITION into rate-limited (firstDrop once)', () => {
    const rl = new PushRateLimiter();
    for (let i = 0; i < 2; i++) rl.tryConsume('s1', 2, T0 + i); // fill the cap
    const sixth = rl.tryConsume('s1', 2, T0 + 2);
    const seventh = rl.tryConsume('s1', 2, T0 + 3);
    expect(sixth).toEqual({ allowed: false, firstDrop: true }); // first drop audits
    expect(seventh).toEqual({ allowed: false, firstDrop: false }); // no re-audit
  });

  it('remaining() reports unconsumed budget WITHOUT consuming a slot', () => {
    const rl = new PushRateLimiter();
    expect(rl.remaining('s1', 5, T0)).toBe(5); // untouched session → full cap
    // Reading does not consume: a subsequent read is still full.
    expect(rl.remaining('s1', 5, T0)).toBe(5);
    rl.tryConsume('s1', 5, T0);
    rl.tryConsume('s1', 5, T0 + 1);
    expect(rl.remaining('s1', 5, T0 + 2)).toBe(3); // 5 - 2 consumed
    // Clamped at 0 when over cap (never negative).
    for (let i = 0; i < 10; i++) rl.tryConsume('s1', 5, T0 + 3 + i);
    expect(rl.remaining('s1', 5, T0 + 20)).toBe(0);
    // Aged-out instants free budget again.
    expect(rl.remaining('s1', 5, T0 + HOUR + 100)).toBe(5);
  });

  it('frees a slot once an instant ages out of the window', () => {
    const rl = new PushRateLimiter();
    expect(rl.tryConsume('s1', 1, T0).allowed).toBe(true);
    expect(rl.tryConsume('s1', 1, T0 + 1).allowed).toBe(false); // at cap
    // 1h + 1ms later the lone instant has aged out → room again.
    const after = rl.tryConsume('s1', 1, T0 + HOUR + 1);
    expect(after.allowed).toBe(true);
  });

  it('re-audits a new storm episode after the window recovers', () => {
    const rl = new PushRateLimiter();
    rl.tryConsume('s1', 1, T0); // fill
    expect(rl.tryConsume('s1', 1, T0 + 1).firstDrop).toBe(true); // episode 1 drop
    // window recovers → an allowed send clears the dropping flag
    expect(rl.tryConsume('s1', 1, T0 + HOUR + 1).allowed).toBe(true);
    // fills again, next drop is a fresh transition
    expect(rl.tryConsume('s1', 1, T0 + HOUR + 2).firstDrop).toBe(true);
  });

  it('isolates subscriptions', () => {
    const rl = new PushRateLimiter();
    expect(rl.tryConsume('s1', 1, T0).allowed).toBe(true);
    expect(rl.tryConsume('s1', 1, T0 + 1).allowed).toBe(false); // s1 capped
    expect(rl.tryConsume('s2', 1, T0 + 1).allowed).toBe(true); // s2 independent
  });

  it('forget() resets a subscription window', () => {
    const rl = new PushRateLimiter();
    rl.tryConsume('s1', 1, T0);
    expect(rl.tryConsume('s1', 1, T0 + 1).allowed).toBe(false);
    rl.forget('s1');
    expect(rl.tryConsume('s1', 1, T0 + 2).allowed).toBe(true); // window cleared
  });

  it('exports a sane default cap', () => {
    expect(DEFAULT_MAX_PER_HOUR).toBe(30);
  });
});

describe('PushRateLimiter.refund (#169)', () => {
  it('gives back the slot counted at that instant', () => {
    const rl = new PushRateLimiter();
    expect(rl.tryConsume('s1', 1, T0).allowed).toBe(true);
    expect(rl.remaining('s1', 1, T0)).toBe(0);
    rl.refund('s1', T0);
    expect(rl.remaining('s1', 1, T0)).toBe(1);
    expect(rl.tryConsume('s1', 1, T0 + 1).allowed).toBe(true);
  });

  it('refunds only one slot, and never one it did not count', () => {
    const rl = new PushRateLimiter();
    rl.tryConsume('s1', 5, T0);
    rl.tryConsume('s1', 5, T0);
    rl.refund('s1', T0);
    expect(rl.remaining('s1', 5, T0)).toBe(4);
    rl.refund('s1', T0 + 999); // nothing counted then
    rl.refund('s2', T0); // unknown subscription
    expect(rl.remaining('s1', 5, T0)).toBe(4);
    expect(rl.remaining('s2', 5, T0)).toBe(5);
  });
});

describe('PushRateLimiter.tryConsumeCritical (#169)', () => {
  it('spends the shared budget first, exactly like tryConsume, while under the cap', () => {
    const rl = new PushRateLimiter();
    expect(rl.tryConsumeCritical('s1', 1, 3, T0)).toEqual({
      allowed: true,
      firstDrop: false,
    });
    // The critical push used the shared slot: an ordinary push is now capped.
    expect(rl.tryConsume('s1', 1, T0 + 1).allowed).toBe(false);
  });

  it('bypasses an exhausted shared cap through its own small reserve', () => {
    const rl = new PushRateLimiter();
    for (let i = 0; i < 2; i++) rl.tryConsume('s1', 2, T0 + i); // shared cap full
    expect(rl.tryConsume('s1', 2, T0 + 2).allowed).toBe(false);
    // Critical kinds still get through, up to the reserve...
    expect(rl.tryConsumeCritical('s1', 2, 2, T0 + 3).allowed).toBe(true);
    expect(rl.tryConsumeCritical('s1', 2, 2, T0 + 4).allowed).toBe(true);
    // ...and the reserve is itself capped, auditing its own transition once.
    expect(rl.tryConsumeCritical('s1', 2, 2, T0 + 5)).toEqual({
      allowed: false,
      firstDrop: true,
    });
    expect(rl.tryConsumeCritical('s1', 2, 2, T0 + 6)).toEqual({
      allowed: false,
      firstDrop: false,
    });
    // The reserve ages out of the rolling hour like the shared window.
    expect(rl.tryConsumeCritical('s1', 2, 2, T0 + HOUR + 10).allowed).toBe(
      true,
    );
  });

  it('a critical spill does not swallow the next ordinary drop audit', () => {
    const rl = new PushRateLimiter();
    rl.tryConsume('s1', 1, T0); // shared cap full, not yet dropping
    expect(rl.tryConsumeCritical('s1', 1, 5, T0 + 1).allowed).toBe(true);
    // The first ORDINARY drop is still the transition, so it still audits.
    expect(rl.tryConsume('s1', 1, T0 + 2)).toEqual({
      allowed: false,
      firstDrop: true,
    });
  });

  it('forget() clears the critical reserve too', () => {
    const rl = new PushRateLimiter();
    rl.tryConsume('s1', 1, T0);
    rl.tryConsumeCritical('s1', 1, 1, T0 + 1); // reserve full
    expect(rl.tryConsumeCritical('s1', 1, 1, T0 + 2).allowed).toBe(false);
    rl.forget('s1');
    rl.tryConsume('s1', 1, T0 + 3); // refill the shared slot
    expect(rl.tryConsumeCritical('s1', 1, 1, T0 + 4).allowed).toBe(true);
  });

  it('exports a small critical reserve', () => {
    expect(CRITICAL_RESERVE_PER_HOUR).toBeGreaterThan(0);
    expect(CRITICAL_RESERVE_PER_HOUR).toBeLessThan(DEFAULT_MAX_PER_HOUR);
  });
});
