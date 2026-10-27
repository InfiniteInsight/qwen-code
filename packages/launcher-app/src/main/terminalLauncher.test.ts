/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import {
  buildWtArgs,
  drainTerminalRequests,
  parsePending,
  pendingCommand,
  TERMINAL_COALESCE_MS,
  type TerminalRequest,
} from './terminalLauncher.js';

function req(over: Partial<TerminalRequest> = {}): TerminalRequest {
  return {
    id: 'r1',
    sessionId: 'sess-1',
    workspaceCwd: '/srv/work/proj',
    daemonUrl: 'http://127.0.0.1:46135',
    daemonToken: 'tok',
    linuxArgv: [
      'qwen',
      '--attach-daemon',
      'http://127.0.0.1:46135',
      '--daemon-token',
      'tok',
    ],
    title: 'qwen sess-1',
    createdAt: 1,
    ...over,
  };
}

function page(requests: TerminalRequest[], cursor: number): string {
  return JSON.stringify({ cursor, requests });
}

describe('parsePending', () => {
  it('reads a well-formed page', () => {
    const out = parsePending(page([req()], 7), 0);
    expect(out.cursor).toBe(7);
    expect(out.requests).toHaveLength(1);
  });

  it('falls back to the given cursor on unparseable output', () => {
    const out = parsePending('not json', 4);
    expect(out).toEqual({ cursor: 4, requests: [] });
  });

  it('drops entries the launcher could not run', () => {
    const raw = JSON.stringify({
      cursor: 3,
      requests: [req(), { ...req({ id: 'r2' }), linuxArgv: [] }, { id: 'r3' }],
    });
    expect(parsePending(raw, 0).requests.map((r) => r.id)).toEqual(['r1']);
  });
});

describe('buildWtArgs', () => {
  it('opens a tab in the workspace and runs the composed command', () => {
    expect(buildWtArgs(req(), { distro: 'Ubuntu-24.04' })).toEqual([
      'new-tab',
      '--title',
      'qwen sess-1',
      'wsl.exe',
      '-d',
      'Ubuntu-24.04',
      '--cd',
      '/srv/work/proj',
      '--exec',
      'qwen',
      '--attach-daemon',
      'http://127.0.0.1:46135',
      '--daemon-token',
      'tok',
    ]);
  });

  it('omits -d when no distro is configured', () => {
    const args = buildWtArgs(req());
    expect(args).not.toContain('-d');
    expect(args.slice(3, 6)).toEqual(['wsl.exe', '--cd', '/srv/work/proj']);
  });
});

describe('pendingCommand', () => {
  it('asks for everything past the cursor', () => {
    expect(pendingCommand(12)).toBe(
      'qwen-rc terminals pending --after=12 --json',
    );
  });

  it('clamps a negative or fractional cursor', () => {
    expect(pendingCommand(-5)).toContain('--after=0');
    expect(pendingCommand(3.7)).toContain('--after=3');
  });
});

