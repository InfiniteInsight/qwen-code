/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Durable per-session event write-ahead log (WAL).
 *
 * Ported from the donor reference implementation at
 * packages/cli/src/serve/remoteControl/wal.ts (qwen-code-remote repo),
 * adapted for the rc-gateway's numeric event-id frame shape.
 *
 * Framing: each frame is a 4-byte big-endian unsigned length prefix followed
 * by exactly that many bytes of UTF-8 JSON (the WalFrame). The fixed-width
 * prefix lets us forward-scan a segment cheaply and detect a torn trailing
 * frame without speculative JSON parsing.
 *
 * On-disk layout: <dir>/wal/<sessionId>.log is the active segment; rotated
 * segments are <sessionId>.log.1, <sessionId>.log.2, ... where a higher
 * numeric suffix is OLDER. Replay scans oldest -> newest.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** Width of the big-endian length prefix that precedes each JSON frame. */
const LENGTH_PREFIX_BYTES = 4;

/**
 * Floor for the compaction trigger: never rewrite the active segment to reclaim
 * less than this. Below it the read + rewrite + fsync costs more than the
 * space it returns, and a session writing small frames would pay a rewrite on
 * nearly every retention drop.
 */
const COMPACT_MIN_DEAD_BYTES = 256 * 1024;

/**
 * The frame shape stored in the WAL. Mirrors the daemon's DaemonEvent shape
 * (id is a numeric integer, not hex), so frames can be replayed directly as
 * SSE data payloads without conversion.
 */
export interface WalFrame {
  id: number;
  v: number;
  type: string;
  data: unknown;
  [extra: string]: unknown;
}

/** Result of a replay request — discriminated on `truncated`. */
export type ReplayResult =
  | { truncated: false; events: WalFrame[] }
  | {
      truncated: true;
      events: WalFrame[];
      earliestAvailableId: number | null;
      reason: 'older_than_wal_horizon' | 'no_wal';
    };

/**
 * WAL retention defaults.
 *
 * `walSegmentMaxBytes` is sized to the retention window, not to a round number.
 * Measured over 186,034 live frames the median frame is ~310 B and the mean
 * 422 B, so the 10,000-frame window costs 3.2-4.0 MB. At 16 MB the cap was 4-5x
 * the whole window, so rotation, the thing that makes a segment deletable at
 * all, rarely happened. 4 MB fits one window in one segment.
 *
 * The cap is not by itself a bound on dead bytes. Retention drops frames from
 * the head of the window, while disk is reclaimed only by whole-segment
 * `rmSync` of rotated files and by compactActiveSegment()'s rewrite of the
 * active one, so the unreachable prefix of the active file sits there until it
 * reaches the compaction trigger: half the segment cap, floored at
 * COMPACT_MIN_DEAD_BYTES. With these defaults a session can hold under 2 MB of
 * dead bytes, against ~12 MB at the old 16 MB cap.
 */
export const WAL_DEFAULTS = {
  walMaxEvents: 10_000,
  walHorizonSec: 86_400,
  walSegmentMaxBytes: 4 * 1024 * 1024,
} as const;

export interface SessionWalOptions {
  /** Root directory; the WAL lives at <dir>/wal/<sessionId>.log. */
  dir: string;
  sessionId: string;
  /** Rotate the active segment once it exceeds this many bytes. */
  segmentMaxBytes?: number;
  /** Retain at most this many events (older bound wins vs. horizon). */
  maxEvents?: number;
  /** Retain events newer than now - horizonSec (older bound wins). */
  horizonSec?: number;
  /**
   * Rewrite the active segment once this many bytes of it have fallen out of
   * the retention window. Defaults to half of segmentMaxBytes, floored at
   * COMPACT_MIN_DEAD_BYTES. Raise it to trade disk for fewer rewrites; there is
   * no way to turn compaction off, since that is what bounds dead bytes on disk.
   */
  compactAfterBytes?: number;
  /** Injectable clock (epoch ms) for horizon tests. Defaults to Date.now. */
  now?: () => number;
}

/** Per-frame metadata for every retained event across all segments. */
interface FrameMeta {
  id: number;
  /** Append wall-clock time (epoch ms) captured at write time. */
  appendedAtMs: number;
  /** Byte length of the full frame (prefix + payload) on disk. */
  frameBytes: number;
}

