/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure renewal-timing policy for ACME-managed certs. Let's Encrypt certs are
 * valid 90 days; we renew `renewBeforeDays` before `notAfter`, so a healthy
 * cert is replaced with ~30 days of slack: enough headroom to retry transient
 * DNS/ACME failures without ever serving an expired cert. The manager derives
 * `renewBeforeDays` from each cert's lifetime ({@link renewBeforeDaysFor}),
 * so a CA issuing shorter leafs gets a proportionally shorter lead.
 *
 * No I/O, no ambient clock, no randomness: the caller passes `now` (the scheduler
 * injects the real `Date`), keeping this trivially unit-testable. Jitter, if any,
 * belongs in the scheduler that consumes `msUntilRenewal`, not here.
 */

export const DEFAULT_RENEW_BEFORE_DAYS = 30;
/** Bounds on a lead time derived from the lifetime (#165). */
export const MIN_RENEW_BEFORE_DAYS = 1;
export const MAX_RENEW_BEFORE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The lead time, in days, for a cert valid from `notBefore` to `notAfter`
 * (#165): a third of its lifetime, at least {@link MIN_RENEW_BEFORE_DAYS} and
 * at most {@link MAX_RENEW_BEFORE_DAYS}. A Let's Encrypt 90-day cert gets the
 * old 30. The one-day floor never exceeds half the lifetime: a private CA's
 * 24h leaf would otherwise be due the moment it was issued and be re-ordered
 * on every wake, so it renews at half life instead. Undefined when the
 * lifetime cannot be read (either date invalid, or not after the other).
 */
export function renewBeforeDaysFor(
  notBefore: Date,
  notAfter: Date,
): number | undefined {
  const lifetime = notAfter.getTime() - notBefore.getTime();
  if (!Number.isFinite(lifetime) || lifetime <= 0) return undefined;
  const lifetimeDays = lifetime / DAY_MS;
  const floor = Math.min(MIN_RENEW_BEFORE_DAYS, lifetimeDays / 2);
  return Math.min(MAX_RENEW_BEFORE_DAYS, Math.max(floor, lifetimeDays / 3));
}

/**
 * The instant (ms epoch) at which renewal becomes due. NaN when `notAfter`
 * cannot be read; callers treat that as due now (#165).
 */
function renewalPoint(notAfter: Date, renewBeforeDays: number): number {
  const lead = Number.isFinite(renewBeforeDays)
    ? renewBeforeDays
    : DEFAULT_RENEW_BEFORE_DAYS;
  return notAfter.getTime() - lead * DAY_MS;
}

/**
 * True once `now` has reached the renewal point (`notAfter - renewBeforeDays`).
 * An unreadable `notAfter` is due: renewing a cert whose expiry we cannot
 * tell is the safe answer, where "never" (the old NaN comparison) let it
 * expire unrenewed.
 */
export function shouldRenew(
  notAfter: Date,
  now: Date,
  renewBeforeDays: number = DEFAULT_RENEW_BEFORE_DAYS,
): boolean {
  const point = renewalPoint(notAfter, renewBeforeDays);
  return !Number.isFinite(point) || now.getTime() >= point;
}

/**
 * Milliseconds from `now` until the renewal point, floored at 0. 0 means "renew
 * now" (including an already-expired cert, or one whose expiry is unreadable).
 * Never NaN, which a timer would read as ~1ms. The scheduler arms a timer for
 * this.
 */
export function msUntilRenewal(
  notAfter: Date,
  now: Date,
  renewBeforeDays: number = DEFAULT_RENEW_BEFORE_DAYS,
): number {
  const point = renewalPoint(notAfter, renewBeforeDays);
  if (!Number.isFinite(point)) return 0;
  return Math.max(0, point - now.getTime());
}
