/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { activeBranch } from './activeBranch.js';

const rec = (uuid: string, parentUuid: string | null, type = 'user') => ({
  uuid,
  parentUuid,
  type,
});

describe('activeBranch', () => {
  it('returns a linear transcript unchanged', () => {
    const rs = [rec('a', null), rec('b', 'a', 'assistant'), rec('c', 'b')];
    const out = activeBranch(rs);
    expect(out.records).toEqual(rs);
    expect(out.indices).toEqual([0, 1, 2]);
  });

  it('drops the abandoned branch a rewind leaves and keeps raw indices', () => {
    const rs = [
      rec('u0', null),
      rec('a0', 'u0', 'assistant'),
      rec('u1', 'a0'),
      rec('a1', 'u1', 'assistant'),
      { ...rec('rw', 'a0', 'system'), subtype: 'rewind' },
      rec('u1b', 'rw'),
    ];
    const out = activeBranch(rs);
    expect(out.records.map((r) => r['uuid'])).toEqual([
      'u0',
      'a0',
      'rw',
      'u1b',
    ]);
    expect(out.indices).toEqual([0, 1, 4, 5]);
  });

  it('handles two stacked rewinds', () => {
    const rs = [
      rec('u0', null),
      rec('a0', 'u0', 'assistant'),
      rec('u1', 'a0'),
      { ...rec('rw1', 'a0', 'system'), subtype: 'rewind' },
      rec('u1b', 'rw1'),
      { ...rec('rw2', 'u0', 'system'), subtype: 'rewind' },
      rec('u0c', 'rw2'),
    ];
    expect(activeBranch(rs).records.map((r) => r['uuid'])).toEqual([
      'u0',
      'rw2',
      'u0c',
    ]);
  });

  it('keeps records that carry no uuid', () => {
    const rs = [{ type: 'fork' }, rec('a', null), rec('b', 'a')];
    expect(activeBranch(rs).records).toHaveLength(3);
  });

  it('falls back to the input on a broken chain or a cycle', () => {
    const gap = [rec('a', 'missing'), rec('b', 'a')];
    expect(activeBranch(gap).records).toHaveLength(2);
    const cyc = [rec('a', 'b'), rec('b', 'a')];
    expect(activeBranch(cyc).records).toHaveLength(2);
  });

  it('records without a parentUuid key carry no chain: unchanged', () => {
    const rs = [
      { uuid: 'a', type: 'user' },
      { uuid: 'b', type: 'assistant' },
    ];
    expect(activeBranch(rs).records).toHaveLength(2);
  });

  it('an artifact record at the tail is not mistaken for the leaf', () => {
    const rs = [
      rec('u0', null),
      rec('a0', 'u0', 'assistant'),
      { ...rec('art', null, 'system'), subtype: 'session_artifact_event' },
    ];
    expect(activeBranch(rs).records).toHaveLength(3);
  });
});
