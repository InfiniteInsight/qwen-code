/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorStore, cursorPartitionOf } from './cursorStore.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-cursor-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PATH = () => join(dir, 'cursors.json');

describe('CursorStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = await CursorStore.open(PATH());
    expect(store.get('tok1', 'sess-a')).toBeUndefined();
  });

  it('persists lastEventId and survives a reopen', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastEventId('tok1', 'sess-a', 42);
    const store2 = await CursorStore.open(PATH());
    expect(store2.get('tok1', 'sess-a')).toEqual({
      lastEventId: 42,
      lastDeliveredEventId: 42,
    });
  });

  it('persists lastDeliveredEventId and survives a reopen', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastEventId('tok1', 'sess-a', 10);
    await store.setLastDeliveredEventId('tok1', 'sess-a', 7);
    const store2 = await CursorStore.open(PATH());
    expect(store2.get('tok1', 'sess-a')).toEqual({
      lastEventId: 10,
      lastDeliveredEventId: 7,
    });
  });

  it('setLastEventId initialises lastDeliveredEventId when no entry exists', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastEventId('tok1', 'sess-new', 99);
    expect(store.get('tok1', 'sess-new')).toEqual({
      lastEventId: 99,
      lastDeliveredEventId: 99,
    });
  });

  it('setLastDeliveredEventId initialises lastEventId when no entry exists', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastDeliveredEventId('tok1', 'sess-new', 5);
    expect(store.get('tok1', 'sess-new')).toEqual({
      lastEventId: 5,
      lastDeliveredEventId: 5,
    });
  });

  it('cursors are keyed per (tokenId, sessionId) pair', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastEventId('tok1', 'sess-a', 10);
    await store.setLastEventId('tok2', 'sess-a', 20);
    await store.setLastEventId('tok1', 'sess-b', 30);
    expect(store.get('tok1', 'sess-a')?.lastEventId).toBe(10);
    expect(store.get('tok2', 'sess-a')?.lastEventId).toBe(20);
    expect(store.get('tok1', 'sess-b')?.lastEventId).toBe(30);
  });

  it('delete removes the entry and flushes', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastEventId('tok1', 'sess-a', 50);
    await store.delete('tok1', 'sess-a');
    expect(store.get('tok1', 'sess-a')).toBeUndefined();
    // Verify persistence
    const store2 = await CursorStore.open(PATH());
    expect(store2.get('tok1', 'sess-a')).toBeUndefined();
  });

  it('write is atomic: the file is never partially written (temp+rename)', async () => {
    const store = await CursorStore.open(PATH());
    // Run several concurrent writes to exercise the rename path.
    await Promise.all([
      store.setLastEventId('tok1', 's1', 1),
      store.setLastEventId('tok1', 's2', 2),
      store.setLastEventId('tok1', 's3', 3),
    ]);
    // At minimum the file is valid JSON after concurrent writes.
    const raw = await readFile(PATH(), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('serializes writes and folds a burst into one more write, ending at the latest value (#168)', async () => {
    // Once wired, every SSE frame sets the cursor; each set used to start its
    // own racing write (temp + rename), so a stream meant a disk write per
    // frame and an older snapshot could land last.
    const writes: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fs = await import('node:fs/promises');
    const store = await CursorStore.open(PATH(), {
      writeFile: async (path, data) => {
        writes.push(String(data));
        if (writes.length === 1) await gate; // hold the first write open
        await fs.writeFile(path, data);
      },
    });
    const done = [store.setLastEventId('tok1', 's', 1)];
    for (let i = 2; i <= 50; i++)
      done.push(store.setLastEventId('tok1', 's', i));
    release();
    await Promise.all(done);
    expect(writes).toHaveLength(2); // the held one, then one carrying 2..50
    expect(JSON.parse(writes[1])['tok1/s'].lastEventId).toBe(50);
    const reopened = await CursorStore.open(PATH());
    expect(reopened.get('tok1', 's')?.lastEventId).toBe(50);
  });

  it('silently ignores a corrupt file and starts empty', async () => {
    const p = PATH();
    await rm(dir, { recursive: true, force: true });
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(dir, { recursive: true }),
    );
    await import('node:fs/promises').then((fs) => fs.writeFile(p, 'NOT JSON'));
    const store = await CursorStore.open(p);
    expect(store.get('tok1', 'sess-a')).toBeUndefined();
  });
});

describe('cursorPartitionOf (#168)', () => {
  const token = 'qwk_' + 'A'.repeat(43);

  it('is stable per token, differs between tokens, and is not the token', () => {
    const id = cursorPartitionOf(token);
    expect(id).toBe(cursorPartitionOf(token));
    expect(id).not.toBe(cursorPartitionOf('qwk_' + 'B'.repeat(43)));
    expect(id).not.toContain('qwk_');
    expect(token).not.toContain(id);
  });

  it('keeps the bearer token out of cursors.json', async () => {
    const store = await CursorStore.open(PATH());
    await store.setLastEventId(cursorPartitionOf(token), 'sess-a', 7);
    const raw = await readFile(PATH(), 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('qwk_');
  });
});
