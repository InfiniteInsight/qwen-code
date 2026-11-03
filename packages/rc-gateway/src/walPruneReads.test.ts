/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Appending must not read a segment back.
 *
 * enforceBounds() runs on every append and, once a session is over its
 * retention bound, it reaches pruneEmptySegments() every single time. That
 * method used to decode each rotated segment in full to learn its last frame
 * id, so a session past the bound paid a whole-segment scan per event: on the
 * 19.8MB log of a live session that measured 55.6ms per append, which is what
 * starved the gateway's event loop. These tests pin the reads to zero rather
 * than timing anything, so they cannot go green by the machine being fast.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { segmentReads } = vi.hoisted(() => ({ segmentReads: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    segmentReads.push(String(args[0]));
    return (actual.readFileSync as unknown as (...a: unknown[]) => unknown)(
      ...args,
    );
  }) as typeof actual.readFileSync;
  const wrapped = { ...actual, readFileSync };
  return { ...wrapped, default: wrapped };
});

import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWal } from './wal.js';
import type { WalFrame } from './wal.js';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function frame(id: number): WalFrame {
  return { id, v: 1, type: 'session_update', data: { text: `event-${id}` } };
}

describe('SessionWal append reads', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-gateway-wal-reads-'));
    segmentReads.length = 0;
  });

  /**
   * segmentMaxBytes=1 rotates on every append and maxEvents=4 keeps the bound
   * crossed from the fourth frame on, so every append after that walks
   * pruneEmptySegments() over the rotated segments.
   */
  function openPastTheBound(): SessionWal {
    const wal = new SessionWal({
      dir,
      sessionId: SESSION_ID,
      maxEvents: 4,
      segmentMaxBytes: 1,
    });
    for (let id = 1; id <= 12; id++) wal.append(frame(id));
    return wal;
  }

  it('reads no segment file while appending past the retention bound', () => {
    const wal = openPastTheBound();
    expect(
      readdirSync(join(dir, 'wal')).some((n) => n.endsWith('.log.1')),
      'the run above must have produced a rotated segment to read',
    ).toBe(true);

    segmentReads.length = 0;
    for (let id = 13; id <= 22; id++) wal.append(frame(id));

    expect(segmentReads).toEqual([]);
  });

  it('still deletes the segments the bound leaves empty, without reading them', () => {
    const wal = openPastTheBound();
    const before = readdirSync(join(dir, 'wal'));
    segmentReads.length = 0;
    for (let id = 13; id <= 40; id++) wal.append(frame(id));
    const after = readdirSync(join(dir, 'wal'));

    expect(segmentReads).toEqual([]);
    expect(after.length).toBeLessThanOrEqual(before.length);
  });

  it('keeps replaying what the bound retains after all those appends', () => {
    const wal = openPastTheBound();
    for (let id = 13; id <= 22; id++) wal.append(frame(id));

    // The bound kept exactly the last four, so 19 is the oldest the WAL will
    // vouch for and a cursor below it is a truncation, not a replay.
    expect(wal.earliestId()).toBe(19);
    expect(wal.replayFrom(18).events.map((f) => f.id)).toEqual([
      19, 20, 21, 22,
    ]);
    expect(wal.replayFrom(0)).toMatchObject({
      truncated: true,
      reason: 'older_than_wal_horizon',
      earliestAvailableId: 19,
    });
  });

  /**
   * Compaction (#226) reads the active segment, so it must stay off this path.
   * What keeps it off is the trigger being scoped to bytes physically inside
   * the active segment. Here every append rotates, so the frames the bound drops
   * sit in rotated files that pruneEmptySegments() deletes whole; a tally that
   * charged those too would cross its trigger on every append and rewrite the
   * segment each time. Checked by mutation: dropping the scoping makes this test
   * record 28 segment reads, which is the per-append segment scan that starved
   * the event loop at 55.6ms.
   */
  it('reads nothing with compaction armed, because the dropped bytes are not in the active segment', () => {
    const wal = new SessionWal({
      dir,
      sessionId: SESSION_ID,
      maxEvents: 4,
      segmentMaxBytes: 1,
      compactAfterBytes: 1,
    });
    for (let id = 1; id <= 12; id++) wal.append(frame(id));

    segmentReads.length = 0;
    for (let id = 13; id <= 40; id++) wal.append(frame(id));

    expect(segmentReads).toEqual([]);
    expect(wal.earliestId()).toBe(37);
  });
});
