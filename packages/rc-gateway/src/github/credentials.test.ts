/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitHubCredentials,
  OAuthTokenStore,
  ghToken,
  listGhLogins,
  createGhRunner,
  locateProgram,
  type GhRunResult,
  type GhRunner,
} from './credentials.js';

// The real two-account `gh auth status` text from gh 2.74 with the token
// lines removed.
const GH_274_STATUS = [
  'github.com',
  '  ✓ Logged in to github.com account evann-opsnexus (/home/evan/snap/gh/640/.config/gh/hosts.yml)',
  '  - Active account: true',
  '  - Git operations protocol: https',
  "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
  '',
  '  ✓ Logged in to github.com account InfiniteInsight (/home/evan/snap/gh/640/.config/gh/hosts.yml)',
  '  - Active account: false',
  '',
].join('\n');

interface Call {
  argv: readonly string[];
  timeoutMs: number;
}

function fakeRunner(
  answer: (argv: readonly string[]) => Partial<GhRunResult>,
): { run: GhRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: GhRunner = async (argv, timeoutMs) => {
    calls.push({ argv, timeoutMs });
    const a = answer(argv);
    return { exitCode: 0, stdout: '', stderr: '', ...a };
  };
  return { run, calls };
}

function ghFake(tokens: Record<string, string>) {
  return fakeRunner((argv) => {
    if (argv[1] === 'auth' && argv[2] === 'status') {
      return { stdout: GH_274_STATUS };
    }
    if (argv[1] === 'auth' && argv[2] === 'token') {
      const login = argv[argv.indexOf('--user') + 1]!;
      const t = tokens[login];
      return t === undefined
        ? { exitCode: 1, stderr: `no oauth token found for ${login}` }
        : { stdout: t + '\n' };
    }
    return { exitCode: 2, stderr: 'unexpected' };
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-gh-cred-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('listGhLogins', () => {
  it('listGhLogins parses both accounts from gh 2.74 output', async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: GH_274_STATUS }));
    const out = await listGhLogins(run);
    expect(out.logins).toEqual(['evann-opsnexus', 'InfiniteInsight']);
    expect(out.error).toBeUndefined();
    expect(calls[0]!.argv).toEqual([
      'gh',
      'auth',
      'status',
      '--hostname',
      'github.com',
    ]);
    expect(calls[0]!.argv).not.toContain('--show-token');
    expect(calls[0]!.argv).not.toContain('-t');
  });

  it('reads the status from stderr too, as older gh prints it there', async () => {
    const { run } = fakeRunner(() => ({ exitCode: 0, stderr: GH_274_STATUS }));
    expect((await listGhLogins(run)).logins).toEqual([
      'evann-opsnexus',
      'InfiniteInsight',
    ]);
  });

  it('keeps the scopes and a failed login as detail', async () => {
    const text = [
      GH_274_STATUS,
      '  X Failed to log in to github.com account stale-one (/x/hosts.yml)',
      '  - Active account: false',
      '  - The token in /x/hosts.yml is invalid.',
    ].join('\n');
    const { run } = fakeRunner(() => ({ exitCode: 1, stdout: text }));
    const out = await listGhLogins(run);
    expect(out.logins).toEqual(['evann-opsnexus', 'InfiniteInsight']);
    expect(out.accounts).toEqual([
      {
        login: 'evann-opsnexus',
        scopes: ['gist', 'read:org', 'repo', 'workflow'],
      },
      { login: 'InfiniteInsight' },
      { login: 'stale-one', error: 'gh: the token for this login is invalid' },
    ]);
    expect(out.error).toBeUndefined();
  });

  it('listGhLogins reports a missing gh', async () => {
    const { run } = fakeRunner(() => ({
      exitCode: 127,
      error: 'ENOENT',
    }));
    const out = await listGhLogins(run);
    expect(out).toEqual({ logins: [], accounts: [], error: 'ENOENT: gh' });
  });

  it('reads a bare exit 127 as a missing gh', async () => {
    const { run } = fakeRunner(() => ({ exitCode: 127 }));
    expect((await listGhLogins(run)).error).toBe('ENOENT: gh');
  });

  it('treats no logins as no accounts, not an error', async () => {
    const { run } = fakeRunner(() => ({
      exitCode: 1,
      stderr:
        'You are not logged into any GitHub hosts. To log in, run: gh auth login\n',
    }));
    expect(await listGhLogins(run)).toEqual({ logins: [], accounts: [] });
  });

  it('names a timeout and a failure, with no token-shaped text', async () => {
    const t = fakeRunner(() => ({ exitCode: null }));
    expect((await listGhLogins(t.run)).error).toBe('gh auth status timed out');
    const f = fakeRunner(() => ({
      exitCode: 4,
      stderr: 'boom ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    }));
    const err = (await listGhLogins(f.run)).error!;
    expect(err).toContain('exited 4');
    expect(err).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('ignores a login that is not a valid GitHub login', async () => {
    const { run } = fakeRunner(() => ({
      stdout:
        '  ✓ Logged in to github.com account --upload-pack=x (/h)\n' +
        '  ✓ Logged in to github.com account ok-login (/h)\n',
    }));
    expect((await listGhLogins(run)).logins).toEqual(['ok-login']);
  });

  it('never rejects when the runner throws', async () => {
    const run: GhRunner = async () => {
      throw new Error('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    };
    const out = await listGhLogins(run);
    expect(out.logins).toEqual([]);
    expect(out.error).toBe('gh auth status could not run');
  });
});

describe('ghToken', () => {
  it('ghToken passes --user and never puts stdout in its error', async () => {
    const ok = fakeRunner(() => ({ stdout: 'gho_tokenvalue\n' }));
    expect(await ghToken('InfiniteInsight', ok.run)).toBe('gho_tokenvalue');
    expect(ok.calls[0]!.argv).toEqual([
      'gh',
      'auth',
      'token',
      '--hostname',
      'github.com',
      '--user',
      'InfiniteInsight',
    ]);

    const bad = fakeRunner(() => ({
      exitCode: 1,
      stdout: 'ghp_secret',
      stderr: 'something echoed ghp_secret back',
    }));
    let message = '';
    try {
      await ghToken('InfiniteInsight', bad.run);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('ghp_secret');
    expect(message).toContain('exited 1');
  });

  it('refuses a crafted login before gh runs', async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: 'gho_x' }));
    for (const login of [
      '--help',
      '-u',
      'a/b',
      '../x',
      'a b',
      '',
      'x'.repeat(40),
    ]) {
      await expect(ghToken(login, run)).rejects.toThrow('invalid_login');
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty or multi-line answer without echoing it', async () => {
    const empty = fakeRunner(() => ({ stdout: '\n' }));
    await expect(ghToken('a', empty.run)).rejects.toThrow(/no token/);
    const two = fakeRunner(() => ({ stdout: 'gho_aaaaaaaa\ngho_bbbbbbbb\n' }));
    const err = await ghToken('a', two.run).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/unexpected output/);
    expect(err?.message).not.toContain('gho_');
  });

  it('reports a missing gh as ENOENT: gh', async () => {
    const { run } = fakeRunner(() => ({ exitCode: 127, error: 'ENOENT' }));
    await expect(ghToken('a', run)).rejects.toThrow('ENOENT: gh');
  });
});

describe('locateProgram', () => {
  it('finds a program on PATH first, then in the fallback dirs', async () => {
    const onPath = join(dir, 'path');
    const snap = join(dir, 'snap');
    await mkdir(onPath);
    await mkdir(snap);
    writeFileSync(join(snap, 'gh'), '', { mode: 0o755 });
    expect(await locateProgram('gh', onPath, [snap])).toBe(join(snap, 'gh'));
    writeFileSync(join(onPath, 'gh'), '', { mode: 0o755 });
    expect(await locateProgram('gh', onPath, [snap])).toBe(join(onPath, 'gh'));
    expect(await locateProgram('gh', undefined, [join(dir, 'none')])).toBe(
      undefined,
    );
  });

  it('skips a file that is not executable', async () => {
    writeFileSync(join(dir, 'gh'), '', { mode: 0o644 });
    expect(await locateProgram('gh', dir, [])).toBe(undefined);
  });
});

describe('OAuthTokenStore', () => {
  it('OAuthTokenStore writes 0600 in a 0700 dir and round-trips', async () => {
    const file = join(dir, 'rc', 'github-oauth.json');
    const store = await OAuthTokenStore.open(file);
    expect(store.list()).toEqual([]);
    await store.put('InfiniteInsight', 'gho_one', ['repo', 'read:org']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'rc')).mode & 0o777).toBe(0o700);

    const again = await OAuthTokenStore.open(file);
    expect(again.token('InfiniteInsight')).toBe('gho_one');
    expect(again.token('infiniteinsight')).toBe('gho_one');
    const listed = again.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.login).toBe('InfiniteInsight');
    expect(listed[0]!.scopes).toEqual(['repo', 'read:org']);
    expect(Number.isNaN(Date.parse(listed[0]!.connectedAt))).toBe(false);
    expect(JSON.stringify(listed)).not.toContain('gho_one');
  });

  it('forget removes the login and persists', async () => {
    const file = join(dir, 'github-oauth.json');
    const store = await OAuthTokenStore.open(file);
    await store.put('a-one', 'gho_a', ['repo']);
    await store.put('b-two', 'gho_b', []);
    expect(await store.forget('A-ONE')).toBe(true);
    expect(await store.forget('a-one')).toBe(false);
    const again = await OAuthTokenStore.open(file);
    expect(again.token('a-one')).toBeUndefined();
    expect(again.list().map((a) => a.login)).toEqual(['b-two']);
    expect(readFileSync(file, 'utf8')).not.toContain('gho_a');
  });

  it('replaces a login on a second put', async () => {
    const store = await OAuthTokenStore.open(join(dir, 's.json'));
    await store.put('Some-One', 'gho_old', ['repo']);
    await store.put('some-one', 'gho_new', ['repo', 'workflow']);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.login).toBe('some-one');
    expect(store.token('SOME-ONE')).toBe('gho_new');
  });

  it('refuses a crafted login, a bad token and bad scopes', async () => {
    const store = await OAuthTokenStore.open(join(dir, 's.json'));
    await expect(store.put('../x', 'gho_a', [])).rejects.toThrow(
      'invalid_login',
    );
    await expect(store.put('__proto__', 'gho_a', [])).rejects.toThrow(
      'invalid_login',
    );
    await expect(store.put('ok', 'has space', [])).rejects.toThrow(
      'invalid_token',
    );
    await expect(store.put('ok', '', [])).rejects.toThrow('invalid_token');
    await expect(
      store.put('ok', 'gho_a', ['repo', 'bad scope'] as string[]),
    ).rejects.toThrow('invalid_scopes');
    expect(store.token('../x')).toBeUndefined();
    expect(await store.forget('--x')).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('tightens a group/world-readable file to 0600', async () => {
    const file = join(dir, 's.json');
    const first = await OAuthTokenStore.open(file);
    await first.put('a', 'gho_a', []);
    chmodSync(file, 0o644);
    const warnings: string[] = [];
    const store = await OAuthTokenStore.open(file, {
      log: (l) => warnings.push(l),
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(store.token('a')).toBe('gho_a');
    expect(warnings.join('\n')).toContain('0644');
    expect(warnings.join('\n')).not.toContain('gho_a');
  });

  it('refuses a file that others could write', async () => {
    const file = join(dir, 's.json');
    const first = await OAuthTokenStore.open(file);
    await first.put('a', 'gho_a', []);
    chmodSync(file, 0o666);
    await expect(OAuthTokenStore.open(file)).rejects.toThrow(/writable/);
  });

  it('drops malformed entries without logging their tokens', async () => {
    const file = join(dir, 's.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        accounts: {
          good: {
            login: 'good',
            token: 'gho_good',
            scopes: ['repo'],
            connectedAt: '2026-11-12T00:00:00.000Z',
          },
          '--bad': {
            login: '--bad',
            token: 'gho_bad',
            scopes: [],
            connectedAt: 'x',
          },
          other: { login: 'other', token: 42, scopes: [] },
        },
      }),
      { mode: 0o600 },
    );
    const warnings: string[] = [];
    const store = await OAuthTokenStore.open(file, {
      log: (l) => warnings.push(l),
    });
    expect(store.list().map((a) => a.login)).toEqual(['good']);
    expect(warnings.join('\n')).toContain('2');
    expect(warnings.join('\n')).not.toContain('gho_');
  });
});

