/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TerminalRequestLog,
  planAttachedTuiCommand,
  planTerminalCommand,
  terminalQwenArgv,
  defaultTerminalLogPath,
} from './terminals.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-terminals-'));
  file = join(dir, 'terminal-requests.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = {
  sessionId: '11111111-2222-3333-4444-555555555555',
  workspaceCwd: '/home/evan/projects/qwen-code-remote',
  daemonUrl: 'http://127.0.0.1:46135',
  daemonToken: 'tok with spaces',
  linuxArgv: ['qwen', '--attach-daemon', 'http://127.0.0.1:46135'],
  title: 'qwen 11111111',
};

/** A complete, valid log line (what the route actually writes). */
const line = (over: Record<string, unknown>) =>
  JSON.stringify({
    id: 'x1',
    createdAt: 1,
    ...base,
    ...over,
  });

describe('TerminalRequestLog', () => {
  it('reads empty when the file does not exist yet', async () => {
    expect(await TerminalRequestLog.open(file).readAll()).toEqual([]);
  });

  it('does not create the file until the first request', async () => {
    const log = TerminalRequestLog.open(file);
    await log.readAll();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('appends requests oldest-first with assigned ids', async () => {
    let t = 1000;
    let n = 0;
    const log = TerminalRequestLog.open(file, {
      now: () => ++t,
      newId: () => `id-${++n}`,
    });
    const a = await log.enqueue(base);
    const b = await log.enqueue({ ...base, sessionId: 'sess-b' });
    expect(a.id).toBe('id-1');
    expect(b.id).toBe('id-2');
    const all = await log.readAll();
    expect(all.map((r) => r.id)).toEqual(['id-1', 'id-2']);
    expect(all.map((r) => r.createdAt)).toEqual([1001, 1002]);
    expect(all[1].sessionId).toBe('sess-b');
  });

  it('writes the file 0600, since it holds the daemon token', async () => {
    await TerminalRequestLog.open(file).enqueue(base);
    const { stat } = await import('node:fs/promises');
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
  });

  it('round-trips the composed command and title', async () => {
    await TerminalRequestLog.open(file).enqueue(base);
    const [got] = await TerminalRequestLog.open(file).readAll();
    expect(got.linuxArgv).toEqual(base.linuxArgv);
    expect(got.title).toBe('qwen 11111111');
  });

  it('skips malformed and incomplete lines instead of failing', async () => {
    await writeFile(
      file,
      [
        line({ id: 'good' }),
        '{"truncated":',
        // no token
        line({ id: 'no-token', daemonToken: undefined }),
        // command dropped → the launcher could not run it
        line({ id: 'no-argv', linuxArgv: [] }),
        '',
      ].join('\n'),
      'utf8',
    );
    const log = TerminalRequestLog.open(file);
    expect((await log.readAll()).map((r) => r.id)).toEqual(['good']);
  });

  it('returns only requests past the launcher cursor', async () => {
    const log = TerminalRequestLog.open(file);
    await log.enqueue({ ...base, sessionId: 'a' });
    await log.enqueue({ ...base, sessionId: 'b' });
    expect((await log.since(1)).map((r) => r.sessionId)).toEqual(['b']);
    expect((await log.since(0)).length).toBe(2);
    expect(await log.since(99)).toEqual([]);
  });
});

describe('planTerminalCommand', () => {
  it('runs the qwen-rc attach wrapper by session id and folder, with no daemon credentials', () => {
    const { linuxArgv, title } = planTerminalCommand(base);
    expect(linuxArgv).toEqual([
      'qwen-rc',
      'attach',
      '--session',
      '11111111-2222-3333-4444-555555555555',
      base.workspaceCwd,
    ]);
    // The tab's argv is visible to every process on the host: the daemon
    // endpoint comes from the gateway at run time instead.
    expect(linuxArgv.join(' ')).not.toContain('tok with spaces');
    expect(linuxArgv).not.toContain('--daemon-token');
    expect(linuxArgv).not.toContain('--attach-daemon');
    expect(title).toBe('qwen 11111111');
  });

  it('runs a caller-supplied qwen-rc argv ahead of the attach subcommand', () => {
    const { linuxArgv } = planTerminalCommand(base, {
      rcArgv: ['/usr/bin/node', '/fork/packages/rc-gateway/dist/cli.js'],
    });
    expect(linuxArgv.slice(0, 4)).toEqual([
      '/usr/bin/node',
      '/fork/packages/rc-gateway/dist/cli.js',
      'attach',
      '--session',
    ]);
  });

  it('does not put the qwen argv on the tab: the wrapper learns it from the gateway', () => {
    const { linuxArgv } = planTerminalCommand(base, {
      qwenArgv: ['node', '/fork/packages/cli/dist/index.js'],
    });
    expect(linuxArgv).not.toContain('/fork/packages/cli/dist/index.js');
  });

  it('quotes shell-active characters only in the display form', () => {
    const { linuxArgv, displayCommand } = planTerminalCommand({
      ...base,
      workspaceCwd: "/tmp/a b's",
    });
    // argv keeps raw values: the launcher uses execFile, no shell runs.
    expect(linuxArgv).toContain("/tmp/a b's");
    // The logged form stays paste-safe for a POSIX shell.
    expect(displayCommand).toContain(`'/tmp/a b'\\''s'`);
    expect(displayCommand.startsWith('wsl.exe --cd ')).toBe(true);
  });
});

describe('planAttachedTuiCommand', () => {
  it('builds the attach command carrying the token unmodified', () => {
    expect(planAttachedTuiCommand(base)).toEqual([
      'qwen',
      '--attach-daemon',
      'http://127.0.0.1:46135',
      '--daemon-token',
      'tok with spaces',
      '--attach-session',
      '11111111-2222-3333-4444-555555555555',
    ]);
  });

  it('runs a caller-supplied qwen argv ahead of the attach flags', () => {
    const argv = planAttachedTuiCommand(base, {
      qwenArgv: ['node', '/fork/packages/cli/dist/index.js'],
    });
    expect(argv.slice(0, 3)).toEqual([
      'node',
      '/fork/packages/cli/dist/index.js',
      '--attach-daemon',
    ]);
  });
});

describe('terminalQwenArgv', () => {
  it('treats unset or blank as the PATH default', () => {
    expect(terminalQwenArgv(undefined)).toBeUndefined();
    expect(terminalQwenArgv('   ')).toBeUndefined();
  });

  it('splits a plain command on whitespace', () => {
    expect(terminalQwenArgv('node /fork/dist/index.js')).toEqual([
      'node',
      '/fork/dist/index.js',
    ]);
  });

  it('reads a JSON array so paths may contain spaces', () => {
    expect(
      terminalQwenArgv('["node","/home/me/my dir/dist/index.js"]'),
    ).toEqual(['node', '/home/me/my dir/dist/index.js']);
  });

  it('ignores a malformed or empty JSON array', () => {
    expect(terminalQwenArgv('["a",]')).toBeUndefined();
    expect(terminalQwenArgv('[]')).toBeUndefined();
    expect(terminalQwenArgv('[""]')).toBeUndefined();
    expect(terminalQwenArgv('[1,2]')).toBeUndefined();
  });
});

describe('defaultTerminalLogPath', () => {
  it('sits beside the other rc stores', () => {
    expect(defaultTerminalLogPath('/home/evan')).toBe(
      '/home/evan/.qwen/rc/terminal-requests.jsonl',
    );
  });
});

describe('launcher liveness (#69)', () => {
  const marker = () => join(dir, 'terminal-launcher-heartbeat.json');
  const clock = (t: { at: number }) =>
    TerminalRequestLog.open(file, { now: () => t.at });
  const STALE = 12_000;

  it('says never rather than guessing live when nothing has polled', async () => {
    const log = TerminalRequestLog.open(file);
    expect(await log.launcherLiveness(STALE)).toEqual({
      state: 'never',
      seenMsAgo: null,
    });
  });

  it('reports live inside the window and how long ago', async () => {
    const t = { at: 100_000 };
    const log = clock(t);
    await log.recordPoll(7);
    t.at = 105_000;
    expect(await log.launcherLiveness(STALE)).toEqual({
      state: 'live',
      seenMsAgo: 5_000,
    });
  });

  it('reports stale once the window has passed', async () => {
    const t = { at: 100_000 };
    const log = clock(t);
    await log.recordPoll(7);
    t.at = 100_000 + STALE + 1;
    const l = await log.launcherLiveness(STALE);
    expect(l.state).toBe('stale');
    expect(l.seenMsAgo).toBe(STALE + 1);
  });

  it('keeps the boundary itself inside the window', async () => {
    const t = { at: 100_000 };
    const log = clock(t);
    await log.recordPoll(1);
    t.at = 100_000 + STALE;
    expect((await log.launcherLiveness(STALE)).state).toBe('live');
  });

  it('reports an unreadable marker as itself, not as never and not as live', async () => {
    // Both of those would be a wrong answer with a different next step: "never"
    // sends the reader to set the feature up, and "live" promises a window.
    await writeFile(marker(), 'not json at all', { encoding: 'utf8' });
    expect(await TerminalRequestLog.open(file).launcherLiveness(STALE)).toEqual(
      { state: 'unreadable', seenMsAgo: null },
    );
    await writeFile(marker(), JSON.stringify({ at: '100' }), {
      encoding: 'utf8',
    });
    expect(
      (await TerminalRequestLog.open(file).launcherLiveness(STALE)).state,
    ).toBe('unreadable');
  });

  it('rewrites the marker so a host polling forever does not grow a file', async () => {
    const t = { at: 100_000 };
    const log = clock(t);
    for (let i = 0; i < 5; i++) {
      t.at += 1_000;
      await log.recordPoll(i);
    }
    const raw = await readFile(marker(), 'utf8');
    // The last write wins outright rather than appending, so the file holds one
    // object no matter how long the host has been up.
    expect(JSON.parse(raw)).toEqual({ at: 105_000, cursor: 4 });
    expect(raw.split('\n')).toHaveLength(1);
  });

  it('leaves the request log alone, so its one-writer rule holds', async () => {
    // The lock freeness of the request log rests on the gateway being its only
    // writer. The heartbeat is the launcher's traffic, so it belongs in its own
    // file; if it ever shared the log, that invariant would be gone.
    const log = TerminalRequestLog.open(file);
    await log.recordPoll(3);
    expect(await log.readAll()).toEqual([]);
    expect(await log.since(0)).toEqual([]);
  });

  it('keeps the marker owner only, matching the request log', async () => {
    await TerminalRequestLog.open(file).recordPoll(1);
    expect(((await stat(marker())).mode & 0o777).toString(8)).toBe('600');
  });
});
