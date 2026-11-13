/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLONE_LINE_MAX,
  CLONE_MAX_FINISHED,
  CloneJobs,
  cloneArgs,
  cloneGitConfigArgs,
  cloneEnv,
  describeTimeout,
} from './clone.js';
import type { CloneChild, CloneJobStatus, CloneSpawner } from './clone.js';

const TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';
const REF = { owner: 'acme', name: 'widget' };
const ACCOUNT = 'gh:acme' as const;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rc-clone-${prefix}-`));
}

/** An environment for real git that never reads the owner's config. */
function gitEnv(): NodeJS.ProcessEnv {
  const home = tmp('home');
  const global = join(home, 'gitconfig');
  writeFileSync(
    global,
    '[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n',
  );
  return {
    PATH: process.env['PATH'],
    HOME: home,
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function git(env: NodeJS.ProcessEnv, cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

/** A bare repo holding `.qwen/settings.json` with one hook. */
function bareRepo(env: NodeJS.ProcessEnv): string {
  const work = tmp('work');
  git(env, work, ['init', '-q']);
  mkdirSync(join(work, '.qwen'));
  writeFileSync(
    join(work, '.qwen', 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    }),
  );
  writeFileSync(join(work, 'README.md'), 'hello\n');
  git(env, work, ['add', '.']);
  git(env, work, ['commit', '-q', '-m', 'init']);
  const bare = join(tmp('bare'), 'widget.git');
  git(env, work, ['clone', '-q', '--bare', work, bare]);
  return bare;
}

/** Live (not zombie) processes in group `pgid`, from /proc. */
function groupMembers(pgid: number): number[] {
  const out: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue;
    }
    // Fields after the parenthesised command: state, ppid, pgrp, ...
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(rest[2]) === pgid && rest[0] !== 'Z') out.push(Number(name));
  }
  return out;
}

/** Processes of this user whose environment holds the test token. */
function processesHoldingToken(): number[] {
  const out: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const env = readFileSync(`/proc/${name}/environ`);
      if (env.includes(`QWEN_RC_GIT_TOKEN=${TOKEN}`)) out.push(Number(name));
    } catch {
      // not ours or gone
    }
  }
  return out;
}

async function waitDone(
  jobs: CloneJobs,
  jobId: string,
  ms = 10_000,
): Promise<CloneJobStatus> {
  const end = Date.now() + ms;
  for (;;) {
    const s = jobs.status(jobId);
    if (!s) throw new Error('job vanished');
    if (s.state !== 'running') return s;
    if (Date.now() > end) throw new Error('job still running');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function jobIdOf(r: Awaited<ReturnType<CloneJobs['start']>>): string {
  if (!('jobId' in r)) throw new Error(`refused: ${r.code} ${r.error}`);
  return r.jobId;
}

class FakeChild extends EventEmitter implements CloneChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  /** Signals sent to the child's whole process group. */
  readonly groupSignals: string[] = [];
  /** Called on each kill; exit from here to obey the signal. */
  onKill?: (signal: string) => void;
  /** Called on each group signal. */
  onGroupKill?: (signal: string) => void;

  /** Set only by a group spawner, whose `killGroup` must go to CloneJobs. */
  constructor(readonly pid?: number) {
    super();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    this.onKill?.(signal);
    return true;
  }

  async exit(code: number | null, signal: NodeJS.Signals | null = null) {
    const ends = [once(this.stdout, 'end'), once(this.stderr, 'end')];
    this.stdout.end();
    this.stderr.end();
    await Promise.all(ends);
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  /** git exits but a helper still holds its pipes: `close` never fires. */
  exitLeavingPipes(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit('exit', code, signal);
  }
}

interface SpawnCall {
  program: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

/**
 * With `groups`, each child gets a fake pid and `killGroup` routes group
 * signals to it; pass both `spawn: f.fn` and `killGroup: f.killGroup`.
 */
function fakeSpawner(
  script: (child: FakeChild, call: SpawnCall) => void,
  groups = false,
) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const detached: boolean[] = [];
  const killGroup = (pid: number, sig: NodeJS.Signals) => {
    const child = children.find((c) => c.pid === pid);
    if (!child) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    child.groupSignals.push(sig);
    child.onGroupKill?.(sig);
  };
  const fn: CloneSpawner = (program, args, options) => {
    const child = new FakeChild(
      groups ? 4_000_000 + children.length : undefined,
    );
    detached.push(options.detached);
    const call = { program, args, env: options.env };
    calls.push(call);
    children.push(child);
    setImmediate(() => script(child, call));
    return child;
  };
  return { fn, calls, children, detached, killGroup };
}

function freshDest(): string {
  return join(tmp('dest'), 'widget');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CloneJobs with real git', () => {
  it('clones a local repo and reports done with its findings', async () => {
    const env = gitEnv();
    const bare = bareRepo(env);
    const jobs = new CloneJobs({ env, urlFor: () => `file://${bare}` });
    const dest = freshDest();
    const s = await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({ ref: REF, dest, token: TOKEN, account: ACCOUNT }),
      ),
    );
    expect(s.state).toBe('done');
    expect(s.exitCode).toBe(0);
    expect(s.error).toBeUndefined();
    expect(s.dest).toBe(dest);
    expect(s.repo).toBe('acme/widget');
    expect(s.account).toBe(ACCOUNT);
    expect(s.hasFindings).toBe(true);
    expect(s.findings?.hooks).toEqual([
      { event: 'SessionStart', command: 'echo hi' },
    ]);
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe('hello\n');
    expect(s.lines.some((l) => l.startsWith('Cloning into'))).toBe(true);
  });

  it("the clone's .git/config holds no token and its remote is the plain URL", async () => {
    const env = gitEnv();
    const bare = bareRepo(env);
    const url = `file://${bare}`;
    const jobs = new CloneJobs({ env, urlFor: () => url });
    const dest = freshDest();
    const s = await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({ ref: REF, dest, token: TOKEN, account: ACCOUNT }),
      ),
    );
    expect(s.state).toBe('done');
    expect(git(env, dest, ['config', 'remote.origin.url']).trim()).toBe(url);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const files = walk(join(dest, '.git'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => readFileSync(f).includes(TOKEN))).toEqual([]);
  });

  it('the default URL is the plain https github.com URL, with the token in env only', async () => {
    const f = fakeSpawner((c) => void c.exit(1));
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const dest = freshDest();
    await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({ ref: REF, dest, token: TOKEN, account: ACCOUNT }),
      ),
    );
    expect(f.calls).toHaveLength(1);
    const { program, args, env } = f.calls[0]!;
    expect(program.endsWith('/git')).toBe(true);
    expect(args).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      'credential.https://github.com.helper=!f() { echo username=x-access-token; echo "password=$QWEN_RC_GIT_TOKEN"; }; f',
      '-c',
      'http.https://github.com/acme/widget.git.followRedirects=false',
      '-c',
      'core.askPass=',
      '-c',
      'http.https://github.com/acme/widget.git.sslVerify=true',
      'clone',
      '--progress',
      '--',
      'https://github.com/acme/widget.git',
      dest,
    ]);
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(env['QWEN_RC_GIT_TOKEN']).toBe(TOKEN);
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it("the owner's credential helpers are not asked, scoped or not", async () => {
    // A loopback server answering 401 makes git ask for credentials. The
    // control run proves the owner's helpers would be asked without our -c.
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const port = (server.address() as AddressInfo).port;
      const env = gitEnv();
      const marker = join(env['HOME']!, 'marker');
      writeFileSync(
        env['GIT_CONFIG_GLOBAL']!,
        [
          '[credential]',
          `\thelper = "!f() { echo unscoped >> ${marker}; }; f"`,
          `[credential "http://127.0.0.1:${port}"]`,
          `\thelper = "!f() { echo scoped >> ${marker}; }; f"`,
          '',
        ].join('\n'),
      );
      const url = `http://127.0.0.1:${port}/acme/widget.git`;

      // Async: the server answers from this same process.
      await new Promise<void>((res) => {
        execFile(
          'git',
          ['clone', '--', url, freshDest()],
          { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 10_000 },
          () => res(),
        );
      });
      expect(readFileSync(marker, 'utf8')).toContain('unscoped');
      expect(readFileSync(marker, 'utf8')).toContain('scoped');
      writeFileSync(marker, '');

      const jobs = new CloneJobs({ env, urlFor: () => url });
      const s = await waitDone(
        jobs,
        jobIdOf(
          await jobs.start({
            ref: REF,
            dest: freshDest(),
            token: TOKEN,
            account: ACCOUNT,
          }),
        ),
      );
      expect(s.state).toBe('failed');
      expect(readFileSync(marker, 'utf8')).toBe('');
      expect(JSON.stringify(s)).not.toContain(TOKEN);
    } finally {
      server.close();
    }
  });

  it("neither the owner's core.askPass nor GIT_ASKPASS or SSH_ASKPASS is run", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const port = (server.address() as AddressInfo).port;
      const env = gitEnv();
      const home = env['HOME']!;
      const marker = join(home, 'marker');
      const askpass = (name: string) => {
        const path = join(home, `${name}.sh`);
        writeFileSync(
          path,
          `#!/bin/sh\necho ${name} >> ${marker}\necho nope\n`,
          {
            mode: 0o755,
          },
        );
        return path;
      };
      writeFileSync(
        env['GIT_CONFIG_GLOBAL']!,
        `[core]\n\taskPass = ${askpass('askpass-core')}\n`,
      );
      const askEnv = {
        ...env,
        GIT_ASKPASS: askpass('askpass-env'),
        SSH_ASKPASS: askpass('askpass-ssh'),
      };
      const url = `http://127.0.0.1:${port}/acme/widget.git`;
      const control = (e: NodeJS.ProcessEnv) =>
        new Promise<string>((res) => {
          writeFileSync(marker, '');
          execFile(
            'git',
            ['clone', '--', url, freshDest()],
            { env: { ...e, GIT_TERMINAL_PROMPT: '0' }, timeout: 10_000 },
            () => res(readFileSync(marker, 'utf8')),
          );
        });

      // Controls: each of the three would be run by a plain git clone.
      expect(await control(askEnv)).toContain('askpass-env');
      const { GIT_ASKPASS: _g, ...noGitAskpass } = askEnv;
      expect(await control(noGitAskpass)).toContain('askpass-core');
      expect(
        await control({ ...noGitAskpass, GIT_CONFIG_GLOBAL: '/dev/null' }),
      ).toContain('askpass-ssh');

      writeFileSync(marker, '');
      const jobs = new CloneJobs({ env: askEnv, urlFor: () => url });
      const s = await waitDone(
        jobs,
        jobIdOf(
          await jobs.start({
            ref: REF,
            dest: freshDest(),
            token: TOKEN,
            account: ACCOUNT,
          }),
        ),
      );
      expect(s.state).toBe('failed');
      expect(readFileSync(marker, 'utf8')).toBe('');
    } finally {
      server.close();
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'a stalled clone that times out leaves no process of its group behind',
    async () => {
      // Accepts and never answers, so git remote-http waits on the socket.
      const server = createServer(() => {});
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const port = (server.address() as AddressInfo).port;
        const pids: number[] = [];
        const spawnReal: CloneSpawner = (program, args, options) => {
          const c = spawn(program, [...args], options);
          if (c.pid) pids.push(c.pid);
          return c;
        };
        const jobs = new CloneJobs({
          spawn: spawnReal,
          env: gitEnv(),
          urlFor: () => `http://127.0.0.1:${port}/acme/widget.git`,
          timeoutMs: 1500,
          killGraceMs: 300,
        });
        const id = jobIdOf(
          await jobs.start({
            ref: REF,
            dest: freshDest(),
            token: TOKEN,
            account: ACCOUNT,
          }),
        );
        await vi.waitFor(() => expect(pids).toHaveLength(1), { timeout: 3000 });
        const pgid = pids[0]!;
        // The helpers exist in the group while the clone stalls.
        await vi.waitFor(
          () => expect(groupMembers(pgid).length).toBeGreaterThan(1),
          { timeout: 3000 },
        );
        const s = await waitDone(jobs, id);
        expect(s.state).toBe('failed');
        expect(s.error).toBe('timed out after 1500 ms');
        await vi.waitFor(() => expect(groupMembers(pgid)).toEqual([]), {
          timeout: 3000,
        });
        expect(processesHoldingToken()).toEqual([]);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    },
  );

  it('the token helper answers github.com and nothing else', () => {
    const env = cloneEnv(gitEnv(), TOKEN);
    const fill = (host: string) =>
      execFileSync(
        'git',
        [
          ...cloneGitConfigArgs('https://github.com/acme/widget.git'),
          'credential',
          'fill',
        ],
        {
          env,
          input: `protocol=https\nhost=${host}\n\n`,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      );
    expect(fill('github.com')).toContain(`password=${TOKEN}`);
    expect(() => fill('example.com')).toThrow();
  });

  it("the clone's sslVerify and followRedirects beat the owner's URL-scoped blocks", () => {
    const env = gitEnv();
    writeFileSync(
      env['GIT_CONFIG_GLOBAL']!,
      [
        '[http "https://github.com"]',
        '\tsslVerify = false',
        '\tfollowRedirects = true',
        '[http "https://github.com/acme"]',
        '\tsslVerify = false',
        '\tfollowRedirects = true',
        '[http "https://github.com/acme/widget.git"]',
        '\tsslVerify = false',
        '\tfollowRedirects = true',
        '',
      ].join('\n'),
    );
    const url = 'https://github.com/acme/widget.git';
    // The -c args exactly as CloneJobs passes them, up to `clone`.
    const full = cloneArgs(url, '/nowhere/widget');
    const ours = full.slice(0, full.indexOf('clone'));
    const get = (pre: string[], key: string) =>
      execFileSync('git', [...pre, 'config', '--get-urlmatch', key, url], {
        env,
        encoding: 'utf8',
      }).trim();

    // Controls: the owner's blocks win without our args, and a generic -c
    // loses to them.
    expect(get([], 'http.sslVerify')).toBe('false');
    expect(get([], 'http.followRedirects')).toBe('true');
    expect(get(['-c', 'http.sslVerify=true'], 'http.sslVerify')).toBe('false');
    expect(
      get(['-c', 'http.followRedirects=false'], 'http.followRedirects'),
    ).toBe('true');

    expect(get(ours, 'http.sslVerify')).toBe('true');
    expect(get(ours, 'http.followRedirects')).toBe('false');
  });
});

