/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The GitHub clone routes (#257), mounted through the REAL `createGatewayApp`
 * (real TokenStore, real requireScope(OWNER) mount, real audit log on disk)
 * with a fake gh runner, a fake fetch and a fake git spawner, so nothing here
 * runs gh or git, reads the owner's ~/.qwen or reaches the network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter, once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { SESSION_READ, WRITE } from '../scopes.js';
import type { CloneChild, CloneSpawner } from '../github/clone.js';
import type { GhRunner } from '../github/credentials.js';
import { resetRepoCache } from '../github/repos.js';
import {
  OAUTH_STARTS_PER_WINDOW,
  openGitHubDeps,
  readGitHubClientId,
  type GitHubRouteDeps,
} from './github.js';

const GH_TOKEN = 'gho_ghFakeTokenAAAAAAAAAAAAAAAAAAAAAAAA';
const OAUTH_TOKEN = 'gho_oauthFakeTokenBBBBBBBBBBBBBBBBBBBBBB';
const NEW_TOKEN = 'gho_newFakeTokenCCCCCCCCCCCCCCCCCCCCCCCC';
const DEVICE_CODE = 'device-code-secret-0123456789';
const USER_CODE = 'WDJB-MJHT';
const CLIENT_ID = 'Iv1.testclient';

const GH_STATUS = [
  'github.com',
  '  ✓ Logged in to github.com account octocat (keyring)',
  '  - Active account: true',
  "  - Token scopes: 'gist', 'read:org', 'repo'",
  '  X Failed to log in to github.com account stale-user (keyring)',
  '  - Active account: false',
  '  - The token in keyring is invalid.',
  '',
].join('\n');

let server: Server | undefined;
let stub: StubDaemon | undefined;
let runtimeBase: string | undefined;
let github: GitHubRouteDeps | undefined;

afterEach(async () => {
  github?.flows.stopAll();
  github?.clones.stopAll();
  // A stopped clone ends, and writes its audit row, a moment later.
  if (github) await new Promise((r) => setTimeout(r, 50));
  github = undefined;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  if (runtimeBase) {
    await rm(runtimeBase, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
  runtimeBase = undefined;
  resetRepoCache();
});

class FakeChild extends EventEmitter implements CloneChild {
  readonly pid = undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(): boolean {
    void this.exit(null);
    return true;
  }
  async exit(code: number | null) {
    const ends = [once(this.stdout, 'end'), once(this.stderr, 'end')];
    this.stdout.end();
    this.stderr.end();
    await Promise.all(ends);
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

interface SpawnCall {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

function fakeSpawner(script: (c: FakeChild, call: SpawnCall) => void) {
  const calls: SpawnCall[] = [];
  const fn: CloneSpawner = (_program, args, options) => {
    const child = new FakeChild();
    const call = { args, env: options.env };
    calls.push(call);
    setImmediate(() => script(child, call));
    return child;
  };
  return { fn, calls };
}

function fakeRunner(status = GH_STATUS) {
  const calls: string[][] = [];
  const run: GhRunner = async (argv) => {
    calls.push([...argv]);
    if (argv[1] === 'auth' && argv[2] === 'status') {
      return { exitCode: 1, stdout: '', stderr: status };
    }
    if (argv[1] === 'auth' && argv[2] === 'token') {
      const user = argv[argv.indexOf('--user') + 1];
      if (user === 'octocat' || user === 'stale-user') {
        return { exitCode: 0, stdout: `${GH_TOKEN}\n`, stderr: '' };
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'no oauth token found for github.com',
      };
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FetchScript {
  deviceCode?: (n: number) => Response;
  accessToken?: () => Response;
  user?: () => Response;
  repos?: () => Response;
}

function fakeFetch(script: FetchScript = {}) {
  const calls: string[] = [];
  let devices = 0;
  const fn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith('https://github.com/login/device/code')) {
      devices++;
      return script.deviceCode
        ? script.deviceCode(devices)
        : json({
            device_code: `${DEVICE_CODE}-${devices}`,
            user_code: USER_CODE,
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 1,
          });
    }
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return script.accessToken
        ? script.accessToken()
        : json({ error: 'authorization_pending' });
    }
    if (url === 'https://api.github.com/user') {
      return script.user ? script.user() : json({ login: 'octo-new' });
    }
    if (url.startsWith('https://api.github.com/user/repos')) {
      return script.repos
        ? script.repos()
        : json([
            {
              full_name: 'octocat/hello',
              private: false,
              default_branch: 'main',
              pushed_at: '2026-11-01T00:00:00Z',
              description: 'hi',
            },
          ]);
    }
    return json({ message: 'not found' }, 404);
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

interface BootOpts {
  clientId?: string;
  fetch?: ReturnType<typeof fakeFetch>;
  runner?: ReturnType<typeof fakeRunner>;
  spawner?: ReturnType<typeof fakeSpawner>;
  now?: () => number;
  mount?: boolean;
  /** Raw text for github-oauth.json, in place of `clientId`. */
  oauthFile?: string;
  /** A group/world-writable token file, so the store refuses it. */
  refuseStore?: boolean;
}

async function boot(o: BootOpts = {}) {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-github-route-'));
  const rcDir = join(runtimeBase, 'rc');
  mkdirSync(rcDir, { mode: 0o700 });
  if (o.clientId !== undefined) {
    writeFileSync(
      join(rcDir, 'github-oauth.json'),
      JSON.stringify({ clientId: o.clientId }),
    );
  }
  if (o.oauthFile !== undefined) {
    writeFileSync(join(rcDir, 'github-oauth.json'), o.oauthFile);
  }
  if (o.refuseStore) {
    const tokens = join(rcDir, 'github-oauth-tokens.json');
    writeFileSync(tokens, '{}');
    chmodSync(tokens, 0o666);
  }
  const fetchFake = o.fetch ?? fakeFetch();
  const runner = o.runner ?? fakeRunner();
  const spawner = o.spawner ?? fakeSpawner((c) => void c.exit(1));
  const logs: string[] = [];
  const deps = await openGitHubDeps({
    rcDir,
    env: { PATH: process.env['PATH'] },
    log: (l) => logs.push(l),
    fetch: fetchFake.fn,
    run: runner.run,
    clones: {
      spawn: spawner.fn,
      processGroups: false,
      env: { PATH: process.env['PATH'] },
    },
    flows: {
      // Scaled down so a poll is milliseconds, not seconds.
      setTimeout: (fn, ms) => setTimeout(fn, ms / 100),
    },
  });
  if (!deps) throw new Error('github deps did not open');
  if (o.now) deps.now = o.now;
  github = deps;
  if (!o.refuseStore) {
    await (
      deps.store as unknown as {
        put(l: string, t: string, s: string[]): Promise<void>;
      }
    ).put('octo-oauth', OAUTH_TOKEN, ['repo']);
  }
  stub = await startStubDaemon();
  const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
  const { token: owner } = await store.issue(['owner'], 'o');
  const { token: write } = await store.issue([WRITE, SESSION_READ], 'w');
  const auditPath = join(runtimeBase, 'audit.log');
  const gw = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath,
    ...(o.mount === false ? {} : { github: deps }),
  });
  server = await new Promise<Server>((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    owner,
    write,
    auditPath,
    rcDir,
    fetch: fetchFake,
    runner,
    spawner,
    logs,
  };
}

async function call(
  url: string,
  token: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<{
  status: number;
  text: string;
  body: Record<string, unknown> | undefined;
  headers: Headers;
}> {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, text, body: parsed, headers: res.headers };
}

function githubRows(path: string): Array<Record<string, unknown>> {
  const dir = dirname(path);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^audit-.*\.log$/.test(f));
  } catch {
    return [];
  }
  return files
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => String(r['action']).startsWith('github_'));
}

async function pollRows(
  path: string,
  pred: (rows: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 3000;
  let rows = githubRows(path);
  while (!pred(rows) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    rows = githubRows(path);
  }
  return rows;
}

async function freshDest(): Promise<string> {
  return join(await mkdtemp(join(runtimeBase!, 'dest-')), 'hello');
}

async function waitJob(
  url: string,
  owner: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = await call(`${url}/rc/github/clone/${jobId}`, owner);
    if (r.body?.['state'] !== 'running') return r.body!;
    if (Date.now() > deadline) throw new Error('job still running');
    await new Promise((res) => setTimeout(res, 20));
  }
}

const SECRETS = [GH_TOKEN, OAUTH_TOKEN, NEW_TOKEN, DEVICE_CODE, USER_CODE];

describe('scope', () => {
  it('every /rc/github route refuses a write token with 403', async () => {
    const g = await boot({ clientId: CLIENT_ID });
    const routes: Array<['GET' | 'POST' | 'DELETE', string, unknown?]> = [
      ['GET', '/rc/github/accounts'],
      ['GET', '/rc/github/repos?account=gh:octocat'],
      ['POST', '/rc/github/oauth/start', {}],
      ['GET', `/rc/github/oauth/${'a'.repeat(32)}`],
      ['DELETE', '/rc/github/accounts/oauth/octo-oauth'],
      [
        'POST',
        '/rc/github/clone',
        { account: 'gh:octocat', repo: 'octocat/hello', dest: '/tmp/x' },
      ],
      ['GET', '/rc/github/clone/some-job'],
    ];
    expect(routes).toHaveLength(7);
    for (const [method, path, body] of routes) {
      const r = await call(`${g.url}${path}`, g.write, method, body);
      expect([path, r.status]).toEqual([path, 403]);
    }
    expect(g.runner.calls).toEqual([]);
    expect(g.fetch.calls).toEqual([]);
    expect(g.spawner.calls).toEqual([]);
    // The same mount answers the owner, so the 403s are the scope floor.
    expect((await call(`${g.url}/rc/github/accounts`, g.owner)).status).toBe(
      200,
    );
  });

  it('nothing under /rc/github is there when the routes are not mounted', async () => {
    const g = await boot({ mount: false });
    expect((await call(`${g.url}/rc/github/accounts`, g.owner)).status).toBe(
      404,
    );
  });
});

describe('GET /rc/github/accounts', () => {
  it('accounts lists gh then oauth logins and never a token', async () => {
    const g = await boot();
    const r = await call(`${g.url}/rc/github/accounts`, g.owner);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      accounts: [
        {
          id: 'gh:octocat',
          source: 'gh',
          login: 'octocat',
          scopes: ['gist', 'read:org', 'repo'],
        },
        {
          id: 'gh:stale-user',
          source: 'gh',
          login: 'stale-user',
          error: 'gh: The token in keyring is invalid.',
        },
        {
          id: 'oauth:octo-oauth',
          source: 'oauth',
          login: 'octo-oauth',
          scopes: ['repo'],
          connectedAt: expect.any(String),
        },
      ],
      oauthConfigured: false,
      oauthConfigPath: join(g.rcDir, 'github-oauth.json'),
    });
    for (const s of SECRETS) expect(r.text).not.toContain(s);
  });
});

describe('GET /rc/github/repos', () => {
  it("lists an account's repos with the filter", async () => {
    const g = await boot();
    const r = await call(
      `${g.url}/rc/github/repos?account=gh:octocat&q=HEL`,
      g.owner,
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      repos: [
        {
          fullName: 'octocat/hello',
          private: false,
          defaultBranch: 'main',
          pushedAt: '2026-11-01T00:00:00Z',
          description: 'hi',
        },
      ],
      truncated: false,
    });
    expect(r.text).not.toContain(GH_TOKEN);
  });

  it('an account id that is not exactly a listed one is 404 account_not_found and reads no token', async () => {
    const g = await boot();
    for (const id of [
      'gh:OctoCat',
      'gh:nobody',
      'octocat',
      'oauth:OCTO-OAUTH',
    ]) {
      const r = await call(
        `${g.url}/rc/github/repos?account=${encodeURIComponent(id)}`,
        g.owner,
      );
      expect([id, r.status, r.body?.['code']]).toEqual([
        id,
        404,
        'account_not_found',
      ]);
    }
    expect(g.runner.calls.some((c) => c[2] === 'token')).toBe(false);
    expect(g.fetch.calls).toEqual([]);
  });

  it("a GitHub failure is 502 github_failed with GitHub's status and message, scrubbed", async () => {
    const g = await boot({
      fetch: fakeFetch({
        repos: () => json({ message: `Bad credentials for ${GH_TOKEN}` }, 401),
      }),
    });
    const r = await call(
      `${g.url}/rc/github/repos?account=gh:octocat`,
      g.owner,
    );
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: 'github_failed', status: 401 });
    expect(String(r.body!['error'])).toContain('Bad credentials');
    expect(r.text).not.toContain(GH_TOKEN);
  });
});

