/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Assistant images (#100). Like the markdown suite, these drive the shipped
// transcript-view.js in jsdom rather than a copy of the builder, because what
// matters is the wiring: the bytes in a frame must reach the DOM as a picture,
// the full-size target must never be a data: URL (the browser blocks that
// navigation), and a row the viewer will not draw must still say what arrived.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => join(here, '..', 'public', f);

type Item = {
  id: number;
  kind: string;
  mime?: string;
  bytes?: number;
  data?: string | null;
  note?: string;
};
type Model = {
  items: Item[];
  addImage: (mime: string, data: string) => void;
  appendAssistant: (t: string) => void;
  touch: (item: Item) => void;
};
type View = { destroy: () => void };

// A real 1x1 PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let rafQueue = new Map<number, () => void>();
let rafId = 0;
let dom: JSDOM;
let scroller: HTMLElement;
let view: View | null = null;
let model: Model;

function tick(): void {
  for (let round = 0; round < 4 && rafQueue.size; round++) {
    const due = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, fn] of due) fn(0);
  }
}

async function attach(): Promise<void> {
  const TranscriptModel = (globalThis as { TranscriptModel: never })
    .TranscriptModel as unknown as {
    createTranscriptModel: () => Model;
  };
  const TranscriptView = (globalThis as { TranscriptView: never })
    .TranscriptView as unknown as {
    createTranscriptView: (o: Record<string, unknown>) => View;
  };
  model = TranscriptModel.createTranscriptModel();
  view = TranscriptView.createTranscriptView({
    model,
    scroller,
    virtualCore: null, // the render-all path: every item is in the DOM
    markdownIt: await import(
      pathToFileURL(join(pub('vendor'), 'markdown-it.js')).href
    ),
  });
  tick();
}

function imageRow(): Element | undefined {
  return [...scroller.querySelectorAll('.bubble.image')].pop();
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window;
  rafQueue = new Map();
  rafId = 0;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    Node: w.Node,
    Event: w.Event,
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
  await attach();
});

afterEach(() => {
  if (view) view.destroy();
  view = null;
  dom.window.close();
});

describe('assistant image (#100)', () => {
  it('draws the frame bytes as a picture, fetching nothing', () => {
    model.addImage('image/png', PNG);
    tick();
    const img = imageRow()?.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,' + PNG);
    expect(img?.getAttribute('alt')).toBeTruthy();
    // No request was made for it: the only source is the inline data: URI.
    expect(img?.getAttribute('srcset')).toBeNull();
  });

  it('makes the full-size target a new tab that cannot reach back here', () => {
    model.addImage('image/png', PNG);
    tick();
    const a = imageRow()?.querySelector('a');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('mints the blob href on the tap that uses it, and lets that tap through', () => {
    model.addImage('image/png', PNG);
    tick();
    const a = imageRow()?.querySelector('a');
    // Not a data: URL left in the markup: that navigation is blocked, so a
    // href minted at build time would still be a dead tap.
    expect(a?.getAttribute('href')).toBeNull();
    const ev = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    a?.dispatchEvent(ev);
    expect(a?.getAttribute('href')?.startsWith('blob:')).toBe(true);
    // The handler must not swallow the click it just prepared.
    expect(ev.defaultPrevented).toBe(false);
  });

  it('names a frame it will not draw instead of leaving no row', () => {
    model.addImage('image/svg+xml', PNG);
    tick();
    const row = imageRow();
    expect(row?.querySelector('img')).toBeNull();
    expect(row?.textContent).toContain('image/svg+xml');
  });

  it('survives a touch: an image row is never rewritten as a system row', () => {
    model.addImage('image/png', PNG);
    tick();
    const item = model.items[0];
    const before = imageRow();
    model.touch(item);
    tick();
    const after = imageRow();
    // The patch path's default case restyles the node, which would drop the
    // picture and its tap target.
    expect(after).toBe(before);
    expect(after?.querySelector('img')).toBeTruthy();
    expect(after?.className).toContain('image');
  });

  it('keeps an image its own row, with text after it in a second bubble', () => {
    model.appendAssistant('before');
    model.addImage('image/png', PNG);
    model.appendAssistant('after');
    tick();
    expect([...scroller.querySelectorAll('.bubble.asst')].length).toBe(2);
    expect([...scroller.querySelectorAll('.bubble.image')].length).toBe(1);
  });
});
