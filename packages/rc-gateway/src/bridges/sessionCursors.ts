/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CursorStore } from './cursorStore.js';

/**
 * The SSE resume state of a bridge runner's session subscriptions: the
 * in-memory `lastEventId` per session, its durable copy in the {@link CursorStore},
 * and one abort handle per session stream. Shared by the Telegram, Discord and
 * Matrix runners.
 *
 * When a binding goes (`detach`, or a re-attach to another session) the runner
 * calls {@link release} with the sessions still bound: an unbound session's
 * stream is closed and its cursor is removed from the store, so `cursors.json`
 * no longer collects an entry per session ever bound (#204). A frame that was
 * already in flight on a closed stream is ignored, so it cannot bring the entry
 * back.
 */
export class SubscriptionCursors {
  /** sessionId → highest SSE frame id seen (resume position on reconnect). */
  readonly lastEventId = new Map<string, number>();
  private readonly aborts = new Map<string, AbortController>();
  /** A stream signal handed out by signalFor → the handle that can release it. */
  private readonly owner = new WeakMap<AbortSignal, AbortController>();

  constructor(
    private readonly cursors?: CursorStore,
    private readonly tokenId?: string,
  ) {}

  /** Load the durable cursor of each given session (call at start). */
  load(sessionIds: Iterable<string>): void {
    if (!this.cursors || !this.tokenId) return;
    for (const sessionId of sessionIds) {
      const entry = this.cursors.get(this.tokenId, sessionId);
      if (entry) this.lastEventId.set(sessionId, entry.lastEventId);
    }
  }

  /**
   * The signal for a session's stream: aborted when `parent` aborts or when the
   * session is released. A new signal follows a release, so a re-bound session
   * gets a live one.
   */
  signalFor(sessionId: string, parent: AbortSignal): AbortSignal {
    let ctrl = this.aborts.get(sessionId);
    if (!ctrl || ctrl.signal.aborted) {
      ctrl = new AbortController();
      this.aborts.set(sessionId, ctrl);
    }
    const stream = AbortSignal.any([parent, ctrl.signal]);
    this.owner.set(stream, ctrl);
    return stream;
  }

  /**
   * Note a frame id for a session and persist it. Ignored when `stream` (the
   * signal the frame arrived on) was released meanwhile; a stream that ended
   * because the whole bridge is stopping still records.
   */
  record(sessionId: string, id: number, stream?: AbortSignal): void {
    if (stream && this.owner.get(stream)?.signal.aborted) return;
    this.lastEventId.set(sessionId, id);
    if (this.cursors && this.tokenId) {
      void this.cursors.setLastEventId(this.tokenId, sessionId, id);
    }
  }

  /**
   * Drop every tracked session that is not in `bound`: abort its stream and
   * remove its cursor from memory and the store. Returns the released ids.
   */
  release(bound: Iterable<string>): string[] {
    const keep = new Set(bound);
    const tracked = new Set([
      ...this.lastEventId.keys(),
      ...this.aborts.keys(),
    ]);
    const released: string[] = [];
    for (const sessionId of tracked) {
      if (keep.has(sessionId)) continue;
      // Abort first, so a frame landing after this call is not recorded.
      this.aborts.get(sessionId)?.abort();
      this.aborts.delete(sessionId);
      this.lastEventId.delete(sessionId);
      if (this.cursors && this.tokenId) {
        void this.cursors.delete(this.tokenId, sessionId);
      }
      released.push(sessionId);
    }
    return released;
  }
}
