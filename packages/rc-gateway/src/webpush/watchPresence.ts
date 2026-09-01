/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-session live-watch presence (#40): counts attached SSE event streams per
 * session so turn-end pushes can be suppressed while someone is watching the
 * session live. In-memory only — a gateway restart resets the counts to zero,
 * which fails OPEN toward sending (at worst one redundant push, never a
 * missed one). Deliberately per-session, not per-subscriber: the v1 semantic
 * is "someone is watching live ⇒ no push".
 */
export class WatchPresence {
  private readonly counts = new Map<string, number>();

  /**
   * Record one attached watch; returns the teardown to call when the stream
   * ends (mirrors ConnectionRegistry.register's shape).
   */
  join(sessionId: string): () => void {
    const n = this.counts.get(sessionId) ?? 0;
    this.counts.set(sessionId, n + 1);
    return () => this.leave(sessionId);
  }

  /** Drop one watch; unknown or already-empty sessions are a no-op (clamped). */
  leave(sessionId: string): void {
    const n = this.counts.get(sessionId) ?? 0;
    if (n <= 1) this.counts.delete(sessionId);
    else this.counts.set(sessionId, n - 1);
  }

  /** True when at least one live SSE stream is attached to the session. */
  isWatched(sessionId: string): boolean {
    return (this.counts.get(sessionId) ?? 0) > 0;
  }
}