/**
 * A per-session write-ahead log. One instance owns one session's segments and
 * may be re-opened against an existing directory (e.g. after a gateway restart),
 * recovering its counters by scanning the segments.
 */
export class SessionWal {
  readonly sessionId: string;
  private readonly walDir: string;
  private readonly activePath: string;
  private readonly segmentMaxBytes: number;
  private readonly maxEvents: number;
  private readonly horizonSec: number;
  private readonly now: () => number;

  /** Append-mode fd for the active segment, or null until opened. */
  private fd: number | null = null;
  /** Current byte size of the active segment. */
  private activeBytes = 0;

  /**
   * Per-frame metadata for every retained event across all segments, in
   * ascending id order. Used to compute counts/horizon and to enforce the
   * bound by dropping leading frames / pruning segments.
   */
  private frames: FrameMeta[] = [];
  /**
   * Last frame id in file order per segment, keyed by numeric suffix (0 = the
   * active segment). A rotated segment is never written again, so its id is
   * stable once read; the active one is updated on each append. Lets
   * pruneEmptySegments() decide without re-reading whole segments.
   * A `null` value is a read that found no decodable frame (empty or corrupt).
   */
  private segLastId = new Map<number, number | null>();
  /**
   * How many of the frames in `frames` are physically in the ACTIVE segment.
   * Appends add to the end of both the list and the file, so the active file
   * always holds the newest `activeFrameCount` entries of the sequence; that is
   * what lets compaction tell which dropped frames were its business without
   * reading the segment. Reset by rotate() (the reopened file holds nothing) and
   * recomputed by recover().
   */
  private activeFrameCount = 0;
  /**
   * Bytes at the head of the active segment that no retained frame occupies,
   * which is disk that `rmSync` can never reach because it is not a whole
   * rotated segment. Accumulated by enforceBounds() from frame sizes it already
   * has, so it costs no read; reset by the rewrite that reclaims it and by
   * rotate(), which moves the dead head into a segment that rmSync can take.
   */
  private deadBytes = 0;
  private readonly compactAfterBytes: number;
  /** Set when dropped from the registry; forces a resync before the next write. */
  private evicted = false;
  private _earliest: number | null = null;
  private _latest: number | null = null;

  constructor(opts: SessionWalOptions) {
    this.sessionId = opts.sessionId;
    this.walDir = join(opts.dir, 'wal');
    this.activePath = join(this.walDir, `${opts.sessionId}.log`);
    this.segmentMaxBytes =
      opts.segmentMaxBytes ?? WAL_DEFAULTS.walSegmentMaxBytes;
    this.maxEvents = opts.maxEvents ?? WAL_DEFAULTS.walMaxEvents;
    this.horizonSec = opts.horizonSec ?? WAL_DEFAULTS.walHorizonSec;
    this.now = opts.now ?? Date.now;
    // Half a segment of dead bytes is the break-even point: below it the
    // rewrite reclaims less than the segment it would have rotated into.
    this.compactAfterBytes =
      opts.compactAfterBytes ??
      Math.max(COMPACT_MIN_DEAD_BYTES, Math.floor(this.segmentMaxBytes / 2));

    // Owner-only: the log holds conversation text. The CLI creates the root
    // this subdirectory the same way at boot (cli.ts prepareSessionWalDir).
    mkdirSync(this.walDir, { recursive: true, mode: 0o700 });
    this.recover();
  }

  // -- accessors ----------------------------------------------------------

  /**
   * Earliest retained event id or null when empty.
   *
   * Deliberately not resynced like latestId(). On disk this only moves when a
   * whole segment is pruned, and nothing in the tree reads it to decide
   * anything; replayFrom() reads `_earliest` for its truncation test and that
   * path resyncs first, so it is covered where it matters.
   */
  earliestId(): number | null {
    return this._earliest;
  }

  /**
   * Latest retained event id or null when empty.
   *
   * Resyncs an evicted instance because this is not a display accessor. Four
   * callers compute a NEW id as `(latestId() ?? 0) + 1` off it: the events-route
   * relay re-anchors a fresh epoch's offset here (routes/sessionEvents.ts), the
   * rewind and fork markers place themselves here, and the recovery orchestrator
   * stamps its terminal marker here. A stale answer does not just read old, it
   * makes the next writer anchor below ids the WAL already holds and append a
   * colliding one.
   */
  latestId(): number | null {
    this.resyncIfEvicted();
    return this._latest;
  }

