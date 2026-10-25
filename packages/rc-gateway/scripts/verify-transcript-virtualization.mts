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
 *
 * Section `page` drives the shipped public/index.html: each scenario boots its
 * own gateway + stub daemon (with that scenario's frames, the stream held
 * open) and browser, opens /ui/ and works through the page's globals
 * (startWatch, renderFrame, addUser, transcriptModel, transcriptView, ...).
 * `window.prompt`/`confirm` dialogs are dismissed. P9 runs
 * scripts/measure-viewer-growth.mts at 200, 1000 and 2000 turns.
 *
 *   ONLY=P4 npx tsx scripts/verify-transcript-virtualization.mts page
 *   ONLY=V9,V10 npx tsx scripts/verify-transcript-virtualization.mts view
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Page } from 'playwright';
import { bootViewer, type Frame, type Viewer } from './lib/viewerHarness.mjs';

const execFileAsync = promisify(execFile);

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

  // Time spent in requestAnimationFrame callbacks (the view's render pass,
  // virtual-core's scroll reconciliation) while rafClock.on is set.
  var rafClock = { on: false, ms: 0 };
  var realRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return realRaf.call(window, function (t) {
      if (!rafClock.on) return cb(t);
      var t0 = performance.now();
      try {
        cb(t);
      } finally {
        rafClock.ms += performance.now() - t0;
      }
    });
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

  var FENCE = String.fromCharCode(96, 96, 96); // a code fence
  // A markdown-style answer, as the daemon sends them: a short list and an
  // 18-line code block (bubbles keep newlines: white-space: pre-wrap).
  function md(t) {
    var s = 'Here is what I found for turn ' + t + ':\n\n' +
      '1. First point about the code path\n2. Second point\n' +
      '3. Third point\n\n' + FENCE + 'ts\n';
    for (var i = 0; i < 18; i++) {
      s += 'const value' + i + ' = compute(' + i + ');\n';
    }
    return s + FENCE + '\n\nThat should fix it.';
  }
  function addMdTurns(n, seed) {
    for (var i = 0; i < n; i++) {
      state.model.addUser(
        'question ' + (seed + i) + ': why does the build fail on the phone?',
      );
      state.model.appendAssistant(md(seed + i));
    }
  }
  // n turns, each answer made of that many short lines.
  function addLineTurns(n, lines) {
    var answer = '';
    for (var i = 0; i < lines; i++) answer += 'line ' + i + '\n';
    for (var j = 0; j < n; j++) {
      state.model.addUser('question ' + j);
      state.model.appendAssistant(answer + j);
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

  // The top-most row still visible at the scroller's top edge (the one
  // crossing it, or the next one when the edge falls between two rows), and
  // its offset from that edge.
  function topRow() {
    var top = scroller.getBoundingClientRect().top;
    var best = null;
    scroller.querySelectorAll('.vrow').forEach(function (r) {
      var b = r.getBoundingClientRect();
      if (b.bottom - top > 0 && (!best || b.top - top < best.y)) {
        best = { id: Number(r.getAttribute('data-id')), y: b.top - top };
      }
    });
    return best;
  }
  // A row's top and bottom relative to the scroller's top edge.
  function rowBox(id) {
    var r = row(id);
    if (!r) return null;
    var edge = scroller.getBoundingClientRect().top;
    var b = r.getBoundingClientRect();
    return { top: b.top - edge, bottom: b.bottom - edge };
  }
  function rowTop(id) {
    var r = row(id);
    return r
      ? r.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      : null;
  }
  // Scrolls from the top to the end a viewport at a time, so every row is
  // mounted (and measured) once at the current width.
  async function sweepDown() {
    scroller.scrollTop = 0;
    await settle(200);
    for (var k = 0; k < 2000 && gap() > 1; k++) {
      scroller.scrollTop += scroller.clientHeight;
      await settle(0);
    }
  }
  // Scrolls up by step px at a time (at most maxSteps times) and returns,
  // per step, how far the row at the top edge moved beyond the scroll itself
  // (0: the content moved exactly with the scroll; null: the row is gone).
  async function scrollBack(step, maxSteps) {
    var out = [];
    for (var i = 0; i < maxSteps; i++) {
      var a = topRow();
      if (!a || scroller.scrollTop < step + 100) break;
      scroller.scrollTop -= step;
      await sleep(350);
      var y = rowTop(a.id);
      out.push(y === null ? null : Math.round(y - a.y - step));
    }
    return out;
  }

  // A synthetic touch event on the scroller: virtual-core and the view only
  // look at the event type (and the view at touches.length, absent here).
  function touch(type) {
    scroller.dispatchEvent(new Event(type));
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
    addMdTurns: addMdTurns,
    addLineTurns: addLineTurns,
    gap: gap,
    frame: frame,
    sleep: sleep,
    settle: settle,
    row: row,
    touch: touch,
    topRow: topRow,
    rowBox: rowBox,
    sweepDown: sweepDown,
    scrollBack: scrollBack,
    rafClock: rafClock,
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
<meta name="viewport" content="width=device-width,initial-scale=1">
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
  setPlan(entries: unknown[]): void;
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
  addMdTurns(n: number, seed: number): void;
  addLineTurns(n: number, lines: number): void;
  gap(): number;
  frame(): Promise<void>;
  sleep(ms: number): Promise<void>;
  settle(minMs?: number): Promise<boolean>;
  row(id: number): HTMLElement | null;
  touch(type: string): void;
  topRow(): { id: number; y: number } | null;
  rowBox(id: number): { top: number; bottom: number } | null;
  sweepDown(): Promise<void>;
  scrollBack(step: number, maxSteps: number): Promise<Array<number | null>>;
  rafClock: { on: boolean; ms: number };
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

// `ONLY=V9,P4` runs just those scenarios (matched on the name's first word).
function selected(name: string): boolean {
  const only = process.env['ONLY'];
  if (!only) return true;
  const id = name.split(' ')[0];
  return only.split(',').some((s) => s.trim() === id);
}

async function routeVt(page: Page, origin: string): Promise<void> {
  await page.route(`${origin}/ui/__vt.html`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: VT_HTML,
    }),
  );
}

// virtual-core takes its iOS WebKit path (deferred scroll corrections) by
// user agent alone, so Chromium with an iPhone UA runs that path.
const MOBILE_UA = {
  ios:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
};

/**
 * Runs `fn` on the test page in a fresh phone-sized context (390x844, touch)
 * of the section's browser, with the given user agent. Page and console
 * errors there fail the scenario.
 */
async function onPhone<T>(
  page: Page,
  userAgent: string,
  fn: (p: Page) => Promise<T>,
): Promise<T> {
  const ctx = await page
    .context()
    .browser()!
    .newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent,
    });
  const errors: string[] = [];
  try {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const origin = new URL(page.url()).origin;
    await routeVt(p, origin);
    await p.goto(`${origin}/ui/__vt.html`);
    await p.evaluate(() => __vt.loadCore());
    const out = await fn(p);
    expect(errors.length === 0, `page errors: ${errors.join(' | ')}`);
    return out;
  } finally {
    await ctx.close();
  }
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
    // Today's head.onclick only toggles `hidden`: nothing scrolls, so the
    // clicked header stays put and the body opens downward.
    name: 'V5b expand-latest-while-pinned',
    run: async (page) => {
      const details: string[] = [];
      for (const virtual of [true, false]) {
        const mode = virtual ? 'virtual' : 'fallback';
        await page.evaluate((v) => {
          __vt.setup(v);
          const m = __vt.model;
          __vt.addTurns(30, 300, 0);
          m.addUser('think hard');
          m.appendThought('pondering ' + __vt.text(3000, 5));
          m.finishThought();
        }, virtual);
        await settle(page);
        const tid = await page.evaluate(() => {
          const items = __vt.model.items;
          const last = items[items.length - 1];
          return last.kind === 'thought' ? last.id : -1;
        });
        expect(tid > 0, `${mode}: latest item is not the thought`);
        const read = () =>
          page.evaluate((id) => {
            const row = __vt.row(id);
            const head = row && row.querySelector('.thought-head');
            const body = row && row.querySelector('.thought-body');
            return {
              top: head ? head.getBoundingClientRect().top : null,
              hidden: body ? (body as HTMLElement).hidden : null,
              bodyHeight: body ? body.getBoundingClientRect().height : 0,
              gap: __vt.gap(),
              near: __vt.view.isNearBottom(),
            };
          }, tid);
        const s0 = await read();
        expect(
          s0.top !== null && s0.hidden === true,
          `${mode}: folded thought not rendered`,
        );
        expect(s0.gap <= 2 && s0.near, `${mode}: not pinned: gap=${s0.gap}`);
        const head = `#vt .vrow[data-id="${tid}"] .thought-head`;
        await page.click(head);
        await settle(page);
        const s1 = await read();
        expect(s1.hidden === false, `${mode}: body hidden after expand`);
        expect(
          s1.bodyHeight >= 200,
          `${mode}: expanded body only ${s1.bodyHeight}px`,
        );
        expect(
          s1.top !== null && Math.abs(s1.top - s0.top!) <= 2,
          `${mode}: expand moved the head ${s0.top} -> ${s1.top}`,
        );
        expect(
          s1.near === s1.gap < 80,
          `${mode}: isNearBottom()=${s1.near} with gap=${s1.gap}`,
        );
        expect(!s1.near, `${mode}: still near the bottom (gap=${s1.gap})`);
        await page.click(head);
        await settle(page);
        const s2 = await read();
        expect(s2.hidden === true, `${mode}: body visible after collapse`);
        expect(
          s2.top !== null && Math.abs(s2.top - s0.top!) <= 2,
          `${mode}: collapse moved the head ${s0.top} -> ${s2.top}`,
        );
        expect(
          s2.near === s2.gap < 80,
          `${mode}: isNearBottom()=${s2.near} with gap=${s2.gap}`,
        );
        // Streaming after the toggle still follows the bottom.
        await page.evaluate(async () => {
          for (let k = 0; k < 20; k++) {
            __vt.model.appendAssistant(__vt.text(200, 40 + k));
            await __vt.frame();
          }
        });
        await settle(page);
        const g = await gap(page);
        expect(g <= 2, `${mode}: streaming after the toggle: gap=${g}`);
        details.push(
          `${mode}: head ${s0.top} -> ${s1.top} -> ${s2.top}, body ${Math.round(s1.bodyHeight)}px`,
        );
      }
      return details.join('; ');
    },
  },
  {
    // #64. Tapping a tool row opens the call and its result, the head does not
    // jump, the state lives on the item so it survives the virtual core
    // rebuilding the row, and a call with nothing to show has no affordance.
    name: 'V5c tool expand',
    run: async (page) => {
      await page.evaluate(() => {
        __vt.setup(true);
        const m = __vt.model;
        m.addUser('read it');
        m.upsertTool({
          toolCallId: 'tc1',
          title: 'Read src/a.ts',
          status: 'pending',
          rawInput: { file_path: '/x/src/a.ts' },
        });
        m.upsertTool({
          toolCallId: 'tc1',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'file body' } },
          ],
        });
        // A frame that carried neither input nor output.
        m.upsertTool({ toolCallId: 'tc2', title: 'Bare', status: 'pending' });
        m.appendAssistant('answer');
        __vt.addTurns(100, 300, 10);
        // A call at the tail: the view sits at the end there, which is where
        // opening a row can pull the tapped line out of place.
        m.upsertTool({
          toolCallId: 'tc3',
          title: 'Tail call',
          status: 'completed',
          rawInput: { command: 'ls' },
          rawOutput: 'a\nb\nc\nd\ne\nf\ng\nh',
        });
      });
      await settle(page);
      const ids = await page.evaluate(() => [
        __vt.model.items.find((i) => i.toolCallId === 'tc1')!.id,
        __vt.model.items.find((i) => i.toolCallId === 'tc2')!.id,
        __vt.model.items.find((i) => i.toolCallId === 'tc3')!.id,
      ]);
      const tid = ids[0]!;
      const bare = ids[1]!;
      const tail = ids[2]!;
      const read = (id: number) =>
        page.evaluate((i) => {
          const row = __vt.row(i);
          const head = row && row.querySelector('.bubble.tool .tool-head');
          const det = row && row.querySelector('.bubble.tool .tool-detail');
          // Measured, not attribute read: the detail's own display rule would
          // keep a hidden one on screen if the [hidden] reassert were missing.
          const vis =
            !!det && !(det as HTMLElement).hidden && det.offsetHeight > 0;
          return {
            mounted: !!row,
            head: head ? (head.textContent ?? '') : null,
            top: head ? Math.round(head.getBoundingClientRect().top) : null,
            // The detail node is only built once a row is opened, so "shown" is
            // what the reader can see, not whether a node happens to exist.
            shown: vis,
            height: det ? det.offsetHeight : null,
            rowText: row ? (row.textContent ?? '') : '',
            detail: det ? (det.textContent ?? '') : null,
          };
        }, id);
      await page.evaluate(() => {
        __vt.scroller.scrollTop = 0;
      });
      await settle(page);
      const s1 = await read(tid);
      expect(s1.mounted, 'tool row is not mounted at the top');
      expect(!s1.shown, 'tool detail is visible before the tap');
      expect(
        !s1.rowText.includes('file_path'),
        'the call input is readable while the row is collapsed',
      );
      expect(
        (s1.head ?? '').endsWith(' ▸'),
        `collapsed head ${JSON.stringify(s1.head)}`,
      );
      const b1 = await read(bare);
      expect(
        !b1.shown && !/▸|▾/.test(b1.head ?? ''),
        `a call with no detail got an affordance: ${JSON.stringify(b1.head)}`,
      );
      await page.click(`#vt .vrow[data-id="${tid}"] .tool-head`);
      await settle(page, 0);
      const s2 = await read(tid);
      expect(s2.shown, 'detail still not shown after the tap');
      expect(
        !!s2.detail &&
          s2.detail.includes('file_path') &&
          s2.detail.includes('file body'),
        `detail text ${JSON.stringify(s2.detail)}`,
      );
      expect((s2.head ?? '').endsWith(' ▾'), `expanded head ${s2.head}`);
      expect(
        s1.top !== null && s2.top !== null && Math.abs(s2.top - s1.top) <= 2,
        `the tap moved the head ${s1.top} -> ${s2.top}`,
      );
      // Unmount and remount through the virtual core.
      await page.evaluate(() => __vt.view.scrollToEnd());
      await settle(page);
      const s3 = await read(tid);
      expect(!s3.mounted, 'tool row still mounted at the bottom');
      await page.evaluate(() => {
        __vt.scroller.scrollTop = 0;
      });
      await settle(page);
      const s4 = await read(tid);
      expect(s4.mounted, 'tool row did not remount');
      expect(s4.shown, 'expanded state lost on remount');
      expect(
        !!s4.detail && s4.detail.includes('file body'),
        'detail text lost on remount',
      );
      // Tapping the tail row while the view sits at the end: virtual-core
      // keeps a growing row's bottom in place there, so without the hold the
      // tapped line is pulled up by the height of the detail.
      await page.evaluate(() => __vt.view.scrollToEnd());
      await settle(page);
      const t1 = await read(tail);
      expect(
        t1.mounted && !t1.shown,
        `tail tool row is not collapsed at the end: ${JSON.stringify(t1.head)}`,
      );
      await page.click(`#vt .vrow[data-id="${tail}"] .tool-head`);
      await settle(page, 0);
      const t2 = await read(tail);
      expect(t2.shown, 'tail detail did not open');
      expect(
        t1.top !== null && t2.top !== null && Math.abs(t2.top - t1.top) <= 2,
        `tapping at the end moved the head ${t1.top} -> ${t2.top}`,
      );
      // Tap again to close: the detail node stays in the tree, hidden, so what
      // the reader sees depends on the hidden flag surviving the patch pass.
      // (This section has no index.html CSS; P16 covers the real page.)
      await page.click(`#vt .vrow[data-id="${tail}"] .tool-head`);
      await settle(page, 0);
      const t3 = await read(tail);
      expect(!t3.shown, `detail still on screen after closing: ${t3.height}`);
      expect(
        (t3.head ?? '').endsWith(' ▸'),
        `head after closing ${JSON.stringify(t3.head)}`,
      );
      return `tool ${tid} opened without moving, stayed open across remount`;
    },
  },
  {
    name: 'V5d to-do row',
    run: async (page) => {
      await page.evaluate(() => {
        __vt.setup(true);
        const m = __vt.model;
        m.addUser('do the thing');
        m.setPlan([
          { content: 'read the code', status: 'pending' },
          { content: 'change it', status: 'pending' },
        ]);
        __vt.addTurns(100, 300, 10);
      });
      await settle(page);
      // The view follows the appended turns to the end, so go back to the top
      // where the to-do row sits.
      await page.evaluate(() => {
        __vt.scroller.scrollTop = 0;
      });
      await settle(page);
      const pid = await page.evaluate(
        () => __vt.model.items.find((i) => i.kind === 'plan')!.id,
      );
      const read = () =>
        page.evaluate((i) => {
          const row = __vt.row(i);
          const body = row && row.querySelector('.bubble.plan .plan-list');
          return {
            mounted: !!row,
            rows: document.querySelectorAll('#vt .bubble.plan').length,
            text: body ? (body.textContent ?? '') : '',
          };
        }, pid);
      const s1 = await read();
      expect(s1.mounted, 'the to-do row is not mounted at the top');
      expect(s1.rows === 1, `${s1.rows} to-do rows on screen`);
      expect(
        s1.text.includes('2 open') && s1.text.includes('read the code'),
        `first frame ${JSON.stringify(s1.text)}`,
      );
      // The daemon re-emits the whole list: the same row is rewritten, the
      // completed entry leaves it, and the count is what says it happened.
      await page.evaluate(() => {
        __vt.model.setPlan([
          { content: 'read the code', status: 'completed' },
          { content: 'change it', status: 'in_progress' },
          { content: 'test it', status: 'pending' },
        ]);
      });
      await settle(page, 0);
      const s2 = await read();
      expect(s2.rows === 1, `${s2.rows} to-do rows after an update`);
      expect(
        s2.text.includes('1 of 3 done') &&
          !s2.text.includes('read the code') &&
          s2.text.includes('▸ change it'),
        `after a completion ${JSON.stringify(s2.text)}`,
      );
      // A long plan is bounded, and says how many are off screen.
      await page.evaluate(() => {
        const many: unknown[] = [];
        for (let k = 0; k < 12; k++) {
          many.push({ content: `step ${k}`, status: 'pending' });
        }
        __vt.model.setPlan(many);
      });
      await settle(page, 0);
      const s3 = await read();
      expect(
        s3.text.includes('step 0') &&
          !s3.text.includes('step 6') &&
          s3.text.includes('6 more'),
        `bounded list ${JSON.stringify(s3.text)}`,
      );
      // Through the virtual core and back: the state is on the item, so the
      // row comes back as it was.
      await page.evaluate(() => __vt.view.scrollToEnd());
      await settle(page);
      expect(!(await read()).mounted, 'to-do row still mounted at the end');
      await page.evaluate(() => {
        __vt.scroller.scrollTop = 0;
      });
      await settle(page);
      const s4 = await read();
      expect(s4.mounted, 'to-do row did not remount');
      expect(s4.text === s3.text, 'to-do row came back different');
      return `one row rewritten in place; ${s2.text
        .split('\n')[0]
        .trim()}; bounded with a hidden count; survived remount`;
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
  {
    // On iOS WebKit (detected by user agent) virtual-core defers its scroll
    // corrections while a finger is down or the scroller is scrolling and
    // replays their sum once things settle. A finger rests on the transcript
    // while the answer streams; then the reader either drags up 1500 px and
    // lets go (must stay exactly there, jump pill shown) or just lets go
    // (must still follow the end). Same checks with an Android user agent.
    name: 'V9 touch while streaming',
    run: async (page) => {
      const problems: string[] = [];
      const details: string[] = [];
      for (const [os, ua] of Object.entries(MOBILE_UA)) {
        await onPhone(page, ua, async (p) => {
          const seen: string[] = [];
          const cases = [
            { chunks: 1, drag: true, end: 'touchend' },
            { chunks: 1, drag: false, end: 'touchend' },
            { chunks: 20, drag: true, end: 'touchend' },
            { chunks: 20, drag: false, end: 'touchend' },
            { chunks: 20, drag: false, end: 'touchcancel' },
          ];
          for (const { chunks, drag, end } of cases) {
            const r = await p.evaluate(
              async ([chunks, drag, end]) => {
                __vt.setup(true);
                __vt.addTurns(60, 330, 0);
                __vt.model.addUser('stream please');
                __vt.model.appendAssistant('start ');
                const settled = await __vt.settle(400);
                const s = __vt.scroller;
                const gapBefore = __vt.gap();
                // Pinned for the touch part even if the first render was
                // not (gapBefore reports that one).
                __vt.view.scrollToEnd();
                const pinned = await __vt.settle(400);
                const gapPinned = __vt.gap();
                __vt.touch('touchstart');
                const held = s.scrollTop;
                for (let k = 0; k < chunks; k++) {
                  __vt.model.appendAssistant(__vt.text(216, 100 + k) + ' ');
                  await __vt.frame();
                  await __vt.frame();
                }
                const heldMoved = s.scrollTop - held;
                if (drag) s.scrollTop -= 1500;
                await __vt.frame();
                const top = s.scrollTop;
                __vt.touch(end);
                await __vt.sleep(700);
                const settledAfter = await __vt.settle(300);
                return {
                  settled: settled && pinned && settledAfter,
                  gapBefore: Math.round(gapBefore),
                  gapPinned: Math.round(gapPinned),
                  heldMoved: Math.round(heldMoved),
                  moved: Math.round(s.scrollTop - top),
                  gap: Math.round(__vt.gap()),
                  near: __vt.view.isNearBottom(),
                };
              },
              [chunks, drag, end] as const,
            );
            const what = `${os} ${chunks} chunk(s) ${drag ? 'drag up' : 'no drag'} ${end}`;
            if (!r.settled) problems.push(`${what}: did not settle`);
            if (r.gapBefore > 2) {
              problems.push(`${what}: initial render ${r.gapBefore}px short`);
            }
            if (r.gapPinned > 2) {
              problems.push(`${what}: scrollToEnd() ${r.gapPinned}px short`);
            }
            // Under a resting finger the view does not scroll to follow
            // (on Android virtual-core itself still keeps the end in view).
            if (os === 'ios' && Math.abs(r.heldMoved) > 2) {
              problems.push(
                `${what}: scrolled ${r.heldMoved}px under the finger`,
              );
            }
            if (drag) {
              if (Math.abs(r.moved) > 2) {
                problems.push(`${what}: moved ${r.moved}px after release`);
              }
              if (r.near) problems.push(`${what}: pill hidden (gap ${r.gap})`);
            } else if (r.gap > 2 || !r.near) {
              problems.push(`${what}: not pinned (gap ${r.gap})`);
            }
            seen.push(
              `${chunks}${drag ? 'd' : ''}${end === 'touchcancel' ? 'c' : ''}: ` +
                (drag ? `moved ${r.moved}` : `gap ${r.gap}`),
            );
          }
          details.push(`${os} [${seen.join(', ')}]`);
        });
      }
      expect(problems.length === 0, problems.join('; '));
      return details.join('; ');
    },
  },
  {
    // Touch events stay aimed at the element the finger came down on. When
    // that element leaves the DOM mid-touch (the live thinking bubble is
    // folded by the first answer chunk, a row is unmounted), its touchend
    // never reaches the scroller. (A) a finger on the live thought when the
    // answer starts, lifted on the detached node: the answer must still be
    // followed. (B) a row touched, dragged out of the mounted range and
    // lifted there, then the reader taps the jump pill: following must
    // resume. (C) as B, but the reader stays in the middle and a row wholly
    // above the viewport grows: the text they read must not move (iOS:
    // virtual-core must not stay in its finger-down state).
    name: 'V9b touched row removed mid-touch',
    run: async (page) => {
      const problems: string[] = [];
      const details: string[] = [];
      for (const [os, ua] of Object.entries(MOBILE_UA)) {
        await onPhone(page, ua, async (p) => {
          const a = await p.evaluate(async () => {
            __vt.setup(true);
            const m = __vt.model;
            __vt.addTurns(30, 330, 0);
            m.addUser('think, then answer');
            m.appendThought('thinking hard about it. ');
            await __vt.settle(400);
            __vt.view.scrollToEnd();
            await __vt.settle(400);
            const items = m.items;
            const row = __vt.row(items[items.length - 1]!.id);
            const th = row && row.querySelector('.bubble');
            if (!th) return null;
            th.dispatchEvent(new Event('touchstart', { bubbles: true }));
            m.appendAssistant('answer: ' + __vt.text(200, 7));
            await __vt.frame();
            await __vt.frame();
            await __vt.sleep(100);
            const detached = !th.isConnected;
            th.dispatchEvent(new Event('touchend', { bubbles: true }));
            await __vt.sleep(300);
            await __vt.settle(200);
            const gaps: number[] = [];
            for (let k = 0; k < 10; k++) {
              m.appendAssistant(' ' + __vt.text(300, 50 + k));
              await __vt.frame();
              await __vt.frame();
              gaps.push(Math.round(__vt.gap()));
            }
            await __vt.sleep(700);
            await __vt.settle(200);
            return {
              detached,
              gaps,
              gap: Math.round(__vt.gap()),
              near: __vt.view.isNearBottom(),
            };
          });
          const b = await p.evaluate(async () => {
            __vt.setup(true);
            const m = __vt.model;
            const s = __vt.scroller;
            __vt.addTurns(60, 330, 0);
            m.addUser('stream please');
            m.appendAssistant('start ' + __vt.text(1000, 9));
            await __vt.settle(400);
            s.scrollTop -= 1200;
            await __vt.sleep(300);
            await __vt.settle(200);
            const top = __vt.topRow();
            const row = top && __vt.row(top.id);
            const target = row && row.querySelector('.bubble');
            if (!target) return null;
            target.dispatchEvent(new Event('touchstart', { bubbles: true }));
            s.scrollTop = 0;
            await __vt.sleep(300);
            await __vt.settle(200);
            const detached = !target.isConnected;
            target.dispatchEvent(new Event('touchend', { bubbles: true }));
            await __vt.sleep(300);
            __vt.view.scrollToEnd(); // the jump pill
            await __vt.sleep(300);
            await __vt.settle(200);
            const gapPinned = Math.round(__vt.gap());
            const gaps: number[] = [];
            for (let k = 0; k < 10; k++) {
              m.appendAssistant(' ' + __vt.text(300, 70 + k));
              await __vt.frame();
              await __vt.frame();
              gaps.push(Math.round(__vt.gap()));
            }
            await __vt.sleep(700);
            await __vt.settle(200);
            return {
              detached,
              gapPinned,
              gaps,
              gap: Math.round(__vt.gap()),
              near: __vt.view.isNearBottom(),
            };
          });
          const c = await p.evaluate(async () => {
            __vt.setup(true);
            const m = __vt.model;
            const s = __vt.scroller;
            __vt.addTurns(60, 330, 0);
            await __vt.settle(400);
            s.scrollTop = Math.floor(s.scrollHeight / 2);
            await __vt.sleep(300);
            await __vt.settle(200);
            const top = __vt.topRow();
            const row = top && __vt.row(top.id);
            const target = row && row.querySelector('.bubble');
            if (!target) return null;
            target.dispatchEvent(new Event('touchstart', { bubbles: true }));
            s.scrollTop -= 3000;
            await __vt.sleep(300);
            await __vt.settle(200);
            const detached = !target.isConnected;
            target.dispatchEvent(new Event('touchend', { bubbles: true }));
            await __vt.sleep(700);
            await __vt.settle(300);
            // A mounted row wholly above the viewport grows by several lines.
            const ref = __vt.topRow();
            if (!ref) return null;
            const at = m.items.findIndex((i) => i.id === ref.id);
            const above = m.items[at - 2];
            if (!above || !__vt.row(above.id)) return null;
            above.text += ' ' + __vt.text(600, 3);
            m.touch(above);
            await __vt.frame();
            await __vt.frame();
            await __vt.sleep(400);
            await __vt.settle(200);
            const r = __vt.row(ref.id);
            const y = r
              ? r.getBoundingClientRect().top - s.getBoundingClientRect().top
              : null;
            return {
              detached,
              moved: y === null ? null : Math.round(y - ref.y),
            };
          });
          if (!a || !b || !c) {
            problems.push(`${os}: setup failed (${!!a}/${!!b}/${!!c})`);
            return;
          }
          if (!a.detached || !b.detached || !c.detached) {
            problems.push(`${os}: touched node not detached`);
          }
          const aMax = Math.max(...a.gaps);
          if (aMax > 2 || a.gap > 2 || !a.near) {
            problems.push(
              `${os} A (thought folded): not following, gaps [${a.gaps.join(',')}] end ${a.gap}`,
            );
          }
          const bMax = Math.max(...b.gaps);
          if (b.gapPinned > 2 || bMax > 2 || b.gap > 2 || !b.near) {
            problems.push(
              `${os} B (row unmounted, pill): not following, pinned ${b.gapPinned}, gaps [${b.gaps.join(',')}] end ${b.gap}`,
            );
          }
          if (c.moved === null || Math.abs(c.moved) > 2) {
            problems.push(
              `${os} C (row above grows): reader's text moved ${c.moved}px`,
            );
          }
          details.push(
            `${os} A max gap ${aMax}, B max gap ${bMax}, C moved ${c.moved}`,
          );
        });
      }
      expect(problems.length === 0, problems.join('; '));
      return details.join('; ');
    },
  },
  {
    // Rows above the viewport that were never measured enter with their
    // estimated height, and virtual-core does not correct the scroll
    // position for them while the reader scrolls up: a poor estimate shows
    // as the text jumping. Typical answers (a list, a code block) are mostly
    // newlines. Phone width, 300 px steps up from the end.
    name: 'V10 scroll back through multi-line answers',
    run: async (page) =>
      onPhone(page, MOBILE_UA.android, async (p) => {
        const steps = await p.evaluate(async () => {
          __vt.setup(true);
          __vt.addMdTurns(300, 0);
          await __vt.settle(400);
          return __vt.scrollBack(300, 25);
        });
        const lost = steps.filter((v) => v === null).length;
        const abs = steps.filter((v) => v !== null).map((v) => Math.abs(v!));
        const max = Math.max(0, ...abs);
        const over = abs.filter((v) => v > 20).length;
        expect(steps.length >= 20, `only ${steps.length} steps`);
        expect(lost === 0, `${lost} step(s) lost the row at the top edge`);
        expect(
          max <= 20,
          `text jumped up to ${max}px in one step (${over}/${abs.length} steps over 20px): [${steps.join(',')}]`,
        );
        // Every append makes virtual-core rebuild its layout, estimating
        // each row it has not measured: the line count must come from a
        // cache, not a fresh scan of every answer's text per frame.
        const cost: number[] = [];
        for (const n of [200, 2000]) {
          cost.push(
            await p.evaluate(async (n) => {
              __vt.setup(true);
              __vt.addLineTurns(n, 600);
              await __vt.settle(300);
              let best = Infinity;
              for (let round = 0; round < 3; round++) {
                __vt.rafClock.ms = 0;
                __vt.rafClock.on = true;
                for (let k = 0; k < 20; k++) {
                  __vt.model.addUser('more ' + k);
                  await __vt.frame();
                }
                __vt.rafClock.on = false;
                best = Math.min(best, __vt.rafClock.ms / 20);
              }
              return best;
            }, n),
          );
        }
        const [small, big] = cost as [number, number];
        expect(
          big <= Math.max(4 * small, 2),
          `per-append frame cost ${small.toFixed(2)} ms at 200 turns -> ${big.toFixed(2)} ms at 2000`,
        );
        return (
          `${abs.length} steps, max jump ${max}px; per-append frame ` +
          `${small.toFixed(2)} ms (200 turns) / ${big.toFixed(2)} ms (2000)`
        );
      }),
  },
  {
    // virtual-core keeps every row's measured height until the row is
    // measured again, also across a width change (a phone rotating). Rows
    // measured in portrait and then unmounted are re-measured on the way
    // back in landscape, and the text lurches as in V10. After rotating,
    // scrolling back must behave as on a transcript laid out in landscape
    // from the start (whose rows enter with their estimate). Pinned at the
    // end the view stays there; a reader in the middle keeps the row at the
    // top edge where it was.
    name: 'V11 rotate the phone',
    run: async (page) =>
      onPhone(page, MOBILE_UA.android, async (p) => {
        const readTop = () =>
          p.evaluate(() => {
            const a = __vt.topRow();
            return {
              id: a ? a.id : -1,
              y: a ? Math.round(a.y) : 0,
              gap: Math.round(__vt.gap()),
              near: __vt.view.isNearBottom(),
            };
          });
        const rotate = async (width: number, height: number) => {
          await p.setViewportSize({ width, height });
          expect(
            await p.evaluate(() => __vt.settle(400)),
            'did not settle after the rotation',
          );
        };
        const jumps = (steps: Array<number | null>) => {
          const abs = steps.filter((v) => v !== null).map((v) => Math.abs(v!));
          return {
            n: abs.length,
            lost: steps.length - abs.length,
            max: Math.max(0, ...abs),
            list: steps.join(','),
          };
        };
        // Baseline: laid out in landscape from the start.
        await p.setViewportSize({ width: 844, height: 390 });
        const base = jumps(
          await p.evaluate(async () => {
            __vt.setup(true);
            __vt.addTurns(30, 1000, 0);
            await __vt.settle(400);
            return __vt.scrollBack(300, 20);
          }),
        );
        // Every row measured in portrait, then rotated at the end.
        await p.setViewportSize({ width: 390, height: 844 });
        await p.evaluate(async () => {
          __vt.setup(true);
          __vt.addTurns(30, 1000, 0);
          await __vt.sweepDown();
        });
        const end0 = await readTop();
        expect(end0.gap <= 2 && end0.near, `not at the end: ${end0.gap}`);
        await rotate(844, 390);
        const end1 = await readTop();
        const back = jumps(await p.evaluate(() => __vt.scrollBack(300, 20)));
        // A reader in the middle rotates back to portrait.
        await p.evaluate(async () => {
          __vt.scroller.scrollTop = __vt.scroller.scrollHeight / 2;
          await __vt.settle(400);
        });
        const mid0 = await readTop();
        await rotate(390, 844);
        const mid1 = await readTop();
        const problems: string[] = [];
        if (end1.gap > 2 || !end1.near) {
          problems.push(`left the end on rotating: gap ${end1.gap}`);
        }
        if (back.n < 10 || base.n < 10) {
          problems.push(`only ${back.n} (baseline ${base.n}) steps`);
        }
        if (back.lost) problems.push(`${back.lost} step(s) lost the top row`);
        if (back.max > base.max + 2) {
          problems.push(
            `text jumped up to ${back.max}px scrolling back after rotating ` +
              `(${base.max}px laid out in landscape): [${back.list}]`,
          );
        }
        if (mid1.id !== mid0.id || Math.abs(mid1.y - mid0.y) > 2) {
          problems.push(
            `reader moved on rotating: row ${mid0.id}@${mid0.y} -> ${mid1.id}@${mid1.y}`,
          );
        }
        expect(problems.length === 0, problems.join('; '));
        return (
          `end kept (gap ${end1.gap}); scrolling back max jump ${back.max}px ` +
          `(landscape from the start ${base.max}px); reader row ` +
          `${mid0.id}@${mid0.y} -> ${mid1.id}@${mid1.y}`
        );
      }),
  },
  {
    // A reader scrolled up into the answer that is still streaming: the
    // viewport's top edge is inside that (growing) row, 400 px above the end
    // or 40 px below the row's start. The text grows below them; nothing
    // they are reading may move, and the jump pill stays shown. Desktop,
    // Android and iPhone user agents, and the iPhone with a resting finger.
    name: 'V12 reader inside the streaming answer',
    run: async (page) => {
      const problems: string[] = [];
      const details: string[] = [];
      const read = (p: Page, pos: string, touch: boolean) =>
        p.evaluate(
          async ([pos, touch]) => {
            const s = __vt.scroller;
            __vt.setup(true);
            const m = __vt.model;
            __vt.addTurns(20, 330, 0);
            m.addUser('stream please');
            m.appendAssistant('start ' + __vt.text(9000, 999));
            await __vt.settle(400);
            const items = m.items;
            const id = items[items.length - 1]!.id;
            if (pos === 'end400') {
              s.scrollTop = s.scrollHeight - s.clientHeight - 400;
            } else {
              const b0 = __vt.rowBox(id);
              if (b0) s.scrollTop += b0.top + 40;
            }
            await __vt.sleep(300);
            await __vt.settle(200);
            const b1 = __vt.rowBox(id);
            const inside = !!b1 && b1.top < 0 && b1.bottom > 0;
            const top0 = s.scrollTop;
            const node = __vt.row(id)?.querySelector('.bubble') ?? s;
            if (touch) {
              node.dispatchEvent(new Event('touchstart', { bubbles: true }));
            }
            const moves: number[] = [];
            for (let k = 0; k < 10; k++) {
              m.appendAssistant(' ' + __vt.text(300, 200 + k));
              await __vt.frame();
              await __vt.frame();
              moves.push(Math.round(s.scrollTop - top0));
            }
            if (touch) {
              node.dispatchEvent(new Event('touchend', { bubbles: true }));
              await __vt.sleep(700);
            }
            await __vt.sleep(300);
            await __vt.settle(200);
            return {
              inside,
              moves,
              moved: Math.round(s.scrollTop - top0),
              near: __vt.view.isNearBottom(),
            };
          },
          [pos, touch] as const,
        );
      const check = async (p: Page, what: string, touch: boolean) => {
        const seen: string[] = [];
        for (const pos of ['end400', 'start40']) {
          const r = await read(p, pos, touch);
          const tag = `${what} ${pos}`;
          const worst = Math.max(...r.moves.map(Math.abs), Math.abs(r.moved));
          if (!r.inside)
            problems.push(`${tag}: top edge not inside the answer`);
          if (worst > 2) {
            problems.push(
              `${tag}: reader moved ${r.moved}px (per chunk [${r.moves.join(',')}])`,
            );
          }
          if (r.near) problems.push(`${tag}: pill hidden`);
          seen.push(`${pos} ${r.moved}`);
        }
        details.push(`${what}: ${seen.join(', ')}`);
      };
      await check(page, 'desktop', false);
      await onPhone(page, MOBILE_UA.android, (p) => check(p, 'android', false));
      await onPhone(page, MOBILE_UA.ios, async (p) => {
        await check(p, 'ios', false);
        await check(p, 'ios+finger', true);
      });
      expect(problems.length === 0, problems.join('; '));
      return details.join('; ');
    },
  },
];

async function runViewSection(viewer: Viewer): Promise<Result[]> {
  const { page, url } = viewer;
  await routeVt(page, url);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const results: Result[] = [];
  for (const s of VIEW_SCENARIOS) {
    if (!selected(s.name)) continue;
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

// ---- Section `page`: the shipped index.html -------------------------------

// Plain JS for the same reason as HELPERS_JS. Installed with addInitScript, so
// it runs before the page's own scripts; it reads the page's globals
// (transcriptModel, transcriptView, renderFrame, ...) only when called.
const PAGE_HELPERS_JS = String.raw`
(function () {
  'use strict';
  function scroller() {
    return document.getElementById('transcript');
  }
  function view() {
    return typeof transcriptView === 'undefined' ? undefined : transcriptView;
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
  function gap() {
    var s = scroller();
    return s.scrollHeight - s.scrollTop - s.clientHeight;
  }
  function snapshot() {
    var s = scroller();
    var v = view();
    return [
      s.scrollTop,
      s.scrollHeight,
      s.clientHeight,
      v ? v.mountedCount() : -1,
      s.querySelectorAll('*').length,
    ].join('|');
  }
  // As __vt.settle: true once geometry and the mounted set held still for
  // 8 frames (and minMs passed); false after 5 s.
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
    return scroller().querySelector('.vrow[data-id="' + id + '"]');
  }
  // Ids of the rows whose box intersects the transcript's visible area.
  function visibleIds() {
    var box = scroller().getBoundingClientRect();
    var out = [];
    scroller()
      .querySelectorAll('.vrow')
      .forEach(function (r) {
        var b = r.getBoundingClientRect();
        if (b.bottom > box.top && b.top < box.bottom && b.height > 0) {
          out.push(Number(r.getAttribute('data-id')));
        }
      });
    return out;
  }
  // Scroll the transcript from the top to the bottom in half-viewport steps
  // and return every item id that was visible at some point.
  async function sweep() {
    var s = scroller();
    var seen = new Set();
    s.scrollTop = 0;
    await settle(200);
    for (var k = 0; k < 5000; k++) {
      visibleIds().forEach(function (id) {
        seen.add(id);
      });
      if (gap() <= 1) break;
      s.scrollTop += Math.max(16, Math.floor(s.clientHeight / 2));
      await settle(0);
    }
    return Array.from(seen);
  }
  function update(u) {
    renderFrame({ type: 'session_update', data: { update: u } });
  }
  // One live turn as the page sees it: the local echo of the sent prompt,
  // the daemon's user record, an optional tool call, the answer, the end.
  function liveTurn(prompt, answer, toolId) {
    addUser(prompt);
    update({ sessionUpdate: 'user_message_chunk', content: { text: prompt } });
    if (toolId) {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: toolId,
        title: 'grep',
        status: 'completed',
      });
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { text: answer } });
    renderFrame({ type: 'turn_complete', data: {} });
  }
  window.__pg = {
    view: view,
    frame: frame,
    sleep: sleep,
    gap: gap,
    settle: settle,
    row: row,
    visibleIds: visibleIds,
    sweep: sweep,
    update: update,
    liveTurn: liveTurn,
  };
})();
`;

// ---- Types of the page's globals ------------------------------------------

interface PgItem {
  id: number;
  kind: string;
  text?: string;
  err?: boolean;
  turn?: number;
  mode?: string;
  note?: string;
  busy?: boolean;
  toolCallId?: string;
}
interface PgModel {
  items: PgItem[];
  readonly curAsst: PgItem | null;
  readonly forkItem: PgItem | null;
  userTurns(): PgItem[];
}
declare const transcriptModel: PgModel;
declare const transcriptView: VtView | null;
declare const startWatch: (
  id: string,
  fromEventId?: number | null,
  title?: string,
) => Promise<void>;
declare let lastSeenEventId: number | null;
// #70: the page's one channel for abandoning an in-flight prompt request. The
// send watchdog and turn_complete both fire it, so a scenario can drive the
// release without waiting out the watchdog's 3-minute timer.
declare let abandonPendingSend: ((why: string) => void) | null;
declare const requestHostTerminal: (id: string) => Promise<void>;
declare const setStatus: (m: string) => void;
declare const renderFrame: (ev: unknown) => void;
declare const addUser: (text: string) => void;
// #50. The conversation this window is on. Read rather than a storage key, so
// P26 asserts which conversation a window came back on instead of pinning the
// name or the store the pointer happens to live in.
declare let watchedSessionId: string | null;
// #50. The folder the load path landed on, and the folder the conversation list
// was fetched FOR. Nothing but the load chain assigns either, so P28 can prove
// the chain ran by watching them fill themselves rather than by calling a
// function of its own and hoping that counted as proof.
declare let curDirPath: string | null;
declare let pastConvosCwd: string | null;
declare let pastConvos: unknown[];
// #70. The outbox and its drain, so P29 can drive the drain directly rather
// than needing a whole turn to end on cue.
declare let outbox: string[];
declare const drainOutbox: (attempt: number) => void;
declare const clearTranscript: () => void;
declare const showProcessing: () => void;
declare const renderTool: (u: Record<string, unknown>) => void;
// #71. The indicator's own state and the length of the beat that drives it, so
// P23 can wait one beat out rather than guess at a wall-clock number.
declare const PROCESSING_QUIET_MS: number;
declare const endTurn: () => void;
declare const renderSessionUpdate: (u: unknown) => void;
// #72. The strip's per-session verdict and the raw log it writes the fault to,
// so P24 can assert the fault is answerable from the page rather than only
// visible on it.
declare let planFramesSeen: number;
declare const logLines: string[];
declare const appendSubagentText: (parentId: string, text: string) => void;
declare const userTurnsSeen: number;
declare const forkTurnCount: number;
declare const __pg: {
  view(): VtView | null | undefined;
  frame(): Promise<void>;
  sleep(ms: number): Promise<void>;
  gap(): number;
  settle(minMs?: number): Promise<boolean>;
  row(id: number): HTMLElement | null;
  visibleIds(): number[];
  sweep(): Promise<number[]>;
  update(u: Record<string, unknown>): void;
  liveTurn(prompt: string, answer: string, toolId?: string): void;
};

// ---- Frames ----------------------------------------------------------------

/** Daemon frames for the stub, ids 1..n in order. */
class Frames {
  readonly list: Frame[] = [];
  ev(type: string, data: unknown = {}): this {
    this.list.push({ id: this.list.length + 1, type, data });
    return this;
  }
  upd(update: Record<string, unknown>): this {
    return this.ev('session_update', { update });
  }
  user(text: string): this {
    return this.upd({ sessionUpdate: 'user_message_chunk', content: { text } });
  }
  asst(text: string): this {
    return this.upd({
      sessionUpdate: 'agent_message_chunk',
      content: { text },
    });
  }
  thought(text: string): this {
    return this.upd({
      sessionUpdate: 'agent_thought_chunk',
      content: { text },
    });
  }
  toolCall(id: string, title: string, status: string): this {
    return this.upd({
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title,
      status,
    });
  }
  toolUpdate(id: string, status: string): this {
    return this.upd({
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status,
    });
  }
  done(): this {
    return this.ev('turn_complete');
  }
}

/** A frame the transcript ignores: marks the stream as connected. */
const READY: Frame[] = new Frames().ev('client_joined').list;

/**
 * `turns` replayed turns of user record, thought, tool call + update and
 * `chunks` assistant chunks, then turn_complete: 5 + chunks frames per turn.
 * The transcript gets a thought, a tool and an assistant item per turn plus
 * one fork row under the last answer (3 * turns + 1 items).
 */
function replayFrames(turns: number, chunks: number): Frame[] {
  const f = new Frames();
  for (let t = 1; t <= turns; t++) {
    f.user(`question ${t}`)
      .thought(`thinking about turn ${t}. `)
      .toolCall(`tc-${t}`, 'read_file', 'in_progress')
      .toolUpdate(`tc-${t}`, 'completed');
    for (let k = 0; k < chunks; k++) {
      f.asst(`turn ${t} chunk ${k}: lorem ipsum dolor sit amet. `);
    }
    f.done();
  }
  return f.list;
}

// ---- Runner ------------------------------------------------------------------

interface PageRun {
  viewer: Viewer;
  page: Page;
  consoleErrors: string[];
}
type PageScenario =
  | {
      name: string;
      /** Stub frames (default READY); the stream is held open. */
      frames?: () => Frame[];
      /** Stub prompt behaviour: a slow turn, or one it refuses outright. */
      stub?: { promptStatus?: number; promptDelayMs?: number };
      /** Runs before navigation (routes). */
      before?: (page: Page) => Promise<void>;
      /** Wait for transcriptView before run() (default true). */
      waitView?: boolean;
      /** Also fail on console errors (page errors always fail). */
      noConsoleErrors?: boolean;
      run: (r: PageRun) => Promise<string>;
    }
  | { name: string; standalone: () => Promise<string> };

const VIEWER_SCRIPT = 'scripts/measure-viewer-growth.mts';
const TRANSCRIPT_ASSET =
  /\/ui\/(transcript-model\.js|transcript-view\.js|vendor\/virtual-core\.js|vendor\/markdown-it\.js)$/;
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));

async function waitView(page: Page, timeoutMs = 10_000): Promise<void> {
  try {
    await page.waitForFunction(() => __pg.view() != null, null, {
      timeout: timeoutMs,
    });
  } catch {
    throw new Error(`transcriptView not attached within ${timeoutMs} ms`);
  }
}

async function watch(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    lastSeenEventId = null;
    void startWatch(id);
  }, sessionId);
}

