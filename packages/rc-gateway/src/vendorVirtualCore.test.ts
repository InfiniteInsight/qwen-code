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