describe('GitHubCredentials', () => {
  it('accounts lists gh then oauth, and token resolves each source', async () => {
    const store = await OAuthTokenStore.open(join(dir, 's.json'));
    await store.put('phone-login', 'gho_phone', ['repo']);
    const { run, calls } = ghFake({
      'evann-opsnexus': 'gho_work',
      InfiniteInsight: 'gho_home',
    });
    const creds = new GitHubCredentials({ run, store });

    const accounts = await creds.accounts();
    expect(accounts.map((a) => a.id)).toEqual([
      'gh:evann-opsnexus',
      'gh:InfiniteInsight',
      'oauth:phone-login',
    ]);
    expect(accounts[0]).toEqual({
      id: 'gh:evann-opsnexus',
      source: 'gh',
      login: 'evann-opsnexus',
      scopes: ['gist', 'read:org', 'repo', 'workflow'],
    });
    expect(accounts[2]).toMatchObject({
      source: 'oauth',
      login: 'phone-login',
      scopes: ['repo'],
    });
    expect(typeof accounts[2]!.connectedAt).toBe('string');
    expect(JSON.stringify(accounts)).not.toMatch(/gho_/);

    expect(await creds.token('gh:InfiniteInsight')).toBe('gho_home');
    expect(await creds.token('oauth:phone-login')).toBe('gho_phone');
    // Never switches the active account and never logs in.
    for (const c of calls) {
      expect(c.argv).not.toContain('switch');
      expect(c.argv).not.toContain('login');
      expect(c.argv).not.toContain('--show-token');
    }
  });

  it('token for an unknown id throws account_not_found', async () => {
    const store = await OAuthTokenStore.open(join(dir, 's.json'));
    const { run, calls } = ghFake({ 'evann-opsnexus': 'gho_work' });
    const creds = new GitHubCredentials({ run, store });
    for (const id of [
      'gh:nobody',
      'oauth:nobody',
      'gh:--help',
      'other:evann-opsnexus',
      'gh:',
    ]) {
      await expect(creds.token(id as `gh:${string}`)).rejects.toThrow(
        'account_not_found',
      );
    }
    expect(calls.some((c) => c.argv.includes('--help'))).toBe(false);
  });

  it('reports a gh failure beside the oauth accounts', async () => {
    const store = await OAuthTokenStore.open(join(dir, 's.json'));
    await store.put('phone-login', 'gho_phone', []);
    const { run } = fakeRunner(() => ({ exitCode: 127, error: 'ENOENT' }));
    const creds = new GitHubCredentials({ run, store });
    expect(await creds.status()).toEqual({
      accounts: [expect.objectContaining({ id: 'oauth:phone-login' })],
      ghError: 'ENOENT: gh',
    });
    expect((await creds.accounts()).map((a) => a.id)).toEqual([
      'oauth:phone-login',
    ]);
  });
});

