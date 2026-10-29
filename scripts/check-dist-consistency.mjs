#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fails when a workspace package's `dist` is stale against its sources or
 * against the `dist` of a workspace package it depends on.
 *
 * The hazard (Qwen-Code-Remote#191): rebuilding one package (`core`, after a
 * `src/` change) without its dependents leaves `packages/cli/dist` importing a
 * name `packages/core/dist` no longer exports. Nothing notices until a daemon
 * or a terminal tab loads the bundle and dies with "does not provide an export
 * named ...". `npm run build` rebuilds everything in dependency order; this
 * check is the tripwire for the build that skipped something.
 *
 * "Built at" for a package is the newest file under its `dist`. Two things are
 * compared, for every workspace package that has a `dist`:
 *   1. the newest source file under its `src` (tests, snapshots and mocks
 *      excluded, because they never reach `dist`): a `dist` older than that
 *      was built before the last source edit;
 *   2. the "built at" of each workspace package named in its package.json
 *      `dependencies`: a `dist` older than that was built before a dependency
 *      changed.
 * A package without a `dist` is skipped (it was never built here); a package
 * without a `src` skips comparison 1.
 *
 * Plain Node, no dependencies. Exit 0 when consistent, 1 with a list when not.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_SKIP_DIRS = new Set([
  'node_modules',
  '__tests__',
  '__mocks__',
  '__snapshots__',
]);
const SOURCE_SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.snap$/;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Workspace package directories from the root `workspaces` globs. */
export function findWorkspaceDirs(root) {
  const rootPkg = readJson(join(root, 'package.json'));
  const patterns = Array.isArray(rootPkg?.workspaces)
    ? rootPkg.workspaces
    : (rootPkg?.workspaces?.packages ?? []);
  const included = new Set();
  const excluded = new Set();
  for (const raw of patterns) {
    const negate = raw.startsWith('!');
    const pattern = negate ? raw.slice(1) : raw;
    const target = negate ? excluded : included;
    if (pattern.endsWith('/*')) {
      const parent = join(root, pattern.slice(0, -2));
      if (!isDir(parent)) continue;
      for (const entry of readdirSync(parent)) {
        target.add(join(parent, entry));
      }
    } else {
      target.add(join(root, pattern));
    }
  }
  return [...included]
    .filter((dir) => !excluded.has(dir))
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .sort();
}

/**
 * Newest mtime (ms) of any file under `dir`, with the path that has it, or
 * undefined when there is no file. `skipSource` applies the test/mock
 * exclusions that only make sense for a `src` tree.
 */
export function newestFile(dir, skipSource = false) {
  let best;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        if (skipSource && SOURCE_SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (skipSource && SOURCE_SKIP_FILE.test(entry.name)) continue;
        const mtimeMs = statSync(full).mtimeMs;
        if (!best || mtimeMs > best.mtimeMs) best = { path: full, mtimeMs };
      }
    }
  };
  walk(dir);
  return best;
}

/**
 * Check every workspace package under `root`. Returns the problems found (an
 * empty array is consistent), plus the packages that were compared.
 */
export function checkDistConsistency(root) {
  const packages = [];
  for (const dir of findWorkspaceDirs(root)) {
    const pkg = readJson(join(dir, 'package.json'));
    if (!pkg?.name) continue;
    packages.push({
      name: pkg.name,
      dir,
      deps: Object.keys(pkg.dependencies ?? {}),
      dist: isDir(join(dir, 'dist'))
        ? newestFile(join(dir, 'dist'))
        : undefined,
    });
  }
  const byName = new Map(packages.map((p) => [p.name, p]));
  const problems = [];
  const checked = [];
  const rel = (p) => relative(root, p) || '.';
  const stamp = (ms) => new Date(ms).toISOString();

  for (const p of packages) {
    if (!p.dist) continue;
    checked.push(p.name);
    const srcDir = join(p.dir, 'src');
    const src = isDir(srcDir) ? newestFile(srcDir, true) : undefined;
    if (src && src.mtimeMs > p.dist.mtimeMs) {
      problems.push(
        `${p.name}: dist (${stamp(p.dist.mtimeMs)}) is older than its source ${rel(src.path)} (${stamp(src.mtimeMs)})`,
      );
    }
    for (const depName of p.deps) {
      const dep = byName.get(depName);
      if (!dep?.dist) continue;
      if (dep.dist.mtimeMs > p.dist.mtimeMs) {
        problems.push(
          `${p.name}: dist (${stamp(p.dist.mtimeMs)}) is older than the dist of its dependency ${depName} (${stamp(dep.dist.mtimeMs)}, ${rel(dep.dist.path)})`,
        );
      }
    }
  }
  return { problems, checked };
}

function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const { problems, checked } = checkDistConsistency(root);
  if (problems.length === 0) {
    console.log(
      `check-dist-consistency: ok (${checked.length} packages with a dist)`,
    );
    return 0;
  }
  console.error(
    'check-dist-consistency: the build is inconsistent. A package was rebuilt without its dependents (or not rebuilt after a source change), so a bundle can import names its dependency no longer exports:\n',
  );
  for (const line of problems) console.error(`  - ${line}`);
  console.error(
    '\nFix: run `npm run build` at the repository root, which rebuilds every package in dependency order.',
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
