/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bearerMatches,
  isLoopbackRemote,
  loadOrCreateLocalToken,
  readLocalToken,
} from './localCredential.js';
import { loadOrCreateHookIngestToken } from './agents/hookIngestToken.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-localcred-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadOrCreateLocalToken', () => {
  it('mints once at 0600 in a 0700 dir and returns the same token on reload', async () => {
    const path = join(dir, 'nested', 'host-attach-token');
    const t1 = await loadOrCreateLocalToken(path);
    const t2 = await loadOrCreateLocalToken(path);
    expect(t1).toBe(t2);
    expect(t1.length).toBeGreaterThanOrEqual(32);
    expect((await readFile(path, 'utf8')).trim()).toBe(t1);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600');
    expect(((await stat(join(dir, 'nested'))).mode & 0o777).toString(8)).toBe(
      '700',
    );
  });

  it('keeps a token that is already on disk', async () => {
    const path = join(dir, 'tok');
    await writeFile(path, 'preexisting-token\n', { mode: 0o600 });
    expect(await loadOrCreateLocalToken(path)).toBe('preexisting-token');
  });

  it('mints distinct tokens for distinct files', async () => {
    const a = await loadOrCreateLocalToken(join(dir, 'a'));
    const b = await loadOrCreateLocalToken(join(dir, 'b'));
    expect(a).not.toBe(b);
  });

  it('is what the hook ingest token loader still does', async () => {
    const path = join(dir, 'hook-ingest-token');
    const minted = await loadOrCreateHookIngestToken(path);
    expect(await loadOrCreateLocalToken(path)).toBe(minted);
  });
});

describe('readLocalToken', () => {
  it('reads a minted token without minting one', async () => {
    const path = join(dir, 'tok');
    const minted = await loadOrCreateLocalToken(path);
    expect(await readLocalToken(path)).toBe(minted);
  });

  it('answers undefined for a missing file and never creates it', async () => {
    const path = join(dir, 'missing');
    expect(await readLocalToken(path)).toBeUndefined();
    await expect(stat(path)).rejects.toThrow();
  });

  it('answers undefined for an empty file', async () => {
    const path = join(dir, 'empty');
    await writeFile(path, '  \n');
    expect(await readLocalToken(path)).toBeUndefined();
  });
});

describe('isLoopbackRemote', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.8.9.10', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['100.109.121.122', false],
    ['::ffff:10.0.0.2', false],
    ['', false],
    [undefined, false],
  ])('%s -> %s', (addr, want) => {
    expect(isLoopbackRemote(addr)).toBe(want);
  });
});

describe('bearerMatches', () => {
  it('accepts the exact bearer', () => {
    expect(bearerMatches('Bearer abc123', 'abc123')).toBe(true);
  });

  it('refuses a wrong, shorter, longer, missing or non-bearer value', () => {
    expect(bearerMatches('Bearer abc124', 'abc123')).toBe(false);
    expect(bearerMatches('Bearer abc12', 'abc123')).toBe(false);
    expect(bearerMatches('Bearer abc1234', 'abc123')).toBe(false);
    expect(bearerMatches(undefined, 'abc123')).toBe(false);
    expect(bearerMatches('Basic abc123', 'abc123')).toBe(false);
  });

  it('never matches an empty expected token', () => {
    expect(bearerMatches('Bearer ', '')).toBe(false);
  });
});
