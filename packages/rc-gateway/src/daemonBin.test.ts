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
  formatBrokenBuildWarning,
  formatDriftWarning,
  probeDaemonBin,
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

describe('probeDaemonBin (#191)', () => {
  const ESM_ERROR =
    "SyntaxError: The requested module '@qwen-code/qwen-code-core' does not provide an export named 'projectGoalStateToLegacy'";

  it('is healthy when --version exits 0 with a clean stderr', async () => {
    const bin = exe(join(dir, 'probe-ok'), '#!/bin/sh\necho 0.25.3\n');
    await expect(probeDaemonBin(bin)).resolves.toEqual({
      version: '0.25.3',
      healthy: true,
      problem: undefined,
    });
  });

  it('is unhealthy when the bundle dies on a missing export, naming the first stderr line', async () => {
    const bin = exe(
      join(dir, 'probe-esm'),
      `#!/bin/sh\necho "file:///x/cli/dist/index.js:1" >&2\necho "${ESM_ERROR}" >&2\nexit 1\n`,
    );
    const probe = await probeDaemonBin(bin);
    expect(probe.healthy).toBe(false);
    expect(probe.version).toBeUndefined();
    expect(probe.problem).toBe('file:///x/cli/dist/index.js:1');
  });

  it('is unhealthy on ERR_MODULE_NOT_FOUND', async () => {
    const bin = exe(
      join(dir, 'probe-nf'),
      '#!/bin/sh\necho "Error [ERR_MODULE_NOT_FOUND]: Cannot find module \'/x/dist/a.js\'" >&2\nexit 1\n',
    );
    const probe = await probeDaemonBin(bin);
    expect(probe.healthy).toBe(false);
    expect(probe.problem).toMatch(/^Error \[ERR_MODULE_NOT_FOUND\]/);
  });

  it('is unhealthy on any non-zero exit, with the exit code when stderr is empty', async () => {
    const bin = exe(join(dir, 'probe-exit'), '#!/bin/sh\nexit 3\n');
    await expect(probeDaemonBin(bin)).resolves.toEqual({
      version: undefined,
      healthy: false,
      problem: 'exited with code 3',
    });
  });

  it('is unhealthy when a load error is printed even though the exit was 0', async () => {
    const bin = exe(
      join(dir, 'probe-zero'),
      `#!/bin/sh\necho "${ESM_ERROR}" >&2\necho 0.25.3\n`,
    );
    const probe = await probeDaemonBin(bin);
    expect(probe.healthy).toBe(false);
    expect(probe.version).toBe('0.25.3');
    expect(probe.problem).toBe(ESM_ERROR);
  });

  it('stays healthy when stderr carries an unrelated warning', async () => {
    const bin = exe(
      join(dir, 'probe-warn'),
      '#!/bin/sh\necho "ExperimentalWarning: something" >&2\necho 1.0.0\n',
    );
    expect((await probeDaemonBin(bin)).healthy).toBe(true);
  });

  it('cannot say anything about a binary that is missing or too slow', async () => {
    const missing = await probeDaemonBin(join(dir, 'probe-missing'));
    expect(missing.healthy).toBeUndefined();
    const slow = exe(join(dir, 'probe-slow'), '#!/bin/sh\nsleep 5\n');
    const t0 = Date.now();
    expect((await probeDaemonBin(slow, 150)).healthy).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('formatBrokenBuildWarning (#191)', () => {
  it('names the binary and first stderr line, says the build is inconsistent, and gives the fix', () => {
    const line = formatBrokenBuildWarning('/x/qwen-fork', {
      version: undefined,
      healthy: false,
      problem: 'SyntaxError: nope',
    });
    expect(line).toBe(
      'qwen-rc serve: WARNING: the daemon qwen /x/qwen-fork failed its import check (SyntaxError: nope): the build is inconsistent (a workspace package was rebuilt without the packages that depend on it), so every daemon and terminal tab started from it will die on load. Fix: run `npm run build` at the fork root.',
    );
  });

  it('says nothing for a healthy or inconclusive probe', () => {
    for (const healthy of [true, undefined]) {
      expect(
        formatBrokenBuildWarning('/x/q', {
          version: '1',
          healthy,
          problem: undefined,
        }),
      ).toBeUndefined();
    }
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
