/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Routes streamed `session_update` text into bound Matrix rooms
 * (`add-matrix-bridge`: "session_update rendering with full Markdown" + "Threads
 * on long streams via m.thread"). Mirrors the Discord stream router's three
 * concerns — buffering, ordered serialized posting, and session-scoped turns with
 * room-scoped counts — but adapted to Matrix:
 *
 * - FLUSH triggers: a paragraph break / fenced-code close, OR the buffer reaches
 *   16384 bytes, OR 1500 ms idle. Matrix's per-event limit is 65536 bytes, ~4× the
 *   flush threshold, so a flush is sent as a SINGLE event — no 2000-char-style
 *   splitter (a pathological single chunk > 65536 is not split; the threshold
 *   makes that effectively impossible for streamed agent prose).
 * - THREADS: after 6 messages posted to a room within one turn, the 7th and later
 *   carry an `m.relates_to { rel_type: "m.thread", event_id: <first msg> }`
 *   relation — no separate create-thread call (unlike Discord); the relation IS
 *   the thread.
 * - A turn is SESSION-scoped (one stream fans out to N rooms); the count + anchor
 *   are ROOM-scoped (lazy reset when the session's turn advances). A turn ends at
 *   the event after a `permission_resolved` OR the next inbound prompt.
 *
 * Posting is serialized per room (a single promise chain) so two rapid chunks
 * can't interleave into out-of-order events or a racy count. Markdown→HTML and the
 * event content shape live in the injected poster, keeping this router
 * transport-agnostic.
 *
 * FENCES (#168): each event renders on its own, so a flush that ends inside a
 * ``` block closes it and the next flush reopens it with the same language (the
 * room carries the fence state between flushes). A blank line inside a block is
 * not a flush trigger. Before, a cut block rendered as literal backticks. A new
 * turn starts outside any fence.
 */

import {
  NO_FENCE,
  atFlushPoint,
  balanceFences,
  fenceStateAfter,
  type FenceState,
} from '../fence.js';

export const MX_FLUSH_MAX_BYTES = 16384;
export const MX_FLUSH_IDLE_MS = 1500;
export const MX_MAX_ROOM_MESSAGES = 6;

/** A growable buffer that knows when a hard flush trigger is present. */
export class MatrixStreamBuffer {
  private buf = '';
  append(text: string): void {
    this.buf += text;
  }
  isEmpty(): boolean {
    return this.buf.length === 0;
  }
  /**
   * ≥ the byte cap, or (ending outside a fence) a paragraph break or a block
   * that just closed. `start` is the fence state carried from the last flush.
   */
  hardDue(start: FenceState = NO_FENCE): boolean {
    if (Buffer.byteLength(this.buf, 'utf8') >= MX_FLUSH_MAX_BYTES) return true;
    return atFlushPoint(this.buf, start);
  }
  take(): string {
    const s = this.buf;
    this.buf = '';
    return s;
  }
}

/** The outbound surface the router needs (the runner supplies markdown→HTML). */
export interface MatrixStreamPoster {
  /**
   * Send one streamed message to a room; resolves the event id (or null). When
   * `threadRootEventId` is set the message is related into that thread.
   */
  sendStream(
    roomId: string,
    opts: { text: string; threadRootEventId?: string },
  ): Promise<string | null>;
}

export interface MatrixStreamRouterConfig {
  poster: MatrixStreamPoster;
  /** Rooms currently bound to a session (resolved fresh per chunk). */
  roomsFor: (sessionId: string) => string[];
  /** Arm a one-shot timer; returns a cancel fn. Injectable for tests. */
  setTimer?: (ms: number, fn: () => void) => () => void;
}

interface RoomState {
  roomId: string;
  sessionId: string;
  buffer: MatrixStreamBuffer;
  chain: Promise<void>;
  cancelTimer?: () => void;
  turnId: number;
  posted: number;
  anchorEventId: string | null;
  /** Fence state at the end of the text already flushed (#168). */
  fence: FenceState;
  /** The turn `fence` belongs to; a new turn starts outside any fence. */
  fenceTurn: number;
}

export class MatrixStreamRouter {
  private readonly cfg: MatrixStreamRouterConfig;
  private readonly setTimer: (ms: number, fn: () => void) => () => void;
  private readonly turnSeq = new Map<string, number>();
  private readonly pendingBump = new Set<string>();
  private readonly rooms = new Map<string, RoomState>();

  constructor(cfg: MatrixStreamRouterConfig) {
    this.cfg = cfg;
    this.setTimer = cfg.setTimer ?? defaultSetTimer;
  }

  private seq(sessionId: string): number {
    return this.turnSeq.get(sessionId) ?? 0;
  }

  /** A new agent turn begins (rooms reset lazily on their next flush). */
  bumpTurn(sessionId: string): void {
    this.turnSeq.set(sessionId, this.seq(sessionId) + 1);
    this.pendingBump.delete(sessionId);
  }

  /** A permission_resolved arrived: the NEXT chunk is a new turn. */
  notePermissionResolved(sessionId: string): void {
    this.pendingBump.add(sessionId);
  }

  onChunk(sessionId: string, text: string): void {
    if (!text) return;
    if (this.pendingBump.has(sessionId)) this.bumpTurn(sessionId);
    for (const roomId of this.cfg.roomsFor(sessionId)) {
      const st = this.roomState(roomId, sessionId);
      // A turn that ended inside an unclosed block must not wrap the next
      // turn's prose. A tail still buffered from the old turn keeps its state.
      if (st.fenceTurn !== this.seq(sessionId) && st.buffer.isEmpty()) {
        st.fence = NO_FENCE;
        st.fenceTurn = this.seq(sessionId);
      }
      st.buffer.append(text);
      if (st.cancelTimer) {
        st.cancelTimer();
        st.cancelTimer = undefined;
      }
      if (st.buffer.hardDue(st.fence)) {
        this.flush(roomId);
      } else {
        st.cancelTimer = this.setTimer(MX_FLUSH_IDLE_MS, () => {
          st.cancelTimer = undefined;
          this.flush(roomId);
        });
      }
    }
  }

  private roomState(roomId: string, sessionId: string): RoomState {
    let st = this.rooms.get(roomId);
    if (!st) {
      st = {
        roomId,
        sessionId,
        buffer: new MatrixStreamBuffer(),
        chain: Promise.resolve(),
        turnId: this.seq(sessionId),
        posted: 0,
        anchorEventId: null,
        fence: NO_FENCE,
        fenceTurn: this.seq(sessionId),
      };
      this.rooms.set(roomId, st);
    } else {
      st.sessionId = sessionId;
    }
    return st;
  }

  private flush(roomId: string): void {
    const st = this.rooms.get(roomId);
    if (!st || st.buffer.isEmpty()) return;
    const raw = st.buffer.take();
    // Advance the fence state at enqueue time so it follows the text order.
    const text = balanceFences(raw, st.fence);
    st.fence = fenceStateAfter(raw, st.fence);
    if (!text) return; // only the closing line of a block already closed
    st.chain = st.chain.then(() => this.doFlush(st, text)).catch(() => {});
  }

  private async doFlush(st: RoomState, text: string): Promise<void> {
    this.resetTurnIfStale(st);
    st.posted += 1;
    // 7th+ message of the turn → relate into the thread off the first message.
    const useThread = st.posted > MX_MAX_ROOM_MESSAGES;
    const eventId = await this.cfg.poster.sendStream(st.roomId, {
      text,
      ...(useThread && st.anchorEventId
        ? { threadRootEventId: st.anchorEventId }
        : {}),
    });
    if (st.posted === 1) st.anchorEventId = eventId;
  }

  private resetTurnIfStale(st: RoomState): void {
    const current = this.seq(st.sessionId);
    if (st.turnId === current) return;
    st.turnId = current;
    st.posted = 0;
    st.anchorEventId = null;
  }

  /** Test helper: await every room's in-flight flush chain. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.rooms.values()].map((s) => s.chain));
  }
}

/** Default one-shot timer using setTimeout; returns a cancel fn. */
function defaultSetTimer(ms: number, fn: () => void): () => void {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}
