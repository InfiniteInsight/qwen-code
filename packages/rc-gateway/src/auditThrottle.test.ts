/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { AuditEntry, AuditRecorder } from './auditLog.js';
import { PeerAuditThrottle, peerKey } from './auditThrottle.js';

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

const FAIL: AuditEntry = { action: 'auth_failed', detail: { path: '/rc/x' } };

describe('PeerAuditThrottle', () => {
  it('writes the first event at once and counts the rest of the window', () => {
    const audit = fakeAudit();
    let now = 0;
    const t = new PeerAuditThrottle(audit, {
      now: () => now,
      autoFlush: false,
    });
    for (let i = 0; i < 100; i++) t.record('203.0.113.9', FAIL);
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]!.detail).toEqual({
      path: '/rc/x',
      peer: '203.0.113.9',
      count: 1,
    });
    // The peer's next event after the window carries everything since.
    now = 60_000;
    t.record('203.0.113.9', FAIL);
    expect(audit.calls).toHaveLength(2);
    expect(audit.calls[1]!.detail).toMatchObject({ count: 100 });
  });

  it('a steady flood costs one row per window', () => {
    const audit = fakeAudit();
    let now = 0;
    const t = new PeerAuditThrottle(audit, {
      now: () => now,
      autoFlush: false,
    });
    for (let minute = 0; minute < 10; minute++) {
      for (let i = 0; i < 50; i++) {
        now = minute * 60_000 + i * 100;
        t.record('198.51.100.1', FAIL);
      }
    }
    expect(audit.calls).toHaveLength(10);
    const total = audit.calls.reduce(
      (n, c) => n + ((c.detail as { count: number }).count ?? 0),
      0,
    );
    // Every event is accounted for except the last window's tail, which
    // only a flush can write.
    expect(total).toBe(500 - 49);
    t.flush(10 * 60_000);
    const after = audit.calls.reduce(
      (n, c) => n + ((c.detail as { count: number }).count ?? 0),
      0,
    );
    expect(after).toBe(500);
  });

  it('keeps peers and actions apart', () => {
    const audit = fakeAudit();
    const t = new PeerAuditThrottle(audit, { now: () => 0, autoFlush: false });
    t.record('192.0.2.1', FAIL);
    t.record('192.0.2.2', FAIL);
    t.record('192.0.2.1', { action: 'cors_denied', detail: { origin: 'x' } });
    t.record('192.0.2.1', FAIL);
    expect(audit.calls.map((c) => [c.action, c.detail?.peer])).toEqual([
      ['auth_failed', '192.0.2.1'],
      ['auth_failed', '192.0.2.2'],
      ['cors_denied', '192.0.2.1'],
    ]);
  });

  it('a quiet peer gets its summary row when its window closes', () => {
    const audit = fakeAudit();
    let now = 0;
    const t = new PeerAuditThrottle(audit, {
      now: () => now,
      autoFlush: false,
    });
    t.record('192.0.2.7', FAIL);
    t.record('192.0.2.7', FAIL);
    t.record('192.0.2.7', FAIL);
    now = 61_000;
    t.flush();
    expect(audit.calls).toHaveLength(2);
    expect(audit.calls[1]!.detail).toMatchObject({
      peer: '192.0.2.7',
      count: 2,
    });
    expect(t.size).toBe(0);
  });

  it('folds peers past the cap into one "*" row, bounding rows per window', () => {
    const audit = fakeAudit();
    const t = new PeerAuditThrottle(audit, {
      now: () => 0,
      maxPeers: 4,
      autoFlush: false,
    });
    for (let i = 0; i < 1000; i++) t.record(`10.0.${i >> 8}.${i & 255}`, FAIL);
    expect(audit.calls).toHaveLength(5);
    expect(audit.calls[4]!.detail).toMatchObject({ peer: '*', count: 1 });
    expect(t.size).toBe(5);
  });

  it('never throws and is a no-op without a recorder', () => {
    const t = new PeerAuditThrottle(undefined);
    expect(() => t.record('192.0.2.1', FAIL)).not.toThrow();
  });
});

describe('peerKey', () => {
  it('keeps IPv4, unwraps mapped IPv4, folds IPv6 to its /64', () => {
    expect(peerKey('203.0.113.9')).toBe('203.0.113.9');
    expect(peerKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(peerKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(peerKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe(
      '2001:db8:1:2::/64',
    );
    expect(peerKey('::1')).toBe('0:0:0:0::/64');
    expect(peerKey(undefined)).toBe('unknown');
  });
});
