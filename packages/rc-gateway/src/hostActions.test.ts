/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostActions,
  HostActionsConfigError,
  START_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  execFileRunner,
  findOnPath,
  parseHostActions,
  type HostActionRunner,
} from './hostActions.js';

const LAUNCHER = {
  launcher: {
    label: 'Qwen Remote Launcher',
    status: ['probe-launcher'],
    start: ['start-launcher', '--hidden'],
  },
};

/**
 * A runner that records every call and answers from a table keyed by the
 * argv's first word, so a test names what each program "does" without any
 * program being run.
 */
function fakeRunner(
  answer: (
    argv: readonly string[],
  ) =>
    | number
    | null
    | { code: null; error: string }
    | Promise<number | null | { code: null; error: string }>,
): HostActionRunner & { calls: Array<{ argv: string[]; timeoutMs: number }> } {
  const calls: Array<{ argv: string[]; timeoutMs: number }> = [];
  const run = (async (argv: readonly string[], timeoutMs: number) => {
    calls.push({ argv: [...argv], timeoutMs });
    const a = await answer(argv);
    return typeof a === 'object' && a !== null ? a : { code: a };
  }) as HostActionRunner & { calls: typeof calls };
  run.calls = calls;
  return run;
}

/** A PATH value of one directory under `dir` holding an executable for each name. */
async function pathWith(dir: string, names: string[]): Promise<string> {
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  for (const n of names) await writeFile(join(bin, n), '#!/bin/sh\n', { mode: 0o755 });
  return bin;
}

describe('parseHostActions', () => {
  it('loads the documented shape, in file order', () => {
    const actions = parseHostActions({
      ...LAUNCHER,
      'llama-2': { label: 'llama', status: ['a'], start: ['b'] },
    });
    expect(actions.map((a) => a.name)).toEqual(['launcher', 'llama-2']);
    expect(actions[0]).toEqual({
      name: 'launcher',
      label: 'Qwen Remote Launcher',
      status: ['probe-launcher'],
      start: ['start-launcher', '--hidden'],
    });
  });

  it('accepts an empty file body as no actions', () => {
    expect(parseHostActions({})).toEqual([]);
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['a string', 'launcher'],
  ])('refuses %s at the top level', (_what, raw) => {
    expect(() => parseHostActions(raw)).toThrow(HostActionsConfigError);
  });

  it.each([
    'Launcher',
    '9lives',
    '-dash',
    'has space',
    'under_score',
    'a'.repeat(33),
    '',
  ])('refuses the name %j', (name) => {
    expect(() =>
      parseHostActions({ [name]: LAUNCHER.launcher }),
    ).toThrow(/must match/);
  });

  it('accepts a 32-character name, the longest allowed', () => {
    const name = 'a' + 'b'.repeat(31);
    expect(parseHostActions({ [name]: LAUNCHER.launcher })[0]!.name).toBe(name);
  });

  it.each([
    ['a string argv', { status: 'probe-launcher' }],
    ['an empty argv', { start: [] }],
    ['a number in the argv', { status: ['probe', 1] }],
    ['an empty program', { start: ['', 'x'] }],
    ['a missing status', { status: undefined }],
  ])('refuses %s', (_what, patch) => {
    expect(() =>
      parseHostActions({ launcher: { ...LAUNCHER.launcher, ...patch } }),
    ).toThrow(HostActionsConfigError);
  });

  it.each([
    ['a missing label', undefined],
    ['a blank label', '   '],
    ['a label too long to draw', 'x'.repeat(81)],
  ])('refuses %s', (_what, label) => {
    expect(() =>
      parseHostActions({ launcher: { ...LAUNCHER.launcher, label } }),
    ).toThrow(/label/);
  });

  it('copies the argv, so a later edit to the parsed object cannot change what runs', () => {
    const raw = structuredClone(LAUNCHER);
    const [action] = parseHostActions(raw);
    raw.launcher.start.push('--evil');
    expect(action!.start).toEqual(['start-launcher', '--hidden']);
  });
});

