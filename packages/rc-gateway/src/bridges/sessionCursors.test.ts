/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorStore } from './cursorStore.js';
import { SubscriptionCursors } from './sessionCursors.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-sesscur-'));
});
/** Wait for the store's writes (in flight and queued) to land. */
async function flush(store: CursorStore): Promise<void> {
  await store['inFlight'];
  await store['queued'];
  await store['inFlight'];
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SubscriptionCursors (#204)', () => {
  it('loads the stored cursor of each bound session', async () => {
    const store = await CursorStore.open(join(dir, 'cursors.json'));
    await store.setLastEventId('tok', 'sess-a', 7);
    const sc = new SubscriptionCursors(store, 'tok');
    sc.load(['sess-a', 'sess-b']);
    expect(sc.lastEventId.get('sess-a')).toBe(7);
    expect(sc.lastEventId.has('sess-b')).toBe(false);
  });

  it('records a frame id in memory and in the store', async () => {
    const store = await CursorStore.open(join(dir, 'cursors.json'));
    const sc = new SubscriptionCursors(store, 'tok');
    sc.record('sess-a', 12);
    expect(sc.lastEventId.get('sess-a')).toBe(12);
    expect(store.get('tok', 'sess-a')?.lastEventId).toBe(12);
    await flush(store);
  });

  it('works without a store (in-memory only)', () => {
    const sc = new SubscriptionCursors();
    sc.record('sess-a', 3);
    expect(sc.lastEventId.get('sess-a')).toBe(3);
    expect(sc.release([])).toEqual(['sess-a']);
  });

  it('release drops the cursor of a session that is no longer bound, from memory and the store', async () => {
    const path = join(dir, 'cursors.json');
    const store = await CursorStore.open(path);
    const sc = new SubscriptionCursors(store, 'tok');
    sc.record('sess-a', 5);
    sc.record('sess-b', 6);
    const released = sc.release(['sess-b']);
    expect(released).toEqual(['sess-a']);
    expect(sc.lastEventId.has('sess-a')).toBe(false);
    expect(sc.lastEventId.get('sess-b')).toBe(6);
    expect(store.get('tok', 'sess-a')).toBeUndefined();
    expect(store.get('tok', 'sess-b')?.lastEventId).toBe(6);
    // Gone from disk too, not just from the in-memory map.
    await flush(store);
    const reopened = await CursorStore.open(path);
    expect(reopened.get('tok', 'sess-a')).toBeUndefined();
    expect(reopened.get('tok', 'sess-b')?.lastEventId).toBe(6);
  });

  it('release aborts the stream of an unbound session and leaves the others running', () => {
    const sc = new SubscriptionCursors();
    const parent = new AbortController();
    const a = sc.signalFor('sess-a', parent.signal);
    const b = sc.signalFor('sess-b', parent.signal);
    sc.release(['sess-b']);
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(false);
    parent.abort();
    expect(b.aborted).toBe(true);
  });

  it('a frame from a stream that was already released does not bring the cursor back', async () => {
    const store = await CursorStore.open(join(dir, 'cursors.json'));
    const sc = new SubscriptionCursors(store, 'tok');
    const parent = new AbortController();
    const sig = sc.signalFor('sess-a', parent.signal);
    sc.record('sess-a', 1, sig);
    sc.release([]);
    sc.record('sess-a', 2, sig); // late frame on the closing stream
    expect(sc.lastEventId.has('sess-a')).toBe(false);
    expect(store.get('tok', 'sess-a')).toBeUndefined();
    await flush(store);
  });

  it('a session bound again after release starts a fresh stream and cursor', async () => {
    const store = await CursorStore.open(join(dir, 'cursors.json'));
    const sc = new SubscriptionCursors(store, 'tok');
    const parent = new AbortController();
    const first = sc.signalFor('sess-a', parent.signal);
    sc.record('sess-a', 9, first);
    sc.release([]);
    const second = sc.signalFor('sess-a', parent.signal);
    expect(second.aborted).toBe(false);
    expect(sc.lastEventId.has('sess-a')).toBe(false);
    sc.record('sess-a', 1, second);
    expect(store.get('tok', 'sess-a')?.lastEventId).toBe(1);
    await flush(store);
  });
});
