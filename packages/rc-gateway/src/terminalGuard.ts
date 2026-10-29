/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End `qwen-rc attach` when its terminal goes away (InfiniteInsight/
 * Qwen-Code-Remote#207).
 *
 * Closing a Windows Terminal tab that runs `qwen-rc attach` left the wrapper
 * and its TUI child running for days, reparented to init, with
 * `/proc/<pid>/fd/0 -> /dev/pts/N (deleted)`. The mirror check then counted
 * the dead tab as a tab on screen and no new one opened.
 *
 * What was measured (2026-10-29, WSL2, a node probe on a pty that a python
 * driver created and then closed the master of; scripts are not kept, the
 * results are):
 *
 * - A process that is the pty's controlling terminal's session member (what a
 *   shell job is) gets SIGHUP when the master closes. A process started
 *   without a controlling terminal but with the pty on fds 0 to 2 (a setsid
 *   child, which is what a launcher that does not make the pty its controlling
 *   terminal produces) gets NO signal at all. SIGHUP is therefore not enough.
 * - In both cases `process.stdin` emits 'end' (then 'close') at once, as an
 *   EOF, not as an 'error' with EIO. But reading fd 0 to find that out would
 *   steal keystrokes from the TUI that shares the terminal, so the wrapper
 *   cannot use it while a TUI runs.
 * - In both cases `readlink /proc/self/fd/0` changes from `/dev/pts/N` to
 *   `/dev/pts/N (deleted)` within the same moment, and reading it consumes
 *   nothing. That is the signal this module polls, once a second, plus SIGHUP
 *   for the case where it arrives first.
 * - The TUI child sees the same EOF and does not exit (that is the orphan), so
 *   the wrapper has to end it: SIGTERM, then SIGKILL after a grace period. The
 *   TUI is also two processes (`dist/index.js` starts a second node to run the
 *   UI): in the no-controlling-terminal case SIGTERM to the first alone left
 *   the second alive on the deleted pty, so the signals go to the whole tree.
 * - `spawnSync` blocks the event loop, so neither a timer nor a signal handler
 *   can run while a TUI is under it. The wrapper therefore runs the TUI with
 *   the async `spawn`.
 *
 * The decision is a function of two readlink results, so it is testable with
 * no terminal at all.
 */

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { isLiveTerminalTarget } from './hostMirrors.js';

/** Exit code for a vanished terminal: 128 + SIGHUP, as a shell reports it. */
export const TERMINAL_GONE_EXIT = 129;

/** How often fd 0 is looked at. */
export const TERMINAL_POLL_MS = 1_000;

/** How long a TUI gets to exit on SIGTERM before it is sent SIGKILL. */
export const CHILD_KILL_GRACE_MS = 2_000;

/** Where this process's fd 0 points now; undefined when it cannot be read. */
export type StdinReader = () => string | undefined;

/** The default {@link StdinReader}: `readlink /proc/self/fd/0`. */
export const readOwnStdinTarget: StdinReader = () => {
  try {
    return readlinkSync('/proc/self/fd/0');
  } catch {
    return undefined;
  }
};

/**
 * Why the terminal counts as gone, or undefined when it does not. `initial` is
 * where fd 0 pointed when the wrapper started, `current` where it points now.
 *
 * A wrapper that did not start on a live terminal (stdin from a pipe, a file,
 * /dev/null, or /proc unreadable) has none to lose and is never ended by this.
 * Otherwise the terminal is gone when fd 0 reads as deleted, cannot be read, or
 * no longer names a terminal at all.
 */
export function terminalGoneReason(
  initial: string | undefined,
  current: string | undefined,
): string | undefined {
  if (!isLiveTerminalTarget(initial)) return undefined;
  if (current === undefined) return 'fd 0 can no longer be read';
  if (current.endsWith(' (deleted)')) return `fd 0 is ${current}`;
  if (!isLiveTerminalTarget(current)) return `fd 0 is now ${current}`;
  return undefined;
}

/** The slice of `process` the guard listens on; a test seam. */
export interface SignalSource {
  on(signal: 'SIGHUP', listener: () => void): unknown;
  off(signal: 'SIGHUP', listener: () => void): unknown;
}

export interface TerminalGuardDeps {
  readStdin?: StdinReader;
  pollMs?: number;
  signals?: SignalSource;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface TerminalGuard {
  /** True once the terminal is gone; looks at fd 0 right now, not at the last poll. */
  gone(): boolean;
  /** Why it is gone, once it is. */
  reason(): string | undefined;
  /**
   * Call `cb` when the terminal goes away (at once if it already has). Returns
   * the undo.
   */
  onGone(cb: () => void): () => void;
  /** Stop polling and release the SIGHUP listener. */
  stop(): void;
}

/**
 * Watch this process's terminal: SIGHUP, and fd 0 read as deleted, once a
 * second. Remembers where fd 0 pointed at the start. Never throws.
 */
export function startTerminalGuard(
  deps: TerminalGuardDeps = {},
): TerminalGuard {
  const readStdin = deps.readStdin ?? readOwnStdinTarget;
  const signals: SignalSource = deps.signals ?? process;
  const setIntervalFn =
    deps.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      // A watcher must never be what keeps the process alive.
      t.unref();
      return t;
    });
  const clearIntervalFn =
    deps.clearInterval ??
    ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));

  const initial = readStdin();
  const callbacks = new Set<() => void>();
  let why: string | undefined;

  const trigger = (reason: string): void => {
    if (why !== undefined) return;
    why = reason;
    for (const cb of [...callbacks]) {
      try {
        cb();
      } catch {
        // One failing callback must not stop the others from ending the TUI.
      }
    }
  };
  const check = (): void => {
    if (why !== undefined) return;
    const reason = terminalGoneReason(initial, readStdin());
    if (reason !== undefined) trigger(reason);
  };
  const onHup = (): void => trigger('SIGHUP');

  signals.on('SIGHUP', onHup);
  const timer = setIntervalFn(check, deps.pollMs ?? TERMINAL_POLL_MS);

  return {
    gone: () => {
      check();
      return why !== undefined;
    },
    reason: () => why,
    onGone: (cb) => {
      if (why !== undefined) {
        cb();
        return () => {};
      }
      callbacks.add(cb);
      return () => void callbacks.delete(cb);
    },
    stop: () => {
      clearIntervalFn(timer);
      signals.off('SIGHUP', onHup);
      callbacks.clear();
    },
  };
}