  /**
   * Number of retained events across all segments.
   *
   * Not resynced: nothing in the tree reads this to decide anything (the two
   * `.count()` calls in this package are on SearchIndex, not a WAL), and an
   * evicted handle's count is corrected by its next append anyway.
   */
  count(): number {
    return this.frames.length;
  }

  // -- write path ---------------------------------------------------------

  /**
   * Encode `frame` as one length-prefixed frame and append it to the active
   * segment via a single append-mode write. Updates counters, rotates when the
   * active segment exceeds segmentMaxBytes, then enforces the retention bounds.
   */
  append(frame: WalFrame): void {
    // Evicted instances may have been superseded by a fresh one that rotated or
    // pruned segments; resync from disk so this write and the bound enforcement
    // below act on the real state rather than a stale snapshot.
    this.resyncIfEvicted();
    const encoded = encodeFrame(frame);
    const fd = this.ensureOpen();
    writeSync(fd, encoded, 0, encoded.length);
    // The active segment's last frame is now this one. Recorded here so
    // enforceBounds() never has to re-read the segment to decide pruning.
    this.segLastId.set(0, frame.id);

    const appendedAtMs = this.now();
    this.activeBytes += encoded.length;
    this.activeFrameCount += 1;
    this.frames.push({
      id: frame.id,
      appendedAtMs,
      frameBytes: encoded.length,
    });
    if (this._earliest === null) {
      this._earliest = frame.id;
    }
    // A high-water mark, not the last written id. Markers can legitimately land
    // below the current end (the fork route anchors `session_forked` to the
    // client's cursor, `fromEventId + 1`), and every appender now shares one
    // instance, so letting a low marker move this backwards makes the
    // id-continuity renumbering re-anchor below ids the relay already handed
    // out and write a colliding WAL id.
    if (this._latest === null || frame.id > this._latest) {
      this._latest = frame.id;
    }

    if (this.activeBytes > this.segmentMaxBytes) {
      this.rotate();
    }
    this.enforceBounds();
  }

  /** Flush + close the active fd. Safe to call multiple times. */
  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  /**
   * Mark this instance as evicted from the shared registry.
   *
   * A caller may still hold a reference across an open stream, and meanwhile a
   * fresh instance for the same session can be created. Two instances trusting
   * their own in-memory bookkeeping could rotate or prune segments out from
   * under each other, so an evicted instance re-reads the on-disk truth before
   * its next append instead of acting on stale state.
   */
  markEvicted(): void {
    this.evicted = true;
    this.close();
  }

  // -- replay path --------------------------------------------------------

  /**
   * Replay events with id strictly greater than `lastEventId`, scanning
   * segments oldest -> newest in ascending id order.
   *
   * - If `lastEventId` is OLDER than the earliest retained id (and not the
   *   predecessor boundary), the requested resume point has fallen out of the
   *   WAL: return a truncated result carrying `earliestAvailableId` so the
   *   caller can emit a `replay_truncated` event and respond 412.
   * - Otherwise return the in-range events in ascending order; the caller then
   *   transitions to live streaming.
   */
  replayFrom(lastEventId: number): ReplayResult {
    this.resyncIfEvicted();
    // Empty WAL: nothing retained. Anything but the genesis cursor (0) is
    // treated as truncated since we cannot vouch for the gap.
    if (this._earliest === null) {
      if (lastEventId === 0) {
        return { truncated: false, events: [] };
      }
      return {
        truncated: true,
        events: [],
        earliestAvailableId: null,
        reason: 'no_wal',
      };
    }

    // The resume cursor is older than anything we still hold AND it is not the
    // exact predecessor boundary we can vouch for: signal truncation.
    if (lastEventId < this._earliest - 1) {
      return {
        truncated: true,
        events: [],
        earliestAvailableId: this._earliest,
        reason: 'older_than_wal_horizon',
      };
    }

    const events: WalFrame[] = [];
    for (const seg of this.segmentsOldestToNewest()) {
      for (const frame of decodeSegment(seg)) {
        if (frame.id > lastEventId) {
          events.push(frame);
        }
      }
    }
    events.sort((a, b) => a.id - b.id);
    return { truncated: false, events };
  }

