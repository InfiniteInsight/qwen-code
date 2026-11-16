/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { WorkingDeviceTracker, recordActivity } from './workingDevice.js';

describe('WorkingDeviceTracker', () => {
  it('reports an unknown token as not working', () => {
    const tracker = new WorkingDeviceTracker();
    expect(tracker.isWorking('never-seen')).toBe(false);
  });

  it('reports a token working after touch and not working past the window', () => {
    let now = 1000;
    const tracker = new WorkingDeviceTracker(120000, () => now);
    tracker.touch('t1');
    expect(tracker.isWorking('t1')).toBe(true);

    // Just under the window → still working.
    now = 1000 + 119999;
    expect(tracker.isWorking('t1')).toBe(true);

    // At/past the window → no longer working.
    now = 1000 + 120000;
    expect(tracker.isWorking('t1')).toBe(false);

    // A second touch re-arms it.
    tracker.touch('t1');
    expect(tracker.isWorking('t1')).toBe(true);
  });

  it('forgets a revoked token immediately and ignores unknown tokens', () => {
    const now = 1000;
    const tracker = new WorkingDeviceTracker(120000, () => now);
    tracker.touch('t1');
    tracker.touch('t2');
    expect(tracker.isWorking('t1')).toBe(true);

    tracker.forget('t1');
    expect(tracker.isWorking('t1')).toBe(false);
    expect(tracker.isWorking('t2')).toBe(true);

    expect(() => tracker.forget('never-seen')).not.toThrow();
  });

  it('prunes expired entries once the map exceeds 256 tokens while preserving live ones', () => {
    let now = 1000;
    const tracker = new WorkingDeviceTracker(60_000, () => now);
    for (let i = 0; i < 256; i++) {
      tracker.touch(`stale-${i}`);
    }
    now += 40_000;
    tracker.touch('still-live');
    // Advance so stale-0..255 are expired (>= 60_000) while still-live is 25_000 old.
    now += 25_000;
    // Touching another token pushes size > 256 and sweeps expired entries.
    tracker.touch('fresh');

    expect(tracker.isWorking('stale-0')).toBe(false);
    expect(tracker.isWorking('stale-255')).toBe(false);
    expect(tracker.isWorking('still-live')).toBe(true);
    expect(tracker.isWorking('fresh')).toBe(true);
    expect((tracker as unknown as { last: Map<string, number> }).last.size).toBe(
      2,
    );
  });
});

describe('recordActivity middleware', () => {
  it('touches the tracker for a req carrying rcClient.id and calls next', () => {
    const tracker = new WorkingDeviceTracker();
    const req = { rcClient: { id: 'tok-1', scopes: [] } } as unknown as Request;
    const res = {} as Response;
    let nextCalled = false;
    recordActivity(tracker)(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(tracker.isWorking('tok-1')).toBe(true);
  });

  it('does not throw and records nothing when rcClient is absent, still calling next', () => {
    const tracker = new WorkingDeviceTracker();
    const req = {} as Request;
    const res = {} as Response;
    let nextCalled = false;
    expect(() =>
      recordActivity(tracker)(req, res, () => {
        nextCalled = true;
      }),
    ).not.toThrow();
    expect(nextCalled).toBe(true);
  });
});
