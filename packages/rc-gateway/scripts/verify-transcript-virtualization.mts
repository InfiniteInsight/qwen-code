/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manual verification (NOT a CI test) for the viewer's virtualized transcript
 * (issue InfiniteInsight/Qwen-Code-Remote#57). Each scenario prints
 * `PASS|FAIL <name>`; the process exits 1 on any FAIL.
 *
 *   npx tsx scripts/verify-transcript-virtualization.mts          # all sections
 *   npx tsx scripts/verify-transcript-virtualization.mts view     # one section
 *   CHROMIUM_PATH=/path/to/chrome npx tsx scripts/verify-transcript-virtualization.mts
 *
 * Section `view` drives public/transcript-view.js directly: a test-owned page
 * (served same-origin at /ui/__vt.html through page.route) loads the real
 * transcript-model.js and transcript-view.js from the gateway, imports the
 * vendored /ui/vendor/virtual-core.js, and mounts the view in its own `#vt`
 * scroller (max-height 75vh, overflow-y auto) — not the page's #transcript.
 */
import type { Page } from 'playwright';
import { bootViewer, type Viewer } from './lib/viewerHarness.mjs';

// ---- In-page test page --------------------------------------------------

// Plain JS (not TypeScript): Playwright serializes evaluate callbacks with
// toString(), and tsx's keepNames would inject an undefined `__name` helper
// into any named function inside them, so every named helper lives here.
const HELPERS_JS = String.raw`
(function () {
  'use strict';
  var scroller = document.getElementById('vt');
  var core = null;
  var state = { model: null, view: null };

  // Interval bookkeeping for the timer scenario. Installed before the view
  // script loads, so the view's setInterval/clearInterval go through it.
  var active = new Set();
  var realSetInterval = window.setInterval;
  var realClearInterval = window.clearInterval;
  window.setInterval = function () {
    var id = realSetInterval.apply(window, arguments);
    active.add(id);
    return id;
  };
  window.clearInterval = function (id) {
    active.delete(id);
    return realClearInterval.call(window, id);
  };

  var WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur',
    'adipiscing', 'elit', 'sed', 'do', 'eiusmod', 'tempor'];
  function text(n, seed) {
    var out = 'item ' + seed + ':';
    for (var i = 0; out.length < n; i++) {
      out += ' ' + WORDS[(i * 7 + seed) % WORDS.length];
    }
    return out.slice(0, n);
  }

  async function loadCore() {
    if (!core) core = await import('/ui/vendor/virtual-core.js');
    return Object.keys(core).sort().join(',');
  }

  function setup(virtual) {
    if (state.view) state.view.destroy();
    state.view = null;
    scroller.textContent = '';
    scroller.scrollTop = 0;
    state.model = TranscriptModel.createTranscriptModel();
    state.view = TranscriptView.createTranscriptView({
      model: state.model,
      scroller: scroller,
      virtualCore: virtual ? core : null,
    });
  }

  // n user/assistant pairs (2n items) of ~chars characters each.
  function addTurns(n, chars, seed) {
    for (var i = 0; i < n; i++) {
      state.model.addUser(text(chars, seed + 2 * i));
      state.model.appendAssistant(text(chars, seed + 2 * i + 1));
    }
  }

  function gap() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  }

  function frame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        resolve();
      });
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function snapshot() {
    return [
      scroller.scrollTop,
      scroller.scrollHeight,
      scroller.clientHeight,
      state.view ? state.view.mountedCount() : -1,
      scroller.querySelectorAll('*').length,
    ].join('|');
  }

  // Resolves true once scroll geometry and the mounted set have been
  // unchanged for 8 consecutive frames (and at least minMs has passed, e.g.
  // to outlast virtual-core's 150 ms is-scrolling debounce); false after 5 s.
  async function settle(minMs) {
    var start = performance.now();
    var last = '';
    var same = 0;
    while (performance.now() - start < 5000) {
      await frame();
      var s = snapshot();
      if (s === last) same++;
      else {
        same = 0;
        last = s;
      }
      if (same >= 8 && performance.now() - start >= (minMs || 0)) return true;
    }
    return false;
  }

  function row(id) {
    return scroller.querySelector('.vrow[data-id="' + id + '"]');
  }

  // Rows whose box intersects the scroller's visible area.
  function visibleRows() {
    var box = scroller.getBoundingClientRect();
    var n = 0;
    scroller.querySelectorAll('.vrow').forEach(function (r) {
      var b = r.getBoundingClientRect();
      if (b.bottom > box.top && b.top < box.bottom && b.height > 0) n++;
    });
    return n;
  }

  window.__vt = {
    scroller: scroller,
    get model() {
      return state.model;
    },
    get view() {
      return state.view;
    },
    loadCore: loadCore,
    setup: setup,
    addTurns: addTurns,
    gap: gap,
    frame: frame,
    sleep: sleep,
    settle: settle,
    row: row,
    visibleRows: visibleRows,
    text: text,
    activeIntervals: function () {
      return active.size;
    },
  };
})();
`;

// The layout-affecting subset of index.html's `#transcript ...` rules,
// re-scoped to #vt, so row heights resemble production. Structural styles
// (sizer, rows) come from the view itself.
const VT_CSS = `
  body { margin: 0; padding: 8px; background: #000; color: #e6e6e6;
    font-family: system-ui, sans-serif; }
  #vt { background: #111; }
  #vt .bubble { max-width: 92%; padding: 8px 10px; border-radius: 10px;
    white-space: pre-wrap; word-break: break-word; line-height: 1.4;
    font-size: 0.95rem; }
  #vt .role { font-size: 0.7rem; text-transform: uppercase; margin-bottom: 2px; }
  #vt .user { align-self: flex-end; }
  #vt .asst, #vt .thought, #vt .tool, #vt .processing, #vt .bubble-fork {
    align-self: flex-start; }
  #vt .system { align-self: center; font-size: 0.8rem; }
  #vt .thought .thought-body { display: block; margin-top: 4px; }
  #vt .thought .thought-body[hidden] { display: none; }
  #vt .subagent { margin: 6px 0 0 6px; padding-left: 10px; }
`;

const VT_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>transcript view scenarios</title>
<style>${VT_CSS}</style></head>
<body>
<div id="vt" style="max-height:75vh;overflow-y:auto"></div>
<script>${HELPERS_JS}</script>
<script src="/ui/transcript-model.js"></script>
<script src="/ui/transcript-view.js"></script>
</body>
</html>`;

// ---- Types of the in-page globals ----------------------------------------

interface VtItem {
  id: number;
  kind: string;
  text: string;
}
interface VtModel {
  items: VtItem[];
  addUser(text: string): void;
  appendAssistant(text: string): void;
  appendThought(text: string): void;
  finishThought(): void;
  showProcessing(): void;
  hideProcessing(): void;
  upsertTool(u: Record<string, unknown>): void;
  appendSubagentText(parentId: string, text: string): void;
  upsertSubagentTool(u: Record<string, unknown>, parentId: string): void;
  finishSubagent(parentId: string, status: string): void;
  touch(item: VtItem): void;
}
interface VtView {
  scrollToEnd(): void;
  followIfPinned(): void;
  isNearBottom(): boolean;
  mountedCount(): number;
  destroy(): void;
}
declare const __vt: {
  scroller: HTMLElement;
  model: VtModel;
  view: VtView;
  loadCore(): Promise<string>;
  setup(virtual: boolean): void;
  addTurns(n: number, chars: number, seed: number): void;
  gap(): number;
  frame(): Promise<void>;
  sleep(ms: number): Promise<void>;
  settle(minMs?: number): Promise<boolean>;
  row(id: number): HTMLElement | null;
  visibleRows(): number;
  text(n: number, seed: number): string;
  activeIntervals(): number;
};

// ---- Runner --------------------------------------------------------------

type Scenario = { name: string; run: (page: Page) => Promise<string> };
type Result = { name: string; ok: boolean; detail: string };

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function settle(page: Page, minMs = 200): Promise<void> {
  const ok = await page.evaluate((ms) => __vt.settle(ms), minMs);
  expect(ok, 'layout did not settle within 5 s');
}

async function gap(page: Page): Promise<number> {
  return page.evaluate(() => __vt.gap());
}

// ---- Section `view`: TranscriptView against a test-owned container -------

const VIEW_SCENARIOS: Scenario[] = [
  {
    name: 'V1 bounded mount',
    run: async (page) => {
      await page.evaluate(() => __vt.setup(true));
      await page.evaluate(() => __vt.addTurns(2500, 2000, 0));
      await settle(page);
      const r = await page.evaluate(() => ({
        items: __vt.model.items.length,
        mounted: __vt.view.mountedCount(),
        bubbles: document.querySelectorAll('#vt .bubble').length,
        visible: __vt.visibleRows(),
      }));
      expect(r.items === 5000, `model has ${r.items} items, expected 5000`);
      expect(
        r.mounted > 0 && r.mounted < 60,
        `mountedCount() = ${r.mounted}, expected 1..59`,
      );
      expect(
        r.bubbles === r.mounted,
        `#vt .bubble count ${r.bubbles} != mountedCount() ${r.mounted}`,
      );
      expect(r.visible > 0, 'no mounted row intersects the viewport');
      return `items=${r.items} mounted=${r.mounted} bubbles=${r.bubbles} visible=${r.visible}`;
    },
  },
  {
    name: 'V2 pinned and not yanked',
    run: async (page) => {
      await page.evaluate(() => __vt.setup(true));
      await page.evaluate(() => __vt.addTurns(100, 400, 0));
      await settle(page);
      let g = await gap(page);
      expect(g <= 2, `initial render not pinned: gap=${g}`);
      for (let k = 0; k < 10; k++) {
        await page.evaluate((s) => __vt.addTurns(1, 400, s), 1000 + 2 * k);
        await settle(page, 0);
        g = await gap(page);
        expect(g <= 2, `append ${k + 1} at the bottom: gap=${g}`);
      }
      await page.evaluate(() => {
        __vt.scroller.scrollTop -= 2000;
      });
      await settle(page);
      const before = await page.evaluate(() => ({
        top: __vt.scroller.scrollTop,
        gap: __vt.gap(),
        near: __vt.view.isNearBottom(),
      }));
      expect(before.gap >= 1990, `scroll-up did not happen: gap=${before.gap}`);
      expect(!before.near, 'isNearBottom() true after scrolling up 2000 px');
      // 20 items, one per frame.
      await page.evaluate(async () => {
        for (let k = 0; k < 20; k++) {
          if (k % 2 === 0) __vt.model.addUser(__vt.text(400, 3000 + k));
          else __vt.model.appendAssistant(__vt.text(400, 3000 + k));
          await __vt.frame();
        }
      });
      await settle(page);
      const after = await page.evaluate(() => ({
        top: __vt.scroller.scrollTop,
        near: __vt.view.isNearBottom(),
      }));
      expect(
        Math.abs(after.top - before.top) <= 2,
        `yanked: scrollTop ${before.top} -> ${after.top}`,
      );
      expect(
        !after.near,
        'isNearBottom() true after appends while scrolled up',
      );
      await page.evaluate(() => __vt.view.scrollToEnd());
      await settle(page);
      const end = await page.evaluate(() => ({
        gap: __vt.gap(),
        near: __vt.view.isNearBottom(),
      }));
      expect(end.gap <= 2, `scrollToEnd() did not re-pin: gap=${end.gap}`);
      expect(end.near, 'isNearBottom() false after scrollToEnd()');
      return `scrolled-up top=${before.top} after-appends top=${after.top} end gap=${end.gap}`;
    },
  },
  {
    name: 'V3 streaming stays pinned',
    run: async (page) => {
      await page.evaluate(() => {
        __vt.setup(true);
        __vt.addTurns(25, 400, 0);
        __vt.model.addUser('stream a long answer');
        __vt.model.appendAssistant('start ');
      });
      await settle(page);
      let g = await gap(page);
      expect(g <= 2, `not pinned before streaming: gap=${g}`);
      // After each chunk, wait (up to 10 frames) for the view to re-pin.
      const r = await page.evaluate(async () => {
        const chunk = __vt.text(200, 7);
        let worstFrames = 0;
        let unpinned = 0;
        let worstGap = 0;
        for (let k = 0; k < 200; k++) {
          __vt.model.appendAssistant(chunk);
          let frames = 0;
          do {
            await __vt.frame();
            frames++;
          } while (__vt.gap() > 2 && frames < 10);
          if (__vt.gap() > 2) {
            unpinned++;
            worstGap = Math.max(worstGap, __vt.gap());
          }
          worstFrames = Math.max(worstFrames, frames);
        }
        return { worstFrames, unpinned, worstGap };
      });
      expect(
        r.unpinned === 0,
        `${r.unpinned}/200 chunks left the view unpinned after 10 frames (worst gap ${r.worstGap})`,
      );
      await settle(page);
      g = await gap(page);
      expect(g <= 2, `not pinned after streaming: gap=${g}`);
      const len = await page.evaluate(() => {
        const items = __vt.model.items;
        const last = items[items.length - 1];
        const row = __vt.row(last.id);
        const body = row && row.querySelector('.bubble.asst > span');
        return body ? (body.textContent ?? '').length : -1;
      });
      expect(len === 6 + 200 * 200, `rendered text length ${len}`);
      return `pinned after every chunk (worst ${r.worstFrames} frame(s)); final gap=${g}`;
    },
  },
  {
    name: 'V4 unmounted accumulation',
    run: async (page) => {
      await page.evaluate(() => {
        __vt.setup(true);
        __vt.addTurns(150, 300, 0);
      });
      await settle(page);
      const target = await page.evaluate(() => {
        const it = __vt.model.items[1];
        return { id: it.id, kind: it.kind, mounted: !!__vt.row(it.id) };
      });
      expect(target.kind === 'asst', `items[1] is ${target.kind}`);
      expect(!target.mounted, 'target item should start unmounted');
      await page.evaluate(() => {
        const it = __vt.model.items[1];
        it.text += 'ZZ';
        __vt.model.touch(it);
      });
      await settle(page, 0);
      await page.evaluate(() => {
        __vt.scroller.scrollTop = 0;
      });
      await settle(page);
      const text = await page.evaluate((id) => {
        const row = __vt.row(id);
        const b = row && row.querySelector('.bubble.asst');
        return b ? b.textContent : null;
      }, target.id);
      expect(text !== null, 'target row not mounted after scrolling back');
      expect(
        (text ?? '').endsWith('ZZ'),
        `rendered text ends with ${JSON.stringify((text ?? '').slice(-12))}`,
      );
      return `item ${target.id} re-rendered with the update`;
    },
  },
  {
    name: 'V5 thought expand survives remount',
    run: async (page) => {
      await page.evaluate(() => {
        __vt.setup(true);
        const m = __vt.model;
        m.addUser('think first');
        m.appendThought('pondering ' + __vt.text(600, 3));
        m.finishThought();
        m.appendAssistant('answer');
        __vt.addTurns(100, 300, 10);
      });
      await settle(page);
      const tid = await page.evaluate(
        () => __vt.model.items.find((i) => i.kind === 'thought')!.id,
      );
      const read = () =>
        page.evaluate((id) => {
          const row = __vt.row(id);
          const head =
            row && row.querySelector('.bubble.thought .thought-head');
          const body =
            row && row.querySelector('.bubble.thought .thought-body');
          return {
            mounted: !!row,
            head: head ? head.textContent : null,
            hidden: body ? (body as HTMLElement).hidden : null,
          };
        }, tid);
      await page.evaluate(() => {
        __vt.scroller.scrollTop = 0;
      });
      await settle(page);
      const s1 = await read();
      expect(s1.head !== null, 'folded thought head not rendered');
      expect(
        (s1.head ?? '').startsWith('∴ Thought for ') &&
          (s1.head ?? '').endsWith(' ▸'),
        `collapsed head text ${JSON.stringify(s1.head)}`,
      );
      expect(s1.hidden === true, 'thought body should start hidden');
      await page.click(`#vt .vrow[data-id="${tid}"] .thought-head`);
      await settle(page, 0);
      const s2 = await read();
      expect(s2.hidden === false, 'body still hidden after clicking the head');
      expect((s2.head ?? '').endsWith(' ▾'), `expanded head ${s2.head}`);
      await page.evaluate(() => __vt.view.scrollToEnd());
      await settle(page);
      const s3 = await read();
      expect(!s3.mounted, 'thought row still mounted at the bottom');
      await page.evaluate(() => {
        __vt.scroller.scrollTop = 0;
      });
      await settle(page);
      const s4 = await read();
      expect(s4.mounted, 'thought row not remounted');
      expect(s4.hidden === false, 'expanded state lost on remount');
      expect((s4.head ?? '').endsWith(' ▾'), `remounted head ${s4.head}`);
      return `thought ${tid} stayed expanded across unmount/remount`;
    },
  },
  {
    name: 'V6 fallback mode',
    run: async (page) => {
      await page.evaluate(() => {
        __vt.setup(false);
        __vt.addTurns(150, 300, 0);
      });
      await settle(page);
      const count = () =>
        page.evaluate(() => ({
          rows: document.querySelectorAll('#vt .vrow').length,
          bubbles: document.querySelectorAll('#vt .bubble').length,
          processing: document.querySelectorAll('#vt .bubble.processing')
            .length,
          mounted: __vt.view.mountedCount(),
          gap: __vt.gap(),
        }));
      const r1 = await count();
      expect(
        r1.rows === 300 && r1.bubbles === 300 && r1.mounted === 300,
        `rows=${r1.rows} bubbles=${r1.bubbles} mounted=${r1.mounted}`,
      );
      await page.evaluate(() => {
        const m = __vt.model;
        m.addUser('tail question');
        m.appendAssistant('alpha ');
        m.appendAssistant('beta');
      });
      await settle(page);
      const r2 = await count();
      expect(r2.rows === 302, `after appends rows=${r2.rows}`);
      const lastText = await page.evaluate(() => {
        const rows = document.querySelectorAll('#vt .vrow');
        return rows[rows.length - 1].textContent;
      });
      expect(
        (lastText ?? '').endsWith('alpha beta'),
        `last row text ${JSON.stringify(lastText)}`,
      );
      expect(r2.gap <= 2, `fallback did not follow the bottom: gap=${r2.gap}`);
      await page.evaluate(() => __vt.model.showProcessing());
      await settle(page);
      const r3 = await count();
      expect(r3.rows === 303 && r3.processing === 1, `rows=${r3.rows}`);
      await page.evaluate(() => __vt.model.hideProcessing());
      await settle(page);
      const r4 = await count();
      expect(r4.rows === 302 && r4.processing === 0, `rows=${r4.rows}`);
      return `rows ${r1.rows} -> ${r2.rows} -> ${r3.rows} -> ${r4.rows}`;
    },
  },
  {
    name: 'V7 timers',
    run: async (page) => {
      await page.evaluate(() => {
        __vt.setup(true);
        __vt.model.addUser('q');
        __vt.model.showProcessing();
      });
      await settle(page, 0);
      const t0 = await page.evaluate(
        () =>
          document.querySelector('#vt .bubble.processing .proc-time')
            ?.textContent ?? null,
      );
      expect(t0 !== null, 'processing row has no .proc-time');
      expect(/^ · \d+s$/.test(t0 ?? ''), `time text ${JSON.stringify(t0)}`);
      const advanced = await page.evaluate(async (first) => {
        const start = performance.now();
        while (performance.now() - start < 2500) {
          await __vt.sleep(50);
          const t = document.querySelector(
            '#vt .bubble.processing .proc-time',
          )?.textContent;
          if (t && t !== first)
            return { text: t, ms: performance.now() - start };
        }
        return null;
      }, t0);
      expect(advanced !== null, 'time text did not advance within 2.5 s');
      const running = await page.evaluate(() => __vt.activeIntervals());
      expect(running === 1, `${running} intervals running, expected 1`);
      await page.evaluate(() => __vt.model.hideProcessing());
      await settle(page, 0);
      const after = await page.evaluate(() => ({
        rows: document.querySelectorAll('#vt .bubble.processing').length,
        intervals: __vt.activeIntervals(),
      }));
      expect(after.rows === 0, 'processing row still rendered');
      expect(
        after.intervals === 0,
        `${after.intervals} intervals still running`,
      );
      const writes = await page.evaluate(async () => {
        let n = 0;
        const mo = new MutationObserver((recs) => {
          n += recs.length;
        });
        mo.observe(__vt.scroller, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
        await __vt.sleep(2500);
        mo.disconnect();
        return n;
      });
      expect(writes === 0, `${writes} DOM mutations after hideProcessing()`);
      return `advanced to ${JSON.stringify(advanced!.text)} after ${Math.round(advanced!.ms)} ms; idle afterwards`;
    },
  },
  {
    name: 'V8 subagent head',
    run: async (page) => {
      await page.evaluate(() => {
        __vt.setup(true);
        const m = __vt.model;
        m.addUser('delegate this');
        m.upsertTool({
          toolCallId: 'p1',
          title: 'agent',
          status: 'in_progress',
        });
        m.appendSubagentText('p1', 'child says hi');
        m.upsertSubagentTool(
          { toolCallId: 'c1', title: 'grep', status: 'in_progress' },
          'p1',
        );
      });
      await settle(page, 0);
      const read = async () => {
        const [head, time, text, subtool, tool] = await page.evaluate(
          (sels) =>
            sels.map(
              (s) =>
                document.querySelector('#vt .bubble.tool ' + s)?.textContent ??
                null,
            ),
          [
            '.subagent > .subagent-head',
            '.subagent-head > .subagent-time',
            '.subagent > .subagent-text',
            '.subagent > .subtool',
            '> span',
          ],
        );
        return { head, time, text, subtool, tool };
      };
      const s1 = await read();
      expect(s1.head !== null, 'no subagent head rendered');
      expect(
        (s1.head ?? '').startsWith('⏳ ') &&
          (s1.head ?? '').includes('subagent running'),
        `running head ${JSON.stringify(s1.head)}`,
      );
      expect(
        /^ · \d+s$/.test(s1.time ?? ''),
        `timer ${JSON.stringify(s1.time)}`,
      );
      expect(s1.text === 'child says hi', `text ${JSON.stringify(s1.text)}`);
      expect(
        s1.subtool === '🔧 grep  [in_progress]',
        `subtool ${JSON.stringify(s1.subtool)}`,
      );
      expect(
        s1.tool === '🔧 agent  [in_progress]',
        `tool ${JSON.stringify(s1.tool)}`,
      );
      await page.evaluate(() => __vt.model.finishSubagent('p1', 'completed'));
      await settle(page, 0);
      const s2 = await read();
      expect(
        (s2.head ?? '').startsWith('✔ ') &&
          (s2.head ?? '').includes('subagent done in '),
        `done head ${JSON.stringify(s2.head)}`,
      );
      // A remounted row shows the same static duration (from endedAt), not
      // one recomputed from the current time.
      await page.evaluate(() => __vt.addTurns(60, 300, 50));
      await settle(page);
      const gone = await page.evaluate(
        () => document.querySelectorAll('#vt .bubble.tool').length === 0,
      );
      expect(gone, 'tool row still mounted at the bottom');
      await page.waitForTimeout(1200);
      await page.evaluate(() => {
        __vt.scroller.scrollTop = 0;
      });
      await settle(page);
      const s3 = await read();
      expect(
        s3.head === s2.head,
        `remounted head ${JSON.stringify(s3.head)} != ${JSON.stringify(s2.head)}`,
      );
      return `running -> ${JSON.stringify(s2.head)}; same after remount`;
    },
  },
];

