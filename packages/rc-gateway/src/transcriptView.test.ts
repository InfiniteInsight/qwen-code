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

type SubTool = {
  id: string;
  label: string;
  status: string;
  textAt?: number;
};

type Item = {
  id: number;
  kind: string;
  text?: string;
  time?: number;
  expanded?: boolean;
  turnEnd?: boolean;
  busy?: boolean;
  note?: string;
  sub?: {
    tools: SubTool[];
  } | null;
};

type Model = {
  items: Item[];
  addUser: (t: string, time?: number) => Item;
  appendAssistant: (t: string, time?: number) => void;
  appendThought: (t: string, time?: number) => void;
  finishThought: () => void;
  upsertTool: (u: Record<string, unknown>, time?: number) => void;
  upsertSubagentTool: (u: Record<string, unknown>, parentId: string) => void;
  prependItems: (list: Item[], beforeInsert?: () => void) => number;
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
  anchorReader: () => void;
  readerAnchor: () => { end?: boolean; item?: Item; top?: number };
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
  const reqRaf = (fn: () => void) => {
    rafQueue.set(++rafId, fn);
    return rafId;
  };
  const cancelRaf = (id: number) => {
    rafQueue.delete(id);
  };
  Object.assign(w, {
    requestAnimationFrame: reqRaf,
    cancelAnimationFrame: cancelRaf,
  });
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
    requestAnimationFrame: reqRaf,
    cancelAnimationFrame: cancelRaf,
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

describe('subagent tool pruning and prepend reader anchoring (#273)', () => {
  it('prunes excess .subtool DOM elements when item.sub.tools shrinks and grows cleanly again', () => {
    model.upsertTool({
      toolCallId: 'tc-sub',
      title: 'Agent',
      status: 'in_progress',
    });
    model.upsertSubagentTool(
      { toolCallId: 'st-1', title: 'Read a.ts', status: 'completed' },
      'tc-sub',
    );
    model.upsertSubagentTool(
      { toolCallId: 'st-2', title: 'Read b.ts', status: 'completed' },
      'tc-sub',
    );
    model.upsertSubagentTool(
      { toolCallId: 'st-3', title: 'Read c.ts', status: 'in_progress' },
      'tc-sub',
    );
    tick();

    const subtoolsBefore = Array.from(
      scroller.querySelectorAll('.subagent .subtool'),
    ).map((n) => n.textContent);
    expect(subtoolsBefore).toEqual([
      '🔧 Read a.ts  [completed]',
      '🔧 Read b.ts  [completed]',
      '🔧 Read c.ts  [in_progress]',
    ]);

    const item = model.items[0]!;
    item.sub!.tools.splice(1);
    model.touch(item);
    tick();

    const subtoolsShrunk = Array.from(
      scroller.querySelectorAll('.subagent .subtool'),
    ).map((n) => n.textContent);
    expect(subtoolsShrunk).toEqual(['🔧 Read a.ts  [completed]']);

    model.upsertSubagentTool(
      { toolCallId: 'st-4', title: 'Grep d.ts', status: 'completed' },
      'tc-sub',
    );
    tick();

    const subtoolsRegrown = Array.from(
      scroller.querySelectorAll('.subagent .subtool'),
    ).map((n) => n.textContent);
    expect(subtoolsRegrown).toEqual([
      '🔧 Read a.ts  [completed]',
      '🔧 Grep d.ts  [completed]',
    ]);
  });

  it('restores the anchored row via pendingPlace when prependItems splices older pages above a virtualized reader', async () => {
    if (view) view.destroy();
    view = null;

    const virtualCoreMod = (await import(
      pathToFileURL(pub(join('vendor', 'virtual-core.js'))).href
    )) as Record<string, unknown>;

    const rectOf = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 390,
        width: 390,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    const vScroller = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(vScroller);
    let scrollTopVal = 0;
    let scrollEventQueued = false;
    Object.defineProperties(vScroller, {
      clientHeight: { get: () => 200 },
      clientWidth: { get: () => 390 },
      scrollTop: {
        get: () => scrollTopVal,
        set: (v: number) => {
          const clamped = Math.max(0, Math.round(v));
          if (clamped !== scrollTopVal) {
            scrollTopVal = clamped;
            if (!scrollEventQueued) {
              scrollEventQueued = true;
              requestAnimationFrame(() => {
                scrollEventQueued = false;
                vScroller.dispatchEvent(new dom.window.Event('scroll'));
              });
            }
          }
        },
      },
      scrollHeight: {
        get: () => {
          const host = vScroller.querySelector(
            '.vsizer, .vlist',
          ) as HTMLElement | null;
          const parsed = host ? parseFloat(host.style.height) : NaN;
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
        },
      },
    });
    vScroller.getClientRects = () =>
      [rectOf(0, 200)] as unknown as DOMRectList;
    vScroller.getBoundingClientRect = () => rectOf(0, 200);
    vScroller.scrollTo = ((opts: unknown) => {
      if (
        opts &&
        typeof opts === 'object' &&
        typeof (opts as { top?: unknown }).top === 'number'
      ) {
        vScroller.scrollTop = (opts as { top: number }).top;
      }
    }) as typeof vScroller.scrollTo;

    const proto = dom.window.HTMLElement.prototype;
    const origOffsetHeight = Object.getOwnPropertyDescriptor(
      proto,
      'offsetHeight',
    );
    const origGetClientRects = proto.getClientRects;
    const origGetBCR = proto.getBoundingClientRect;
    Object.defineProperty(proto, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('vrow')) return 59;
        return 0;
      },
    });
    proto.getClientRects = function (this: HTMLElement) {
      if (this === vScroller) {
        return [rectOf(0, 200)] as unknown as DOMRectList;
      }
      if (this.classList.contains('vrow')) {
        return [rectOf(0, 59)] as unknown as DOMRectList;
      }
      return origGetClientRects.call(this);
    };
    proto.getBoundingClientRect = function (this: HTMLElement) {
      if (this === vScroller) return rectOf(0, 200);
      if (this.classList.contains('vrow')) {
        const m = /translateY\(([-\d.]+)px\)/.exec(this.style.transform || '');
        const y = m ? parseFloat(m[1]!) : 0;
        return rectOf(y - scrollTopVal, 59);
      }
      return origGetBCR.call(this);
    };

    try {
      const vModel = modelApi.createTranscriptModel({ now: () => clockMs });
      for (let i = 0; i < 40; i++) {
        vModel.addUser(`live-${i}`, STAMP_START + i * 1000);
      }
      const TranscriptView = (globalThis as { TranscriptView: never })
        .TranscriptView as unknown as {
        createTranscriptView: (o: Record<string, unknown>) => View;
      };
      const vView = TranscriptView.createTranscriptView({
        model: vModel,
        scroller: vScroller,
        virtualCore: {
          Virtualizer: virtualCoreMod['Virtualizer'],
          observeElementRect: (
            _inst: unknown,
            cb: (r: { width: number; height: number }) => void,
          ) => {
            cb({ width: 390, height: 200 });
            return () => {};
          },
          observeElementOffset: virtualCoreMod['observeElementOffset'],
          elementScroll: virtualCoreMod['elementScroll'],
        },
      });
      view = vView;
      tick();
      tick();

      // Scroll away from the bottom to the top of the currently loaded window
      // (live-0 sits at viewport top = 8px because paddingStart is 8px).
      vScroller.scrollTop = 0;
      vScroller.dispatchEvent(new dom.window.Event('scroll'));
      tick();

      const anchorBefore = vView.readerAnchor();
      expect(Boolean(anchorBefore.end)).toBe(false);
      expect(anchorBefore.item?.text).toBe('live-0');
      expect(anchorBefore.top).toBe(8);

      // Prepend 20 older rows (far beyond overscan: 8). Without pendingPlace,
      // scrollTop = 0 would mount older-0..older-11, unmounting live-0 so hold/keepHeld
      // could not find it and the reader would jump to older-0.
      const olderEvents = Array.from({ length: 20 }, (_, idx) => ({
        v: 1,
        type: 'session_update',
        data: {
          sessionUpdate: 'user_message_chunk',
          content: { text: `older-${idx}` },
          _meta: {
            timestamp: STAMP_START - (20 - idx) * 1000,
            'qwen.session.recordId': `older-rec-${idx}`,
          },
        },
      }));
      const olderRows = modelApi.replayStoredPage(olderEvents);
      const added = vModel.prependItems(olderRows, () => {
        vView.anchorReader();
      });
      expect(added).toBe(20);
      tick();

      const mountedRow = vScroller.querySelector(
        `.vrow[data-id="${anchorBefore.item!.id}"]`,
      ) as HTMLElement | null;
      expect(mountedRow).not.toBeNull();
      expect(mountedRow!.getBoundingClientRect().top).toBe(8);
      expect(vScroller.scrollTop).toBeGreaterThan(1200);
    } finally {
      if (origOffsetHeight) {
        Object.defineProperty(proto, 'offsetHeight', origOffsetHeight);
      }
      proto.getClientRects = origGetClientRects;
      proto.getBoundingClientRect = origGetBCR;
    }
  });

  it('places Fork, Rewind, and Copy inline in the assistant role line after the stamp, preserves them across restamp, and excludes turn-acts-note from Find (#233)', () => {
    const actsCalled: Array<[string, number]> = [];
    view?.destroy();
    const TranscriptView = (globalThis as { TranscriptView: never })
      .TranscriptView as unknown as {
      createTranscriptView: (o: Record<string, unknown>) => View;
    };
    view = TranscriptView.createTranscriptView({
      model,
      scroller,
      virtualCore: null,
      onTurnAct: (act: string, it: Item) => actsCalled.push([act, it.id]),
    });

    model.appendAssistant('Forkable reply mentioning Fork in body.', STAMP_START);
    const asst = model.items[0]!;
    asst.turnEnd = true;
    model.touch(asst);
    tick();

    const bubble = scroller.querySelector('.bubble.asst') as HTMLElement | null;
    expect(bubble).not.toBeNull();
    const role = bubble!.querySelector(':scope > .role') as HTMLElement | null;
    expect(role).not.toBeNull();
    const stamp = role!.querySelector(':scope > .stamp');
    const acts = role!.querySelector(':scope > .turn-acts');
    expect(stamp).not.toBeNull();
    expect(acts).not.toBeNull();
    expect(stamp!.nextElementSibling).toBe(acts);
    expect(
      Array.from(acts!.querySelectorAll('button')).map((b) => b.textContent),
    ).toEqual(['Fork', 'Rewind', 'Copy']);
    // No strip below the bubble on the vrow itself.
    expect(scroller.querySelector('.vrow > .turn-acts')).toBeNull();

    const noteEl = bubble!.querySelector(
      ':scope > .turn-acts-note',
    ) as HTMLElement | null;
    expect(noteEl).not.toBeNull();
    expect(noteEl!.hidden).toBe(true);

    (acts!.querySelector('.act-fork') as HTMLButtonElement).click();
    expect(actsCalled).toEqual([['fork', asst.id]]);

    asst.busy = true;
    asst.note = 'copied Fork note';
    model.touch(asst);
    tick();
    expect((acts!.querySelector('.act-fork') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(noteEl!.hidden).toBe(false);
    expect(noteEl!.textContent).toBe('copied Fork note');

    // Find-in-conversation matches only the 2 occurrences in the body text (1 active + 1 other),
    // never the Fork button label or turn-acts-note.
    view.setFind(findSpec('Fork'));
    tick();
    expect(marked('rc-find')).toEqual(['Fork']);
    expect(marked('rc-find-active')).toEqual(['Fork']);
    const highlightParents = [
      ...(registry.get('rc-find-active')?.ranges ?? []),
      ...(registry.get('rc-find')?.ranges ?? []),
    ].map((r) => r.startContainer.parentElement?.className ?? '');
    expect(
      highlightParents.every(
        (cls) => !cls.includes('act-') && !cls.includes('turn-acts-note'),
      ),
    ).toBe(true);

    // Changing time zone rebuilds the bubble and preserves inline .turn-acts + note.
    view.setStampZone('UTC');
    tick();
    const rebuiltRole = scroller.querySelector(
      '.bubble.asst > .role',
    ) as HTMLElement | null;
    expect(rebuiltRole?.querySelector('.stamp')?.textContent).toBe(
      ' · Nov 15, 4:26 PM',
    );
    expect(
      Array.from(
        rebuiltRole?.querySelectorAll(':scope > .turn-acts button') ?? [],
      ).map((b) => b.textContent),
    ).toEqual(['Fork', 'Rewind', 'Copy']);
    expect(
      scroller.querySelector('.bubble.asst > .turn-acts-note')?.textContent,
    ).toBe('copied Fork note');

    // Clearing turnEnd removes both inline .turn-acts and .turn-acts-note.
    asst.turnEnd = false;
    model.touch(asst);
    tick();
    expect(scroller.querySelector('.turn-acts')).toBeNull();
    expect(scroller.querySelector('.turn-acts-note')).toBeNull();
  });
});
