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
import { readFileSync } from 'node:fs';
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
  //
  // The echo is queued through noteSelfSend for the same reason the real send
  // path does it (issue #114): that marker is what tells the frame handler this
  // window typed the prompt, so the daemon's echo is recognised instead of
  // drawn as a second row. Omitting it here would model a send the page never
  // performs, and the turn would double up.
  function liveTurn(prompt, answer, toolId) {
    noteSelfSend(prompt);
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
  /** The send time (#80), from the frame envelope or the local echo. */
  time?: number;
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
declare const addUser: (text: string, time?: number) => PgItem;
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
declare const renderSessionUpdate: (u: unknown, sentAt?: number) => void;
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
  /** `meta` is the frame ENVELOPE the real EventBus stamps at publish. */
  ev(
    type: string,
    data: unknown = {},
    meta?: Record<string, unknown>,
  ): this {
    this.list.push({
      id: this.list.length + 1,
      type,
      data,
      ...(meta !== undefined ? { _meta: meta } : {}),
    });
    return this;
  }
  upd(
    update: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): this {
    return this.ev('session_update', { update }, meta);
  }
  user(text: string): this {
    return this.upd({ sessionUpdate: 'user_message_chunk', content: { text } });
  }
  asst(text: string, meta?: Record<string, unknown>): this {
    return this.upd(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { text },
      },
      meta,
    );
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

/**
 * One event as the transcript ROUTE relays it (not as the live stream sends it):
 * the same DaemonEvent envelope, with the send time on the envelope's `_meta`.
 */
function storedEvent(
  id: number,
  sessionUpdate: string,
  update: Record<string, unknown>,
  ts: number,
): Record<string, unknown> {
  return {
    id,
    v: 1,
    type: 'session_update',
    data: { update: { sessionUpdate, ...update } },
    _meta: { serverTimestamp: ts },
  };
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
      /** Stub behaviour: a slow turn, one it refuses, or the page it stores. */
      stub?: {
        promptStatus?: number;
        promptDelayMs?: number;
        transcriptPage?: unknown;
        /**
         * Status the stub answers a permission vote with, so a scenario can
         * drive a vote the daemon refuses.
         */
        permissionStatus?: number;
        /**
         * Body for GET /session/:id/status. A card scenario lists its request
         * here, because the stub's default reports nothing pending and the
         * page's 5s sweep would retire the card before the scenario votes.
         */
        sessionStatus?: unknown;
        /**
         * Daemon feature tags the stub advertises. The page hides a whole
         * panel behind some of these tags, so a scenario that drives such a
         * panel has to advertise the tag it depends on, or it is asserting
         * against markup that never becomes visible.
         */
        capabilitiesFeatures?: string[];
        /**
         * Status the stub answers GET /session/:id/export with, so a scenario
         * can drive the refusal note the page writes from the response body.
         */
        exportStatusCode?: number;
        /**
         * Status the stub answers POST /session/:id/attachments with, so a
         * scenario can drive the attach note the page writes from the response
         * body. Pair it with `attachmentUploadErrorBody`: the stub's own
         * default says `stub error`, which no real daemon ever sends.
         */
        attachmentUploadStatus?: number;
        /** Body the stub answers a refused upload with. */
        attachmentUploadErrorBody?: unknown;
        /** Body the stub answers the stored-attachment list with. */
        attachmentListResult?: unknown;
        /** Status the stub answers the stored-attachment list with. */
        attachmentListStatus?: number;
        /**
         * Status the stub answers GET /session/:id/stats with, so a scenario
         * can drive the failure row. Pair it with `statsResult` when the point
         * is the reason code, since the stub's own default body says
         * `stub error`, which no real daemon ever sends.
         */
        statsStatusCode?: number;
        /**
         * Body the stub answers GET /session/:id/stats with. A scenario that
         * asserts a printed number, or asserts that an absent optional block
         * draws nothing, has to supply the payload it expects, or it is
         * checking a roll-up the stub invented.
         */
        statsResult?: unknown;
      };
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
      // A replayed turn is four rows: the prompt, its thought, its answer,
      // and the fork that closes it. The prompt row was missing until #114.
      expect(
        r.items === 4 * P1_TURNS + 1,
        `model has ${r.items} items, expected ${4 * P1_TURNS + 1}`,
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
      expect(r.items === 1001, `${r.items} items, expected 1001`);
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
      expect(r.items === 401, `${r.items} items, expected 401`);
      expect(!r.sizer, '.vsizer present without the bundle');
      expect(
        r.rows.length === r.items && r.rows.join() === r.ids.join(),
        `${r.rows.length} rows for ${r.items} items (or out of order)`,
      );
      expect(r.mounted === r.items, `mountedCount() = ${r.mounted}`);
      // The rendered row drops the trailing space the model keeps on the
      // last chunk, so compare with it off. A missing text must still fail.
      const tail = (r.lastText ?? '').replace(/\s+$/, '');
      const want = r.lastModel === null ? null : r.lastModel.replace(/\s+$/, '');
      expect(
        want !== null && tail.endsWith(want),
        `last answer ${JSON.stringify(r.lastText)} vs model ${JSON.stringify(r.lastModel)}`,
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
      expect(before.items === 83, `setup: ${before.items} items`);
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
        switched.items === 81 && switched.seen === 20,
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
      expect(r.items === 401, `${r.items} items, expected 401`);
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
      expect(items === 21, `model holds ${items} items, expected 21`);
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

PAGE_SCENARIOS.push({
  name: 'P41 a running run can be stopped, and a run the daemon did not stop does not read as stopped',
  waitView: false,
  run: async ({ page }) => {
    const SID = '11111111-2222-3333-4444-555555555555';
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
    await page.route(/\/session\/[0-9a-f-]+\/tasks$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ v: 1, sessionId: SID, now: Date.now(), tasks }),
      }),
    );

    // The cancel endpoint is answered from mutable state so one page can be
    // driven through every verdict the daemon can return.
    const sends: Array<{ path: string; body: Record<string, unknown> }> = [];
    let cancelStatus = 200;
    let cancelBody: Record<string, unknown> = { cancelled: true };
    await page.route(
      /\/session\/[0-9a-f-]+\/tasks\/[^/]+\/cancel$/,
      (route) => {
        const raw = route.request().postData() ?? '{}';
        sends.push({
          path: new URL(route.request().url()).pathname,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        return route.fulfill({
          status: cancelStatus,
          contentType: 'application/json',
          body: JSON.stringify(cancelBody),
        });
      },
    );

    const rows = () =>
      page.evaluate(() =>
        Array.from(
          document.querySelectorAll('#runs-body > div'),
        ).map((d) => d.textContent ?? ''),
      );
    const listRuns = async () => {
      await page.evaluate((id) => {
        (document.getElementById('runs-id') as HTMLInputElement).value = id;
      }, SID);
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
      return rows();
    };
    /** Press the stop button on row `i` and wait for its verdict to land. */
    const stopRow = async (i: number) => {
      await page.evaluate((n) => {
        const row = document.querySelectorAll('#runs-body > div')[n];
        (
          row?.querySelector('button') as HTMLButtonElement | null | undefined
        )?.click();
      }, i);
      await page.waitForFunction(
        (n) =>
          /stopped|did not stop|not enabled|stop failed/.test(
            document.querySelectorAll('#runs-body > div')[n]?.textContent ?? '',
          ),
        i,
        { timeout: 8000 },
      );
      return rows();
    };

    const first = await listRuns();
    expect(first.length === 3, `three runs were sent, ${first.length} rows drew`);
    // Only the two running rows get a control. A settled row that offers stop
    // is a button that can only ever 404.
    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#runs-body > div')).map(
        (d) => d.querySelectorAll('button').length,
      ),
    );
    expect(
      buttons[0] === 1 && buttons[1] === 0 && buttons[2] === 1,
      `stop buttons landed on the wrong rows (${JSON.stringify(buttons)})`,
    );

    // Stop the agent row. The body must carry the kind and the URL the task's
    // own id, not the label the row prints.
    cancelStatus = 200;
    cancelBody = { sessionId: SID, taskId: 'a-1', cancelled: true };
    const stopped = await stopRow(0);
    expect(
      sends.length === 1,
      `the stop button sent ${sends.length} requests, expected 1`,
    );
    expect(
      sends[0].path.endsWith('/tasks/a-1/cancel'),
      `the stop request named something other than the task id (${sends[0].path})`,
    );
    expect(
      sends[0].body['kind'] === 'agent',
      `the stop body lost the kind (${JSON.stringify(sends[0].body)})`,
    );
    expect(
      stopped[0].startsWith('stopped'),
      `a cancelled run did not read as stopped (${JSON.stringify(stopped[0])})`,
    );

    // The load-bearing half: HTTP 200 with cancelled:false is NOT a stop. A
    // handler that reads only res.ok prints "stopped" over a run that is still
    // running, which is the flattened failure this route exists to avoid.
    await listRuns();
    cancelBody = { sessionId: SID, taskId: 'a-1', cancelled: false };
    const refused = await stopRow(0);
    expect(
      !/stopped/.test(refused[0]),
      `a run the daemon did not stop read as stopped (${JSON.stringify(refused[0])})`,
    );
    expect(
      refused[0].includes('did not stop'),
      `a refused stop was not named as one (${JSON.stringify(refused[0])})`,
    );

    // A policy refusal says why, because "workflow runs are not enabled here"
    // is actionable and "the daemon did not stop it" is not.
    await listRuns();
    cancelBody = { cancelled: false, reason: 'disabled' };
    const disabled = await stopRow(0);
    expect(
      disabled[0].includes('not enabled'),
      `a disabled-workspace refusal lost its reason (${JSON.stringify(disabled[0])})`,
    );

    // A transport failure names the gateway code, not the daemon's message.
    await listRuns();
    cancelStatus = 502;
    cancelBody = { error: 'Daemon unavailable', code: 'daemon_unavailable' };
    const broke = await stopRow(0);
    expect(
      broke[0].includes('stop failed: daemon_unavailable'),
      `a transport failure was not named (${JSON.stringify(broke[0])})`,
    );

    return `only running rows offer stop; the request carries the task id and the kind; cancelled:true reads as stopped; a 200 with cancelled:false does NOT; a disabled-workspace refusal names itself; a transport failure names daemon_unavailable`;
  },
});

// Three different instants, so no assertion can be satisfied by a row that
// happens to share another row's time.
const SENT_AT = 1_700_000_000_000;
const TURN2_AT = 1_700_003_600_000;
const ECHO_AT = 1_700_010_800_000;

/**
 * The viewer's formatter run here rather than read back from the page, so the
 * expected string derives from the pinned zone and not from whatever the view
 * happened to produce. Chromium's ICU puts a narrow no-break space before
 * AM/PM where Node's puts an ordinary one, so both sides fold to plain spaces.
 */
function zoned(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(new Date(ms))
    .replace(/[\u202f\u00a0]/g, ' ');
}

function eastern(ms: number): string {
  return zoned(ms, 'America/New_York');
}

const fold = (t: string | null): string | null =>
  t === null ? null : t.replace(/[\u202f\u00a0]/g, ' ');

const wantStamp = (ms: number) => ` \u00b7 ${eastern(ms)}`;
const wantStampIn = (ms: number, zone: string) => ` \u00b7 ${zoned(ms, zone)}`;

PAGE_SCENARIOS.push({
  name: 'P42 a message row says when it was sent, in the zone the viewer pins rather than the browser\u2019s',
  // This box runs America/New_York, so an Eastern assertion made here would
  // also pass if the view leaked the browser's own zone. Moving the browser to
  // Kolkata (+5:30, most of a day out) is what makes the assertion bite.
  before: async (page) => {
    // Playwright pins the zone at context creation, which the harness owns, so
    // move this one page over CDP instead of widening the harness for it.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTimezoneOverride', {
      timezoneId: 'Asia/Kolkata',
    });
  },
  // Three turns, each opened by a tool frame: the model closes the current
  // assistant bubble on a tool call (upsertTool -> resetTurn), NOT on
  // turn_complete, so back-to-back asst frames would all land in one row and
  // the per-message assertion below would be vacuous.
  frames: () => {
    const f = new Frames();
    for (const [i, stamp] of [
      [1, SENT_AT],
      [2, TURN2_AT],
      // The third turn carries no send time at all: the row must draw no
      // stamp. An absent time reaching the formatter would print
      // "Dec 31, 1969" and read like a real date.
      [3, null],
    ] as Array<[number, number | null]>) {
      f.toolCall(`tc-${i}`, 'read_file', 'in_progress').toolUpdate(
        `tc-${i}`,
        'completed',
      );
      f.asst(
        `answer ${i}. `,
        stamp === null ? undefined : { serverTimestamp: stamp },
      );
      f.done();
    }
    return f.list;
  },
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await waitForFrame(page, 12, 30_000);
    await settlePage(page);

    // The echo is the only user row the viewer ever draws: a replayed
    // user_message_chunk is counted, not rendered, so there is no record-side
    // time for it and its send moment is this browser's own.
    const echoId = await page.evaluate(
      (t) => addUser('typed prompt', t).id,
      ECHO_AT,
    );
    await settlePage(page);

    const read = (rowId: number) =>
      page.evaluate((id) => {
        const row = __pg.row(id);
        const sp = row ? row.querySelector('.stamp') : null;
        const it = transcriptModel.items.find((i) => i.id === id);
        return {
          found: !!it,
          time: it && typeof it.time === 'number' ? it.time : null,
          stamp: sp ? (sp.textContent ?? '') : null,
          inRole: !!(
            sp &&
            sp.parentElement &&
            sp.parentElement.classList.contains('role')
          ),
        };
      }, rowId);

    const asstIds = await page.evaluate(() =>
      transcriptModel.items
        .filter((i) => i.kind === 'asst')
        .map((i) => i.id),
    );
    const allKinds = await page.evaluate(() =>
      transcriptModel.items.map((i) => i.kind).join(','),
    );
    expect(
      asstIds.length === 3,
      `${asstIds.length} assistant rows, expected 3 (items: ${allKinds})`,
    );

    // Row 1: the envelope's send time reached the model untouched, and it is
    // drawn INSIDE the existing role line, so no row grew a second line and
    // the row-height cache never sees a different measurement.
    const one = await read(asstIds[0]!);
    expect(one.time === SENT_AT, `stamped row time=${one.time}`);
    expect(
      fold(one.stamp) === wantStamp(SENT_AT),
      `stamped row reads ${JSON.stringify(one.stamp)}, expected ${JSON.stringify(
        wantStamp(SENT_AT),
      )}`,
    );
    expect(
      one.inRole,
      'the stamp sits outside the role line, so it moves row height',
    );

    // Row 2: each row carries its OWN time. A single shared "now" would render
    // both rows identically, which is the failure this guards.
    const two = await read(asstIds[1]!);
    expect(
      two.time === TURN2_AT,
      `second row time=${two.time}, expected its own send time`,
    );
    expect(fold(two.stamp) === wantStamp(TURN2_AT), `second row reads ${JSON.stringify(two.stamp)}`);
    expect(
      fold(one.stamp) !== fold(two.stamp),
      'both rows drew the same time, so the stamp is not per-message',
    );

    // Row 3: the negative case. No send time on the frame means no stamp, not
    // a zero-time stamp.
    const three = await read(asstIds[2]!);
    expect(three.time === null, `an unstamped row grew a time (${three.time})`);
    expect(
      three.stamp === null,
      `an unstamped row drew a stamp (${JSON.stringify(three.stamp)})`,
    );

    // The user echo, the other kind the issue names.
    const user = await read(echoId);
    expect(user.time === ECHO_AT, `echo row time=${user.time}`);
    expect(
      fold(user.stamp) === wantStamp(ECHO_AT),
      `echo row reads ${JSON.stringify(user.stamp)}`,
    );
    expect(user.inRole, 'the echo stamp sits outside the role line');

    return `the envelope send time reaches the row untouched (${eastern(SENT_AT)}); each row carries its own, so it is per-message; the stamp rides inside the role line so no row grows; the user echo is stamped; a frame with no send time draws no stamp; all of it under a browser pinned to Kolkata, so the zone is the viewer's, not the browser's`;
  },
});