  /**
   * The newest retained frame matching `pred`, read from disk newest segment
   * first, so a match in the active segment never decodes the rotated ones.
   * Used to recover the relay's renumbering state from the log itself.
   */
  findLast(pred: (frame: WalFrame) => boolean): WalFrame | undefined {
    const segments = this.segmentsOldestToNewest();
    for (let i = segments.length - 1; i >= 0; i--) {
      const frames = [...decodeSegment(segments[i]!)];
      for (let j = frames.length - 1; j >= 0; j--) {
        if (pred(frames[j]!)) return frames[j];
      }
    }
    return undefined;
  }

  // -- internals ----------------------------------------------------------

  /**
   * Re-read the on-disk truth when this handle has been dropped from the shared
   * registry, so the decision about to be made off `frames`/`_earliest`/`_latest`
   * is made against the current log rather than a snapshot taken before another
   * instance started writing it.
   *
   * Both the write path and the read paths need it, and they need the SAME rule,
   * which is why it lives here instead of inline in append(). The window this
   * does not close is stated rather than papered over: another instance can
   * still append between this resync and the caller's next call, so an evicted
   * handle that is held for the life of a long stream can still be one write
   * behind. Closing that needs one handle per session to be handed out at all,
   * which is the fan-out half of the issue, not something a resync can fix.
   */
  private resyncIfEvicted(): void {
    if (!this.evicted) return;
    this.evicted = false;
    this.recover();
  }

  private ensureOpen(): number {
    if (this.fd === null) {
      // 'a' => append mode; every write lands at end-of-file atomically.
      // 0600 applies only when this creates the segment.
      this.fd = openSync(this.activePath, 'a', 0o600);
      this.activeBytes = existsSync(this.activePath)
        ? fstatSync(this.fd).size
        : 0;
    }
    return this.fd;
  }

  /**
   * Re-derive counters by scanning every existing segment. Tolerates a torn
   * trailing frame in any segment (ignored as a truncated tail).
   */
  private recover(): void {
    this.frames = [];
    this.segLastId.clear();
    this._earliest = null;
    this._latest = null;
    // A fresh scan sees only retained-on-disk bytes, so there is no dead head
    // to charge until appends start dropping frames again.
    this.activeFrameCount = 0;
    this.deadBytes = 0;

    for (const seg of this.segmentsOldestToNewest()) {
      // Use the file mtime as a best-effort append time for recovered frames so
      // the horizon bound still applies across restarts.
      const mtimeMs = statSync(seg).mtimeMs;
      const suffix = this.suffixOfPath(seg);
      let last: number | null = null;
      let decoded = 0;
      for (const { frame, frameBytes } of decodeSegmentWithSizes(seg)) {
        last = frame.id;
        decoded += 1;
        this.frames.push({ id: frame.id, appendedAtMs: mtimeMs, frameBytes });
        if (this._earliest === null) {
          this._earliest = frame.id;
        }
        // Same high-water rule as append(): a resync must not report a lower
        // end than the live instance did, or the renumbering that anchors on it
        // re-anchors below ids already handed out.
        if (this._latest === null || frame.id > this._latest) {
          this._latest = frame.id;
        }
      }
      this.segLastId.set(suffix, last);
      if (suffix === 0) {
        this.activeFrameCount = decoded;
      }
    }

    if (existsSync(this.activePath)) {
      this.activeBytes = statSync(this.activePath).size;
    }
  }

  /**
   * Rotate the active segment: <sid>.log -> <sid>.log.1, shifting any existing
   * .log.N up to .log.(N+1) first so a higher suffix stays older.
   */
  private rotate(): void {
    this.close();

    const suffixes = this.rotatedSuffixesDescending();
    for (const n of suffixes) {
      renameSync(this.segPath(n), this.segPath(n + 1));
    }
    if (existsSync(this.activePath)) {
      renameSync(this.activePath, this.segPath(1));
    }
    // Every segment moved up one suffix, so the cached last-ids shift with the
    // files instead of being re-read. The reopened active segment holds no
    // frame yet, so its (absent) entry is not restored here.
    const shifted = new Map<number, number | null>();
    for (const [n, last] of this.segLastId) shifted.set(n + 1, last);
    this.segLastId = shifted;
    this.activeBytes = 0;
    // The renamed-away file took the active segment's frames (and any dead head
    // it was holding) with it, where pruneEmptySegments() can delete it whole.
    // The reopened segment holds no frame yet.
    this.activeFrameCount = 0;
    this.deadBytes = 0;
    // Eagerly reopen so the active segment exists as an empty file even before
    // the next append.
    this.ensureOpen();
  }

