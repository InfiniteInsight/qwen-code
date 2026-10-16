/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
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
  notSent?: string;
  input?: unknown;
  result?: unknown;
  open?: Array<{ text: string; status: string }>;
  done?: number;
  total?: number;
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
  planItem: Item | null;
  subscribe(fn: (ev: Ev) => void): () => void;
  addUser(text: string): Item;
  appendAssistant(text: string): void;
  appendThought(text: string): void;
  finishThought(): void;
  addSystem(text: string, err?: boolean): void;
  setPlan(entries: unknown[]): void;
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

  // #63. Every tool frame ends the current bubble (upsertTool calls
  // resetTurn), so the chunk right after a tool call opens a new item. A blank
  // chunk must not open an empty row, the way finishThought already refuses to
  // keep a blank thought.
  it('blank delta after a tool call opens no bubble (#63)', () => {
    const { m, events } = setup();
    m.appendAssistant('before');
    m.upsertTool({ toolCallId: 't1', title: 'Read file', status: 'pending' });
    const before = events.length;
    m.appendAssistant(' \n ');
    expect(m.items.map((i) => i.kind)).toEqual(['asst', 'tool']);
    expect(m.curAsst).toBeNull();
    expect(events.slice(before)).toEqual([]);
  });

  it('blank delta as the first frame of a turn opens no bubble (#63)', () => {
    const { m } = setup();
    m.appendAssistant('');
    m.appendAssistant('  ');
    m.appendAssistant('\x00\x07'); // control chars only: clean() empties it
    expect(m.items.length).toBe(0);
    expect(m.curAsst).toBeNull();
  });

  it('a delta that starts blank then carries text yields one bubble (#63)', () => {
    const { m } = setup();
    m.upsertTool({ toolCallId: 't1', status: 'pending' });
    m.appendAssistant(' ');
    m.appendAssistant('Hello');
    m.appendAssistant(' there');
    expect(m.items.map((i) => i.kind)).toEqual(['tool', 'asst']);
    expect(m.items[1].text).toBe('Hello there');
  });

  it('a blank delta inside a live bubble is kept (#63)', () => {
    const { m } = setup();
    m.appendAssistant('line\n');
    m.appendAssistant('   ');
    m.appendAssistant('next');
    expect(m.items.length).toBe(1);
    expect(m.items[0].text).toBe('line\n   next');
  });

  it('a turn with two tool calls keeps two bubbles in frame order (#63)', () => {
    const { m } = setup();
    m.appendAssistant('first');
    m.appendAssistant(' still first');
    m.upsertTool({ toolCallId: 't1', status: 'completed' });
    m.appendAssistant(' \n'); // the delta that used to become an empty row
    m.appendAssistant('between');
    m.upsertTool({ toolCallId: 't2', status: 'completed' });
    m.appendAssistant('last');
    expect(m.items.map((i) => `${i.kind}:${i.text ?? i.label}`)).toEqual([
      'asst:first still first',
      'tool:t1',
      'asst:between',
      'tool:t2',
      'asst:last',
    ]);
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

  // #64. The real frames, from createTranscriptToolCallStartUpdate and
  // createTranscriptToolCallResultUpdate in acp-bridge: a start frame carries
  // rawInput and an empty content, a result frame carries content plus rawOutput,
  // and a status-only frame carries neither.
  describe('tool input and result (#64)', () => {
    const start = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      status: 'pending',
      title: 'Read src/a.ts',
      kind: 'read',
      content: [],
      rawInput: { file_path: '/x/src/a.ts' },
    };
    const result = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'hello' } }],
      rawOutput: { kind: 'text' },
    };

    it('the start frame keeps rawInput and starts collapsed', () => {
      const { m } = setup();
      m.upsertTool(start);
      const tool = m.items[0];
      expect(tool.expanded).toBe(false);
      expect(tool.input).toEqual({ file_path: '/x/src/a.ts' });
      expect(tool.result).toBeUndefined();
    });

    it('the result frame lands on the same item and keeps the input', () => {
      const { m } = setup();
      m.upsertTool(start);
      m.upsertTool(result);
      expect(m.items.length).toBe(1);
      const tool = m.items[0];
      expect(tool.status).toBe('completed');
      expect(tool.result).toEqual(result.content);
      expect(tool.input).toEqual({ file_path: '/x/src/a.ts' });
    });

    it('a status-only frame erases neither', () => {
      const { m } = setup();
      m.upsertTool(start);
      m.upsertTool(result);
      m.upsertTool({ toolCallId: 'tc1', status: 'in_progress' });
      const tool = m.items[0];
      expect(tool.status).toBe('in_progress');
      expect(tool.result).toEqual(result.content);
      expect(tool.input).toEqual({ file_path: '/x/src/a.ts' });
    });

    it('rawOutput is the result when content is empty', () => {
      const { m } = setup();
      m.upsertTool(start);
      m.upsertTool({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        content: [],
        rawOutput: { stdout: 'hi' },
      });
      expect(m.items[0].result).toEqual({ stdout: 'hi' });
    });

    it('a frame with no input and no output has nothing to expand into', () => {
      const { m } = setup();
      m.upsertTool({ toolCallId: 'tc9', title: 'x', status: 'pending' });
      const tool = m.items[0];
      expect(tool.input).toBeUndefined();
      expect(tool.result).toBeUndefined();
    });

    it('an empty rawInput object still counts as the call', () => {
      const { m } = setup();
      m.upsertTool({ ...start, rawInput: {} });
      expect(m.items[0].input).toEqual({});
    });
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

  it('addUser returns the item it created so the caller can mark it later (#62)', () => {
    const { m, events } = setup();
    const item = m.addUser('do the thing');
    expect(item.kind).toBe('user');
    expect(item.text).toBe('do the thing');
    expect(m.items[0]).toBe(item);
    const before = events.length;
    item.notSent = 'session was busy';
    m.touch(item);
    expect(events.slice(before)).toEqual(['update']);
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

  describe('to-do list (#65)', () => {
    const entry = (content: string, status: string) => ({
      content,
      priority: 'medium',
      status,
    });

    const plans = (m: Model) =>
      m.items.filter((i) => i.kind === 'plan').map((i) => i.id);

    it('one row per session, updated in place by the newest frame', () => {
      const { m, events } = setup();
      m.addUser('go');
      m.setPlan([entry('a', 'pending'), entry('b', 'pending')]);
      const first = m.planItem;
      expect(first!.kind).toBe('plan');
      m.setPlan([entry('a', 'completed'), entry('b', 'in_progress')]);
      // The daemon re-emits the whole list on every change: one append, then
      // updates only.
      expect(events).toEqual(['append', 'append', 'update']);
      expect(m.planItem).toBe(first);
      expect(plans(m)).toHaveLength(1);
      expect(first!.open).toEqual([{ text: 'b', status: 'in_progress' }]);
      expect(first!.done).toBe(1);
      expect(first!.total).toBe(2);
    });

    it('completed entries leave the list and are counted, not dropped silently', () => {
      const { m } = setup();
      m.setPlan([
        entry('a', 'pending'),
        entry('b', 'pending'),
        entry('c', 'pending'),
      ]);
      m.setPlan([
        entry('a', 'completed'),
        entry('b', 'completed'),
        entry('c', 'pending'),
      ]);
      const p = m.planItem;
      expect(p!.open.map((e) => e.text)).toEqual(['c']);
      expect([p!.done, p!.total]).toEqual([2, 3]);
    });

    it('a failed entry stays on screen, since dropping it hides the news', () => {
      const { m } = setup();
      m.setPlan([entry('a', 'failed'), entry('b', 'completed')]);
      const p = m.planItem;
      expect(p!.open).toEqual([{ text: 'a', status: 'failed' }]);
      expect([p!.done, p!.total]).toEqual([1, 2]);
    });

    it('a frame with nothing usable leaves no row at all', () => {
      const { m } = setup();
      m.setPlan([]);
      m.setPlan(undefined as unknown as []);
      m.setPlan([null, { content: '', status: 'pending' }] as unknown as []);
      expect(m.items).toEqual([]);
      expect(m.planItem).toBe(null);
    });

    it('a blank entry is not counted, so the total stays what is readable', () => {
      const { m } = setup();
      m.setPlan([entry('a', 'pending'), { status: 'pending' } as unknown]);
      const p = m.planItem;
      expect(p!.open.map((e) => e.text)).toEqual(['a']);
      expect([p!.done, p!.total]).toEqual([0, 1]);
    });

    it('the row keeps its place while the transcript grows around it', () => {
      const { m } = setup();
      m.addUser('one');
      m.setPlan([entry('a', 'pending')]);
      const first = m.planItem;
      const place = m.items.indexOf(first!);
      for (let k = 0; k < 20; k++) {
        m.appendAssistant(`chunk ${k}`);
        m.upsertTool({ toolCallId: `t${k}`, title: 'x', status: 'completed' });
      }
      m.setPlan([entry('a', 'completed'), entry('b', 'pending')]);
      expect(m.planItem).toBe(first);
      expect(m.items.indexOf(first!)).toBe(place);
      expect(m.items.filter((i) => i.kind === 'plan')).toHaveLength(1);
    });

    it('clear drops the row and a later frame starts a fresh one', () => {
      const { m } = setup();
      m.setPlan([entry('a', 'pending')]);
      const first = m.planItem;
      m.clear();
      expect(m.planItem).toBe(null);
      m.setPlan([entry('z', 'pending')]);
      expect(m.planItem).not.toBe(first);
      expect(plans(m)).toHaveLength(1);
    });

    it('a rewind that never reached the row keeps updating that row', () => {
      const { m } = setup();
      m.addUser('one');
      m.setPlan([entry('a', 'pending')]);
      const first = m.planItem;
      m.addUser('two');
      expect(m.cutAtUserTurn(1)).toBe(true);
      expect(m.planItem).toBe(first);
      m.setPlan([entry('a', 'completed'), entry('b', 'pending')]);
      // Without the pointer the next frame would push a second row under it.
      expect(plans(m)).toHaveLength(1);
      expect(m.planItem!.open.map((e) => e.text)).toEqual(['b']);
    });

    it('a rewind that drops the row lets the next frame start a fresh one', () => {
      const { m } = setup();
      m.addUser('one');
      m.setPlan([entry('a', 'pending')]);
      const first = m.planItem;
      m.addUser('two');
      expect(m.cutAtUserTurn(0)).toBe(true);
      expect(m.planItem).toBe(null);
      m.setPlan([entry('z', 'pending')]);
      expect(plans(m)).toHaveLength(1);
      expect(m.planItem!.id).not.toBe(first!.id);
    });
  });

  describe('a throwing subscriber', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    // Listener errors are reported (reportError, else console.error), never
    // thrown into the mutation that triggered them.
    function throwOnce(m: Model): void {
      let armed = true;
      m.subscribe(() => {
        if (armed) {
          armed = false;
          throw new Error('view render bug');
        }
      });
    }
    function quietReports(): ReturnType<typeof vi.fn> {
      vi.stubGlobal('reportError', undefined);
      const spy = vi.fn();
      vi.spyOn(console, 'error').mockImplementation(spy);
      return spy;
    }

    it('does not stop the next assistant chunk from coalescing into the same item', () => {
      const reported = quietReports();
      const { m } = setup();
      throwOnce(m);
      m.appendAssistant('he');
      m.appendAssistant('llo');
      expect(m.items.length).toBe(1);
      expect(m.items[0].text).toBe('hello');
      expect(m.curAsst).toBe(m.items[0]);
      expect(reported).toHaveBeenCalledTimes(1);
    });

    it('does not orphan a live thought: finishThought still folds it', () => {
      quietReports();
      const { m } = setup();
      throwOnce(m);
      m.appendThought('pondering');
      m.appendAssistant('answer');
      expect(m.items.map((i) => i.kind)).toEqual(['thought', 'asst']);
      expect(m.items[0].live).toBe(false);
      expect(m.items[0].durLabel).toBe('<1s');
    });

    it('does not leave the processing or fork row uncleareable', () => {
      quietReports();
      const { m } = setup();
      throwOnce(m);
      m.showProcessing();
      m.hideProcessing();
      expect(m.items.length).toBe(0);

      const { m: m2 } = setup();
      m2.appendAssistant('a');
      throwOnce(m2);
      m2.placeFork(1);
      expect(m2.forkItem).not.toBeNull();
      m2.clearFork();
      expect(m2.items.some((i) => i.kind === 'fork')).toBe(false);
    });

    it('does not stop other subscribers from receiving the event', () => {
      const reported = quietReports();
      const { m } = setup();
      const seen: string[] = [];
      m.subscribe(() => {
        throw new Error('first listener fails');
      });
      m.subscribe((ev) => seen.push(ev.type));
      m.addUser('hi');
      expect(seen).toEqual(['append']);
      expect(reported).toHaveBeenCalledTimes(1);
    });

    it('reports through reportError when the host provides it', () => {
      const reportError = vi.fn();
      vi.stubGlobal('reportError', reportError);
      const { m } = setup();
      const boom = new Error('boom');
      m.subscribe(() => {
        throw boom;
      });
      m.addUser('hi');
      expect(reportError).toHaveBeenCalledWith(boom);
    });
  });
});
