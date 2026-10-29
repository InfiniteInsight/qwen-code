/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { SessionModelCache, modelIdFromContext } from './sessionModelCache.js';

describe('modelIdFromContext', () => {
  it('reads the current model out of the providers shape', () => {
    expect(
      modelIdFromContext({
        state: {
          models: {
            providers: [
              { models: [{ modelId: 'a', isCurrent: false }] },
              { models: [{ modelId: 'flint(openai)', isCurrent: true }] },
            ],
          },
        },
      }),
    ).toBe('flint(openai)');
  });
  it('reads currentModelId when state.models carries one', () => {
    expect(
      modelIdFromContext({ state: { models: { currentModelId: 'm1' } } }),
    ).toBe('m1');
  });
  it('reads current.modelId (what the daemon sends today)', () => {
    expect(
      modelIdFromContext({
        state: { models: { current: { modelId: 'flint(openai)' } } },
      }),
    ).toBe('flint(openai)');
  });
  it('reads a flat isCurrent list and availableModels', () => {
    expect(
      modelIdFromContext({
        state: {
          models: [{ modelId: 'x' }, { modelId: 'y', isCurrent: true }],
        },
      }),
    ).toBe('y');
    expect(
      modelIdFromContext({
        state: {
          models: { availableModels: [{ modelId: 'z', isCurrent: true }] },
        },
      }),
    ).toBe('z');
  });
  it('returns null for anything else', () => {
    expect(modelIdFromContext(null)).toBeNull();
    expect(modelIdFromContext({})).toBeNull();
    expect(modelIdFromContext({ state: { models: {} } })).toBeNull();
    expect(
      modelIdFromContext({ state: { models: { currentModelId: '' } } }),
    ).toBeNull();
  });
});

function make(
  over: {
    ctx?: (sid: string) => Promise<string | null>;
    tr?: (sid: string) => Promise<string | null>;
    now?: () => number;
    maxSessions?: number;
  } = {},
) {
  const calls = { ctx: 0, tr: 0 };
  const cache = new SessionModelCache({
    fromContext: async (sid) => {
      calls.ctx++;
      return over.ctx ? over.ctx(sid) : 'ctx-model';
    },
    fromTranscript: async (sid) => {
      calls.tr++;
      return over.tr ? over.tr(sid) : 'tr-model';
    },
    now: over.now ?? (() => 0),
    maxSessions: over.maxSessions,
  });
  return { cache, calls };
}

describe('SessionModelCache', () => {
  it('seeds from the daemon context and serves it synchronously afterwards', async () => {
    const { cache, calls } = make();
    expect(cache.get('s')).toBeUndefined();
    expect(await cache.ensure('s')).toBe('ctx-model');
    expect(cache.get('s')).toBe('ctx-model');
    await cache.ensure('s');
    expect(calls.ctx).toBe(1);
    expect(calls.tr).toBe(0);
  });

  it('shares one in-flight seed between concurrent callers', async () => {
    const { cache, calls } = make();
    await Promise.all([
      cache.ensure('s'),
      cache.ensure('s'),
      cache.ensure('s'),
    ]);
    expect(calls.ctx).toBe(1);
  });

  it('a model_switched value replaces the cached one', async () => {
    const { cache } = make();
    await cache.ensure('s');
    cache.set('s', 'switched');
    expect(cache.get('s')).toBe('switched');
  });

  it('a switch that lands while the seed is in flight wins over the seed result', async () => {
    let release!: (v: string) => void;
    const { cache } = make({
      ctx: () => new Promise<string>((r) => (release = r)),
    });
    const p = cache.ensure('s');
    cache.set('s', 'switched');
    release('stale-from-context');
    expect(await p).toBe('switched');
    expect(cache.get('s')).toBe('switched');
  });

  it('falls back to the transcript when the context read fails', async () => {
    const { cache, calls } = make({
      ctx: async () => {
        throw new Error('daemon down');
      },
    });
    expect(await cache.ensure('s')).toBe('tr-model');
    expect(calls.tr).toBe(1);
  });

  it('falls back to the transcript when the context names no model', async () => {
    const { cache } = make({ ctx: async () => null });
    expect(await cache.ensure('s')).toBe('tr-model');
  });

  it('resolves null when both sources fail, and does not retry inside the backoff', async () => {
    let t = 0;
    const { cache, calls } = make({
      ctx: async () => null,
      tr: async () => {
        throw new Error('no file');
      },
      now: () => t,
    });
    expect(await cache.ensure('s')).toBeNull();
    expect(await cache.ensure('s')).toBeNull();
    expect(calls.ctx).toBe(1);
    t = 31_000;
    await cache.ensure('s');
    expect(calls.ctx).toBe(2);
  });

  it('forget drops the entry so the next ensure re-seeds', async () => {
    const { cache, calls } = make();
    await cache.ensure('s');
    cache.forget('s');
    expect(cache.get('s')).toBeUndefined();
    await cache.ensure('s');
    expect(calls.ctx).toBe(2);
  });

  it('is bounded: the oldest session is evicted past maxSessions', async () => {
    const { cache } = make({ maxSessions: 2 });
    await cache.ensure('a');
    await cache.ensure('b');
    await cache.ensure('c');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('ctx-model');
    expect(cache.get('c')).toBe('ctx-model');
  });
});