describe('HostActions.open', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-host-actions-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves undefined when there is no file', async () => {
    expect(await HostActions.open(join(dir, 'host-actions.json'))).toBeUndefined();
  });

  it('loads a well-formed file', async () => {
    const path = join(dir, 'host-actions.json');
    await writeFile(path, JSON.stringify(LAUNCHER), { mode: 0o600 });
    const store = await HostActions.open(path, fakeRunner(() => 0));
    expect(store!.list()).toEqual([
      { name: 'launcher', label: 'Qwen Remote Launcher' },
    ]);
  });

  it('refuses a file that is not JSON', async () => {
    const path = join(dir, 'host-actions.json');
    await writeFile(path, '{ launcher: ', { mode: 0o600 });
    await expect(HostActions.open(path)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses a file of the wrong shape', async () => {
    const path = join(dir, 'host-actions.json');
    await writeFile(path, JSON.stringify({ launcher: { label: 'x' } }), {
      mode: 0o600,
    });
    await expect(HostActions.open(path)).rejects.toThrow(
      HostActionsConfigError,
    );
  });

  it('refuses a file another account can write, since it names what the phone runs', async () => {
    const path = join(dir, 'host-actions.json');
    await writeFile(path, JSON.stringify(LAUNCHER));
    await chmod(path, 0o664);
    await expect(HostActions.open(path)).rejects.toThrow(/chmod go-w/);
    await chmod(path, 0o644);
    expect(await HostActions.open(path, fakeRunner(() => 0))).toBeDefined();
  });

  it('refuses a path it cannot read as a file', async () => {
    // A directory reads as EISDIR, which is not "no file".
    await expect(HostActions.open(dir)).rejects.toThrow(/cannot read/);
  });
});

describe('HostActions.load (the boot path)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-host-actions-load-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('says nothing and loads nothing when there is no file', async () => {
    const lines: string[] = [];
    expect(
      await HostActions.load(join(dir, 'host-actions.json'), (l) => lines.push(l)),
    ).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('logs one line naming the file and the reason, and loads nothing, for a malformed file', async () => {
    const path = join(dir, 'host-actions.json');
    await writeFile(path, JSON.stringify({ Launcher: LAUNCHER.launcher }), {
      mode: 0o600,
    });
    const lines: string[] = [];
    expect(await HostActions.load(path, (l) => lines.push(l))).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(path);
    expect(lines[0]).toMatch(/must match/);
    expect(lines[0]).not.toContain('\n');
  });

  it('logs the names it loaded', async () => {
    const path = join(dir, 'host-actions.json');
    await writeFile(path, JSON.stringify(LAUNCHER), { mode: 0o600 });
    const lines: string[] = [];
    const bin = await pathWith(dir, ['probe-launcher', 'start-launcher']);
    const store = await HostActions.load(
      path,
      (l) => lines.push(l),
      fakeRunner(() => 0),
      bin,
    );
    expect(store?.has('launcher')).toBe(true);
    expect(lines).toEqual([`host-actions: 1 from ${path} (launcher)`]);
  });

  it('warns once per action for a bare program the unit PATH does not hold, naming the action and the program', async () => {
    const path = join(dir, 'host-actions.json');
    await writeFile(
      path,
      JSON.stringify({
        launcher: {
          label: 'Launcher',
          status: ['powershell.exe', '-Command', 'x'],
          start: ['powershell.exe', '-Command', 'y'],
        },
      }),
      { mode: 0o600 },
    );
    const lines: string[] = [];
    const bin = await pathWith(dir, []);
    const store = await HostActions.load(path, (l) => lines.push(l), fakeRunner(() => 0), bin);
    expect(store?.has('launcher')).toBe(true);
    const warns = lines.filter((l) => /PATH/.test(l));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('launcher');
    expect(warns[0]).toContain('powershell.exe');
    expect(warns[0]).toMatch(/does not include it/);
    expect(warns[0]).not.toContain('-Command');
    expect(warns[0]).not.toContain('\n');
  });

  it('names each missing program when status and start differ, and stays quiet for found ones and for paths', async () => {
    const path = join(dir, 'host-actions.json');
    await writeFile(
      path,
      JSON.stringify({
        a: { label: 'A', status: ['probe-a'], start: ['start-a'] },
        b: { label: 'B', status: ['/abs/probe'], start: ['./rel/start'] },
        c: { label: 'C', status: ['here'], start: ['here'] },
      }),
      { mode: 0o600 },
    );
    const lines: string[] = [];
    const bin = await pathWith(dir, ['probe-a', 'here']);
    await HostActions.load(path, (l) => lines.push(l), fakeRunner(() => 0), bin);
    const warns = lines.filter((l) => /PATH/.test(l));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('a:');
    expect(warns[0]).toContain('start-a');
    expect(warns[0]).not.toContain('probe-a');
  });
});

