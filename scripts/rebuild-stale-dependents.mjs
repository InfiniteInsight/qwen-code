/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Repairs the case where a package's dist lags the dist of a workspace
 * dependency after the root build (Qwen-Code-Remote#209).
 *
 * A package built with `tsc --build` (rc-gateway, audio-capture, the channel
 * packages) is incremental on its own sources: when only a dependency changed,
 * `tsc --build` finds nothing to do and leaves its dist older than the
 * dependency's, which `check-dist-consistency.mjs` then rightly reports. The
 * repair is a forced rebuild of exactly those packages. The package build
 * scripts take no force flag, so the least invasive lever is the one tsc
 * itself keys on: delete the package's `*.tsbuildinfo` (next to its tsconfig,
 * or under `dist/` for a composite build) and run its own build script again.
 *
 * This runs AFTER the recursive build, not before it: the dependency's dist is
 * rebuilt during that same run, so the stale relationship does not exist yet
 * to be detected beforehand. Packages whose build already emits fresh output
 * (esbuild bundles, build_package.js which wipes dist itself) are never
 * stale here and are not touched, so the normal incremental path stays.
 *
 * Plain Node, no dependencies.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findStaleDependents } from './check-dist-consistency.mjs';

/** `*.tsbuildinfo` files tsc keeps for the package at `dir`. */
export function tsBuildInfoFiles(dir) {
  const found = [];
  for (const where of [dir, join(dir, 'dist')]) {
    let entries;
    try {
      entries = readdirSync(where, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.tsbuildinfo')) {
        found.push(join(where, e.name));
      }
    }
  }
  return found;
}

/**
 * Decide the next batch to rebuild: the stale packages (not yet attempted)
 * none of whose dependencies is itself waiting in the stale set, so a stale
 * chain is rebuilt dependency first. Pure; takes `findStaleDependents` output.
 */
export function nextRepairBatch(stale, attempted = new Set()) {
  const waiting = new Set(stale.map((s) => s.name));
  return stale.filter(
    (s) =>
      !attempted.has(s.name) && !s.dependencies.some((d) => waiting.has(d)),
  );
}

function defaultRun(pkg, root) {
  execFileSync('corepack', ['pnpm', '--filter', pkg.name, 'run', 'build'], {
    stdio: 'inherit',
    cwd: root,
  });
}

/**
 * Force-rebuild every package whose dist is older than a dependency's dist,
 * repeating until none is left (a rebuilt package can outdate its own
 * dependents) or a package that was already rebuilt is still stale, which is
 * left for the consistency check to report. Returns the names rebuilt, in
 * order. `run`, `remove` and `find` are injectable for tests.
 */
export function rebuildStaleDependents(
  root,
  {
    run = defaultRun,
    remove = (f) => rmSync(f, { force: true }),
    find = findStaleDependents,
    log = (m) => console.log(m),
  } = {},
) {
  const attempted = new Set();
  const rebuilt = [];
  for (;;) {
    const batch = nextRepairBatch(find(root), attempted);
    if (batch.length === 0) return rebuilt;
    for (const pkg of batch) {
      attempted.add(pkg.name);
      log(
        `rebuild-stale-dependents: ${pkg.name} lags ${pkg.dependencies.join(', ')}; forcing a rebuild`,
      );
      for (const f of tsBuildInfoFiles(pkg.dir)) remove(f);
      run(pkg, root);
      rebuilt.push(pkg.name);
    }
  }
}
