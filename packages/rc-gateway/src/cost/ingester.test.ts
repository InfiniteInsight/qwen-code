/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractUsage,
  UsageTickCoalescer,
  UsageIngester,
  type UsageTick,
} from './ingester.js';
import { UsageStore } from './usageStore.js';
import { RateTableHolder, parseRateTable } from './rateTable.js';
import Database from 'better-sqlite3';

const RATES = `
currencyLabel: USD
defaultModelServiceId: qwen
models:
  - modelServiceId: qwen
    modelId: qwen3-coder-plus
    inputPerMTok: 200
    outputPerMTok: 800
    cachedReadPerMTok: 20
  - modelServiceId: qwen
    modelId: flint
    inputPerMTok: 100
    outputPerMTok: 400
    cachedReadPerMTok: 10
`;

// The runtime session_update frame shape: data.update._meta.usage.
const frame = (
  usage: Record<string, unknown>,
  meta: Record<string, unknown> = {},
) => ({
  sessionId: 'sess_1',
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { text: 'hi' },
    _meta: { usage, modelId: 'qwen3-coder-plus', ...meta },
  },
});

describe('extractUsage', () => {
  it('reads camelCase token fields and the model id', () => {
    const u = extractUsage(
      frame({ inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 10 }),
    );
    expect(u).toEqual({
      modelServiceId: undefined,
      modelId: 'qwen3-coder-plus',
      tokensIn: 1000,
      tokensOut: 500,
      tokensCached: 10,
      stage: null,
    });
  });

  it('tolerates snake_case token spellings', () => {
    const u = extractUsage(
      frame({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 1 }),
    );
    expect(u).toMatchObject({ tokensIn: 7, tokensOut: 3, tokensCached: 1 });
  });

  it('returns null when there is no usage block', () => {
    expect(
      extractUsage({ sessionId: 's', update: { content: {} } }),
    ).toBeNull();
    expect(extractUsage({ update: { _meta: {} } })).toBeNull();
    expect(extractUsage(null)).toBeNull();
  });

  it('returns null when all token counts are zero', () => {
    expect(extractUsage(frame({ inputTokens: 0, outputTokens: 0 }))).toBeNull();
  });

  it('ignores a usage block on a non-agent_message_chunk frame (no double-count)', () => {
    // A `result`-style frame also carrying usage must NOT be priced — only the
    // agent_message_chunk locus is, so one turn is never counted twice.
    const resultFrame = {
      sessionId: 's1',
      update: {
        sessionUpdate: 'result',
        _meta: { modelId: 'qwen3-coder-plus', usage: { input_tokens: 999 } },
      },
    };
    expect(extractUsage(resultFrame)).toBeNull();
  });

  it('captures modelServiceId and stage when present', () => {
    const u = extractUsage(
      frame({ inputTokens: 1 }, { modelServiceId: 'openai', stage: 'stage1' }),
    );
    expect(u).toMatchObject({ modelServiceId: 'openai', stage: 'stage1' });
  });

  it('reads the cached count off the key the live daemon actually emits', () => {
    // The shape createTranscriptUsageUpdate writes: cachedReadTokens, and NO
    // modelId in _meta (its placement is Qwen-Code-Remote#181, asserted here so a
    // change to either is visible). Every guard above uses the other spelling, so
    // none of them could see this key regress to 0.
    const u = extractUsage({
      sessionId: 's',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'hi' },
        _meta: {
          usage: { inputTokens: 900, outputTokens: 10, cachedReadTokens: 700 },
        },
      },
    });
    expect(u).toMatchObject({
      tokensIn: 900,
      tokensOut: 10,
      tokensCached: 700,
      modelId: '',
    });
  });
});