/** Polls until the page has seen frame `lastId`; returns the elapsed ms. */
async function waitForFrame(
  page: Page,
  lastId: number,
  timeoutMs: number,
): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const got = await page.evaluate(() => lastSeenEventId);
    if (got !== null && got >= lastId) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `replay stalled at frame ${got} of ${lastId} after ${timeoutMs} ms`,
      );
    }
    await page.waitForTimeout(250);
  }
}

async function settlePage(page: Page, minMs = 200): Promise<void> {
  const ok = await page.evaluate((ms) => __pg.settle(ms), minMs);
  expect(ok, 'transcript did not settle within 5 s');
}

/**
 * A transcript script failed to load: #transcript shows a visible "reload"
 * note, and the page's other UI initialized (app shown after the auth check,
 * the pair button wired, tabs switch, frames are handled without errors).
 */
async function checkTranscriptMissing(
  page: Page,
  viewer: Viewer,
): Promise<string> {
  const note = () =>
    page.evaluate(() => {
      const t = document.getElementById('transcript')!;
      return {
        text: t.textContent ?? '',
        shown: t.getClientRects().length > 0,
      };
    });
  try {
    await page.waitForFunction(
      () =>
        /reload/i.test(
          document.getElementById('transcript')!.textContent ?? '',
        ),
      null,
      { timeout: 10_000 },
    );
  } catch {
    throw new Error(
      `no failure note in #transcript: ${JSON.stringify((await note()).text)}`,
    );
  }
  await page.waitForFunction(
    () => !document.getElementById('app-body')!.hidden,
    null,
    { timeout: 10_000 },
  );
  const ui = await page.evaluate(() => ({
    pairWired:
      typeof (document.getElementById('pair') as HTMLButtonElement).onclick ===
      'function',
  }));
  expect(ui.pairWired, 'pair button not wired');
  await page.click('.tab[data-tab="diag"]');
  const diag = await page.evaluate(() =>
    document.getElementById('pane-diag')!.classList.contains('active'),
  );
  expect(diag, 'the Diagnostics tab did not open');
  await page.click('.tab[data-tab="chat"]');
  await watch(page, viewer.sessionId);
  await waitForFrame(page, 5 * 7, 30_000);
  const n = await note();
  expect(n.shown, '#transcript not shown on the Chat tab');
  expect(/reload/i.test(n.text), 'failure note gone after the watch');
  return `note ${JSON.stringify(n.text)}; tabs and frames work`;
}