describe('findOnPath', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-host-actions-path-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds an executable on any directory of the PATH, and not a non-executable or a missing one', async () => {
    const bin = await pathWith(dir, ['tool']);
    await writeFile(join(dir, 'bin', 'plain'), '', { mode: 0o644 });
    expect(await findOnPath('tool', `/nonexistent:${bin}`)).toBe(true);
    expect(await findOnPath('plain', bin)).toBe(false);
    expect(await findOnPath('absent', bin)).toBe(false);
  });

  it('finds nothing on an unset or empty PATH', async () => {
    expect(await findOnPath('tool', undefined)).toBe(false);
    expect(await findOnPath('tool', '')).toBe(false);
  });
});

describe('HostActions.probe', () => {
  it('reads exit 0 as running, with the 10s cap', async () => {
    const run = fakeRunner(() => 0);
    const store = HostActions.fromConfig(LAUNCHER, run);
    expect(await store.probe('launcher')).toBe(true);
    expect(run.calls).toEqual([
      { argv: ['probe-launcher'], timeoutMs: STATUS_TIMEOUT_MS },
    ]);
    expect(STATUS_TIMEOUT_MS).toBe(10_000);
  });

  it.each([
    ['a nonzero exit', 1],
    ['no exit code (killed at the cap)', null],
  ])('reads %s as not running', async (_what, code) => {
    const store = HostActions.fromConfig(LAUNCHER, fakeRunner(() => code));
    expect(await store.probe('launcher')).toBe(false);
  });

  it('reads a runner that throws as not running, rather than rejecting', async () => {
    const store = HostActions.fromConfig(
      LAUNCHER,
      fakeRunner(() => {
        throw new Error('spawn failed');
      }),
    );
    expect(await store.probe('launcher')).toBe(false);
  });

  it('reports a spawn failure as unknown with the code and the program basename, never the argv', async () => {
    const store = HostActions.fromConfig(
      {
        launcher: {
          label: 'L',
          status: ['powershell.exe', '-Command', 'secret-arg'],
          start: ['x'],
        },
        abs: {
          label: 'A',
          status: ['/mnt/c/Windows/System32/powershell.exe', '-Command', 'z'],
          start: ['x'],
        },
      },
      fakeRunner(() => ({ code: null, error: 'ENOENT' })),
    );
    expect(await store.check('launcher')).toEqual({
      running: false,
      error: 'ENOENT: powershell.exe',
    });
    expect(await store.check('abs')).toEqual({
      running: false,
      error: 'ENOENT: powershell.exe',
    });
    expect(await store.probe('launcher')).toBe(false);
  });

  it('carries no error for a program that ran and exited nonzero or was killed', async () => {
    const store = HostActions.fromConfig(LAUNCHER, fakeRunner(() => 1));
    expect(await store.check('launcher')).toEqual({ running: false });
    const killed = HostActions.fromConfig(LAUNCHER, fakeRunner(() => null));
    expect(await killed.check('launcher')).toEqual({ running: false });
    const up = HostActions.fromConfig(LAUNCHER, fakeRunner(() => 0));
    expect(await up.check('launcher')).toEqual({ running: true });
  });

  it('throws for a name it does not hold', async () => {
    const store = HostActions.fromConfig(LAUNCHER, fakeRunner(() => 0));
    await expect(store.probe('nope')).rejects.toThrow(RangeError);
    expect(store.has('nope')).toBe(false);
    expect(store.has('launcher')).toBe(true);
  });
});

