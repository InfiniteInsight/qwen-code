/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { scrubSecrets } from './scrub.js';

describe('scrubSecrets', () => {
  it('removes the token from a git URL in an error line', () => {
    const line =
      'fatal: could not read from https://x-access-token:ghp_abc@github.com/o/n.git';
    const out = scrubSecrets(line, ['ghp_abc']);
    expect(out).not.toContain('ghp_abc');
    expect(out).not.toContain('x-access-token:');
    expect(out).toBe(
      'fatal: could not read from https://***github.com/o/n.git',
    );
  });

  it('removes an x-access-token credential it was not told about', () => {
    const out = scrubSecrets(
      'remote: https://x-access-token:gho_other@github.com/o/n.git',
      [],
    );
    expect(out).not.toContain('gho_other');
    expect(out).toBe('remote: https://***github.com/o/n.git');
  });

  it('removes a bare occurrence of a secret, every time it appears', () => {
    const out = scrubSecrets('token ghp_abc then ghp_abc again', ['ghp_abc']);
    expect(out).toBe('token *** then *** again');
  });

  it('removes an x-access-token credential cut off before its @', () => {
    const out = scrubSecrets('url https://x-access-token:gho_cut', []);
    expect(out).not.toContain('gho_cut');
  });

  it('scrubs the longer of two overlapping secrets whole', () => {
    const out = scrubSecrets('abcdef', ['abc', 'abcdef']);
    expect(out).toBe('***');
  });

  it('treats a secret as text, not a pattern', () => {
    expect(scrubSecrets('a.c abc', ['a.c'])).toBe('*** abc');
  });

  it('ignores an empty secret and leaves other text alone', () => {
    expect(scrubSecrets('Cloning into dest...', ['', 'ghp_abc'])).toBe(
      'Cloning into dest...',
    );
  });
});
