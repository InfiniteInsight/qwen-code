/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isRunning,
  listDescendants,
  spawnTui,
  startTerminalGuard,
  terminalGoneReason,
  type SignalSource,
  type TerminalGuard,
} from './terminalGuard.js';

const PTY = '/dev/pts/7';

describe('terminalGoneReason', () => {
  it('is undefined while fd 0 still names the terminal', () => {
    expect(terminalGoneReason(PTY, PTY)).toBeUndefined();
    expect(terminalGoneReason('/dev/tty1', '/dev/tty1')).toBeUndefined();
  });

  it('says so when fd 0 reads as deleted (a closed tab, the measured case)', () => {
    expect(terminalGoneReason(PTY, `${PTY} (deleted)`)).toContain('(deleted)');
  });

  it('says so when fd 0 cannot be read or no longer names a terminal', () => {
    expect(terminalGoneReason(PTY, undefined)).toBeDefined();
    expect(terminalGoneReason(PTY, '/dev/null')).toContain('/dev/null');
    expect(terminalGoneReason(PTY, 'pipe:[9]')).toBeDefined();
  });

  it('never ends a wrapper that did not start on a live terminal', () => {
    for (const initial of [
      undefined,
      '/dev/null',
      'pipe:[1]',
      '/home/evan/in.txt',
      `${PTY} (deleted)`,
    ]) {
      expect(terminalGoneReason(initial, `${PTY} (deleted)`)).toBeUndefined();
      expect(terminalGoneReason(initial, undefined)).toBeUndefined();
    }
  });
});

/** A guard over a scripted fd 0 and a hand-cranked clock and signal source. */
function fakeGuard(initial: string | undefined = PTY) {
  let stdin: string | undefined = initial;
  let tick: (() => void) | undefined;
  let cleared = 0;
  const listeners = new Set<() => void>();
  const signals: SignalSource = {
    on: (_s, l) => void listeners.add(l),
    off: (_s, l) => void listeners.delete(l),
  };
  const guard = startTerminalGuard({
    readStdin: () => stdin,
    signals,
    setInterval: (fn) => {
      tick = fn;
      return 'timer';
    },
    clearInterval: () => void cleared++,
  });
  return {
    guard,
    setStdin: (v: string | undefined) => (stdin = v),
    poll: () => tick?.(),
    hup: () => [...listeners].forEach((l) => l()),
    listeners,
    cleared: () => cleared,
  };
}

describe('startTerminalGuard', () => {
  it('stays quiet while the terminal is there', () => {
    const f = fakeGuard();
    let fired = 0;
    f.guard.onGone(() => void fired++);
    f.poll();
    f.poll();
    expect(fired).toBe(0);
    expect(f.guard.gone()).toBe(false);
    expect(f.guard.reason()).toBeUndefined();
  });

  it('fires once, from the poll, when fd 0 reads as deleted', () => {
    const f = fakeGuard();
    let fired = 0;
    f.guard.onGone(() => void fired++);
    f.setStdin(`${PTY} (deleted)`);
    f.poll();
    f.poll();
    expect(fired).toBe(1);
    expect(f.guard.reason()).toContain('(deleted)');
  });

  it('fires from SIGHUP alone, before any poll', () => {
    const f = fakeGuard();
    let fired = 0;
    f.guard.onGone(() => void fired++);
    f.hup();
    expect(fired).toBe(1);
    expect(f.guard.reason()).toBe('SIGHUP');
  });

  it('gone() looks at fd 0 now, without waiting for the next poll', () => {
    const f = fakeGuard();
    let fired = 0;
    f.guard.onGone(() => void fired++);
    f.setStdin(`${PTY} (deleted)`);
    expect(f.guard.gone()).toBe(true);
    expect(fired).toBe(1);
  });

  it('an onGone registered after the fact fires at once; an undone one does not', () => {
    const f = fakeGuard();
    let late = 0;
    let undone = 0;
    const undo = f.guard.onGone(() => void undone++);
    undo();
    f.hup();
    f.guard.onGone(() => void late++);
    expect(late).toBe(1);
    expect(undone).toBe(0);
  });

  it('a throwing callback does not stop the others', () => {
    const f = fakeGuard();
    let second = 0;
    f.guard.onGone(() => {
      throw new Error('boom');
    });
    f.guard.onGone(() => void second++);
    f.hup();
    expect(second).toBe(1);
  });

  it('does nothing for a wrapper that started without a terminal', () => {
    const f = fakeGuard('/dev/null');
    f.setStdin(undefined);
    f.poll();
    expect(f.guard.gone()).toBe(false);
  });

  it('stop() ends the poll and releases SIGHUP', () => {
    const f = fakeGuard();
    expect(f.listeners.size).toBe(1);
    f.guard.stop();
    expect(f.listeners.size).toBe(0);
    expect(f.cleared()).toBe(1);
  });
});