async function runViewSection(viewer: Viewer): Promise<Result[]> {
  const { page, url } = viewer;
  await page.route(`${url}/ui/__vt.html`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: VT_HTML,
    }),
  );
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const results: Result[] = [];
  for (const s of VIEW_SCENARIOS) {
    errors.length = 0;
    let result: Result;
    try {
      await page.goto(`${url}/ui/__vt.html`);
      await page.evaluate(() => __vt.loadCore());
      const detail = await s.run(page);
      expect(errors.length === 0, `page errors: ${errors.join(' | ')}`);
      result = { name: s.name, ok: true, detail };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const extra = errors.length
        ? ` [page errors: ${errors.join(' | ')}]`
        : '';
      result = { name: s.name, ok: false, detail: msg.split('\n')[0] + extra };
    }
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'} ${result.name} — ${result.detail}`,
    );
    results.push(result);
  }
  return results;
}

const SECTIONS: Record<string, (viewer: Viewer) => Promise<Result[]>> = {
  view: runViewSection,
};

async function main(): Promise<void> {
  const wanted = process.argv[2] ?? process.env['SECTION'] ?? 'all';
  const names = wanted === 'all' ? Object.keys(SECTIONS) : [wanted];
  for (const n of names) {
    if (!SECTIONS[n]) throw new Error(`unknown section ${n}`);
  }
  const results: Result[] = [];
  for (const n of names) {
    console.log(`== section ${n}`);
    const viewer = await bootViewer();
    try {
      results.push(...(await SECTIONS[n]!(viewer)));
    } finally {
      await viewer.close();
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