describe('UsageTickCoalescer', () => {
  function timers() {
    const armed: Array<{ fn: () => void; ms: number }> = [];
    return {
      armed,
      schedule: (fn: () => void, ms: number) => {
        armed.push({ fn, ms });
        return armed.length - 1;
      },
      cancel: () => {},
      fireAll: () => {
        const fns = armed.splice(0);
        for (const a of fns) a.fn();
      },
    };
  }

  const tick = (over: Partial<UsageTick> = {}): UsageTick => ({
    sessionId: 'sess_1',
    costMicrocentsSesTotal: 0,
    costMicrocentsPromptTotal: 0,
    tokensInTotal: 0,
    tokensOutTotal: 0,
    ...over,
  });

  it('collapses a burst into a single trailing emit with the latest totals', () => {
    const emitted: UsageTick[] = [];
    const t = timers();
    const c = new UsageTickCoalescer({
      emit: (x) => emitted.push(x),
      schedule: t.schedule,
      cancel: t.cancel,
    });
    for (let i = 1; i <= 10; i++) c.push(tick({ costMicrocentsSesTotal: i }));
    expect(t.armed).toHaveLength(1); // only one timer armed for the session
    t.fireAll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].costMicrocentsSesTotal).toBe(10); // latest wins
  });

  it('coalesces per session independently', () => {
    const emitted: UsageTick[] = [];
    const t = timers();
    const c = new UsageTickCoalescer({
      emit: (x) => emitted.push(x),
      schedule: t.schedule,
      cancel: t.cancel,
    });
    c.push(tick({ sessionId: 'a', costMicrocentsSesTotal: 1 }));
    c.push(tick({ sessionId: 'b', costMicrocentsSesTotal: 2 }));
    t.fireAll();
    expect(emitted.map((e) => e.sessionId).sort()).toEqual(['a', 'b']);
  });
});