describe('POST /rc/github/clone', () => {
  it('clone refuses a non-empty destination with 409 dest_not_empty and runs no git', async () => {
    const g = await boot();
    const dest = await freshDest();
    mkdirSync(dest);
    writeFileSync(join(dest, 'x'), 'x');
    const r = await call(`${g.url}/rc/github/clone`, g.owner, 'POST', {
      account: 'gh:octocat',
      repo: 'octocat/hello',
      dest,
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'dest_not_empty' });
    expect(g.spawner.calls).toEqual([]);
    expect(g.runner.calls.some((c) => c[2] === 'token')).toBe(false);
  });

  it('clone refuses an invalid repo with 400 invalid_repo', async () => {
    const g = await boot();
    for (const repo of [
      '--upload-pack=x/y',
      'https://evil.example/octocat/hello',
      'octocat',
      42,
    ]) {
      const r = await call(`${g.url}/rc/github/clone`, g.owner, 'POST', {
        account: 'gh:octocat',
        repo,
        dest: await freshDest(),
      });
      expect([repo, r.status, r.body?.['code']]).toEqual([
        repo,
        400,
        'invalid_repo',
      ]);
    }
    expect(g.spawner.calls).toEqual([]);
  });

  it('a relative destination is 400 dest_not_absolute', async () => {
    const g = await boot();
    const r = await call(`${g.url}/rc/github/clone`, g.owner, 'POST', {
      account: 'gh:octocat',
      repo: 'octocat/hello',
      dest: 'rel/path',
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'dest_not_absolute' });
  });

  it('an unknown account is 404 account_not_found', async () => {
    const g = await boot();
    const r = await call(`${g.url}/rc/github/clone`, g.owner, 'POST', {
      account: 'gh:OCTOCAT',
      repo: 'octocat/hello',
      dest: await freshDest(),
    });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'account_not_found' });
    expect(g.spawner.calls).toEqual([]);
  });

  it('a clone runs to done and its status carries findings', async () => {
    const spawner = fakeSpawner((c, callInfo) => {
      const dest = callInfo.args[callInfo.args.length - 1]!;
      mkdirSync(join(dest, '.qwen'), { recursive: true });
      writeFileSync(
        join(dest, '.qwen', 'settings.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'echo hi' }] },
            ],
          },
        }),
      );
      c.stderr.write(`Cloning into '${dest}'...\n`);
      void c.exit(0);
    });
    const g = await boot({ spawner });
    const dest = await freshDest();
    const r = await call(`${g.url}/rc/github/clone`, g.owner, 'POST', {
      account: 'gh:octocat',
      repo: 'https://github.com/octocat/hello.git',
      dest,
    });
    expect(r.status).toBe(202);
    expect(Object.keys(r.body!)).toEqual(['jobId']);
    const s = await waitJob(g.url, g.owner, String(r.body!['jobId']));
    expect(s).toMatchObject({
      state: 'done',
      repo: 'octocat/hello',
      account: 'gh:octocat',
      dest,
      hasFindings: true,
    });
    expect((s['findings'] as { hooks: unknown[] }).hooks).toEqual([
      { event: 'SessionStart', command: 'echo hi' },
    ]);
    // The token reached git through its env only.
    expect(spawner.calls[0]!.env['QWEN_RC_GIT_TOKEN']).toBe(GH_TOKEN);
    expect(spawner.calls[0]!.args.join(' ')).not.toContain(GH_TOKEN);
    expect(JSON.stringify(s)).not.toContain(GH_TOKEN);
  });

  it('a clone with a gh login gh lists as failing is started, with a warning naming it', async () => {
    const g = await boot();
    const r = await call(`${g.url}/rc/github/clone`, g.owner, 'POST', {
      account: 'gh:stale-user',
      repo: 'octocat/hello',
      dest: await freshDest(),
    });
    expect(r.status).toBe(202);
    expect(String(r.body!['warning'])).toContain('stale-user');
    expect(String(r.body!['warning'])).toContain('failing');
  });

  it('a third concurrent clone is 429 too_many_clones', async () => {
    const spawner = fakeSpawner(() => {
      // never exits on its own
    });
    const g = await boot({ spawner });
    const start = async () =>
      call(`${g.url}/rc/github/clone`, g.owner, 'POST', {
        account: 'gh:octocat',
        repo: 'octocat/hello',
        dest: await freshDest(),
      });
    expect((await start()).status).toBe(202);
    expect((await start()).status).toBe(202);
    const third = await start();
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ code: 'too_many_clones' });
  });

  it('an unknown job is 404 job_not_found', async () => {
    const g = await boot();
    const r = await call(`${g.url}/rc/github/clone/nope`, g.owner);
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'job_not_found' });
  });
});

