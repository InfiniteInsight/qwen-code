/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #268: server timestamps rendered on live thoughts, settled thought headers,
// and tool call headers in transcript-view.js, including timezone restamping,
// graceful omission when no frame timestamp exists, and exclusion from
// find-in-conversation range highlights.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => join(here, '..', 'public', f);

// 2026-11-15T16:26:00Z -> Nov 15, 11:26 AM in America/New_York (EST)
//                      -> Nov 15, 4:26 PM in UTC
const STAMP_START = Date.UTC(2026, 10, 15, 16, 26, 0);
const STAMP_END = Date.UTC(2026, 10, 15, 16, 29, 0);

type Item = {
  id: number;
  kind: string;
  text?: string;
  time?: number;
  expanded?: boolean;
};

type Model = {
  items: Item[];
  addUser: (t: string, time?: number) => Item;
  appendAssistant: (t: string, time?: number) => void;
  appendThought: (t: string, time?: number) => void;
  finishThought: () => void;
  upsertTool: (u: Record<string, unknown>, time?: number) => void;
  prependItems: (list: Item[]) => number;
  touch: (item: Item) => void;
  search: (q: string) => Array<{ id: number; item: Item }>;
};

type ModelApi = {
  createTranscriptModel: (opts?: { now?: () => number }) => Model;
  replayStoredPage: (events: unknown[]) => Item[];
};

type View = {
  destroy: () => void;
  setStampZone: (zone?: string) => void;
  setFind: (spec: unknown) => void;
};

let rafQueue = new Map<number, () => void>();
let rafId = 0;
let clockMs = 0;
let dom: JSDOM;
let scroller: HTMLElement;
let view: View | null = null;
let modelApi: ModelApi;
let model: Model;
let registry: Map<string, { ranges: Range[] }>;

function tick(): void {
  for (let round = 0; round < 4 && rafQueue.size; round++) {
    const due = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, fn] of due) fn();
  }
}

function findSpec(query: string, active: number | null = 0) {
  const hits = model.search(query);
  return {
    query,
    ids: hits.map((h) => h.id),
    active: active === null ? null : (hits[active]?.item ?? null),
  };
}

function marked(name: string): string[] {
  return (registry.get(name)?.ranges ?? []).map((r) => r.toString());
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window;
  rafQueue = new Map();
  rafId = 0;
  clockMs = STAMP_START;
  registry = new Map();
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    Node: w.Node,
    Event: w.Event,
    CSS: { highlights: registry },
    Highlight: class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    },
    requestAnimationFrame: (fn: () => void) => {
      rafQueue.set(++rafId, fn);
      return rafId;
    },
    cancelAnimationFrame: (id: number) => {
      rafQueue.delete(id);
    },
  });
  scroller = w.document.createElement('div');
  w.document.body.appendChild(scroller);
  await import(pathToFileURL(pub('transcript-model.js')).href);
  await import(pathToFileURL(pub('transcript-view.js')).href);
  modelApi = (globalThis as { TranscriptModel: never })
    .TranscriptModel as unknown as ModelApi;
  const TranscriptView = (globalThis as { TranscriptView: never })
    .TranscriptView as unknown as {
    createTranscriptView: (o: Record<string, unknown>) => View;
  };
  model = modelApi.createTranscriptModel({ now: () => clockMs });
  view = TranscriptView.createTranscriptView({
    model,
    scroller,
    virtualCore: null,
  });
});

afterEach(() => {
  if (view) view.destroy();
  view = null;
  dom.window.close();
});

