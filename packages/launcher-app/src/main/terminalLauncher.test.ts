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
    const open = new Set<string>();
    const out = await drainTerminalRequests(0, open, deps);
    expect(launched).toHaveLength(2);
    expect(out.opened).toEqual(['r1', 'r2']);
    expect(out.cursor).toBe(2);
    expect([...open]).toEqual(['sess-1', 's2']);
  });

  it('does not open a second tab for a session already shown', async () => {
    let calls = 0;
    const deps = {
      runWsl: async () => ({ code: 0, stdout: page([req()], 5) }),
      execWt: async () => {
        calls++;
      },
    };
    const out = await drainTerminalRequests(4, new Set(['sess-1']), deps);
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
    const out = await drainTerminalRequests(0, new Set(), deps);
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
    const out = await drainTerminalRequests(9, new Set(), deps);
    expect(out.cursor).toBe(9);
    expect(out.opened).toEqual([]);
  });

  it('never advances past what the log reports', async () => {
    const deps = {
      runWsl: async () => ({ code: 0, stdout: page([req()], 1) }),
      execWt: async () => {},
    };
    expect((await drainTerminalRequests(0, new Set(), deps)).cursor).toBe(1);
  });
});
