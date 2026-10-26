/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecentTurns, readSessionModel } from './transcriptTail.js';

const SID = '00000000-0000-0000-0000-000000000001';

/** Build one JSONL transcript record line. */
function rec(type: string, text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    uuid: `u-${Math.abs(hash(text))}`,
    sessionId: SID,
    type,
    message: { parts: [{ text }] },
    ...extra,
  });
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-tail-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeTranscript(lines: string[]): Promise<void> {
  await writeFile(join(dir, `${SID}.jsonl`), lines.join('\n') + '\n', 'utf8');
}

describe('readRecentTurns', () => {
  it('returns user/assistant turns in order, skipping tool/system records', async () => {
    await writeTranscript([
      rec('system', 'boot'),
      rec('user', 'fix the login bug'),
      rec('tool_result', 'a huge tool dump'),
      rec('assistant', 'done, the null check was missing'),
    ]);
    expect(await readRecentTurns(dir, SID)).toEqual([
      { role: 'user', text: 'fix the login bug' },
      { role: 'assistant', text: 'done, the null check was missing' },
    ]);
  });

  it('keeps only the LAST maxTurns (newest-biased), preserving order', async () => {
    await writeTranscript([
      rec('user', 'one'),
      rec('assistant', 'two'),
      rec('user', 'three'),
      rec('assistant', 'four'),
    ]);
    expect(await readRecentTurns(dir, SID, { maxTurns: 2 })).toEqual([
      { role: 'user', text: 'three' },
      { role: 'assistant', text: 'four' },
    ]);
  });

  it('collapses whitespace and ellipsis-truncates at maxTextLen', async () => {
    await writeTranscript([
      rec('user', 'a  \n\t  b    c'),
      rec('user', 'x'.repeat(50)),
    ]);
    const out = await readRecentTurns(dir, SID, { maxTextLen: 10 });
    expect(out[0]).toEqual({ role: 'user', text: 'a b c' });
    expect(out[1].text).toBe('x'.repeat(9) + '…');
    expect(out[1].text.length).toBe(10);
  });

  it('skips records whose searchable text is empty', async () => {
    await writeTranscript([rec('user', '   '), rec('assistant', 'real')]);
    expect(await readRecentTurns(dir, SID)).toEqual([
      { role: 'assistant', text: 'real' },
    ]);
  });

  it('bounded tail: a turn before the byte window is not returned, no crash on the partial leading line', async () => {
    // A big assistant turn, then two small turns. With a tiny maxBytes only the
    // tail is read; the leading (now-partial) line must be dropped cleanly.
    await writeTranscript([
      rec('assistant', 'Z'.repeat(20000)),
      rec('user', 'tail-one'),
      rec('assistant', 'tail-two'),
    ]);
    // 600-byte window holds both small tail records in full plus the partial
    // tail of the 20 KB record, which is dropped as the (partial) leading line.
    const out = await readRecentTurns(dir, SID, { maxBytes: 600 });
    expect(out).toEqual([
      { role: 'user', text: 'tail-one' },
      { role: 'assistant', text: 'tail-two' },
    ]);
  });

  it('returns [] for a missing file', async () => {
    expect(await readRecentTurns(dir, SID)).toEqual([]);
  });

  it('returns [] for an empty file', async () => {
    await writeFile(join(dir, `${SID}.jsonl`), '', 'utf8');
    expect(await readRecentTurns(dir, SID)).toEqual([]);
  });

  it('returns [] for an invalid (path-traversal) session id without touching disk', async () => {
    expect(await readRecentTurns(dir, '../etc/passwd')).toEqual([]);
  });

  it('skips corrupt JSONL lines rather than throwing', async () => {
    await writeTranscript([
      rec('user', 'good'),
      '{ not json',
      rec('assistant', 'also good'),
    ]);
    expect(await readRecentTurns(dir, SID)).toEqual([
      { role: 'user', text: 'good' },
      { role: 'assistant', text: 'also good' },
    ]);
  });
});

describe('readSessionModel', () => {
  it('returns the model of the LAST assistant record (newest-biased)', async () => {
    await writeTranscript([
      rec('user', 'first', { model: 'stale-model' }),
      rec('assistant', 'a1', { model: 'first-model' }),
      rec('system', 'switched', { model: 'not-a-turn' }),
      rec('assistant', 'a2', { model: 'current-model' }),
      rec('tool_result', 'dump', { model: 'also-ignored' }),
    ]);
    expect(await readSessionModel(dir, SID)).toBe('current-model');
  });

  it('trims the stored model name', async () => {
    await writeTranscript([
      rec('assistant', 'a', { model: '  spaced-model  ' }),
    ]);
    expect(await readSessionModel(dir, SID)).toBe('spaced-model');
  });

  it('returns null when no assistant record carries a model', async () => {
    await writeTranscript([
      rec('user', 'u', { model: 'user-record-has-no-model-field' }),
      rec('assistant', 'a'),
    ]);
    expect(await readSessionModel(dir, SID)).toBeNull();
  });

  it('returns null for a missing file, an empty file, and an invalid id', async () => {
    expect(await readSessionModel(dir, SID)).toBeNull();
    await writeFile(join(dir, `${SID}.jsonl`), '', 'utf8');
    expect(await readSessionModel(dir, SID)).toBeNull();
    expect(await readSessionModel(dir, '../etc/passwd')).toBeNull();
  });

  it('skips corrupt lines and blank model values rather than throwing', async () => {
    await writeTranscript([
      '{ not json',
      rec('assistant', 'a', { model: 'good-model' }),
      rec('assistant', 'b', { model: '   ' }),
    ]);
    expect(await readSessionModel(dir, SID)).toBe('good-model');
  });

  it('a model pushed out of the byte window yields null, no crash', async () => {
    const pad = 'x'.repeat(4000);
    await writeTranscript([
      rec('assistant', 'early', { model: 'out-of-window' }),
      rec('user', pad),
    ]);
    expect(await readSessionModel(dir, SID, { maxBytes: 200 })).toBeNull();
  });
});