// The half P42 cannot see: P42 proves the view ignores the browser's zone, but
// it never changes the zone, so it would pass just as well with the zone
// welded to the default. This drives the real Settings control, checks that a
// row ALREADY on screen repaints (the patchers cannot reach an existing stamp,
// so this is the one path that proves the rebuild), and reloads to prove the
// choice came from the gateway rather than from this tab.
PAGE_SCENARIOS.push({
  name: 'P43 the zone a reader picks is saved on the gateway, repaints the rows already on screen, and survives a reload',
  // Pinned to a zone that is neither the default nor the saved choice, so a
  // render that followed the browser fails at every step rather than at one.
  before: async (page) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTimezoneOverride', {
      timezoneId: 'Asia/Kolkata',
    });
  },
  frames: () => {
    const f = new Frames();
    for (const [i, stamp] of [
      [1, SENT_AT],
      [2, TURN2_AT],
    ] as Array<[number, number]>) {
      // The model closes the current bubble on a tool frame, so each turn needs
      // one or both answers collapse into a single row.
      f.toolCall(`tc-${i}`, 'read_file', 'in_progress').toolUpdate(
        `tc-${i}`,
        'completed',
      );
      f.asst(`answer ${i}. `, { serverTimestamp: stamp });
      f.done();
    }
    return f.list;
  },
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await waitForFrame(page, 8, 30_000);
    await settlePage(page);

    const asstIds = () =>
      page.evaluate(() =>
        transcriptModel.items
          .filter((i) => i.kind === 'asst')
          .map((i) => i.id),
      );
    const stampOf = (id: number) =>
      page.evaluate((rid) => {
        const row = __pg.row(rid);
        const sp = row ? row.querySelector('.stamp') : null;
        return sp ? (sp.textContent ?? '') : null;
      }, id);
    const heightOf = (id: number) =>
      page.evaluate((rid) => {
        const row = __pg.row(rid);
        return row ? Math.round(row.getBoundingClientRect().height) : -1;
      }, id);

    const ids = await asstIds();
    expect(ids.length === 2, `${ids.length} assistant rows, expected 2`);

    // Step 1: nothing saved, so the rows draw in the default zone, which is not
    // the browser's. This is the state the change is made FROM, so a view that
    // ignored the change entirely would still be caught by step 3.
    const start1 = fold(await stampOf(ids[0]!));
    expect(
      start1 === wantStamp(SENT_AT),
      `with nothing saved the row reads ${JSON.stringify(start1)}, expected the default ${JSON.stringify(wantStamp(SENT_AT))}`,
    );
    const startH = await heightOf(ids[0]!);

    // Step 2: drive the control the way a person does, not the setter.
    const picked = await page.evaluate(() => {
      const sel = document.getElementById('stamp-zone') as HTMLSelectElement;
      if (!sel) return 'no control on the page';
      sel.value = 'Asia/Tokyo';
      // A select with no such option silently reads back empty, which would
      // make the rest of this scenario vacuous.
      if (sel.value !== 'Asia/Tokyo')
        return `the picker has no Tokyo option (value reads ${JSON.stringify(sel.value)}, ${sel.options.length} options)`;
      sel.dispatchEvent(new Event('change'));
      return 'ok';
    });
    expect(picked === 'ok', `the Settings control could not be set (${picked})`);

    // Step 3: the row that was already mounted repaints. Polled, not slept:
    // this is a PUT round trip plus a restamp pass.
    const wantTokyo = wantStampIn(SENT_AT, 'Asia/Tokyo');
    const deadline = Date.now() + 10_000;
    let after1 = fold(await stampOf(ids[0]!));
    while (after1 !== wantTokyo && Date.now() < deadline) {
      await page.waitForTimeout(100);
      after1 = fold(await stampOf(ids[0]!));
    }
    expect(
      after1 === wantTokyo,
      `after the change the row already on screen reads ${JSON.stringify(after1)}, expected ${JSON.stringify(wantTokyo)}`,
    );
    // Both rows, not just the newest: the restamp walks the mounted set.
    expect(
      fold(await stampOf(ids[1]!)) === wantStampIn(TURN2_AT, 'Asia/Tokyo'),
      'the second mounted row did not repaint',
    );
    // And the repaint cost no height, because the stamp still rides inside the
    // role line. A row that grew here would desync the virtualizer's cache.
    const afterH = await heightOf(ids[0]!);
    expect(
      afterH === startH,
      `the repaint moved the row height (${startH} -> ${afterH})`,
    );

    // Step 4: a fresh page, no interaction. The only thing that can put Tokyo
    // back on screen now is the gateway's answer to the boot read.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof startWatch === 'function');
    await page.waitForFunction(() => watchedSessionId !== null);
    const reloadedDeadline = Date.now() + 10_000;
    let reloaded: number[] = [];
    for (;;) {
      reloaded = await asstIds();
      if (reloaded.length >= 2 || Date.now() > reloadedDeadline) break;
      await page.waitForTimeout(100);
    }
    expect(
      reloaded.length === 2,
      `the reload rebuilt ${reloaded.length} assistant rows, expected 2`,
    );
    await settlePage(page);
    let afterReload = fold(await stampOf(reloaded[0]!));
    const reloadDeadline = Date.now() + 10_000;
    while (afterReload !== wantTokyo && Date.now() < reloadDeadline) {
      await page.waitForTimeout(100);
      afterReload = fold(await stampOf(reloaded[0]!));
    }
    expect(
      afterReload === wantTokyo,
      `after a reload the row reads ${JSON.stringify(afterReload)}, expected the saved zone ${JSON.stringify(wantTokyo)}`,
    );
    const shownZone = await page.evaluate(
      () => (document.getElementById('stamp-zone') as HTMLSelectElement).value,
    );
    expect(
      shownZone === 'Asia/Tokyo',
      `the control came back showing ${JSON.stringify(shownZone)}, expected the saved zone`,
    );

    // Named separately from the render, so a row that painted Tokyo while the
    // gateway held something else cannot pass on the render alone.
    const stored = await page.evaluate(async () => {
      const r = await fetch('/rc/ui-prefs', {
        headers: { Authorization: 'Bearer ' + token() },
      });
      return (await r.json()) as { stampZone: string; saved: boolean };
    });
    expect(
      stored.stampZone === 'Asia/Tokyo' && stored.saved === true,
      `the gateway holds ${JSON.stringify(stored)}, expected the saved Tokyo choice`,
    );

    return `nothing saved draws the default (${start1}) while the browser sits in Kolkata; picking Tokyo in Settings repaints the rows already mounted (${after1}) and both rows together; the repaint costs no row height (${startH}px held); a reload with no interaction comes back in Tokyo from the gateway's own answer (${JSON.stringify(stored)})`;
  },
});

// The route answers a curl, but a reader on the page could never reach it: the
// transcript only ever held what this attach replayed. This drives the control
// the way a person does. Three things go wrong in a naive wiring, and all three
// are checked: the rows must land AHEAD of the live ones, not after them; the
// page's live turn state must not move (a stored frame carries the same envelope
// as a live one, so routing it through renderFrame would advance the turn
// counter and the footer); and the reader, who is looking at the middle of a
// long transcript, must not be shoved by content arriving above the viewport.
PAGE_SCENARIOS.push({
  name: 'P44 load earlier draws the stored page ahead of the live rows without moving the turn or the reader',
  frames: () => replayFrames(20, 2),
  stub: {
    transcriptPage: {
      v: 1,
      events: [
        storedEvent(
          1,
          'user_message_chunk',
          { content: { text: 'paged question one' } },
          1_700_000_000_000,
        ),
        storedEvent(
          2,
          'agent_thought_chunk',
          { content: { text: 'paged thinking' } },
          1_700_000_001_000,
        ),
        storedEvent(
          3,
          'agent_message_chunk',
          { content: { text: 'paged answer one' } },
          1_700_000_002_000,
        ),
        storedEvent(
          4,
          'tool_call',
          { toolCallId: 'pt-1', title: 'read_file', status: 'in_progress' },
          1_700_000_003_000,
        ),
      ],
      nextCursor: 'eyJyZWNvcmRJZCI6IjEifQ',
      hasMore: true,
    },
  },
  run: async ({ page, viewer }) => {
    const asked: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.endsWith('/transcript')) asked.push(u.search);
    });

    await watch(page, viewer.sessionId);
    await waitForFrame(page, 20 * 7, 30_000);
    await settlePage(page);

    const state = () =>
      page.evaluate(() => ({
        items: transcriptModel.items.map((i) => ({
          id: i.id,
          kind: i.kind,
          text: i.text ?? '',
        })),
        users: userTurnsSeen,
        forks: forkTurnCount,
        footer: document.getElementById('session-footer')?.textContent ?? '',
        pill: (document.getElementById('jump-bottom') as HTMLElement).hidden,
      }));
    // The row the reader is aimed at, as readerPlace() picks it: the last one
    // starting at or above the top edge, else the first one below it.
    const edgeRow = () =>
      page.evaluate(() => {
        const s = document.getElementById('transcript')!;
        const edge = s.getBoundingClientRect().top;
        const rows = Array.from(
          s.querySelectorAll<HTMLElement>('.vrow[data-id]'),
        ).map((r) => ({
          id: Number(r.dataset['id']),
          top: Math.round(r.getBoundingClientRect().top - edge),
        }));
        const above = rows.filter((r) => r.top <= 0);
        if (above.length)
          return above.reduce((a, b) => (b.top > a.top ? b : a));
        const below = rows.filter((r) => r.top > 0);
        if (below.length)
          return below.reduce((a, b) => (b.top < a.top ? b : a));
        return { id: -1, top: 0 };
      });

    // Mid-transcript, not at the end: at the end the view follows, which is a
    // different path and would make the anchor claim vacuous.
    await page.evaluate(() => {
      const s = document.getElementById('transcript')!;
      s.scrollTop = Math.floor(s.scrollHeight / 2);
    });
    await settlePage(page);

    const before = await state();
    expect(before.items.length > 20, `setup: only ${before.items.length} rows`);
    expect(before.users > 0, 'setup: no live user records counted');
    const anchor = await edgeRow();
    expect(anchor.id > 0, 'setup: nothing on screen to anchor the reader to');
    expect(before.pill === false, 'setup: the reader was not mid-transcript');

    await page.click('#load-earlier');
    const drew = await page
      .waitForFunction(
        (n) => transcriptModel.items.length > n,
        before.items.length,
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    expect(drew, 'the read added no rows to the model');
    await settlePage(page);

    const after = await state();
    const added = after.items.length - before.items.length;
    expect(added === 4, `${added} rows drawn, expected 4`);
    expect(
      after.items
        .slice(0, 4)
        .map((r) => r.kind)
        .join(',') === 'user,thought,asst,tool',
      `the page drew ${JSON.stringify(after.items.slice(0, 4).map((r) => r.kind))}`,
    );
    // Ahead of, not after: the stored half of the conversation belongs above the
    // live one, and the reader's own prompt has to be drawn even though the live
    // path leaves it to the local echo (which a stored page never carries).
    expect(
      after.items[0]?.text === 'paged question one',
      `the first row reads ${JSON.stringify(after.items[0]?.text)}`,
    );
    // The live rows survive untouched, down to their ids: the read re-keys only
    // what it splices in, so the virtualizer never sees two items on one key.
    expect(
      JSON.stringify(after.items.slice(4)) === JSON.stringify(before.items),
      'the read did not leave the live rows exactly as they were',
    );

    // The live turn. A stored page carries user records and answers in the same
    // envelope a live frame does, so this is where a wiring that reused
    // renderFrame would show up: the turn counter arms, and the footer restates
    // a token total this read never produced.
    expect(
      after.users === before.users && after.forks === before.forks,
      `the read moved the turn: ${before.users}/${before.forks} -> ${after.users}/${after.forks}`,
    );
    expect(
      after.footer === before.footer,
      `the read moved the footer: ${JSON.stringify(before.footer)} -> ${JSON.stringify(after.footer)}`,
    );

    // The reader. Content arriving above the viewport moves everything below it,
    // so unless the view puts them back the row they were reading is gone.
    const moved = await page.evaluate((rid) => {
      const s = document.getElementById('transcript')!;
      const r = s.querySelector<HTMLElement>(`.vrow[data-id="${rid}"]`);
      if (!r) return null;
      const edge = s.getBoundingClientRect().top;
      return Math.round(r.getBoundingClientRect().top - edge);
    }, anchor.id);
    expect(moved !== null, `the row the reader was on (${anchor.id}) vanished`);
    expect(
      Math.abs((moved ?? 0) - anchor.top) <= 2 && after.pill === false,
      `the read moved the reader: row ${anchor.id} was at ${anchor.top}px, now ${moved}px (pill hidden ${after.pill})`,
    );

    expect(
      asked.length === 1,
      `${asked.length} reads after one tap, expected 1`,
    );
    expect(
      asked[0]?.includes('direction=backward') &&
        asked[0]?.includes('limit=80') &&
        !asked[0]?.includes('cursor='),
      `the first read asked for ${JSON.stringify(asked[0])}`,
    );

    // The cursor has to ride the next request. Without it a second tap re-reads
    // the newest page and prepends the same records a second time.
    await page.click('#load-earlier');
    const again = Date.now();
    while (asked.length < 2 && Date.now() - again < 10_000) {
      await page.waitForTimeout(100);
    }
    expect(asked.length === 2, `the second tap sent ${asked.length} requests`);
    expect(
      asked[1]?.includes('cursor=eyJyZWNvcmRJZCI6IjEifQ'),
      `the second read dropped the cursor: ${JSON.stringify(asked[1])}`,
    );

    return `${added} stored rows drawn ahead of ${before.items.length} live ones (${JSON.stringify(after.items[0]?.text)} first) with the live rows byte-identical behind them; the turn (${after.users} records) and the footer held still; the reader stayed on row ${anchor.id} at ${moved}px; the first read asked for a backward page of 80 with no cursor and the second carried the daemon's back`;
  },
});

