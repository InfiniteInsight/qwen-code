/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { WatchPresence } from './watchPresence.js';

describe('WatchPresence', () => {
  it('tracks a single watcher join/leave', () => {
    const wp = new WatchPresence();
    expect(wp.isWatched('s1')).toBe(false);
    const leave = wp.join('s1');
    expect(wp.isWatched('s1')).toBe(true);
    leave();
    expect(wp.isWatched('s1')).toBe(false);
  });

  it('counts concurrent watchers: leave only clears at zero', () => {
    const wp = new WatchPresence();
    const leaveA = wp.join('s1');
    const leaveB = wp.join('s1');
    leaveA();
    expect(wp.isWatched('s1')).toBe(true); // B still attached
    leaveB();
    expect(wp.isWatched('s1')).toBe(false);
  });

  it('clamps an extra leave: count never goes negative / other sessions unaffected', () => {
    const wp = new WatchPresence();
    wp.join('s1');
    wp.leave('s1');
    wp.leave('s1'); // extra leave (double-disconnect) — must be a no-op
    expect(wp.isWatched('s1')).toBe(false);
    wp.join('s2');
    expect(wp.isWatched('s2')).toBe(true);
    expect(wp.isWatched('s1')).toBe(false);
  });

  it('tracks sessions independently', () => {
    const wp = new WatchPresence();
    const leaveA = wp.join('a');
    wp.join('b');
    leaveA();
    expect(wp.isWatched('a')).toBe(false);
    expect(wp.isWatched('b')).toBe(true);
  });
});