describe('CloneJobs output and failures', () => {
  it("a failing clone's lines are scrubbed of the token", async () => {
    const f = fakeSpawner((c) => {
      c.stderr.write("Cloning into 'widget'...\n");
      c.stderr.write(
        `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/acme/widget.git/': 403 ${TOKEN}\n`,
      );
      void c.exit(128);
    });
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const s = await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      ),
    );
    expect(s.state).toBe('failed');
    expect(s.exitCode).toBe(128);
    expect(s.error).toContain('fatal: unable to access');
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(JSON.stringify(s)).not.toContain('x-access-token:');
  });

  it('a token split across two writes is still masked', async () => {
    const half = TOKEN.length / 2;
    const f = fakeSpawner(async (c) => {
      c.stderr.write(`remote: here ${TOKEN.slice(0, half)}`);
      await new Promise((r) => setTimeout(r, 20));
      c.stderr.write(`${TOKEN.slice(half)} there\rReceiving objects: 50%`);
      await new Promise((r) => setTimeout(r, 20));
      c.stderr.write(`\rtail ${TOKEN.slice(0, 12)}`);
      void c.exit(128);
    });
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const s = await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      ),
    );
    expect(s.lines).toEqual([
      'remote: here *** there',
      'Receiving objects: 50%',
      'tail ***',
    ]);
    const all = JSON.stringify(s);
    for (let i = 0; i + 6 <= TOKEN.length; i++) {
      expect(all).not.toContain(TOKEN.slice(i, i + 6));
    }
  });

  it('cuts a line longer than the cap and scrubs it first', async () => {
    const f = fakeSpawner(async (c) => {
      c.stderr.write('a'.repeat(CLONE_LINE_MAX - 10) + TOKEN);
      c.stderr.write('b'.repeat(CLONE_LINE_MAX * 2));
      c.stderr.write('c'.repeat(100) + '\nafter\n');
      void c.exit(1);
    });
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const s = await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      ),
    );
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]!.length).toBeLessThanOrEqual(CLONE_LINE_MAX + 10);
    // Whether the writes arrive as one chunk or three, the token is masked
    // before the cut.
    expect(s.lines[0]).toContain('a***');
    expect(s.lines[0]!.endsWith(' [cut]')).toBe(true);
    expect(s.lines[1]).toBe('after');
    expect(JSON.stringify(s)).not.toContain(TOKEN.slice(0, 6));
  });

  it('keeps the last 50 lines', async () => {
    const f = fakeSpawner((c) => {
      for (let i = 0; i < 120; i++)
        c.stderr.write(`Receiving objects: ${i}%\r`);
      void c.exit(1);
    });
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const s = await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      ),
    );
    expect(s.lines).toHaveLength(50);
    expect(s.lines[49]).toBe('Receiving objects: 119%');
    expect(s.error).toBe('Receiving objects: 119%');
  });

  it('a clone that runs past the timeout is killed and says so', async () => {
    const f = fakeSpawner((c) => {
      c.stderr.write("Cloning into 'widget'...\n");
      c.onKill = (sig) => {
        if (sig === 'SIGKILL') void c.exit(null, 'SIGKILL');
      };
    });
    const jobs = new CloneJobs({
      spawn: f.fn,
      env: gitEnv(),
      timeoutMs: 60_000,
      killGraceMs: 30,
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const id = jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      );
      // setImmediate is real here, so this waits without moving the clock.
      while (f.children.length < 1) {
        await new Promise((r) => setImmediate(r));
      }
      await vi.advanceTimersByTimeAsync(59_000);
      expect(f.children[0]!.signals).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.children[0]!.signals).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(30);
      // The second SIGKILL is the sweep when the timed-out job finishes.
      expect(f.children[0]!.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL']);
      vi.useRealTimers();
      const s = await waitDone(jobs, id);
      expect(s.state).toBe('failed');
      expect(s.error).toBe('timed out after 1 minute');
      expect(s.exitCode).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the timeout signals the whole process group, SIGTERM then SIGKILL', async () => {
    const f = fakeSpawner((c) => {
      c.stderr.write("Cloning into 'widget'...\n");
      c.onGroupKill = (sig) => {
        if (sig === 'SIGKILL') void c.exit(null, 'SIGKILL');
      };
    }, true);
    const jobs = new CloneJobs({
      spawn: f.fn,
      killGroup: f.killGroup,
      processGroups: true,
      env: gitEnv(),
      timeoutMs: 60_000,
      killGraceMs: 30,
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const id = jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      );
      while (f.children.length < 1) {
        await new Promise((r) => setImmediate(r));
      }
      expect(f.detached).toEqual([true]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.children[0]!.groupSignals).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(30);
      // The second SIGKILL is the sweep when the timed-out job finishes.
      expect(f.children[0]!.groupSignals).toEqual([
        'SIGTERM',
        'SIGKILL',
        'SIGKILL',
      ]);
      expect(f.children[0]!.signals).toEqual([]);
      vi.useRealTimers();
      const s = await waitDone(jobs, id);
      expect(s.state).toBe('failed');
      expect(s.error).toBe('timed out after 1 minute');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a git that exits while a helper holds its pipes has its group killed before the slot frees', async () => {
    const f = fakeSpawner((c) => {
      c.stderr.write('fatal: early EOF\n');
      c.exitLeavingPipes(128);
    }, true);
    const jobs = new CloneJobs({
      spawn: f.fn,
      killGroup: f.killGroup,
      processGroups: true,
      env: gitEnv(),
      closeGraceMs: 50,
      maxConcurrent: 1,
    });
    const dest = freshDest();
    const id = jobIdOf(
      await jobs.start({ ref: REF, dest, token: TOKEN, account: ACCOUNT }),
    );
    while (f.children.length < 1) {
      await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(jobs.status(id)!.state).toBe('running');
    expect(
      await jobs.start({
        ref: REF,
        dest: freshDest(),
        token: TOKEN,
        account: ACCOUNT,
      }),
    ).toMatchObject({ code: 'too_many_clones' });
    const s = await waitDone(jobs, id);
    expect(f.children[0]!.groupSignals).toEqual(['SIGKILL']);
    expect(s.state).toBe('failed');
    expect(s.exitCode).toBe(128);
    expect(s.error).toBe('fatal: early EOF');
  });

  it('without process groups the child alone is signalled and not detached', async () => {
    const f = fakeSpawner((c) => void c.exit(1));
    const jobs = new CloneJobs({
      spawn: f.fn,
      env: gitEnv(),
      processGroups: false,
    });
    await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      ),
    );
    expect(f.detached).toEqual([false]);
  });

  it('the default timeout says 10 minutes', () => {
    expect(describeTimeout(10 * 60 * 1000)).toBe('timed out after 10 minutes');
    expect(describeTimeout(1500)).toBe('timed out after 1500 ms');
    expect(describeTimeout(2000)).toBe('timed out after 2 seconds');
  });

  it('a failed clone never removes its folder and says where it was left', async () => {
    const dest = freshDest();
    const f = fakeSpawner((c) => {
      mkdirSync(dest);
      writeFileSync(join(dest, 'partial'), 'x');
      c.stderr.write('fatal: early EOF\n');
      void c.exit(128);
    });
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const s = await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({ ref: REF, dest, token: TOKEN, account: ACCOUNT }),
      ),
    );
    expect(s.error).toBe(`fatal: early EOF. The folder was left at ${dest}.`);
    expect(existsSync(join(dest, 'partial'))).toBe(true);
  });

  it('a git that cannot be spawned fails with its errno', async () => {
    const f = fakeSpawner((c) => {
      c.emit(
        'error',
        Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
      );
    });
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const s = await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      ),
    );
    expect(s.state).toBe('failed');
    expect(s.error).toBe('git could not be started (ENOENT).');
  });

  it('an inspection that throws still ends done, with hasFindings so the page asks', async () => {
    const f = fakeSpawner((c) => void c.exit(0));
    const jobs = new CloneJobs({
      spawn: f.fn,
      env: gitEnv(),
      inspect: async () => {
        throw new Error(`disk on fire ${TOKEN}`);
      },
    });
    const s = await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      ),
    );
    expect(s.state).toBe('done');
    expect(s.hasFindings).toBe(true);
    expect(s.findings).toBeUndefined();
    expect(s.error).toBe(
      'The clone finished but its settings could not be inspected: disk on fire ***',
    );
  });

  it('a clean clone has hasFindings false', async () => {
    const f = fakeSpawner((c) => void c.exit(0));
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const s = await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      ),
    );
    expect(s.state).toBe('done');
    expect(s.hasFindings).toBe(false);
    expect(s.findings?.file).toBe(false);
  });
});