interface Growth {
  turns: number;
  finished: boolean;
  replayMs: number;
  transcriptNodes: number;
  totalNodes: number;
  perChunkMs: number;
  perChunkFrameMs: number;
  jsHeapMb: number;
  rendererRssMb: number;
}

async function measureGrowth(turns: number): Promise<Growth> {
  const { stdout } = await execFileAsync('npx', ['tsx', VIEWER_SCRIPT], {
    cwd: PKG_DIR,
    env: { ...process.env, TURNS: String(turns) },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 900_000,
  });
  const at = stdout.indexOf('{');
  expect(at >= 0, `no JSON from ${VIEWER_SCRIPT} at ${turns} turns`);
  return JSON.parse(stdout.slice(at)) as Growth;
}

const P1_TURNS = 5000;

// The sample P32 sends: heading, emphasis, inline code, a list, a fenced block,
// raw HTML, a hostile link target, and one real link. The fence ticks are built
// rather than typed so this string stays free of backticks.
function mdFrames(): Frame[] {
  const tick = String.fromCharCode(96);
  const fence = tick.repeat(3);
  const f = new Frames();
  f.user('make **this** bold');
  f.asst(
    [
      '# Heading',
      '',
      'Body with **bold** and ' + tick + 'code' + tick + '.',
      '',
      '- one',
      '- two',
      '',
      fence + 'js',
      'const a = 1;',
      fence,
      '',
      '<img src=x onerror=alert(1)>',
      '',
      '[bad](javascript:alert(1)) [good](https://example.com/a)',
    ].join('\n'),
  );
  return f.done().list;
}

