/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  shouldRenew,
  msUntilRenewal,
  renewBeforeDaysFor,
  DEFAULT_RENEW_BEFORE_DAYS,
} from './renewalSchedule.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-01-01T00:00:00Z');

describe('renewalSchedule', () => {
  it('does not renew a fresh 90-day cert; ~60 days until the renewal point', () => {
    const notAfter = new Date(now.getTime() + 90 * DAY);
    expect(shouldRenew(notAfter, now)).toBe(false);
    expect(msUntilRenewal(notAfter, now)).toBe(60 * DAY);
  });

  it('renews once inside the renewBeforeDays window (delay 0)', () => {
    const notAfter = new Date(now.getTime() + 20 * DAY); // 20 < 30
    expect(shouldRenew(notAfter, now)).toBe(true);
    expect(msUntilRenewal(notAfter, now)).toBe(0);
  });

  it('renews an already-expired cert (delay 0)', () => {
    const notAfter = new Date(now.getTime() - DAY);
    expect(shouldRenew(notAfter, now)).toBe(true);
    expect(msUntilRenewal(notAfter, now)).toBe(0);
  });

  it('treats the exact renewal point as due', () => {
    const notAfter = new Date(now.getTime() + DEFAULT_RENEW_BEFORE_DAYS * DAY);
    expect(shouldRenew(notAfter, now)).toBe(true);
    expect(msUntilRenewal(notAfter, now)).toBe(0);
  });

  it('honors a custom renewBeforeDays', () => {
    const notAfter = new Date(now.getTime() + 10 * DAY);
    expect(shouldRenew(notAfter, now, 7)).toBe(false);
    expect(msUntilRenewal(notAfter, now, 7)).toBe(3 * DAY);
  });

  it('#165 an unreadable notAfter is due now, never NaN', () => {
    const bad = new Date('not a date');
    expect(shouldRenew(bad, now)).toBe(true);
    expect(msUntilRenewal(bad, now)).toBe(0);
    expect(msUntilRenewal(new Date(now.getTime() + 90 * DAY), now, NaN)).toBe(
      60 * DAY,
    );
  });
});

describe('#165 renewBeforeDaysFor (lead time from the cert lifetime)', () => {
  const at = (days: number) => new Date(now.getTime() + days * DAY);

  it('is a third of the lifetime, capped at 30 days', () => {
    expect(renewBeforeDaysFor(now, at(90))).toBe(30);
    expect(renewBeforeDaysFor(now, at(365))).toBe(30);
    expect(renewBeforeDaysFor(now, at(6))).toBe(2);
  });

  it('is at least a day, but never so long the cert is due when issued', () => {
    expect(renewBeforeDaysFor(now, at(2))).toBe(1);
    // A 24h private-CA leaf: a third is 8h, the 1-day floor would make it due
    // at issue, so the floor gives way to half the lifetime.
    expect(renewBeforeDaysFor(now, at(1))).toBe(0.5);
    const hour = 1 / 24;
    expect(renewBeforeDaysFor(now, at(hour))).toBeCloseTo(hour / 2);
  });

  it('answers undefined for a lifetime it cannot read', () => {
    expect(renewBeforeDaysFor(new Date('x'), at(90))).toBeUndefined();
    expect(renewBeforeDaysFor(at(90), now)).toBeUndefined();
  });

  it('a fresh 24h leaf is not due and waits half its life', () => {
    const notAfter = at(1);
    const lead = renewBeforeDaysFor(now, notAfter)!;
    expect(shouldRenew(notAfter, now, lead)).toBe(false);
    expect(msUntilRenewal(notAfter, now, lead)).toBe(DAY / 2);
  });
});
