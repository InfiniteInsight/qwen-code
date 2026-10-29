/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  readDaemonModels,
  readDaemonModes,
  resolveDaemonModelArg,
} from './daemon-session-state.js';

const STATE = {
  models: {
    currentModelId: 'flint(openai)',
    availableModels: [
      { modelId: 'flint(openai)', name: 'flint', description: 'local' },
      { modelId: 'qwen3-coder(openai)', name: 'qwen3-coder' },
      { modelId: 'qwen3-coder(qwen-oauth)', name: 'qwen3-coder' },
      { nope: true },
    ],
  },
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'yolo', name: 'YOLO' },
      7,
    ],
  },
};

describe('readDaemonModels', () => {
  it('reads the current id and the usable entries', () => {
    const m = readDaemonModels(STATE);
    expect(m.currentModelId).toBe('flint(openai)');
    expect(m.availableModels.map((x) => x.modelId)).toEqual([
      'flint(openai)',
      'qwen3-coder(openai)',
      'qwen3-coder(qwen-oauth)',
    ]);
    expect(m.availableModels[0]).toMatchObject({
      name: 'flint',
      description: 'local',
    });
  });

  it('is empty for missing or malformed state', () => {
    for (const s of [undefined, null, {}, { models: 'x' }, { models: {} }]) {
      const m = readDaemonModels(s as never);
      expect(m.currentModelId).toBeUndefined();
      expect(m.availableModels).toEqual([]);
    }
  });
});

describe('readDaemonModes', () => {
  it('reads the current id and the usable entries', () => {
    const m = readDaemonModes(STATE);
    expect(m.currentModeId).toBe('default');
    expect(m.availableModes.map((x) => x.id)).toEqual(['default', 'yolo']);
  });

  it('is empty for missing state', () => {
    expect(readDaemonModes(undefined).currentModeId).toBeUndefined();
    expect(readDaemonModes({}).availableModes).toEqual([]);
  });
});

describe('resolveDaemonModelArg', () => {
  const { availableModels } = readDaemonModels(STATE);

  it('matches a full id exactly', () => {
    expect(resolveDaemonModelArg(availableModels, 'flint(openai)')).toEqual({
      kind: 'ok',
      modelId: 'flint(openai)',
    });
  });

  it('matches a bare name when it is unique', () => {
    expect(resolveDaemonModelArg(availableModels, 'flint')).toEqual({
      kind: 'ok',
      modelId: 'flint(openai)',
    });
  });

  it('reports an ambiguous bare name', () => {
    const r = resolveDaemonModelArg(availableModels, 'qwen3-coder');
    expect(r.kind).toBe('ambiguous');
  });

  it('reports an unknown model', () => {
    expect(resolveDaemonModelArg(availableModels, 'nope').kind).toBe('unknown');
  });
});
