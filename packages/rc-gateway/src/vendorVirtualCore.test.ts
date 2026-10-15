/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendored = join(here, '..', 'public', 'vendor', 'virtual-core.js');
const scriptUrl = pathToFileURL(
  join(here, '..', 'scripts', 'vendor-virtual-core.mjs'),
).href;

const REGEN_HINT =
  'public/vendor/virtual-core.js is out of date with the installed ' +
  '@tanstack/virtual-core / esbuild. Re-run: ' +
  '`node scripts/vendor-virtual-core.mjs` (in packages/rc-gateway) and ' +
  'commit the result.';

describe('vendored @tanstack/virtual-core', () => {
  it('is byte-identical to a fresh build', async () => {
    const { buildVirtualCore } = (await import(scriptUrl)) as {
      buildVirtualCore: () => Promise<string>;
    };
    const fresh = await buildVirtualCore();
    const committed = readFileSync(vendored, 'utf8');
    // The hint rides along as the "expected" string so it shows in the failure.
    expect(committed === fresh ? 'up to date' : REGEN_HINT).toBe('up to date');
  });

  it('exports exactly Virtualizer, observeElementRect, observeElementOffset, elementScroll', async () => {
    const mod = (await import(pathToFileURL(vendored).href)) as Record<
      string,
      unknown
    >;
    expect(typeof mod['Virtualizer']).toBe('function');
    expect(typeof mod['observeElementRect']).toBe('function');
    expect(typeof mod['observeElementOffset']).toBe('function');
    expect(typeof mod['elementScroll']).toBe('function');
    expect(Object.keys(mod).sort()).toEqual([
      'Virtualizer',
      'elementScroll',
      'observeElementOffset',
      'observeElementRect',
    ]);
  });

  it('starts with a provenance comment naming the pinned version', () => {
    const firstLine = readFileSync(vendored, 'utf8').split('\n')[0];
    expect(firstLine).toMatch(/^\/\*.*@tanstack\/virtual-core 3\.17\.0.*\*\/$/);
  });
});

// public/transcript-view.js drives a Virtualizer without a framework adapter
// and reaches past the typed API in places. These checks make a vendor bump
// that renames or drops any of those members fail here, not in the browser.
describe('Virtualizer members transcript-view.js relies on', () => {
  type Instance = Record<string, unknown> & {
    options: Record<string, unknown>;
  };
  type ScrollCall = { offset: number; adjustments: number | undefined };

  async function make(calls: ScrollCall[] = []): Promise<Instance> {
    const mod = (await import(pathToFileURL(vendored).href)) as {
      Virtualizer: new (opts: Record<string, unknown>) => Instance;
    };
    return new mod.Virtualizer({
      count: 3,
      getScrollElement: () => null,
      estimateSize: () => 40,
      getItemKey: (i: number) => 100 + i,
      scrollToFn: (offset: number, o: { adjustments?: number }) => {
        calls.push({ offset, adjustments: o.adjustments });
      },
      observeElementRect: () => {},
      observeElementOffset: () => {},
    });
  }

  it('has the methods and fields the view uses', async () => {
    const v = await make();
    for (const name of [
      // typed API
      'setOptions',
      'getVirtualItems',
      'getTotalSize',
      'scrollToEnd',
      'scrollToOffset',
      'getOffsetForIndex',
      'measure',
      'measureElement',
      'resizeItem',
      'indexFromElement',
      // framework-adapter lifecycle
      '_didMount',
      '_willUpdate',
    ]) {
      expect({ name, type: typeof v[name] }).toEqual({
        name,
        type: 'function',
      });
    }
    expect(v['itemSizeCache']).toBeInstanceOf(Map);
    expect((v.options['getItemKey'] as (i: number) => number)(2)).toBe(102);
    // Read for the estimate's width; written after a relayout's scroll.
    expect(v['scrollRect']).toBeNull();
    expect('scrollOffset' in v).toBe(true);
    // Zeroed by the view to cancel a stale iOS correction (see below).
    expect(v['_iosDeferredAdjustment']).toBe(0);
    // measureElement(null) drops detached rows; it must accept null.
    expect(() =>
      (v['measureElement'] as (node: null) => void)(null),
    ).not.toThrow();
  });

  it('asks shouldAdjustScrollPositionOnItemSizeChange whether a resize moves the scroll position', async () => {
    const calls: ScrollCall[] = [];
    const v = await make(calls);
    const getTotalSize = v['getTotalSize'] as () => number;
    const resizeItem = v['resizeItem'] as (i: number, size: number) => void;
    const asked: Array<{ index: number; end: number; delta: number }> = [];
    let answer = true;
    let instance: unknown = null;
    v['shouldAdjustScrollPositionOnItemSizeChange'] = (
      item: { index: number; end: number },
      delta: number,
      inst: unknown,
    ) => {
      asked.push({ index: item.index, end: item.end, delta });
      instance = inst;
      return answer;
    };
    getTotalSize(); // lays the three 40 px rows out
    resizeItem(0, 60);
    expect(asked).toEqual([{ index: 0, end: 40, delta: 20 }]);
    expect(instance).toBe(v);
    expect(calls).toEqual([{ offset: 0, adjustments: 20 }]);
    answer = false;
    getTotalSize();
    resizeItem(1, 70);
    expect(asked[1]).toEqual({ index: 1, end: 100, delta: 30 });
    expect(calls).toHaveLength(1);
  });

  it('replays _iosDeferredAdjustment once settled, so zeroing it cancels the replay', async () => {
    const calls: ScrollCall[] = [];
    const v = await make(calls);
    const flush = v['_flushIosDeferredIfReady'] as () => void;
    expect(typeof flush).toBe('function');
    v['_iosDeferredAdjustment'] = 37;
    flush();
    expect(calls).toEqual([{ offset: 0, adjustments: 37 }]);
    expect(v['_iosDeferredAdjustment']).toBe(0);
    flush();
    expect(calls).toHaveLength(1);
  });
});