describe('thought and tool header timestamps (#268)', () => {
  it('renders the start timestamp on a live thought role line and adopts a later chunk stamp', () => {
    model.appendThought('Checking schema...', STAMP_START);
    tick();

    const role = scroller.querySelector('.bubble.thought .role');
    expect(role?.textContent).toBe('thinking \u00b7 Nov 15, 11:26 AM');
    expect(role?.querySelector('.stamp')?.textContent).toBe(
      ' \u00b7 Nov 15, 11:26 AM',
    );

    // A later chunk does not move the opening timestamp.
    model.appendThought(' still checking', STAMP_END);
    tick();
    expect(role?.textContent).toBe('thinking \u00b7 Nov 15, 11:26 AM');

    // When the first chunk carried no timestamp and a subsequent chunk does,
    // the mounted live thought role adopts that stamp in place.
    model.finishThought();
    model.appendThought('Unstamped start ');
    tick();
    const roles = scroller.querySelectorAll('.bubble.thought .role');
    const secondRole = roles[roles.length - 1];
    expect(secondRole?.textContent).toBe('thinking');
    expect(secondRole?.querySelector('.stamp')).toBeNull();

    model.appendThought('clocked continuation', STAMP_END);
    tick();
    expect(secondRole?.textContent).toBe('thinking \u00b7 Nov 15, 11:29 AM');
  });

  it('renders the opening timestamp inside a settled thought header when collapsed and expanded', () => {
    clockMs = STAMP_START;
    model.appendThought('Reasoning through layout', STAMP_START);
    clockMs = STAMP_START + 3_000;
    model.finishThought();
    tick();

    const head = scroller.querySelector(
      '.bubble.thought .thought-head',
    ) as HTMLElement | null;
    expect(head).not.toBeNull();
    expect(head?.textContent).toBe(
      '∴ Thought for 3s \u00b7 Nov 15, 11:26 AM ▸',
    );
    expect(head?.querySelector('.stamp')?.textContent).toBe(
      ' \u00b7 Nov 15, 11:26 AM',
    );

    head!.click();
    tick();
    expect(head?.textContent).toBe(
      '∴ Thought for 3s \u00b7 Nov 15, 11:26 AM ▾',
    );
    expect(head?.querySelector('.stamp')?.textContent).toBe(
      ' \u00b7 Nov 15, 11:26 AM',
    );
  });

  it('renders the tool start timestamp with and without expandable detail, preserving start time across updates', () => {
    model.upsertTool(
      {
        toolCallId: 'tc-nodetail',
        title: 'Read file',
        status: 'in_progress',
      },
      STAMP_START,
    );
    model.upsertTool(
      {
        toolCallId: 'tc-detail',
        title: 'Read file',
        status: 'in_progress',
        rawInput: { path: 'src/index.ts' },
      },
      STAMP_START,
    );
    tick();

    const heads = scroller.querySelectorAll('.bubble.tool .tool-head');
    expect(heads).toHaveLength(2);
    expect(heads[0]?.textContent).toBe(
      '🔧 Read file  [in_progress] \u00b7 Nov 15, 11:26 AM',
    );
    expect(heads[1]?.textContent).toBe(
      '🔧 Read file  [in_progress] \u00b7 Nov 15, 11:26 AM ▸',
    );

    // Terminal update minutes later updates status and output while keeping start stamp.
    model.upsertTool(
      {
        toolCallId: 'tc-detail',
        status: 'completed',
        rawOutput: 'ok',
      },
      STAMP_END,
    );
    tick();
    expect(heads[1]?.textContent).toBe(
      '🔧 Read file  [completed] \u00b7 Nov 15, 11:26 AM ▸',
    );
    expect(heads[1]?.querySelector('.stamp')?.textContent).toBe(
      ' \u00b7 Nov 15, 11:26 AM',
    );

    (heads[1] as HTMLElement).click();
    tick();
    expect(heads[1]?.textContent).toBe(
      '🔧 Read file  [completed] \u00b7 Nov 15, 11:26 AM ▾',
    );
  });

  it('omits .stamp gracefully when thought and tool items carry no server timestamp', () => {
    clockMs = 1_000;
    model.appendThought('No clock attached');
    tick();
    expect(scroller.querySelector('.bubble.thought .role')?.textContent).toBe(
      'thinking',
    );
    expect(scroller.querySelectorAll('.stamp')).toHaveLength(0);

    clockMs = 4_000;
    model.finishThought();
    model.upsertTool({
      toolCallId: 'tc-plain',
      title: 'Read file',
      status: 'completed',
      rawOutput: 'contents',
    });
    tick();

    expect(
      scroller.querySelector('.bubble.thought .thought-head')?.textContent,
    ).toBe('∴ Thought for 3s ▸');
    expect(scroller.querySelector('.bubble.tool .tool-head')?.textContent).toBe(
      '🔧 Read file  [completed] ▸',
    );
    expect(scroller.querySelectorAll('.stamp')).toHaveLength(0);
  });

  it('restamps mounted user, assistant, live-thought, settled-thought, and tool rows on setStampZone', () => {
    model.addUser('Hello', STAMP_START);
    model.appendThought('First thought', STAMP_START);
    clockMs = STAMP_START + 2_000;
    model.appendAssistant('Answer', STAMP_START);
    model.upsertTool(
      {
        toolCallId: 'tc-zone',
        title: 'Run tests',
        status: 'completed',
        rawOutput: 'pass',
      },
      STAMP_START,
    );
    model.appendThought('Live follow-up thought', STAMP_START);
    tick();

    expect(scroller.querySelector('.bubble.user .role')?.textContent).toBe(
      'you \u00b7 Nov 15, 11:26 AM',
    );
    expect(
      scroller.querySelector('.bubble.thought .thought-head')?.textContent,
    ).toBe('∴ Thought for 2s \u00b7 Nov 15, 11:26 AM ▸');
    expect(scroller.querySelector('.bubble.asst .role')?.textContent).toBe(
      'assistant \u00b7 Nov 15, 11:26 AM',
    );
    expect(scroller.querySelector('.bubble.tool .tool-head')?.textContent).toBe(
      '🔧 Run tests  [completed] \u00b7 Nov 15, 11:26 AM ▸',
    );
    const liveRoles = scroller.querySelectorAll('.bubble.thought .role');
    expect(liveRoles[liveRoles.length - 1]?.textContent).toBe(
      'thinking \u00b7 Nov 15, 11:26 AM',
    );

    view!.setStampZone('UTC');
    tick();

    expect(scroller.querySelector('.bubble.user .role')?.textContent).toBe(
      'you \u00b7 Nov 15, 4:26 PM',
    );
    expect(
      scroller.querySelector('.bubble.thought .thought-head')?.textContent,
    ).toBe('∴ Thought for 2s \u00b7 Nov 15, 4:26 PM ▸');
    expect(scroller.querySelector('.bubble.asst .role')?.textContent).toBe(
      'assistant \u00b7 Nov 15, 4:26 PM',
    );
    expect(scroller.querySelector('.bubble.tool .tool-head')?.textContent).toBe(
      '🔧 Run tests  [completed] \u00b7 Nov 15, 4:26 PM ▸',
    );
    const updatedLiveRoles = scroller.querySelectorAll('.bubble.thought .role');
    expect(updatedLiveRoles[updatedLiveRoles.length - 1]?.textContent).toBe(
      'thinking \u00b7 Nov 15, 4:26 PM',
    );
  });

  it('excludes .stamp text from find-in-conversation highlights while matching expanded bodies', () => {
    clockMs = STAMP_START;
    model.appendThought('Notes from Nov release', STAMP_START);
    clockMs = STAMP_START + 5_000;
    model.upsertTool(
      {
        toolCallId: 'tc-find',
        title: 'Inspect log',
        status: 'completed',
        rawOutput: 'Nov deploy succeeded',
      },
      STAMP_START,
    );
    tick();

    // Searching for the clock digits present only in .stamp matches zero rows
    // and paints zero highlight ranges even if all rows are passed to setFind.
    expect(model.search('11:26')).toHaveLength(0);
    view!.setFind({
      query: '11:26',
      ids: model.items.map((i) => i.id),
      active: model.items[0],
    });
    tick();
    expect(marked('rc-find-active')).toEqual([]);
    expect(marked('rc-find')).toEqual([]);

    // Expand both rows and search for "Nov", which appears in both .stamp AND
    // the expanded body/detail: only the body/detail occurrences are highlighted.
    (
      scroller.querySelector('.bubble.thought .thought-head') as HTMLElement
    ).click();
    (scroller.querySelector('.bubble.tool .tool-head') as HTMLElement).click();
    tick();

    view!.setFind(findSpec('Nov', 0));
    tick();
    expect(marked('rc-find-active')).toEqual(['Nov']);
    expect(marked('rc-find')).toEqual(['Nov']);

    const allRanges = [
      ...(registry.get('rc-find-active')?.ranges ?? []),
      ...(registry.get('rc-find')?.ranges ?? []),
    ];
    for (const r of allRanges) {
      const parent = r.startContainer.parentElement;
      expect(parent?.closest('.stamp')).toBeNull();
    }
  });

  it('repaints a mounted result-only tool row in place when an older page brings its tool_call start timestamp', () => {
    model.prependItems(
      modelApi.replayStoredPage([
        {
          v: 1,
          type: 'session_update',
          data: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-split',
            status: 'completed',
            rawOutput: 'done',
            _meta: { timestamp: STAMP_END },
          },
        },
      ]),
    );
    tick();
    expect(scroller.querySelector('.bubble.tool .tool-head')?.textContent).toBe(
      '🔧 tc-split  [completed] \u00b7 Nov 15, 11:29 AM ▸',
    );

    model.prependItems(
      modelApi.replayStoredPage([
        {
          v: 1,
          type: 'session_update',
          data: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-split',
            title: 'Read split.ts',
            status: 'in_progress',
            rawInput: { path: 'split.ts' },
            _meta: { timestamp: STAMP_START },
          },
        },
      ]),
    );
    tick();
    expect(scroller.querySelectorAll('.bubble.tool')).toHaveLength(1);
    expect(scroller.querySelector('.bubble.tool .tool-head')?.textContent).toBe(
      '🔧 Read split.ts  [completed] \u00b7 Nov 15, 11:26 AM ▸',
    );
  });
});
