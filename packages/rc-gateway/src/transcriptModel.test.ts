/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// The model is a classic browser script (no module syntax); loading it in
// Node runs the IIFE, which assigns globalThis.TranscriptModel.
interface Sub {
  startedAt: number;
  endedAt: number | null;
  done: boolean;
  failed: boolean;
  type: string;
  text: string;
  tools: Array<{ id: string; label: string; status: string }>;
}
interface Item {
  id: number;
  kind: string;
  text?: string;
  startedAt?: number;
  live?: boolean;
  durLabel?: string | null;
  expanded?: boolean;
  toolCallId?: string;
  label?: string;
  status?: string;
  sub?: Sub | null;
  err?: boolean;
  turn?: number;
  mode?: string;
  note?: string;
  busy?: boolean;
}
interface Ev {
  type: 'append' | 'update' | 'reset';
  item?: Item;
}
interface Model {
  items: Item[];
  curAsst: Item | null;
  forkItem: Item | null;
  subscribe(fn: (ev: Ev) => void): () => void;
  addUser(text: string): void;
  appendAssistant(text: string): void;
  appendThought(text: string): void;
  finishThought(): void;
  addSystem(text: string, err?: boolean): void;
  upsertTool(u: Record<string, unknown>): void;
  setSubagentType(parentId: string, type: string): void;
  appendSubagentText(parentId: string, text: string): void;
  upsertSubagentTool(u: Record<string, unknown>, parentId: string): void;
  finishSubagent(parentId: string, status: string): void;
  settleAllSubagents(): void;
  resetTurn(): void;
  showProcessing(): void;
  hideProcessing(): void;
  placeFork(turn: number): void;
  clearFork(): void;
  userTurns(): Item[];
  cutAtUserTurn(keep: number): boolean;
  touch(item: Item): void;
  clear(): void;
}
interface Api {
  clean(t: unknown): string;
  createTranscriptModel(opts?: { now?: () => number }): Model;
}

let api: Api;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, '..', 'public', 'transcript-model.js');
  await import(pathToFileURL(file).href);
  api = (globalThis as unknown as { TranscriptModel: Api }).TranscriptModel;
});

function setup(): { m: Model; events: string[]; clock: { t: number } } {
  const clock = { t: 1000 };
  const m = api.createTranscriptModel({ now: () => clock.t });
  const events: string[] = [];
  m.subscribe((ev) => events.push(ev.type));
  return { m, events, clock };
}

