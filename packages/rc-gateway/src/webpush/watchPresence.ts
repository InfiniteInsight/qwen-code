/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-session live-watch presence (#40): counts attached SSE event streams per
 * session so turn-end pushes can be suppressed while someone is watching the
 * session live. In-memory only - a gateway restart resets the counts to zero,
 * which fails OPEN toward sending (at worst one redundant push, never a
 * missed one). Deliberately per-session, not per-subscriber: the v1 semantic
 * is "someone is watching live ⇒ no push".
 */
export interface WatchedSessionSnapshot {
  sessionId: string;
  joinedAt: number;
  watcherCount: number;
}

export class WatchPresence {
  private readonly counts = new Map<string, number>();
  private readonly lastJoinedAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Record one attached watch; returns the teardown to call when the stream
   * ends (mirrors ConnectionRegistry.register's shape).
   */
  join(sessionId: string): () => void {
    const n = this.counts.get(sessionId) ?? 0;
    this.counts.set(sessionId, n + 1);
    this.lastJoinedAt.set(sessionId, this.now());
    return () => this.leave(sessionId);
  }

  /** Drop one watch; unknown or already-empty sessions are a no-op (clamped). */
  leave(sessionId: string): void {
    const n = this.counts.get(sessionId) ?? 0;
    if (n <= 1) {
      this.counts.delete(sessionId);
      this.lastJoinedAt.delete(sessionId);
    } else {
      this.counts.set(sessionId, n - 1);
    }
  }

  /** True when at least one live SSE stream is attached to the session. */
  isWatched(sessionId: string): boolean {
    return (this.counts.get(sessionId) ?? 0) > 0;
  }

  /** Number of live SSE streams currently attached to the session. */
  watcherCount(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }

  /**
   * Most recently joined session that still has at least one live SSE watcher,
   * or null when no session is currently watched (#113).
   */
  mostRecentWatched(): WatchedSessionSnapshot | null {
    let best: WatchedSessionSnapshot | null = null;
    for (const [sessionId, watcherCount] of this.counts.entries()) {
      if (watcherCount <= 0) continue;
      const joinedAt = this.lastJoinedAt.get(sessionId) ?? 0;
      if (!best || joinedAt >= best.joinedAt) {
        best = { sessionId, joinedAt, watcherCount };
      }
    }
    return best;
  }
}
