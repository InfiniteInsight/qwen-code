/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkDistConsistency,
  findStaleDependents,
} from '../check-dist-consistency.mjs';
import {
  nextRepairBatch,
  rebuildStaleDependents,
  tsBuildInfoFiles,
} from '../rebuild-stale-dependents.mjs';

const checkScript = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'check-dist-consistency.mjs',
);

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function put(root, rel, secs, body = 'x') {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  utimesSync(full, secs, secs);
}

/**
 * The #209 tree: core and sdk (dependencies) were rebuilt at 400 and 410, the
 * gateway (depends on both, built with `tsc --build`) still has the dist from
 * 300 and a tsbuildinfo, and its own sources are untouched (150).
 */
function staleGatewayTree() {
  const root = mkdtempSync(join(tmpdir(), 'stale-deps-'));
  dirs.push(root);
  put(
    root,
    'package.json',
    1,
    JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
  );
  put(
    root,
    'packages/core/package.json',
    1,
    JSON.stringify({ name: '@x/core' }),
  );
  put(root, 'packages/sdk/package.json', 1, JSON.stringify({ name: '@x/sdk' }));
  put(
    root,
    'packages/gw/package.json',
    1,
    JSON.stringify({
      name: '@x/gw',
      dependencies: { '@x/core': '*', '@x/sdk': '*' },
    }),
  );
  put(root, 'packages/core/src/index.ts', 100);
  put(root, 'packages/core/dist/index.js', 400);
  put(root, 'packages/sdk/src/index.ts', 100);
  put(root, 'packages/sdk/dist/index.js', 410);
  put(root, 'packages/gw/src/index.ts', 150);
  put(root, 'packages/gw/dist/index.js', 300);
  put(root, 'packages/gw/tsconfig.tsbuildinfo', 300);
  return root;
}

describe('findStaleDependents', () => {
  it('names the dependent whose dist predates its dependencies (the #209 case)', () => {
    const root = staleGatewayTree();
    const stale = findStaleDependents(root);
    expect(stale).toHaveLength(1);
    expect(stale[0].name).toBe('@x/gw');
    expect(stale[0].dependencies.sort()).toEqual(['@x/core', '@x/sdk']);
    expect(stale[0].dir).toBe(join(root, 'packages/gw'));
  });

  it('does not treat a dist older than its own source as a stale dependent', () => {
    const root = staleGatewayTree();
    put(root, 'packages/gw/dist/index.js', 500); // gateway is fresher than both
    put(root, 'packages/gw/src/index.ts', 600); // but its own source moved on
    expect(findStaleDependents(root)).toEqual([]);
    expect(checkDistConsistency(root).problems).toHaveLength(1);
  });

  it('finds nothing in a consistent tree', () => {
    const root = staleGatewayTree();
    put(root, 'packages/gw/dist/index.js', 500);
    expect(findStaleDependents(root)).toEqual([]);
  });
});

describe('nextRepairBatch', () => {
  const s = (name, dependencies) => ({ name, dir: `/p/${name}`, dependencies });

  it('rebuilds a stale chain dependency first', () => {
    const stale = [s('b', ['a']), s('a', ['core']), s('c', ['core'])];
    expect(nextRepairBatch(stale).map((p) => p.name)).toEqual(['a', 'c']);
  });

  it('skips packages already attempted', () => {
    expect(nextRepairBatch([s('a', ['core'])], new Set(['a']))).toEqual([]);
  });
});

describe('tsBuildInfoFiles', () => {
  it('finds tsbuildinfo beside the tsconfig and under dist, not elsewhere', () => {
    const root = staleGatewayTree();
    put(root, 'packages/gw/dist/tsconfig.tsbuildinfo', 300);
    put(root, 'packages/gw/src/nested.tsbuildinfo', 300);
    expect(tsBuildInfoFiles(join(root, 'packages/gw')).sort()).toEqual([
      join(root, 'packages/gw/dist/tsconfig.tsbuildinfo'),
      join(root, 'packages/gw/tsconfig.tsbuildinfo'),
    ]);
  });
});

describe('rebuildStaleDependents (the repair decision)', () => {
  /** Runner that, like a forced tsc emit, writes a fresh dist for the package. */
  function emitRunner(clock) {
    const calls = [];
    const run = (pkg) => {
      calls.push({
        name: pkg.name,
        buildinfoGoneAtRun: !existsSync(join(pkg.dir, 'tsconfig.tsbuildinfo')),
      });
      put(pkg.dir, 'dist/index.js', clock.t++);
    };
    return { calls, run };
  }

  it('deletes the stale package tsbuildinfo, rebuilds only it, and leaves the check passing', () => {
    const root = staleGatewayTree();
    expect(checkDistConsistency(root).problems).toHaveLength(2);

    const { calls, run } = emitRunner({ t: 1000 });
    const rebuilt = rebuildStaleDependents(root, { run, log: () => {} });

    expect(rebuilt).toEqual(['@x/gw']);
    expect(calls).toEqual([{ name: '@x/gw', buildinfoGoneAtRun: true }]);
    expect(checkDistConsistency(root).problems).toEqual([]);
  });

  it('does nothing, and removes nothing, when no dependent is stale', () => {
    const root = staleGatewayTree();
    put(root, 'packages/gw/dist/index.js', 500);
    const { calls, run } = emitRunner({ t: 1000 });
    expect(rebuildStaleDependents(root, { run, log: () => {} })).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(join(root, 'packages/gw/tsconfig.tsbuildinfo'))).toBe(
      true,
    );
  });

  it('rebuilds a stale chain in dependency order across rounds', () => {
    const root = staleGatewayTree();
    // ui depends on gw; both predate core and sdk.
    put(
      root,
      'packages/ui/package.json',
      1,
      JSON.stringify({
        name: '@x/ui',
        dependencies: { '@x/gw': '*', '@x/core': '*' },
      }),
    );
    put(root, 'packages/ui/dist/index.js', 250);
    const { calls, run } = emitRunner({ t: 1000 });
    const rebuilt = rebuildStaleDependents(root, { run, log: () => {} });
    expect(rebuilt).toEqual(['@x/gw', '@x/ui']);
    expect(calls.map((c) => c.name)).toEqual(['@x/gw', '@x/ui']);
    expect(checkDistConsistency(root).problems).toEqual([]);
  });

  it('gives up on a package whose rebuild did not refresh its dist, instead of looping', () => {
    const root = staleGatewayTree();
    let runs = 0;
    const rebuilt = rebuildStaleDependents(root, {
      run: () => {
        runs += 1; // a no-op build: the dist stays old
      },
      log: () => {},
    });
    expect(runs).toBe(1);
    expect(rebuilt).toEqual(['@x/gw']);
    expect(checkDistConsistency(root).problems).toHaveLength(2);
  });
});

describe('check-dist-consistency fix line', () => {
  it('names the root build and the force rebuild that works when it does not', () => {
    const root = staleGatewayTree();
    // The script derives its root from its own location, so run a copy placed
    // inside the temp tree's scripts directory.
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'scripts/check-dist-consistency.mjs'),
      readFileSync(checkScript, 'utf8'),
    );
    let err = '';
    let code = 0;
    try {
      execFileSync(
        process.execPath,
        [join(root, 'scripts/check-dist-consistency.mjs')],
        {
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
    } catch (e) {
      code = e.status;
      err = String(e.stderr);
    }
    expect(code).toBe(1);
    expect(err).toMatch(/run `npm run build` at the repository root/);
    expect(err).toMatch(/\(cd packages\/gw && npx tsc --build --force\)/);
  });
});