function guardGoneOnDemand(): { guard: TerminalGuard; end: () => void } {
  const callbacks: Array<() => void> = [];
  const guard: TerminalGuard = {
    gone: () => false,
    reason: () => undefined,
    onGone: (cb) => {
      callbacks.push(cb);
      return () => {};
    },
    stop: () => {},
  };
  return { guard, end: () => callbacks.forEach((cb) => cb()) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('spawnTui', () => {
  it('resolves with the child exit status', async () => {
    const { guard } = guardGoneOnDemand();
    const r = await spawnTui('sh', ['-c', 'exit 7'], {}, guard);
    expect(r.status).toBe(7);
  });

  it('resolves with the spawn error when the command does not exist', async () => {
    const { guard } = guardGoneOnDemand();
    const r = await spawnTui('/nonexistent/qwen', [], {}, guard);
    expect(r.error).toBeDefined();
    expect(r.status).toBeNull();
  });

  it('SIGTERMs the child when the terminal goes', async () => {
    const { guard, end } = guardGoneOnDemand();
    const run = spawnTui('sleep', ['5'], {}, guard, { killGraceMs: 5_000 });
    setTimeout(end, 50);
    const r = await run;
    expect(r.signal).toBe('SIGTERM');
  });

  it('escalates to SIGKILL after the grace period for a child that ignores SIGTERM', async () => {
    const { guard, end } = guardGoneOnDemand();
    let pid = 0;
    const run = spawnTui(
      'sh',
      ['-c', 'trap "" TERM; sleep 5; sleep 5'],
      {},
      guard,
      {
        killGraceMs: 300,
        spawn: (c, a) => {
          const child = spawn(c, a, { stdio: 'ignore' });
          pid = child.pid ?? 0;
          return child;
        },
      },
    );
    // Give sh time to install its trap before the signal arrives.
    setTimeout(end, 200);
    const started = Date.now();
    const r = await run;
    expect(r.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(alive(pid)).toBe(false);
  });

  it('stops listening for the terminal once the child has exited', async () => {
    let undone = 0;
    const guard: TerminalGuard = {
      gone: () => false,
      reason: () => undefined,
      onGone: () => () => void undone++,
      stop: () => {},
    };
    await spawnTui('true', [], {}, guard);
    expect(undone).toBe(1);
  });
});

describe('listDescendants and isRunning', () => {
  async function fakeProc(
    rows: Array<{ pid: number; ppid: number; comm?: string; state?: string }>,
  ): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'rc-proc-'));
    for (const r of rows) {
      await mkdir(join(root, String(r.pid)));
      // The command name may hold spaces and parentheses.
      await writeFile(
        join(root, String(r.pid), 'stat'),
        `${r.pid} (${r.comm ?? 'node'}) ${r.state ?? 'S'} ${r.ppid} 1 1 0 -1 0`,
      );
    }
    await mkdir(join(root, 'self'));
    return root;
  }

  it('walks children and grandchildren, and nothing else', async () => {
    const root = await fakeProc([
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11, comm: 'a (b) c' },
      { pid: 13, ppid: 10 },
      { pid: 20, ppid: 1 },
      { pid: 21, ppid: 20 },
    ]);
    try {
      expect(listDescendants(10, root).sort()).toEqual([11, 12, 13]);
      expect(listDescendants(12, root)).toEqual([]);
      expect(listDescendants(99, root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is empty when /proc cannot be read, and isRunning is false for zombies and the absent', async () => {
    expect(listDescendants(1, '/nonexistent-proc-dir')).toEqual([]);
    const root = await fakeProc([
      { pid: 30, ppid: 1, state: 'Z' },
      { pid: 31, ppid: 1, state: 'S' },
    ]);
    try {
      expect(isRunning(30, root)).toBe(false);
      expect(isRunning(31, root)).toBe(true);
      expect(isRunning(32, root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('spawnTui ends the whole tree (#207: the TUI is two processes)', () => {
  it('kills a grandchild that survives its parent and ignores SIGTERM, before resolving', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-tree-'));
    const pidFile = join(dir, 'grandchild.pid');
    try {
      const { guard, end } = guardGoneOnDemand();
      // The outer sh dies on SIGTERM, as the real launcher does; the inner sh
      // is the UI process that is left behind and ignores it.
      const script = `sh -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 20; sleep 20' & wait`;
      const run = spawnTui('sh', ['-c', script], {}, guard, {
        killGraceMs: 400,
      });
      await new Promise((r) => setTimeout(r, 400));
      const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
      expect(isRunning(grandchild)).toBe(true);
      end();
      await run;
      expect(isRunning(grandchild)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