describe('device flow routes', () => {
  it('oauth start without a client id is 409 oauth_not_configured naming the config path', async () => {
    const g = await boot();
    const r = await call(`${g.url}/rc/github/oauth/start`, g.owner, 'POST', {});
    expect(r.status).toBe(409);
    const path = join(g.rcDir, 'github-oauth.json');
    expect(r.body).toMatchObject({
      code: 'oauth_not_configured',
      configPath: path,
    });
    expect(String(r.body!['error'])).toContain(path);
    expect(g.fetch.calls).toEqual([]);
  });

  it('starts a flow, answers its state, and an unknown flow is 404 flow_not_found', async () => {
    const g = await boot({ clientId: CLIENT_ID });
    const r = await call(`${g.url}/rc/github/oauth/start`, g.owner, 'POST', {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      flowId: expect.stringMatching(/^[0-9a-f]{32}$/),
      userCode: USER_CODE,
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
    });
    expect(r.text).not.toContain(DEVICE_CODE);
    const s = await call(
      `${g.url}/rc/github/oauth/${String(r.body!['flowId'])}`,
      g.owner,
    );
    expect(s.status).toBe(200);
    expect(s.body).toEqual({ state: 'pending' });
    const unknown = await call(
      `${g.url}/rc/github/oauth/${'f'.repeat(32)}`,
      g.owner,
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'flow_not_found' });
  });

  it('oauth start is capped per minute, and a failed start holds no flow slot', async () => {
    let t = 1_000_000;
    const g = await boot({
      clientId: CLIENT_ID,
      now: () => t,
      fetch: fakeFetch({
        deviceCode: (n) =>
          n === 1
            ? json({ error: 'service_unavailable' }, 503)
            : json({
                device_code: `${DEVICE_CODE}-${n}`,
                user_code: USER_CODE,
                verification_uri: 'https://github.com/login/device',
                expires_in: 900,
                interval: 1,
              }),
      }),
    });
    const start = () =>
      call(`${g.url}/rc/github/oauth/start`, g.owner, 'POST', {});
    const failed = await start();
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ code: 'github_failed', status: 503 });
    // Four flows (the live cap) still start after it: the failure held none.
    for (let i = 0; i < 4; i++) expect((await start()).status).toBe(200);
    // Five starts reached GitHub this minute.
    expect(OAUTH_STARTS_PER_WINDOW).toBe(5);
    const limited = await start();
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // A minute on, the window has room but four flows are still pending.
    t += 61_000;
    const busy = await start();
    expect(busy.status).toBe(429);
    expect(busy.body).toMatchObject({ code: 'too_many_flows' });
    // That refusal never asked GitHub, so it did not use up the window.
    expect(
      g.fetch.calls.filter((u) => u.includes('/login/device/code')),
    ).toHaveLength(5);
  });

  it('audit rows for a clone and a connect carry no token or user code', async () => {
    const spawner = fakeSpawner((c) => void c.exit(0));
    let approved = false;
    const g = await boot({
      clientId: CLIENT_ID,
      spawner,
      fetch: fakeFetch({
        accessToken: () =>
          approved
            ? json({
                access_token: NEW_TOKEN,
                token_type: 'bearer',
                scope: 'repo',
              })
            : json({ error: 'authorization_pending' }),
      }),
    });
    const dest = await freshDest();
    const c = await call(`${g.url}/rc/github/clone`, g.owner, 'POST', {
      account: 'oauth:octo-oauth',
      repo: 'octocat/hello',
      dest,
    });
    expect(c.status).toBe(202);
    await waitJob(g.url, g.owner, String(c.body!['jobId']));
    expect(spawner.calls[0]!.env['QWEN_RC_GIT_TOKEN']).toBe(OAUTH_TOKEN);

    const f = await call(`${g.url}/rc/github/oauth/start`, g.owner, 'POST', {});
    expect(f.status).toBe(200);
    approved = true;
    const rows = await pollRows(
      g.auditPath,
      (rs) =>
        rs.some((r) => r['action'] === 'github_clone') &&
        rs.some((r) => r['action'] === 'github_oauth_connected'),
    );
    const cloneRow = rows.find((r) => r['action'] === 'github_clone');
    expect(cloneRow).toMatchObject({
      outcome: 'ok',
      detail: {
        outcome: 'done',
        account: 'oauth:octo-oauth',
        login: 'octo-oauth',
        repo: 'octocat/hello',
        dest,
      },
    });
    expect(typeof cloneRow!['actorTokenId']).toBe('string');
    const connected = rows.find(
      (r) => r['action'] === 'github_oauth_connected',
    );
    expect(connected).toMatchObject({
      outcome: 'ok',
      detail: { state: 'connected', login: 'octo-new' },
    });
    expect(typeof connected!['actorTokenId']).toBe('string');
    const text = JSON.stringify(rows);
    for (const s of SECRETS) expect(text).not.toContain(s);
    // The new account is listed at once, not after the cache runs out.
    const a = await call(
      `${g.url}/rc/github/repos?account=oauth:octo-new`,
      g.owner,
    );
    expect(a.status).toBe(200);
  });

  it('a denied connect writes github_oauth_failed with its state', async () => {
    const g = await boot({
      clientId: CLIENT_ID,
      fetch: fakeFetch({ accessToken: () => json({ error: 'access_denied' }) }),
    });
    expect(
      (await call(`${g.url}/rc/github/oauth/start`, g.owner, 'POST', {}))
        .status,
    ).toBe(200);
    const rows = await pollRows(g.auditPath, (rs) =>
      rs.some((r) => r['action'] === 'github_oauth_failed'),
    );
    expect(
      rows.find((r) => r['action'] === 'github_oauth_failed'),
    ).toMatchObject({
      outcome: 'failed',
      detail: { state: 'denied' },
    });
    for (const s of SECRETS) expect(JSON.stringify(rows)).not.toContain(s);
  });
});