describe('TranscriptModel', () => {
  it('clean strips control chars but keeps newline and tab', () => {
    expect(api.clean('a\x00b\x07c\x1bd\x7fe\nf\tg')).toBe('abcde\nf\tg');
    expect(api.clean(42)).toBe('');
    expect(api.clean(undefined)).toBe('');
  });

  it('appendAssistant coalesces chunks into one asst item and emits update after the first chunk', () => {
    const { m, events } = setup();
    m.appendAssistant('he');
    m.appendAssistant('l');
    m.appendAssistant('lo');
    expect(m.items.length).toBe(1);
    expect(m.items[0].kind).toBe('asst');
    expect(m.items[0].text).toBe('hello');
    expect(m.curAsst).toBe(m.items[0]);
    expect(events).toEqual(['append', 'update', 'update']);
  });

  it('appendThought then appendAssistant folds the thought', () => {
    const { m, clock } = setup();
    m.appendThought('hmm ');
    m.appendThought('ok');
    const thought = m.items[0];
    expect(thought.kind).toBe('thought');
    expect(thought.text).toBe('hmm ok');
    expect(thought.live).toBe(true);
    expect(thought.startedAt).toBe(1000);
    clock.t = 1400;
    m.appendAssistant('answer');
    expect(thought.live).toBe(false);
    expect(thought.expanded).toBe(false);
    expect(thought.durLabel).toBe('<1s');
    expect(m.items[1].kind).toBe('asst');
    expect(m.items[1].text).toBe('answer');
  });

  it('whitespace-only thought is removed on finish', () => {
    const { m, events } = setup();
    m.appendThought('  \n ');
    expect(m.items.length).toBe(1);
    m.finishThought();
    expect(m.items.length).toBe(0);
    expect(events).toEqual(['append', 'reset']);
  });

  it('thought duration labels', () => {
    const labels: Array<[number, string]> = [
      [400, '<1s'],
      [12000, '12s'],
      [75000, '1m15s'],
    ];
    for (const [ms, want] of labels) {
      const { m, clock } = setup();
      m.appendThought('x');
      clock.t += ms;
      m.finishThought();
      expect(m.items[0].durLabel).toBe(want);
    }
  });

  it('upsertTool keeps one item per toolCallId and keeps the first label on a status-only update', () => {
    const { m, events } = setup();
    m.upsertTool({ toolCallId: 't1', title: 'Read file', status: 'pending' });
    m.upsertTool({ toolCallId: 't1', status: 'in_progress' });
    expect(m.items.length).toBe(1);
    expect(m.items[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 't1',
      label: 'Read file',
      status: 'in_progress',
    });
    expect(events).toEqual(['append', 'update']);
    // kind is the fallback label, then the id, then 'tool'
    m.upsertTool({ toolCallId: 't2', kind: 'execute' });
    m.upsertTool({ toolCallId: 't3' });
    m.upsertTool({});
    expect(m.items.map((i) => i.label)).toEqual([
      'Read file',
      'execute',
      't3',
      'tool',
    ]);
  });

  it('upsertTool without a toolCallId always creates a new item', () => {
    const { m } = setup();
    m.upsertTool({ title: 'a' });
    m.upsertTool({ title: 'a' });
    expect(m.items.length).toBe(2);
    expect(m.items[0].id).not.toBe(m.items[1].id);
  });

  it('terminal tool status finishes its subagent', () => {
    const cases: Array<[string, boolean]> = [
      ['completed', false],
      ['failed', true],
      ['cancelled', false],
    ];
    for (const [status, failed] of cases) {
      const { m, clock } = setup();
      m.upsertTool({ toolCallId: 'p', title: 'Agent', status: 'in_progress' });
      m.appendSubagentText('p', 'working');
      const tool = m.items[0];
      expect(tool.sub?.done).toBe(false);
      clock.t = 5000;
      m.upsertTool({ toolCallId: 'p', status });
      expect(tool.sub?.done).toBe(true);
      expect(tool.sub?.failed).toBe(failed);
      expect(tool.sub?.endedAt).toBe(5000);
    }
    // a non-terminal status leaves it running
    const { m } = setup();
    m.upsertTool({ toolCallId: 'p', status: 'in_progress' });
    m.appendSubagentText('p', 'x');
    m.upsertTool({ toolCallId: 'p', status: 'in_progress' });
    expect(m.items[0].sub?.done).toBe(false);
  });

  it('subagent text and tools accumulate on the parent tool item; frames for an unknown parent are dropped; first subagent type wins', () => {
    const { m, events } = setup();
    m.upsertTool({ toolCallId: 'p', title: 'Agent', status: 'in_progress' });
    const tool = m.items[0];
    expect(tool.sub).toBeNull();
    m.setSubagentType('p', 'explorer');
    m.setSubagentType('p', 'other');
    m.setSubagentType('p', '');
    m.appendSubagentText('p', 'one ');
    m.appendSubagentText('p', 'two');
    m.upsertSubagentTool(
      { toolCallId: 'c1', title: 'Grep', status: 'pending' },
      'p',
    );
    m.upsertSubagentTool({ toolCallId: 'c1', status: 'completed' }, 'p');
    m.upsertSubagentTool({ title: 'noid' }, 'p');
    m.upsertSubagentTool({ title: 'noid' }, 'p');
    expect(tool.sub).toMatchObject({
      done: false,
      failed: false,
      type: 'explorer',
      text: 'one two',
    });
    expect(tool.sub?.startedAt).toBe(1000);
    expect(tool.sub?.tools).toEqual([
      { id: 'c1', label: 'Grep', status: 'completed' },
      { id: '', label: 'noid', status: '' },
      { id: '', label: 'noid', status: '' },
    ]);
    expect(m.items.length).toBe(1);

    const before = events.length;
    m.appendSubagentText('ghost', 'x');
    m.upsertSubagentTool({ toolCallId: 'c9', title: 'x' }, 'ghost');
    m.setSubagentType('ghost', 'x');
    m.finishSubagent('ghost', 'completed');
    expect(events.length).toBe(before);
    expect(m.items.length).toBe(1);
    // a type set before the first subagent frame is used when the sub is created
    m.upsertTool({ toolCallId: 'q', title: 'Agent' });
    m.setSubagentType('q', 'planner');
    m.appendSubagentText('q', 'hi');
    expect(m.items[1].sub?.type).toBe('planner');
  });

  it('settleAllSubagents finishes every running subagent as completed', () => {
    const { m } = setup();
    m.upsertTool({ toolCallId: 'a', title: 'Agent' });
    m.upsertTool({ toolCallId: 'b', title: 'Agent' });
    m.appendSubagentText('a', 'x');
    m.appendSubagentText('b', 'y');
    m.finishSubagent('b', 'failed');
    m.settleAllSubagents();
    expect(m.items[0].sub).toMatchObject({ done: true, failed: false });
    expect(m.items[1].sub).toMatchObject({ done: true, failed: true });
  });

  it('showProcessing adds one processing item at the end; addUser, addSystem and upsertTool remove it', () => {
    const { m } = setup();
    m.addUser('hi');
    m.showProcessing();
    m.showProcessing();
    expect(m.items.map((i) => i.kind)).toEqual(['user', 'processing']);
    expect(m.items[1].startedAt).toBe(1000);
    m.addUser('again');
    expect(m.items.map((i) => i.kind)).toEqual(['user', 'user']);
    m.showProcessing();
    m.addSystem('note', true);
    expect(m.items.map((i) => i.kind)).toEqual(['user', 'user', 'system']);
    expect(m.items[2]).toMatchObject({ text: 'note', err: true });
    m.showProcessing();
    m.upsertTool({ toolCallId: 't' });
    expect(m.items.map((i) => i.kind)).toEqual([
      'user',
      'user',
      'system',
      'tool',
    ]);
    m.showProcessing();
    m.hideProcessing();
    expect(m.items.length).toBe(4);
  });

  it('placeFork needs curAsst, is idempotent, and moves to the end when a newer asst appears', () => {
    const { m } = setup();
    m.placeFork(1);
    expect(m.items.length).toBe(0);
    expect(m.forkItem).toBeNull();

    m.addUser('q');
    m.appendAssistant('a1');
    m.placeFork(1);
    const fork = m.forkItem as Item;
    expect(fork).toMatchObject({
      kind: 'fork',
      turn: 1,
      mode: 'include',
      note: '',
      busy: false,
    });
    expect(m.items.map((i) => i.kind)).toEqual(['user', 'asst', 'fork']);
    m.placeFork(1);
    expect(m.forkItem).toBe(fork);
    expect(m.items.length).toBe(3);

    // tool call, then a newer assistant item: the row moves under it
    m.upsertTool({ toolCallId: 't' });
    m.appendAssistant('a2');
    expect(m.items.map((i) => i.kind)).toEqual([
      'user',
      'asst',
      'fork',
      'tool',
      'asst',
    ]);
    m.placeFork(1);
    expect(m.forkItem).toBe(fork);
    expect(m.items.map((i) => i.kind)).toEqual([
      'user',
      'asst',
      'tool',
      'asst',
      'fork',
    ]);

    // a different turn replaces the row
    m.placeFork(2);
    expect(m.forkItem).not.toBe(fork);
    expect(m.forkItem?.turn).toBe(2);
    expect(m.items.filter((i) => i.kind === 'fork').length).toBe(1);
    expect(m.items[m.items.length - 1]).toBe(m.forkItem);

    m.clearFork();
    expect(m.forkItem).toBeNull();
    expect(m.items.some((i) => i.kind === 'fork')).toBe(false);
  });

  it('userTurns lists user items in order', () => {
    const { m } = setup();
    m.addUser('one');
    m.appendAssistant('r');
    m.addUser('two');
    expect(m.userTurns().map((i) => i.text)).toEqual(['one', 'two']);
  });

  it('cutAtUserTurn(1) removes the second user turn and everything after; a later update with an old toolCallId creates a fresh tool item; returns true', () => {
    const { m, events } = setup();
    m.addUser('one');
    m.upsertTool({ toolCallId: 'old', title: 'Agent', status: 'in_progress' });
    m.appendSubagentText('old', 'x');
    m.appendAssistant('r1');
    m.placeFork(1);
    m.addUser('two');
    m.appendThought('thinking');
    m.showProcessing();
    const firstTool = m.items[1];
    events.length = 0;

    expect(m.cutAtUserTurn(1)).toBe(true);
    expect(m.items.map((i) => i.kind)).toEqual(['user', 'tool', 'asst']);
    expect(events).toContain('reset');
    expect(m.curAsst).toBeNull();
    expect(m.forkItem).toBeNull();

    m.upsertTool({ toolCallId: 'old', status: 'completed' });
    const fresh = m.items[m.items.length - 1];
    expect(fresh).not.toBe(firstTool);
    expect(fresh).toMatchObject({
      kind: 'tool',
      label: 'old',
      status: 'completed',
      sub: null,
    });
    // the subagent state went with the cut: a frame for the old parent
    // attaches to the fresh item, not the stale one
    m.appendSubagentText('old', 'y');
    expect(fresh.sub?.text).toBe('y');
    expect(firstTool.sub?.text).toBe('x');
  });

  it('cutAtUserTurn(5) with two user turns returns false but still clears the tool index', () => {
    const { m } = setup();
    m.addUser('one');
    m.upsertTool({ toolCallId: 't', title: 'Read' });
    m.appendAssistant('r');
    m.placeFork(1);
    m.showProcessing();
    m.addUser('two');
    m.showProcessing();
    const n = m.items.length;
    expect(m.cutAtUserTurn(5)).toBe(false);
    // fork row and processing item are still dropped; nothing else is
    expect(m.items.map((i) => i.kind)).toEqual([
      'user',
      'tool',
      'asst',
      'user',
    ]);
    expect(m.items.length).toBe(n - 2);
    expect(m.curAsst).toBeNull();
    expect(m.forkItem).toBeNull();
    const old = m.items[1];
    m.upsertTool({ toolCallId: 't', status: 'completed' });
    expect(m.items.length).toBe(5);
    expect(m.items[4]).not.toBe(old);
    expect(old.status).toBe('');
  });

  it('clear empties items, resets pointers and emits reset', () => {
    const { m, events } = setup();
    m.addUser('q');
    m.appendThought('t');
    m.appendAssistant('a');
    m.placeFork(1);
    m.upsertTool({ toolCallId: 't' });
    const arr = m.items;
    events.length = 0;
    m.clear();
    expect(events).toEqual(['reset']);
    expect(m.items).toBe(arr);
    expect(m.items.length).toBe(0);
    expect(m.curAsst).toBeNull();
    expect(m.forkItem).toBeNull();
    m.appendAssistant('fresh');
    expect(m.items.length).toBe(1);
    m.finishThought(); // no stale thought pointer
    expect(m.items.length).toBe(1);
  });

  it('item ids are unique and strictly increasing across a cut', () => {
    const { m } = setup();
    m.addUser('one');
    m.appendAssistant('a');
    m.addUser('two');
    m.appendAssistant('b');
    expect(m.cutAtUserTurn(1)).toBe(true);
    m.addUser('three');
    m.upsertTool({ toolCallId: 'x' });
    m.addSystem('s');
    const all: number[] = [];
    m.subscribe((ev) => {
      if (ev.type === 'append' && ev.item) all.push(ev.item.id);
    });
    m.appendAssistant('c');
    m.addUser('four');
    const ids = m.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++)
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    expect(all.length).toBe(2);
    expect(all[0]).toBeGreaterThan(ids[ids.length - 3]);
  });

  it('subscribe returns an unsubscribe function', () => {
    const { m } = setup();
    const seen: string[] = [];
    const off = m.subscribe((ev) => seen.push(ev.type));
    m.addUser('a');
    off();
    m.addUser('b');
    expect(seen).toEqual(['append']);
  });
});