describe('HostActions.start', () => {
  it('runs the start argv with the 20s cap, then probes, and reports running', async () => {
    let started = false;
    const run = fakeRunner((argv) => {
      if (argv[0] === 'start-launcher') {
        started = true;
        return 0;
      }
      return started ? 0 : 1;
    });
    const store = HostActions.fromConfig(LAUNCHER, run);
    expect(await store.probe('launcher')).toBe(false);
    expect(await store.start('launcher')).toEqual({ ok: true, running: true });
    expect(run.calls.slice(1)).toEqual([
      { argv: ['start-launcher', '--hidden'], timeoutMs: START_TIMEOUT_MS },
      { argv: ['probe-launcher'], timeoutMs: STATUS_TIMEOUT_MS },
    ]);
    expect(START_TIMEOUT_MS).toBe(20_000);
  });

  it('reports what the probe finds when the start exits 0 but nothing came up', async () => {
    const run = fakeRunner((argv) => (argv[0] === 'start-launcher' ? 0 : 1));
    const store = HostActions.fromConfig(LAUNCHER, run);
    expect(await store.start('launcher')).toEqual({ ok: true, running: false });
  });

  it.each([
    ['a nonzero exit', 3, 3],
    ['no exit code', null, null],
  ])('fails with the code on %s, and does not probe', async (_w, code, want) => {
    const run = fakeRunner(() => code);
    const store = HostActions.fromConfig(LAUNCHER, run);
    expect(await store.start('launcher')).toEqual({ ok: false, code: want });
    expect(run.calls).toHaveLength(1);
  });

  it('fails with no code when the runner throws', async () => {
    const store = HostActions.fromConfig(
      LAUNCHER,
      fakeRunner(() => {
        throw new Error('boom');
      }),
    );
    expect(await store.start('launcher')).toEqual({ ok: false, code: null });
  });

  it('reports a start that cannot be spawned with the code and program, and does not probe', async () => {
    const run = fakeRunner(() => ({ code: null, error: 'EACCES' }));
    const store = HostActions.fromConfig(LAUNCHER, run);
    expect(await store.start('launcher')).toEqual({
      ok: false,
      code: null,
      spawn: { code: 'EACCES', error: 'EACCES: start-launcher' },
    });
    expect(run.calls).toHaveLength(1);
  });

  it('joins a second press to the start already running rather than running the argv twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = fakeRunner(async (argv) => {
      if (argv[0] === 'start-launcher') await gate;
      return 0;
    });
    const store = HostActions.fromConfig(LAUNCHER, run);
    const a = store.start('launcher');
    const b = store.start('launcher');
    release();
    expect(await a).toEqual({ ok: true, running: true });
    expect(await b).toEqual({ ok: true, running: true });
    expect(run.calls.filter((c) => c.argv[0] === 'start-launcher')).toHaveLength(1);
    // Once it has finished, the next press is a new start.
    await store.start('launcher');
    expect(run.calls.filter((c) => c.argv[0] === 'start-launcher')).toHaveLength(2);
  });
});

// The real runner, against node itself rather than anything on the host, so
// the exit-code mapping and the cap are tested on a real child.
describe('execFileRunner', () => {
  const node = process.execPath;

  it('reports the exit code', async () => {
    expect(await execFileRunner([node, '-e', 'process.exit(0)'], 5000)).toEqual({ code: 0 });
    expect(await execFileRunner([node, '-e', 'process.exit(3)'], 5000)).toEqual({ code: 3 });
  });

  it('reports no code and the errno for a program that does not exist', async () => {
    expect(
      await execFileRunner(['/nonexistent/qwen-rc-host-action'], 5000),
    ).toEqual({ code: null, error: 'ENOENT' });
    expect(
      await execFileRunner(['qwen-rc-host-action-not-on-path'], 5000),
    ).toEqual({ code: null, error: 'ENOENT' });
  });

  it('reports the errno for a file it may not execute', async () => {
    const d = await mkdtemp(join(tmpdir(), 'rc-host-actions-eacces-'));
    try {
      const f = join(d, 'plain');
      await writeFile(f, '', { mode: 0o644 });
      expect(await execFileRunner([f], 5000)).toEqual({ code: null, error: 'EACCES' });
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('carries no error when the cap kills a child that did start', async () => {
    expect(
      await execFileRunner([node, '-e', 'setTimeout(() => {}, 10000)'], 200),
    ).toEqual({ code: null });
  });

  it('reports no code when the cap kills the child', async () => {
    const t0 = Date.now();
    expect(
      await execFileRunner([node, '-e', 'setTimeout(() => {}, 10000)'], 300),
    ).toEqual({ code: null });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('settles when the child exits even while something it started still holds its output', async () => {
    // What a start argv does: launch a program and return. The grandchild
    // inherits stdout and outlives its parent, and the answer must come when
    // the parent exits, not when the grandchild lets go of the pipe.
    const script =
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { stdio: 'inherit', detached: true }).unref()";
    const t0 = Date.now();
    expect(await execFileRunner([node, '-e', script], 10_000)).toEqual({ code: 0 });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