  /**
   * Enforce both retention bounds; the OLDER bound wins. Drop leading (oldest)
   * frames whose id is below the threshold, then delete any rotated segment
   * whose every frame has been dropped.
   */
  private enforceBounds(): void {
    if (this.frames.length === 0) {
      return;
    }

    // Bound A: event count. The oldest index we may keep.
    let keepFromCount = 0;
    if (this.frames.length > this.maxEvents) {
      keepFromCount = this.frames.length - this.maxEvents;
    }

    // Bound B: wall-clock horizon.
    const cutoffMs = this.now() - this.horizonSec * 1000;
    let keepFromHorizon = 0;
    while (
      keepFromHorizon < this.frames.length &&
      this.frames[keepFromHorizon]!.appendedAtMs < cutoffMs
    ) {
      keepFromHorizon += 1;
    }

    // Older bound wins => keep from the LATER (larger) of the two cut indices.
    const dropCount = Math.max(keepFromCount, keepFromHorizon);
    if (dropCount <= 0) {
      return;
    }

    // Charge the dropped bytes that were physically in the active segment. The
    // drop takes from the head of the sequence and the active file holds its
    // newest `activeFrameCount` entries, so the overlap is the tail of the drop
    // range; frames dropped from further back live in rotated segments, where
    // pruneEmptySegments() below already deletes the whole file.
    const firstActiveIdx = this.frames.length - this.activeFrameCount;
    if (dropCount > firstActiveIdx) {
      for (let i = Math.max(0, firstActiveIdx); i < dropCount; i++) {
        this.deadBytes += this.frames[i]!.frameBytes;
      }
      this.activeFrameCount -= dropCount - Math.max(0, firstActiveIdx);
    }

    this.frames = this.frames.slice(dropCount);
    this._earliest = this.frames.length > 0 ? this.frames[0]!.id : null;
    if (this.frames.length === 0) {
      this._latest = null;
    }

    this.pruneEmptySegments();
    if (this.deadBytes >= this.compactAfterBytes) {
      this.compactActiveSegment();
    }
  }

  /**
   * Rewrite the active segment so the retained frames start at byte 0.
   *
   * Retention was enforced in memory plus whole-segment `rmSync`, and never on
   * the active file, so a session whose window had slid forward kept its dead
   * prefix on disk until it rotated (#226). The session that filled the old
   * 16 MB cap held ~4 MB of reachable frames sitting on ~12 MB of unreachable
   * ones, and nothing could reclaim them while the session stayed open.
   *
   * Two rules keep this off the hot path and off the data-loss path:
   *
   * - It runs only when enforceBounds()'s dead-byte tally crosses
   *   compactAfterBytes, never from a scan, so appending past the retention
   *   bound still reads no segment (see walPruneReads.test.ts). One read pays
   *   for one segment's worth of reclamation.
   * - It refuses to rewrite unless the file decodes end to end. A frame the
   *   scanner cannot parse stops the scan, which hides every valid frame behind
   *   it; keeping only what decoded would delete reachable events.
   *
   * The write goes to a temp file that is fsynced before the rename, so a crash
   * mid-rewrite leaves the previous segment intact rather than a half-written
   * one. The fd is closed before the rename because a still-open fd would keep
   * appending to the unlinked inode.
   */
  private compactActiveSegment(): void {
    // Spend the tally either way: a skipped or failed rewrite must not make the
    // next append read the segment too, so a retry waits for another
    // compactAfterBytes of dead data.
    this.deadBytes = 0;
    if (this.evicted) {
      return;
    }

    let buf: Buffer;
    try {
      buf = readFileSync(this.activePath);
    } catch {
      return;
    }

    // subarray() views share `buf`, so collecting them costs nothing until the
    // retained tail is concatenated.
    const decoded: Buffer[] = [];
    let offset = 0;
    for (const { frameBytes } of decodeBuffer(buf)) {
      decoded.push(buf.subarray(offset, offset + frameBytes));
      offset += frameBytes;
    }
    if (offset !== buf.length) {
      return;
    }

    // Retained frames are a contiguous suffix of the append sequence, so the
    // ones in this file are simply its newest `keep` frames, by position. Ids
    // cannot be used for this: fork and rewind markers land below the current
    // end, so file order is not id order.
    const keep = Math.min(this.frames.length, decoded.length);
    if (keep >= decoded.length) {
      return;
    }

    const out = Buffer.concat(decoded.slice(decoded.length - keep));
    const tmpPath = `${this.activePath}.compact`;
    try {
      const tmpFd = openSync(tmpPath, 'w', 0o600);
      try {
        // writeSync can return short; a partial rewrite would truncate the live
        // window, so it is driven to completion here.
        let written = 0;
        while (written < out.length) {
          written += writeSync(tmpFd, out, written, out.length - written);
        }
        fsyncSync(tmpFd);
      } finally {
        closeSync(tmpFd);
      }
      this.close();
      renameSync(tmpPath, this.activePath);
      this.activeBytes = out.length;
      this.activeFrameCount = keep;
      if (keep === 0) {
        this.segLastId.set(0, null);
      }
    } catch {
      // The append that triggered this must not fail because its reclaim did:
      // the old segment is untouched, so the only cost is deferred reclamation.
      rmSync(tmpPath, { force: true });
    } finally {
      this.ensureOpen();
    }
  }

