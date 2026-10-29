/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The re-attach loop of `qwen-rc attach` (InfiniteInsight/Qwen-Code-Remote#194
 * slice E).
 *
 * A terminal tab mirrors a daemon session. When the gateway restarts, every
 * pooled daemon dies and the tab's TUI is left on a dead session. The TUI
 * answers that by printing one line and exiting {@link TUI_DAEMON_GONE_EXIT};
 * this loop is what turns that exit into "wait for a daemon for the session to
 * come back, then run the TUI again" instead of a closed tab.
 *
 * Pure on purpose: running the TUI, asking the gateway, sleeping and reading
 * the clock are all injected, so every path is testable without a terminal,
 * a gateway or real time.
 *
 * Contract:
 * - The TUI exits with any code other than 75: that code is the result, no
 *   attach call is made.
 * - It exits 75: log `daemon gone, re-attaching <id>…` once, then ask the
 *   gateway (`attach`) until it answers. `ready` relaunches the TUI with the
 *   new argv (and the loop starts over if that one exits 75 too); `retry`
 *   sleeps and asks again; `stop` logs its message and ends with exit code 1.
 * - Sleeps start at 1 s and double up to 10 s. Each loss starts at 1 s again,
 *   unless the TUI that was lost had run for less than 10 s, in which case the
 *   delay carries over and also applies before the relaunch, so a pool that
 *   keeps answering 200 for a dead daemon cannot make this spin.
 * - After 15 minutes of failed attempts for one loss it logs one line and ends
 *   with exit code 1.
 * - An interrupt (Ctrl-C), watched for only while waiting, ends it with 130
 *   at once, including from inside a sleep or an attach call in flight.
 */

/** The exit code the TUI uses for "my daemon is gone" (sysexits EX_TEMPFAIL). */
export const TUI_DAEMON_GONE_EXIT = 75;

/** Exit code for an interrupt during the wait: 128 + SIGINT, as a shell reports it. */
export const INTERRUPTED_EXIT = 130;

export const REATTACH_INITIAL_BACKOFF_MS = 1_000;
export const REATTACH_MAX_BACKOFF_MS = 10_000;
export const REATTACH_GIVE_UP_MS = 15 * 60_000;
/** A TUI that ran at least this long counts as having worked. */
export const REATTACH_STABLE_RUN_MS = 10_000;

/** What one ask of the gateway came to. */
export type ReattachAttempt =
  /** A daemon holds the session: run the TUI with this argv, in this directory. */
  | { kind: 'ready'; linuxArgv: string[]; workspaceCwd: string }
  /** Not yet (daemon restarting, pool full, gateway not listening): ask again. */
  | { kind: 'retry'; reason: string }
  /** Never going to work (session gone, token refused): `message` is the one line to print. */
  | { kind: 'stop'; message: string };

export interface ReattachLoopDeps {
  sessionId: string;
  /** Run the TUI to completion and return its exit code. */
  run(linuxArgv: string[], cwd: string): Promise<number>;
  /** Ask the gateway for the session's attach material. Must not throw. */
  attach(): Promise<ReattachAttempt>;
  /** Resolve after `ms`, or earlier when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  /** One line to the user's stderr. */
  log(line: string): void;
  /**
   * Start listening for an interrupt; call `onInterrupt` when one arrives and
   * return the undo. Called once per wait, never while the TUI runs (the TUI
   * owns Ctrl-C then). Without it nothing can interrupt the wait.
   */
  watchInterrupt?(onInterrupt: () => void): () => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  giveUpMs?: number;
  stableRunMs?: number;
}

/** Resolves to `'aborted'` as soon as `signal` aborts, otherwise to the value. */
function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise<T | 'aborted'>((resolve, reject) => {
    const onAbort = (): void => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Run the TUI, and re-attach each time it reports its daemon gone. Returns the
 * wrapper's exit code.
 */
export async function runWithReattach(
  first: { linuxArgv: string[]; workspaceCwd: string },
  deps: ReattachLoopDeps,
): Promise<number> {
  const initial = deps.initialBackoffMs ?? REATTACH_INITIAL_BACKOFF_MS;
  const max = deps.maxBackoffMs ?? REATTACH_MAX_BACKOFF_MS;
  const giveUp = deps.giveUpMs ?? REATTACH_GIVE_UP_MS;
  const stable = deps.stableRunMs ?? REATTACH_STABLE_RUN_MS;

  let target = first;
  let delay = initial;
  for (;;) {
    const startedAt = deps.now();
    const code = await deps.run(target.linuxArgv, target.workspaceCwd);
    if (code !== TUI_DAEMON_GONE_EXIT) return code;

    deps.log(`daemon gone, re-attaching ${deps.sessionId}…`);
    const lostAt = deps.now();
    if (lostAt - startedAt >= stable) delay = initial;

    const interrupt = new AbortController();
    const unwatch = deps.watchInterrupt?.(() => interrupt.abort());
    try {
      const wait = async (): Promise<boolean> => {
        await deps.sleep(delay, interrupt.signal);
        delay = Math.min(delay * 2, max);
        return !interrupt.signal.aborted;
      };
      // A TUI that died right after starting means the last "ready" was a lie
      // (a pool entry for a daemon that is gone); wait before believing again.
      if (lostAt - startedAt < stable && !(await wait())) {
        return INTERRUPTED_EXIT;
      }
      let next: Extract<ReattachAttempt, { kind: 'ready' }> | undefined;
      while (next === undefined) {
        const got = await raceAbort(deps.attach(), interrupt.signal);
        if (got === 'aborted') return INTERRUPTED_EXIT;
        if (got.kind === 'stop') {
          deps.log(got.message);
          return 1;
        }
        if (got.kind === 'ready') {
          next = got;
          break;
        }
        if (deps.now() - lostAt >= giveUp) {
          deps.log(
            `qwen-rc attach: gave up re-attaching ${deps.sessionId} after ` +
              `${Math.round(giveUp / 60_000)} minutes (${got.reason})`,
          );
          return 1;
        }
        if (!(await wait())) return INTERRUPTED_EXIT;
      }
      target = { linuxArgv: next.linuxArgv, workspaceCwd: next.workspaceCwd };
    } finally {
      unwatch?.();
    }
  }
}