describe('CloneJobs environment', () => {
  it('trace and repo-pointing variables never reach git', async () => {
    const f = fakeSpawner((c) => void c.exit(1));
    const jobs = new CloneJobs({
      spawn: f.fn,
      env: {
        ...gitEnv(),
        GIT_TRACE: '1',
        GIT_TRACE_CURL: '1',
        GIT_TRACE_PACKET: '1',
        GIT_CURL_VERBOSE: '1',
        GIT_DIR: '/x',
        GIT_WORK_TREE: '/x',
        GIT_INDEX_FILE: '/x',
        GIT_CONFIG_PARAMETERS: "'a.b'='c'",
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: 'store',
        GIT_ASKPASS: '/x/askpass',
        SSH_ASKPASS: '/x/ssh-askpass',
        GIT_SSL_NO_VERIFY: '1',
        KEEP_ME: 'yes',
      },
    });
    await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      ),
    );
    const env = f.calls[0]!.env;
    expect(
      Object.keys(env).filter(
        (k) =>
          k.startsWith('GIT_TRACE') ||
          k.startsWith('GIT_CONFIG_KEY_') ||
          k.startsWith('GIT_CONFIG_VALUE_') ||
          [
            'GIT_CURL_VERBOSE',
            'GIT_DIR',
            'GIT_WORK_TREE',
            'GIT_INDEX_FILE',
            'GIT_CONFIG_PARAMETERS',
            'GIT_CONFIG_COUNT',
            'GIT_ASKPASS',
            'SSH_ASKPASS',
            'GIT_SSL_NO_VERIFY',
          ].includes(k),
      ),
    ).toEqual([]);
    expect(env['KEEP_ME']).toBe('yes');
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
  });

  it("a parent process's GIT_TRACE does not reach git by default", async () => {
    vi.stubEnv('GIT_TRACE', '1');
    vi.stubEnv('GIT_CURL_VERBOSE', '1');
    const f = fakeSpawner((c) => void c.exit(1));
    const jobs = new CloneJobs({ spawn: f.fn });
    await waitDone(
      jobs,
      jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      ),
    );
    expect(f.calls[0]!.env['GIT_TRACE']).toBeUndefined();
    expect(f.calls[0]!.env['GIT_CURL_VERBOSE']).toBeUndefined();
    expect(f.calls[0]!.env['QWEN_RC_GIT_TOKEN']).toBe(TOKEN);
  });
});