describe('DELETE /rc/github/accounts/:source/:login', () => {
  it('forgets an oauth login, audits it, and drops its cached repos', async () => {
    const g = await boot();
    const list = () =>
      call(`${g.url}/rc/github/repos?account=oauth:octo-oauth`, g.owner);
    expect((await list()).status).toBe(200);
    expect(g.fetch.calls).toHaveLength(1);
    const r = await call(
      `${g.url}/rc/github/accounts/oauth/octo-oauth`,
      g.owner,
      'DELETE',
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ forgotten: true });
    expect((await list()).status).toBe(404);
    const rows = await pollRows(g.auditPath, (rs) =>
      rs.some((x) => x['action'] === 'github_oauth_forgotten'),
    );
    expect(
      rows.find((x) => x['action'] === 'github_oauth_forgotten'),
    ).toMatchObject({ outcome: 'ok', detail: { login: 'octo-oauth' } });
    expect(JSON.stringify(rows)).not.toContain(OAUTH_TOKEN);
    // Connected again: the listing asks GitHub again rather than reusing
    // what was cached before the forget.
    await (
      github!.store as unknown as {
        put(l: string, t: string, s: string[]): Promise<void>;
      }
    ).put('octo-oauth', OAUTH_TOKEN, ['repo']);
    expect((await list()).status).toBe(200);
    expect(g.fetch.calls).toHaveLength(2);
  });

  it('a gh login is 400 not_removable and an unknown one 404 account_not_found', async () => {
    const g = await boot();
    const gh = await call(
      `${g.url}/rc/github/accounts/gh/octocat`,
      g.owner,
      'DELETE',
    );
    expect(gh.status).toBe(400);
    expect(gh.body).toMatchObject({ code: 'not_removable' });
    for (const path of [
      'oauth/OCTO-OAUTH',
      'oauth/nobody',
      'other/octo-oauth',
    ]) {
      const r = await call(
        `${g.url}/rc/github/accounts/${path}`,
        g.owner,
        'DELETE',
      );
      expect([path, r.status, r.body?.['code']]).toEqual([
        path,
        404,
        'account_not_found',
      ]);
    }
    expect(github!.store.list().map((a) => a.login)).toEqual(['octo-oauth']);
  });
});

