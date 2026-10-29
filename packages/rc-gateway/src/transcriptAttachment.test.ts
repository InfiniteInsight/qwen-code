/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// A sent attachment (#197). Drives the shipped transcript-view.js in jsdom, as
// transcriptImage.test.ts does: the point is the wiring from a user row's
// `parts` to the DOM, since a user message whose only content is a picture or a
// file used to draw an empty bubble.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => join(here, '..', 'public', f);

type Part = {
  kind: string;
  name: string;
  attachmentId?: string;
  mimeType: string;
  size: number;
  data?: string;
  url?: string;
};
type Model = {
  addUser: (t: string) => unknown;
  addUserPart: (p: Part) => { merged: boolean };
};
type View = { destroy: () => void };
type Loader = (id: string, part: Part) => Promise<{ url: string } | null>;

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let rafQueue = new Map<number, () => void>();
let rafId = 0;
let dom: JSDOM;
let scroller: HTMLElement;
let view: View | null = null;
let model: Model;
let loads: string[] = [];

function tick(): void {
  for (let round = 0; round < 4 && rafQueue.size; round++) {
    const due = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, fn] of due) fn(0);
  }
}

async function attach(loadAttachment?: Loader): Promise<void> {
  const TM = (globalThis as { TranscriptModel: unknown }).TranscriptModel as {
    createTranscriptModel: () => Model;
  };
  const TV = (globalThis as { TranscriptView: unknown }).TranscriptView as {
    createTranscriptView: (o: Record<string, unknown>) => View;
  };
  model = TM.createTranscriptModel();
  view = TV.createTranscriptView({
    model,
    scroller,
    virtualCore: null,
    ...(loadAttachment
      ? {
          loadAttachment: (id: string, part: Part) => {
            loads.push(id);
            return loadAttachment(id, part);
          },
        }
      : {}),
  });
  tick();
}

const imagePart = (over: Partial<Part> = {}): Part => ({
  kind: 'image',
  name: 'IMG_0001.jpg',
  attachmentId: 'IMG_0001.jpg',
  mimeType: 'image/jpeg',
  size: 2_500_000,
  ...over,
});
const filePart = (over: Partial<Part> = {}): Part => ({
  kind: 'file',
  name: 'crash.log',
  attachmentId: 'crash.log',
  mimeType: 'text/plain',
  size: 2048,
  ...over,
});

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  tick();
};

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window;
  rafQueue = new Map();
  rafId = 0;
  loads = [];
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
});

afterEach(() => {
  if (view) view.destroy();
  view = null;
  dom.window.close();
});

describe('a user message that is an attachment (#197)', () => {
  it('draws a stored picture as a thumbnail loaded through the page, with its name', async () => {
    await attach(async () => ({ url: 'blob:thumb-1' }));
    model.addUserPart(imagePart());
    tick();
    await flush();
    const bubble = scroller.querySelector('.bubble.user')!;
    const img = bubble.querySelector('img.att-thumb');
    expect(img?.getAttribute('src')).toBe('blob:thumb-1');
    const a = bubble.querySelector('a.att-link');
    expect(a?.getAttribute('href')).toBe('blob:thumb-1');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(bubble.querySelector('.att-name')?.textContent).toBe('IMG_0001.jpg');
    expect(loads).toEqual(['IMG_0001.jpg']);
    // No empty text span is left in the bubble.
    expect((bubble.querySelector('span') as HTMLElement | null)?.hidden).toBe(
      true,
    );
  });

  it('draws a file as a chip with its name, type and size', async () => {
    await attach(async () => null);
    model.addUserPart(filePart());
    tick();
    const chip = scroller.querySelector('.bubble.user .att-chip')!;
    expect(chip.textContent).toContain('crash.log');
    expect(chip.textContent).toContain('text/plain');
    expect(chip.textContent).toContain('2 KB');
    expect(loads).toEqual([]);
  });

  it('draws text and the picture together in one bubble', async () => {
    await attach(async () => ({ url: 'blob:t' }));
    model.addUser('what is this?');
    model.addUserPart(imagePart());
    tick();
    await flush();
    const bubbles = scroller.querySelectorAll('.bubble.user');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].textContent).toContain('what is this?');
    expect(bubbles[0].querySelector('img.att-thumb')).not.toBeNull();
  });

  it('says so when the picture cannot be fetched, and keeps the name', async () => {
    await attach(async () => null);
    model.addUserPart(imagePart());
    tick();
    await flush();
    const bubble = scroller.querySelector('.bubble.user')!;
    expect(bubble.querySelector('img')).toBeNull();
    expect(bubble.textContent).toContain('image unavailable');
    expect(bubble.textContent).toContain('IMG_0001.jpg');
  });

  it('draws inline bytes without fetching anything', async () => {
    await attach(async () => ({ url: 'blob:never' }));
    model.addUserPart({
      kind: 'image',
      name: 'image',
      mimeType: 'image/png',
      size: 70,
      data: PNG,
    });
    tick();
    const img = scroller.querySelector('.bubble.user img.att-thumb');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,' + PNG);
    expect(loads).toEqual([]);
  });

  it('shows a picture again on a rebuilt row without asking the page twice', async () => {
    await attach(async () => ({ url: 'blob:once' }));
    model.addUserPart(imagePart());
    tick();
    await flush();
    // A virtualised row that scrolls away and back is built again from the item.
    (view as unknown as { destroy: () => void }).destroy();
    scroller.textContent = '';
    const TV = (globalThis as { TranscriptView: unknown }).TranscriptView as {
      createTranscriptView: (o: Record<string, unknown>) => View;
    };
    view = TV.createTranscriptView({
      model,
      scroller,
      virtualCore: null,
      loadAttachment: (id: string) => {
        loads.push(id);
        return Promise.resolve(null);
      },
    });
    tick();
    expect(scroller.querySelector('img.att-thumb')?.getAttribute('src')).toBe(
      'blob:once',
    );
    expect(loads).toEqual(['IMG_0001.jpg']);
  });

  it('adds a later part to the row already on screen', async () => {
    await attach(async () => ({ url: 'blob:t' }));
    model.addUser('two files');
    model.addUserPart(filePart());
    tick();
    model.addUserPart(filePart({ name: 'b.txt', attachmentId: 'b.txt' }));
    tick();
    expect(scroller.querySelectorAll('.bubble.user .att-chip')).toHaveLength(2);
  });
});