describe('drainTerminalRequests', () => {
  it('opens one tab per request and advances the cursor', async () => {
    const launched: string[][] = [];
    const deps = {
      runWsl: async () => ({
        code: 0,
        stdout: page([req(), req({ id: 'r2', sessionId: 's2' })], 2),
      }),
      execWt: async (args: string[]) => {
        launched.push(args);
      },
    };
    const open = new Map<string, number>();
    const out = await drainTerminalRequests(0, open, deps);
    expect(launched).toHaveLength(2);
    expect(out.opened).toEqual(['r1', 'r2']);
    expect(out.cursor).toBe(2);
    expect([...open.keys()]).toEqual(['sess-1', 's2']);
  });

  it('coalesces a repeat ask that arrives inside the window', async () => {
    let calls = 0;
    const deps = {
      runWsl: async () => ({ code: 0, stdout: page([req()], 5) }),
      execWt: async () => {
        calls++;
      },
    };
    const out = await drainTerminalRequests(4, new Map([['sess-1', 1]]), deps);
    expect(calls).toBe(0);
    expect(out.skipped).toEqual(['r1']);
    // Still advances: the request is handled, just not by opening a tab.
    expect(out.cursor).toBe(5);
  });

  it('stops at a failed launch and leaves the cursor behind it', async () => {
    const launched: string[] = [];
    const deps = {
      runWsl: async () => ({
        code: 0,
        stdout: page([req({ id: 'a' }), req({ id: 'b', sessionId: 's2' })], 2),
      }),
      execWt: async () => {
        throw new Error('Access is denied.');
      },
    };
    const out = await drainTerminalRequests(0, new Map(), deps);
    expect(out.opened).toEqual([]);
    expect(launched).toEqual([]);
    expect(out.failed.map((f) => f.id)).toEqual(['a']);
    expect(out.failed[0].error).toContain('Access is denied');
    // 'b' stays queued for the next pass.
    expect(out.cursor).toBe(0);
  });

  it('keeps the cursor when the fetch returns nothing readable', async () => {
    const deps = {
      runWsl: async () => ({ code: 1, stdout: 'qwen-rc: command not found' }),
      execWt: async () => {},
    };
    const out = await drainTerminalRequests(9, new Map(), deps);
    expect(out.cursor).toBe(9);
    expect(out.opened).toEqual([]);
    // Reported as its own state: an unreadable queue must not look like an
    // empty one, since the tray line is the only output a packaged app has.
    expect(out.fetchFailed).toBe(true);
  });

  it('reports an empty queue as readable', async () => {
    const deps = {
      runWsl: async () => ({ code: 0, stdout: page([], 9) }),
      execWt: async () => {},
    };
    expect((await drainTerminalRequests(9, new Map(), deps)).fetchFailed).toBe(
      false,
    );
  });

  it('never advances past what the log reports', async () => {
    const deps = {
      runWsl: async () => ({ code: 0, stdout: page([req()], 1) }),
      execWt: async () => {},
    };
    expect((await drainTerminalRequests(0, new Map(), deps)).cursor).toBe(1);
  });

  it('opens a later ask for the same session once the window passes', async () => {
    // The half the old set got wrong: a tab the user closed used to suppress
    // every future tab for that conversation for the life of the process,
    // which is days. A stamped request past the window opens its own tab.
    const arrived = 1 + TERMINAL_COALESCE_MS + 1;
    const launched: string[][] = [];
    const deps = {
      runWsl: async () => ({
        code: 0,
        stdout: page([req({ createdAt: arrived })], 2),
      }),
      execWt: async (args: string[]) => {
        launched.push(args);
      },
    };
    const open = new Map([['sess-1', 1]]);
    const out = await drainTerminalRequests(1, open, deps);
    expect(launched).toHaveLength(1);
    expect(out.opened).toEqual(['r1']);
    expect(out.skipped).toEqual([]);
    // Re-dated to this request, and not pruned: it is inside the window.
    expect(open.get('sess-1')).toBe(arrived);
  });

  it('coalesces a double click that arrives as two requests on one page', async () => {
    // The dedup the change must KEEP: with `sessionScope:'single'` every "New
    // conversation" in a workspace resolves the same session id, so a user
    // clicking twice really does get two identical requests in one poll.
    const launched: string[][] = [];
    const deps = {
      runWsl: async () => ({
        code: 0,
        stdout: page([req({ id: 'a' }), req({ id: 'b', createdAt: 2 })], 2),
      }),
      execWt: async (args: string[]) => {
        launched.push(args);
      },
    };
    const out = await drainTerminalRequests(0, new Map(), deps);
    expect(launched).toHaveLength(1);
    expect(out.opened).toEqual(['a']);
    expect(out.skipped).toEqual(['b']);
  });

  it('never lets an unstamped request suppress a later one', async () => {
    // The log read defaults a missing createdAt to 0, and 0 against a real
    // epoch stamp is a gap of half a century. An unstamped request cannot
    // support a window, so it must not be recorded as one.
    let calls = 0;
    const deps = {
      runWsl: async () => ({
        code: 0,
        stdout: page([req({ createdAt: 0 })], 5),
      }),
      execWt: async () => {
        calls++;
      },
    };
    const open = new Map([['sess-1', 1]]);
    const out = await drainTerminalRequests(4, open, deps);
    expect(calls).toBe(1);
    expect(out.skipped).toEqual([]);
    // The unstamped pass leaves the existing entry exactly as it was.
    expect(open.get('sess-1')).toBe(1);
  });

  it('drops entries past the window rather than keeping them for the run', async () => {
    // Unbounded growth is the other half of issue #68: the old set only ever
    // gained entries. The log moves forward, so a stale entry is dead weight.
    const deps = {
      runWsl: async () => ({
        code: 0,
        stdout: page([req({ sessionId: 's2', createdAt: 600_000 })], 3),
      }),
      execWt: async () => {},
    };
    const open = new Map([
      ['sess-1', 1],
      ['s2', 2],
    ]);
    const out = await drainTerminalRequests(2, open, deps);
    expect(out.opened).toEqual(['r1']);
    expect([...open.keys()]).toEqual(['s2']);
    expect(open.get('s2')).toBe(600_000);
  });
});