const PAGE_SCENARIOS: PageScenario[] = [
  {
    name: 'P1 replay',
    frames: () => replayFrames(P1_TURNS, 2),
    run: async ({ page, viewer }) => {
      const last = P1_TURNS * 7;
      await watch(page, viewer.sessionId);
      const ms = await waitForFrame(page, last, 300_000);
      await settlePage(page);
      const r = await page.evaluate(() => {
        const items = transcriptModel.items;
        const tail = items[items.length - 1];
        return {
          items: items.length,
          mounted: transcriptView!.mountedCount(),
          rows: document.querySelectorAll('#transcript .vrow').length,
          gap: __pg.gap(),
          tailKind: tail ? tail.kind : '',
          tailVisible: !!tail && __pg.visibleIds().includes(tail.id),
        };
      });
      expect(
        r.items === 3 * P1_TURNS + 1,
        `model has ${r.items} items, expected ${3 * P1_TURNS + 1}`,
      );
      expect(
        r.mounted > 0 && r.mounted < 60,
        `mountedCount() = ${r.mounted}, expected 1..59`,
      );
      expect(r.rows === r.mounted, `${r.rows} .vrow != ${r.mounted} mounted`);
      expect(r.gap <= 2, `not pinned after the replay: gap=${r.gap}`);
      expect(
        r.tailKind === 'fork' && r.tailVisible,
        `last item ${r.tailKind} visible=${r.tailVisible}`,
      );
      return `${last} frames in ${ms} ms; items=${r.items} mounted=${r.mounted}`;
    },
  },
  {
    name: 'P2 rewind picker',
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await waitForFrame(page, 1, 10_000);
      const prompts: string[] = [];
      for (let i = 1; i <= 300; i++) {
        prompts.push(
          `prompt ${i}:\n   tell me\tabout  ` +
            'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(3),
        );
      }
      await page.evaluate((ps) => {
        for (const p of ps) addUser(p);
      }, prompts);
      await settlePage(page);
      const state = await page.evaluate(() => {
        const first = transcriptModel.userTurns()[0];
        return {
          mounted: transcriptView!.mountedCount(),
          firstMounted: !!(first && __pg.row(first.id)),
        };
      });
      expect(
        state.mounted < 60 && !state.firstMounted,
        `expected most turns unmounted: mounted=${state.mounted} first=${state.firstMounted}`,
      );
      await page.evaluate(() =>
        document.getElementById('rewind-chat')!.click(),
      );
      const opts = await page.evaluate(() => {
        const sel = document.getElementById(
          'rewind-turn-pick',
        ) as HTMLSelectElement;
        return {
          texts: Array.from(sel.options).map((o) => o.textContent ?? ''),
          values: Array.from(sel.options).map((o) => o.value),
          value: sel.value,
        };
      });
      const preview = (p: string) => p.replace(/\s+/g, ' ').trim().slice(0, 60);
      expect(opts.texts.length === 301, `${opts.texts.length} options`);
      expect(opts.texts[0]!.startsWith('Start'), `first ${opts.texts[0]}`);
      const want300 = 'Turn 300: ' + preview(prompts[299]!);
      expect(
        opts.texts[300] === want300,
        `option 300 ${JSON.stringify(opts.texts[300])} != ${JSON.stringify(want300)}`,
      );
      const want1 = 'Turn 1: ' + preview(prompts[0]!);
      expect(
        opts.texts[1] === want1,
        `option 1 ${JSON.stringify(opts.texts[1])} != ${JSON.stringify(want1)}`,
      );
      expect(
        opts.values[300] === '300' && opts.value === '300',
        `values ${opts.values[300]} selected ${opts.value}`,
      );
      return `301 options with ${state.mounted} rows mounted; ${JSON.stringify(opts.texts[300])}`;
    },
  },
  {
    name: 'P3 session_rewound cut',
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await waitForFrame(page, 1, 10_000);
      await page.evaluate(() => {
        for (let i = 1; i <= 300; i++) {
          __pg.liveTurn('question ' + i, 'answer ' + i, 'tc-' + i);
        }
      });
      const before = await page.evaluate(() => ({
        users: transcriptModel.userTurns().length,
        seen: userTurnsSeen,
        fork: transcriptModel.forkItem ? transcriptModel.forkItem.turn : -1,
      }));
      expect(
        before.users === 300 && before.seen === 300 && before.fork === 300,
        `setup: ${JSON.stringify(before)}`,
      );
      await page.evaluate(() =>
        renderFrame({ type: 'session_rewound', data: { toTurn: 100 } }),
      );
      await settlePage(page);
      const r = await page.evaluate(() => {
        const items = transcriptModel.items;
        const tail = items[items.length - 1]!;
        return {
          users: transcriptModel.userTurns().length,
          items: items.length,
          tailKind: tail.kind,
          tailText: tail.text,
          seen: userTurnsSeen,
          forkTurns: forkTurnCount,
          forkItem: !!transcriptModel.forkItem,
          forkRows: document.querySelectorAll('#transcript .bubble-fork')
            .length,
          tailShown: __pg.visibleIds().includes(tail.id),
          tailDom: __pg.row(tail.id)?.textContent ?? null,
          gap: __pg.gap(),
          mounted: transcriptView!.mountedCount(),
        };
      });
      expect(r.users === 100, `${r.users} user turns after the cut`);
      expect(r.items === 301, `${r.items} items, expected 100 * 3 + 1`);
      expect(
        r.tailKind === 'system' && r.tailText === 'rewound to turn 100',
        `last item ${r.tailKind} ${JSON.stringify(r.tailText)}`,
      );
      expect(r.seen === 100, `userTurnsSeen = ${r.seen}`);
      expect(r.forkTurns === 100, `forkTurnCount = ${r.forkTurns}`);
      expect(!r.forkItem && r.forkRows === 0, 'fork row survived the cut');
      expect(
        r.tailShown && r.tailDom === 'rewound to turn 100',
        `system note not shown: ${JSON.stringify(r.tailDom)}`,
      );
      expect(r.gap <= 2, `not pinned after the cut: gap=${r.gap}`);
      expect(r.mounted < 60, `mounted ${r.mounted}`);
      // The dropped turns' tool bookkeeping is gone: a late update for one of
      // them starts a new row instead of editing a cut item.
      const late = await page.evaluate(() => {
        __pg.update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-150',
          status: 'failed',
        });
        const items = transcriptModel.items;
        const tail = items[items.length - 1]!;
        return { items: items.length, id: tail.toolCallId };
      });
      expect(
        late.items === 302 && late.id === 'tc-150',
        `late tool update: ${JSON.stringify(late)}`,
      );
      // A malformed target cuts nothing and keeps the counters.
      const bad = await page.evaluate(() => {
        renderFrame({ type: 'session_rewound', data: {} });
        const items = transcriptModel.items;
        return {
          users: transcriptModel.userTurns().length,
          seen: userTurnsSeen,
          tail: items[items.length - 1]!.text,
          items: items.length,
        };
      });
      expect(
        bad.users === 100 &&
          bad.seen === 100 &&
          bad.items === 303 &&
          bad.tail === 'rewound to turn ?',
        `malformed rewind: ${JSON.stringify(bad)}`,
      );
      return `300 -> ${r.users} user turns, ${r.items} items, tail ${JSON.stringify(r.tailText)}`;
    },
  },
  {
    name: 'P4 fork row',
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await waitForFrame(page, 1, 10_000);
      // Where the fork item sits relative to the newest assistant item, in
      // the model and in the DOM.
      const read = () =>
        page.evaluate(() => {
          const items = transcriptModel.items;
          const forks = items.filter((i) => i.kind === 'fork');
          let lastAsst = -1;
          for (let i = 0; i < items.length; i++) {
            if (items[i]!.kind === 'asst') lastAsst = i;
          }
          const f = forks[0];
          const fRow = f ? __pg.row(f.id) : null;
          const aRow = lastAsst >= 0 ? __pg.row(items[lastAsst]!.id) : null;
          const sel = fRow ? fRow.querySelector('select') : null;
          return {
            forks: forks.length,
            forkRows: document.querySelectorAll('#transcript .bubble-fork')
              .length,
            afterAsst: !!f && items[lastAsst + 1] === f,
            turn: f ? f.turn : -1,
            domNext: !!fRow && !!aRow && aRow.nextElementSibling === fRow,
            button: fRow?.querySelector('button')?.textContent ?? null,
            mode: sel ? sel.value : null,
            options: sel ? Array.from(sel.options).map((o) => o.value) : [],
            asstText: lastAsst >= 0 ? items[lastAsst]!.text : null,
          };
        });
      await page.evaluate(() => __pg.liveTurn('first question', 'answer one'));
      await settlePage(page, 0);
      const s1 = await read();
      expect(
        s1.forks === 1 && s1.forkRows === 1,
        `turn 1: ${s1.forks} fork items, ${s1.forkRows} rows`,
      );
      expect(s1.afterAsst && s1.turn === 1, `turn 1: ${JSON.stringify(s1)}`);
      expect(
        s1.domNext,
        'turn 1: fork row is not the next row after the answer',
      );
      expect(s1.button === 'Fork from here', `button ${s1.button}`);
      expect(
        s1.mode === 'include' && s1.options.join(',') === 'include,empty',
        `select ${s1.mode} [${s1.options.join(',')}]`,
      );
      await page.evaluate(() => {
        addUser('second question');
        __pg.update({
          sessionUpdate: 'user_message_chunk',
          content: { text: 'second question' },
        });
        __pg.update({
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'answer two' },
        });
        __pg.update({
          sessionUpdate: 'tool_call',
          toolCallId: 'p4-tool',
          title: 'grep',
          status: 'completed',
        });
        __pg.update({
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'answer two, after the tool' },
        });
        renderFrame({ type: 'turn_complete', data: {} });
      });
      await settlePage(page, 0);
      const s2 = await read();
      expect(
        s2.forks === 1 && s2.forkRows === 1 && s2.turn === 2,
        `turn 2: ${JSON.stringify(s2)}`,
      );
      expect(
        s2.afterAsst && s2.asstText === 'answer two, after the tool',
        `turn 2: fork not under the newest answer: ${JSON.stringify(s2)}`,
      );
      expect(
        s2.domNext,
        'turn 2: fork row is not the next row after the answer',
      );
      // A late chunk of the same turn moves the row under the newer answer.
      await page.evaluate(() => {
        __pg.update({
          sessionUpdate: 'tool_call',
          toolCallId: 'p4-late',
          title: 'grep',
          status: 'completed',
        });
        __pg.update({
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'late chunk' },
        });
      });
      await settlePage(page, 0);
      const s3 = await read();
      expect(
        s3.forks === 1 &&
          s3.turn === 2 &&
          s3.afterAsst &&
          s3.asstText === 'late chunk' &&
          s3.domNext,
        `late chunk: ${JSON.stringify(s3)}`,
      );
      await page.selectOption('#transcript .bubble-fork select', 'empty');
      // The prompt for a fork name is dismissed: no request, no state change.
      await page.click('#transcript .bubble-fork button');
      await page.waitForTimeout(200);
      const s4 = await page.evaluate(() => {
        const f = transcriptModel.forkItem!;
        return { mode: f.mode, busy: !!f.busy, note: f.note ?? '' };
      });
      expect(
        s4.mode === 'empty' && !s4.busy && s4.note === '',
        `after select + dismissed click: ${JSON.stringify(s4)}`,
      );
      return `fork follows the newest answer (turn ${s3.turn}); mode stored as ${s4.mode}`;
    },
  },
  {
    name: 'P5 raw toggle',
    noConsoleErrors: true,
    frames: () => {
      const f = new Frames();
      for (let i = 1; i <= 25; i++) {
        f.asst(`answer ${i}`).toolCall(`raw-${i}`, `tool ${i}`, 'in_progress');
        for (let k = 0; k < 24; k++) f.ev('client_joined');
      }
      return f.list;
    },
    run: async ({ page, viewer }) => {
      const total = 25 * 26;
      await page.evaluate(() => document.getElementById('raw-toggle')!.click());
      const raw = await page.evaluate(() => ({
        checked: (document.getElementById('raw-toggle') as HTMLInputElement)
          .checked,
        hidden:
          getComputedStyle(document.getElementById('transcript')!).display ===
          'none',
      }));
      expect(raw.checked && raw.hidden, `raw on: ${JSON.stringify(raw)}`);
      await watch(page, viewer.sessionId);
      await waitForFrame(page, total, 30_000);
      await page.waitForTimeout(300);
      const hidden = await page.evaluate(() => ({
        items: transcriptModel.items.length,
        logLines: document.getElementById('log')!.childNodes.length,
        lastLog: document.getElementById('log')!.lastChild?.textContent ?? '',
      }));
      expect(hidden.items === 50, `${hidden.items} items while hidden`);
      expect(hidden.logLines === 500, `#log holds ${hidden.logLines} lines`);
      expect(
        hidden.lastLog.includes(`"id":${total},`),
        `newest #log line ${JSON.stringify(hidden.lastLog.slice(0, 80))}`,
      );
      await page.evaluate(() => document.getElementById('raw-toggle')!.click());
      await settlePage(page);
      const shown = await page.evaluate(() => {
        const items = transcriptModel.items;
        return {
          gap: __pg.gap(),
          tailVisible: __pg.visibleIds().includes(items[items.length - 1]!.id),
          pill: (document.getElementById('jump-bottom') as HTMLElement).hidden,
        };
      });
      expect(shown.gap <= 2, `not pinned after raw off: gap=${shown.gap}`);
      expect(shown.tailVisible, 'newest item not visible after raw off');
      expect(shown.pill, 'jump-to-bottom pill shown while pinned');
      const seen = await page.evaluate(() => __pg.sweep());
      const ids = await page.evaluate(() =>
        transcriptModel.items.map((i) => i.id),
      );
      const missing = ids.filter((id) => !seen.includes(id));
      expect(
        missing.length === 0,
        `${missing.length}/50 items never visible: ${missing.join(',')}`,
      );
      const after = await page.evaluate(
        () => document.getElementById('log')!.childNodes.length,
      );
      expect(after === 500, `#log holds ${after} lines after raw off`);
      return `50 items appended while hidden, all ${seen.length} visible after raw off; #log ${hidden.logLines} lines`;
    },
  },
  {
    name: 'P6 late bundle',
    waitView: false,
    noConsoleErrors: true,
    frames: () => replayFrames(250, 3),
    before: async (page) => {
      await page.route('**/ui/vendor/virtual-core.js', async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      });
    },
    run: async ({ page, viewer }) => {
      const total = 250 * 8;
      const t0 = Date.now();
      await watch(page, viewer.sessionId);
      // Frames arrive (and are buffered in the model) before the view exists.
      let early = { view: false, items: 0 };
      while (Date.now() - t0 < 1400) {
        early = await page.evaluate(() => ({
          view: __pg.view() != null,
          items: transcriptModel.items.length,
        }));
        if (early.view || early.items > 0) break;
        await page.waitForTimeout(20);
      }
      expect(
        !early.view && early.items > 0,
        `nothing buffered before the bundle: ${JSON.stringify(early)}`,
      );
      await waitView(page, 15_000);
      const attachedMs = Date.now() - t0;
      await waitForFrame(page, total, 60_000);
      await settlePage(page);
      const r = await page.evaluate(() => {
        const items = transcriptModel.items;
        return {
          items: items.length,
          mounted: transcriptView!.mountedCount(),
          sizer: !!document.querySelector('#transcript .vsizer'),
          gap: __pg.gap(),
          tailVisible: __pg.visibleIds().includes(items[items.length - 1]!.id),
          pill: (document.getElementById('jump-bottom') as HTMLElement).hidden,
        };
      });
      expect(r.items === 751, `${r.items} items, expected 751`);
      expect(r.sizer, 'no .vsizer: the view did not use the bundle');
      expect(
        r.mounted > 0 && r.mounted < 60,
        `mountedCount() = ${r.mounted}, expected 1..59`,
      );
      expect(r.gap <= 2, `not pinned: gap=${r.gap}`);
      expect(r.tailVisible, 'newest item not visible');
      expect(r.pill, 'jump-to-bottom pill shown while pinned');
      return `${early.items} items buffered before the view; attached after ${attachedMs} ms; mounted=${r.mounted}`;
    },
  },
  {
    name: 'P7 bundle 404',
    frames: () => replayFrames(100, 2),
    before: async (page) => {
      await page.route('**/ui/vendor/virtual-core.js', (route) =>
        route.abort(),
      );
    },
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await waitForFrame(page, 100 * 7, 30_000);
      await settlePage(page);
      const r = await page.evaluate(() => {
        const items = transcriptModel.items;
        const rows = Array.from(
          document.querySelectorAll('#transcript .vrow'),
        ).map((el) => Number(el.getAttribute('data-id')));
        return {
          items: items.length,
          ids: items.map((i) => i.id),
          rows,
          mounted: transcriptView!.mountedCount(),
          sizer: !!document.querySelector('#transcript .vsizer'),
          gap: __pg.gap(),
          lastText: __pg.row(items[items.length - 2]!.id)?.textContent ?? null,
          lastModel: items[items.length - 2]!.text ?? null,
        };
      });
      expect(r.items === 301, `${r.items} items, expected 301`);
      expect(!r.sizer, '.vsizer present without the bundle');
      expect(
        r.rows.length === r.items && r.rows.join() === r.ids.join(),
        `${r.rows.length} rows for ${r.items} items (or out of order)`,
      );
      expect(r.mounted === r.items, `mountedCount() = ${r.mounted}`);
      expect(
        (r.lastText ?? '').endsWith(r.lastModel ?? '\u0000'),
        `last answer ${JSON.stringify(r.lastText)}`,
      );
      expect(r.gap <= 2, `fallback not pinned: gap=${r.gap}`);
      return `fallback rendered all ${r.rows.length} items`;
    },
  },
  {
    name: 'P8 session switch',
    frames: () => replayFrames(20, 2),
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await waitForFrame(page, 20 * 7, 30_000);
      await page.evaluate(() => {
        renderTool({
          toolCallId: 'p8-agent',
          title: 'agent',
          status: 'in_progress',
        });
        appendSubagentText('p8-agent', 'child working');
        showProcessing();
      });
      await settlePage(page, 0);
      await page.evaluate(() => {
        document.getElementById('transcript')!.scrollTop = 0;
      });
      await settlePage(page);
      const before = await page.evaluate(() => ({
        items: transcriptModel.items.length,
        rows: document.querySelectorAll('#transcript .vrow').length,
        pill: (document.getElementById('jump-bottom') as HTMLElement).hidden,
      }));
      expect(before.items === 63, `setup: ${before.items} items`);
      expect(!before.pill, 'pill hidden while scrolled to the top');
      await page.evaluate(() => clearTranscript());
      await settlePage(page);
      const cleared = await page.evaluate(() => ({
        items: transcriptModel.items.length,
        rows: document.querySelectorAll('#transcript .vrow').length,
        bubbles: document.querySelectorAll(
          '#transcript .bubble, #transcript .system, #transcript .bubble-fork',
        ).length,
        mounted: transcriptView!.mountedCount(),
        seen: userTurnsSeen,
        forkTurns: forkTurnCount,
        pill: (document.getElementById('jump-bottom') as HTMLElement).hidden,
      }));
      expect(
        cleared.items === 0 &&
          cleared.rows === 0 &&
          cleared.bubbles === 0 &&
          cleared.mounted === 0,
        `after clearTranscript(): ${JSON.stringify(cleared)}`,
      );
      expect(
        cleared.seen === 0 && cleared.forkTurns === 0,
        `counters not reset: ${JSON.stringify(cleared)}`,
      );
      expect(cleared.pill, 'pill still shown on an empty transcript');
      // The processing and subagent clocks stopped with the clear.
      const writes = await page.evaluate(async () => {
        let n = 0;
        const mo = new MutationObserver((recs) => {
          n += recs.length;
        });
        mo.observe(document.getElementById('transcript')!, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
        await __pg.sleep(1500);
        mo.disconnect();
        return n;
      });
      expect(writes === 0, `${writes} transcript mutations after the clear`);
      // A switch to another session: the transcript holds one replay only.
      await watch(page, '99999999-8888-7777-6666-555555555555');
      await waitForFrame(page, 20 * 7, 30_000);
      await settlePage(page);
      const switched = await page.evaluate(() => ({
        items: transcriptModel.items.length,
        seen: userTurnsSeen,
        gap: __pg.gap(),
      }));
      expect(
        switched.items === 61 && switched.seen === 20,
        `after the switch: ${JSON.stringify(switched)}`,
      );
      expect(switched.gap <= 2, `not pinned after the switch: ${switched.gap}`);
      return `${before.items} items -> 0 -> ${switched.items} after the switch`;
    },
  },
  {
    // Another tab (or the raw-JSON view) hides #transcript with
    // display:none; every row then measures 0. Coming back must find the
    // reader where they were, and a pinned transcript at the new end.
    name: 'P10 hide and show',
    frames: () => replayFrames(40, 2),
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await waitForFrame(page, 40 * 7, 30_000);
      await settlePage(page);
      const read = () =>
        page.evaluate(() => {
          const s = document.getElementById('transcript')!;
          const ids = __pg.visibleIds();
          return {
            top: s.scrollTop,
            first: ids.length ? Math.min(...ids) : -1,
            gap: __pg.gap(),
            pill: (document.getElementById('jump-bottom') as HTMLElement)
              .hidden,
          };
        });
      await page.evaluate(() => {
        const s = document.getElementById('transcript')!;
        s.scrollTop = Math.floor(s.scrollHeight / 2);
      });
      await settlePage(page);
      const s0 = await read();
      expect(s0.gap > 200 && !s0.pill, `setup: ${JSON.stringify(s0)}`);
      await page.click('.tab[data-tab="diag"]');
      await page.waitForTimeout(300);
      await page.click('.tab[data-tab="chat"]');
      await settlePage(page);
      const s1 = await read();
      expect(
        Math.abs(s1.top - s0.top) <= 2 && s1.first === s0.first && !s1.pill,
        `tab round trip moved the reader: ${JSON.stringify(s0)} -> ${JSON.stringify(s1)}`,
      );
      await page.evaluate(() => document.getElementById('raw-toggle')!.click());
      await page.waitForTimeout(300);
      await page.evaluate(() => document.getElementById('raw-toggle')!.click());
      await settlePage(page);
      const s2 = await read();
      expect(
        Math.abs(s2.top - s0.top) <= 2 && s2.first === s0.first && !s2.pill,
        `raw round trip moved the reader: ${JSON.stringify(s0)} -> ${JSON.stringify(s2)}`,
      );
      // Pinned, and the answer grows while the transcript is hidden.
      await page.click('#jump-bottom');
      await settlePage(page);
      await page.click('.tab[data-tab="diag"]');
      await page.evaluate(() =>
        __pg.update({
          sessionUpdate: 'agent_message_chunk',
          content: { text: ' tail while hidden' },
        }),
      );
      await page.waitForTimeout(300);
      await page.click('.tab[data-tab="chat"]');
      await settlePage(page);
      const s3 = await page.evaluate(() => {
        const asst = transcriptModel.curAsst!;
        return {
          gap: __pg.gap(),
          pill: (document.getElementById('jump-bottom') as HTMLElement).hidden,
          text: __pg.row(asst.id)?.textContent ?? null,
          shown: __pg.visibleIds().includes(asst.id),
        };
      });
      expect(
        s3.gap <= 2 && s3.pill,
        `pinned transcript not at the end after the tab: ${JSON.stringify(s3)}`,
      );
      expect(
        s3.shown && (s3.text ?? '').endsWith(' tail while hidden'),
        `hidden-time chunk not shown: ${JSON.stringify(s3.text)}`,
      );
      return `reader kept at ${Math.round(s0.top)} (item ${s0.first}); pinned view followed the hidden-time chunk`;
    },
  },
  {
    // The bundle loads but the view cannot start with it (here its
    // Virtualizer constructor throws, as an internals mismatch would): the
    // page falls back to rendering every item and says what went wrong.
    name: 'P11 view fails to start',
    waitView: false,
    frames: () => replayFrames(100, 2),
    before: async (page) => {
      await page.route('**/ui/vendor/virtual-core.js', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/javascript',
          body: [
            'export class Virtualizer {',
            '  constructor() { throw new Error("virtualizer boom"); }',
            '}',
            'export const observeElementRect = () => {};',
            'export const observeElementOffset = () => {};',
            'export const elementScroll = () => {};',
          ].join('\n'),
        }),
      );
    },
    run: async ({ page, viewer, consoleErrors }) => {
      await waitView(page);
      const s0 = await page.evaluate(() => ({
        status: document.getElementById('status')!.textContent ?? '',
        anchor: getComputedStyle(document.getElementById('transcript')!)
          .overflowAnchor,
      }));
      expect(
        s0.status.includes('virtualizer boom'),
        `status line ${JSON.stringify(s0.status)}`,
      );
      expect(
        consoleErrors.some((e) => e.includes('virtualizer boom')),
        `error not logged: ${JSON.stringify(consoleErrors)}`,
      );
      expect(s0.anchor !== 'none', 'overflow-anchor left at none');
      await watch(page, viewer.sessionId);
      await waitForFrame(page, 100 * 7, 30_000);
      await settlePage(page);
      const r = await page.evaluate(() => {
        const items = transcriptModel.items;
        const rows = Array.from(
          document.querySelectorAll('#transcript .vrow'),
        ).map((el) => Number(el.getAttribute('data-id')));
        return {
          items: items.length,
          ids: items.map((i) => i.id),
          rows,
          sizers: document.querySelectorAll('#transcript .vsizer').length,
          gap: __pg.gap(),
        };
      });
      expect(r.items === 301, `${r.items} items, expected 301`);
      expect(r.sizers === 0, `${r.sizers} .vsizer left by the failed view`);
      expect(
        r.rows.length === r.items && r.rows.join() === r.ids.join(),
        `${r.rows.length} rows for ${r.items} items (or out of order)`,
      );
      expect(r.gap <= 2, `fallback not pinned: gap=${r.gap}`);
      return `fallback rendered all ${r.rows.length} items; status ${JSON.stringify(s0.status)}`;
    },
  },
  {
    // transcript-model.js did not load: the transcript says so, and the
    // rest of the page (pairing, tabs, frame handling) still works.
    name: 'P12 model script missing',
    waitView: false,
    frames: () => replayFrames(5, 2),
    before: async (page) => {
      await page.route('**/ui/transcript-model.js', (route) => route.abort());
    },
    run: async ({ page, viewer }) => checkTranscriptMissing(page, viewer),
  },
  {
    // The same for transcript-view.js: the model still records the frames.
    name: 'P13 view script missing',
    waitView: false,
    frames: () => replayFrames(5, 2),
    before: async (page) => {
      await page.route('**/ui/transcript-view.js', (route) => route.abort());
    },
    run: async ({ page, viewer }) => {
      const detail = await checkTranscriptMissing(page, viewer);
      const items = await page.evaluate(() => transcriptModel.items.length);
      expect(items === 16, `model holds ${items} items, expected 16`);
      return `${detail}; model holds ${items} items`;
    },
  },
  {
    // #62. POST /session/:id/prompt is long-lived (it answers when the turn
    // ends), so clearing the composer on the response leaves the sent text on
    // screen for the whole turn and then throws away whatever was typed while
    // it ran. The stub holds this turn open so the window is observable.
    name: 'P14 composer clears at dispatch',
    stub: { promptDelayMs: 5_000 },
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.evaluate(() => {
        (document.getElementById('prompt') as HTMLTextAreaElement).value =
          'first message';
        void (document.getElementById('send') as HTMLButtonElement).onclick!();
      });
      const mid = await page.evaluate(() => ({
        inflight: (document.getElementById('send') as HTMLButtonElement)
          .disabled,
        box: (document.getElementById('prompt') as HTMLTextAreaElement).value,
        echo: transcriptModel.items
          .filter((i) => i.kind === 'user')
          .map((i) => i.text),
      }));
      expect(mid.inflight, 'the prompt POST had already resolved');
      expect(
        mid.box === '',
        `composer still holds the sent text mid-turn: ${JSON.stringify(
          mid.box,
        )}`,
      );
      expect(
        mid.echo.length === 1 && mid.echo[0] === 'first message',
        `local echo: ${JSON.stringify(mid.echo)}`,
      );
      // The next message is typed while the first turn is still running.
      await page.evaluate(() => {
        (document.getElementById('prompt') as HTMLTextAreaElement).value =
          'next draft';
      });
      await page.waitForFunction(
        () => !(document.getElementById('send') as HTMLButtonElement).disabled,
        null,
        { timeout: 30_000 },
      );
      const after = await page.evaluate(
        () => (document.getElementById('prompt') as HTMLTextAreaElement).value,
      );
      expect(
        after === 'next draft',
        `the late clear destroyed the draft: ${JSON.stringify(after)}`,
      );
      return 'box empty mid-turn, draft intact after the turn';
    },
  },
  {
    // #62. A prompt the gateway refuses before the turn begins must not leave a
    // user message that reads as if it ran, and must not lose its text.
    name: 'P15 refused send is marked and offered back',
    before: async (page) => {
      await page.route('**/session/*/prompt', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":"queue_timeout","code":"queue_timeout"}',
        }),
      );
    },
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.evaluate(() => {
        (document.getElementById('prompt') as HTMLTextAreaElement).value =
          'do the thing';
        void (document.getElementById('send') as HTMLButtonElement).onclick!();
      });
      await page.waitForFunction(
        () => !(document.getElementById('send') as HTMLButtonElement).disabled,
        null,
        { timeout: 20_000 },
      );
      await settlePage(page);
      const st = await page.evaluate(() => ({
        hidden: (document.getElementById('unsent') as HTMLDivElement).hidden,
        note: document.getElementById('unsent-note')!.textContent,
        text: document.getElementById('unsent-text')!.textContent,
        box: (document.getElementById('prompt') as HTMLTextAreaElement).value,
        marked: transcriptModel.items
          .filter((i) => i.kind === 'user')
          .map((i) => (i as { notSent?: string }).notSent ?? ''),
        shown: Array.from(
          document.querySelectorAll('#transcript .not-sent'),
        ).map((n) => n.textContent ?? ''),
      }));
      expect(
        !st.hidden && st.text === 'do the thing' && !!st.note,
        `refused-send strip: ${JSON.stringify(st)}`,
      );
      expect(
        st.marked.length === 1 && st.marked[0] !== '',
        `echo not marked: ${JSON.stringify(st.marked)}`,
      );
      expect(
        st.shown.length === 1 && st.shown[0] === 'not sent: ' + st.marked[0],
        `marker on screen: ${JSON.stringify(st.shown)}`,
      );
      await page.click('#unsent-restore');
      const back = await page.evaluate(() => ({
        box: (document.getElementById('prompt') as HTMLTextAreaElement).value,
        hidden: (document.getElementById('unsent') as HTMLDivElement).hidden,
      }));
      expect(
        back.box === 'do the thing' && back.hidden,
        `Edit again: ${JSON.stringify(back)}`,
      );
      return `marked '${st.marked[0]}' on the echo, text offered and restored`;
    },
  },
  {
    // The view section builds its own container, so index.html CSS never
    // applies there: this is the only place the detail's real display is seen.
    name: 'P16 tool detail on the real page',
    frames: () => {
      const f = new Frames();
      f.user('read it').upd({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-css',
        title: 'Read src/a.ts',
        status: 'in_progress',
        rawInput: { file_path: '/x/src/a.ts' },
      });
      f.upd({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-css',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'file body' } },
        ],
      });
      return f.asst('answer').done().list;
    },
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await waitForFrame(page, 5, 30_000);
      await settlePage(page);
      const read = () =>
        page.evaluate(() => {
          const d = document.querySelector(
            '#transcript .tool-detail',
          ) as HTMLElement | null;
          const head = document.querySelector('#transcript .tool .tool-head');
          return {
            heads: document.querySelectorAll('#transcript .tool .tool-head')
              .length,
            mark: head ? (head.textContent ?? '') : '',
            display: d ? getComputedStyle(d).display : null,
            height: d ? d.offsetHeight : null,
            text: d ? (d.textContent ?? '') : '',
          };
        });
      const s1 = await read();
      expect(s1.heads === 1, `${s1.heads} tool heads on screen`);
      expect(
        s1.height === null || s1.height === 0,
        `detail is on screen before the tap: ${s1.height}`,
      );
      await page.click('#transcript .tool .tool-head');
      await settlePage(page);
      const s2 = await read();
      expect(
        s2.display === 'block' && (s2.height ?? 0) > 0,
        `detail after the tap: ${JSON.stringify(s2)}`,
      );
      expect(
        s2.text.includes('file_path') && s2.text.includes('file body'),
        `detail text ${JSON.stringify(s2.text.slice(0, 60))}`,
      );
      await page.click('#transcript .tool .tool-head');
      await settlePage(page);
      const s3 = await read();
      // The CSS guard: naming a display on .tool-detail would outrank the UA
      // [hidden] rule, so a closed call would stay on screen.
      expect(
        s3.display === 'none' && s3.height === 0,
        `detail after closing: ${JSON.stringify(s3)}`,
      );
      return `detail opened (block, ${s2.height}px) and closed (display none)`;
    },
  },
  {
    name: 'P17 to-do strip outlives the transcript',
    frames: () => {
      const f = new Frames();
      const plan = (entries: Array<[string, string]>) =>
        f.upd({
          sessionUpdate: 'plan',
          entries: entries.map(([content, status]) => ({
            content,
            priority: 'medium',
            status,
          })),
        });
      f.user('do the thing');
      plan([
        ['read the code', 'pending'],
        ['change it', 'pending'],
        ['test it', 'pending'],
      ]);
      plan([
        ['read the code', 'completed'],
        ['change it', 'in_progress'],
        ['test it', 'pending'],
        ['ship it', 'pending'],
      ]);
      // Long enough that the row near the top is genuinely off screen when the
      // view sits at the end.
      for (let k = 0; k < 40; k++) {
        f.asst(`turn ${k}: lorem ipsum dolor sit amet consectetur elit. `);
      }
      return f.done().list;
    },
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await waitForFrame(page, 44, 30_000);
      await settlePage(page);
      const read = () =>
        page.evaluate(() => {
          const box = document.getElementById('plan') as HTMLDivElement;
          return {
            hidden: box.hidden,
            // Not whether it is on screen: the strip is a row in normal flow
            // below the chat window, and "visible without scrolling" was
            // dropped on 2026-10-21. Whether it is in the document at all is
            // the claim that still means something here.
            shown: box.offsetHeight > 0,
            count: document.getElementById('plan-count')!.textContent ?? '',
            rows: document.getElementById('plan-rows')!.textContent ?? '',
            moreHidden: (document.getElementById('plan-more') as HTMLDivElement)
              .hidden,
            bubbles: document.querySelectorAll('#transcript .bubble.plan')
              .length,
            // Counted on the model, not the DOM: these rows sit near the top,
            // where the virtual core has unmounted them, so a DOM query would
            // read zero whatever the cause.
            dumps: transcriptModel.items.filter(
              (i) => i.kind === 'system' && (i.text ?? '').includes('Plan:'),
            ).length,
          };
        });
      const s1 = await read();
      expect(!s1.hidden, 'the strip is hidden while a plan exists');
      expect(
        s1.count === '1 of 4 done',
        `strip count ${JSON.stringify(s1.count)}`,
      );
      expect(
        s1.rows.includes('change it') && !s1.rows.includes('read the code'),
        `strip rows ${JSON.stringify(s1.rows)}`,
      );
      expect(s1.moreHidden, 'the strip says a hidden count it has no use for');
      // The old dump left a `Plan:` block per frame; there is one row now.
      expect(s1.bubbles === 1, `${s1.bubbles} to-do rows in the transcript`);
      expect(s1.dumps === 0, `${s1.dumps} stacked Plan: dumps left behind`);
      // The strip's reason for existing: the reader is at the newest output, the
      // to-do row itself has been unmounted out of the capped box, and the list
      // still reads. It is a row in normal flow below the chat window, so it is
      // not on screen here; "visible without scrolling" was dropped 2026-10-21.
      const far = await page.evaluate(() => {
        const items = transcriptModel.items;
        const plan = items.find((i) => i.kind === 'plan')!;
        return { seen: __pg.visibleIds().includes(plan.id) };
      });
      expect(
        !far.seen,
        'the to-do row is still on screen, so this proves nothing',
      );
      expect(
        s1.shown,
        `the strip is missing at the end: ${JSON.stringify(s1)}`,
      );
      return `one row (no ${s1.dumps} dumps); strip held "${s1.count}" with the row off screen`;
    },
  },
  {
    // The reason the viewer read as "my conversation is missing": with the
    // New conversation panel open by default it measured 947px, which pushed
    // the transcript entirely below the fold at a 720px viewport. This guards
    // that the conversation is on screen the moment the page loads, with no
    // scrolling, so it goes red if a panel is made default-open again or if
    // enough chrome is added above the transcript to bury it.
    name: 'P25 the transcript is on screen at load',
    frames: () => {
      const f = new Frames();
      const plan = (entries: Array<[string, string]>) =>
        f.upd({
          sessionUpdate: 'plan',
          entries: entries.map(([content, status]) => ({
            content,
            priority: 'medium',
            status,
          })),
        });
      f.user('do the thing');
      plan([
        ['read the code', 'pending'],
        ['change it', 'pending'],
        ['test it', 'pending'],
      ]);
      plan([
        ['read the code', 'completed'],
        ['change it', 'in_progress'],
        ['test it', 'pending'],
        ['ship it', 'pending'],
      ]);
      for (let k = 0; k < 40; k++) {
        f.asst(`turn ${k}: lorem ipsum dolor sit amet consectetur elit. `);
      }
      return f.done().list;
    },
    run: async ({ page, viewer }) => {
      // The height the bug was reported at. Deliberately not the harness
      // default: at a tall viewport the transcript clears the fold whatever
      // the panels do, so a short one is the only height that can go red.
      await page.setViewportSize({ width: 1280, height: 720 });
      await watch(page, viewer.sessionId);
      await waitForFrame(page, 44, 30_000);
      await settlePage(page);
      const g = await page.evaluate(() => {
        const tr = document.getElementById('transcript') as HTMLDivElement;
        const dp = document.getElementById(
          'dir-picker',
        ) as HTMLDetailsElement;
        const tb = tr.getBoundingClientRect();
        return {
          dirPickerOpen: dp.open,
          docHeight: document.documentElement.scrollHeight,
          scrollY: Math.round(scrollY),
          transcript: [Math.round(tb.top), Math.round(tb.bottom)],
          transcriptOnScreen:
            tb.top < innerHeight && tb.bottom > 0 && tr.offsetHeight > 0,
        };
      });
      // Nothing here scrolls the page: the property is about load state, so a
      // scrollY that is not zero would mean the assertion below was measured
      // after something had already moved the document.
      expect(g.scrollY === 0, `the page had already scrolled to ${g.scrollY}`);
      expect(
        !g.dirPickerOpen,
        'the New conversation panel is open by default again, which is what ' +
          'pushed the transcript below the fold',
      );
      expect(
        g.transcriptOnScreen,
        `the transcript is below the fold at load, viewport 720 and it sits ` +
          `at ${JSON.stringify(g.transcript)} of a ${g.docHeight}px document`,
      );
      return `transcript ${JSON.stringify(g.transcript)} visible in a 720px ` +
        `viewport, document ${g.docHeight}px, panel collapsed`;
    },
  },
  {
    name: 'P18 a session with no plan shows no strip',
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.evaluate(() => {
        transcriptModel.addUser('hello');
        transcriptModel.appendAssistant('hi there');
      });
      await settlePage(page);
      const s = await page.evaluate(() => ({
        hidden: (document.getElementById('plan') as HTMLDivElement).hidden,
        rows: document.querySelectorAll('#transcript .bubble.plan').length,
      }));
      expect(s.hidden, 'the strip is shown for a session that never planned');
      expect(s.rows === 0, `${s.rows} to-do rows without any plan frame`);
      return 'no plan frame, no strip and no row';
    },
  },
  {
    // #70. The prompt POST awaits the whole turn, so the send button was held
    // by that request: one that never settled left the button disabled until a
    // page refresh. The turn ending is the real release signal, so the button
    // must come back on turn_complete with the request still open. The 3 s
    // bound below is what makes this a test rather than a restatement of
    // P14: the stub holds this request for 12 s, so a button that is only
    // released by the request cannot come back inside it.
    name: 'P19 turn_complete returns the send button mid-request',
    stub: { promptDelayMs: 12_000 },
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.evaluate(() => {
        (document.getElementById('prompt') as HTMLTextAreaElement).value =
          'hold the turn';
        void (document.getElementById('send') as HTMLButtonElement).onclick!();
      });
      const held = await page.evaluate(() => {
        const btn = document.getElementById('send') as HTMLButtonElement;
        const cs = getComputedStyle(btn);
        return {
          disabled: btn.disabled,
          inflight: abandonPendingSend != null,
          label: btn.textContent ?? '',
          cursor: cs.cursor,
          opacity: Number.parseFloat(cs.opacity),
        };
      });
      expect(held.disabled, 'the send button was never held');
      expect(held.inflight, 'no send was registered as in flight');
      // A held button that still looks pressable is the reported fault: a press
      // on a disabled button is swallowed with no trace at all, so being held
      // has to be visible on the button itself. The reason line goes to #status
      // at the top of the page, which is off screen from the composer.
      expect(
        held.cursor === 'not-allowed',
        `the held button still looks pressable, cursor: ${held.cursor}`,
      );
      expect(
        held.opacity < 1,
        `the held button is undimmed, opacity: ${held.opacity}`,
      );
      expect(
        held.label.includes('waiting'),
        `the held button says nothing about being held: ${JSON.stringify(held.label)}`,
      );
      // The turn ends over the watch while the POST is still hanging.
      await page.evaluate(() => {
        renderFrame({ type: 'turn_complete', data: {} });
      });
      await page.waitForFunction(
        () => !(document.getElementById('send') as HTMLButtonElement).disabled,
        null,
        { timeout: 3_000 },
      );
      const after = await page.evaluate(() => ({
        status: document.getElementById('status')!.textContent ?? '',
        inflight: abandonPendingSend != null,
      }));
      expect(
        after.status.includes('turn ended'),
        `the release said nothing about itself: ${JSON.stringify(after)}`,
      );
      expect(!after.inflight, 'the abandoned send is still registered');
      return 'button back on turn_complete, request still open';
    },
  },
  {
    // #70. The watchdog is the same release channel, fired by a timer rather
    // than by a frame. Its timer is 3 minutes and is not the thing under test,
    // so this drives the channel exactly as the timer callback does and pins
    // the outcome: the button returns, the reason is stated, and a send of
    // unknown outcome is NOT reported as unsent, because the turn may still be
    // running and claiming otherwise would be its own false statement.
    name: 'P20 abandoning a hung send reports it without a false not-sent',
    stub: { promptDelayMs: 12_000 },
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.evaluate(() => {
        (document.getElementById('prompt') as HTMLTextAreaElement).value =
          'into a dead connection';
        void (document.getElementById('send') as HTMLButtonElement).onclick!();
      });
      const held = await page.evaluate(() => ({
        disabled: (document.getElementById('send') as HTMLButtonElement)
          .disabled,
        inflight: abandonPendingSend != null,
      }));
      expect(held.disabled, 'the send button was never held');
      expect(held.inflight, 'no send was registered as in flight');
      await page.evaluate(() => {
        abandonPendingSend?.('watchdog');
      });
      await page.waitForFunction(
        () => !(document.getElementById('send') as HTMLButtonElement).disabled,
        null,
        { timeout: 3_000 },
      );
      const st = await page.evaluate(() => ({
        status: document.getElementById('status')!.textContent ?? '',
        unsentHidden: (document.getElementById('unsent') as HTMLDivElement)
          .hidden,
        marks: transcriptModel.items
          .filter((i) => i.kind === 'user')
          .map((i) => (i as { notSent?: string }).notSent ?? ''),
      }));
      expect(
        st.status.includes('still running'),
        `the abandon was silent: ${JSON.stringify(st)}`,
      );
      expect(
        st.unsentHidden,
        'a send of unknown outcome was reported as unsent',
      );
      expect(
        st.marks.length === 1 && st.marks[0] === '',
        `echo carries a not-sent mark: ${JSON.stringify(st.marks)}`,
      );
      return 'button back, reason stated, no false not-sent claim';
    },
  },
  {
    // #69's browser half. A host-terminal request is best-effort so that a
    // machine with no launcher cannot block a chat, but it was silent as well
    // as best-effort: only 202 wrote a status and the catch was empty, so every
    // other outcome left no trace. Best-effort must mean non-blocking, not
    // unreported.
    name: 'P21 a refused host-terminal request says why',
    before: async (page) => {
      await page.route('**/rc/terminals', (route) =>
        route.fulfill({
          status: 501,
          contentType: 'application/json',
          body: '{"error":"This gateway cannot open host terminals","code":"host_terminals_unsupported"}',
        }),
      );
    },
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.evaluate(() => {
        setStatus('sent: stop');
        return requestHostTerminal('sess-1');
      });
      // Waited for rather than read straight back: the regression this guards
      // is silence, and a silent path would leave the previous status in place
      // for an immediate read to pass on. The predicate is written out inline
      // because it is serialised into the page, where no outer binding exists.
      await page.waitForFunction(
        () =>
          (
            document.getElementById('status') as HTMLDivElement
          ).textContent?.includes('no terminal on the host') === true,
        null,
        { timeout: 8_000 },
      );
      const refused = await page.evaluate(
        () => document.getElementById('status')!.textContent ?? '',
      );
      expect(
        refused.includes('cannot open host terminals'),
        `the 501 reason was not carried: ${JSON.stringify(refused)}`,
      );
      // And a request that never got an answer at all: the gateway being
      // unreachable is a different fact from the feature declining.
      await page.unrouteAll();
      await page.route('**/rc/terminals', (route) => route.abort());
      await page.evaluate(() => {
        setStatus('sent: stop');
        return requestHostTerminal('sess-1');
      });
      await page.waitForFunction(
        () =>
          (
            document.getElementById('status') as HTMLDivElement
          ).textContent?.includes('did not answer') === true,
        null,
        { timeout: 8_000 },
      );
      const dead = await page.evaluate(
        () => document.getElementById('status')!.textContent ?? '',
      );
      return `501 -> ${JSON.stringify(refused)}; aborted -> ${JSON.stringify(dead)}`;
    },
  },
  {
    // #69's other half. P21 covers a request the gateway refused outright; this
    // covers the one it accepted, which used to always say "opening on the host"
    // off a 202 alone. 202 only means the request was written down, so the note
    // now follows the gateway's report of whether its launcher is checking in.
    name: 'P22 an accepted host-terminal request qualifies the window',
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      // The route is swapped per case rather than once because each case is a
      // different thing the gateway could truthfully report, and the status line
      // is the only surface where the difference is visible.
      const answer = async (body: string) => {
        await page.unrouteAll();
        await page.route('**/rc/terminals', (route) =>
          route.fulfill({
            status: 202,
            contentType: 'application/json',
            body,
          }),
        );
        await page.evaluate(() => {
          setStatus('sent: stop');
          return requestHostTerminal('sess-1');
        });
      };
      // Waited for rather than read straight back, same as P21: the failure
      // being guarded is a branch not being taken, which otherwise leaves the
      // sentinel above in place for an immediate read to pass on.
      const say = async (needle: string) => {
        await page.waitForFunction(
          (n: string) =>
            (
              document.getElementById('status') as HTMLDivElement
            ).textContent?.includes(n) === true,
          needle,
          { timeout: 8_000 },
        );
        return page.evaluate(
          () => document.getElementById('status')!.textContent ?? '',
        );
      };

      await answer(
        '{"requestId":"r1","launcherState":"live","launcherSeenMsAgo":1500}',
      );
      const live = await say('opening on the host');
      expect(
        !live.includes('queued'),
        `a live launcher should still promise a window: ${JSON.stringify(live)}`,
      );

      await answer(
        '{"requestId":"r1","launcherState":"stale","launcherSeenMsAgo":60000}',
      );
      const stale = await say('stopped checking in');
      expect(
        stale.includes('60 s ago') && !stale.includes('opening'),
        `a stale launcher was not qualified: ${JSON.stringify(stale)}`,
      );

      await answer(
        '{"requestId":"r1","launcherState":"never","launcherSeenMsAgo":null}',
      );
      const never = await say('no launcher has ever checked in');
      expect(
        !never.includes('opening'),
        `a host with no launcher promised a window: ${JSON.stringify(never)}`,
      );

      // An older gateway answers 202 with just the id. Guessing well there is
      // what produced the note this replaces, so the absence has to be said.
      await answer('{"requestId":"r1"}');
      const blind = await say('cannot tell whether a launcher is running');
      expect(
        !blind.includes('opening'),
        `a gateway that reports nothing guessed well: ${JSON.stringify(blind)}`,
      );

      return `live -> ${JSON.stringify(live)}; stale -> ${JSON.stringify(stale)}; never -> ${JSON.stringify(never)}; no report -> ${JSON.stringify(blind)}`;
    },
  },
  {
    // #71. The indicator was armed at send and disarmed by the first prose or
    // thought chunk, so it could not cover the rest of the turn, which is the
    // reported "long periods of time, maybe after tool calls" with no sign of
    // work. It is now driven by whether the transcript has gone quiet while the
    // turn is still open. Counted on the model rather than the DOM: the
    // virtualizer unmounts rows, so a DOM count reads zero whatever the cause.
    name: 'P23 the indicator covers the quiet gaps of a turn',
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      const beat = await page.evaluate(() => PROCESSING_QUIET_MS);
      const wait = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const thinking = () =>
        page.evaluate(
          () =>
            (
              transcriptModel.items as Array<{ kind: string }>
            ).filter((i) => i.kind === 'processing').length,
        );

      // A turn of ours, armed the way the send handler arms it.
      await page.evaluate(() => showProcessing());
      const armed = await thinking();
      expect(armed === 1, `arming a turn showed ${armed} indicators`);

      // Proof of work arrives, so it stands down. This is the old design's
      // whole behaviour, kept: a streaming turn does not also get a spinner.
      await page.evaluate(() =>
        renderSessionUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'first words of the answer' },
        }),
      );
      const streaming = await thinking();
      expect(
        streaming === 0,
        `the indicator competed with streaming text (${streaming})`,
      );

      // The defect. The transcript has gone quiet mid-turn, which is the state
      // that used to stay blank for the rest of the turn.
      await wait(beat + 700);
      const gap = await thinking();
      expect(
        gap === 1,
        `a quiet gap mid-turn showed nothing, which is the #71 defect (${gap})`,
      );

      // A running tool row is better evidence than a spinner, so it holds the
      // indicator back for as long as it lasts.
      await page.evaluate(() =>
        renderSessionUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: 'call-running-1',
          status: 'running',
        }),
      );
      await wait(beat + 700);
      const duringTool = await thinking();
      expect(
        duringTool === 0,
        `the indicator doubled up with a running tool row (${duringTool})`,
      );

      // The row settling is one of the gaps the indicator exists for.
      await page.evaluate(() =>
        renderSessionUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-running-1',
          status: 'completed',
        }),
      );
      await wait(beat + 700);
      const afterTool = await thinking();
      expect(
        afterTool === 1,
        `no indicator in the gap after a tool settled (${afterTool})`,
      );

      // The other half of the contract: once the turn is over it must stay
      // down, or it would claim work that stopped, which is the same error
      // pointed the other way.
      await page.evaluate(() => endTurn());
      await wait(beat + 700);
      const ended = await thinking();
      expect(
        ended === 0,
        `the indicator outlived the turn and is claiming work that stopped (${ended})`,
      );

      return `armed, quiet mid-turn -> back, running tool -> held, tool settled -> back, turn over -> stays down (beat ${beat} ms)`;
    },
  },
  {
    // #72 made the strip narrate its own absence, on the grounds that a hidden
    // strip and a broken one look alike. Reversed on the reader's instruction:
    // the strip shows up only once the model has actually put something on it.
    // The distinction #72 cared about is still answerable, from the raw log
    // rather than from the page, so this guards both halves, quiet on screen and
    // counted and worded in the log.
    // Asserted on the real page because the question is what is on screen.
    name: 'P24 the to-do strip stays out until the model puts work on it',
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      const beat = await page.evaluate(() => PROCESSING_QUIET_MS);
      const wait = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const state = () =>
        page.evaluate(() => {
          const box = document.getElementById('plan') as HTMLDivElement;
          return {
            shown: !box.hidden && box.offsetHeight > 0,
            rows: (document.getElementById('plan-rows')!.textContent ?? '').trim(),
            count: document.getElementById('plan-count')!.textContent ?? '',
            frames: planFramesSeen,
          };
        });

      // A session with content and no plan frame of any kind.
      await page.evaluate(() => {
        addUser('what is the plan');
        renderSessionUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'reading the code now' },
        });
      });
      // The claim has to wait for the stream to settle. A replay may still be
      // carrying a plan, and asserting "stay out" mid-replay would assert
      // something the next frame proves false.
      const early = await state();
      expect(
        !early.shown,
        `the strip appeared before the stream settled (${JSON.stringify(early)})`,
      );

      await wait(beat + 700);
      const absent = await state();
      expect(
        !absent.shown,
        `a session with no plan put a strip on screen (${JSON.stringify(absent)})`,
      );
      expect(
        absent.frames === 0,
        `a session with no plan counted plan frames (${absent.frames})`,
      );

      // The other meaning. A plan frame arrives and the model keeps nothing
      // renderable from it. On screen it is now indistinguishable from the
      // ordinary absence, by design, so the guard moves to the two places that
      // can still tell them apart, the per-session count and the raw log.
      await page.evaluate(() =>
        renderSessionUpdate({ sessionUpdate: 'plan', entries: [] }),
      );
      const fault = await state();
      expect(
        !fault.shown,
        `a plan frame that held nothing still put a strip on screen (${JSON.stringify(fault)})`,
      );
      expect(
        fault.frames === 1,
        `the fault did not reach the per-session count (${fault.frames})`,
      );
      const traced = await page.evaluate(
        () => logLines.filter((l) => l.includes('held nothing to show')).length,
      );
      expect(
        traced > 0,
        'the fault left no trace in the raw log, so it is not answerable from the page',
      );

      // A real plan is the one thing that earns the strip a place on screen.
      await page.evaluate(() =>
        renderSessionUpdate({
          sessionUpdate: 'plan',
          entries: [
            { content: 'read the code', priority: 'medium', status: 'completed' },
            { content: 'change it', priority: 'medium', status: 'pending' },
          ],
        }),
      );
      const list = await state();
      expect(
        list.shown && list.rows.includes('change it'),
        `a real plan did not put the strip on screen (${JSON.stringify(list)})`,
      );
      expect(
        list.count === '1 of 2 done',
        `strip count ${JSON.stringify(list.count)}`,
      );

      // The case this scenario stopped one frame short of: a plan in which every
      // entry has finished. planTally sorts a completed entry into `done` and
      // everything else into `open`, so this leaves the plan item in place with
      // `open` empty. The strip stays up and carries the tally, because it
      // answers "where is the run up to" and a finished list is still that
      // answer; a strip that disappears on the last frame is indistinguishable
      // from one that broke (#72). Only the row list goes empty, since a done
      // entry keeps no text. The frame count is asserted alongside so this
      // cannot pass by the frame never arriving.
      await page.evaluate(() =>
        renderSessionUpdate({
          sessionUpdate: 'plan',
          entries: [
            { content: 'read the code', priority: 'medium', status: 'completed' },
            { content: 'change it', priority: 'medium', status: 'completed' },
          ],
        }),
      );
      const finished = await state();
      expect(
        finished.frames === list.frames + 1,
        `the finished plan did not reach the per-session count ` +
          `(${list.frames} -> ${finished.frames})`,
      );
      expect(
        finished.shown,
        `a plan with every item done took the strip off screen, so the reader ` +
          `cannot tell it finished from it having broken ` +
          `(${JSON.stringify(finished)})`,
      );
      expect(
        finished.count === '2 of 2 done',
        `strip count once every item finished ` +
          `(${JSON.stringify(finished.count)})`,
      );
      expect(
        finished.rows === '',
        `the row list still named finished items ` +
          `(${JSON.stringify(finished.rows)})`,
      );

      // The per-session facts go with the session. Without the reset the next
      // one would open wearing this one's list.
      await page.evaluate(() => clearTranscript());
      const next = await state();
      expect(
        !next.shown,
        `the list carried into a new session (${JSON.stringify(next)})`,
      );
      return `quiet with no plan, quiet and counted and logged on an empty frame, on screen only for a real list, nothing inherited`;
    },
  },
  {
    // #50. Two windows must be able to hold two different conversations. The
    // watch pointer used to live only in localStorage, which is shared by every
    // tab on the origin, so the last window to write it decided what every
    // other window opened on its next reload. Cross-device mirroring of ONE
    // conversation is wanted; a single pointer that also decides what each
    // separate window is looking at is not, and no storage key name can do both.
    // Asserted on two pages in one browser context on purpose: that is the
    // configuration that shares localStorage and does not share sessionStorage,
    // which is exactly the seam the fix rests on. Asserted by which conversation
    // each window is on rather than by a key name, so the guard does not
    // over-specify where the pointer is kept.
    name: 'P26 two windows hold two different conversations',
    run: async ({ page, viewer }) => {
      const OTHER = '22222222-3333-4444-5555-666666666666';
      const here = viewer.sessionId;

      // Window A takes the harness session and marks it with a line only it should
      // see. The gate is the first frame landing, not watchedSessionId: startWatch
      // assigns that synchronously before its await on the event stream, and the
      // clearTranscript that opens a from-0 replay runs after that await resolves,
      // so waiting on the id releases before the clear and the marker is wiped by
      // the hand-off that just asked for it. A frame can only land after that
      // clear, so the frame is the honest signal.
      await watch(page, here);
      await waitForFrame(page, 1, 30_000);
      await page.evaluate(() => addUser('alpha only'));
      const onA = () =>
        page.evaluate(() => ({
          id: watchedSessionId,
          text: transcriptModel.items
            .map((i) => i.text ?? '')
            .join('\n'),
        }));

      // Window B, same context, so it shares A's localStorage and token and
      // does not share A's sessionStorage.
      const ctx = page.context();
      const b = await ctx.newPage();
      try {
        await b.addInitScript({ content: PAGE_HELPERS_JS });
        await b.goto(`${viewer.url}/ui/`, { waitUntil: 'domcontentloaded' });
        await b.waitForFunction(() => typeof startWatch === 'function');
        await b.evaluate((id) => {
          lastSeenEventId = null;
          void startWatch(id);
        }, OTHER);
        // Same gate as window A, for the same reason.
        await waitForFrame(b, 1, 30_000);
        await b.evaluate(() => addUser('beta only'));
        const onB = () =>
          b.evaluate(() => ({
            id: watchedSessionId,
            text: transcriptModel.items
              .map((i) => i.text ?? '')
              .join('\n'),
          }));

        // Both are live at once, each on its own conversation.
        const aFirst = await onA();
        const bFirst = await onB();
        expect(
          aFirst.id === here,
          `window A moved off its own conversation to ${JSON.stringify(aFirst.id)}`,
        );
        expect(
          bFirst.id === OTHER,
          `window B is on ${JSON.stringify(bFirst.id)}, expected ${OTHER}`,
        );

        // No cross-talk. This is the failure a reader would actually see: not a
        // broken page, a message that appears to have gone to the wrong
        // conversation.
        expect(
          aFirst.text.includes('alpha only') && !aFirst.text.includes('beta only'),
          `window A's transcript is not its own (${JSON.stringify(aFirst.text)})`,
        );
        expect(
          bFirst.text.includes('beta only') && !bFirst.text.includes('alpha only'),
          `window B's transcript is not its own (${JSON.stringify(bFirst.text)})`,
        );

        // The case that breaks today. B wrote the shared pointer last, so a
        // reload of A comes back on B's conversation.
        await b.reload({ waitUntil: 'domcontentloaded' });
        await b.waitForFunction(() => typeof startWatch === 'function');
        await b.waitForFunction(() => watchedSessionId !== null);
        const bReloaded = await onB();
        expect(
          bReloaded.id === OTHER,
          `window B lost its own conversation across a reload (got ${JSON.stringify(bReloaded.id)})`,
        );

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof startWatch === 'function');
        await page.waitForFunction(() => watchedSessionId !== null);
        const aReloaded = await onA();
        expect(
          aReloaded.id === here,
          `window A came back on window B's conversation after B wrote the shared pointer, which is the #50 defect (A got ${JSON.stringify(aReloaded.id)}, wanted ${here})`,
        );

        return `two windows on two conversations, no cross-talk, each keeps its own across a reload`;
      } finally {
        await b.close();
      }
    },
  },
  {
    // #50. The switcher is the visible half of multi-conversation support, and
    // the whole reason it exists as its own control is that the only previous
    // route to another conversation lives inside #dir-picker, which is collapsed
    // by default. So the load-bearing property is not that it lists
    // conversations, it is that it is reachable WITHOUT opening that panel. An
    // implementation that put it inside the panel would pass a test that only
    // asked "does it list them", which is the assertion this one refuses to make
    // on its own. Asserted on the real page because on-screen-ness is the claim.
    name: 'P27 the way to another conversation is on screen without opening the panel',
    run: async ({ page, viewer }) => {
      const here = viewer.sessionId;
      const OTHER = '22222222-3333-4444-5555-666666666666';
      const CWD = '/home/evan/scratch';
      // Gate on the first frame, not on watchedSessionId, for the reason P26
      // documents: the id is assigned before the hand-off that clears the
      // transcript, so waiting on it releases too early.
      await watch(page, here);
      await waitForFrame(page, 1, 30_000);

      const state = () =>
        page.evaluate(() => {
          const box = document.getElementById('convo-switch') as HTMLDivElement;
          const list = document.getElementById(
            'convo-switch-list',
          ) as HTMLSelectElement;
          return {
            shown: !box.hidden && box.offsetHeight > 0,
            // The property the whole control exists for.
            insidePanel: document
              .getElementById('dir-picker')!
              .contains(box),
            panelOpen: (
              document.getElementById('dir-picker') as HTMLDetailsElement
            ).open,
            options: Array.from(list.options).map((o) => o.textContent ?? ''),
            picked: list.value,
            note: document.getElementById('convo-switch-note')!.textContent ?? '',
          };
        });

      // A folder with one conversation gets no control at all. A select holding
      // the one option already chosen is a control that cannot do anything, and
      // that reads as broken rather than as quiet.
      await page.evaluate(
        ([id, cwd]) => {
          renderPastConversations([{ sessionId: id, title: 'only one' }], cwd, false);
        },
        [here, CWD],
      );
      const alone = await state();
      expect(
        !alone.shown,
        `a folder with one conversation offered a control that can do nothing (${JSON.stringify(alone)})`,
      );

      // Two conversations, so there is somewhere to go.
      await page.evaluate(
        ([id, other, cwd]) => {
          renderPastConversations(
            [
              { sessionId: id, title: 'the one on screen' },
              { sessionId: other, title: 'the other one' },
            ],
            cwd,
            false,
          );
        },
        [here, OTHER, CWD],
      );
      const two = await state();
      expect(
        !two.insidePanel,
        'the switcher is inside #dir-picker, so reaching another conversation costs the click this control exists to remove',
      );
      expect(
        !two.panelOpen,
        'the test assumed the panel is collapsed, which is what makes the assertion above mean anything',
      );
      expect(
        two.shown,
        `two conversations in the folder and no way to the other one on screen (${JSON.stringify(two)})`,
      );
      expect(
        two.options.some((t) => t.includes('the other one')),
        `the other conversation is not offered (${JSON.stringify(two.options)})`,
      );
      expect(
        two.picked === here,
        `the switcher marks ${JSON.stringify(two.picked)} as the conversation on screen, not ${here}`,
      );
      expect(
        two.note.includes(CWD),
        `the switcher does not say which folder it is listing (${JSON.stringify(two.note)})`,
      );

      // The list is the folder's whole set, not whatever the panel's filter
      // currently happens to show. A switcher that inherited that view state
      // would quietly drop conversations the reader cannot get back to.
      await page.evaluate(() => {
        const f = document.getElementById('past-filter') as HTMLInputElement;
        f.value = 'nothing matches this';
        f.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const filtered = await state();
      expect(
        filtered.shown &&
          filtered.options.some((t) => t.includes('the other one')),
        `the panel's filter took options off the switcher (${JSON.stringify(filtered.options)})`,
      );

      // Unwatching leaves nothing to switch from, so the control goes away
      // rather than sitting on a stale folder.
      await page.evaluate(() => {
        (document.getElementById('stop') as HTMLButtonElement).click!();
      });
      const stopped = await state();
      expect(
        !stopped.shown,
        `the switcher stayed on screen after Unwatch (${JSON.stringify(stopped)})`,
      );
      return `no control for one conversation, on screen with the panel shut for two, marks the one on screen, survives the panel filter, gone on Unwatch`;
    },
  },
  {
    // #50. P27 hands the list to renderPastConversations itself, so it would
    // keep passing if no real load ever reached that function. That is exactly
    // the shape of the complaint this control exists to answer: something that
    // works when it is driven and never appears on the page. So this covers the
    // other half, that a default load feeds it, and it does it by watching the
    // page fill its own state rather than by calling anything. The chain is
    // capabilities -> browseTo -> renderDirList -> refreshPastConversations ->
    // renderPastConversations -> renderConvoSwitch, and nothing but that chain
    // assigns curDirPath or pastConvosCwd.
    //
    // The two halves are independently load-bearing. Remove the browse-time
    // refresh and the first half fails; remove the renderConvoSwitch call from
    // renderPastConversations and only the second does.
    name: 'P28 a default load feeds the switcher without anything being driven',
    run: async ({ page, viewer }) => {
      // The premise that makes this control necessary at all: on a load the
      // folder panel is shut, so everything inside it is off screen.
      const premise = await page.evaluate(() => ({
        panelOpen: (
          document.getElementById('dir-picker') as HTMLDetailsElement
        ).open,
      }));
      expect(
        !premise.panelOpen,
        'the folder panel came up open on a load, so the reachability this and P27 guard is not the property it is written to guard',
      );

      // Both of these are the load path doing its own work. The runner has
      // already navigated, so waiting is the whole of the driving here.
      await page.waitForFunction(() => curDirPath !== null);
      await page.waitForFunction(() => pastConvosCwd !== null);
      const fed = await page.evaluate(() => ({
        dir: curDirPath,
        list: pastConvosCwd,
        count: pastConvos.length,
      }));
      expect(
        fed.list === fed.dir,
        `the conversation list was fetched for ${JSON.stringify(fed.list)} while the folder on screen is ${JSON.stringify(fed.dir)}, so the switcher would list some other folder's conversations`,
      );

      // The feed is real but the control still has to be drawn from it, and
      // that is the half the removal of one call would break. Feeding through
      // renderPastConversations is the same entry point the chain above just
      // used, not a private path into the switcher.
      //
      // The order here is the whole of the test, and it was got wrong first.
      // Watching a conversation draws the switcher on its own, because
      // showSessionTitle hooks it, and on a real load the folder already holds
      // conversations. So a scenario that only ever ADDED a conversation could be
      // satisfied by that other hook and would pass with the feed hook deleted,
      // which is exactly what happened when this was mutation-tested. Collapsing
      // the list to the conversation already on screen first makes the correct
      // answer NO control, so the only thing left that can bring it back is a
      // list arriving with no change to the conversation on screen.
      const here = viewer.sessionId;
      const OTHER = '22222222-3333-4444-5555-666666666666';
      await watch(page, here);
      await waitForFrame(page, 1, 30_000);
      await page.evaluate(
        ([id, cwd]) => {
          renderPastConversations([{ sessionId: id, title: 'only one' }], cwd, false);
        },
        [here, fed.dir],
      );
      const quiet = await page.evaluate(() => ({
        shown:
          !document.getElementById('convo-switch')!.hidden &&
          document.getElementById('convo-switch')!.offsetHeight > 0,
      }));
      expect(
        !quiet.shown,
        `the switcher stayed on screen listing nothing but the conversation already on screen (${JSON.stringify(quiet)})`,
      );

      // The second conversation arrives with the conversation on screen
      // unchanged. Nothing but the feed hook draws the control from this.
      await page.evaluate(
        ([id, other, cwd]) => {
          renderPastConversations(
            [
              { sessionId: id, title: 'the one on screen' },
              { sessionId: other, title: 'the other one' },
            ],
            cwd,
            false,
          );
        },
        [here, OTHER, fed.dir],
      );
      const grown = await page.evaluate(() => ({
        shown:
          !document.getElementById('convo-switch')!.hidden &&
          document.getElementById('convo-switch')!.offsetHeight > 0,
        panelOpen: (
          document.getElementById('dir-picker') as HTMLDetailsElement
        ).open,
      }));
      expect(
        grown.shown && !grown.panelOpen,
        `a conversation arrived in the folder while the switcher sat hidden, and it did not come on screen with the panel shut (${JSON.stringify(grown)})`,
      );

      return `load path filled ${JSON.stringify(fed.dir)} on its own (${fed.count} conversations found), list matches the folder on screen, control drawn by a list arriving rather than by the watch`;
    },
  },
  {
    // #70. "I should be able to queue messages whenever." Send is held for the
    // whole turn on purpose, two shipped scenarios assert that hold, so the
    // ability to queue arrived as its own control. This guards the control and,
    // more importantly, the two ways the drain could take something from the
    // reader: sending over a draft the send path would clear, and reporting a
    // queue as waiting when the button is not actually free.
    name: 'P29 a message can be queued during a turn and goes when the turn ends',
    stub: { promptDelayMs: 2_500 },
    run: async ({ page, viewer }) => {
      const here = viewer.sessionId;
      const state = () =>
        page.evaluate(() => ({
          held: (document.getElementById('send') as HTMLButtonElement).disabled,
          queueable: !document.getElementById('queue')!.hidden,
          strip:
            !document.getElementById('queued')!.hidden &&
            document.getElementById('queued')!.offsetHeight > 0,
          waiting:
            document.getElementById('queued-text')!.textContent ?? '',
          draft: (document.getElementById('prompt') as HTMLTextAreaElement).value,
          queued: outbox.slice(),
          stored: localStorage.getItem('qwen-rc:outbox:' + watchedSessionId),
        }));

      await watch(page, here);
      await waitForFrame(page, 1, 30_000);

      // Quiet when there is nothing to do, the same rule the to-do strip and the
      // conversation switcher follow. A Queue button outside a turn is a Send
      // button that does not send.
      const calm = await state();
      expect(
        !calm.queueable && !calm.strip,
        `with no turn running the composer offered a queue it does not need (${JSON.stringify({ q: calm.queueable, s: calm.strip })})`,
      );

      // During a turn the way to queue is on screen. This is the whole of the
      // ask: the user should not have to refresh to make progress.
      await page.evaluate(() => {
        (document.getElementById('prompt') as HTMLTextAreaElement).value =
          'the turn is running';
        (document.getElementById('send') as HTMLButtonElement).click!();
      });
      const held = await state();
      expect(
        held.held,
        'the send button was not held during the turn, so this scenario is not testing what it is written to test',
      );
      expect(
        held.queueable,
        'Send is held for the whole turn and nothing on screen offered to queue during it, which is the #70 complaint',
      );

      // Capture: the text leaves the composer and is shown as waiting. Shown,
      // not held in a variable, because text the reader cannot see reads as lost.
      await page.evaluate(() => {
        (document.getElementById('prompt') as HTMLTextAreaElement).value =
          'queued while busy';
        (document.getElementById('queue') as HTMLButtonElement).click!();
      });
      const queued = await state();
      expect(
        queued.draft.trim() === '',
        `queueing left the text in the composer, so the next thought would be sent on top of it (${JSON.stringify(queued.draft)})`,
      );
      expect(
        queued.strip && queued.waiting.includes('queued while busy'),
        `the queued message is not shown waiting (${JSON.stringify({ s: queued.strip, w: queued.waiting })})`,
      );
      expect(
        queued.queued.length === 1 && String(queued.stored ?? '').includes('queued while busy'),
        `the queued message is not held across a reload (${JSON.stringify({ q: queued.queued, st: queued.stored })})`,
      );

      // The drain must not take a draft. The send path clears the composer at
      // dispatch, so dispatching over text being typed would remove it with no
      // way to get it back.
      //
      // This has to be reached with Send free, and that is the whole of the
      // point. Drained while the turn still holds the button, the drain stops at
      // its own wait-for-the-button branch and never gets to the branch the
      // guard is the only thing protecting, so the assertion reads green with the
      // guard deleted. Mutation-proving this found exactly that.
      await page.waitForFunction(() => abandonPendingSend === null);
      await page.evaluate(() => {
        (document.getElementById('prompt') as HTMLTextAreaElement).value =
          'a draft being typed';
        drainOutbox(0);
      });
      const overDraft = await state();
      expect(
        overDraft.draft.includes('a draft being typed'),
        `the drain dispatched over a draft and the send path cleared it (${JSON.stringify(overDraft.draft)})`,
      );
      expect(
        overDraft.queued.length === 1,
        `the drain dropped the queued message while refusing to send over a draft (${JSON.stringify(overDraft.queued)})`,
      );

      // The composer is free now, so the same drain goes.
      await page.evaluate(() => {
        (document.getElementById('prompt') as HTMLTextAreaElement).value = '';
        drainOutbox(0);
      });
      const gone = await state();
      expect(
        gone.queued.length === 0 && gone.stored === null,
        `the drain left the message queued with the composer free (${JSON.stringify({ q: gone.queued, st: gone.stored })})`,
      );

      // Counted on the model, not the DOM, and it is the real send path that put
      // it there, since the drain presses Send rather than copying the request.
      const sent = await page.evaluate(() =>
        transcriptModel.items
          .map((i) => i.text ?? '')
          .join('\n')
          .includes('queued while busy'),
      );
      expect(
        sent,
        'the drain emptied the queue without the text reaching the transcript, so the message was thrown away rather than sent',
      );

      return 'quiet outside a turn, on screen during one, captured and shown and stored, refuses to send over a draft, goes through Send when free';
    },
  },
  {
    name: 'P9 curve',
    standalone: async () => {
      const runs: Growth[] = [];
      for (const turns of [200, 1000, 2000]) {
        const g = await measureGrowth(turns);
        console.log(
          `  ${turns} turns: replay ${g.replayMs} ms, nodes ${g.totalNodes} ` +
            `(transcript ${g.transcriptNodes}), ${g.perChunkMs} ms/chunk ` +
            `(${g.perChunkFrameMs} ms/chunk with its frame), ` +
            `heap ${g.jsHeapMb} MB, rss ${g.rendererRssMb} MB`,
        );
        expect(g.finished, `${turns}-turn replay did not finish`);
        runs.push(g);
      }
      const [small, , big] = runs as [Growth, Growth, Growth];
      expect(
        Math.abs(big.totalNodes - small.totalNodes) <= 0.1 * small.totalNodes,
        `nodes ${small.totalNodes} -> ${big.totalNodes} (> 10%)`,
      );
      expect(
        big.perChunkMs <= 2 * small.perChunkMs,
        `per-chunk ${small.perChunkMs} -> ${big.perChunkMs} ms (> 2x)`,
      );
      // Rendering is deferred to the animation frame: hold the frame-inclusive
      // cost to the same bound.
      expect(
        big.perChunkFrameMs <= 2 * small.perChunkFrameMs,
        `per-chunk with its frame ${small.perChunkFrameMs} -> ${big.perChunkFrameMs} ms (> 2x)`,
      );
      return runs
        .map(
          (g) =>
            `${g.turns}: ${g.totalNodes} nodes ${g.perChunkMs}/${g.perChunkFrameMs} ms`,
        )
        .join('; ');
    },
  },
  {
    // #73. The indicator had one arm point: the local echo of a prompt this
    // window sent. A turn started on the laptop therefore showed nothing at
    // all, because its only arrival here is the daemon's user record. Adding
    // that as the second arm point is the whole fix, and the danger is all in
    // one fact: replay carries no turn_complete, so a turn armed from a
    // replayed user record could never be stood down. Ungated, every idle
    // session with a prompt history would claim work forever on every attach.
    // So the arm is gated on being outside a replay, and this pins both halves.
    //
    // The negative half runs for real rather than being hand-fed: the frames
    // below ARE the replay, `startWatch(id, 0)` is the cursor that asks for it,
    // and the gate is armed by the viewer reading that cursor. The stub cannot
    // express an id-less frame (stubDaemon.ts:586 writes `id` unconditionally),
    // so the boundary frame is driven the way this file's own helpers drive
    // `turn_complete`, and the positive half follows it.
    name: 'P30 a replayed user record does not arm the indicator, a live one does',
    frames: () => new Frames().user('started on the laptop').list,
    run: async ({ page, viewer }) => {
      const thinking = () =>
        page.evaluate(
          () =>
            transcriptModel.items.filter((i) => i.kind === 'processing').length,
        );

      // The half that would have made the fix unusable. Cursor 0 asks for the
      // whole journal, so the user record above arrives as history.
      await page.evaluate((id) => {
        lastSeenEventId = null;
        void startWatch(id, 0);
      }, viewer.sessionId);
      // The composer only becomes visible once a watch is running, so this
      // waits after the watch and not before it, which is the order its
      // neighbours use. Waiting first cannot resolve.
      await page.waitForSelector('#composer', { state: 'visible' });
      await waitForFrame(page, 1, 8_000);
      const replayed = await thinking();
      expect(
        replayed === 0,
        `a replayed user record armed the indicator (${replayed}). Replay has ` +
          'no turn_complete to stand it down, so this is the permanent false ' +
          'claim an idle session would carry on every attach',
      );

      // The boundary is a fence and not an arm point, so crossing it leaves
      // the count exactly where it was.
      await page.evaluate(() =>
        renderFrame({ type: 'replay_complete', data: { replayedCount: 1 } }),
      );
      const boundary = await thinking();
      expect(
        boundary === 0,
        `the replay boundary itself raised an indicator (${boundary})`,
      );

      // The half the issue exists for. Past the boundary a user record means a
      // prompt was just accepted somewhere else, which is real work.
      await page.evaluate(() =>
        renderSessionUpdate({
          sessionUpdate: 'user_message_chunk',
          content: { text: 'a prompt from the laptop' },
        }),
      );
      const live = await thinking();
      expect(
        live === 1,
        `a live user record showed no indicator (${live}); this is the #73 gap`,
      );

      // And it is a turn like any other, so the boundary that ends a turn
      // stands it down rather than leaving it running.
      await page.evaluate(() => endTurn());
      const ended = await thinking();
      expect(
        ended === 0,
        `the indicator outlived the turn it came from (${ended})`,
      );

      return `replayed -> ${replayed}, boundary -> ${boundary}, live -> ${live}, turn over -> ${ended}`;
    },
  },
  {
    // The chat window is sized the way it was before #74 bounded it: the
    // transcript box carries its own max-height: 75vh cap and the document
    // scrolls, rather than the column being pinned to calc(100vh - 4rem) with
    // the box shrinking to whatever its siblings left. Bounding it that way
    // squeezed the transcript onto its 60px floor at a 720px window, which is
    // the "chat window is way too small" fault. The to-do strip takes its own
    // row in normal flow below the chat window: it is not pinned to the foot
    // of the viewport and it never overlaps the transcript, and it is reached
    // by scrolling to the end of the document rather than held on screen.
    // Asserted on pixels because the claim is about pixels.
    name: 'P31 the chat window keeps its 75vh transcript and the strip sits below it',
    frames: () => {
      const f = new Frames();
      const plan = (entries: Array<[string, string]>) =>
        f.upd({
          sessionUpdate: 'plan',
          entries: entries.map(([content, status]) => ({
            content,
            priority: 'medium',
            status,
          })),
        });
      f.user('do the thing');
      plan([
        ['read the code', 'pending'],
        ['change it', 'pending'],
        ['test it', 'pending'],
      ]);
      plan([
        ['read the code', 'completed'],
        ['change it', 'in_progress'],
        ['test it', 'pending'],
        ['ship it', 'pending'],
      ]);
      // Enough history to overflow a 75vh box at both heights the run below
      // measures at, so `scrolls` tests the cap rather than a short transcript.
      for (let k = 0; k < 120; k++) {
        f.asst(`turn ${k}: lorem ipsum dolor sit amet consectetur elit. `);
      }
      return f.done().list;
    },
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await waitForFrame(page, 44, 30_000);
      await settlePage(page);
      const read = () =>
        page.evaluate(() => {
          const tr = document.getElementById('transcript') as HTMLDivElement;
          const box = document.getElementById('plan') as HTMLDivElement;
          const tb = tr.getBoundingClientRect();
          const pb = box.getBoundingClientRect();
          const cap = Math.round(innerHeight * 0.75);
          return {
            inner: innerHeight,
            cap,
            transcript: [Math.round(tb.top), Math.round(tb.bottom)],
            transcriptHeight: tr.clientHeight,
            // The original sizing: the box is capped at 75vh and scrolls its
            // own history, so its height comes from the cap and not from
            // whatever its siblings happened to leave over.
            withinCap: tr.clientHeight <= cap + 1,
            scrolls: tr.scrollHeight > tr.clientHeight,
            // The reported fault was the box collapsing onto its 60px floor, so
            // the height alone is not enough to pass: it has to be the cap.
            aboveFloor: tr.clientHeight > 60,
            stripShown: box.offsetHeight > 0,
            strip: [Math.round(pb.top), Math.round(pb.bottom)],
            // The strip is in normal flow below the chat window, so at the top
            // of a full document it sits below the fold. What has to hold is
            // that it never covers transcript pixels and never rides at the
            // foot of the viewport the way the position: sticky pin did.
            belowTranscript: pb.top >= tb.bottom - 1,
            overlapsTranscript: pb.top < tb.bottom - 1,
            pinned: Math.abs(innerHeight - 8 - pb.bottom) <= 1,
            stripOnScreen:
              pb.height > 0 && pb.top < innerHeight && pb.bottom > 0,
          };
        });
      const lines: string[] = [];
      // 720 is the height P25 uses and the height the fault was reported at.
      // 1080 rides along so the scenario cannot pass on a rule that only binds
      // when the window is nearly empty.
      for (const height of [720, 1080]) {
        await page.setViewportSize({ width: 1280, height });
        // The reachability check at the foot of this loop leaves the window
        // scrolled, and the placement claims are about the strip's own row, so
        // every height starts from the top of the document.
        await page.evaluate(() => window.scrollTo(0, 0));
        // settlePage waits on the transcript, and a viewport change is a
        // relayout and not new frames, so it needs its own beat.
        await page.waitForTimeout(300);
        await settlePage(page);
        const g = await read();
        // First, because a strip that is not on screen at all would satisfy
        // every claim below by being nowhere.
        expect(
          g.stripShown,
          `no strip in the ${height}px window, so the placement claims below ` +
            'would pass vacuously',
        );
        expect(
          g.scrolls,
          `the transcript already shows all it holds at ${height}px, so this ` +
            'window does not exercise the cap',
        );
        expect(
          g.withinCap,
          `the transcript is ${g.transcriptHeight}px in a ${g.inner}px window ` +
            `at ${height}px, past its ${g.cap}px (75vh) cap`,
        );
        expect(
          g.aboveFloor,
          `the transcript is ${g.transcriptHeight}px at ${height}px, which is ` +
            'its min-height floor and not its cap: this is the window that read ' +
            'as too small',
        );
        expect(
          g.belowTranscript,
          `the strip does not sit below the chat window at ${height}px: ` +
            `strip ${JSON.stringify(g.strip)} transcript ` +
            JSON.stringify(g.transcript),
        );
        expect(
          !g.overlapsTranscript,
          `the strip covers the chat window at ${height}px: ` +
            `strip ${JSON.stringify(g.strip)} transcript ` +
            JSON.stringify(g.transcript),
        );
        expect(
          !g.pinned,
          `the strip is pinned to the foot of the ${height}px window, which is ` +
            `how it floated over transcript pixels: ` +
            JSON.stringify(g.strip),
        );
        // Reachability, the property that survives dropping the pin: the strip
        // holds the end of the document, so scrolling there finds it.
        await page.evaluate(() =>
          window.scrollTo(0, document.documentElement.scrollHeight),
        );
        await page.waitForTimeout(300);
        const atEnd = await read();
        expect(
          atEnd.stripOnScreen,
          `the strip is not on screen at the end of the ${height}px document: ` +
            JSON.stringify(atEnd.strip),
        );
        lines.push(
          `${height}px: transcript ${g.transcriptHeight}px (cap ${g.cap}), ` +
            `strip ${JSON.stringify(g.strip)} below it, ` +
            `${JSON.stringify(atEnd.strip)} at the end`,
        );
      }
      return `${lines.join('; ')}; the transcript keeps its 75vh box at both heights`;
    },
  },
];

