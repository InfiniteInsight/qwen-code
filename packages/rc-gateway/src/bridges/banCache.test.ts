/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  BanCache,
  BAN_CACHE_TTL_MS,
  BAN_CACHE_MAX,
  isSubActorBan,
} from './banCache.js';

describe('BanCache (#168)', () => {
  it('holds a ban for the TTL, then forgets it so a lifted ban takes effect', () => {
    let now = 1_000;
    const c = new BanCache({ now: () => now });
    c.add('telegram:1');
    expect(c.has('telegram:1')).toBe(true);
    now += BAN_CACHE_TTL_MS - 1;
    expect(c.has('telegram:1')).toBe(true);
    now += 1;
    expect(c.has('telegram:1')).toBe(false);
    expect(c.size).toBe(0); // the expired entry is gone, not just hidden
  });

  it('a repeat 403 refreshes the TTL', () => {
    let now = 0;
    const c = new BanCache({ now: () => now });
    c.add('a');
    now += BAN_CACHE_TTL_MS - 10;
    c.add('a');
    now += 20;
    expect(c.has('a')).toBe(true);
  });

  it('is bounded: past the cap the oldest entry goes first', () => {
    const c = new BanCache({ max: 3, now: () => 0 });
    for (const id of ['a', 'b', 'c', 'd']) c.add(id);
    expect(c.size).toBe(3);
    expect(c.has('a')).toBe(false);
    expect(c.has('d')).toBe(true);
    expect(BAN_CACHE_MAX).toBeGreaterThan(0);
  });
});

describe('isSubActorBan (#168)', () => {
  it('is a ban only when the 403 carries code sub_actor_banned', () => {
    expect(
      isSubActorBan({
        ok: false,
        status: 403,
        body: { code: 'sub_actor_banned' },
      }),
    ).toBe(true);
    expect(
      isSubActorBan({
        ok: false,
        status: 403,
        body: { code: 'scope_required' },
      }),
    ).toBe(false);
    expect(isSubActorBan({ ok: false, status: 403 })).toBe(false);
    expect(
      isSubActorBan({
        ok: false,
        status: 400,
        body: { code: 'sub_actor_banned' },
      }),
    ).toBe(false);
  });
});