/** What {@link spawnTui} resolves to: the fields the wrapper reads off a run. */
export type TuiResult = Pick<
  SpawnSyncReturns<Buffer>,
  'status' | 'signal' | 'error'
>;

/**
 * The state letter of `pid` from `<procDir>/<pid>/stat`, or undefined when it
 * does not exist. The command name sits in parentheses and may hold spaces, so
 * the fields are counted from the last `)`.
 */
function procFields(pid: number, procDir: string): string[] | undefined {
  try {
    const stat = readFileSync(join(procDir, String(pid), 'stat'), 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  } catch {
    return undefined;
  }
}

/** Whether `pid` exists and is not a zombie. */
export function isRunning(pid: number, procDir = '/proc'): boolean {
  const f = procFields(pid, procDir);
  return f !== undefined && f[0] !== 'Z';
}

/**
 * Every descendant of `root` (children, grandchildren, ...) that is visible
 * under `procDir`, by walking parent pids. The TUI is not one process: `qwen`
 * starts a second node process to run the real UI, and that one is not killed
 * by a signal sent only to the first (measured on #207: the launcher exits on
 * SIGTERM and the UI is left running on the deleted pty).
 */
export function listDescendants(root: number, procDir = '/proc'): number[] {
  const children = new Map<number, number[]>();
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const f = procFields(Number(name), procDir);
    const ppid = f === undefined ? NaN : Number(f[1]);
    if (!Number.isInteger(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(Number(name));
    children.set(ppid, list);
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (found.includes(c)) continue;
      found.push(c);
      queue.push(c);
    }
  }
  return found;
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone, or not ours to signal.
    }
  }
}

export interface SpawnTuiDeps {
  spawn?: (
    command: string,
    args: string[],
    options: SpawnSyncOptions,
  ) => ChildProcess;
  killGraceMs?: number;
  /** How often the tree is looked at while it is being ended. */
  killPollMs?: number;
}

/**
 * Run the TUI with the terminal handed straight through, and end it when the
 * terminal goes away: SIGTERM to it and everything under it, then SIGKILL to
 * whatever is left after `killGraceMs`. Asynchronous on purpose, see the module
 * comment: a blocked event loop cannot notice the terminal going. Resolves with
 * the child's exit status or signal; when the terminal went, only once the
 * whole tree is gone (or twice the grace has passed). Never rejects.
 */
export function spawnTui(
  command: string,
  args: string[],
  options: SpawnSyncOptions,
  guard: TerminalGuard,
  deps: SpawnTuiDeps = {},
): Promise<TuiResult> {
  const doSpawn =
    deps.spawn ??
    ((c: string, a: string[], o: SpawnSyncOptions) =>
      nodeSpawn(c, a, { stdio: 'inherit', cwd: o.cwd }));
  const grace = deps.killGraceMs ?? CHILD_KILL_GRACE_MS;
  const pollMs = deps.killPollMs ?? 50;
  return new Promise<TuiResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = doSpawn(command, args, options);
    } catch (error) {
      resolve({ status: null, signal: null, error: error as Error });
      return;
    }
    let done = false;
    let ending = false;
    let childResult: TuiResult | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: TuiResult): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      undo();
      resolve(result);
    };
    const end = (): void => {
      const pid = child.pid;
      if (done || ending || pid === undefined) return;
      ending = true;
      const tree = [pid, ...listDescendants(pid)];
      signalAll(tree, 'SIGTERM');
      const startedAt = Date.now();
      let killed = false;
      const tick = (): void => {
        if (done) return;
        const elapsed = Date.now() - startedAt;
        // Anything the TUI started after the first look counts too.
        const everyone = [
          ...new Set([
            ...tree,
            ...(isRunning(pid) ? listDescendants(pid) : []),
          ]),
        ];
        const live = everyone.filter((p) => isRunning(p));
        if (live.length === 0) {
          finish(childResult ?? { status: null, signal: 'SIGTERM' });
          return;
        }
        if (!killed && elapsed >= grace) {
          killed = true;
          signalAll(live, 'SIGKILL');
        }
        // SIGKILL cannot be caught, but a process stuck in the kernel may not
        // go for a while; the wrapper must not wait on it forever.
        if (elapsed >= 2 * grace) {
          finish(childResult ?? { status: null, signal: 'SIGKILL' });
          return;
        }
        timer = setTimeout(tick, pollMs);
      };
      timer = setTimeout(tick, pollMs);
    };
    const undo = guard.onGone(end);
    child.on('error', (error) => finish({ status: null, signal: null, error }));
    child.on('close', (status, signal) => {
      childResult = { status, signal };
      if (!ending) finish(childResult);
    });
  });
}
