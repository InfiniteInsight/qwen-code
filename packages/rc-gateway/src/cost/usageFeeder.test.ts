/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { SessionModelCache } from './sessionModelCache.js';
import { UsageFeeder } from './usageFeeder.js';
import type { IngestOptions, UsageAttribution } from './ingester.js';

const usageData = (tag: string) => ({
  sessionId: 's1',
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { text: tag },
    _meta: { usage: { inputTokens: 10, outputTokens: 5 } },
  },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(
  over: {
    ctx?: (sid: string) => Promise<string | null>;
    tr?: (sid: string) => Promise<string | null>;
    maxQueue?: number;
  } = {},
) {
  let t = 100;
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const ingested: Array<{
    sid: string;
    tag: string;
    attr: UsageAttribution;
    opts: IngestOptions;
  }> = [];
  const unresolved: Array<[string, number]> = [];
  const attr = { current: 'tkn-1' };
  const cache = new SessionModelCache({
    fromContext: over.ctx ?? (async () => 'ctx-model'),
    fromTranscript: over.tr ?? (async () => null),
    now: () => t,
  });
  const feeder = new UsageFeeder({
    cache,
    ingester: {
      ingest: (sid, data, a, opts) => {
        const tag = (data as { update: { content: { text: string } } }).update
          .content.text;
        ingested.push({ sid, tag, attr: a, opts: opts ?? {} });
        return 0;
      },
    },
    attributionFor: () => ({
      attributionTokenId: attr.current,
      subActor: null,
    }),
    now: () => t,
    maxWaitMs: 5000,
    maxQueuePerSession: over.maxQueue ?? 64,
    schedule: (fn, ms) => {
      const h = { fn, ms, live: true };
      timers.push(h);
      return h;
    },
    cancel: (h) => {
      (h as { live: boolean }).live = false;
    },
    onUnresolved: (sid, n) => unresolved.push([sid, n]),
  });
  return {
    feeder,
    cache,
    ingested,
    unresolved,
    attr,
    advance: (ms: number) => (t += ms),
    fireTimers: () => timers.filter((x) => x.live).forEach((x) => x.fn()),
  };
}

describe('UsageFeeder', () => {
  it('ingests straight away once the model is known', async () => {
    const h = setup();
    h.cache.set('s1', 'flint(openai)');
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('a') });
    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0].opts.modelId).toBe('flint(openai)');
  });

  it('queues a usage frame until the seed resolves, then flushes it with the id', async () => {
    let release!: (v: string) => void;
    const h = setup({ ctx: () => new Promise((r) => (release = r)) });
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('a') });
    expect(h.ingested).toHaveLength(0);
    release('ctx-model');
    await flush();
    expect(h.ingested.map((i) => [i.tag, i.opts.modelId])).toEqual([
      ['a', 'ctx-model'],
    ]);
  });

  it('keeps arrival order, arrival time and arrival attribution for queued frames', async () => {
    let release!: (v: string) => void;
    const h = setup({ ctx: () => new Promise((r) => (release = r)) });
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('a') });
    h.advance(10);
    h.attr.current = 'tkn-2';
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('b') });
    h.advance(10);
    release('m');
    await flush();
    expect(h.ingested.map((i) => i.tag)).toEqual(['a', 'b']);
    expect(h.ingested.map((i) => i.opts.ts)).toEqual([100, 110]);
    expect(h.ingested.map((i) => i.attr.attributionTokenId)).toEqual([
      'tkn-1',
      'tkn-2',
    ]);
  });

  it('seeds on first sight of a session even from a non-usage frame', async () => {
    const h = setup();
    expect(h.cache.get('s1')).toBeUndefined();
    h.feeder.onEvent('s1', { type: 'agent_thought', data: {} });
    await flush();
    expect(h.cache.get('s1')).toBe('ctx-model');
    expect(h.ingested).toHaveLength(0);
  });

  it('a model_switched frame updates the model used for later usage', async () => {
    const h = setup();
    h.cache.set('s1', 'old');
    h.feeder.onEvent('s1', {
      type: 'model_switched',
      data: { sessionId: 's1', modelId: 'new(openai)' },
    });
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('a') });
    expect(h.ingested[0].opts.modelId).toBe('new(openai)');
  });

  it('a model_switched frame also seeds a session the cache had not seen', () => {
    const h = setup();
    h.feeder.onEvent('s1', {
      type: 'model_switched',
      data: { sessionId: 's1', modelId: 'new' },
    });
    expect(h.cache.get('s1')).toBe('new');
  });

  it('ignores a malformed model_switched', () => {
    const h = setup();
    h.cache.set('s1', 'old');
    h.feeder.onEvent('s1', { type: 'model_switched', data: { modelId: 7 } });
    expect(h.cache.get('s1')).toBe('old');
  });

  it('falls back to the transcript model when the context read fails', async () => {
    const h = setup({
      ctx: async () => {
        throw new Error('down');
      },
      tr: async () => 'from-transcript',
    });
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('a') });
    await flush();
    expect(h.ingested[0].opts.modelId).toBe('from-transcript');
  });

  it('writes the queued frames unpriced and audits ONCE when no source names a model', async () => {
    const h = setup({ ctx: async () => null, tr: async () => null });
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('a') });
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('b') });
    await flush();
    expect(h.ingested.map((i) => [i.tag, i.opts.modelId])).toEqual([
      ['a', ''],
      ['b', ''],
    ]);
    expect(h.unresolved).toEqual([['s1', 2]]);
  });

  it('gives up waiting after maxWaitMs, flushing unpriced with one audit', async () => {
    const h = setup({ ctx: () => new Promise(() => {}) }); // hangs forever
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('a') });
    expect(h.ingested).toHaveLength(0);
    h.fireTimers();
    expect(h.ingested.map((i) => [i.tag, i.opts.modelId])).toEqual([['a', '']]);
    expect(h.unresolved).toEqual([['s1', 1]]);
  });

  it('a flush cancels the timeout so nothing is reported twice', async () => {
    const h = setup();
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('a') });
    await flush();
    h.fireTimers();
    expect(h.ingested).toHaveLength(1);
    expect(h.unresolved).toEqual([]);
  });

  it('bounds the queue: overflow flushes the oldest frame unpriced', async () => {
    const h = setup({ ctx: () => new Promise(() => {}), maxQueue: 2 });
    for (const tag of ['a', 'b', 'c']) {
      h.feeder.onEvent('s1', { type: 'session_update', data: usageData(tag) });
    }
    expect(h.ingested.map((i) => [i.tag, i.opts.modelId])).toEqual([['a', '']]);
    expect(h.unresolved).toEqual([['s1', 1]]);
  });

  it('does not let a new frame jump ahead of frames still queued', async () => {
    let release!: (v: string) => void;
    const h = setup({ ctx: () => new Promise((r) => (release = r)) });
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('a') });
    h.cache.set('s1', 'switched'); // becomes known while 'a' is still queued
    h.feeder.onEvent('s1', { type: 'session_update', data: usageData('b') });
    expect(h.ingested).toHaveLength(0);
    release('ignored');
    await flush();
    expect(h.ingested.map((i) => i.tag)).toEqual(['a', 'b']);
  });

  it('session_closed forgets the cached model', async () => {
    const h = setup();
    h.cache.set('s1', 'm');
    h.feeder.onEvent('s1', { type: 'session_closed', data: {} });
    expect(h.cache.get('s1')).toBeUndefined();
  });

  it('is a no-op for non-usage frames once seeded', async () => {
    const h = setup();
    h.cache.set('s1', 'm');
    h.feeder.onEvent('s1', {
      type: 'session_update',
      data: { update: { sessionUpdate: 'agent_message_chunk', _meta: {} } },
    });
    expect(h.ingested).toHaveLength(0);
  });
});
