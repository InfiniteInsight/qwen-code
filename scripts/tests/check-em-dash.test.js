/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findDashViolations,
  formatViolations,
  isExempt,
  selfIsClean,
} from '../check-em-dash.mjs';

const EM = '\u2014';
const EN = '\u2013';
const CHECKER = fileURLToPath(new URL('../check-em-dash.mjs', import.meta.url));

const temporaryDirectories = [];

function makeTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'em-dash-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A staged diff where `text` is the single added line, with two lines of
 * context above it so the ratchet property is exercised at the same time.
 */
function diffWithAddedLine(text, path = 'src/a.ts') {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,0 +1,1 @@',
    `+${text}`,
    '',
  ].join('\n');
}

describe('findDashViolations', () => {
  it('flags an added em dash and names it', () => {
    const violations = findDashViolations(
      diffWithAddedLine(`// a comment with a dash${EM}in it`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toBe('src/a.ts');
    expect(violations[0].kinds).toEqual(['em dash']);
  });

  it('flags an added en dash and names it', () => {
    const violations = findDashViolations(
      diffWithAddedLine(`// a range 1${EN}4`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].kinds).toEqual(['en dash']);
  });

  it('names both when a line carries both', () => {
    const violations = findDashViolations(
      diffWithAddedLine(`// ${EM} and ${EN}`),
    );
    expect(violations[0].kinds.sort()).toEqual(['em dash', 'en dash']);
  });

  it('accepts a hyphen', () => {
    expect(findDashViolations(diffWithAddedLine('// a range 1-4'))).toEqual([]);
  });

  it('accepts the escape spelling, which is how code names the character', () => {
    expect(
      findDashViolations(diffWithAddedLine("const dash = '\\u2014';")),
    ).toEqual([]);
  });

  it('does not blame a commit for the pre-existing backlog around it', () => {
    // The whole point of reading added lines: a file dense with historical
    // dashes stays committable as long as the new line is clean.
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -4,2 +5,1 @@',
      ` // an old line with a dash${EM} in it`,
      ` // another old line with a dash${EN} in it`,
      '+const added = 1; // clean',
      '',
    ].join('\n');
    expect(findDashViolations(diff)).toEqual([]);
  });

  it('ignores a removed line that carried a dash', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      `-// sweeping out a dash${EM}`,
      '+// replaced with a hyphen',
      '',
    ].join('\n');
    expect(findDashViolations(diff)).toEqual([]);
  });

  it('reports the line number from the hunk header, not the diff offset', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,0 +42,1 @@',
      `+// a dash${EM} on line 42`,
      '',
    ].join('\n');
    const violations = findDashViolations(diff);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(42);
  });

  it('counts several added lines independently', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,0 +1,3 @@',
      '+const clean = 1;',
      `+const bad = 2; // ${EM}`,
      '+const alsoClean = 3;',
      '',
    ].join('\n');
    const violations = findDashViolations(diff);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
  });

  it('handles a multi-file diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,0 +1,1 @@',
      '+const a = 1;',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,0 +1,1 @@',
      `+const b = 2; // ${EM}`,
      '',
    ].join('\n');
    const violations = findDashViolations(diff);
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toBe('src/b.ts');
  });

  it('skips a deleted file', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ /dev/null',
      `@@ -1,1 +0,0 @@`,
      `-// gone${EM}`,
      '',
    ].join('\n');
    expect(findDashViolations(diff)).toEqual([]);
  });
});

describe('isExempt', () => {
  it.each([
    'pnpm-lock.yaml',
    'packages/app/pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'Cargo.lock',
    'go.sum',
    'src/__snapshots__/a.test.ts.snap',
    'public/vendor/lib.min.js',
    'dist/cli.js',
    'node_modules/iconv-lite/encodings/sbcs-data-generated.js',
  ])('exempts generated or vendored %s', (path) => {
    expect(isExempt(path)).toBe(true);
  });

  it.each([
    'src/cli.ts',
    'packages/rc-gateway/public/index.html',
    'README.md',
    'docs/design/thing.md',
  ])('checks authored %s', (path) => {
    expect(isExempt(path)).toBe(false);
  });
});

describe('formatViolations', () => {
  it('points at the file, the line, and the fix', () => {
    const output = formatViolations([
      {
        path: 'src/a.ts',
        line: 7,
        kinds: ['em dash'],
        text: `// a dash${EM}`,
      },
    ]);
    expect(output).toContain('src/a.ts:7');
    expect(output).toContain('em dash');
    expect(output).toContain('hyphen');
  });
});

describe('selfIsClean', () => {
  it('holds no literal dash, so the checker passes its own rule', () => {
    expect(selfIsClean()).toBe(true);
  });
});

describe('the checker as a command', () => {
  function initRepo() {
    const repo = makeTemporaryDirectory();
    const run = (args) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    return repo;
  }

  function runChecker(repo, args = []) {
    try {
      const out = execFileSync(process.execPath, [CHECKER, ...args], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (error) {
      return { code: error.status, out: `${error.stdout}${error.stderr}` };
    }
  }

  it('exits 0 when nothing staged carries a dash', () => {
    const repo = initRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'src', 'a.ts'),
      'export const a = 1; // hyphen -\n',
    );
    execFileSync('git', ['add', '.'], { cwd: repo });
    expect(runChecker(repo).code).toBe(0);
  });

  it('exits 1 and names the file when a staged line carries a dash', () => {
    const repo = initRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), `export const a = 1; // ${EM}\n`);
    execFileSync('git', ['add', '.'], { cwd: repo });
    const result = runChecker(repo);
    expect(result.code).toBe(1);
    expect(result.out).toContain('src/a.ts');
    expect(result.out).toContain('em dash');
  });

  it('lets a commit remove a dash without being blocked by it', () => {
    const repo = initRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    const target = join(repo, 'src', 'a.ts');
    writeFileSync(target, `export const a = 1; // ${EM}\n`);
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo });

    // The seed line is pre-existing now, so the sweep commit is not blamed.
    writeFileSync(target, 'export const a = 1; // -\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    expect(runChecker(repo).code).toBe(0);
  });

  it('exempts a lockfile it did not type', () => {
    const repo = initRepo();
    writeFileSync(join(repo, 'pnpm-lock.yaml'), `# a dash ${EM}\n`);
    execFileSync('git', ['add', '.'], { cwd: repo });
    expect(runChecker(repo).code).toBe(0);
  });
});