// Appended here rather than written inline in the array above: that edit kept
// arriving incomplete, so the entry is added in pieces from a clean anchor.
PAGE_SCENARIOS.push({
  name: 'P32 assistant markdown on the real page',
  // The jsdom tests cannot see this file's stylesheet, so the CSS half of #93
  // is checked here. Claims stay scoped to the assistant bubble: a substring
  // read off #transcript is satisfied by the echoed prompt row.
  noConsoleErrors: true,
  frames: () => mdFrames(),
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await waitForFrame(page, 3, 30_000);
    await settlePage(page);
    const s = await page.evaluate(() => {
      const row = document.querySelector('#transcript .bubble.asst');
      const md = row ? row.querySelector('.md') : null;
      const pre = row ? row.querySelector('pre') : null;
      const good = row ? row.querySelector('a[href^="https"]') : null;
      const h1 = row ? row.querySelector('h1') : null;
      const strong = row ? row.querySelector('strong') : null;
      const code = row ? row.querySelector(':not(pre) > code') : null;
      return {
        row: !!row,
        h1: h1 ? h1.textContent || '' : '',
        strong: strong ? strong.textContent || '' : '',
        code: code ? code.textContent || '' : '',
        li: row ? row.querySelectorAll('ul li').length : 0,
        pre: pre ? pre.textContent || '' : '',
        mdWrap: md ? getComputedStyle(md).whiteSpace : null,
        preWrap: pre ? getComputedStyle(pre).whiteSpace : null,
        rowText: row ? row.textContent || '' : '',
        imgs: document.querySelectorAll('#transcript img').length,
        badLinks: document.querySelectorAll(
          '#transcript a[href^="javascript"]',
        ).length,
        anchors: row ? row.querySelectorAll('a').length : 0,
        goodHref: good ? good.getAttribute('href') : null,
        goodTarget: good ? good.getAttribute('target') : null,
        mounted: Array.from(
          document.querySelectorAll('#transcript .bubble'),
        ).length,
      };
    });
    expect(s.row, 'no assistant row on screen, so the checks below are vacuous');
    expect(s.h1 === 'Heading', 'heading rendered as ' + JSON.stringify(s.h1));
    expect(s.strong === 'bold', 'strong rendered as ' + JSON.stringify(s.strong));
    expect(s.code === 'code', 'inline code rendered as ' + JSON.stringify(s.code));
    expect(s.li === 2, s.li + ' list items, expected 2');
    expect(s.pre.includes('const a = 1;'), 'fence text ' + s.pre);
    // The CSS half: prose reflows while the code block keeps the source's
    // whitespace. Naming a display on .md would outrank this and leave the
    // bubble's pre-wrap in force.
    expect(
      s.mdWrap === 'normal',
      '.md white-space is ' + JSON.stringify(s.mdWrap) + ', expected normal',
    );
    expect(
      s.preWrap === 'pre-wrap' || s.preWrap === 'pre',
      'pre white-space is ' + JSON.stringify(s.preWrap) + ', expected pre-wrap',
    );
    // Safety on the shipped page, not only in the walker.
    expect(s.imgs === 0, s.imgs + ' img elements in the transcript');
    expect(s.badLinks === 0, s.badLinks + ' javascript: links in the transcript');
    expect(
      s.rowText.includes('<img src=x onerror=alert(1)>'),
      'the raw HTML is not shown as typed',
    );
    expect(
      s.anchors === 1,
      s.anchors + ' links in the assistant row, expected only the https one',
    );
    expect(
      s.goodHref === 'https://example.com/a',
      'link href ' + JSON.stringify(s.goodHref),
    );
    expect(
      s.goodTarget === '_blank',
      'link target ' +
        JSON.stringify(s.goodTarget) +
        ': a link must not navigate the viewer away from its session',
    );
    // The "assistant only" half is not checked here: the virtualizer recycles
    // rows outside the viewport, so on this page a user row is not something
    // the DOM can be asked about. It is covered in transcriptMarkdown.test.ts,
    // which attaches with virtualCore null and so holds every row.
    return (
      'h1/strong/code/2 items/fence rendered; prose ' +
      s.mdWrap +
      ' with pre ' +
      s.preWrap +
      '; 0 img, 0 javascript: link, 1 https link at target ' +
      s.goodTarget +
      '; ' +
      s.mounted +
      ' bubbles mounted'
    );
  },
});