describe('boot config', () => {
  async function dir() {
    runtimeBase = await mkdtemp(join(tmpdir(), 'rc-github-cfg-'));
    return runtimeBase;
  }

  it('reads the client id from the env first, then the file', async () => {
    const d = await dir();
    const path = join(d, 'github-oauth.json');
    writeFileSync(path, JSON.stringify({ clientId: 'Iv1.fromfile' }));
    const logs: string[] = [];
    expect(
      await readGitHubClientId(
        path,
        { QWEN_RC_GITHUB_CLIENT_ID: 'Iv1.fromenv' },
        (l) => logs.push(l),
      ),
    ).toEqual({ clientId: 'Iv1.fromenv', source: 'env' });
    expect(await readGitHubClientId(path, {}, (l) => logs.push(l))).toEqual({
      clientId: 'Iv1.fromfile',
      source: 'file',
    });
    expect(logs).toEqual([]);
  });

  it('a missing file is unconfigured and says nothing', async () => {
    const d = await dir();
    const logs: string[] = [];
    expect(
      await readGitHubClientId(join(d, 'none.json'), {}, (l) => logs.push(l)),
    ).toEqual({});
    expect(logs).toEqual([]);
  });

  it('a malformed file is unconfigured with one line naming the path and the cause, never the contents', async () => {
    const d = await dir();
    const path = join(d, 'github-oauth.json');
    for (const text of [
      '{"clientId": "Iv1.secretish',
      JSON.stringify({ clientId: 'bad id with spaces secretish' }),
      JSON.stringify({ other: 'secretish' }),
    ]) {
      writeFileSync(path, text);
      const logs: string[] = [];
      const r = await readGitHubClientId(path, {}, (l) => logs.push(l));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(path);
      expect(logs[0]).not.toContain('secretish');
      // The same reason, for the accounts answer, and no client id.
      expect(r).toEqual({ error: logs[0]!.replace(/^github clone: /, '') });
    }
  });

  it('opens unconfigured from a dir with no files, and runs nothing at boot', async () => {
    const d = await dir();
    const fetchFake = fakeFetch();
    const runner = fakeRunner();
    const logs: string[] = [];
    const deps = await openGitHubDeps({
      rcDir: join(d, 'rc'),
      env: {},
      log: (l) => logs.push(l),
      fetch: fetchFake.fn,
      run: runner.run,
    });
    expect(deps).toBeDefined();
    expect(deps!.flows.configured()).toBe(false);
    expect(deps!.oauthConfigPath).toBe(join(d, 'rc', 'github-oauth.json'));
    expect(fetchFake.calls).toEqual([]);
    expect(runner.calls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('OAuth connect off');
  });

  it('opens with the store marked refused when the token store refuses its file', async () => {
    const d = await dir();
    const rcDir = join(d, 'rc');
    mkdirSync(rcDir, { mode: 0o700 });
    writeFileSync(join(rcDir, 'github-oauth-tokens.json'), '{}', {
      mode: 0o666,
    });
    chmodSync(join(rcDir, 'github-oauth-tokens.json'), 0o666);
    writeFileSync(
      join(rcDir, 'github-oauth.json'),
      JSON.stringify({ clientId: CLIENT_ID }),
    );
    const logs: string[] = [];
    const deps = await openGitHubDeps({
      rcDir,
      env: {},
      log: (l) => logs.push(l),
      fetch: fakeFetch().fn,
      run: fakeRunner().run,
    });
    expect(deps.oauthStoreError).toContain('writable');
    // A client id alone does not turn connect on over a refused store.
    expect(deps.flows.configured()).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('OAuth connect off');
    expect(logs[0]).toContain('writable');
  });
});

describe('OAuth setup reasons in the accounts answer', () => {
  it('a malformed github-oauth.json is said in oauthConfigError, path and cause, never the contents', async () => {
    const g = await boot({ oauthFile: '{"clientId": "Iv1.secretish' });
    const a = await call(`${g.url}/rc/github/accounts`, g.owner);
    expect(a.status).toBe(200);
    expect(a.body!['oauthConfigured']).toBe(false);
    expect(a.body!['oauthConfigError']).toBe(
      `${join(g.rcDir, 'github-oauth.json')} is not valid JSON; OAuth connect is off`,
    );
    expect(a.text).not.toContain('secretish');
  });

  it('a client id of the wrong shape is said in oauthConfigError without the id', async () => {
    const bad = await boot({
      oauthFile: JSON.stringify({ clientId: 'bad id secretish' }),
    });
    const b = await call(`${bad.url}/rc/github/accounts`, bad.owner);
    expect(String(b.body!['oauthConfigError'])).toMatch(
      /"clientId" in .* is not a valid client id/,
    );
    expect(b.text).not.toContain('secretish');
  });

  it('a configured gateway has neither reason', async () => {
    const g = await boot({ clientId: CLIENT_ID });
    const a = await call(`${g.url}/rc/github/accounts`, g.owner);
    expect(a.body!['oauthConfigured']).toBe(true);
    expect(a.body).not.toHaveProperty('oauthConfigError');
    expect(a.body).not.toHaveProperty('oauthStoreError');
  });

  it('a refused token store mounts the routes: gh logins list and clone, connect and forget are 409 oauth_store_refused', async () => {
    const spawner = fakeSpawner((c) => void c.exit(0));
    const g = await boot({ clientId: CLIENT_ID, refuseStore: true, spawner });
    const caps = await call(`${g.url}/rc/capabilities`, g.owner);
    expect(
      (caps.body!['remoteControl'] as Record<string, unknown>)['githubClone'],
    ).toBe(true);
    const a = await call(`${g.url}/rc/github/accounts`, g.owner);
    expect(a.status).toBe(200);
    expect(
      (a.body!['accounts'] as Array<{ id: string }>).map((x) => x.id),
    ).toEqual(['gh:octocat', 'gh:stale-user']);
    expect(a.body!['oauthConfigured']).toBe(false);
    expect(String(a.body!['oauthStoreError'])).toContain('writable');
    const start = await call(
      `${g.url}/rc/github/oauth/start`,
      g.owner,
      'POST',
      {},
    );
    expect(start.status).toBe(409);
    expect(start.body!['code']).toBe('oauth_store_refused');
    expect(String(start.body!['error'])).toContain('writable');
    expect(g.fetch.calls).toEqual([]);
    const forget = await call(
      `${g.url}/rc/github/accounts/oauth/octo-oauth`,
      g.owner,
      'DELETE',
    );
    expect(forget.status).toBe(409);
    expect(forget.body!['code']).toBe('oauth_store_refused');
    const gh = await call(
      `${g.url}/rc/github/accounts/gh/octocat`,
      g.owner,
      'DELETE',
    );
    expect(gh.status).toBe(400);
    const c = await call(`${g.url}/rc/github/clone`, g.owner, 'POST', {
      account: 'gh:octocat',
      repo: 'octocat/hello',
      dest: await freshDest(),
    });
    expect(c.status).toBe(202);
    for (const secret of SECRETS) {
      expect(a.text + start.text + forget.text + c.text).not.toContain(secret);
    }
  });
});

describe('shutdown', () => {
  it('stopping the deps ends a running clone failed and a pending flow stopped', async () => {
    const spawner = fakeSpawner(() => {
      // never exits on its own
    });
    const g = await boot({ clientId: CLIENT_ID, spawner });
    const c = await call(`${g.url}/rc/github/clone`, g.owner, 'POST', {
      account: 'gh:octocat',
      repo: 'octocat/hello',
      dest: await freshDest(),
    });
    const f = await call(`${g.url}/rc/github/oauth/start`, g.owner, 'POST', {});
    await vi.waitFor(() => expect(spawner.calls).toHaveLength(1));
    github!.flows.stopAll();
    github!.clones.stopAll();
    const s = await waitJob(g.url, g.owner, String(c.body!['jobId']));
    expect(s['state']).toBe('failed');
    expect(String(s['error'])).toMatch(/^gateway stopped/);
    const fs = await call(
      `${g.url}/rc/github/oauth/${String(f.body!['flowId'])}`,
      g.owner,
    );
    expect(fs.body).toEqual({ state: 'failed', code: 'stopped' });
  });
});

describe('capability', () => {
  it('githubClone is true only when the routes are mounted', async () => {
    const on = await boot();
    const a = await call(`${on.url}/rc/capabilities`, on.owner);
    expect(
      (a.body!['remoteControl'] as Record<string, unknown>)['githubClone'],
    ).toBe(true);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    await stub!.close();
    stub = undefined;
    const off = await boot({ mount: false });
    const b = await call(`${off.url}/rc/capabilities`, off.owner);
    expect(
      (b.body!['remoteControl'] as Record<string, unknown>)['githubClone'],
    ).toBe(false);
  });
});
