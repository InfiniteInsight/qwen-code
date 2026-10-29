/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectBuildDrift,
  formatDaemonBinLine,
  formatDriftWarning,
  readDaemonVersion,
  resolveDaemonBin,
  resolveOnPath,
  terminalScriptPath,
  validateQwenBinPath,
} from './daemonBin.js';

let dir: string;
let scriptA: string;
let scriptB: string;
let linkToA: string;
let noExec: string;
let wrapper: string;
let binDir: string;

function exe(path: string, body = '#!/bin/sh\necho "1.2.3"\n'): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'daemonbin-')));
  scriptA = exe(join(dir, 'a.js'));
  scriptB = exe(join(dir, 'b.js'));
  linkToA = join(dir, 'link-to-a');
  symlinkSync(scriptA, linkToA);
  noExec = join(dir, 'plain.txt');
  writeFileSync(noExec, 'x');
  chmodSync(noExec, 0o644);
  wrapper = exe(join(dir, 'wrap.sh'), '#!/bin/sh\nexec node a.js "$@"\n');
  binDir = join(dir, 'bin');
  mkdirSync(binDir);
  exe(join(binDir, 'qwen'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validateQwenBinPath', () => {
  it('accepts an existing executable path and returns it absolute', () => {
    expect(validateQwenBinPath(scriptA, '--qwen-bin')).toBe(scriptA);
  });

  it('makes a relative path with a slash absolute against the cwd', () => {
    expect(validateQwenBinPath('./a.js', '--qwen-bin', dir)).toBe(
      join(dir, 'a.js'),
    );
  });

  it('fails fast on a path that does not exist, naming the source', () => {
    expect(() =>
      validateQwenBinPath(join(dir, 'nope'), 'QWEN_RC_QWEN_BIN'),
    ).toThrow(/QWEN_RC_QWEN_BIN: .*nope.* does not exist/);
  });

  it('fails fast on a file that is not executable', () => {
    expect(() => validateQwenBinPath(noExec, '--qwen-bin')).toThrow(
      /--qwen-bin: .*plain\.txt.* is not executable/,
    );
  });

  it('fails fast on a directory', () => {
    expect(() => validateQwenBinPath(binDir, '--qwen-bin')).toThrow(
      /not a file/,
    );
  });

  it('leaves a bare name alone, for the PATH resolution at boot', () => {
    expect(validateQwenBinPath('qwen', '--qwen-bin')).toBe('qwen');
  });

  it('rejects an empty value and a value that looks like another flag', () => {
    expect(() => validateQwenBinPath('', '--qwen-bin')).toThrow(/needs a path/);
    expect(() => validateQwenBinPath('--no-mdns', '--qwen-bin')).toThrow(
      /needs a path/,
    );
  });
});

describe('resolveOnPath', () => {
  it('finds an executable on the given PATH', () => {
    expect(resolveOnPath('qwen', `/nonexistent:${binDir}`)).toBe(
      join(binDir, 'qwen'),
    );
  });

  it('returns undefined when nothing matches or the match is not executable', () => {
    expect(resolveOnPath('qwen', '/nonexistent')).toBeUndefined();
    expect(resolveOnPath('plain.txt', dir)).toBeUndefined();
    expect(resolveOnPath('qwen', undefined)).toBeUndefined();
  });
});

describe('resolveDaemonBin', () => {
  it('defaults to qwen on PATH and marks it as not explicit', () => {
    expect(resolveDaemonBin(undefined, binDir)).toEqual({
      path: join(binDir, 'qwen'),
      found: true,
      explicit: false,
    });
  });

  it('reports a default that is not on PATH as not found, keeping the bare name', () => {
    expect(resolveDaemonBin(undefined, '/nonexistent')).toEqual({
      path: 'qwen',
      found: false,
      explicit: false,
    });
  });

  it('passes an absolute path straight through as explicit', () => {
    expect(resolveDaemonBin(scriptA, '/nonexistent')).toEqual({
      path: scriptA,
      found: true,
      explicit: true,
    });
  });

  it('resolves an explicit bare name on PATH', () => {
    expect(resolveDaemonBin('qwen', binDir)).toMatchObject({
      path: join(binDir, 'qwen'),
      found: true,
      explicit: true,
    });
  });
});

