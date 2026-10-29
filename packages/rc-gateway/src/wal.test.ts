/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionWal,
  encodeFrame,
  decodeSegment,
  getSharedWal,
  releaseSharedWal,
  sharedWalCount,
  pruneWalDir,
} from './wal.js';
import type { WalFrame } from './wal.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'rc-gateway-wal-'));
}

function makeFrame(
  id: number,
  type = 'session_update',
  data: unknown = { text: `event-${id}` },
): WalFrame {
  return { id, v: 1, type, data };
}

describe('SessionWal', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  it('append + replay round-trip: returns frames in ascending id order', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1' });
    wal.append(makeFrame(1));
    wal.append(makeFrame(2));
    wal.append(makeFrame(3));
    wal.close();

    const result = wal.replayFrom(0);
    expect(result.truncated).toBe(false);
    if (!result.truncated) {
      expect(result.events.map((e) => e.id)).toEqual([1, 2, 3]);
      expect(result.events[0]!.data).toEqual({ text: 'event-1' });
    }
  });

  it('replayFrom skips events at or before the cursor', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1' });
    wal.append(makeFrame(1));
    wal.append(makeFrame(2));
    wal.append(makeFrame(3));
    wal.close();

    const result = wal.replayFrom(2);
    expect(result.truncated).toBe(false);
    if (!result.truncated) {
      expect(result.events.map((e) => e.id)).toEqual([3]);
    }
  });

  it('replayFrom(0) on empty WAL returns empty non-truncated result', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1' });
    wal.close();
    const result = wal.replayFrom(0);
    expect(result.truncated).toBe(false);
    if (!result.truncated) {
      expect(result.events).toHaveLength(0);
    }
  });

  it('replayFrom non-zero cursor on empty WAL returns truncated: no_wal', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1' });
    wal.close();
    const result = wal.replayFrom(5);
    expect(result.truncated).toBe(true);
    if (result.truncated) {
      expect(result.reason).toBe('no_wal');
      expect(result.earliestAvailableId).toBeNull();
    }
  });

  it('horizon eviction: events older than horizonSec are dropped', () => {
    let now = 1_000_000;
    const wal = new SessionWal({
      dir,
      sessionId: 'sess-1',
      horizonSec: 10,
      now: () => now,
    });

    wal.append(makeFrame(1)); // at t=1_000_000
    now += 15_000; // jump 15s forward — frame 1 is now beyond 10s horizon
    wal.append(makeFrame(2)); // at t=1_015_000

    wal.close();

    expect(wal.count()).toBe(1);
    expect(wal.earliestId()).toBe(2);

    const result = wal.replayFrom(0);
    expect(result.truncated).toBe(true);
    if (result.truncated) {
      expect(result.reason).toBe('older_than_wal_horizon');
      expect(result.earliestAvailableId).toBe(2);
    }
  });

  it('count eviction: keeps only maxEvents newest events', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1', maxEvents: 3 });
    for (let i = 1; i <= 5; i++) {
      wal.append(makeFrame(i));
    }
    wal.close();

    expect(wal.count()).toBe(3);
    expect(wal.earliestId()).toBe(3);
    expect(wal.latestId()).toBe(5);

    const result = wal.replayFrom(0);
    expect(result.truncated).toBe(true);
    if (result.truncated) {
      expect(result.reason).toBe('older_than_wal_horizon');
      expect(result.earliestAvailableId).toBe(3);
    }
  });

  it('replay from cursor older than earliest returns truncated with earliestAvailableId', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1', maxEvents: 2 });
    wal.append(makeFrame(10));
    wal.append(makeFrame(11));
    wal.append(makeFrame(12)); // evicts 10
    wal.close();

    const result = wal.replayFrom(5); // 5 < 11 (earliest)
    expect(result.truncated).toBe(true);
    if (result.truncated) {
      expect(result.earliestAvailableId).toBe(11);
    }
  });

  it('torn-tail recovery: ignores incomplete frame at end of segment', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1' });
    wal.append(makeFrame(1));
    wal.append(makeFrame(2));
    wal.close();

    // Corrupt the active segment: append a partial length prefix (3 bytes instead of 4+payload)
    const segPath = join(dir, 'wal', 'sess-1.log');
    const existing = readFileSync(segPath);
    const torn = Buffer.concat([existing, Buffer.from([0x00, 0x00, 0x10])]);
    writeFileSync(segPath, torn);

    // Re-open should recover cleanly
    const wal2 = new SessionWal({ dir, sessionId: 'sess-1' });
    const result = wal2.replayFrom(0);
    expect(result.truncated).toBe(false);
    if (!result.truncated) {
      expect(result.events.map((e) => e.id)).toEqual([1, 2]);
    }
    wal2.close();
  });

  it('segment rotation: creates .log.1 once active segment exceeds segmentMaxBytes', () => {
    const wal = new SessionWal({
      dir,
      sessionId: 'sess-1',
      segmentMaxBytes: 50, // tiny threshold to force rotation quickly
    });

    // Each frame is ~50+ bytes; after first append it will rotate
    wal.append(makeFrame(1, 'session_update', { text: 'a'.repeat(40) }));
    wal.append(makeFrame(2, 'session_update', { text: 'b'.repeat(40) }));
    wal.close();

    expect(existsSync(join(dir, 'wal', 'sess-1.log.1'))).toBe(true);

    const wal2 = new SessionWal({ dir, sessionId: 'sess-1' });
    const result = wal2.replayFrom(0);
    expect(result.truncated).toBe(false);
    if (!result.truncated) {
      expect(result.events.map((e) => e.id)).toEqual([1, 2]);
    }
    wal2.close();
  });
});

