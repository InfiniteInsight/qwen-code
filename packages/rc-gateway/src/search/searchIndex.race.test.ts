/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A full reindex must STAT a transcript before it READS it. To prove the order,
// the mocked readFileSync appends to the file right after the real read returns
// (a daemon writing mid-reindex). With stat-after-read the new mtime would be
// recorded against the old content and the next incremental pass would call the
// file unchanged, never indexing the appended record.
const afterRead = vi.hoisted(() => ({
  fn: undefined as undefined | (() => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: ((...args: Parameters<typeof real.readFileSync>) => {
      const out = real.readFileSync(...args);
      afterRead.fn?.();
      return out;
    }) as typeof real.readFileSync,
  };
});

import { SearchIndex } from './searchIndex.js';

const ID = '00000000000000000000000000000001';
const line = (uuid: string, text: string) =>
  JSON.stringify({
    uuid,
    sessionId: ID,
    timestamp: '2026-06-01T12:00:00.000Z',
    type: 'user',
    message: { parts: [{ text }] },
  });

describe('SearchIndex.reindex stat-before-read (#170)', () => {
  let chatsDir: string;
  let dbPath: string;
  beforeEach(() => {
    chatsDir = mkdtempSync(join(tmpdir(), 'rc-race-chats-'));
    dbPath = join(mkdtempSync(join(tmpdir(), 'rc-race-db-')), 'index.db');
  });
  afterEach(() => {
    afterRead.fn = undefined;
    rmSync(chatsDir, { recursive: true, force: true });
  });

  it('a record appended during a full reindex is picked up by the next incremental pass', () => {
    const file = join(chatsDir, `${ID}.jsonl`);
    writeFileSync(file, line('first', 'alpha widget') + '\n');
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);

    let fired = false;
    afterRead.fn = () => {
      if (fired) return;
      fired = true;
      writeFileSync(
        file,
        line('first', 'alpha widget') +
          '\n' +
          line('late', 'beta gadget') +
          '\n',
      );
    };

    const idx = SearchIndex.open(dbPath);
    try {
      idx.reindex(chatsDir);
      afterRead.fn = undefined;
      const inc = idx.reindexIncremental(chatsDir);
      expect(inc.updated).toBe(1);
      expect(idx.query('gadget').hits.map((h) => h.eventId)).toEqual(['late']);
    } finally {
      idx.close();
    }
  });
});