describe('readDaemonVersion', () => {
  it('returns the first line of --version output, trimmed', async () => {
    const bin = exe(
      join(dir, 'ver'),
      '#!/bin/sh\necho "  0.25.3 "\necho more\n',
    );
    await expect(readDaemonVersion(bin)).resolves.toBe('0.25.3');
  });

  it('returns undefined when the binary fails', async () => {
    const bin = exe(join(dir, 'bad'), '#!/bin/sh\nexit 3\n');
    await expect(readDaemonVersion(bin)).resolves.toBeUndefined();
  });

  it('returns undefined when the binary cannot be run at all', async () => {
    await expect(
      readDaemonVersion(join(dir, 'missing')),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the binary outlives the timeout', async () => {
    const bin = exe(join(dir, 'slow'), '#!/bin/sh\nsleep 5\necho 9\n');
    const t0 = Date.now();
    await expect(readDaemonVersion(bin, 150)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('formatDaemonBinLine', () => {
  it('states the path and the version', () => {
    expect(formatDaemonBinLine('/x/qwen', '0.25.3')).toBe(
      'qwen-rc serve: daemon qwen = /x/qwen (0.25.3)',
    );
  });

  it('says version unknown when there is none', () => {
    expect(formatDaemonBinLine('/x/qwen', undefined)).toBe(
      'qwen-rc serve: daemon qwen = /x/qwen (version unknown)',
    );
  });
});

describe('terminalScriptPath', () => {
  it('takes the last element ending in .js', () => {
    expect(terminalScriptPath(['node', '--inspect', '/p/dist/index.js'])).toBe(
      '/p/dist/index.js',
    );
    expect(terminalScriptPath(['node', '/p/dist/index.js', 'x.js'])).toBe(
      'x.js',
    );
  });

  it('otherwise takes the first element', () => {
    expect(terminalScriptPath(['/opt/qwen-wrapper', '--flag'])).toBe(
      '/opt/qwen-wrapper',
    );
  });
});

describe('detectBuildDrift', () => {
  it('reports nothing when the terminal and the daemon are the same file', () => {
    expect(detectBuildDrift(scriptA, ['node', scriptA], '')).toBeUndefined();
  });

  it('reports nothing when a symlink points at the same file', () => {
    expect(detectBuildDrift(linkToA, ['node', scriptA], '')).toBeUndefined();
    expect(detectBuildDrift(scriptA, ['node', linkToA], '')).toBeUndefined();
  });

  it('reports the two real paths when the files differ', () => {
    const d = detectBuildDrift(linkToA, ['node', scriptB], '');
    expect(d).toEqual({
      daemonReal: scriptA,
      terminalReal: scriptB,
      maybeWrapper: false,
    });
  });

  it('flags that a wrapper script was compared by path, not by content', () => {
    const d = detectBuildDrift(wrapper, ['node', scriptA], '');
    expect(d).toMatchObject({
      daemonReal: wrapper,
      terminalReal: scriptA,
      maybeWrapper: true,
    });
    const w = formatDriftWarning(d!);
    expect(w).toContain(wrapper);
    expect(w).toContain(scriptA);
    expect(w).toMatch(/WARNING/);
    expect(w).toMatch(/different builds/);
    expect(w).toMatch(/wrapper/);
  });

  it('resolves a bare first element on PATH when there is no .js element', () => {
    expect(
      detectBuildDrift(join(binDir, 'qwen'), ['qwen'], binDir),
    ).toBeUndefined();
  });

  it('reports nothing when either side cannot be resolved', () => {
    expect(
      detectBuildDrift(scriptA, ['node', join(dir, 'gone.js')], ''),
    ).toBeUndefined();
    expect(detectBuildDrift('qwen', ['node', scriptA], '')).toBeUndefined();
  });

  it('keeps the plain warning free of the wrapper note for two .js files', () => {
    const w = formatDriftWarning({
      daemonReal: '/a/cli.js',
      terminalReal: '/b/index.js',
      maybeWrapper: false,
    });
    expect(w).toBe(
      'qwen-rc serve: WARNING: the terminal (QWEN_RC_TERMINAL_QWEN) runs /b/index.js but the daemons run /a/cli.js: the terminal and the daemons run different builds',
    );
  });
});