describe('encodeFrame / decodeSegment', () => {
  it('round-trips a frame through encode + decode', () => {
    const frame: WalFrame = {
      id: 42,
      v: 1,
      type: 'session_update',
      data: { x: 1 },
    };
    const encoded = encodeFrame(frame);
    const path = join(makeTmpDir(), 'test.log');
    writeFileSync(path, encoded);
    const decoded = [...decodeSegment(path)];
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(frame);
  });
});

describe('shared WAL registry', () => {
  it('returns the same instance for the same session', () => {
    const dir = makeTmpDir();
    expect(getSharedWal(dir, 's1')).toBe(getSharedWal(dir, 's1'));
  });

  it('stays bounded as sessions accumulate', () => {
    const dir = makeTmpDir();
    const before = sharedWalCount();
    for (let i = 0; i < 200; i++) getSharedWal(dir, `bounded-${i}`);
    // Without a cap this would be `before + 200`.
    expect(sharedWalCount()).toBeLessThanOrEqual(64);
    expect(sharedWalCount()).toBeLessThan(before + 200);
  });

  it('evicts least-recently-used, keeping the freshly touched one', () => {
    const dir = makeTmpDir();
    const keep = getSharedWal(dir, 'keep-me');
    keep.append(makeFrame(1));
    for (let i = 0; i < 40; i++) {
      getSharedWal(dir, `filler-a-${i}`);
      // Touch it again so it never becomes the oldest entry.
      getSharedWal(dir, 'keep-me');
    }
    expect(getSharedWal(dir, 'keep-me')).toBe(keep);
  });

  it('releaseSharedWal drops the handle', () => {
    const dir = makeTmpDir();
    const first = getSharedWal(dir, 'released');
    releaseSharedWal(dir, 'released');
    expect(getSharedWal(dir, 'released')).not.toBe(first);
  });

  // The reason eviction is safe at all: a caller can still be holding an
  // evicted instance across an open stream.
  it('an evicted instance still appends correctly, resyncing from disk', () => {
    const dir = makeTmpDir();
    const held = getSharedWal(dir, 'evicted');
    held.append(makeFrame(1));
    held.append(makeFrame(2));

    // Push it out of the registry, then let a fresh instance write more.
    releaseSharedWal(dir, 'evicted');
    const fresh = getSharedWal(dir, 'evicted');
    expect(fresh).not.toBe(held);
    fresh.append(makeFrame(3));

    // The stale reference must not clobber what the fresh one wrote.
    held.append(makeFrame(4));

    const ids = getSharedWal(dir, 'evicted')
      .replayFrom(0)
      .events.map((e) => e.id);
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  // Why the rewind and fork routes must not build their own SessionWal: the
  // events-route relay holds the registry handle for the whole stream and
  // anchors its id renumbering on latestId(). A private instance writes the
  // marker to disk but leaves that handle none the wiser, so the next frame the
  // relay appends reuses the marker id.
  it('a private instance hides its marker from the shared handle, and the id collides', () => {
    const dir = makeTmpDir();
    const relay = getSharedWal(dir, 'collide');
    relay.append(makeFrame(1));

    const privateWal = new SessionWal({ dir, sessionId: 'collide' });
    const markerId = (privateWal.latestId() ?? 0) + 1;
    privateWal.append(makeFrame(markerId));
    privateWal.close();

    // The live stream never saw the marker, so it hands the same id out next.
    expect(relay.latestId()).toBe(1);
    expect((relay.latestId() ?? 0) + 1).toBe(markerId);

    // Through the registry the same write advances the stream's anchor, so the
    // next relayed id is past the marker.
    const seeded = getSharedWal(dir, 'collide');
    seeded.append(makeFrame(markerId));
    expect(relay.latestId()).toBe(markerId);
    expect((relay.latestId() ?? 0) + 1).toBe(markerId + 1);
  });

  // The fork route anchors session_forked at the client cursor (fromEventId +
  // 1), which can sit below the end of the log. Now that every appender shares
  // one handle, a low marker must not drag the anchor backwards: the renumbering
  // would re-anchor below ids already sent and write colliding WAL ids.
  // The reads matter as much as the write here: four callers compute a new id as
  // (latestId() ?? 0) + 1, so a handle that answers from a snapshot taken before
  // another instance started writing the same log does not merely read old, it
  // aims the next append at an id the WAL already holds.
  it('an evicted handle reports what the fresh instance appended', () => {
    const dir = makeTmpDir();
    const held = getSharedWal(dir, 'evict-read');
    held.append(makeFrame(1));
    // The registry dropping this handle is what marks it; a caller can still be
    // holding it across an open stream.
    releaseSharedWal(dir, 'evict-read');
    const fresh = getSharedWal(dir, 'evict-read');
    fresh.append(makeFrame(2));

    expect(held.latestId()).toBe(2);
  });

  // replayFrom() decodes its segments from disk on every call, so the EVENTS it
  // returns are never stale. What can be stale is `_earliest`, which is the only
  // thing its truncation test reads. A foreign instance that pruned a whole
  // segment moves that on disk, and a handle that answers from its old value
  // reports a clean replay across a hole the client can never see.
  it('a pruned foreign segment makes a stale cursor truncate instead of replaying a gap', () => {
    const dir = makeTmpDir();
    const held = getSharedWal(dir, 'evict-prune');
    held.append(makeFrame(1));
    releaseSharedWal(dir, 'evict-prune');

    // A foreign writer with a one-frame window: every append rotates and prunes
    // the segment before it, so by id 3 only id 3 survives on disk.
    const foreign = new SessionWal({
      dir,
      sessionId: 'evict-prune',
      segmentMaxBytes: 1,
      maxEvents: 1,
    });
    foreign.append(makeFrame(2));
    foreign.append(makeFrame(3));
    foreign.close();

    // Disk truth, read through a fresh handle: id 1 and 2 are gone.
    const truth = getSharedWal(dir, 'evict-prune');
    expect(truth.earliestId()).toBe(3);

    // The held handle still believes it starts at 1, so a cursor of 1 looks
    // satisfiable. Resynced it must report truncation, not a silent [3].
    const replay = held.replayFrom(1);
    expect(replay.truncated).toBe(true);
    expect(replay.earliestAvailableId).toBe(3);
  });

  it('an evicted handle anchors a new id above the foreign write, not on it', () => {
    const dir = makeTmpDir();
    const held = getSharedWal(dir, 'evict-anchor');
    held.append(makeFrame(1));
    releaseSharedWal(dir, 'evict-anchor');
    const fresh = getSharedWal(dir, 'evict-anchor');
    fresh.append(makeFrame(2));

    // This is the arithmetic a marker or a re-anchored epoch actually uses.
    const nextId = (held.latestId() ?? 0) + 1;
    expect(nextId).toBe(3);
    const alreadyWritten = fresh.replayFrom(0).events.map((e) => e.id);
    expect(alreadyWritten).not.toContain(nextId);
  });

  it('latestId is a high water mark, an out of order marker cannot pull it back', () => {
    const dir = makeTmpDir();
    const wal = getSharedWal(dir, 'high-water');
    wal.append(makeFrame(7));
    wal.append(makeFrame(3));

    expect(wal.latestId()).toBe(7);
    expect((wal.latestId() ?? 0) + 1).toBe(8);

    // A resync (eviction, or a gateway restart re-opening the log) must agree
    // with the live view rather than reading the out of order tail as the end.
    releaseSharedWal(dir, 'high-water');
    expect(getSharedWal(dir, 'high-water').latestId()).toBe(7);
  });
});

describe('WAL directory retention (#174)', () => {
  const DAY = 86_400_000;
  const NOW = 1_800_000_000_000;
  const A = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
  const B = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
  const C = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';

  /** A session's WAL (rotated segment, active segment, sidecar), aged. */
  function seed(dir: string, sid: string, ageMs: number, frames = 3): void {
    const wal = new SessionWal({ dir, sessionId: sid, segmentMaxBytes: 64 });
    for (let id = 1; id <= frames; id++) wal.append(makeFrame(id));
    wal.close();
    writeFileSync(join(dir, 'wal', `${sid}.epoch.json`), '{}');
    const at = new Date(NOW - ageMs);
    for (const name of readdirSync(join(dir, 'wal'))) {
      if (name.startsWith(sid)) utimesSync(join(dir, 'wal', name), at, at);
    }
  }
  const files = (dir: string, sid: string) =>
    readdirSync(join(dir, 'wal')).filter((n) => n.startsWith(sid));

  it('removes a session idle past the age bound, every file of it, and keeps the rest', () => {
    const dir = makeTmpDir();
    seed(dir, A, 10 * DAY);
    seed(dir, B, 1 * DAY);
    expect(files(dir, A).length).toBeGreaterThanOrEqual(3);

    const result = pruneWalDir(dir, {
      maxAgeMs: 7 * DAY,
      maxBytes: Number.MAX_SAFE_INTEGER,
      now: () => NOW,
    });

    expect(files(dir, A)).toEqual([]);
    expect(files(dir, B).length).toBeGreaterThanOrEqual(3);
    expect(result).toMatchObject({
      sessionsRemoved: 1,
      sessionsRetained: 1,
      removedForAge: 1,
      removedForSize: 0,
    });
    expect(result.bytesFreed).toBeGreaterThan(0);
  });

  it('over the size bound, removes the least recently written sessions first until under it', () => {
    const dir = makeTmpDir();
    seed(dir, A, 3 * DAY);
    seed(dir, B, 2 * DAY);
    seed(dir, C, 1 * DAY);
    const one = files(dir, C).reduce(
      (n, f) => n + readFileSync(join(dir, 'wal', f)).length,
      0,
    );

    // Room for a little more than one session: the two oldest go.
    const result = pruneWalDir(dir, {
      maxAgeMs: 30 * DAY,
      maxBytes: one + 1,
      now: () => NOW,
    });

    expect(files(dir, A)).toEqual([]);
    expect(files(dir, B)).toEqual([]);
    expect(files(dir, C).length).toBeGreaterThan(0);
    expect(result).toMatchObject({ sessionsRemoved: 2, removedForSize: 2 });
    expect(result.bytesRetained).toBeLessThanOrEqual(one + 1);
  });

  it('never removes a session the keep predicate holds (one being relayed live)', () => {
    const dir = makeTmpDir();
    seed(dir, A, 10 * DAY);
    seed(dir, B, 10 * DAY);
    const result = pruneWalDir(dir, {
      maxAgeMs: 7 * DAY,
      maxBytes: 0,
      now: () => NOW,
      keep: (sid) => sid === A,
    });
    expect(files(dir, A).length).toBeGreaterThan(0);
    expect(files(dir, B)).toEqual([]);
    expect(result.sessionsRemoved).toBe(1);
  });

  it("drops a pruned session's shared handle, so the next writer starts from the empty disk", () => {
    const dir = makeTmpDir();
    const held = getSharedWal(dir, A);
    held.append(makeFrame(1));
    held.append(makeFrame(2));
    seed(dir, B, 0);
    for (const name of files(dir, A)) {
      const at = new Date(NOW - 10 * DAY);
      utimesSync(join(dir, 'wal', name), at, at);
    }
    pruneWalDir(dir, {
      maxAgeMs: 7 * DAY,
      maxBytes: Number.MAX_SAFE_INTEGER,
      now: () => NOW,
    });
    expect(getSharedWal(dir, A)).not.toBe(held);
    expect(getSharedWal(dir, A).latestId()).toBeNull();
  });

  it("leaves files that are not a session's WAL alone, and an absent directory is a no-op", () => {
    const dir = makeTmpDir();
    expect(
      pruneWalDir(dir, { maxAgeMs: 0, maxBytes: 0, now: () => NOW }),
    ).toMatchObject({ sessionsRemoved: 0, bytesFreed: 0 });
    seed(dir, A, 10 * DAY);
    writeFileSync(join(dir, 'wal', 'notes.txt'), 'keep');
    const old = new Date(NOW - 10 * DAY);
    utimesSync(join(dir, 'wal', 'notes.txt'), old, old);
    pruneWalDir(dir, { maxAgeMs: DAY, maxBytes: 0, now: () => NOW });
    expect(existsSync(join(dir, 'wal', 'notes.txt'))).toBe(true);
    expect(files(dir, A)).toEqual([]);
  });
});