// The other half of the same guard. The daemon can say there is more while
// handing back nothing to ask for it with, and a control that stays on the page
// in that state invites a tap that re-reads the newest page and shows it twice.
PAGE_SCENARIOS.push({
  name: 'P45 a page that claims more but carries no cursor retires the control',
  frames: () => replayFrames(6, 1),
  stub: {
    transcriptPage: {
      v: 1,
      events: [
        storedEvent(
          1,
          'agent_message_chunk',
          { content: { text: 'one stored answer' } },
          1_700_000_000_000,
        ),
      ],
      hasMore: true,
    },
  },
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await waitForFrame(page, 6 * 6, 30_000);
    await settlePage(page);

    const btn = () =>
      page.evaluate(() => {
        const b = document.getElementById('load-earlier') as HTMLElement;
        return { hidden: b.hidden, rows: transcriptModel.items.length };
      });

    const before = await btn();
    expect(before.hidden === false, 'setup: no control to begin with');

    await page.click('#load-earlier');
    const gone = await page
      .waitForFunction(
        () => (document.getElementById('load-earlier') as HTMLElement).hidden,
        null,
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    const after = await btn();
    // The row it did draw still lands: retiring the control is not undoing the
    // page that arrived with the retirement.
    expect(
      after.rows === before.rows + 1,
      `the read drew ${after.rows - before.rows} rows, expected 1`,
    );
    expect(
      gone && after.hidden,
      `the control stayed on the page: ${JSON.stringify(after)}`,
    );

    return `the stored row landed (${after.rows - before.rows}) and the control retired itself (${JSON.stringify(after)}), so a tap that could only repeat the page is not offered`;
  },
});

// issue #114. The send path echoes what you typed at the moment you sent it,
// and the viewer used to drop every `user_message_chunk` on that account. That
// was only ever true of the window that typed it: a second window, a reload, or
// a turn started on another device has no local echo, so it rendered an
// assistant-only transcript, which is what #114 reads as and what #113 reads as
// the phone's messages never reaching the laptop.
//
// The assertion is on the model rather than the DOM (rows far from the viewport
// are unmounted) and it counts user rows specifically, because an assistant
// count would pass with the defect still in place.
PAGE_SCENARIOS.push({
  name: 'P46 a transcript draws the user rows it never typed, and still draws your own once',
  frames: () =>
    new Frames()
      .user('started on the laptop')
      .asst('the answer to it')
      .done()
      .user('a second question')
      .asst('the second answer')
      .done().list,
  run: async ({ page, viewer }) => {
    // No cursor, which is what a fresh attach sends: this is the window that
    // did not type anything, reading a conversation that already has turns.
    await watch(page, viewer.sessionId);
    await waitForFrame(page, 6, 15_000);
    await settlePage(page);

    const userRows = () =>
      page.evaluate(
        () =>
          transcriptModel.items
            .filter((i) => i.kind === 'user')
            .map((i) => i.text),
      );

    const replayed = await userRows();
    expect(
      replayed.length === 2,
      `${replayed.length} user rows after replaying two prompts (${JSON.stringify(replayed)}) - ` +
        'the replay path is dropping them again, which is #114',
    );
    expect(
      replayed[0] === 'started on the laptop',
      `the first user row reads ${JSON.stringify(replayed[0])}`,
    );

    // The other half: the echo of a prompt this window DID send must not draw
    // a second row under it. Driven through the page's own bookkeeping rather
    // than a real send, because the send path needs a live turn to settle.
    const echoed = await page.evaluate(() => {
      noteSelfSend('typed right here');
      renderFrame({
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { text: 'typed right here' },
          },
        },
      });
      return transcriptModel.items
        .filter((i) => i.kind === 'user')
        .map((i) => i.text);
    });
    expect(
      echoed.length === 2,
      `the daemon's echo of your own prompt drew a second row (${JSON.stringify(echoed)})`,
    );

    // And a frame that is NOT yours still draws, so the dedup above has not
    // simply restored the old drop-everything behaviour.
    const other = await page.evaluate(() => {
      renderFrame({
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { text: 'typed on the phone' },
          },
        },
      });
      return transcriptModel.items
        .filter((i) => i.kind === 'user')
        .map((i) => i.text);
    });
    expect(
      other.length === 3 && other[2] === 'typed on the phone',
      `another device's prompt drew ${other.length - 2} rows (${JSON.stringify(other)})`,
    );

    return `two replayed prompts drew two user rows, your own echo stayed at one row, and another device's prompt drew its own`;
  },
});

// #116: an answered card is history. The strip above the composer is the live
// queue, so a card that stays there after the vote turns a few turns into a
// pile the reader has to scroll past. The note is what makes this prove the
// VOTE retired it: the pending poll retires the same shape with a different
// word, so watching only for a removal would pass even if vote() never called
// retireCard at all.
PAGE_SCENARIOS.push({
  name: 'P47 an answered permission card leaves the strip',
  frames: () =>
    new Frames().ev('permission_request', {
      requestId: 'p47-req',
      toolCall: { kind: 'exec', title: 'run the tests' },
      options: [{ optionId: 'allow_once', name: 'Allow once' }],
    }).list,
  // The request stays listed as pending. The stub's default status reports
  // none, and the page's 5s sweep would otherwise retire the card before the
  // scenario ever presses a button, which would test the sweep instead of the
  // vote.
  stub: {
    sessionStatus: {
      workspaceCwd: '/proj',
      clientCount: 0,
      hasActivePrompt: false,
      pendingInteractions: [
        {
          requestId: 'p47-req',
          kind: 'permission',
          action: { type: 'exec', title: 'run the tests' },
          options: [{ optionId: 'allow_once', label: 'Allow once' }],
        },
      ],
    },
  },
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await page.waitForFunction(
      () => document.querySelectorAll('#cards .card').length === 1,
      null,
      { timeout: 15_000 },
    );
    // Tag the node rather than counting the strip. The poll still lists this
    // request, so a later poll could draw a fresh card, and "the strip is
    // empty" would race that redraw. "This card left" is the actual claim.
    await page.evaluate(() => {
      document.querySelector('#cards .card')?.setAttribute('data-probe', '1');
    });

    await page.click('#cards .card button');
    await page.waitForFunction(
      () =>
        document
          .querySelector('#cards .card[data-probe]')
          ?.textContent?.includes('voted: selected'),
      null,
      { timeout: 10_000 },
    );

    const gone = await page
      .waitForFunction(
        () => document.querySelector('#cards .card[data-probe]') === null,
        null,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    expect(gone, 'the answered card never left the strip');
    return 'the card confirmed the vote, then left the strip on its own, so an answered prompt does not pile up';
  },
});

// The other half of #116. A vote the daemon refused leaves the request live on
// the daemon, so a card greyed out over it is the worst case of the issue: a
// dead card in the pile with the retry taken away as well.
PAGE_SCENARIOS.push({
  name: 'P48 a refused vote leaves the card pressable so it can be retried',
  frames: () =>
    new Frames().ev('permission_request', {
      requestId: 'p48-req',
      toolCall: { kind: 'exec', title: 'run the tests' },
      options: [{ optionId: 'allow_once', name: 'Allow once' }],
    }).list,
  stub: {
    permissionStatus: 502,
    sessionStatus: {
      workspaceCwd: '/proj',
      clientCount: 0,
      hasActivePrompt: false,
      pendingInteractions: [
        {
          requestId: 'p48-req',
          kind: 'permission',
          action: { type: 'exec', title: 'run the tests' },
          options: [{ optionId: 'allow_once', label: 'Allow once' }],
        },
      ],
    },
  },
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await page.waitForFunction(
      () => document.querySelectorAll('#cards .card').length === 1,
      null,
      { timeout: 15_000 },
    );
    await page.evaluate(() => {
      document.querySelector('#cards .card')?.setAttribute('data-probe', '1');
    });

    await page.click('#cards .card button');
    await page.waitForFunction(
      () =>
        document
          .querySelector('#cards .card[data-probe]')
          ?.textContent?.includes('vote failed'),
      null,
      { timeout: 10_000 },
    );

    const state = await page.evaluate(() => {
      const el = document.querySelector('#cards .card[data-probe]');
      const btns = Array.from(
        el?.querySelectorAll('button') ?? [],
      ) as HTMLButtonElement[];
      return {
        attached: el !== null,
        pressable: btns.some((b) => !b.disabled),
        note: el?.textContent ?? '',
      };
    });
    expect(
      state.attached,
      'the refused card was dropped, so the reader cannot retry it',
    );
    expect(
      state.pressable,
      `every button on the refused card is disabled: ${state.note}`,
    );
    return `the refused vote was reported (${JSON.stringify(state.note)}) and the card stayed pressable, so the retry is still there`;
  },
});

