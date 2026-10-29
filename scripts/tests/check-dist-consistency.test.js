/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDistConsistency } from '../check-dist-consistency.mjs';

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'check-dist-consistency.mjs',
);

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write `rel` under `root` and stamp it `secs` seconds after the epoch. */
function put(root, rel, secs, body = 'x') {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  utimesSync(full, secs, secs);
}

/**
 * A two-package workspace: app depends on lib. Times are seconds; lib src 100,
 * lib dist 200, app src 150, app dist 300 is the consistent baseline.
 */
function workspace(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'distcheck-'));
  dirs.push(root);
  put(
    root,
    'package.json',
    1,
    JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
  );
  put(root, 'packages/lib/package.json', 1, JSON.stringify({ name: '@x/lib' }));
  put(
    root,
    'packages/app/package.json',
    1,
    JSON.stringify({ name: '@x/app', dependencies: { '@x/lib': '*' } }),
  );
  const t = {
    libSrc: 100,
    libDist: 200,
    appSrc: 150,
    appDist: 300,
    ...overrides,
  };
  put(root, 'packages/lib/src/index.ts', t.libSrc);
  put(root, 'packages/lib/dist/index.js', t.libDist);
  put(root, 'packages/app/src/index.ts', t.appSrc);
  put(root, 'packages/app/dist/index.js', t.appDist);
  return root;
}

describe('checkDistConsistency', () => {
  it('passes when every dist is newer than its sources and dependencies', () => {
    const { problems, checked } = checkDistConsistency(workspace());
    expect(problems).toEqual([]);
    expect(checked.sort()).toEqual(['@x/app', '@x/lib']);
  });

  it('flags a dist older than its own newest source', () => {
    const root = workspace();
    put(root, 'packages/lib/src/deep/new.ts', 250);
    const { problems } = checkDistConsistency(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^@x\/lib: dist .* is older than its source packages\/lib\/src\/deep\/new\.ts/,
    );
  });

  it('flags the dependent when only the dependency was rebuilt (the #191 case)', () => {
    const root = workspace({ libDist: 400 });
    const { problems } = checkDistConsistency(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^@x\/app: dist .* older than the dist of its dependency @x\/lib/,
    );
  });

  it('ignores test files and test directories under src', () => {
    const root = workspace();
    put(root, 'packages/lib/src/index.test.ts', 900);
    put(root, 'packages/lib/src/__tests__/a.ts', 900);
    put(root, 'packages/lib/src/__snapshots__/a.snap', 900);
    expect(checkDistConsistency(root).problems).toEqual([]);
  });

  it('skips a package that has no dist, and a dist without a src', () => {
    const root = workspace();
    rmSync(join(root, 'packages/lib/dist'), { recursive: true });
    rmSync(join(root, 'packages/app/src'), { recursive: true });
    const { problems, checked } = checkDistConsistency(root);
    expect(problems).toEqual([]);
    expect(checked).toEqual(['@x/app']);
  });

  it('honours workspace exclusions', () => {
    const root = workspace({ libDist: 400 });
    put(
      root,
      'package.json',
      1,
      JSON.stringify({
        name: 'root',
        workspaces: ['packages/*', '!packages/app'],
      }),
    );
    expect(checkDistConsistency(root).problems).toEqual([]);
  });
});

describe('check-dist-consistency script', () => {
  it('prints ok or the fix hint when run as a command', () => {
    // The real tree may legitimately be unbuilt or stale; assert only the shape.
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    } catch (e) {
      code = e.status;
      out = String(e.stderr);
    }
    if (code === 0) expect(out).toMatch(/^check-dist-consistency: ok/);
    else expect(out).toMatch(/npm run build/);
  });
});