// Appended for the same reason as P32: the array edit kept arriving incomplete.
// #97. The mic is the browser's Web Speech API, not the product's voice stack,
// and the gateway has no transcribe route to offer in its place. Both states
// are pinned: naming the engine when there is one, and naming the absence when
// there is not. Headless Chromium has no SpeechRecognition at all, so the
// absent state is the page's own and needs no help; the present state is
// reached by installing an engine before the page script runs. Each state
// needs its own boot, because an init script cannot be swapped after load.
PAGE_SCENARIOS.push({
  name: 'P33 the mic names the engine behind it',
  before: async (page) => {
    await page.addInitScript({
      content: 'window.SpeechRecognition = function () {};',
    });
  },
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await page.waitForSelector('#composer', { state: 'visible' });
    const s = await page.evaluate(() => {
      const tag = document.getElementById('dictate-engine');
      const mic = document.getElementById('dictate') as HTMLButtonElement;
      return {
        tag: tag ? tag.textContent : null,
        shown: tag ? tag.getClientRects().length > 0 : false,
        beside: tag
          ? tag.previousElementSibling === mic
          : false,
        disabled: mic ? mic.disabled : null,
      };
    });
    expect(
      s.tag === 'browser',
      `the tag reads ${JSON.stringify(s.tag)}, expected "browser"`,
    );
    expect(s.shown, 'the engine tag is not on screen, so it labels nothing');
    expect(s.beside, 'the engine tag is not beside the mic it labels');
    expect(!s.disabled, 'the mic is disabled with an engine installed');
    return 'engine installed: tag "browser" on screen beside a live mic';
  },
});

