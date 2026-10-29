/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import {
  runWithReattach,
  TUI_DAEMON_GONE_EXIT,
  type ReattachAttempt,
  type ReattachLoopDeps,
} from './reattachLoop.js';

const SESSION = 'a9a5ddef-edc9-472e-8c52-ea6da2609e80';
const CWD = '/srv/work/proj';
const FIRST = { linuxArgv: ['qwen', '--first'], workspaceCwd: CWD };
const READY = (tag: string): ReattachAttempt => ({
  kind: 'ready',
  linuxArgv: ['qwen', `--${tag}`],
  workspaceCwd: CWD,
});
const RETRY: ReattachAttempt = { kind: 'retry', reason: 'gateway not up' };

/** A scripted harness: a fake clock that only sleeping and running a TUI move. */
function harness(opts: {
  exits: number[];
  attempts: ReattachAttempt[];
  /** How long each TUI run "lasts" on the fake clock. Default: long enough to count as stable. */
  runMs?: number;
}) {
  let clock = 1_000_000;
  const exits = [...opts.exits];
  const attempts = [...opts.attempts];
  const ran: Array<{ argv: string[]; cwd: string }> = [];
  const slept: number[] = [];
  const lines: string[] = [];
  let attemptCalls = 0;
  const deps: ReattachLoopDeps = {
    sessionId: SESSION,
    run: async (argv, cwd) => {
      ran.push({ argv, cwd });
      clock += opts.runMs ?? 60_000;
      const code = exits.shift();
      if (code === undefined) throw new Error('run called more than scripted');
      return code;
    },
    attach: async () => {
      attemptCalls++;
      const a = attempts.shift();
      if (a === undefined) throw new Error('attach called more than scripted');
      return a;
    },
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    log: (l) => lines.push(l),
  };
  return { deps, ran, slept, lines, attemptCalls: () => attemptCalls };
}

