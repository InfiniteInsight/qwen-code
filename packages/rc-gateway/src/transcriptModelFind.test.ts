/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #138: find in conversation. The matcher runs on the model's `items[]`, not on
// the DOM, so a row the virtualizer has not mounted is found too. These pin
// what is searched (and what is not), case, the order and shape of the hits,
// and that the hit list follows the list as rows arrive.

import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

interface Item {
  id: number;
  kind: string;
  text?: string;
  label?: string;
  expanded?: boolean;
  input?: unknown;
  result?: unknown;
}
interface Hit {
  item: Item;
  id: number;
  index: number;
  fields: string[];
  count: number;
}
interface Model {
  items: Item[];
  addUser(text: string, time?: number): Item;
  addUserPart(part: unknown): { item: Item; merged: boolean };
  appendAssistant(text: string): void;
  appendThought(text: string): void;
  finishThought(): void;
  addSystem(text: string, err?: boolean): void;
  setPlan(entries: unknown[]): void;
  upsertTool(u: Record<string, unknown>): void;
  touch(item: Item): void;
  search(query: string): Hit[];
  cutAtUserTurn(keep: number): boolean;
  subscribe(fn: (ev: { type: string }) => void): () => void;
}
interface Api {
  createTranscriptModel(opts?: { now?: () => number }): Model;
  searchItems(items: Item[], query: string): Hit[];
  searchNeedle(query: unknown): string;
}

let api: Api;
beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  await import(
    pathToFileURL(join(here, '..', 'public', 'transcript-model.js')).href
  );
  api = (globalThis as unknown as { TranscriptModel: Api }).TranscriptModel;
});

function ids(hits: Hit[]): number[] {
  return hits.map((h) => h.index);
}

describe('searchItems: what is searched', () => {
  it('finds the words of a user message and of an assistant message', () => {
    const m = api.createTranscriptModel();
    m.addUser('please fix the flaky build');
    m.appendAssistant('The build fails because of a stale lockfile.');
    const hits = m.search('build');
    expect(ids(hits)).toEqual([0, 1]);
    expect(hits[0]!.fields).toEqual(['text']);
    expect(hits[1]!.item.kind).toBe('asst');
  });

  it('is case-insensitive in both directions', () => {
    const m = api.createTranscriptModel();
    m.addUser('Check the README');
    m.appendAssistant('readme looks fine, ReadMe too');
    expect(ids(m.search('readme'))).toEqual([0, 1]);
    expect(ids(m.search('README'))).toEqual([0, 1]);
    expect(ids(m.search('rEaDmE'))).toEqual([0, 1]);
  });

  it('counts a row once however many times it matches, and says how many', () => {
    const m = api.createTranscriptModel();
    m.addUser('x');
    m.appendAssistant('ab ab ab');
    const hits = m.search('ab');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.count).toBe(3);
  });

  it('searches a thought only once it is expanded', () => {
    let t = 1000;
    const m = api.createTranscriptModel({ now: () => (t += 500) });
    m.addUser('q');
    m.appendThought('weighing the zebra option');
    m.finishThought();
    const thought = m.items.find((i) => i.kind === 'thought')!;
    expect(m.search('zebra')).toHaveLength(0);
    thought.expanded = true;
    m.touch(thought);
    expect(m.search('zebra').map((h) => h.item)).toEqual([thought]);
    thought.expanded = false;
    expect(m.search('zebra')).toHaveLength(0);
  });

  it('searches a tool by its title, not by its status or its call and result', () => {
    const m = api.createTranscriptModel();
    m.upsertTool({
      toolCallId: 't1',
      title: 'Read package.json',
      status: 'completed',
      rawInput: { path: '/secret/needle.txt' },
      content: [{ type: 'content', content: { type: 'text', text: 'haystack needle' } }],
    });
    expect(ids(m.search('package'))).toEqual([0]);
    expect(m.search('completed')).toHaveLength(0);
    expect(m.search('needle')).toHaveLength(0);
    expect(m.search('haystack')).toHaveLength(0);
  });

  it('searches a tool call and result once the row is expanded', () => {
    const m = api.createTranscriptModel();
    m.upsertTool({
      toolCallId: 't1',
      title: 'Run command',
      status: 'completed',
      rawInput: { command: 'grep -r needle .' },
      content: [{ type: 'content', content: { type: 'text', text: 'src/a.ts: haystack' } }],
    });
    const tool = m.items[0]!;
    expect(tool.input).toBeDefined();
    tool.expanded = true;
    const byInput = m.search('grep -r');
    expect(byInput).toHaveLength(1);
    expect(byInput[0]!.fields).toEqual(['input']);
    const byResult = m.search('HAYSTACK');
    expect(byResult).toHaveLength(1);
    expect(byResult[0]!.fields).toEqual(['result']);
  });

  it('does not search system lines, plan rows or the fork row', () => {
    const m = api.createTranscriptModel();
    m.addUser('hello');
    m.appendAssistant('hi');
    m.addSystem('reconnected zulu');
    m.setPlan([{ content: 'write zulu tests', status: 'pending' }]);
    expect(m.search('zulu')).toHaveLength(0);
  });

  it('finds an attachment by its file name on the message that carries it', () => {
    const m = api.createTranscriptModel();
    m.addUser('here you go');
    m.addUserPart({ kind: 'file', name: 'budget-2026.csv', mimeType: 'text/csv', size: 10 });
    const hits = m.search('budget');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.fields).toEqual(['part']);
  });
});

