/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #138: the view's side of find in conversation. The model finds the rows; the
// view marks the ones that are mounted and puts a chosen one in front of the
// reader. These drive the shipped transcript-view.js in jsdom (the render-all
// path, so every row is mounted) with a stand-in for the CSS Custom Highlight
// registry, which jsdom does not have. What a real browser does with the
// virtualizer (a row far above, unmounted, reached by revealItem) is covered by
// the verifier's V19 to V22 and P350 to P357.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => join(here, '..', 'public', f);

type Item = { id: number; kind: string; text?: string };
type Model = {
  items: Item[];
  addUser: (t: string) => Item;
  appendAssistant: (t: string) => void;
  search: (q: string) => Array<{ id: number; item: Item }>;
};
type View = {
  destroy: () => void;
  setFind: (spec: unknown) => void;
  revealItem: (item: Item, top?: number) => void;
};

let rafQueue = new Map<number, () => void>();
let rafId = 0;
let dom: JSDOM;
let scroller: HTMLElement;
let view: View | null = null;
let model: Model;
let registry: Map<string, { ranges: Range[] }>;

function tick(): void {
  for (let round = 0; round < 4 && rafQueue.size; round++) {
    const due = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, fn] of due) fn(0);
  }
}

function spec(query: string, active: number | null = 0) {
  const hits = model.search(query);
  return {
    query,
    ids: hits.map((h) => h.id),
    active: active === null ? null : (hits[active]?.item ?? null),
  };
}

function rows(cls: string): string[] {
  return [...scroller.querySelectorAll(`.vrow.${cls}`)].map(
    (r) => r.querySelector('.bubble')?.textContent ?? '',
  );
}

function marked(name: string): string[] {
  return (registry.get(name)?.ranges ?? []).map((r) => r.toString());
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window;
  rafQueue = new Map();
  rafId = 0;
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
  const TranscriptModel = (globalThis as { TranscriptModel: never })
    .TranscriptModel as unknown as { createTranscriptModel: () => Model };
  const TranscriptView = (globalThis as { TranscriptView: never })
    .TranscriptView as unknown as {
    createTranscriptView: (o: Record<string, unknown>) => View;
  };
  model = TranscriptModel.createTranscriptModel();
  view = TranscriptView.createTranscriptView({
    model,
    scroller,
    virtualCore: null,
  });
  model.addUser('where is the Needle in this repo');
  model.appendAssistant('It is in src/a.ts, the needle and another NEEDLE.');
  model.addUser('thanks');
  model.appendAssistant('Anytime.');
  tick();
});

afterEach(() => {
  if (view) view.destroy();
  view = null;
  dom.window.close();
});

describe('view.setFind (#138)', () => {
  it('marks the rows that hold the query and rings the active one', () => {
    view!.setFind(spec('needle', 1));
    tick();
    expect(rows('find-hit')).toHaveLength(2);
    expect(rows('find-active')).toHaveLength(1);
    expect(rows('find-active')[0]).toContain('src/a.ts');
  });

  it('paints every occurrence in a hit row, the first of the active row apart', () => {
    view!.setFind(spec('needle', 1));
    tick();
    expect(marked('rc-find-active')).toEqual(['needle']);
    // The user row's one, and the active row's second.
    expect(marked('rc-find').map((s) => s.toLowerCase())).toEqual([
      'needle',
      'needle',
    ]);
  });

  it('adds no node and changes no text: a mark is a range over the words', () => {
    const before = scroller.innerHTML.replace(/ ?class="vrow[^"]*"/g, '');
    view!.setFind(spec('needle', 0));
    tick();
    const after = scroller.innerHTML.replace(/ ?class="vrow[^"]*"/g, '');
    expect(after).toBe(before);
  });

  it('does not mark the role line or its time', () => {
    view!.setFind(spec('you', 0));
    tick();
    // "you" is the user rows role label, not the conversation's words.
    expect(marked('rc-find-active')).toEqual([]);
  });

  it('is case-insensitive when painting', () => {
    view!.setFind(spec('NEEDLE', 0));
    tick();
    expect(marked('rc-find-active')).toHaveLength(1);
    expect(marked('rc-find-active')[0]).toBe('Needle');
  });

  it('follows a streamed row: the mark is painted again when the text grows', () => {
    view!.setFind(spec('lockfile', null));
    tick();
    expect(rows('find-hit')).toHaveLength(0);
    model.appendAssistant(' The lockfile is stale.');
    view!.setFind(spec('lockfile', null));
    tick();
    expect(rows('find-hit')).toHaveLength(1);
    expect(marked('rc-find')).toEqual(['lockfile']);
  });

  it('clears the classes and the registry on null and on destroy', () => {
    view!.setFind(spec('needle', 0));
    tick();
    expect(rows('find-hit').length).toBeGreaterThan(0);
    view!.setFind(null);
    tick();
    expect(rows('find-hit')).toHaveLength(0);
    expect(rows('find-active')).toHaveLength(0);
    expect(registry.has('rc-find')).toBe(false);
    expect(registry.has('rc-find-active')).toBe(false);
    view!.setFind(spec('needle', 0));
    tick();
    expect(registry.size).toBeGreaterThan(0);
    view!.destroy();
    view = null;
    expect(registry.size).toBe(0);
  });

  it('still rings the rows where the highlight registry is absent', () => {
    (globalThis as { CSS?: unknown }).CSS = undefined;
    view!.setFind(spec('needle', 0));
    tick();
    expect(rows('find-hit')).toHaveLength(2);
    expect(rows('find-active')).toHaveLength(1);
    expect(registry.size).toBe(0);
  });

  it('draws nothing for a blank query', () => {
    view!.setFind({ query: '   ', ids: [1, 2], active: model.items[0] });
    tick();
    expect(rows('find-hit')).toHaveLength(0);
  });

  it('ignores revealItem for a row that is not in the list', () => {
    expect(() => view!.revealItem({ id: 9999, kind: 'user' })).not.toThrow();
    tick();
  });
});
