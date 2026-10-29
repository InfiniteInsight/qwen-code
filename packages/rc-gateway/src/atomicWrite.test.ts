/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonStore, writeFileAtomic } from './atomicWrite.js';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'rc-atomic-'));
}

describe('writeFileAtomic', () => {
  it('writes the content at mode 0600 and leaves no temp file', async () => {
    const d = dir();
    const p = join(d, 'nested', 'x.json');
    await writeFileAtomic(p, '{"a":1}');
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(d, 'nested'))).toEqual(['x.json']);
  });

  it('a burst for one path ends with the last data and costs at most two writes', async () => {
    const p = join(dir(), 'x.json');
    const produced: number[] = [];
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        writeFileAtomic(p, () => {
          produced.push(i);
          return String(i);
        }),
      ),
    );
    expect(readFileSync(p, 'utf8')).toBe('49');
    expect(produced.length).toBeLessThanOrEqual(2);
    expect(produced[produced.length - 1]).toBe(49);
  });

  it('sequential writes land in call order', async () => {
    const p = join(dir(), 'x.json');
    for (let i = 0; i < 5; i++) await writeFileAtomic(p, String(i));
    expect(readFileSync(p, 'utf8')).toBe('4');
  });

  it('a failed write rejects its callers, keeps the old file, and cleans up', async () => {
    const d = dir();
    const p = join(d, 'x.json');
    writeFileSync(p, 'old');
    await expect(
      writeFileAtomic(p, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(readFileSync(p, 'utf8')).toBe('old');
    // A rename onto a directory fails after the temp was written.
    const target = join(d, 'adir');
    mkdirSync(join(target, 'child'), { recursive: true });
    await expect(writeFileAtomic(target, 'x')).rejects.toBeTruthy();
    expect(readdirSync(d).sort()).toEqual(['adir', 'x.json']);
    // The path recovers for the next caller.
    await writeFileAtomic(p, 'new');
    expect(readFileSync(p, 'utf8')).toBe('new');
  });
});

describe('readJsonStore', () => {
  it('returns undefined quietly for a missing file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await readJsonStore(join(dir(), 'none.json'))).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('parses a good file', async () => {
    const p = join(dir(), 'x.json');
    writeFileSync(p, '{"a":1}');
    expect(await readJsonStore(p)).toEqual({ a: 1 });
  });

  it('warns about a corrupt file and moves it aside so the next save cannot erase it', async () => {
    const d = dir();
    const p = join(d, 'x.json');
    writeFileSync(p, '{"a":');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await readJsonStore(p)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const aside = readdirSync(d).filter((f) =>
        f.startsWith('x.json.corrupt-'),
      );
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(d, aside[0]!), 'utf8')).toBe('{"a":');
      expect(readdirSync(d)).not.toContain('x.json');
    } finally {
      warn.mockRestore();
    }
  });
});