PAGE_SCENARIOS.push({
  name: 'P34 the mic names the missing engine',
  // Headless Chromium DOES expose SpeechRecognition, so the absent state has
  // to be made rather than assumed: the first run of this scenario failed its
  // own precondition check and said so, which is the fact worth recording.
  // Deleting both names is what a Firefox or Safari user arrives with.
  before: async (page) => {
    await page.addInitScript({
      content:
        "Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });" +
        "Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });",
    });
  },
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await page.waitForSelector('#composer', { state: 'visible' });
    const s = await page.evaluate(() => {
      const tag = document.getElementById('dictate-engine');
      const mic = document.getElementById('dictate') as HTMLButtonElement;
      return {
        tag: tag ? tag.textContent : null,
        shown: tag ? tag.getClientRects().length > 0 : false,
        disabled: mic ? mic.disabled : null,
        sr: !!(
          (window as { SpeechRecognition?: unknown }).SpeechRecognition ||
          (window as { webkitSpeechRecognition?: unknown })
            .webkitSpeechRecognition
        ),
      };
    });
    expect(!s.sr, 'an engine was present, so this scenario proved nothing');
    expect(
      s.tag === 'no browser engine',
      `the tag reads ${JSON.stringify(s.tag)}, expected "no browser engine"`,
    );
    expect(s.shown, 'the engine tag is not on screen, so it labels nothing');
    expect(s.disabled, 'the mic is live with no engine behind it');
    return 'no engine: tag "no browser engine" on screen, mic disabled';
  },
});

// #98: seven gateway surfaces shipped their backend before anything drew them.
// They were placed under Settings rather than the main rail, so these two
// scenarios assert placement and the honest state when a route is absent.
// The absent lines are NOT stubbed: this harness gateway mounts several of
// these routes conditionally, and a probe run showed which ones answer 404
// for real (usage, peers, agents, policy-explain) and which answer 200 with
// an empty list (cors, bridges, bans) or 403 (share whoami).
const SURFACES = [
  'usage-view',
  'peers-view',
  'policy-explain-view',
  'cors-view',
  'whoami-view',
  'bridges-view',
  'agents-view',
] as const;

const PLACEHOLDERS = ['(not loaded)', '(not browsed)', '(not asked)', '(not listed)'];

// Waits for an output div to leave its placeholder and settle, then returns it.
async function drawn(page: Page, id: string): Promise<string> {
  await page.waitForFunction(
    (p) => {
      const el = document.getElementById(p.id);
      const t = el ? (el.textContent || '').trim() : '';
      return (
        t.length > 0 && !t.startsWith('loading') && !t.startsWith('asking') && !p.ph.includes(t)
      );
    },
    { id, ph: PLACEHOLDERS },
    { timeout: 20_000 },
  );
  return page.evaluate(
    (id) => (document.getElementById(id)?.textContent || '').trim(),
    id,
  );
}

// Opens a panel and clicks one of its buttons, since a closed <details> hides
// its controls from Playwright's visibility check.
async function press(page: Page, panel: string, button: string): Promise<void> {
  await page.evaluate(
    ({ panel, button }) => {
      const det = document.getElementById(panel) as HTMLDetailsElement | null;
      if (det) det.open = true;
      (document.getElementById(button) as HTMLButtonElement | null)?.click();
    },
    { panel, button },
  );
}

PAGE_SCENARIOS.push({
  name: 'P35 the seven unseen surfaces have screens under Settings',
  waitView: false,
  run: async ({ page }) => {
    await page.click('.tab[data-tab="settings"]');
    const s = await page.evaluate((ids) => {
      const settings = document.getElementById('pane-settings');
      const chat = document.getElementById('pane-chat');
      const rows = ids.map((id) => {
        const det = document.getElementById(id);
        const btn = det ? det.querySelector('.help-btn') : null;
        const help = btn
          ? document.getElementById(btn.getAttribute('aria-controls') || '')
          : null;
        return {
          id,
          exists: !!det,
          inSettings: !!det && !!settings?.contains(det),
          inChat: !!det && !!chat?.contains(det),
          helpHidden: !!help && help.hidden,
          helpLabelled: !!btn && !!btn.getAttribute('aria-label'),
        };
      });
      return { rows };
    }, [...SURFACES]);

    for (const r of s.rows) {
      expect(r.exists, `#${r.id} is not in the page at all`);
      expect(r.inSettings, `#${r.id} is not inside #pane-settings`);
      expect(!r.inChat, `#${r.id} sits in the chat pane, i.e. on the main screen`);
      expect(r.helpLabelled, `#${r.id} has no labelled ? control`);
      expect(r.helpHidden, `#${r.id} shows its help before it is asked for`);
      // The guard above is only worth having if it can actually trip, so move
      // one panel into the chat pane and re-run the same test on it.
    }

    // The inChat assertion above is only worth having if it can trip, so move
    // one panel into the chat pane, re-run the SAME predicate on it, and put
    // it back. Without this, an `inChat` that always returned false would pass.
    const tripped = await page.evaluate(() => {
      const det = document.getElementById('usage-view');
      const chat = document.getElementById('pane-chat');
      const settings = document.getElementById('pane-settings');
      if (!det || !chat || !settings) return 'could not move the panel';
      chat.appendChild(det);
      const now = {
        inChat: chat.contains(document.getElementById('usage-view')),
        inSettings: settings.contains(document.getElementById('usage-view')),
      };
      settings.appendChild(det);
      const back = settings.contains(document.getElementById('usage-view'));
      return `${now.inChat}/${now.inSettings}/${back}`;
    });
    // inChat must flip true, inSettings false, and the restore must take.
    expect(
      tripped === 'true/false/true',
      `placement guard is vacuous, moving a panel into the chat pane read ${tripped}`,
    );

    // The "?" is one delegated listener on document keyed on aria-controls,
    // so prove it reaches all seven new panels rather than only the old ones.
    const toggled: string[] = [];
    for (const id of SURFACES) {
      const shown = await page.evaluate((panelId) => {
        const det = document.getElementById(panelId) as HTMLDetailsElement | null;
        const btn = det?.querySelector('.help-btn') as HTMLButtonElement | null;
        if (!btn) return 'no ? button';
        btn.click();
        const help = document.getElementById(btn.getAttribute('aria-controls') || '');
        return help
          ? `${!help.hidden}/${btn.getAttribute('aria-expanded')}`
          : 'no help element';
      }, id);
      expect(
        shown === 'true/true',
        `#${id} ? did not reveal its help where it is read (got ${shown})`,
      );
      toggled.push(id);
    }
    return `${toggled.length} screens under Settings, none on the main screen, each ? reveals its help in place`;
  },
});

PAGE_SCENARIOS.push({
  name: 'P36 an unseen surface says why it has nothing rather than showing a blank',
  waitView: false,
  run: async ({ page }) => {
    await page.click('.tab[data-tab="settings"]');

    // Routes the harness gateway genuinely does not mount: the panel must name
    // the absence, not render an empty table that reads as "no data".
    const unmounted: Array<[string, string, string, string]> = [
      ['usage-view', 'load-usage', 'usage-out', 'not enabled'],
      ['peers-view', 'browse-peers', 'peers-out', 'no such route'],
      ['agents-view', 'list-agents', 'agents-out', 'no such route'],
    ];
    for (const [panel, button, out, want] of unmounted) {
      await press(page, panel, button);
      const text = await drawn(page, out);
      expect(
        text.includes(want),
        `${panel} drew ${JSON.stringify(text.slice(0, 80))}, expected it to say "${want}"`,
      );
    }

    // A blank tool name must be caught here rather than sent and round-tripped
    // into a 400, so prove the client guard fires without a request.
    await press(page, 'policy-explain-view', 'run-explain');
    const blank = await drawn(page, 'explain-out');
    expect(
      blank.includes('tool name is required'),
      `an empty tool name was not caught client-side: ${JSON.stringify(blank)}`,
    );

    // With a tool named, the route itself is absent in this harness, which is
    // the same fact as a 503: there is no policy to ask.
    await page.fill('#explain-tool', 'read_file');
    await press(page, 'policy-explain-view', 'run-explain');
    const noPolicy = await drawn(page, 'explain-out');
    expect(
      noPolicy.includes('no policy loaded'),
      `an unmounted policy route was reported as ${JSON.stringify(noPolicy)}`,
    );

    // An owner token is refused by /rc/share/whoami because `owner` implies
    // write/approve/session:read but NOT share. The panel must state that
    // fact rather than dress it up as a failure.
    await press(page, 'whoami-view', 'whoami-btn');
    const whoami = await drawn(page, 'whoami-out');
    expect(
      whoami.includes('not a share token'),
      `the owner token's 403 was drawn as ${JSON.stringify(whoami)}`,
    );

    // Routes that ARE mounted answer 200 with an empty list, which must read
    // as "nothing here" and not as an error.
    await press(page, 'cors-view', 'list-cors');
    const cors = await drawn(page, 'cors-out');
    expect(
      cors.includes('no admitted origins'),
      `an empty allowlist was drawn as ${JSON.stringify(cors)}`,
    );
    await press(page, 'bridges-view', 'list-bridges');
    const bridges = await drawn(page, 'bridges-out');
    expect(
      bridges.includes('no bridges registered'),
      `an empty bridge registry was drawn as ${JSON.stringify(bridges)}`,
    );
    await press(page, 'bridges-view', 'list-bans');
    const bans = await drawn(page, 'bridges-out');
    expect(
      bans.includes('no banned chat users'),
      `an empty ban list was drawn as ${JSON.stringify(bans)}`,
    );
    return 'absent routes say so, an owner token is told it is not a share token, empty lists read as empty';
  },
});

PAGE_SCENARIOS.push({
  // #89. The rail is a scan of the on-disk chats dir, so a conversation whose
  // transcript has not been written yet gets no row at all: the device that did
  // not start it cannot see it, cannot resume it, and cannot tell it apart from
  // one that already ended. Only the daemon's in-memory snapshot knows it is
  // there, so the load-bearing property is that the list is merged with that
  // snapshot rather than merely annotated where rows already exist. Asserted on
  // the real page because the row itself is the claim, and a badge on existing
  // rows would pass a test that never asked for the missing one.
  name: 'P37 a conversation with no transcript is listed, and an unreadable snapshot changes nothing',
  waitView: false,
  run: async ({ page }) => {
    const CWD = '/home/evan/scratch';
    const DISK = '11111111-2222-3333-4444-555555555555';
    const LIVEONLY = '77777777-8888-9999-0000-111111111111';
    const now = new Date().toISOString();

    // Both reads are intercepted rather than served, because the harness wires a
    // bare DaemonClient and that route answers 502 here for every scenario.
    await page.route(/\/rc\/sessions\?/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [{ sessionId: DISK, title: 'on disk', updatedAt: now }],
          truncated: false,
        }),
      }),
    );
    const liveBody = JSON.stringify({
      v: 1,
      catalogVersion: { generation: 'g-1', revision: 4 },
      sessions: [
        {
          sessionId: DISK,
          clientCount: 2,
          hasActivePrompt: true,
          isWaitingForPermission: false,
          isWaitingForUserQuestion: false,
        },
        {
          sessionId: LIVEONLY,
          clientCount: 1,
          hasActivePrompt: false,
          isWaitingForPermission: false,
          isWaitingForUserQuestion: false,
        },
      ],
    });
    await page.route(/\/rc\/sessions\/live-state\?/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: liveBody,
      }),
    );

    const readRows = () =>
      page.evaluate(() => {
        const box = document.getElementById('past-list') as HTMLDivElement;
        return Array.from(box.querySelectorAll('.token-row')).map((el) => {
          const row = el as HTMLElement;
          const line = row.firstElementChild as HTMLElement;
          const kids = Array.from(line.children) as HTMLElement[];
          return {
            label: kids[0]?.textContent ?? '',
            marks: kids.slice(1).map((k) => k.textContent ?? ''),
            buttons: Array.from(row.querySelectorAll('button')).map(
              (b) => b.textContent ?? '',
            ),
          };
        });
      });

    // curDirPath is what the page sets when it browses into a folder, and the
    // render is skipped unless it matches the cwd being refreshed. Set here so
    // the call below goes all the way through rather than returning early.
    await page.evaluate(([cwd]) => {
      curDirPath = cwd;
      return refreshPastConversations(cwd);
    }, [CWD, 0]);
    const rows = await readRows();

    expect(
      rows.length === 2,
      `the rail listed ${rows.length} rows, wanted the transcript row plus the transcript-less one (${JSON.stringify(rows)})`,
    );
    // The live-only row is the whole point of #89, so it has to be the row that
    // is NOT on disk. Its label is the session-id fallback because it has no
    // title, and no separator, because it has no mtime either.
    const only = rows.find((r) => r.label.startsWith('session 77777777'));
    expect(
      !!only,
      `the conversation with no transcript is not in the rail at all (${JSON.stringify(rows.map((r) => r.label))})`,
    );
    expect(
      !only!.label.includes('\u00b7'),
      `the transcript-less row shows a separator with nothing after it (${JSON.stringify(only!.label)})`,
    );
    expect(
      only!.marks.includes('open'),
      `the transcript-less row does not say it is open (${JSON.stringify(only)})`,
    );
    // No delete on that row: its confirm text promises a transcript is removed
    // for good, and there is no transcript to remove.
    expect(
      only!.buttons.length === 0,
      `the transcript-less row offers a delete that cannot do what its confirm says (${JSON.stringify(only!.buttons)})`,
    );

    const disk = rows.find((r) => r.label.startsWith('on disk'));
    expect(!!disk, `the row that was already listed went missing (${JSON.stringify(rows)})`);
    expect(
      disk!.label.includes('\u00b7'),
      `the test assumed the disk row shows a time, so the marker assertions below mean anything (${JSON.stringify(disk!.label)})`,
    );
    expect(
      disk!.marks.includes('open'),
      `the snapshot names this conversation and the row does not say so (${JSON.stringify(disk)})`,
    );
    expect(
      disk!.buttons.includes('delete'),
      `a conversation that has a transcript lost its delete (${JSON.stringify(disk!.buttons)})`,
    );

    // The honesty property. A snapshot the page cannot read is NOT a statement
    // that nothing is open: the route can be unsupported on an older daemon, or
    // refused by the per-workspace trust check. The list must come back exactly
    // as the disk scan alone, because an unreadable snapshot that emptied the
    // rail would be worse than never having tried.
    await page.route(/\/rc\/sessions\/live-state\?/, (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Daemon unavailable', code: 'daemon_unavailable' }),
      }),
    );
    await page.evaluate(([cwd]) => refreshPastConversations(cwd), [CWD, 0]);
    const blind = await readRows();
    expect(
      blind.length === 1 && blind[0]!.label.startsWith('on disk'),
      `an unreadable snapshot changed the list rather than leaving it as the disk scan (${JSON.stringify(blind.map((r) => r.label))})`,
    );
    expect(
      !blind[0]!.marks.includes('open'),
      `with no snapshot the row still claims to be open, which is a claim about state it cannot know (${JSON.stringify(blind[0])})`,
    );
    expect(
      blind[0]!.buttons.includes('delete'),
      `with no snapshot the surviving row lost its delete (${JSON.stringify(blind[0]!.buttons)})`,
    );

    return `2 rows with the transcript-less one listed as open and undeletable; an unreadable snapshot leaves the disk row alone and unmarked`;
  },
});