  /**
   * Delete whole rotated segments that no longer contain any retained frame.
   * A rotated segment is droppable when its newest (last) id is < the current
   * earliest retained id. We never delete the active segment here.
   */
  private pruneEmptySegments(): void {
    const earliest = this._earliest;
    for (const n of this.rotatedSuffixesDescending()) {
      const path = this.segPath(n);
      // A rotated segment is immutable, so its last id is read once and kept.
      // Re-reading it here cost a full segment scan on every append once the
      // session passed the retention bound (see enforceBounds).
      let newestInSeg = this.segLastId.get(n);
      if (newestInSeg === undefined) {
        newestInSeg = null;
        for (const frame of decodeSegment(path)) {
          newestInSeg = frame.id;
        }
        this.segLastId.set(n, newestInSeg);
      }
      // Segment fully below the retained window (or empty) => delete it.
      if (newestInSeg === null || earliest === null || newestInSeg < earliest) {
        rmSync(path, { force: true });
        this.segLastId.delete(n);
      }
    }
  }

  // -- segment path helpers ----------------------------------------------

  private segPath(n: number): string {
    return n === 0 ? this.activePath : `${this.activePath}.${n}`;
  }

  /** The numeric suffix of one of this instance's segment paths (0 = active). */
  private suffixOfPath(path: string): number {
    if (path === this.activePath) return 0;
    const tail = path.slice(this.activePath.length + 1);
    return /^\d+$/.test(tail) ? Number(tail) : 0;
  }

