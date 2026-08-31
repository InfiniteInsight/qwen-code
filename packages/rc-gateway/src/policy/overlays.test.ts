/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  OVERLAY_CAP,
  OverlayLimitError,
  PermissionOverlayStore,
} from './overlays.js';

/** Arbitrary fixed "now" so the expiry tests are clock-independent. */
const T0 = 1_000_000_000_000;
const HOUR = 3_600_000;

describe('PermissionOverlayStore', () => {
  it('add assigns an id and createdAt, echoes the supplied fields', () => {
    const store = new PermissionOverlayStore();
    const ov = store.add(
      { action: 'deny', tool: 'fetch', expiresAt: T0 + HOUR, reason: 'test' },
      T0,
    );
    expect(ov.id).toMatch(/^overlay-/);
    expect(ov.createdAt).toBe(T0);
    expect(ov).toMatchObject({
      action: 'deny',
      tool: 'fetch',
      expiresAt: T0 + HOUR,
      reason: 'test',
    });
  });

  it('list is newest-first by createdAt', () => {
    const store = new PermissionOverlayStore();
    const a = store.add({ action: 'deny', expiresAt: T0 + HOUR }, T0);
    const b = store.add({ action: 'allow', expiresAt: T0 + HOUR }, T0 + 10);
    const c = store.add({ action: 'prompt', expiresAt: T0 + HOUR }, T0 + 20);
    expect(store.list(T0 + 30).map((o) => o.id)).toEqual([c.id, b.id, a.id]);
  });

  it('list prunes expired entries as a side effect', () => {
    const store = new PermissionOverlayStore();
    const expired = store.add({ action: 'deny', expiresAt: T0 + 100 }, T0);
    const live = store.add({ action: 'deny', expiresAt: T0 + HOUR }, T0);
    // just before the boundary only the early entry is expired
    expect(store.list(T0 + HOUR - 1).map((o) => o.id)).toEqual([live.id]);
    // the pruned entry is gone from the backing map — revoke no longer finds it
    expect(store.revoke(expired.id, T0 + HOUR - 1)).toBe(false);
    // at the boundary instant the live entry is itself expired (now >= expiresAt)
    expect(store.list(T0 + HOUR)).toEqual([]);
  });

  it('revoke removes a live overlay; returns false for unknown ids', () => {
    const store = new PermissionOverlayStore();
    const ov = store.add({ action: 'deny', expiresAt: T0 + HOUR }, T0);
    expect(store.revoke(ov.id, T0 + 1)).toBe(true);
    expect(store.revoke(ov.id, T0 + 1)).toBe(false);
    expect(store.revoke('overlay-nobody', T0 + 1)).toBe(false);
    expect(store.list(T0 + 1)).toHaveLength(0);
  });

  it('add rejects a non-future expiresAt (finite future instant only)', () => {
    const store = new PermissionOverlayStore();
    expect(() => store.add({ action: 'deny', expiresAt: T0 }, T0)).toThrow(
      /finite future instant/,
    );
    expect(() => store.add({ action: 'deny', expiresAt: T0 - 1 }, T0)).toThrow(
      /finite future instant/,
    );
    expect(() =>
      store.add({ action: 'deny', expiresAt: Number.NaN }, T0),
    ).toThrow(/finite future instant/);
    // nothing was stored
    expect(store.list(T0)).toHaveLength(0);
  });

  it('add throws OverlayLimitError at the cap, but pruned room re-opens it', () => {
    const store = new PermissionOverlayStore();
    for (let i = 0; i < OVERLAY_CAP; i++) {
      store.add({ action: 'deny', expiresAt: T0 + HOUR }, T0);
    }
    expect(() =>
      store.add({ action: 'deny', expiresAt: T0 + HOUR }, T0 + 1),
    ).toThrow(OverlayLimitError);
    // Let every overlay lapse: the cap is on ACTIVE overlays, so a fresh one fits.
    const after = T0 + HOUR + 1;
    expect(
      store.add({ action: 'deny', expiresAt: after + HOUR }, after),
    ).toBeDefined();
  });

  it('policyFor includes unbound overlays for every session, bound ones only for theirs', () => {
    const store = new PermissionOverlayStore();
    const unbound = store.add({ action: 'deny', expiresAt: T0 + HOUR }, T0);
    const boundA = store.add(
      { action: 'allow', sessionId: 'a', expiresAt: T0 + HOUR },
      T0,
    );
    const boundB = store.add(
      { action: 'allow', sessionId: 'b', expiresAt: T0 + HOUR },
      T0,
    );

    const forA = store.policyFor('a', T0 + 1);
    expect(forA.rules.map((r) => r.id).sort()).toEqual(
      [unbound.id, boundA.id].sort(),
    );

    const forB = store.policyFor('b', T0 + 1);
    expect(forB.rules.map((r) => r.id).sort()).toEqual(
      [unbound.id, boundB.id].sort(),
    );

    // A third session sees only the unbound overlay.
    const forC = store.policyFor('c', T0 + 1);
    expect(forC.rules.map((r) => r.id)).toEqual([unbound.id]);
  });

  it('policyFor renders a standalone prompt/approve policy with ISO-string expiresAt and the right match', () => {
    const store = new PermissionOverlayStore();
    const ov = store.add(
      { action: 'deny', tool: 'fetch', expiresAt: T0 + HOUR, reason: 'why' },
      T0,
    );
    const any = store.add({ action: 'allow', expiresAt: T0 + HOUR }, T0);

    const pol = store.policyFor('s1', T0 + 1);
    expect(pol.defaults).toEqual({ action: 'prompt', requireScope: 'approve' });
    const byId = new Map(pol.rules.map((r) => [r.id, r]));
    expect(byId.get(ov.id)).toEqual({
      id: ov.id,
      match: { tool: 'fetch' },
      action: 'deny',
      expiresAt: new Date(T0 + HOUR).toISOString(),
      reason: 'why',
    });
    expect(byId.get(any.id)).toEqual({
      id: any.id,
      match: {},
      action: 'allow',
      expiresAt: new Date(T0 + HOUR).toISOString(),
    });
  });

  it('policyFor drops expired overlays (inert once their instant passes)', () => {
    const store = new PermissionOverlayStore();
    const ov = store.add({ action: 'deny', expiresAt: T0 + 100 }, T0);
    expect(store.policyFor('s1', T0 + 50).rules).toHaveLength(1);
    expect(store.policyFor('s1', T0 + 100).rules).toHaveLength(0);
    expect(ov).toBeDefined();
  });
});