// Appended for the same reason as P32: the array edit kept arriving incomplete.
//
// issue #113. A reload re-attaches to the conversation it was showing, and the
// first thing that connect can do is answer 412: the cursor it sent has fallen
// out of the WAL. The gateway's body already names the oldest id it still holds
// (sessionEvents.ts:297-303), and the client used to throw that value away and
// retry with no cursor at all, which the comment above startWatch says means the
// daemon replays nothing. So the reload blanked a conversation that is intact on
// disk, which is the reported symptom.
//
// The stub replays every frame whatever the cursor says (stubDaemon.ts:742-788
// reads the header and ignores it), so "rows came back" would pass with the bug
// still in place. What carries the assertion here is the header the retry
// actually puts on the wire, recorded from the request rather than from the
// page's own idea of what it asked for.
PAGE_SCENARIOS.push({
  name: 'P38 a reload whose first connect 412s re-subscribes at the WAL horizon',
  waitView: false,
  frames: () => new Frames().asst('the reply that was still on disk').done().list,
  run: async ({ page, viewer }) => {
    const sent: Array<string | null> = [];
    await page.route(/\/session\/[^/]+\/events$/, async (route) => {
      sent.push(route.request().headers()['last-event-id'] ?? null);
      if (sent.length === 1) {
        await route.fulfill({
          status: 412,
          contentType: 'application/json',
          body: JSON.stringify({
            type: 'replay_truncated',
            data: { earliestAvailableId: 12, reason: 'older_than_wal_horizon' },
          }),
        });
        return;
      }
      await route.continue();
    });

    // Cursor 0 is what restoreWatchedSession sends on a reload (index.html:9253).
    await page.evaluate((id) => {
      lastSeenEventId = null;
      void startWatch(id, 0);
    }, viewer.sessionId);

    // The first retry is scheduled 1s out, so this waits for the wire rather
    // than assuming the self-heal ran.
    const deadline = Date.now() + 10_000;
    while (sent.length < 2 && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    expect(
      sent.length >= 2,
      `the 412 never produced a second connect (attempts: ${JSON.stringify(sent)}) — ` +
        'self-heal state at the deadline: ' +
        (await page.evaluate(
          () =>
            `hidden=${document.hidden} watch.disabled=${$('watch').disabled} ` +
            `streamAlive=${watchStreamAlive} watchedId=${watchedSessionId != null} ` +
            `retryAttempt=${watchRetryAttempt} timerPending=${watchRetryTimer != null} ` +
            `lastSeen=${lastSeenEventId}`,
        )),
    );
    // replayFrom replays ids STRICTLY GREATER than the cursor and honours only
    // the predecessor boundary, so 11 is what recovers frame 12. Asking for 12
    // would drop it.
    expect(
      sent[1] === '11',
      `the retry asked for Last-Event-ID ${JSON.stringify(sent[1])}, wanted "11" ` +
        `(the 412 named 12 as the oldest held; attempts: ${JSON.stringify(sent)})`,
    );

    await waitForFrame(page, 2, 8_000);
    // The cursor is written from the SSE id line (index.html:7930-7935) before
    // the data line is rendered, so waitForFrame can report the frame arrived
    // while the model is still empty. Wait on the model rather than assume the
    // render has landed, or this asserts a race instead of the rebuild.
    const itemsDeadline = Date.now() + 8_000;
    let items = 0;
    for (;;) {
      items = await page.evaluate(() => transcriptModel.items.length);
      if (items > 0 || Date.now() > itemsDeadline) break;
      await page.waitForTimeout(100);
    }
    expect(
      items > 0,
      `the reload rebuilt nothing: ${items} items after recovering the cursor`,
    );
    return `412 at cursor 0 retried at Last-Event-ID 11 and rebuilt ${items} items`;
  },
});

PAGE_SCENARIOS.push({
  name: 'P39 a conversation can be filed away and put back, and the filed half is not pressable',
  waitView: false,
  run: async ({ page }) => {
    const CWD = '/home/evan/scratch';
    const DISK = '11111111-2222-3333-4444-555555555555';
    const GONE = '88888888-9999-0000-1111-222222222222';
    const LIVEONLY = '77777777-8888-9999-0000-111111111111';
    const now = new Date().toISOString();
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];

    // One route answers both listings, because they differ only by the query.
    // Serving them from one place means a page that asked for the wrong one
    // cannot be rescued into passing by a lucky pattern match.
    //
    // The transcript-less id is named ONLY by the snapshot below, never by this
    // listing. If it appeared here too it would have a transcript on disk, so
    // the merge would be right to offer it the at-rest buttons, and the
    // assertion that the row carries none would be guarding nothing.
    await page.route(/\/rc\/sessions\?cwd=/, (route) => {
      const wantArchived = route.request().url().includes('archiveState=archived');
      const sessions = wantArchived
        ? [{ sessionId: GONE, title: 'filed away', updatedAt: now, archived: true }]
        : [{ sessionId: DISK, title: 'on disk', updatedAt: now }];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions, truncated: false }),
      });
    });
    // The snapshot names the transcript-less row so it is listed at all, which
    // is the #89 behaviour the rail row below depends on.
    await page.route(/\/rc\/sessions\/live-state\?/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          v: 1,
          catalogVersion: { generation: 'g-1', revision: 1 },
          sessions: [
            {
              sessionId: LIVEONLY,
              clientCount: 1,
              hasActivePrompt: false,
              isWaitingForPermission: false,
              isWaitingForUserQuestion: false,
            },
          ],
        }),
      }),
    );
    const verb = (re: RegExp, action: string, key: string, id: string) =>
      page.route(re, (route) => {
        const raw = route.request().postData() ?? '{}';
        posts.push({ path: action, body: JSON.parse(raw) as Record<string, unknown> });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ action, requested: 1, [key]: [id] }),
        });
      });
    await verb(/\/rc\/sessions\/archive$/, 'archive', 'archived', DISK);
    await verb(/\/rc\/sessions\/unarchive$/, 'unarchive', 'unarchived', GONE);

    const status = () =>
      page.evaluate(() => (document.getElementById('status') as HTMLElement).textContent ?? '');
    const railButtons = () =>
      page.evaluate(() => {
        const box = document.getElementById('past-list') as HTMLElement;
        return Array.from(box.querySelectorAll('.token-row')).map((row) => ({
          label: ((row.firstElementChild?.children[0] as HTMLElement) ?? row).textContent ?? '',
          buttons: Array.from(row.querySelectorAll('button')).map((b) => b.textContent ?? ''),
        }));
      });

    await page.evaluate(([cwd]) => {
      curDirPath = cwd;
      return refreshPastConversations(cwd);
    }, [CWD]);
    const rows = await railButtons();
    const diskRow = rows.find((r) => r.label.startsWith('on disk'));
    expect(!!diskRow, `the disk row is missing from the rail (${JSON.stringify(rows)})`);
    expect(
      diskRow!.buttons.includes('archive'),
      `a conversation with a transcript offers no way to file it away (${JSON.stringify(diskRow!.buttons)})`,
    );
    const liveRow = rows.find((r) => r.label.startsWith('session 77777777'));
    expect(!!liveRow, `the transcript-less row went missing (${JSON.stringify(rows)})`);
    expect(
      liveRow!.buttons.length === 0,
      `the transcript-less row was offered an at-rest action it cannot perform (${JSON.stringify(liveRow!.buttons)})`,
    );

    // The placement ruling: the filed half is not something to reach for while
    // working, so it lives under Settings and not on the main screen.
    const placed = await page.evaluate(() => {
      const det = document.getElementById('archived-view');
      return {
        exists: !!det,
        inSettings: !!document.getElementById('pane-settings')?.contains(det ?? null),
        inChat: !!document.getElementById('pane-chat')?.contains(det ?? null),
      };
    });
    expect(placed.exists, 'there is no archived section in the page at all');
    expect(placed.inSettings, 'the archived section is not under Settings');
    expect(!placed.inChat, 'the archived section sits on the main screen');

    // The ? is one delegated listener on document keyed on aria-controls (the
    // rule P35 proves for the seven surfaces). A panel added after P35 was
    // written is only covered by that rule if it follows it, so check this one
    // rather than inherit the older scenario's conclusion.
    const help = await page.evaluate(() => {
      const det = document.getElementById('archived-view') as HTMLDetailsElement | null;
      const btn = det?.querySelector('.help-btn') as HTMLButtonElement | null;
      if (!btn) return 'no ? button';
      const before = (document.getElementById('help-archived-view') as HTMLElement)?.hidden;
      btn.click();
      const el = document.getElementById('help-archived-view') as HTMLElement | null;
      return `${before === true}/${el ? !el.hidden : 'no help element'}/${btn.getAttribute('aria-expanded')}`;
    });
    expect(
      help === 'true/true/true',
      `the archived section's ? did not behave like the other panels' (got ${help})`,
    );

    // Press archive. The body is the load-bearing part: archive is reversible,
    // so it must NOT carry the confirm that only delete requires, and it must
    // name the cwd or it would act on whichever workspace the gateway defaults
    // to rather than the folder the row came from.
    await page.evaluate(() => {
      const box = document.getElementById('past-list') as HTMLElement;
      for (const row of Array.from(box.querySelectorAll('.token-row'))) {
        const btn = Array.from(row.querySelectorAll('button')).find(
          (b) => b.textContent === 'archive',
        );
        if (btn) {
          (btn as HTMLButtonElement).click();
          return;
        }
      }
    });
    await page.waitForFunction(
      () => !((document.getElementById('status') as HTMLElement).textContent ?? '').includes('archiving'),
      null,
      { timeout: 8000 },
    );
    const arc = posts.find((x) => x.path === 'archive');
    expect(!!arc, `pressing archive sent nothing (${JSON.stringify(posts)})`);
    expect(
      JSON.stringify(arc!.body.sessionIds) === JSON.stringify([DISK]),
      `archive did not name the conversation on the row that was pressed (${JSON.stringify(arc!.body)})`,
    );
    expect(
      arc!.body.cwd === CWD,
      `archive did not carry the cwd the row came from, so it could act on another workspace (${JSON.stringify(arc!.body)})`,
    );
    expect(
      !('confirm' in arc!.body),
      `archive sent a confirm, which only the irreversible verb requires (${JSON.stringify(arc!.body)})`,
    );
    expect(
      (await status()) === 'archived',
      `pressing archive did not report what it did (${JSON.stringify(await status())})`,
    );

    // The filed half, listed and put back.
    await page.evaluate(() => refreshArchivedConversations());
    const filed = await page.evaluate(() => {
      const box = document.getElementById('archived-list') as HTMLElement;
      return Array.from(box.querySelectorAll('.token-row')).map((row) => ({
        label: ((row.children[0] as HTMLElement) ?? row).textContent ?? '',
        buttons: Array.from(row.querySelectorAll('button')).map((b) => b.textContent ?? ''),
        pressable: (row as (HTMLElement & { onclick: unknown })).onclick !== null,
      }));
    });
    expect(
      filed.length === 1 && filed[0]!.label.startsWith('filed away'),
      `the archived listing did not show the filed conversation (${JSON.stringify(filed)})`,
    );
    expect(
      filed[0]!.buttons.includes('restore'),
      `an archived conversation offers no way back (${JSON.stringify(filed[0]!)})`,
    );
    // The honesty property. The rail's rows are pressable because they open a
    // conversation; these must not be, because the daemon refuses to read an
    // archived transcript. A row that looked pressable would promise a read
    // that cannot happen.
    expect(
      !filed[0]!.pressable,
      `an archived row is pressable, promising a read the daemon refuses (${JSON.stringify(filed[0]!)})`,
    );

    await page.evaluate(() => {
      const box = document.getElementById('archived-list') as HTMLElement;
      const btn = box.querySelector('button');
      if (btn) (btn as HTMLButtonElement).click();
    });
    await page.waitForFunction(
      () => !((document.getElementById('status') as HTMLElement).textContent ?? '').includes('restoring'),
      null,
      { timeout: 8000 },
    );
    const back = posts.find((x) => x.path === 'unarchive');
    expect(!!back, `pressing restore sent nothing (${JSON.stringify(posts)})`);
    expect(
      JSON.stringify(back!.body.sessionIds) === JSON.stringify([GONE]),
      `restore did not name the archived conversation on the row pressed (${JSON.stringify(back!.body)})`,
    );
    expect(
      (await status()) === 'restored',
      `pressing restore did not report what it did (${JSON.stringify(await status())})`,
    );

    // The one refusal the daemon makes here is about a Live call, and the fix
    // is a specific act rather than a retry, so a bare status number would send
    // the operator off looking in the wrong place.
    await page.route(/\/rc\/sessions\/archive$/, (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'An active Live session cannot be archived', code: 'live_session_active' }),
      }),
    );
    await page.evaluate(() => {
      const box = document.getElementById('past-list') as HTMLElement;
      for (const row of Array.from(box.querySelectorAll('.token-row'))) {
        const btn = Array.from(row.querySelectorAll('button')).find(
          (b) => b.textContent === 'archive',
        );
        if (btn) {
          (btn as HTMLButtonElement).click();
          return;
        }
      }
    });
    await page.waitForFunction(
      () => !((document.getElementById('status') as HTMLElement).textContent ?? '').includes('archiving'),
      null,
      { timeout: 8000 },
    );
    const said = await status();
    expect(
      said.includes('live call'),
      `a refused archive read "${said}" rather than naming the live call that blocks it`,
    );

    return `rail offers archive only where a transcript exists; the filed half sits under Settings, lists as restore-only and unpressable; archive sends no confirm and carries the cwd; a Live-call refusal is named`;
  },
});

PAGE_SCENARIOS.push({
  name: 'P40 a session can list what it has running, and an empty list reads as empty',
  waitView: false,
  run: async ({ page }) => {
    const SID = '11111111-2222-3333-4444-555555555555';
    // Mutable so the same route can answer twice: once with runs, once with
    // none. The empty case is the half that matters, because a reader who sees
    // an error there cannot tell "nothing running" from "the gateway is broke",
    // which is the exact confusion #110 is filed against.
    let tasks: Array<Record<string, unknown>> = [
      {
        kind: 'agent',
        id: 'a-1',
        label: 'reading rc-gateway routes',
        description: 'd',
        status: 'running',
        startTime: 0,
        runtimeMs: 4000,
        subagentType: 'Explore',
        isBackgrounded: false,
        stats: { totalTokens: 1200, toolUses: 3, durationMs: 4000 },
        // Paths that exist on the record and must NOT reach the screen.
        outputFile: '/home/evan/.qwen/secret-output.log',
      },
      {
        kind: 'shell',
        id: 's-1',
        label: 'pnpm test',
        description: 'd',
        status: 'completed',
        startTime: 0,
        runtimeMs: 2000,
        command: 'pnpm test',
        cwd: '/home/evan/secret-workdir',
        exitCode: 0,
        outputFile: '/home/evan/.qwen/secret-shell.log',
      },
      {
        kind: 'monitor',
        id: 'm-1',
        label: 'watch build',
        description: 'd',
        status: 'running',
        startTime: 0,
        runtimeMs: 1000,
        command: 'tail -f build.log',
        eventCount: 7,
        lastEventTime: 1,
      },
    ];
    await page.route(/\/session\/[0-9a-f-]+\/tasks/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ v: 1, sessionId: SID, now: Date.now(), tasks }),
      }),
    );

    const body = () =>
      page.evaluate(
        () =>
          (document.getElementById('runs-body') as HTMLElement).textContent ??
          '',
      );
    const press = async () => {
      await page.evaluate(() =>
        (document.getElementById('runs-list') as HTMLButtonElement).click(),
      );
      await page.waitForFunction(
        () =>
          !(
            (document.getElementById('runs-body') as HTMLElement).textContent ??
            ''
          ).includes('loading'),
        null,
        { timeout: 8000 },
      );
      return body();
    };

    // The placement ruling: a run log is not something to reach for mid-work,
    // so it lives in Operations and not on the main screen.
    const placed = await page.evaluate(() => {
      const det = document.getElementById('runs');
      return {
        exists: !!det,
        inOps: !!document.getElementById('pane-ops')?.contains(det ?? null),
        inChat: !!document.getElementById('pane-chat')?.contains(det ?? null),
      };
    });
    expect(placed.exists, 'there is no runs section in the page at all');
    expect(placed.inOps, 'the runs section is not under Operations');
    expect(!placed.inChat, 'the runs section sits on the main screen');

    // A panel added after P35 is only covered by the one-delegated-listener
    // rule if it follows it, so check this one rather than inherit it.
    const help = await page.evaluate(() => {
      const det = document.getElementById('runs') as HTMLDetailsElement | null;
      const btn = det?.querySelector('.help-btn') as HTMLButtonElement | null;
      if (!btn) return 'no ? button';
      const before = (document.getElementById('help-runs') as HTMLElement)
        ?.hidden;
      btn.click();
      const el = document.getElementById('help-runs') as HTMLElement | null;
      return `${before === true}/${el ? !el.hidden : 'no help element'}/${btn.getAttribute('aria-expanded')}`;
    });
    expect(
      help === 'true/true/true',
      `the runs section's ? did not behave like the other panels' (got ${help})`,
    );

    await page.evaluate((id) => {
      (document.getElementById('runs-id') as HTMLInputElement).value = id;
    }, SID);

    const listed = await press();
    expect(
      listed.includes('running') &&
        listed.includes('reading rc-gateway routes'),
      `the agent run is not drawn (${JSON.stringify(listed)})`,
    );
    expect(
      listed.includes('Explore'),
      `the agent kind is not shown (${JSON.stringify(listed)})`,
    );
    expect(
      listed.includes('pnpm test'),
      `the shell command is not shown (${JSON.stringify(listed)})`,
    );
    expect(
      listed.includes('exit 0'),
      `a finished shell lost its exit code (${JSON.stringify(listed)})`,
    );
    expect(
      listed.includes('tail -f build.log') && listed.includes('7 events'),
      `the monitor run is not drawn (${JSON.stringify(listed)})`,
    );
    // The load-bearing privacy half: these paths are on the daemon's records and
    // are deliberately not drawn, so a row that grows one has widened what this
    // read discloses without anyone deciding to.
    expect(
      !listed.includes('secret-output') && !listed.includes('secret-shell'),
      `the run list drew task output paths (${JSON.stringify(listed)})`,
    );
    expect(
      !listed.includes('secret-workdir'),
      `the run list drew a shell task's cwd (${JSON.stringify(listed)})`,
    );

    // The empty half: nothing running is a normal state and must not read as a
    // failure.
    tasks = [];
    const none = await press();
    expect(
      none.includes('no runs'),
      `an idle session did not read as empty (${JSON.stringify(none)})`,
    );
    expect(
      !/fail|error|500|502/i.test(none),
      `an idle session read as a failure (${JSON.stringify(none)})`,
    );

    return `runs live under Operations with the shared ? behaviour; agent/shell/monitor rows carry their own fields and no filesystem path; an idle session says "(no runs)" instead of failing`;
  },
});

async function runPageScenario(
  s: Exclude<PageScenario, { standalone: () => Promise<string> }>,
): Promise<string> {
  const viewer = await bootViewer({
    frames: s.frames ? s.frames() : READY,
    holdOpenMs: 600_000,
    promptStatus: s.stub?.promptStatus,
    promptDelayMs: s.stub?.promptDelayMs,
  });
  const { page, url } = viewer;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location().url;
    // Best-effort endpoints the page tolerates (permission overlays, the
    // clients manifest, lineage) answer 404 in the harness, and the browser
    // logs each as an error. Only a failed transcript asset counts.
    if (
      m.text().startsWith('Failed to load resource') &&
      !TRANSCRIPT_ASSET.test(where)
    ) {
      return;
    }
    consoleErrors.push(`${m.text()} @ ${where}`);
  });
  page.on('dialog', (d) => void d.dismiss());
  try {
    await page.addInitScript({ content: PAGE_HELPERS_JS });
    if (s.before) await s.before(page);
    await page.goto(`${url}/ui/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof startWatch === 'function');
    if (s.waitView !== false) {
      await waitView(page);
      await page.waitForSelector('#transcript', { state: 'visible' });
    }
    const detail = await s.run({ viewer, page, consoleErrors });
    expect(
      pageErrors.length === 0,
      `uncaught page errors: ${pageErrors.join(' | ')}`,
    );
    if (s.noConsoleErrors) {
      expect(
        consoleErrors.length === 0,
        `console errors: ${consoleErrors.join(' | ')}`,
      );
    }
    return detail;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const extra = pageErrors.length
      ? ` [page errors: ${pageErrors.join(' | ')}]`
      : '';
    throw new Error(msg.split('\n')[0] + extra);
  } finally {
    await viewer.close();
  }
}

// Every page scenario boots its own gateway, stub (with its own frames) and
// browser, so the section's shared viewer is unused. `ONLY=P4` runs that
// scenario only (see selected()).
async function runPageSection(): Promise<Result[]> {
  const results: Result[] = [];
  for (const s of PAGE_SCENARIOS) {
    if (!selected(s.name)) continue;
    let result: Result;
    try {
      const detail =
        'standalone' in s ? await s.standalone() : await runPageScenario(s);
      result = { name: s.name, ok: true, detail };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { name: s.name, ok: false, detail: msg.split('\n')[0]! };
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
  page: runPageSection,
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