// #85: the page's own clock. The gateway pings every 25s, so a live socket
// always produces bytes. A path that black-holes writes without ever failing
// them produces neither a byte nor a close, and reader.read() parks on it
// forever — the reported freeze. Nothing else here can see it: the retry
// ladder only runs once a connect has failed or ended, and this one has done
// neither. The stub already holds the stream open after its frames
// (holdOpenMs), which is that silence, so the scenario lowers the window and
// watches the wire. The assertion is the header the reconnect actually puts
// on the wire, recorded from the request rather than from the page's own idea
// of what it asked for.
PAGE_SCENARIOS.push({
  name: 'P49 a watched stream that goes silent reconnects from its cursor',
  frames: () =>
    new Frames()
      .asst('the first answer')
      .asst('the second answer')
      .done()
      .list,
  run: async ({ page, viewer }) => {
    const sent: Array<{ id: string | null; at: number }> = [];
    const t0 = Date.now();
    await page.route(/\/session\/[^/]+\/events$/, async (route) => {
      sent.push({
        id: route.request().headers()['last-event-id'] ?? null,
        at: Date.now() - t0,
      });
      await route.continue();
    });

    // Lowered before the connect, because armStall reads the window when it
    // arms and a later assignment would leave this watch on the 75s default.
    // 1.5s sits far under the gateway's 25s ping, so no heartbeat can be what
    // ends this stream — only the page's own clock can.
    await page.evaluate((id) => {
      lastSeenEventId = null;
      watchStallMs = 1500;
      void startWatch(id);
    }, viewer.sessionId);

    // The three frames land first, so the cursor the reconnect has to carry is
    // observed rather than assumed.
    await waitForFrame(page, 3, 8_000);

    // Stall fires at ~1.5s, then the first retry is scheduled 1s out.
    const deadline = Date.now() + 12_000;
    while (sent.length < 2 && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    expect(
      sent.length >= 2,
      `the silent stream never produced a reconnect (attempts: ${JSON.stringify(sent)}) — ` +
        'self-heal state at the deadline: ' +
        (await page.evaluate(
          () =>
            `hidden=${document.hidden} watch.disabled=${$('watch').disabled} ` +
            `streamAlive=${watchStreamAlive} watchedId=${watchedSessionId != null} ` +
            `retryAttempt=${watchRetryAttempt} timerPending=${watchRetryTimer != null} ` +
            `lastSeen=${lastSeenEventId} status=${$('status').textContent}`,
        )),
    );
    // The first connect asked for nothing (a fresh tap), which is what makes
    // the second one the recovery rather than the original subscribe.
    expect(
      sent[0].id === null,
      `the first connect already asked for Last-Event-ID ${JSON.stringify(sent[0].id)}`,
    );
    // replayFrom is exclusive of the cursor, so 3 re-sends frame 4 and nothing
    // more: no gap, no duplicate of what was already drawn.
    expect(
      sent[1].id === '3',
      `the stall reconnect asked for Last-Event-ID ${JSON.stringify(sent[1].id)}, wanted "3" ` +
        `(the last frame drawn; attempts: ${JSON.stringify(sent)})`,
    );
    // Well under the 25s heartbeat, so the page's clock is what recovered it.
    // Were the watchdog absent, the earliest this could happen is a ping
    // arriving and the socket dying behind it.
    expect(
      sent[1].at < 10_000,
      `the reconnect took ${sent[1].at} ms, which is not the page's 1500 ms window plus ` +
        'its 1s first retry — something slower than the watchdog recovered it',
    );
    return `a stream silent for 1.5s reconnected at Last-Event-ID 3 after ${sent[1].at} ms, so a black-holed socket recovers without waiting for the server's 25s ping`;
  },
});
PAGE_SCENARIOS.push({
  name: 'P50 the workspace file browser reaches the daemon and reads through it',
  // The panel sits in the ops pane, so nothing here needs the transcript view.
  waitView: false,
  stub: { capabilitiesFeatures: ['workspace_file_read'] },
  noConsoleErrors: true,
  run: async ({ page }) => {
    // The panel lives under Settings, not Operations: its ancestor chain is
    // details#ws-files inside #pane-settings, which is where P35 finds the
    // other unseen surfaces too.
    await page.click('.tab[data-tab="settings"]');
    const gate = await page.evaluate(() => {
      const sec = document.getElementById('ws-files');
      return {
        hasBody: !!document.getElementById('ws-files-body'),
        hidden: !!sec && sec.hidden,
      };
    });
    expect(gate.hasBody, 'no #ws-files-body in the page at all');
    expect(
      !gate.hidden,
      '#ws-files stayed hidden although the daemon advertised workspace_file_read',
    );

    // The section is a <details> and nothing in the page expands it for the
    // reader (the only .open assignment is the ? handler, which opens a panel
    // to show its help), so its body is unrendered until tapped. Expand it the
    // way a tap on the heading does, and check the body actually has geometry
    // before clicking into it.
    await page.click('#ws-files > summary');
    const opened = await page.evaluate(() => {
      const det = document.getElementById('ws-files');
      const body = document.getElementById('ws-files-body');
      return `${det?.open}/${!!body && body.getBoundingClientRect().height > 0}`;
    });
    expect(
      opened === 'true/true',
      `expanding the heading did not render the body, open/has-height ${JSON.stringify(opened)}`,
    );

    // Open it the way a user does: the section's own Load control.
    await page.click('#ws-files-body button');
    await page.waitForFunction(
      () => {
        const b = document.getElementById('ws-files-body');
        return !!b && /README\.md/.test(b.textContent || '');
      },
      null,
      { timeout: 15_000 },
    );

    const listing = await page.evaluate(() => {
      const b = document.getElementById('ws-files-body');
      const strong = b ? b.querySelector('strong') : null;
      return {
        head: strong ? strong.textContent || '' : '',
        rows: Array.from(b ? b.querySelectorAll('button') : []).map(
          (x) => x.textContent || '',
        ),
        notes: Array.from(b ? b.querySelectorAll('span') : [])
          .map((x) => (x.textContent || '').trim())
          .filter((t) => t !== ''),
      };
    });
    expect(
      listing.head === '.',
      `the listing opened at ${JSON.stringify(listing.head)}, expected the root`,
    );
    expect(
      listing.rows.includes('src/'),
      `a directory is not offered as enterable: ${JSON.stringify(listing.rows)}`,
    );
    expect(
      listing.rows.includes('README.md'),
      `a file row is missing: ${JSON.stringify(listing.rows)}`,
    );
    expect(
      listing.notes.includes('ignored'),
      `the daemon's ignored flag is not surfaced: ${JSON.stringify(listing.notes)}`,
    );
    // At the root there is nowhere to go up, so the control must be absent
    // rather than present and inert.
    expect(
      !listing.rows.includes('up'),
      'an up control appeared at the root of the tree',
    );

    // Descend. The stub answers with the path IT was asked for, so the head
    // reading 'src' can only happen if the request carried path=src: this is
    // the round trip, not a re-read of page state.
    const clickRow = (label: string) =>
      page.evaluate((text) => {
        const hit = Array.from(
          document.querySelectorAll('#ws-files-body button'),
        ).find((x) => (x.textContent || '') === text) as
          | HTMLButtonElement
          | undefined;
        if (!hit) return 'no such control';
        hit.click();
        return 'clicked';
      }, label);
    const headText = () =>
      page.evaluate(
        () =>
          document.querySelector('#ws-files-body strong')?.textContent || '',
      );

    expect((await clickRow('src/')) === 'clicked', 'the src row vanished');
    await page.waitForFunction(
      () =>
        document.querySelector('#ws-files-body strong')?.textContent === 'src',
      null,
      { timeout: 15_000 },
    );

    // One level down, up appears and takes the reader back.
    expect(
      (await page.evaluate(() =>
        Array.from(
          document.querySelectorAll('#ws-files-body button'),
        ).some((x) => (x.textContent || '') === 'up'),
      )) === true,
      'no up control one directory down',
    );
    expect((await clickRow('up')) === 'clicked', 'the up control vanished');
    await page.waitForFunction(
      () =>
        document.querySelector('#ws-files-body strong')?.textContent === '.',
      null,
      { timeout: 15_000 },
    );
    expect((await headText()) === '.', 'up did not return the reader to root');

    // A file row reads the file rather than entering it.
    expect((await clickRow('README.md')) === 'clicked', 'the file row vanished');
    await page.waitForFunction(
      () => {
        const v = document.getElementById('ws-files-view');
        return !!v && /# hello/.test(v.textContent || '');
      },
      null,
      { timeout: 15_000 },
    );
    const fileView = await page.evaluate(() => {
      const v = document.getElementById('ws-files-view');
      return {
        title: v ? v.querySelector('strong')?.textContent || '' : '',
        size: v ? v.querySelector('span')?.textContent || '' : '',
      };
    });
    expect(
      fileView.title === 'README.md',
      `the file view is titled ${JSON.stringify(fileView.title)}`,
    );
    expect(
      fileView.size.includes('8 bytes'),
      `the file view reports ${JSON.stringify(fileView.size)}`,
    );

    // Find goes through GET /glob, the fourth route of the slice.
    await page.fill('#ws-files-body input', 'src/**/*.ts');
    await page.press('#ws-files-body input', 'Enter');
    await page.waitForFunction(
      () => {
        const v = document.getElementById('ws-files-view');
        return !!v && /src\/index\.ts/.test(v.textContent || '');
      },
      null,
      { timeout: 15_000 },
    );
    const globView = await page.evaluate(() => {
      const v = document.getElementById('ws-files-view');
      return {
        title: v ? v.querySelector('strong')?.textContent || '' : '',
        text: v ? v.textContent || '' : '',
      };
    });
    expect(
      globView.title === 'find: src/**/*.ts',
      `the find view is titled ${JSON.stringify(globView.title)}`,
    );
    expect(
      globView.text.includes('1 matches'),
      `the find view reports ${JSON.stringify(globView.text)}`,
    );

    return 'the file browser opened on the advertised tag, listed the root, descended into src and back, read README.md, and found through /glob';
  },
});

PAGE_SCENARIOS.push({
  name: 'P51 the file browser stays shut when the daemon does not advertise it',
  // The counterfactual to P50. Re-running the page's own gating inside that
  // scenario was the obvious way to prove this and is not a safe one: gating
  // also renders the permission-rules panel, which throws on a body whose
  // scope entry carries no rules. Booting a second gateway without the tag
  // proves the same thing without reaching into another panel.
  waitView: false,
  run: async ({ page }) => {
    await page.click('.tab[data-tab="settings"]');
    const state = await page.evaluate(() => {
      const sec = document.getElementById('ws-files');
      return {
        exists: !!sec,
        hidden: !!sec && sec.hidden,
        daemonDaemon: typeof caps === 'undefined' ? 'caps undeclared' : JSON.stringify(caps?.remoteControl?.daemon?.features ?? null),
      };
    });
    expect(state.exists, 'no #ws-files section in the page at all');
    expect(
      state.daemonDaemon === '[]',
      `the stub advertised ${state.daemonDaemon}, so this is not the no-tag case`,
    );
    expect(
      state.hidden,
      '#ws-files was revealed although the daemon advertised no features',
    );
    return 'with no feature tag the panel stays closed and lists nothing, so P50 seeing it open is the tag working';
  },
});
PAGE_SCENARIOS.push({
  name: 'P52 the export button hands the remote a real file, bytes and all',
  // Nothing here needs the transcript view: the footer is drawn by the watch
  // path, so this boots the gateway and watches directly, the shape P50 uses
  // for the other non-chat surfaces.
  waitView: false,
  noConsoleErrors: true,
  run: async ({ page, viewer }) => {
    const asked: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.endsWith('/export')) asked.push(u.pathname + u.search);
    });
    await watch(page, viewer.sessionId);
    await page.waitForFunction(
      () => !!document.getElementById('footer-export'),
      null,
      { timeout: 10_000 },
    );

    // Armed before the click: the save can land while the click is still in
    // flight, and a listener attached afterwards would miss it entirely.
    const armed = page.waitForEvent('download', { timeout: 15_000 });
    await page.click('#footer-export');
    const dl = await armed;

    // The route is format-specific and the page asks for markdown, the form a
    // person pastes somewhere else. A missing query means it took the daemon's
    // default instead, which is a different file.
    expect(
      asked.length === 1 && asked[0].endsWith('/export?format=md'),
      `the page asked ${JSON.stringify(asked)}, not one /export?format=md`,
    );

    // The filename is the DAEMON's, from its Content-Disposition, relayed in
    // the gateway's JSON body. A name invented here would hide a gateway that
    // dropped the field on the way through.
    const short = viewer.sessionId.slice(0, 8);
    expect(
      dl.suggestedFilename() === `session-${short}.md`,
      `saved as ${dl.suggestedFilename()}, not session-${short}.md`,
    );
    const why = await dl.failure();
    expect(why === null, `the browser reported a failed save: ${why?.errorMessage}`);
    const p = await dl.path();
    const text = p ? readFileSync(p, 'utf8') : '';
    expect(
      text === `# session ${short}\n`,
      `the saved file holds ${JSON.stringify(text)}, not the daemon's bytes`,
    );

    // Re-enabled on the way out, so a reader can export again without
    // reloading. Left disabled it is a one-shot control.
    const after = await page.evaluate(() => ({
      disabled: document.getElementById('footer-export')?.disabled === true,
      note: document.getElementById('footer-export-note')?.textContent ?? '',
    }));
    expect(!after.disabled, 'the export button stayed disabled after a success');
    expect(
      after.note === '',
      `a successful export still left a note behind: ${JSON.stringify(after.note)}`,
    );
    return `one click saved ${JSON.stringify(dl.suggestedFilename())} holding ${JSON.stringify(text)}, so a token on a phone can get the conversation out`;
  },
});
PAGE_SCENARIOS.push({
  name: 'P53 a refused export says which reason it was, not just failed',
  // The other half of the export path. The route answers three different
  // failures (a format the daemon rejects, a session the pool dropped, a dead
  // daemon) and the note is the only place a reader learns which one they hit,
  // so a verdict flattened into "failed" is invisible everywhere else.
  waitView: false,
  stub: { exportStatusCode: 404 },
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await page.waitForFunction(
      () => !!document.getElementById('footer-export'),
      null,
      { timeout: 10_000 },
    );
    // A refused export must produce no file at all. Short timeout, because the
    // correct outcome here is the event never arriving.
    let produced = false;
    const armed = page
      .waitForEvent('download', { timeout: 4_000 })
      .then(() => {
        produced = true;
      })
      .catch(() => undefined);
    await page.click('#footer-export');
    const note = await page.waitForFunction(
      () => {
        const n = document.getElementById('footer-export-note');
        return n && n.textContent ? n.textContent : null;
      },
      null,
      { timeout: 10_000 },
    );
    await armed;
    const text = (await note.jsonValue()) as string;
    expect(!produced, 'a refused export still produced a download');
    // The daemon's 404 is a session it cannot load, and the gateway names it
    // session_not_found. Anything vaguer sends the reader hunting for a cause
    // the page already knew.
    expect(
      text.includes('session_not_found'),
      `the note said ${JSON.stringify(text)}, which does not name the reason`,
    );
    return `a refused export reports ${JSON.stringify(text)} rather than a bare failure`;
  },
});
PAGE_SCENARIOS.push({
  name: 'P54 the footer fill is the daemon usage read, not the stream sum',
  // The footer used to draw a running in/out sum off the live stream, which
  // counts what the browser happened to see rather than how full the window
  // is. The stub answers /context-usage with 65536 of a 262144 window, and
  // those two numbers appear nowhere else in the app, so seeing them formatted
  // here can only mean the read was made and parsed.
  waitView: false,
  noConsoleErrors: true,
  run: async ({ page, viewer }) => {
    const asked: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.endsWith('/context-usage')) asked.push(u.pathname);
    });
    await watch(page, viewer.sessionId);
    const fill = await page.waitForFunction(
      () => {
        const f = document.getElementById('session-footer');
        const t = f ? f.textContent ?? '' : '';
        return t.includes('65.5k/262.1k') ? t : null;
      },
      null,
      { timeout: 15_000 },
    );
    expect(
      asked.length >= 1,
      'the page never asked /context-usage, so the fill came from somewhere else',
    );
    const text = (await fill.jsonValue()) as string;
    // The stream-sum shape is "N in / M out". Its absence next to the fill is
    // what shows the read replaced the sum rather than sitting beside it.
    expect(
      !text.includes(' in / '),
      `the footer still carries the stream sum alongside the fill: ${JSON.stringify(text)}`,
    );
    return `the footer reads ${JSON.stringify(text)}, the daemon's 65536/262144 rather than a running sum`;
  },
});
PAGE_SCENARIOS.push({
  name: 'P55 a picked file reaches the daemon and rides with the next prompt',
  // #109: the attachment routes had no path to the UI, so a phone could not
  // put a file into a conversation. The harness hides the stub, so what the
  // page actually sent is read off the wire: the upload's request line and the
  // prompt body it later produced. Two files, because one is enough to prove a
  // POST and only two can prove the page carried EACH answer.
  waitView: false,
  noConsoleErrors: true,
  run: async ({ page, viewer }) => {
    const uploads: {
      path: string;
      search: string;
      type: string;
      status: number;
      json: Promise<unknown>;
    }[] = [];
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (r.request().method() !== 'POST' || !u.pathname.endsWith('/attachments'))
        return;
      uploads.push({
        path: u.pathname,
        search: u.search,
        type: r.request().headers()['content-type'] ?? '',
        status: r.status(),
        json: r.json().catch(() => null),
      });
    });
    await watch(page, viewer.sessionId);
    await page.waitForSelector('#composer', { state: 'visible' });

    await page.setInputFiles('#attach-file', [
      {
        name: 'crash.log',
        mimeType: 'text/plain',
        buffer: Buffer.from('stack trace here'),
      },
      {
        name: 'shot.png',
        mimeType: 'image/png',
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    ]);
    const listed = await page.waitForFunction(
      () => {
        const l = document.getElementById('pending-list');
        const t = l ? (l.textContent ?? '') : '';
        return t.includes('crash.log') && t.includes('shot.png') ? t : null;
      },
      null,
      { timeout: 15_000 },
    );
    // Named on screen, not just held in a variable: a file the reader cannot
    // see is the #70 failure mode all over again.
    const shown = (await listed.jsonValue()) as string;
    expect(
      uploads.length === 2,
      `the page made ${uploads.length} upload requests, not one per file`,
    );
    expect(
      uploads.every((x) => x.path === `/session/${viewer.sessionId}/attachments`),
      `the uploads went to ${JSON.stringify(uploads.map((x) => x.path))}`,
    );
    // The name travels in the query and the bytes carry the file's own media
    // type, which is the contract the gateway forwards to the daemon.
    expect(
      uploads[0].search === '?name=crash.log' &&
        uploads[1].search === '?name=shot.png',
      `the names arrived as ${JSON.stringify(uploads.map((x) => x.search))}`,
    );
    expect(
      uploads[0].type === 'text/plain' && uploads[1].type === 'image/png',
      `the files arrived as ${JSON.stringify(uploads.map((x) => x.type))}, not their own media types`,
    );
    expect(
      uploads.every((x) => x.status === 201),
      `the daemon answered ${JSON.stringify(uploads.map((x) => x.status))}`,
    );
    const answers = await Promise.all(uploads.map((x) => x.json));
    const refs = answers.map((a) => (a as { attachment?: unknown })?.attachment);
    expect(
      shown.includes('crash.log') && shown.includes('shot.png'),
      `the strip reads ${JSON.stringify(shown)}, which does not name both files`,
    );

    await page.fill('#prompt', 'look at these');
    // Armed before the click, because the request can leave while the click is
    // still in flight.
    const sent = page.waitForRequest(
      (r) =>
        r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/prompt'),
      { timeout: 15_000 },
    );
    await page.click('#send');
    const req = await sent;
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
    const blocks = body['blocks'] as Record<string, unknown>[] | undefined;
    expect(
      Array.isArray(blocks),
      `the prompt went as ${req.postData()}, which is not content blocks`,
    );
    expect(
      blocks![0]?.['type'] === 'text' && blocks![0]?.['text'] === 'look at these',
      `the first block is ${JSON.stringify(blocks![0])}, not the typed text`,
    );
    // Each reference is the daemon's answer field for field. This is the whole
    // point of the page holding what came back: a block rebuilt from the File
    // would carry a name and a type the page invented instead.
    expect(
      blocks!.length === 3 &&
        JSON.stringify(blocks[1]) === JSON.stringify(refs[0]) &&
        JSON.stringify(blocks[2]) === JSON.stringify(refs[1]),
      `the prompt carried ${JSON.stringify(blocks)}, not the text plus ${JSON.stringify(refs)}`,
    );
    // The kinds differ per file, and only the store decides that: a png is an
    // image, a log is a resource. Seeing both in one prompt means the page
    // relayed each answer rather than settling on one kind for everything.
    const kinds = refs.map((r) => (r as { type?: unknown })?.type);
    expect(
      kinds[0] === 'resource' && kinds[1] === 'image',
      `the daemon answered ${JSON.stringify(kinds)}, so this proves nothing about the relay`,
    );
    const stillStaged = await page.evaluate(
      () => document.getElementById('pending')?.hidden === true,
    );
    expect(
      stillStaged,
      'the strip still shows both files after they were sent',
    );
    return `two picks reached the daemon as ${JSON.stringify(kinds)} and rode with the prompt unchanged, so a phone can put a file into a conversation`;
  },
});
PAGE_SCENARIOS.push({
  name: 'P56 a prompt with nothing attached keeps its plain shape',
  // P55 only means something if the page did not start sending content blocks
  // for everything. Same page, no file picked: the prompt has to go out in the
  // {prompt} shape it has always had, or the attach path has quietly become the
  // only path.
  waitView: false,
  noConsoleErrors: true,
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await page.waitForSelector('#composer', { state: 'visible' });
    await page.fill('#prompt', 'just a question');
    const sent = page.waitForRequest(
      (r) =>
        r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/prompt'),
      { timeout: 15_000 },
    );
    await page.click('#send');
    const body = JSON.parse((await sent).postData() ?? '{}') as Record<
      string,
      unknown
    >;
    expect(
      body['blocks'] === undefined,
      `the page sent ${JSON.stringify(body)}, which carries blocks it was never given`,
    );
    expect(
      body['prompt'] === 'just a question',
      `the page sent ${JSON.stringify(body)}, not the plain prompt`,
    );
    return `with nothing picked the prompt stays ${JSON.stringify(body)}, so blocks are the attach path rather than the default`;
  },
});
PAGE_SCENARIOS.push({
  name: 'P57 a refused upload says which reason it was, and stages nothing',
  // The other half of the attach path. The route answers several different
  // failures (the byte cap, a daemon without these routes, a dead daemon) and
  // the note is the only place a reader learns which one they hit, so a verdict
  // flattened into "failed" is invisible everywhere else. The stub's own default
  // body says `stub error`, which no daemon ever sends, so the scenario supplies
  // the envelope the real daemon uses.
  waitView: false,
  stub: {
    attachmentUploadStatus: 413,
    attachmentUploadErrorBody: {
      error: 'attachment too large',
      errorKind: 'attachment_too_large',
    },
  },
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await page.waitForSelector('#composer', { state: 'visible' });
    // Armed before the pick. The wait is keyed on the RESPONSE rather than on
    // the first text to appear, because the page writes an "uploading…" line
    // the instant the pick happens: waiting for any text at all matches that
    // line and reads the verdict before the refusal exists.
    const refused = page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith('/attachments'),
      { timeout: 15_000 },
    );
    await page.setInputFiles('#attach-file', {
      name: 'huge.log',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    });
    const res = await refused;
    expect(
      res.status() === 413,
      `the daemon answered ${res.status()}, not the 413 this scenario drives`,
    );
    // Settled on the note CHANGING, which says nothing about its content; what
    // replaced it is asserted below.
    const note = await page.waitForFunction(
      () => {
        const n = document.getElementById('pending-note');
        const t = n ? (n.textContent ?? '') : '';
        return t !== '' && !t.startsWith('uploading') ? t : null;
      },
      null,
      { timeout: 15_000 },
    );
    const text = (await note.jsonValue()) as string;
    expect(
      text.includes('attachment_too_large'),
      `the note said ${JSON.stringify(text)}, which does not name the reason`,
    );
    // Refused means refused: a file the daemon never accepted must not sit on
    // the strip ready to ride with the next prompt.
    const staged = await page.evaluate(
      () => document.getElementById('pending-list')?.textContent ?? '',
    );
    expect(
      staged === '',
      `${JSON.stringify(staged)} was staged even though the daemon refused it`,
    );
    return `a refused upload reports ${JSON.stringify(text)} and stages nothing`;
  },
});
PAGE_SCENARIOS.push({
  name: 'P58 the stored list names what the daemon holds, and only when asked',
  // #125. The pending strip is this page's own memory, so a reload lost the
  // names of files the store still had. Each row here is the store's reference
  // (packages/acp-bridge/src/sessionAttachments.ts:840-846), where the name IS
  // `attachmentId` and there is no `name` field to read: a page written against
  // `name` shows blanks on a device and passes on this machine. Two entries,
  // because one proves a row exists and only two can prove the page read EACH
  // answer rather than the first.
  waitView: false,
  noConsoleErrors: true,
  stub: {
    attachmentListResult: {
      attachments: [
        {
          type: 'resource',
          attachmentId: 'crash.log',
          mimeType: 'text/plain',
          size: 2048,
        },
        {
          type: 'image',
          attachmentId: 'shot.png',
          mimeType: 'image/png',
          size: 3 * 1024 * 1024,
        },
      ],
    },
  },
  run: async ({ page, viewer }) => {
    const lists: string[] = [];
    page.on('request', (r) => {
      if (
        new URL(r.url()).pathname === `/session/${viewer.sessionId}/attachments`
      )
        lists.push(r.method());
    });
    await watch(page, viewer.sessionId);
    await page.waitForSelector('#composer', { state: 'visible' });
    // Nothing fetched just for watching. The names are the daemon's answer, and
    // polling it on every session would pay a round trip nobody asked for.
    expect(
      lists.length === 0,
      `watching alone fetched the list ${lists.length} times before anyone asked`,
    );
    const closed = await page.evaluate(
      () => document.getElementById('stored')?.hidden === true,
    );
    expect(closed, 'the stored panel was open before it was asked for');

    const answered = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/session/${viewer.sessionId}/attachments`,
      { timeout: 15_000 },
    );
    await page.click('#stored-toggle');
    const res = await answered;
    expect(
      res.status() === 200,
      `the gateway answered the list with ${res.status()}`,
    );
    const shown = await page.waitForFunction(
      () => {
        const l = document.getElementById('stored-list');
        const t = l ? (l.textContent ?? '') : '';
        return t.includes('crash.log') && t.includes('shot.png') ? t : null;
      },
      null,
      { timeout: 15_000 },
    );
    const text = (await shown.jsonValue()) as string;
    // The row is the reference's own fields, formatted: 2048 bytes reads 2.0 KB
    // and 3 MiB reads 3.0 MB, and the kind is the store's, which differs per
    // file. Reading `name` instead would render `undefined (undefined B,
    // undefined)` and still satisfy a looser assertion.
    expect(
      text.includes('crash.log (2.0 KB, resource)') &&
        text.includes('shot.png (3.0 MB, image)'),
      `the list reads ${JSON.stringify(text)}, which is not each reference's own fields`,
    );
    const note = await page.evaluate(
      () => document.getElementById('stored-note')?.textContent ?? '',
    );
    expect(
      note === '',
      `the note said ${JSON.stringify(note)} for a list that succeeded`,
    );
    const expanded = await page.evaluate(() =>
      document.getElementById('stored-toggle')?.getAttribute('aria-expanded'),
    );
    expect(
      expanded === 'true',
      `the toggle reports aria-expanded=${JSON.stringify(expanded)} while open`,
    );
    expect(
      lists.length === 1,
      `one open fetched the list ${lists.length} times, not once`,
    );
    return `the panel reads ${JSON.stringify(text)} off the store's own fields, fetched once on open`;
  },
});
PAGE_SCENARIOS.push({
  name: 'P59 removing a stored file asks once, then sends exactly one delete',
  // #125. The house pattern for a destructive control is window.confirm
  // (public/index.html:11284 and :11405), but this verifier dismisses every
  // dialog unconditionally, so a confirm gate could never be driven here, and a
  // control nobody can drive is a control nobody can show works. The row arms on
  // the first press instead, which is provable: nothing leaves on press one and
  // exactly one DELETE leaves on press two.
  waitView: false,
  noConsoleErrors: true,
  stub: {
    attachmentListResult: {
      attachments: [
        {
          type: 'resource',
          attachmentId: 'crash.log',
          mimeType: 'text/plain',
          size: 2048,
        },
      ],
    },
  },
  run: async ({ page, viewer }) => {
    const deletes: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'DELETE') deletes.push(new URL(r.url()).pathname);
    });
    await watch(page, viewer.sessionId);
    await page.waitForSelector('#composer', { state: 'visible' });
    await page.click('#stored-toggle');
    await page.waitForFunction(
      () =>
        (document.getElementById('stored-list')?.textContent ?? '').includes(
          'crash.log',
        ),
      null,
      { timeout: 15_000 },
    );
    // Located by label, not by position. The row gained an Open control when
    // stored files became readable, so "> button" named whichever control
    // happened to be first rather than the destructive one.
    const press = (want: string) =>
      page.evaluate((label) => {
        const line = document.getElementById('stored-list')?.firstElementChild;
        if (!line) return false;
        const btn = Array.from(line.querySelectorAll('button')).find(
          (b) => (b.textContent ?? '') === label,
        );
        if (!btn) return false;
        (btn as HTMLButtonElement).click();
        return true;
      }, want);
    expect(await press('Remove'), 'the stored row has no Remove control');
    // Waited on the LABEL rather than a request, because press one must produce
    // no request at all, so the only thing to wait for is the re-render.
    const armed = await page.waitForFunction(
      () => {
        const line = document.getElementById('stored-list')?.firstElementChild;
        if (!line) return null;
        const b = Array.from(line.querySelectorAll('button')).find(
          (x) => (x.textContent ?? '') === 'Confirm remove',
        );
        return b ? b.textContent : null;
      },
      null,
      { timeout: 15_000 },
    );
    const armedText = (await armed.jsonValue()) as string;
    expect(
      armedText === 'Confirm remove',
      `the first press left the button reading ${JSON.stringify(armedText)}`,
    );
    expect(
      deletes.length === 0,
      `the first press sent ${JSON.stringify(deletes)}; an armed button sends nothing`,
    );
    expect(
      await press('Confirm remove'),
      'the armed row lost its confirm control before press two',
    );
    const gone = await page.waitForFunction(
      () => {
        const l = document.getElementById('stored-list');
        return l && !(l.textContent ?? '').includes('crash.log') ? 'gone' : null;
      },
      null,
      { timeout: 15_000 },
    );
    expect(
      (await gone.jsonValue()) === 'gone',
      'the row was still listed after the delete was answered',
    );
    expect(
      deletes.length === 1 &&
        deletes[0] === `/session/${viewer.sessionId}/attachments/crash.log`,
      `the page sent ${JSON.stringify(deletes)}, not one delete naming the attachmentId`,
    );
    const note = await page.evaluate(
      () => document.getElementById('stored-note')?.textContent ?? '',
    );
    expect(
      note === '',
      `the note said ${JSON.stringify(note)} after a delete the daemon confirmed`,
    );
    return `press one armed the row and sent nothing, press two sent ${JSON.stringify(deletes)} and dropped it`;
  },
});
PAGE_SCENARIOS.push({
  name: 'P60 a refused stored list says which reason it was, and shows nothing',
  // The other half of the read path. A daemon that predates these routes
  // answers the list with a bare 404, which the route maps to 502
  // attachments_unsupported (src/routes/sessionAttachments.ts:106-113). This
  // scenario drives only the daemon's status and no body, so the code that
  // reaches the screen is the gateway's own verdict, not one composed here.
  waitView: false,
  stub: { attachmentListStatus: 404 },
  run: async ({ page, viewer }) => {
    await watch(page, viewer.sessionId);
    await page.waitForSelector('#composer', { state: 'visible' });
    const answered = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/session/${viewer.sessionId}/attachments`,
      { timeout: 15_000 },
    );
    await page.click('#stored-toggle');
    const res = await answered;
    expect(
      res.status() === 502,
      `the gateway answered ${res.status()}, not the 502 a daemon without these routes earns`,
    );
    const note = await page.waitForFunction(
      () => {
        const n = document.getElementById('stored-note');
        const t = n ? (n.textContent ?? '') : '';
        return t !== '' ? t : null;
      },
      null,
      { timeout: 15_000 },
    );
    const text = (await note.jsonValue()) as string;
    expect(
      text.includes('attachments_unsupported'),
      `the note said ${JSON.stringify(text)}, which does not name the reason`,
    );
    const listed = await page.evaluate(
      () => document.getElementById('stored-list')?.textContent ?? '',
    );
    expect(
      listed === '',
      `${JSON.stringify(listed)} was listed even though the daemon refused`,
    );
    return `a refused list reports ${JSON.stringify(text)} and lists nothing`;
  },
});
{
  // P61. The list is fetched when the panel opens, and a switch made while that
  // request is in flight painted the conversation the reader had just left:
  // loadStored reads watchedSessionId to build the URL, then wrote storedFiles
  // after the await, and syncStoredForSession cannot cancel a request already
  // sent. Two sessions answering differently, because one answer cannot show
  // WHICH conversation painted. This is the test the guard exists for; remove
  // the watchedSessionId checks in loadStored and it goes red on the release.
  let releaseHeldList = () => {};
  const heldList = new Promise<void>((resolve) => {
    releaseHeldList = () => resolve();
  });
  PAGE_SCENARIOS.push({
    name: 'P61 a stored list that lands after a switch names the conversation on screen',
    waitView: false,
    run: async ({ page, viewer }) => {
      const A = viewer.sessionId;
      const B = '22222222-3333-4444-5555-666666666666';
      let askedA = false;
      await page.route(/\/session\/[^/]+\/attachments$/, async (route) => {
        const sid = new URL(route.request().url()).pathname.split('/')[2];
        const name = sid === A ? 'from-a.log' : 'from-b.log';
        if (sid === A) {
          askedA = true;
          await heldList;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            attachments: [
              {
                type: 'resource',
                attachmentId: name,
                mimeType: 'text/plain',
                size: 12,
              },
            ],
          }),
        });
      });

      await watch(page, A);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.click('#stored-toggle');
      // The window the guard has to survive: A's request is on the wire and
      // unanswered. Polling the flag rather than sleeping, so a slow machine
      // cannot fall through before the request exists.
      const deadline = Date.now() + 10_000;
      while (!askedA && Date.now() < deadline) await page.waitForTimeout(50);
      expect(askedA, 'opening the panel never asked the daemon for the list');

      await watch(page, B);
      const shown = await page.waitForFunction(
        () => {
          const l = document.getElementById('stored-list');
          const t = l ? (l.textContent ?? '') : '';
          return t.includes('from-b.log') ? t : null;
        },
        null,
        { timeout: 15_000 },
      );
      const onScreen = (await shown.jsonValue()) as string;

      releaseHeldList();
      // A's answer is on the wire now; give it the turn it needs to arrive.
      await page.waitForTimeout(500);
      const after = await page.evaluate(
        () => document.getElementById('stored-list')?.textContent ?? '',
      );
      expect(
        !after.includes('from-a.log'),
        `the list for the conversation just left painted it under the one on screen (${JSON.stringify(after)})`,
      );
      expect(
        after.includes('from-b.log'),
        `the conversation on screen lost its own rows (${JSON.stringify(after)})`,
      );
      return `a list released after the switch is dropped, the panel still reads ${JSON.stringify(after)} against ${JSON.stringify(onScreen)}`;
    },
  });

  // The recap sentence is the daemon's own summary of the conversation, so the
  // scenarios below intercept the route and answer with a sentence this file
  // chose. Asserting a substring the stub invented would pass even if the page
  // had asked about a different conversation entirely.
  const RECAP_SENTENCE =
    'moved the anodising line to Tuesdays after the vendor reply';

  PAGE_SCENARIOS.push({
    name: 'P62 the recap control shows the daemon sentence for the conversation on screen',
    waitView: false,
    stub: { capabilitiesFeatures: ['session_recap'] },
    run: async ({ page, viewer }) => {
      const A = viewer.sessionId;
      let asked = null;
      await page.route(/\/session\/[^/]+\/recap$/, async (route) => {
        asked = new URL(route.request().url()).pathname.split('/')[2];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sessionId: asked, recap: RECAP_SENTENCE }),
        });
      });

      await watch(page, A);
      await page.waitForSelector('#composer', { state: 'visible' });
      // The control is markup from boot and stays hidden until the daemon's own
      // feature list says it can answer, so becoming visible is the gate firing.
      await page.waitForSelector('#recap-toggle', { state: 'visible' });

      // Before the press the box must cost nothing. A control that carries
      // layout height when nobody asked for it is what pushed the composer
      // under the fold on a phone (#65), so this is the claim being guarded.
      const before = await page.evaluate(() => {
        const el = document.getElementById('recap');
        return el ? { hidden: el.hidden, height: el.offsetHeight } : null;
      });
      expect(before !== null, 'the recap box is missing from the page');
      expect(
        before?.hidden === true && before?.height === 0,
        `the recap box already costs layout height before anyone asked (${JSON.stringify(before)})`,
      );

      await page.click('#recap-toggle');
      const shown = await page.waitForFunction(
        (needle) => {
          const el = document.getElementById('recap');
          const t = el ? (el.textContent ?? '') : '';
          return t.includes(needle) ? t : null;
        },
        RECAP_SENTENCE,
        { timeout: 15_000 },
      );
      const onScreen = (await shown.jsonValue()) as string;

      expect(
        asked === A,
        `the page asked for a recap of ${JSON.stringify(asked)} while watching ${JSON.stringify(A)}`,
      );
      // Bounded on purpose: the box scrolls rather than growing, because a
      // summary that grows is the failure this page has already been filed for.
      const height = await page.evaluate(
        () => document.getElementById('recap')?.offsetHeight ?? -1,
      );
      expect(
        height > 0 && height <= 160,
        `the open recap box is not bounded (${height} px)`,
      );
      return `the summary is asked for the watched conversation and reads ${JSON.stringify(onScreen)} in a ${height}px box`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P63 a daemon that cannot summarise is offered no button that could only fail',
    waitView: false,
    run: async ({ page, viewer }) => {
      let asked = 0;
      await page.route(/\/session\/[^/]+\/recap$/, async (route) => {
        asked += 1;
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Not Found' }),
        });
      });

      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      // The harness advertises no daemon features here, which is the state of a
      // daemon from before this route existed.
      const offered = await page.evaluate(() => {
        const b = document.getElementById('recap-toggle');
        return b ? { present: true, hidden: b.hidden } : { present: false };
      });
      expect(
        offered.present === true && offered.hidden === true,
        `the page showed a recap control to a daemon that has no recap route (${JSON.stringify(offered)})`,
      );
      expect(
        asked === 0,
        'a control that is not on screen still asked the daemon for a summary',
      );
      return `with no session_recap tag the control stays hidden (${JSON.stringify(offered)}) and nothing was asked`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P64 a daemon with nothing to say is reported as having nothing to say',
    waitView: false,
    stub: { capabilitiesFeatures: ['session_recap'] },
    run: async ({ page, viewer }) => {
      await page.route(/\/session\/[^/]+\/recap$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sessionId: viewer.sessionId, recap: null }),
        });
      });

      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.waitForSelector('#recap-toggle', { state: 'visible' });
      await page.click('#recap-toggle');
      const filled = await page.waitForFunction(
        () => {
          const el = document.getElementById('recap');
          const t = el ? (el.textContent ?? '') : '';
          // "asking..." is the loader's own placeholder and is non-empty, so
          // waiting on length alone would settle on it before the answer.
          return t.length > 0 && !t.includes('asking') ? t : null;
        },
        null,
        { timeout: 15_000 },
      );
      const onScreen = (await filled.jsonValue()) as string;
      // `recap: null` is a 200 that means "not yet", so the page must not dress
      // it as a refusal. A reader told it failed goes looking for a bug that
      // does not exist, on a conversation that simply has not done anything.
      expect(
        !/refused|failed|error/i.test(onScreen),
        `a null recap was reported as a failure (${JSON.stringify(onScreen)})`,
      );
      expect(
        /nothing/i.test(onScreen),
        `a null recap said nothing about there being nothing to say (${JSON.stringify(onScreen)})`,
      );
      return `a null recap reads ${JSON.stringify(onScreen)} rather than a refusal`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P65 a daemon that 404s the recap is named as too old, not as a missing conversation',
    waitView: false,
    stub: { capabilitiesFeatures: ['session_recap'] },
    run: async ({ page, viewer }) => {
      // The capability tag says the route exists and the daemon still 404s: the
      // state a gateway reaches when the capabilities it advertises are ahead of
      // the daemon it is now talking to.
      await page.route(/\/session\/[^/]+\/recap$/, async (route) => {
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Daemon does not support session recaps',
            code: 'recap_unsupported',
          }),
        });
      });

      await watch(page, viewer.sessionId);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.waitForSelector('#recap-toggle', { state: 'visible' });
      await page.click('#recap-toggle');
      const filled = await page.waitForFunction(
        () => {
          const el = document.getElementById('recap');
          const t = el ? (el.textContent ?? '') : '';
          // "asking..." is the loader's own placeholder and is non-empty, so
          // waiting on length alone would settle on it before the answer.
          return t.length > 0 && !t.includes('asking') ? t : null;
        },
        null,
        { timeout: 15_000 },
      );
      const onScreen = (await filled.jsonValue()) as string;
      // The gateway maps a bare 404 to recap_unsupported precisely so nobody is
      // sent looking for a conversation that is still there. The page has to
      // keep that distinction rather than flattening it back into "not found".
      expect(
        !/not_found|not found|no such/i.test(onScreen),
        `an old daemon was reported as a missing conversation (${JSON.stringify(onScreen)})`,
      );
      expect(
        /cannot|support|yet/i.test(onScreen),
        `an old daemon was not named as the cause (${JSON.stringify(onScreen)})`,
      );
      return `a 404 on the recap route reads ${JSON.stringify(onScreen)}`;
    },
  });

  // #125's content read. The gateway mount exists at server.ts:973 and had no
  // caller, so these scenarios are what make it a feature rather than a route.
  // Intercepted rather than driven through the stub options because the read
  // answers per FILE, and a stub option would have to grow a second knob to
  // name one. P61 and P62 established the technique.
  // A real 1x1 PNG, so the browser can actually decode it: an <img> that fails
  // to load would still satisfy a src assertion.
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const FILE_BODY = 'EXECUTE-MARKER-42 the file body';

  const storedListRoute = (
    page: Page,
    entries: Array<{ id: string; mime: string }>,
  ) =>
    page.route(/\/session\/[^/]+\/attachments$/, async (route) => {
      const sid = new URL(route.request().url()).pathname.split('/')[2];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          attachments: entries.map((e) => ({
            type: 'resource',
            attachmentId: e.id,
            mimeType: e.mime,
            size: 64,
            sessionId: sid,
          })),
        }),
      });
    });

  async function openStoredRow(page: Page, name: string): Promise<void> {
    const clicked = await page.evaluate((needle) => {
      const list = document.getElementById('stored-list');
      if (!list) return false;
      for (const row of Array.from(list.children)) {
        if (!(row.textContent ?? '').includes(needle)) continue;
        const btn = Array.from(row.querySelectorAll('button')).find(
          (b) => (b.textContent ?? '') === 'Open',
        );
        if (!btn) return false;
        (btn as HTMLButtonElement).click();
        return true;
      }
      return false;
    }, name);
    expect(clicked, `the stored row for ${JSON.stringify(name)} has no Open control`);
  }

  PAGE_SCENARIOS.push({
    name: 'P66 opening a stored image draws it inside the bounded panel',
    waitView: false,
    run: async ({ page, viewer }) => {
      const A = viewer.sessionId;
      let askedSession: string | null = null;
      let askedFile: string | null = null;
      await storedListRoute(page, [{ id: 'plate.png', mime: 'image/png' }]);
      await page.route(/\/session\/[^/]+\/attachments\/[^/]+$/, async (route) => {
        const parts = new URL(route.request().url()).pathname.split('/');
        askedSession = parts[2];
        askedFile = decodeURIComponent(parts[4]);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: PNG_B64, mimeType: 'image/png' }),
        });
      });

      await watch(page, A);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.click('#stored-toggle');
      await page.waitForFunction(
        () => (document.getElementById('stored-list')?.textContent ?? '').includes('plate.png'),
        null,
        { timeout: 15_000 },
      );
      // Before the press the panel must not already be showing a file: an
      // eager content read is a round trip nobody asked for.
      const before = await page.evaluate(() => {
        const el = document.getElementById('stored-preview');
        return el ? { hidden: el.hidden, height: el.offsetHeight } : null;
      });
      expect(before !== null, 'the stored preview box is missing from the page');
      expect(
        before?.hidden === true && before?.height === 0,
        `a file is already drawn before anyone opened it (${JSON.stringify(before)})`,
      );

      await openStoredRow(page, 'plate.png');
      const shown = await page.waitForFunction(
        () => {
          const box = document.getElementById('stored-preview');
          const img = box ? box.querySelector('img') : null;
          return img ? { src: img.getAttribute('src') ?? '', alt: img.alt } : null;
        },
        null,
        { timeout: 15_000 },
      );
      const onScreen = (await shown.jsonValue()) as { src: string; alt: string };

      expect(
        askedSession === A,
        `the page read an attachment of ${JSON.stringify(askedSession)} while watching ${JSON.stringify(A)}`,
      );
      expect(
        askedFile === 'plate.png',
        `the page read ${JSON.stringify(askedFile)} after Open was pressed on ${JSON.stringify('plate.png')}`,
      );
      // A blob URL rather than a data URI: the route answers base64 and the
      // page decodes it once, which is what keeps an 8 MiB file out of the DOM.
      expect(
        onScreen.src.startsWith('blob:'),
        `the preview is not a decoded object URL (${JSON.stringify(onScreen)})`,
      );
      // The claim this page was filed for: an open panel that grows pushed the
      // composer under the fold on a phone. The preview lives INSIDE the box
      // that is already capped, so the cap has to hold with a file drawn.
      // A measured height on its own is a weak claim, and was: one row plus a
      // 1x1 image sits at 53px and clears any ceiling, so the panel passed with
      // its cap deleted. What makes an open file unable to grow the composer
      // row is the computed pair below, so assert that and not a number small
      // content always beats.
      const shape = await page.evaluate(() => {
        const el = document.getElementById('stored');
        if (!el) return null;
        const css = window.getComputedStyle(el);
        return {
          height: el.offsetHeight,
          maxHeight: css.maxHeight,
          overflowY: css.overflowY,
        };
      });
      expect(shape !== null, 'the stored panel is missing from the page');
      expect(
        shape !== null && shape.maxHeight !== 'none',
        `the panel carries no height cap, so an open file grows it (${JSON.stringify(shape)})`,
      );
      expect(
        shape !== null && (shape.overflowY === 'auto' || shape.overflowY === 'scroll'),
        `the panel cannot scroll its own overflow (${JSON.stringify(shape)})`,
      );
      expect(
        shape !== null && shape.height > 0 && shape.height <= 160,
        `the panel with a file open is not bounded (${JSON.stringify(shape)})`,
      );
      return `an image opens as ${JSON.stringify(onScreen.src.slice(0, 12))}... inside a ${shape?.height}px capped panel (${shape?.maxHeight}, ${shape?.overflowY})`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P67 a stored non-image is offered as a file, never injected',
    waitView: false,
    run: async ({ page, viewer }) => {
      const A = viewer.sessionId;
      await storedListRoute(page, [{ id: 'notes.txt', mime: 'text/plain' }]);
      await page.route(/\/session\/[^/]+\/attachments\/[^/]+$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: Buffer.from(FILE_BODY, 'utf8').toString('base64'),
            mimeType: 'text/plain',
          }),
        });
      });

      await watch(page, A);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.click('#stored-toggle');
      await page.waitForFunction(
        () => (document.getElementById('stored-list')?.textContent ?? '').includes('notes.txt'),
        null,
        { timeout: 15_000 },
      );
      await openStoredRow(page, 'notes.txt');
      const shown = await page.waitForFunction(
        () => {
          const box = document.getElementById('stored-preview');
          const a = box ? box.querySelector('a') : null;
          return a
            ? { download: a.getAttribute('download') ?? '', href: a.getAttribute('href') ?? '' }
            : null;
        },
        null,
        { timeout: 15_000 },
      );
      const link = (await shown.jsonValue()) as { download: string; href: string };

      expect(
        link.download === 'notes.txt',
        `the download is not named for the file it came from (${JSON.stringify(link)})`,
      );
      expect(
        link.href.startsWith('blob:'),
        `the download is not a decoded object URL (${JSON.stringify(link)})`,
      );
      // The bytes stay out of the document. Only an image is drawn, and this is
      // the assertion that would catch a page that rendered text or HTML
      // straight from the store.
      const body = await page.evaluate(() => ({
        imgs: document.querySelectorAll('#stored-preview img').length,
        text: document.body.innerText,
      }));
      expect(
        body.imgs === 0,
        `a text file was drawn as an image (${JSON.stringify(body)})`,
      );
      expect(
        !body.text.includes(FILE_BODY),
        'the stored bytes were injected into the document rather than offered as a file',
      );
      return `a text file is offered as ${JSON.stringify(link.download)} with its bytes kept out of the document`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P68 a stored file that lands after a switch is not drawn',
    waitView: false,
    run: async ({ page, viewer }) => {
      const A = viewer.sessionId;
      const B = '22222222-3333-4444-5555-666666666666';
      let releaseHeldRead = () => {};
      const heldRead = new Promise<void>((resolve) => {
        releaseHeldRead = () => resolve();
      });
      let heldForA = false;
      await storedListRoute(page, [{ id: 'plate.png', mime: 'image/png' }]);
      await page.route(/\/session\/[^/]+\/attachments\/[^/]+$/, async (route) => {
        const parts = new URL(route.request().url()).pathname.split('/');
        if (parts[2] === A) {
          heldForA = true;
          await heldRead;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: PNG_B64, mimeType: 'image/png' }),
        });
      });

      await watch(page, A);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.click('#stored-toggle');
      await page.waitForFunction(
        () => (document.getElementById('stored-list')?.textContent ?? '').includes('plate.png'),
        null,
        { timeout: 15_000 },
      );
      await openStoredRow(page, 'plate.png');
      const deadline = Date.now() + 10_000;
      while (!heldForA && Date.now() < deadline) await page.waitForTimeout(50);
      expect(heldForA, 'pressing Open never asked the daemon for the file');

      await watch(page, B);
      releaseHeldRead();
      // The answer is on the wire now; give it the turn it needs to arrive.
      await page.waitForTimeout(750);
      const after = await page.evaluate(() => {
        const box = document.getElementById('stored-preview');
        return box
          ? { hidden: box.hidden, imgs: box.querySelectorAll('img').length }
          : null;
      });
      expect(after !== null, 'the stored preview box is missing from the page');
      expect(
        after?.hidden === true && after?.imgs === 0,
        `a file read against the conversation just left was drawn under the one on screen (${JSON.stringify(after)})`,
      );
      return `a read released after the switch is dropped (${JSON.stringify(after)})`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P69 a stored file the gateway refuses is named, not drawn broken',
    waitView: false,
    run: async ({ page, viewer }) => {
      const A = viewer.sessionId;
      await storedListRoute(page, [{ id: 'secret.dat', mime: 'application/octet-stream' }]);
      await page.route(/\/session\/[^/]+\/attachments\/[^/]+$/, async (route) => {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'insufficient_scope' }),
        });
      });

      await watch(page, A);
      await page.waitForSelector('#composer', { state: 'visible' });
      await page.click('#stored-toggle');
      await page.waitForFunction(
        () => (document.getElementById('stored-list')?.textContent ?? '').includes('secret.dat'),
        null,
        { timeout: 15_000 },
      );
      await openStoredRow(page, 'secret.dat');
      const shown = await page.waitForFunction(
        () => {
          const box = document.getElementById('stored-preview');
          const t = box && !box.hidden ? (box.textContent ?? '') : '';
          return t.includes('insufficient_scope') ? t : null;
        },
        null,
        { timeout: 15_000 },
      );
      const onScreen = (await shown.jsonValue()) as string;
      const shape = await page.evaluate(() => {
        const box = document.getElementById('stored-preview');
        return {
          imgs: box ? box.querySelectorAll('img').length : -1,
          links: box ? box.querySelectorAll('a').length : -1,
        };
      });
      expect(
        shape.imgs === 0 && shape.links === 0,
        `a refused read still drew a preview (${JSON.stringify(shape)})`,
      );
      expect(
        !/cannot reach the gateway/i.test(onScreen),
        `a refusal was reported as the gateway being unreachable (${JSON.stringify(onScreen)})`,
      );
      return `a refused read reads ${JSON.stringify(onScreen)} with no preview drawn`;
    },
  });

  // ---- issue #110: pricing the nested subagent row ------------------------
  // No scenario on either side had ever drawn a nested subagent block, so the
  // stop control shipped earlier in this line arrived unproven too. Two frame
  // rules decide whether these scenarios exercise the real path: the child
  // marker rides on the UPDATE's own _meta (index.html:5829), not the frame
  // ENVELOPE that Frames.upd's second argument stamps, and the parent
  // tool_call has to precede its children or the model drops them outright
  // (transcript-model.js:278).
  const subagentFrames = (settle: boolean): Frame[] => {
    const f = new Frames();
    f.user('go');
    f.toolCall('tc-1', 'Agent', 'in_progress');
    f.upd({
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'reading rc-gateway routes' },
      _meta: { parentToolCallId: 'tc-1', subagentType: 'Explore' },
    });
    if (settle) f.done();
    return f.list;
  };

  const subagentInspectRoute = (
    page: Page,
    status: number,
    body: unknown,
    asked: { session: string | null; ref: string | null },
  ) =>
    page.route(/\/session\/[^/]+\/subagents\/[^/]+$/, async (route) => {
      const parts = new URL(route.request().url()).pathname.split('/');
      asked.session = parts[2];
      asked.ref = decodeURIComponent(parts[4]);
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

  const subagentRow = (page: Page) =>
    page.evaluate(() => {
      const note = document.querySelector('.subagent-cost-note');
      const cost = document.querySelector('.subagent-cost') as
        | HTMLButtonElement
        | null;
      const cancel = document.querySelector('.subagent-cancel') as
        | HTMLButtonElement
        | null;
      return {
        note: note ? (note.textContent ?? '') : null,
        costHidden: cost ? cost.hidden : null,
        cancelHidden: cancel ? cancel.hidden : null,
      };
    });

  const pressCost = (page: Page) =>
    page.evaluate(() => {
      const btn = document.querySelector('.subagent-cost') as
        | HTMLButtonElement
        | null;
      if (!btn || btn.hidden) return false;
      btn.click();
      return true;
    });

  // Waits for the read to leave its in-flight text.
  const settledCostNote = async (page: Page): Promise<string> => {
    const h = await page.waitForFunction(
      () => {
        const el = document.querySelector('.subagent-cost-note');
        const t = el ? (el.textContent ?? '') : '';
        return t && !t.includes('reading') ? t : null;
      },
      null,
      { timeout: 15_000 },
    );
    return (await h.jsonValue()) as string;
  };

  PAGE_SCENARIOS.push({
    name: 'P70 a subagent row is priced by the parent tool reference, not its own id',
    frames: () => subagentFrames(false),
    run: async ({ page, viewer }) => {
      const asked = { session: null as string | null, ref: null as string | null };
      await subagentInspectRoute(
        page,
        200,
        {
          sessionId: 'sub-1',
          taskId: 'task-1',
          title: 'Explore the reconnect path',
          status: 'running',
          durationMs: 6000,
          totalTokens: 1234,
          inputTokens: 1000,
          outputTokens: 234,
        },
        asked,
      );
      await watch(page, viewer.sessionId);
      await page.waitForSelector('.subagent-cost', { state: 'visible' });
      // Nothing is asked before the press: a row that polled would fire one
      // request per subagent on every transcript.
      const before = await subagentRow(page);
      expect(
        before.note === '' && asked.session === null,
        `a cost was drawn before anyone asked (${JSON.stringify({ before, asked })})`,
      );
      expect(
        (await pressCost(page)) === true,
        'the cost control is not pressable on a running subagent',
      );
      const note = await settledCostNote(page);
      expect(
        asked.session === viewer.sessionId,
        `the cost of ${JSON.stringify(asked.session)} was read while watching ${JSON.stringify(viewer.sessionId)}`,
      );
      // The load-bearing half: the daemon resolves a subagent by its PARENT
      // Agent tool's toolUseId, so sending the row's own id 404s in production.
      expect(
        asked.ref === 'tc-1',
        `the read sent ${JSON.stringify(asked.ref)} rather than the parent Agent tool's reference`,
      );
      expect(
        note.includes('1.2k tok'),
        `the daemon's 1234 tokens did not reach the row (${JSON.stringify(note)})`,
      );
      return `a running subagent reads ${JSON.stringify(note)} from ${JSON.stringify(asked.ref)} of ${JSON.stringify(asked.session)}`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P71 a subagent the daemon gives no usage for is not drawn as costing nothing',
    frames: () => subagentFrames(false),
    run: async ({ page, viewer }) => {
      await subagentInspectRoute(
        page,
        200,
        {
          sessionId: 'sub-1',
          taskId: 'task-1',
          title: 'Explore the reconnect path',
          status: 'running',
          durationMs: 6000,
        },
        { session: null, ref: null },
      );
      await watch(page, viewer.sessionId);
      await page.waitForSelector('.subagent-cost', { state: 'visible' });
      await pressCost(page);
      const note = await settledCostNote(page);
      expect(
        /named no usage/i.test(note),
        `a resolution with no usage read ${JSON.stringify(note)}`,
      );
      // 0 is a number nobody reported, and a reader cannot tell it apart from
      // a run that genuinely cost nothing.
      expect(
        !/\d/.test(note),
        `an unreported cost was drawn as a number (${JSON.stringify(note)})`,
      );
      return `a subagent with no reported usage reads ${JSON.stringify(note)}`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P72 a refused subagent cost read names the reason, not the gateway being down',
    frames: () => subagentFrames(false),
    run: async ({ page, viewer }) => {
      await subagentInspectRoute(
        page,
        404,
        // Verbatim from the route (src/routes/subagentInspect.ts:48): the code
        // rides at the TOP level, which is the one field rcCall lifts off an
        // error body. A nested fixture here would test a shape the gateway
        // never sends.
        { error: 'Subagent not found in this session', code: 'subagent_not_found' },
        { session: null, ref: null },
      );
      await watch(page, viewer.sessionId);
      await page.waitForSelector('.subagent-cost', { state: 'visible' });
      await pressCost(page);
      const note = await settledCostNote(page);
      expect(
        note.includes('subagent_not_found'),
        `a refusal read ${JSON.stringify(note)} instead of naming its code`,
      );
      expect(
        !/cannot reach|unreachable|offline/i.test(note),
        `a refusal was reported as the gateway being unreachable (${JSON.stringify(note)})`,
      );
      return `a refused cost read says ${JSON.stringify(note)}`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P73 a settled subagent keeps its price and loses its stop',
    frames: () => subagentFrames(true),
    run: async ({ page, viewer }) => {
      await subagentInspectRoute(
        page,
        200,
        {
          sessionId: 'sub-1',
          taskId: 'task-1',
          title: 'Explore the reconnect path',
          status: 'completed',
          durationMs: 6000,
          totalTokens: 1234,
        },
        { session: null, ref: null },
      );
      await watch(page, viewer.sessionId);
      await page.waitForFunction(
        () => {
          const c = document.querySelector('.subagent-cancel') as
            | HTMLButtonElement
            | null;
          return c ? c.hidden : null;
        },
        null,
        { timeout: 15_000 },
      );
      const row = await subagentRow(page);
      // The asymmetry, on purpose: stopping a finished run is meaningless, so
      // its control goes away, while a finished run's COST is the number a
      // reader actually wants and never changes.
      expect(
        row.costHidden === false,
        `a settled subagent lost its cost control (${JSON.stringify(row)})`,
      );
      await pressCost(page);
      const note = await settledCostNote(page);
      expect(
        note.includes('1.2k tok'),
        `a settled subagent could not be priced (${JSON.stringify(note)})`,
      );
      return `a settled subagent still reads ${JSON.stringify(note)} with its stop withdrawn`;
    },
  });

  // #110: the visible queue. The page is the first consumer these routes ever
  // had, so these scenarios are what proves a caller exists, not the route
  // being mounted.
  const queueListRoute = (
    page: Page,
    body: unknown,
    asked: { session: string | null },
  ) =>
    page.route(/\/session\/[^/]+\/pending-prompts$/, async (route) => {
      const parts = new URL(route.request().url()).pathname.split('/');
      asked.session = parts[2];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

  // Anchored on the trailing segment so it cannot swallow the list request.
  const queueDropRoute = (
    page: Page,
    status: number,
    body: unknown,
    asked: { session: string | null; promptId: string | null },
  ) =>
    page.route(/\/session\/[^/]+\/pending-prompts\/[^/]+$/, async (route) => {
      const parts = new URL(route.request().url()).pathname.split('/');
      asked.session = parts[2];
      asked.promptId = decodeURIComponent(parts[4]);
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

  const queuedBody = (page: Page) =>
    page.evaluate(
      () =>
        (document.getElementById('prompt-queue-body') as HTMLElement)
          .textContent ?? '',
    );

  const queueRows = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('#prompt-queue-body > div')).map(
        (d) => d.textContent ?? '',
      ),
    );

  const pressQueueList = async (page: Page): Promise<string> => {
    await page.evaluate(() =>
      (
        document.getElementById('prompt-queue-list') as HTMLButtonElement
      ).click(),
    );
    await page.waitForFunction(
      () =>
        !(
          (document.getElementById('prompt-queue-body') as HTMLElement)
            .textContent ?? ''
        ).includes('loading'),
      null,
      { timeout: 8000 },
    );
    return queuedBody(page);
  };

  const pressQueueDrop = async (page: Page, n: number): Promise<string> => {
    await page.evaluate((i) => {
      const row = document.querySelectorAll('#prompt-queue-body > div')[i];
      (row?.querySelector('button') as HTMLButtonElement | undefined)?.click();
    }, n);
    await page.waitForFunction(
      (i) => {
        const row = document.querySelectorAll('#prompt-queue-body > div')[i];
        const t = row ? (row.textContent ?? '') : '';
        return t.includes('dropped') || t.includes('[');
      },
      n,
      { timeout: 8000 },
    );
    return page.evaluate((i) => {
      const row = document.querySelectorAll('#prompt-queue-body > div')[i];
      return row ? (row.textContent ?? '') : '';
    }, n);
  };

  const twoQueued = {
    pendingPrompts: [
      {
        promptId: 'p-run',
        text: 'the one in flight',
        queuedAt: 1700000000000,
        state: 'running',
      },
      {
        promptId: 'p-queue',
        text: 'waiting its turn',
        queuedAt: 1700000000500,
        state: 'queued',
      },
    ],
  };

  PAGE_SCENARIOS.push({
    name: 'P74 the prompt queue lists what the daemon holds for the watched session',
    run: async ({ page, viewer }) => {
      const asked = { session: null as string | null };
      await queueListRoute(page, twoQueued, asked);
      await watch(page, viewer.sessionId);
      await pressQueueList(page);
      expect(
        asked.session === viewer.sessionId,
        `the queue of ${JSON.stringify(asked.session)} was listed while watching ${JSON.stringify(viewer.sessionId)}`,
      );
      const rows = await queueRows(page);
      expect(
        rows.length === 2,
        `the daemon listed two prompts and the page drew ${rows.length} (${JSON.stringify(rows)})`,
      );
      expect(
        rows[0].includes('running') && rows[0].includes('the one in flight'),
        `the running prompt did not reach the panel (${JSON.stringify(rows[0])})`,
      );
      expect(
        rows[1].includes('queued') && rows[1].includes('waiting its turn'),
        `the waiting prompt did not reach the panel (${JSON.stringify(rows[1])})`,
      );
      // Both states are droppable, so both rows carry the control: the SDK
      // gives each a defined effect, and hiding it on the running row would
      // hide the only control that reaches a turn already in flight.
      const drops = await page.evaluate(
        () =>
          document.querySelectorAll('#prompt-queue-body > div button').length,
      );
      expect(
        drops === 2,
        `${rows.length} prompts were listed and ${drops} drop controls were drawn`,
      );
      // The placement ruling, copied from the runs panel: this is an operator
      // read, so it lives under Operations and not on the main screen.
      const placed = await page.evaluate(() => {
        const det = document.getElementById('prompt-queue');
        return {
          exists: !!det,
          inOps: !!document.getElementById('pane-ops')?.contains(det ?? null),
          inChat: !!document.getElementById('pane-chat')?.contains(det ?? null),
        };
      });
      expect(placed.exists, 'there is no prompt queue section in the page');
      expect(placed.inOps, 'the prompt queue section is not under Operations');
      expect(!placed.inChat, 'the prompt queue section sits on the main screen');
      return `the queue drew ${JSON.stringify(rows)} for ${JSON.stringify(asked.session)} with ${drops} controls`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P75 a session with nothing queued reads as a result and not a failure',
    run: async ({ page, viewer }) => {
      const asked = { session: null as string | null };
      await queueListRoute(page, { pendingPrompts: [] }, asked);
      await watch(page, viewer.sessionId);
      const body = await pressQueueList(page);
      expect(
        body.includes('(nothing queued)'),
        `an empty queue did not read as empty (${JSON.stringify(body)})`,
      );
      expect(
        !/fail|error/i.test(body),
        `an empty queue read as a failure (${JSON.stringify(body)})`,
      );
      return `an empty queue reads ${JSON.stringify(body)}`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P76 a drop the daemon did not honour does not read as dropped',
    run: async ({ page, viewer }) => {
      const listAsked = { session: null as string | null };
      await queueListRoute(page, twoQueued, listAsked);
      const dropped = {
        session: null as string | null,
        promptId: null as string | null,
      };
      // The daemon's own answer for a promptId it does not know: 200, with
      // removed false. Reading c.ok here would print "dropped" over a prompt
      // still sitting in the queue.
      await queueDropRoute(page, 200, { removed: false }, dropped);
      await watch(page, viewer.sessionId);
      await pressQueueList(page);
      const row = await pressQueueDrop(page, 1);
      expect(
        dropped.promptId === 'p-queue',
        `the drop asked for ${JSON.stringify(dropped.promptId)} rather than the row's own prompt id`,
      );
      expect(
        !row.includes('dropped'),
        `a prompt the daemon did not remove read as dropped (${JSON.stringify(row)})`,
      );
      expect(
        row.includes('the daemon did not drop it'),
        `a no-op drop did not say so (${JSON.stringify(row)})`,
      );
      return `a 200 with removed:false reads ${JSON.stringify(row)}`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P77 a refused drop names the reason instead of a bare status',
    run: async ({ page, viewer }) => {
      await queueListRoute(page, twoQueued, { session: null });
      const dropped = {
        session: null as string | null,
        promptId: null as string | null,
      };
      // The gateway's own wording for a daemon too old to serve the queue
      // (src/routes/sessionQueue.ts:73), so the page has a real code to name.
      await queueDropRoute(
        page,
        502,
        {
          error: 'Daemon does not support the session queue routes',
          code: 'queue_unsupported',
        },
        dropped,
      );
      await watch(page, viewer.sessionId);
      await pressQueueList(page);
      const row = await pressQueueDrop(page, 0);
      expect(
        row.includes('queue_unsupported'),
        `a refusal did not name its code (${JSON.stringify(row)})`,
      );
      expect(
        !row.includes('dropped'),
        `a refused drop read as dropped (${JSON.stringify(row)})`,
      );
      return `a refused drop reads ${JSON.stringify(row)}`;
    },
  });

  // The mid-turn half of the same route pair. Separate helpers because the
  // paths differ and the list request must not be swallowed by the drop rule.
  const heldRoute = (
    page: Page,
    body: unknown,
    asked: { session: string | null },
  ) =>
    page.route(/\/session\/[^/]+\/mid-turn-messages$/, async (route) => {
      const parts = new URL(route.request().url()).pathname.split('/');
      asked.session = parts[2];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

  const withdrawRoute = (
    page: Page,
    status: number,
    body: unknown,
    asked: { session: string | null; messageId: string | null },
  ) =>
    page.route(
      /\/session\/[^/]+\/mid-turn-messages\/[^/]+$/,
      async (route) => {
        const parts = new URL(route.request().url()).pathname.split('/');
        asked.session = parts[2];
        asked.messageId = decodeURIComponent(parts[4]);
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      },
    );

  const heldBody = (page: Page) =>
    page.evaluate(
      () =>
        (document.getElementById('mid-turn-body') as HTMLElement).textContent ??
        '',
    );

  const heldRows = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('#mid-turn-body > div')).map(
        (d) => d.textContent ?? '',
      ),
    );

  const pressHeldList = async (page: Page): Promise<string> => {
    await page.evaluate(() =>
      (document.getElementById('mid-turn-list') as HTMLButtonElement).click(),
    );
    await page.waitForFunction(
      () =>
        !(
          (document.getElementById('mid-turn-body') as HTMLElement).textContent ??
          ''
        ).includes('loading'),
      null,
      { timeout: 8000 },
    );
    return heldBody(page);
  };

  const pressWithdraw = async (page: Page, n: number): Promise<string> => {
    await page.evaluate((i) => {
      const row = document.querySelectorAll('#mid-turn-body > div')[i];
      (row?.querySelector('button') as HTMLButtonElement | undefined)?.click();
    }, n);
    await page.waitForFunction(
      (i) => {
        const row = document.querySelectorAll('#mid-turn-body > div')[i];
        const t = row ? (row.textContent ?? '') : '';
        return t.includes('withdrawn') || t.includes('[');
      },
      n,
      { timeout: 8000 },
    );
    return page.evaluate((i) => {
      const row = document.querySelectorAll('#mid-turn-body > div')[i];
      return row ? (row.textContent ?? '') : '';
    }, n);
  };

  const twoHeld = {
    messages: [
      { messageId: 'm-1', text: 'also use the short name' },
      { messageId: 'm-2', text: 'and skip the migration' },
    ],
    settledMessageIds: ['m-old'],
    promotedMessageIds: [],
  };

  PAGE_SCENARIOS.push({
    name: 'P78 the page lists what the daemon holds mid-turn for the watched session',
    run: async ({ page, viewer }) => {
      const asked = { session: null as string | null };
      await heldRoute(page, twoHeld, asked);
      await watch(page, viewer.sessionId);
      await pressHeldList(page);
      expect(
        asked.session === viewer.sessionId,
        `the held messages of ${JSON.stringify(asked.session)} were listed while watching ${JSON.stringify(viewer.sessionId)}`,
      );
      const rows = await heldRows(page);
      expect(
        rows.length === 2,
        `the daemon held two messages and the page drew ${rows.length} (${JSON.stringify(rows)})`,
      );
      expect(
        rows[0].includes('also use the short name'),
        `the first held message did not reach the panel (${JSON.stringify(rows[0])})`,
      );
      expect(
        rows[1].includes('and skip the migration'),
        `the second held message did not reach the panel (${JSON.stringify(rows[1])})`,
      );
      // The two rings are not drawn. They are bounded rings of ids kept so a
      // client can reconcile rows it stored, and this page stores none, so a
      // count of them would read as a total the ring cannot hold.
      expect(
        !/m-old|settled|promoted/i.test(rows.join(' ')),
        `a reconciliation ring leaked into the rows (${JSON.stringify(rows)})`,
      );
      const placed = await page.evaluate(() => {
        const det = document.getElementById('mid-turn');
        return {
          exists: !!det,
          inOps: !!document.getElementById('pane-ops')?.contains(det ?? null),
          inChat: !!document.getElementById('pane-chat')?.contains(det ?? null),
        };
      });
      expect(placed.exists, 'there is no mid-turn section in the page');
      expect(placed.inOps, 'the mid-turn section is not under Operations');
      expect(!placed.inChat, 'the mid-turn section sits on the main screen');
      return `the held messages drew ${JSON.stringify(rows)} for ${JSON.stringify(asked.session)}`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P79 a session holding nothing mid-turn reads as a result and not a failure',
    run: async ({ page, viewer }) => {
      await heldRoute(page, { messages: [], settledMessageIds: [], promotedMessageIds: [] }, { session: null });
      await watch(page, viewer.sessionId);
      const body = await pressHeldList(page);
      expect(
        body.includes('(nothing held)'),
        `an empty hold did not read as empty (${JSON.stringify(body)})`,
      );
      expect(
        !/fail|error/i.test(body),
        `an empty hold read as a failure (${JSON.stringify(body)})`,
      );
      return `an empty hold reads ${JSON.stringify(body)}`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P80 a withdraw the daemon did not honour does not read as withdrawn',
    run: async ({ page, viewer }) => {
      await heldRoute(page, twoHeld, { session: null });
      const gone = {
        session: null as string | null,
        messageId: null as string | null,
      };
      // The daemon's own answer for a messageId it does not know: 200 with
      // removed false, so reading c.ok here would print "withdrawn" over a
      // message the daemon still holds.
      await withdrawRoute(page, 200, { removed: false }, gone);
      await watch(page, viewer.sessionId);
      await pressHeldList(page);
      const row = await pressWithdraw(page, 1);
      expect(
        gone.messageId === 'm-2',
        `the withdraw asked for ${JSON.stringify(gone.messageId)} rather than the row's own message id`,
      );
      expect(
        !row.includes('withdrawn'),
        `a message the daemon did not withdraw read as withdrawn (${JSON.stringify(row)})`,
      );
      expect(
        row.includes('the daemon did not withdraw it'),
        `a no-op withdraw did not say so (${JSON.stringify(row)})`,
      );
      return `a 200 with removed:false reads ${JSON.stringify(row)}`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P81 a refused withdraw names the reason instead of a bare status',
    run: async ({ page, viewer }) => {
      await heldRoute(page, twoHeld, { session: null });
      const gone = {
        session: null as string | null,
        messageId: null as string | null,
      };
      await withdrawRoute(
        page,
        502,
        {
          error: 'Daemon does not support the session queue routes',
          code: 'queue_unsupported',
        },
        gone,
      );
      await watch(page, viewer.sessionId);
      await pressHeldList(page);
      const row = await pressWithdraw(page, 0);
      expect(
        row.includes('queue_unsupported'),
        `a refusal did not name its code (${JSON.stringify(row)})`,
      );
      expect(
        !row.includes('withdrawn'),
        `a refused withdraw read as withdrawn (${JSON.stringify(row)})`,
      );
      return `a refused withdraw reads ${JSON.stringify(row)}`;
    },
  });

  // #124: the Session report panel. The stub's default roll-up is built so
  // that no number in it appears anywhere else in the harness (the
  // context-usage read answers 65536/262144), so a row carrying one of these
  // values can only have come from GET /session/:id/stats.
  //
  // Rows are read off the child divs rather than the container's textContent.
  // renderRows writes one div per row, so the container's text jams them
  // together with no separator and an assertion could match across a row
  // boundary.
  const statsRows = async (page: Page): Promise<string[]> =>
    page.evaluate(() =>
      Array.from(
        document.getElementById('stats-body')?.children ?? [],
      ).map((d) => d.textContent ?? ''),
    );

  PAGE_SCENARIOS.push({
    name: 'P82 the session report prints the models total and not the subagent sum',
    waitView: false,
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await press(page, 'session-stats', 'stats-load');
      await drawn(page, 'stats-body');
      const rows = await statsRows(page);
      expect(
        rows.some((r) => r === 'ran 1h 30m, 7 prompts'),
        `the roll-up header is missing (${JSON.stringify(rows)})`,
      );
      // 128000 is models['qwen3-coder:30b'].tokens.total, the whole
      // conversation. 9500 is the one subagent's spend, which by the
      // payload's own definition excludes the main conversation, so a total
      // printed as 9500 would be a number labelled like a session total while
      // being a partial one.
      expect(
        rows.some((r) => r === 'total 128000 tokens'),
        `the printed total is not the models sum (${JSON.stringify(rows)})`,
      );
      expect(
        !rows.some((r) => r.includes('total 9500')),
        `the total was taken from the sources list (${JSON.stringify(rows)})`,
      );
      expect(
        rows.some((r) => r.startsWith('subagent audit the paging path')),
        `the per-subagent row is missing (${JSON.stringify(rows)})`,
      );
      expect(
        rows.some((r) => r.startsWith('lines +140 / -22')),
        `the lines-written row is missing (${JSON.stringify(rows)})`,
      );
      expect(
        rows.some((r) => r.includes('12 tool calls') && r.includes('2 failed')),
        `the tool roll-up is missing (${JSON.stringify(rows)})`,
      );
      // A refused tool call is the one number on this panel that says something
      // about what the human actually did, so it has to survive to the screen.
      expect(
        rows.some((r) => r.startsWith('  run_shell_command') && r.includes('1 refused')),
        `the refused-call count is missing (${JSON.stringify(rows)})`,
      );
      return `the report drew ${rows.length} rows headed ${JSON.stringify(rows[0])}`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P83 a stats payload with no skills block draws no skills row',
    waitView: false,
    // `skills` and `sources` are optional on the wire. A daemon that never
    // measured skills must not be drawn saying zero skill calls, because that
    // states a fact about a thing it did not measure. The default stub body
    // carries every optional block, so this scenario has to hand it one
    // without them.
    stub: {
      statsResult: {
        v: 1,
        sessionId: '11111111-2222-3333-4444-555555555555',
        workspaceCwd: '/proj',
        sessionStartTimeMs: 1_767_225_600_000,
        durationMs: 60_000,
        promptCount: 1,
        models: {
          'qwen3-coder:30b': {
            api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 900 },
            tokens: {
              prompt: 10,
              candidates: 5,
              total: 15,
              cached: 0,
              thoughts: 0,
            },
          },
        },
        tools: {
          totalCalls: 0,
          totalSuccess: 0,
          totalFail: 0,
          totalDurationMs: 0,
          byName: {},
        },
        files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
      },
    },
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await press(page, 'session-stats', 'stats-load');
      await drawn(page, 'stats-body');
      const rows = await statsRows(page);
      expect(
        !rows.some((r) => /skill/i.test(r)),
        `an unmeasured skills block drew a row (${JSON.stringify(rows)})`,
      );
      expect(
        !rows.some((r) => /subagent/i.test(r)),
        `an absent sources list drew a row (${JSON.stringify(rows)})`,
      );
      // The tool roll-up is present but empty. Drawing "0 tool calls" for a
      // conversation that made none is the same invention, so the guard here
      // is the same one.
      expect(
        !rows.some((r) => /tool calls/.test(r)),
        `an empty tool roll-up drew a zero row (${JSON.stringify(rows)})`,
      );
      expect(
        rows.some((r) => r === 'total 15 tokens'),
        `the models total is wrong (${JSON.stringify(rows)})`,
      );
      return `a bare roll-up drew only ${JSON.stringify(rows)}`;
    },
  });

  PAGE_SCENARIOS.push({
    name: 'P84 a refused stats read names its reason instead of a bare failure',
    waitView: false,
    // The gateway answers this route with three different failures and the
    // page has no place to show the difference except this row. A daemon 404
    // is a conversation it cannot load, which the gateway passes on as
    // session_not_found rather than flattening into a capability verdict the
    // way the recap route does.
    stub: { statsStatusCode: 404 },
    run: async ({ page, viewer }) => {
      await watch(page, viewer.sessionId);
      await press(page, 'session-stats', 'stats-load');
      await drawn(page, 'stats-body');
      const body = await page.evaluate(
        () => (document.getElementById('stats-body')?.textContent ?? '').trim(),
      );
      expect(
        body.includes('session_not_found'),
        `a refused read did not name its code (${JSON.stringify(body)})`,
      );
      expect(
        !/^\(not loaded\)$/.test(body),
        `a refused read left the placeholder in place (${JSON.stringify(body)})`,
      );
      return `a refused read reports ${JSON.stringify(body)}`;
    },
  });
}
async function runPageScenario(
  s: Exclude<PageScenario, { standalone: () => Promise<string> }>,
): Promise<string> {
  const viewer = await bootViewer({
    frames: s.frames ? s.frames() : READY,
    holdOpenMs: 600_000,
    promptStatus: s.stub?.promptStatus,
    promptDelayMs: s.stub?.promptDelayMs,
    transcriptPage: s.stub?.transcriptPage,
    // A card scenario needs both: the status body that keeps its request
    // listed as pending, and the status the vote is answered with.
    permissionStatus: s.stub?.permissionStatus,
    sessionStatus: s.stub?.sessionStatus,
    capabilitiesFeatures: s.stub?.capabilitiesFeatures,
    exportStatusCode: s.stub?.exportStatusCode,
    attachmentUploadStatus: s.stub?.attachmentUploadStatus,
    attachmentUploadErrorBody: s.stub?.attachmentUploadErrorBody,
    attachmentListResult: s.stub?.attachmentListResult,
    attachmentListStatus: s.stub?.attachmentListStatus,
    statsStatusCode: s.stub?.statsStatusCode,
    statsResult: s.stub?.statsResult,
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
