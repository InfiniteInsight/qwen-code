/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionWal,
  encodeFrame,
  decodeSegment,
  getSharedWal,
  releaseSharedWal,
  sharedWalCount,
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
