/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { UsageStore } from './usageStore.js';
import { parseRateTable } from './rateTable.js';
import {
  repriceUsage,
  parseRepriceArgs,
  createTranscriptModelResolver,
  formatRepriceReport,
} from './usageReprice.js';

const RATES = parseRateTable(`
currencyLabel: USD
defaultModelServiceId: qwen
models:
  - modelServiceId: qwen
    modelId: flint
    inputPerMTok: 100
    outputPerMTok: 400
    cachedReadPerMTok: 10
`);

let dir: string;
let dbPath: string;
let store: UsageStore;

/** Rows exactly as the pre-fix ingester wrote them. */
function seed(
  sessionId: string,
  over: Partial<Parameters<UsageStore['record']>[0]> = {},
) {
  store.record({
    sessionId,
    ts: 1000,
    tokensIn: 1000,
    tokensOut: 100,
    tokensCached: 600,
    costMicrocents: null,
    modelServiceId: 'qwen',
    modelId: '',
    attributionTokenId: 'tkn',
    subActor: null,
    stage: null,
    ...over,
  });
}

function dump() {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT session_id, model_id, cost_microcents, rate_key, rate_match
         FROM usage_events ORDER BY id`,
    )
    .all();
  db.close();
  return rows;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-reprice-'));
  dbPath = join(dir, 'usage.db');
  store = UsageStore.open(dbPath);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('repriceUsage', () => {
  const resolver = async (sid: string) =>
    ({ a: 'flint(openai)', b: 'unpriced-model(openai)' })[sid] ?? null;

  it('fills the model from the resolver and prices with cached tokens split out', async () => {
    seed('a');
    seed('a', { tokensCached: 0 });
    const r = await repriceUsage(store, RATES, resolver, { dryRun: false });
    // row 1: (1000-600)*100 + 100*400 + 600*10 ; row 2: 1000*100 + 100*400
    expect(dump()).toEqual([
      {
        session_id: 'a',
        model_id: 'flint(openai)',
        cost_microcents: 400 * 100 + 100 * 400 + 600 * 10,
        rate_key: 'qwen/flint',
        rate_match: 'stripped',
      },
      {
        session_id: 'a',
        model_id: 'flint(openai)',
        cost_microcents: 1000 * 100 + 100 * 400,
        rate_key: 'qwen/flint',
        rate_match: 'stripped',
      },
    ]);
    expect(r).toMatchObject({
      scanned: 2,
      modelFilled: 2,
      repriced: 2,
      stillUnpriced: 0,
      noModel: 0,
      updated: 2,
      dryRun: false,
    });
  });

  it('reports but does not write on a dry run', async () => {
    seed('a');
    const before = dump();
    const r = await repriceUsage(store, RATES, resolver, { dryRun: true });
    expect(dump()).toEqual(before);
    expect(r).toMatchObject({
      scanned: 1,
      modelFilled: 1,
      repriced: 1,
      wouldUpdate: 1,
      updated: 0,
      dryRun: true,
    });
  });

  it('keeps a filled model id but a null cost when the rate table has no entry', async () => {
    seed('b');
    const r = await repriceUsage(store, RATES, resolver, { dryRun: false });
    expect(dump()[0]).toMatchObject({
      model_id: 'unpriced-model(openai)',
      cost_microcents: null,
    });
    expect(r).toMatchObject({ modelFilled: 1, repriced: 0, stillUnpriced: 1 });
    // A second pass finds nothing new to write for the still-unpriced row.
    const again = await repriceUsage(store, RATES, resolver, { dryRun: false });
    expect(again).toMatchObject({
      stillUnpriced: 1,
      wouldUpdate: 0,
      updated: 0,
    });
  });

  it('leaves rows alone when the session has no resolvable model', async () => {
    seed('zzz');
    const r = await repriceUsage(store, RATES, resolver, { dryRun: false });
    expect(dump()[0]).toMatchObject({ model_id: '', cost_microcents: null });
    expect(r).toMatchObject({ noModel: 1, updated: 0 });
  });

  it('reprices a row that already has a model id but a null cost (suffix match now applies)', async () => {
    seed('a', { modelId: 'flint(openai)' });
    const r = await repriceUsage(store, RATES, async () => null, {
      dryRun: false,
    });
    expect(dump()[0]).toMatchObject({
      model_id: 'flint(openai)',
      rate_match: 'stripped',
    });
    expect(r).toMatchObject({ modelFilled: 0, repriced: 1, updated: 1 });
  });

  it('asks the resolver once per session', async () => {
    seed('a');
    seed('a');
    seed('a');
    let calls = 0;
    await repriceUsage(
      store,
      RATES,
      async () => {
        calls++;
        return 'flint';
      },
      { dryRun: true },
    );
    expect(calls).toBe(1);
  });

  it('is a no-op the second time', async () => {
    seed('a');
    await repriceUsage(store, RATES, resolver, { dryRun: false });
    const r2 = await repriceUsage(store, RATES, resolver, { dryRun: false });
    expect(r2).toMatchObject({ scanned: 0, updated: 0 });
  });
});

describe('parseRepriceArgs', () => {
  it('defaults to a real run on the default db', () => {
    expect(parseRepriceArgs([])).toEqual({
      dryRun: false,
      dbPath: undefined,
      chatsDir: undefined,
    });
  });
  it('reads --dry-run, --db and --chats-dir (both flag forms)', () => {
    expect(
      parseRepriceArgs(['--dry-run', '--db', '/x/u.db', '--chats-dir=/c']),
    ).toEqual({ dryRun: true, dbPath: '/x/u.db', chatsDir: '/c' });
  });
});

describe('createTranscriptModelResolver', () => {
  const SID = '00000000-0000-0000-0000-0000000000aa';

  it('reads the model out of the session transcript wherever its project dir is', async () => {
    const runtime = join(dir, 'runtime');
    const chats = join(runtime, 'projects', '-some-proj', 'chats');
    mkdirSync(chats, { recursive: true });
    writeFileSync(
      join(chats, `${SID}.jsonl`),
      JSON.stringify({ type: 'assistant', model: 'flint(openai)' }) + '\n',
    );
    const resolve = createTranscriptModelResolver({
      env: { QWEN_RUNTIME_DIR: runtime },
    });
    expect(await resolve(SID)).toBe('flint(openai)');
    expect(await resolve('00000000-0000-0000-0000-0000000000bb')).toBeNull();
  });

  it('prefers an explicit chats dir', async () => {
    const chats = join(dir, 'chats');
    mkdirSync(chats, { recursive: true });
    writeFileSync(
      join(chats, `${SID}.jsonl`),
      JSON.stringify({ type: 'assistant', model: 'flint' }) + '\n',
    );
    const resolve = createTranscriptModelResolver({ chatsDir: chats, env: {} });
    expect(await resolve(SID)).toBe('flint');
  });
});

describe('formatRepriceReport', () => {
  const base = {
    scanned: 5,
    modelFilled: 4,
    repriced: 3,
    stillUnpriced: 1,
    noModel: 1,
    wouldUpdate: 4,
    updated: 0,
    dryRun: true,
  };
  it('says DRY RUN and what would change', () => {
    const t = formatRepriceReport(base);
    expect(t).toMatch(/DRY RUN/);
    expect(t).toMatch(/would change\s+4/);
  });
  it('reports the rows written on a real run', () => {
    const t = formatRepriceReport({ ...base, dryRun: false, updated: 4 });
    expect(t).not.toMatch(/DRY RUN/);
    expect(t).toMatch(/rows updated\s+4/);
  });
});