describe('CloneJobs refusals and bounds', () => {
  it('a third concurrent clone is refused with too_many_clones', async () => {
    const f = fakeSpawner(() => {
      // never exits on its own
    });
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const start = () =>
      jobs.start({
        ref: REF,
        dest: freshDest(),
        token: TOKEN,
        account: ACCOUNT,
      });
    const [a, b, c] = await Promise.all([start(), start(), start()]);
    const ids = [a, b, c].filter((r) => 'jobId' in r);
    expect(ids).toHaveLength(2);
    expect([a, b, c].find((r) => 'code' in r)).toMatchObject({
      code: 'too_many_clones',
    });
    await vi.waitFor(() => expect(f.children).toHaveLength(2));
    await f.children[0]!.exit(1);
    await vi.waitFor(() =>
      expect(
        ids.some(
          (r) => 'jobId' in r && jobs.status(r.jobId)?.state === 'failed',
        ),
      ).toBe(true),
    );
    expect('jobId' in (await start())).toBe(true);
    await vi.waitFor(() => expect(f.children).toHaveLength(3));
    for (const child of f.children.slice(1)) await child.exit(1);
  });

  it('a non-empty destination is refused before git runs', async () => {
    const f = fakeSpawner((c) => void c.exit(0));
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const dest = tmp('full');
    writeFileSync(join(dest, 'x'), 'x');
    const r = await jobs.start({
      ref: REF,
      dest,
      token: TOKEN,
      account: ACCOUNT,
    });
    expect(r).toMatchObject({ code: 'dest_not_empty' });
    expect(f.calls).toHaveLength(0);
    expect(
      await jobs.start({
        ref: REF,
        dest: 'rel/path',
        token: TOKEN,
        account: ACCOUNT,
      }),
    ).toMatchObject({ code: 'dest_not_absolute' });
    expect(f.calls).toHaveLength(0);
  });

  it('a second clone into the same or a nested folder is refused while the first runs', async () => {
    const f = fakeSpawner(() => {
      // never exits on its own
    });
    const jobs = new CloneJobs({
      spawn: f.fn,
      env: gitEnv(),
      maxConcurrent: 5,
    });
    const dest = freshDest();
    jobIdOf(
      await jobs.start({ ref: REF, dest, token: TOKEN, account: ACCOUNT }),
    );
    for (const d of [dest, `${dest}/`, join(dest, 'inner')]) {
      const r = await jobs.start({
        ref: REF,
        dest: d,
        token: TOKEN,
        account: ACCOUNT,
      });
      expect(r).toEqual({
        code: 'dest_not_empty',
        error: `A clone into ${dest} is already running.`,
      });
    }
    await vi.waitFor(() => expect(f.children).toHaveLength(1));
    await f.children[0]!.exit(1);
  });

  it('job ids are random and finished jobs are bounded', async () => {
    const f = fakeSpawner((c) => void c.exit(1));
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const ids: string[] = [];
    for (let i = 0; i < CLONE_MAX_FINISHED + 5; i++) {
      const id = jobIdOf(
        await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        }),
      );
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      await waitDone(jobs, id);
      ids.push(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 5).map((id) => jobs.status(id))).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(jobs.status(ids[5]!)).not.toBeNull();
    expect(jobs.status('nope')).toBeNull();
  });

  it('refuses a ref repoUrl refuses before anything runs', async () => {
    const f = fakeSpawner((c) => void c.exit(0));
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    await expect(
      jobs.start({
        ref: { owner: '--upload-pack=x', name: 'y' },
        dest: freshDest(),
        token: TOKEN,
        account: ACCOUNT,
      }),
    ).rejects.toThrow('not a GitHub owner/name');
    expect(f.calls).toHaveLength(0);
  });

  it('a status is a copy the caller cannot change', async () => {
    const f = fakeSpawner((c) => {
      c.stderr.write('one\n');
      void c.exit(1);
    });
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const id = jobIdOf(
      await jobs.start({
        ref: REF,
        dest: freshDest(),
        token: TOKEN,
        account: ACCOUNT,
      }),
    );
    const s = await waitDone(jobs, id);
    s.lines.push('two');
    expect(jobs.status(id)!.lines).toEqual(['one']);
  });
});