describe('runWithReattach', () => {
  it('passes any exit code other than 75 straight through, with no attach call', async () => {
    for (const code of [0, 1, 7, 130]) {
      const h = harness({ exits: [code], attempts: [] });
      expect(await runWithReattach(FIRST, h.deps)).toBe(code);
      expect(h.ran).toEqual([{ argv: FIRST.linuxArgv, cwd: CWD }]);
      expect(h.lines).toEqual([]);
      expect(h.attemptCalls()).toBe(0);
    }
  });

  it('75 then 200 relaunches the TUI with the new argv and says so once', async () => {
    const h = harness({
      exits: [TUI_DAEMON_GONE_EXIT, 0],
      attempts: [READY('second')],
    });
    expect(await runWithReattach(FIRST, h.deps)).toBe(0);
    expect(h.ran.map((r) => r.argv)).toEqual([
      ['qwen', '--first'],
      ['qwen', '--second'],
    ]);
    expect(h.lines).toEqual([`daemon gone, re-attaching ${SESSION}…`]);
    expect(h.slept).toEqual([]);
  });

  it('runs the relaunch in the workspace the gateway answered with', async () => {
    const h = harness({
      exits: [TUI_DAEMON_GONE_EXIT, 0],
      attempts: [{ kind: 'ready', linuxArgv: ['q'], workspaceCwd: '/canon' }],
    });
    await runWithReattach(FIRST, h.deps);
    expect(h.ran[1]).toEqual({ argv: ['q'], cwd: '/canon' });
  });

  it('75 then 503, 503, 200 waits 1s then 2s between tries and then relaunches', async () => {
    const h = harness({
      exits: [TUI_DAEMON_GONE_EXIT, 0],
      attempts: [RETRY, RETRY, READY('back')],
    });
    expect(await runWithReattach(FIRST, h.deps)).toBe(0);
    expect(h.slept).toEqual([1000, 2000]);
    expect(h.attemptCalls()).toBe(3);
    expect(h.ran[1]?.argv).toEqual(['qwen', '--back']);
    expect(h.lines).toHaveLength(1);
  });

  it('doubles the wait up to a 10s cap', async () => {
    const h = harness({
      exits: [TUI_DAEMON_GONE_EXIT, 0],
      attempts: [RETRY, RETRY, RETRY, RETRY, RETRY, RETRY, RETRY, READY('x')],
    });
    await runWithReattach(FIRST, h.deps);
    expect(h.slept).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });

  it('stops on a final refusal, printing its message and exiting 1', async () => {
    const h = harness({
      exits: [TUI_DAEMON_GONE_EXIT],
      attempts: [{ kind: 'stop', message: 'qwen-rc attach: no conversation' }],
    });
    expect(await runWithReattach(FIRST, h.deps)).toBe(1);
    expect(h.lines).toEqual([
      `daemon gone, re-attaching ${SESSION}…`,
      'qwen-rc attach: no conversation',
    ]);
    expect(h.ran).toHaveLength(1);
    expect(h.slept).toEqual([]);
  });

  it('stops after a few retries when the answer turns final', async () => {
    const h = harness({
      exits: [TUI_DAEMON_GONE_EXIT],
      attempts: [RETRY, RETRY, { kind: 'stop', message: 'gone for good' }],
    });
    expect(await runWithReattach(FIRST, h.deps)).toBe(1);
    expect(h.slept).toEqual([1000, 2000]);
    expect(h.lines.at(-1)).toBe('gone for good');
  });

  it('gives up with one line after 15 minutes of retries', async () => {
    const h = harness({
      exits: [TUI_DAEMON_GONE_EXIT],
      attempts: Array.from({ length: 500 }, () => RETRY),
    });
    expect(await runWithReattach(FIRST, h.deps)).toBe(1);
    const total = h.slept.reduce((a, b) => a + b, 0);
    // It tried for the whole window and stopped on the first attempt past it.
    expect(total).toBeGreaterThanOrEqual(15 * 60_000);
    expect(total).toBeLessThan(15 * 60_000 + 10_000);
    expect(h.lines).toHaveLength(2);
    expect(h.lines[1]).toContain(SESSION);
    expect(h.lines[1]).toContain('15 minutes');
    expect(h.ran).toHaveLength(1);
  });

  it('starts a fresh 15 minute window and fresh backoff for each loss', async () => {
    const h = harness({
      exits: [TUI_DAEMON_GONE_EXIT, TUI_DAEMON_GONE_EXIT, 0],
      attempts: [RETRY, READY('a'), RETRY, READY('b')],
    });
    expect(await runWithReattach(FIRST, h.deps)).toBe(0);
    expect(h.slept).toEqual([1000, 1000]);
    expect(h.lines).toEqual([
      `daemon gone, re-attaching ${SESSION}…`,
      `daemon gone, re-attaching ${SESSION}…`,
    ]);
  });

  it('backs off before relaunching when the TUI keeps dying right away', async () => {
    // A pool that still believes in a dead daemon answers 200 every time and
    // the TUI exits 75 at once; without this the wrapper would spin.
    const h = harness({
      exits: [TUI_DAEMON_GONE_EXIT, TUI_DAEMON_GONE_EXIT, 0],
      attempts: [READY('a'), READY('b')],
      runMs: 50,
    });
    expect(await runWithReattach(FIRST, h.deps)).toBe(0);
    expect(h.slept).toEqual([1000, 2000]);
  });

  it('exits 130 when interrupted during the wait, without another attach call', async () => {
    let abort: (() => void) | undefined;
    let undone = 0;
    const h = harness({
      exits: [TUI_DAEMON_GONE_EXIT],
      attempts: [RETRY, RETRY],
    });
    h.deps.watchInterrupt = (fn) => {
      abort = fn;
      return () => void undone++;
    };
    h.deps.sleep = async (ms) => {
      h.slept.push(ms);
      abort?.();
    };
    expect(await runWithReattach(FIRST, h.deps)).toBe(130);
    expect(h.attemptCalls()).toBe(1);
    expect(h.ran).toHaveLength(1);
    expect(undone).toBe(1);
  });

  it('exits 130 when interrupted while an attach call is in flight', async () => {
    let abort: (() => void) | undefined;
    const h = harness({ exits: [TUI_DAEMON_GONE_EXIT], attempts: [] });
    h.deps.watchInterrupt = (fn) => {
      abort = fn;
      return () => {};
    };
    h.deps.attach = () =>
      new Promise<ReattachAttempt>(() => {
        queueMicrotask(() => abort?.());
      });
    expect(await runWithReattach(FIRST, h.deps)).toBe(130);
  });

  it('only watches for interrupts while waiting, not while the TUI runs', async () => {
    const events: string[] = [];
    const h = harness({
      exits: [TUI_DAEMON_GONE_EXIT, 0],
      attempts: [READY('b')],
    });
    const run = h.deps.run;
    h.deps.run = async (a, c) => {
      events.push('run');
      return run(a, c);
    };
    h.deps.watchInterrupt = () => {
      events.push('watch');
      return () => void events.push('unwatch');
    };
    await runWithReattach(FIRST, h.deps);
    expect(events).toEqual(['run', 'watch', 'unwatch', 'run']);
  });
});
