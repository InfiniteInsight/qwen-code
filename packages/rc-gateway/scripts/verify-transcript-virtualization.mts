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
declare const renderFrame: (ev: unknown) => void;
declare const addUser: (text: string) => void;
declare const clearTranscript: () => void;
declare const showProcessing: () => void;
declare const renderTool: (u: Record<string, unknown>) => void;
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
  /\/ui\/(transcript-model\.js|transcript-view\.js|vendor\/virtual-core\.js)$/;
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
];

async function runPageScenario(
  s: Exclude<PageScenario, { standalone: () => Promise<string> }>,
): Promise<string> {
  const viewer = await bootViewer({
    frames: s.frames ? s.frames() : READY,
    holdOpenMs: 600_000,
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
