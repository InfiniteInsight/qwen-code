/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TerminalRequestLog,
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
  it('builds an attach command carrying the token unmodified', () => {
    const { linuxArgv, title } = planTerminalCommand(base);
    expect(linuxArgv).toEqual([
      'qwen',
      '--attach-daemon',
      'http://127.0.0.1:46135',
      '--daemon-token',
      'tok with spaces',
      '--attach-session',
      '11111111-2222-3333-4444-555555555555',
    ]);
    expect(title).toBe('qwen 11111111');
  });

  it('runs a caller-supplied qwen argv ahead of the attach flags', () => {
    const { linuxArgv } = planTerminalCommand(base, {
      qwenArgv: ['node', '/fork/packages/cli/dist/index.js'],
    });
    expect(linuxArgv.slice(0, 3)).toEqual([
      'node',
      '/fork/packages/cli/dist/index.js',
      '--attach-daemon',
    ]);
  });

  it('quotes shell-active characters only in the display form', () => {
    const { linuxArgv, displayCommand } = planTerminalCommand({
      ...base,
      workspaceCwd: '/tmp/a b',
      daemonToken: "o'k",
    });
    // argv keeps raw values: the launcher uses execFile, no shell runs.
    expect(linuxArgv).toContain("o'k");
    // The logged form stays paste-safe for a POSIX shell.
    expect(displayCommand).toContain("'/tmp/a b'");
    expect(displayCommand).toContain(`'o'\\''k'`);
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