describe('createGhRunner', () => {
  it('reports a gh found nowhere as ENOENT without spawning', async () => {
    const run = createGhRunner({
      pathEnv: join(dir, 'empty'),
      fallbackDirs: [],
    });
    expect(await run(['gh', 'auth', 'status'], 1000)).toEqual({
      exitCode: null,
      stdout: '',
      stderr: '',
      error: 'ENOENT',
    });
    expect((await listGhLogins(run)).error).toBe('ENOENT: gh');
  });

  it('runs a stub gh from a fallback dir with no env token and no prompts', async () => {
    // A stub script named gh, not the real gh: it prints what it was given.
    const bin = join(dir, 'bin');
    await mkdir(bin);
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\necho "args=$*"\necho "token=${GH_TOKEN:-unset} prompt=$GH_PROMPT_DISABLED" >&2\nexit 3\n',
      { mode: 0o755 },
    );
    const run = createGhRunner({
      pathEnv: join(dir, 'empty'),
      fallbackDirs: [bin],
      env: { PATH: '/usr/bin:/bin', GH_TOKEN: 'ghp_fromenv' },
    });
    const out = await run(['gh', 'auth', 'token', '--user', 'x'], 5000);
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toBe('args=auth token --user x\n');
    expect(out.stderr).toBe('token=unset prompt=1\n');
  });
});

describe('GitHubCredentials with a failing gh login', () => {
  it('lists it with its error and refuses its token by cause', async () => {
    const store = await OAuthTokenStore.open(join(dir, 's.json'));
    const { run, calls } = fakeRunner(() => ({
      exitCode: 1,
      stdout:
        '  X Failed to log in to github.com account stale-one (/x/hosts.yml)\n' +
        '  - The token in /x/hosts.yml is invalid.\n',
    }));
    const creds = new GitHubCredentials({ run, store });
    expect(await creds.accounts()).toEqual([
      {
        id: 'gh:stale-one',
        source: 'gh',
        login: 'stale-one',
        error: 'gh: the token for this login is invalid',
      },
    ]);
    await expect(creds.token('gh:stale-one')).rejects.toThrow(
      'gh: the token for this login is invalid',
    );
    expect(calls.some((c) => c.argv[2] === 'token')).toBe(false);
  });
});