describe('CloneJobs end hook and stopAll (#257 task 6)', () => {
  it('calls onEnd once with the final status when a job ends', async () => {
    const f = fakeSpawner((c) => void c.exit(0));
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const ends: CloneJobStatus[] = [];
    const id = jobIdOf(
      await jobs.start({
        ref: REF,
        dest: freshDest(),
        token: TOKEN,
        account: ACCOUNT,
        onEnd: (s) => ends.push(s),
      }),
    );
    await waitDone(jobs, id);
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    expect(ends[0]).toMatchObject({
      state: 'done',
      repo: 'acme/widget',
      account: ACCOUNT,
    });
    expect(typeof ends[0]!.finishedAt).toBe('number');
  });

  it('an onEnd that throws does not break the job', async () => {
    const f = fakeSpawner((c) => void c.exit(1));
    const jobs = new CloneJobs({ spawn: f.fn, env: gitEnv() });
    const id = jobIdOf(
      await jobs.start({
        ref: REF,
        dest: freshDest(),
        token: TOKEN,
        account: ACCOUNT,
        onEnd: () => {
          throw new Error('audit down');
        },
      }),
    );
    expect((await waitDone(jobs, id)).state).toBe('failed');
    // the slot was given back
    expect(
      'jobId' in
        (await jobs.start({
          ref: REF,
          dest: freshDest(),
          token: TOKEN,
          account: ACCOUNT,
        })),
    ).toBe(true);
  });

  it('stopAll kills a running clone group, ends it failed with gateway stopped and refuses later starts', async () => {
    const f = fakeSpawner(() => {
      // never exits on its own
    }, true);
    const jobs = new CloneJobs({
      spawn: f.fn,
      killGroup: f.killGroup,
      processGroups: true,
      env: gitEnv(),
    });
    const ends: CloneJobStatus[] = [];
    const id = jobIdOf(
      await jobs.start({
        ref: REF,
        dest: freshDest(),
        token: TOKEN,
        account: ACCOUNT,
        onEnd: (s) => ends.push(s),
      }),
    );
    await vi.waitFor(() => expect(f.children).toHaveLength(1));
    jobs.stopAll();
    const s = await waitDone(jobs, id);
    expect(s.state).toBe('failed');
    expect(s.error).toMatch(/^gateway stopped/);
    expect(f.children[0]!.groupSignals).toContain('SIGKILL');
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    expect(ends[0]!.state).toBe('failed');
    await expect(
      jobs.start({
        ref: REF,
        dest: freshDest(),
        token: TOKEN,
        account: ACCOUNT,
      }),
    ).rejects.toThrow('the gateway is stopping');
    expect(f.calls).toHaveLength(1);
  });
});