describe('searchItems: the query and the order', () => {
  it('returns hits in list order with the index of each row', () => {
    const m = api.createTranscriptModel();
    for (let i = 0; i < 6; i++) {
      m.addUser(i % 2 ? `odd ${i}` : `even ${i}`);
      m.appendAssistant(`answer ${i}`);
    }
    const hits = m.search('odd');
    expect(ids(hits)).toEqual([2, 6, 10]);
    expect(hits.map((h) => m.items[h.index]!.id)).toEqual(hits.map((h) => h.id));
    const all = m.search('answer');
    expect(ids(all)).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it('is empty for an empty or blank query, and ignores the space a keyboard adds', () => {
    const m = api.createTranscriptModel();
    m.addUser('alpha beta');
    expect(m.search('')).toEqual([]);
    expect(m.search('   ')).toEqual([]);
    expect(m.search(undefined as unknown as string)).toEqual([]);
    expect(ids(m.search('alpha '))).toEqual([0]);
    expect(api.searchNeedle('  AbC ')).toBe('abc');
  });

  it('keeps a space inside the query', () => {
    const m = api.createTranscriptModel();
    m.addUser('alpha beta');
    m.addUser('alphabeta');
    expect(ids(m.search('alpha beta'))).toEqual([0]);
  });

  it('treats the query as text, not as a pattern', () => {
    const m = api.createTranscriptModel();
    m.addUser('a.c and a+c and (x)');
    expect(m.search('a.c')[0]!.count).toBe(1);
    expect(m.search('a+c')).toHaveLength(1);
    expect(m.search('(x)')).toHaveLength(1);
    expect(m.search('.*')).toHaveLength(0);
  });

  it('works on a bare array of items, the way the page and a test can call it', () => {
    const m = api.createTranscriptModel();
    m.addUser('one two');
    expect(api.searchItems(m.items, 'two')).toHaveLength(1);
    expect(api.searchItems(m.items, 'three')).toHaveLength(0);
    expect(api.searchItems([], 'two')).toHaveLength(0);
  });
});

describe('searchItems: the hit list follows the list', () => {
  it('finds a row that arrives after the search, in its place', () => {
    const m = api.createTranscriptModel();
    m.addUser('deploy it');
    m.appendAssistant('deployed');
    expect(m.search('deploy')).toHaveLength(2);
    m.addUser('and deploy again');
    const hits = m.search('deploy');
    expect(ids(hits)).toEqual([0, 1, 2]);
  });

  it('follows an assistant message as it streams in', () => {
    const m = api.createTranscriptModel();
    m.addUser('q');
    m.appendAssistant('the answer is in the ');
    expect(m.search('lockfile')).toHaveLength(0);
    m.appendAssistant('lockfile');
    expect(ids(m.search('lockfile'))).toEqual([1]);
  });

  it('drops the rows a rewind cuts', () => {
    const m = api.createTranscriptModel();
    m.addUser('first marker');
    m.appendAssistant('ok');
    m.addUser('second marker');
    m.appendAssistant('ok');
    expect(m.search('marker')).toHaveLength(2);
    m.cutAtUserTurn(1);
    expect(m.search('marker')).toHaveLength(1);
  });

  it('tells subscribers about the rows, so a page can refresh its hits on an event', () => {
    const m = api.createTranscriptModel();
    const seen: string[] = [];
    m.subscribe((ev) => seen.push(ev.type));
    m.addUser('x');
    expect(seen).toContain('append');
  });
});