  /** Existing rotated suffixes (>=1), sorted DESCENDING (oldest first). */
  private rotatedSuffixesDescending(): number[] {
    const base = `${this.sessionId}.log.`;
    const out: number[] = [];
    let entries: string[];
    try {
      entries = readdirSync(this.walDir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (!name.startsWith(base)) {
        continue;
      }
      const tail = name.slice(base.length);
      if (!/^[0-9]+$/.test(tail)) {
        continue;
      }
      out.push(Number(tail));
    }
    out.sort((a, b) => b - a);
    return out;
  }

  /** All segment paths in oldest -> newest order (rotated desc, then active). */
  private segmentsOldestToNewest(): string[] {
    const paths: string[] = [];
    for (const n of this.rotatedSuffixesDescending()) {
      paths.push(this.segPath(n));
    }
    if (existsSync(this.activePath)) {
      paths.push(this.activePath);
    }
    return paths;
  }
}

// ---------------------------------------------------------------------------
// Shared instance registry
// ---------------------------------------------------------------------------

/**
 * Process-wide registry of live SessionWal instances, keyed by
 * "<dir>/<sessionId>".
 *
 * Every module that appends to a session's WAL (the events-route relay, the
 * recovery marker frames) MUST obtain its instance from here. `latestId()` is
 * in-memory per instance: two instances on the same segments diverge, and the
 * id-continuity renumbering (add-mid-turn-recovery §4) anchors a new epoch's
 * offset to the shared instance's `latestId()` — a stale duplicate instance
 * would re-anchor too low and write a colliding WAL id.
 */
/**
 * Shared WAL handles, bounded.
 *
 * Every session ever streamed used to leave a `SessionWal` here forever, each
 * holding per-frame metadata for up to `walMaxEvents` events and an open file
 * descriptor. On a long-lived gateway that is unbounded growth in both memory
 * and fds, for sessions nobody is reading any more.
 *
 * Entries are dropped least-recently-used. Dropping one is safe: a `SessionWal`
 * rebuilds its whole state from the on-disk log in its constructor, and any
 * reference a caller still holds resyncs before its next append (see
 * {@link SessionWal.markEvicted}).
 */
const SHARED_WAL_MAX = 64;
const sharedWalRegistry = new Map<string, SessionWal>();

export function getSharedWal(dir: string, sessionId: string): SessionWal {
  const key = `${dir}/${sessionId}`;
  const existing = sharedWalRegistry.get(key);
  if (existing !== undefined) {
    // Re-insert so Map iteration order stays least-recently-used first.
    sharedWalRegistry.delete(key);
    sharedWalRegistry.set(key, existing);
    return existing;
  }

  const wal = new SessionWal({ dir, sessionId });
  sharedWalRegistry.set(key, wal);

  while (sharedWalRegistry.size > SHARED_WAL_MAX) {
    const oldest = sharedWalRegistry.keys().next();
    if (oldest.done || oldest.value === key) break;
    const victim = sharedWalRegistry.get(oldest.value);
    sharedWalRegistry.delete(oldest.value);
    victim?.markEvicted();
  }
  return wal;
}

/** Drop a session's WAL handle, closing its fd. Used when a session ends. */
export function releaseSharedWal(dir: string, sessionId: string): void {
  const key = `${dir}/${sessionId}`;
  const wal = sharedWalRegistry.get(key);
  if (wal === undefined) return;
  sharedWalRegistry.delete(key);
  wal.markEvicted();
}

/** Registry size, for tests. */
export function sharedWalCount(): number {
  return sharedWalRegistry.size;
}

// ---------------------------------------------------------------------------
// Directory retention
// ---------------------------------------------------------------------------

/**
 * Bounds on the whole WAL directory (#174). A session's own log is bounded on
 * append (`maxEvents`, `horizonSec`), but only on append: a conversation
 * nobody streams again keeps its files forever, and the directory grows by
 * one session's worth for every conversation ever watched.
 */
export interface WalRetentionBounds {
  /** A session whose newest WAL write is older than this is removed. */
  maxAgeMs: number;
  /** Then, least recently written first, until the directory fits in this. */
  maxBytes: number;
}

export interface PruneWalDirOptions extends WalRetentionBounds {
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /** A session this holds is never removed: one being relayed right now. */
  keep?: (sessionId: string) => boolean;
}

export interface WalPruneResult {
  sessionsRemoved: number;
  removedForAge: number;
  removedForSize: number;
  bytesFreed: number;
  sessionsRetained: number;
  bytesRetained: number;
}

/** A session's files: segments `<sid>.log[.N]`, the epoch sidecar and its tmp. */
const WAL_SESSION_FILE =
  /^([0-9a-fA-F-]{32,36})\.(?:log(?:\.\d+)?|epoch\.json(?:\.tmp)?)$/;

/**
 * Remove whole sessions from the WAL directory: every one idle past
 * `maxAgeMs`, then, oldest newest-write first, as many as it takes to bring
 * the directory within `maxBytes`. A session goes as a unit (segments and
 * sidecar together), so what remains is always a complete log; its registry
 * handle is dropped first, so a later writer starts from the empty disk
 * instead of a snapshot of the files it no longer has. Files that are not a
 * session's WAL are left alone. Never throws for a missing directory.
 *
 * A pruned session is one the gateway has not relayed: a watcher coming back
 * to it with a cursor finds an empty WAL and is served from the daemon, the
 * same as the first time (see the events route).
 */
export function pruneWalDir(
  dir: string,
  opts: PruneWalDirOptions,
): WalPruneResult {
  const walDir = join(dir, 'wal');
  const result: WalPruneResult = {
    sessionsRemoved: 0,
    removedForAge: 0,
    removedForSize: 0,
    bytesFreed: 0,
    sessionsRetained: 0,
    bytesRetained: 0,
  };
  let entries: string[];
  try {
    entries = readdirSync(walDir);
  } catch {
    return result;
  }

  interface SessionFiles {
    sessionId: string;
    files: string[];
    bytes: number;
    newestMs: number;
  }
  const sessions = new Map<string, SessionFiles>();
  for (const name of entries) {
    const match = WAL_SESSION_FILE.exec(name);
    if (match === null) continue;
    let st;
    try {
      st = statSync(join(walDir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const sessionId = match[1]!;
    const entry = sessions.get(sessionId) ?? {
      sessionId,
      files: [],
      bytes: 0,
      newestMs: 0,
    };
    entry.files.push(name);
    entry.bytes += st.size;
    entry.newestMs = Math.max(entry.newestMs, st.mtimeMs);
    sessions.set(sessionId, entry);
  }

  const remove = (entry: SessionFiles): void => {
    releaseSharedWal(dir, entry.sessionId);
    for (const name of entry.files) {
      rmSync(join(walDir, name), { force: true });
    }
    result.sessionsRemoved += 1;
    result.bytesFreed += entry.bytes;
  };

  const now = (opts.now ?? Date.now)();
  const retained: SessionFiles[] = [];
  for (const entry of sessions.values()) {
    const held = opts.keep?.(entry.sessionId) ?? false;
    if (!held && now - entry.newestMs > opts.maxAgeMs) {
      remove(entry);
      result.removedForAge += 1;
    } else {
      retained.push(entry);
    }
  }

  let total = retained.reduce((n, e) => n + e.bytes, 0);
  if (total > opts.maxBytes) {
    const oldestFirst = retained
      .filter((e) => !(opts.keep?.(e.sessionId) ?? false))
      .sort((a, b) => a.newestMs - b.newestMs);
    for (const entry of oldestFirst) {
      if (total <= opts.maxBytes) break;
      remove(entry);
      result.removedForSize += 1;
      total -= entry.bytes;
      retained.splice(retained.indexOf(entry), 1);
    }
  }
  result.sessionsRetained = retained.length;
  result.bytesRetained = total;
  return result;
}

// ---------------------------------------------------------------------------
// Framing helpers (exported for tests / reuse)
// ---------------------------------------------------------------------------

/** Encode one WalFrame as a 4-byte big-endian length prefix + UTF-8 JSON. */
export function encodeFrame(frame: WalFrame): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  const encoded = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + json.length);
  encoded.writeUInt32BE(json.length, 0);
  json.copy(encoded, LENGTH_PREFIX_BYTES);
  return encoded;
}

/**
 * Forward-scan a buffer yielding decoded frames with byte sizes. A torn
 * trailing frame (the length prefix promises more bytes than remain, or the
 * prefix itself is partial) is treated as a truncated tail and silently
 * ignored — we stop the scan rather than crash.
 */
function* decodeBuffer(
  buf: Buffer,
): Generator<{ frame: WalFrame; frameBytes: number }> {
  let offset = 0;
  while (offset + LENGTH_PREFIX_BYTES <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const start = offset + LENGTH_PREFIX_BYTES;
    const end = start + len;
    if (end > buf.length) {
      // Torn/partial frame: stop; this is the truncated tail.
      return;
    }
    const slice = buf.subarray(start, end);
    let frame: WalFrame;
    try {
      frame = JSON.parse(slice.toString('utf8')) as WalFrame;
    } catch {
      // Corrupt payload: treat the rest as untrustworthy and stop.
      return;
    }
    yield { frame, frameBytes: LENGTH_PREFIX_BYTES + len };
    offset = end;
  }
}

/** Decode a segment file path into WalFrames (torn tail tolerated). */
export function* decodeSegment(path: string): Generator<WalFrame> {
  if (!existsSync(path)) {
    return;
  }
  const buf = readFileSync(path);
  for (const { frame } of decodeBuffer(buf)) {
    yield frame;
  }
}

/** Like decodeSegment but also yields each frame's on-disk byte size. */
function* decodeSegmentWithSizes(
  path: string,
): Generator<{ frame: WalFrame; frameBytes: number }> {
  if (!existsSync(path)) {
    return;
  }
  const buf = readFileSync(path);
  yield* decodeBuffer(buf);
}
