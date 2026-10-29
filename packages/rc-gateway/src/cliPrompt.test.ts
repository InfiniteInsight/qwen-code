/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { askLine, confirmPrompt } from './cliPrompt.js';

function io() {
  const input = new PassThrough();
  const output = new PassThrough();
  return { input, output };
}

describe('askLine / confirmPrompt', () => {
  it('resolves the typed line', async () => {
    const i = io();
    const p = askLine('name? ', i);
    i.input.write('alice\n');
    await expect(p).resolves.toBe('alice');
  });

  it('confirmPrompt is true for y and yes, false for anything else', async () => {
    for (const [typed, want] of [
      ['y', true],
      ['YES', true],
      ['n', false],
      ['', false],
      ['maybe', false],
    ] as const) {
      const i = io();
      const p = confirmPrompt('ok? ', i);
      i.input.write(`${typed}\n`);
      await expect(p).resolves.toBe(want);
    }
  });

  it('rejects, rather than never resolving, when stdin closes with no answer', async () => {
    const i = io();
    const p = confirmPrompt('ok? ', i);
    i.input.end();
    await expect(p).rejects.toThrow(/stdin closed|--yes/);
  });

  it('rejects when stdin was already closed before the prompt', async () => {
    const i = io();
    i.input.end();
    await new Promise((r) => setImmediate(r));
    await expect(confirmPrompt('ok? ', i)).rejects.toThrow(/--yes/);
  });
});