describe('UsageIngester', () => {
  let dir: string;
  let store: UsageStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rc-ingest-'));
    store = UsageStore.open(join(dir, 'usage.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeIngester(
    over: {
      onRateMiss?: (
        service: string | undefined,
        model: string,
        sid: string,
      ) => void;
      now?: () => number;
    } = {},
  ) {
    const ticks: UsageTick[] = [];
    const coalescer = new UsageTickCoalescer({
      emit: (x) => ticks.push(x),
      schedule: (fn) => {
        fn(); // fire synchronously for assertions
        return 0;
      },
      cancel: () => {},
    });
    const ingester = new UsageIngester({
      rates: new RateTableHolder(parseRateTable(RATES)),
      store,
      coalescer,
      now: over.now ?? (() => 1234),
      onRateMiss: over.onRateMiss,
    });
    return { ingester, ticks };
  }

  it('prices a usage frame, writes a row, and emits a usage_tick (microcents)', () => {
    const { ingester, ticks } = makeIngester();
    // 1000 in * 200/MTok + 500 out * 800/MTok = 200000 + 400000 = 600000 microcents = 0.6 cents
    const MICRO = 1_000_000;
    const cost = ingester.ingest(
      'sess_1',
      frame({ inputTokens: 1000, outputTokens: 500 }),
      { attributionTokenId: 'tkn_abc', subActor: null },
    );
    expect(cost).toBe(Math.round(0.6 * MICRO));
    expect(store.sessionTotals('sess_1').costMicrocentsSesTotal).toBe(
      Math.round(0.6 * MICRO),
    );
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({
      sessionId: 'sess_1',
      costMicrocentsPromptTotal: Math.round(0.6 * MICRO),
    });
  });

  it('records the bridge sub-actor on the row', () => {
    const { ingester } = makeIngester();
    ingester.ingest('sess_1', frame({ inputTokens: 100 }), {
      attributionTokenId: 'tkn_brg',
      subActor: 'telegram:42',
    });
    const rows = store.aggregate({
      sinceMs: 0,
      untilMs: 9999,
      groupBy: 'sub_actor',
    });
    expect(rows.map((r) => r.key)).toContain('telegram:42');
  });

  it('writes a NULL cost and audits on a rate-table miss', () => {
    let missed = false;
    const { ingester } = makeIngester({ onRateMiss: () => (missed = true) });
    const cost = ingester.ingest(
      'sess_1',
      frame({ inputTokens: 1 }, { modelId: 'unknown-model' }),
      { attributionTokenId: 't', subActor: null },
    );
    expect(cost).toBeNull();
    expect(missed).toBe(true);
    expect(store.sessionTotals('sess_1').tokensInTotal).toBe(1); // row still written
  });

  // #190: the tick carries what a page needs to say `no price` instead of $0.
  it('a tick counts the rows of the session and the ones the rate table missed', () => {
    const { ingester, ticks } = makeIngester();
    ingester.ingest('sess_1', frame({ inputTokens: 1000, outputTokens: 500 }), {
      attributionTokenId: 't',
      subActor: null,
    });
    ingester.ingest(
      'sess_1',
      frame({ inputTokens: 1 }, { modelId: 'unknown-model' }),
      { attributionTokenId: 't', subActor: null },
    );
    expect(ticks[ticks.length - 1]).toMatchObject({
      sessionId: 'sess_1',
      eventsTotal: 2,
      unpricedEventsTotal: 1,
    });
  });

  it('is a no-op for a frame with no usage', () => {
    const { ingester, ticks } = makeIngester();
    const r = ingester.ingest(
      'sess_1',
      { update: { content: {} } },
      {
        attributionTokenId: 't',
        subActor: null,
      },
    );
    expect(r).toBeUndefined();
    expect(ticks).toHaveLength(0);
  });

  it('does not charge the cached tokens twice', () => {
    const { ingester } = makeIngester();
    const MICRO = 1_000_000;
    // 900 input of which 700 were cached reads: bill the 200 that were not at
    // input(200), the 700 at cachedRead(20), and 10 out at 800.
    // 200*200 + 700*20 + 10*800 = 40000 + 14000 + 8000 = 62000 microcents.
    // Charging the full 900 at input would give 202000, so this fails loudly.
    const cost = ingester.ingest(
      'sess_1',
      frame({ inputTokens: 900, outputTokens: 10, cachedReadTokens: 700 }),
      { attributionTokenId: 't', subActor: null },
    );
    expect(cost).toBe(Math.round(0.062 * MICRO));
    // The ROW still records what the model reported; only the price is net.
    expect(store.sessionTotals('sess_1').tokensInTotal).toBe(900);
  });

  it('clamps a frame that reports more cached than input instead of billing negative', () => {
    const { ingester } = makeIngester();
    const cost = ingester.ingest(
      'sess_1',
      frame({ inputTokens: 5, outputTokens: 0, cachedReadTokens: 9 }),
      { attributionTokenId: 't', subActor: null },
    );
    // pricedIn clamps to 0, leaving 9 * 20 = 180. Without the clamp the input
    // term is -4 * 200 = -800 and the row bills -620.
    expect(cost).toBe(180);
  });

  it('resets the prompt total on a prompt boundary but keeps the session total', () => {
    const { ingester, ticks } = makeIngester();
    const MICRO = 1_000_000;
    ingester.ingest('sess_1', frame({ inputTokens: 1000, outputTokens: 500 }), {
      attributionTokenId: 't',
      subActor: null,
    });
    ingester.notePromptBoundary('sess_1');
    ingester.ingest('sess_1', frame({ inputTokens: 1000, outputTokens: 500 }), {
      attributionTokenId: 't',
      subActor: null,
    });
    const last = ticks[ticks.length - 1];
    expect(last.costMicrocentsPromptTotal).toBe(Math.round(0.6 * MICRO)); // reset, just this prompt
    expect(last.costMicrocentsSesTotal).toBe(Math.round(1.2 * MICRO)); // both prompts
  });

  // The shape the live daemon really emits: usage only, NO model id in _meta.
  const liveFrame = (usage: Record<string, unknown>) => ({
    sessionId: 'sess_1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'hi' },
      _meta: { usage, timestamp: 1 },
    },
  });
  const ATTR = { attributionTokenId: 't', subActor: null };

  function rawRows() {
    const db = new Database(join(dir, 'usage.db'), { readonly: true });
    const rows = db
      .prepare(
        `SELECT model_id, tokens_cached, cost_microcents, rate_key, rate_match, ts
           FROM usage_events ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
    db.close();
    return rows;
  }

  describe('model id supplied by the session cache (#181)', () => {
    it('prices a live-shaped frame with the supplied id and stores it', () => {
      const { ingester } = makeIngester();
      const cost = ingester.ingest(
        'sess_1',
        liveFrame({ inputTokens: 1000, outputTokens: 500 }),
        ATTR,
        { modelId: 'qwen3-coder-plus' },
      );
      expect(cost).toBe(600_000);
      expect(rawRows()[0]).toMatchObject({
        model_id: 'qwen3-coder-plus',
        cost_microcents: 600_000,
        rate_key: 'qwen/qwen3-coder-plus',
        rate_match: 'exact',
      });
    });

    it('without any id the row is unpriced, as before', () => {
      const { ingester } = makeIngester();
      const cost = ingester.ingest(
        'sess_1',
        liveFrame({ inputTokens: 10 }),
        ATTR,
      );
      expect(cost).toBeNull();
      expect(rawRows()[0]).toMatchObject({
        model_id: '',
        cost_microcents: null,
      });
    });

    it('a model id carried by the frame itself wins over the supplied one', () => {
      const { ingester } = makeIngester();
      ingester.ingest('sess_1', frame({ inputTokens: 1000 }), ATTR, {
        modelId: 'flint',
      });
      expect(rawRows()[0]?.model_id).toBe('qwen3-coder-plus');
    });

    it('honours a ts captured when the frame arrived (queued events)', () => {
      const { ingester } = makeIngester({ now: () => 9_999 });
      ingester.ingest('sess_1', liveFrame({ inputTokens: 10 }), ATTR, {
        modelId: 'flint',
        ts: 42,
      });
      expect(rawRows()[0]?.ts).toBe(42);
    });
  });

  describe('cached tokens and the (provider) suffix, end to end', () => {
    it('stores cachedReadTokens and bills input minus cached at the input rate', () => {
      const { ingester } = makeIngester();
      // flint: in 100, out 400, cached 10. (1000-600)*100 + 100*400 + 600*10
      const cost = ingester.ingest(
        'sess_1',
        liveFrame({
          inputTokens: 1000,
          outputTokens: 100,
          totalTokens: 1100,
          cachedReadTokens: 600,
        }),
        ATTR,
        { modelId: 'flint(openai)' },
      );
      expect(cost).toBe(40_000 + 40_000 + 6_000);
      expect(rawRows()[0]).toMatchObject({
        tokens_cached: 600,
        model_id: 'flint(openai)',
        rate_key: 'qwen/flint',
        rate_match: 'stripped',
      });
    });
  });

  describe('rate_table_miss audit collapse', () => {
    it('reports once per (session, model) per hour', () => {
      let t = 0;
      const misses: Array<[string | undefined, string, string]> = [];
      const { ingester } = makeIngester({
        now: () => t,
        onRateMiss: (svc, m, sid) => misses.push([svc, m, sid]),
      });
      const go = (sid: string, model: string) =>
        ingester.ingest(sid, liveFrame({ inputTokens: 1 }), ATTR, {
          modelId: model,
        });
      go('a', 'ghost(openai)');
      go('a', 'ghost(openai)');
      go('a', 'ghost(openai)');
      expect(misses).toHaveLength(1);
      expect(misses[0]).toEqual([undefined, 'ghost(openai)', 'a']);
      go('b', 'ghost(openai)'); // other session
      go('a', 'other(openai)'); // other model
      expect(misses).toHaveLength(3);
      t = 59 * 60_000;
      go('a', 'ghost(openai)');
      expect(misses).toHaveLength(3);
      t = 61 * 60_000;
      go('a', 'ghost(openai)');
      expect(misses).toHaveLength(4);
    });

    it('still writes the unpriced row every time', () => {
      const { ingester } = makeIngester({ onRateMiss: () => {} });
      for (let i = 0; i < 3; i++) {
        ingester.ingest('a', liveFrame({ inputTokens: 1 }), ATTR, {
          modelId: 'ghost',
        });
      }
      expect(rawRows()).toHaveLength(3);
    });
  });
});
