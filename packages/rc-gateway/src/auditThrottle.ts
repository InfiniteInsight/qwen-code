/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isIP } from 'node:net';
import type { AuditEntry, AuditRecorder } from './auditLog.js';

/** One row per peer per action per window. */
export const DEFAULT_PEER_AUDIT_WINDOW_MS = 60_000;
/**
 * Distinct peers tracked per window before new ones are folded into the `*`
 * row. Bounds rows per window at about this many per action no matter how
 * many addresses a flood comes from.
 */
export const DEFAULT_PEER_AUDIT_MAX_PEERS = 256;

export interface PeerAuditThrottleOptions {
  windowMs?: number;
  maxPeers?: number;
  now?: () => number;
  /**
   * Schedule a flush of suppressed counts when a window closes with nobody
   * else arriving to trigger it. Default true; tests that drive `now` by hand
   * turn it off and call {@link PeerAuditThrottle.flush}.
   */
  autoFlush?: boolean;
}

interface Slot {
  windowStart: number;
  /** Events seen since this slot's last row was written. */
  suppressed: number;
  /** The most recent suppressed entry, for the summary row's detail. */
  last: AuditEntry;
  peer: string;
}

/**
 * Collapse a remote address to the unit an attacker cannot cheaply multiply:
 * an IPv4 address as is, an IPv6 address to its /64 (one host usually owns a
 * whole /64, so per-address keys would let it mint unlimited rows).
 */
export function peerKey(remote: string | undefined): string {
  if (!remote) return 'unknown';
  let a = remote.trim();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) !== 6) return a;
  const [head] = a.split('::');
  const groups = head!.split(':').filter((g) => g.length > 0);
  if (a.includes('::')) {
    const tail = a
      .split('::')[1]!
      .split(':')
      .filter((g) => g.length > 0);
    const zeros = 8 - groups.length - tail.length;
    for (let i = 0; i < zeros; i++) groups.push('0');
    groups.push(...tail);
  }
  return (
    groups
      .slice(0, 4)
      .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
      .join(':') + '::/64'
  );
}

/**
 * Rate-limits the audit rows that unauthenticated traffic can cause (#165):
 * every 401 and every refused CORS preflight used to append a synchronous
 * row, so anything that could reach the port could grow the disk without
 * bound.
 *
 * The first event from a peer is written at once, so an owner still sees a
 * single failure the moment it happens. Further events from that peer for
 * that action within the window are counted, not written. The next row for
 * the peer carries `detail.count`: how many events it stands for, itself
 * included. That row is written by the peer's next event after the window
 * (so a steady flood costs one row per minute), or, if the peer goes quiet,
 * by a flush when its window closes.
 */
export class PeerAuditThrottle {
  private readonly windowMs: number;
  private readonly maxPeers: number;
  private readonly now: () => number;
  private readonly autoFlush: boolean;
  private readonly slots = new Map<string, Slot>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly audit: AuditRecorder | undefined,
    opts: PeerAuditThrottleOptions = {},
  ) {
    this.windowMs = opts.windowMs ?? DEFAULT_PEER_AUDIT_WINDOW_MS;
    this.maxPeers = opts.maxPeers ?? DEFAULT_PEER_AUDIT_MAX_PEERS;
    this.now = opts.now ?? Date.now;
    this.autoFlush = opts.autoFlush ?? true;
  }

  /** Record `entry` on behalf of the peer at `remote`. Never throws. */
  record(remote: string | undefined, entry: AuditEntry): void {
    if (!this.audit) return;
    try {
      const now = this.now();
      let peer = peerKey(remote);
      let key = entry.action + '\u0000' + peer;
      let slot = this.slots.get(key);
      if (!slot) {
        this.flush(now);
        if (this.slots.size >= this.maxPeers) {
          peer = '*';
          key = entry.action + '\u0000*';
          slot = this.slots.get(key);
        }
      }
      if (slot && now - slot.windowStart < this.windowMs) {
        slot.suppressed += 1;
        slot.last = entry;
        this.scheduleFlush();
        return;
      }
      const count = (slot?.suppressed ?? 0) + 1;
      this.slots.set(key, {
        windowStart: now,
        suppressed: 0,
        last: entry,
        peer,
      });
      this.write(entry, peer, count);
    } catch {
      // Audit is best-effort and must never break the request path.
    }
  }

  /**
   * Write the summary row of every slot whose window has closed with events
   * still counted, and forget slots that have gone quiet.
   */
  flush(now: number = this.now()): void {
    for (const [key, slot] of this.slots) {
      if (now - slot.windowStart < this.windowMs) continue;
      if (slot.suppressed > 0)
        this.write(slot.last, slot.peer, slot.suppressed);
      this.slots.delete(key);
    }
  }

  /** Slots currently tracked (test seam). */
  get size(): number {
    return this.slots.size;
  }

  private write(entry: AuditEntry, peer: string, count: number): void {
    void this.audit?.record({
      ...entry,
      detail: { ...(entry.detail ?? {}), peer, count },
    });
  }

  private scheduleFlush(): void {
    if (!this.autoFlush || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
      if ([...this.slots.values()].some((s) => s.suppressed > 0)) {
        this.scheduleFlush();
      }
    }, this.windowMs);
    // Never the reason the process stays up.
    this.timer.unref?.();
  }
}
