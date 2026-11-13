/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  GitHubApiError,
  listRepos,
  REPO_CACHE_MS,
  resetRepoCache,
} from './repos.js';

const TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';

interface Call {
  url: string;
  init: RequestInit;
}

function repo(i: number, over: Record<string, unknown> = {}) {
  return {
    full_name: `owner/repo-${i}`,
    private: i % 2 === 0,
    default_branch: 'main',
    pushed_at: `2026-11-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    description: i % 3 === 0 ? null : `desc ${i}`,
    id: i,
    owner: { login: 'owner', secret_extra: 'x' },
    ...over,
  };
}

interface Page {
  status?: number;
  body: unknown;
  link?: string;
}

/** A fake fetch answering each call from `pages(url, callIndex)`. */
function fakeFetch(pages: (page: number, n: number) => Page | 'network') {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const page = Number(new URL(u).searchParams.get('page'));
    const a = pages(page, calls.length - 1);
    if (a === 'network') throw new Error(`boom ${TOKEN}`);
    const headers = new Headers();
    if (a.link) headers.set('link', a.link);
    return new Response(
      typeof a.body === 'string' ? a.body : JSON.stringify(a.body),
      { status: a.status ?? 200, headers },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const NEXT = '<https://api.github.com/user/repos?page=6>; rel="next"';

describe('listRepos', () => {
  beforeEach(() => resetRepoCache());

  it('filters by name and sorts as GitHub sent', async () => {
    const f = fakeFetch(() => ({
      body: [
        repo(1, { full_name: 'owner/zeta-app' }),
        repo(2, { full_name: 'Acme/Widget' }),
        repo(3, { full_name: 'owner/alpha-app' }),
      ],
    }));
    const all = await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:me' },
      '',
    );
    expect(all.repos.map((r) => r.fullName)).toEqual([
      'owner/zeta-app',
      'Acme/Widget',
      'owner/alpha-app',
    ]);
    expect(all.truncated).toBe(false);
    const hit = await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:me' },
      'APP',
    );
    expect(hit.repos.map((r) => r.fullName)).toEqual([
      'owner/zeta-app',
      'owner/alpha-app',
    ]);
    // Only the named fields come back.
    expect(Object.keys(hit.repos[0]!).sort()).toEqual([
      'defaultBranch',
      'description',
      'fullName',
      'private',
      'pushedAt',
    ]);
    expect(f.calls).toHaveLength(1);
  });

  it('asks for the documented URL with the token in the header only', async () => {
    const f = fakeFetch(() => ({ body: [repo(1)] }));
    await listRepos({ fetch: f.fn, token: TOKEN, cacheKey: 'gh:me' }, '');
    const call = f.calls[0]!;
    expect(call.url).toBe(
      'https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&sort=pushed&per_page=100&page=1',
    );
    expect(call.url).not.toContain(TOKEN);
    const h = call.init.headers as Record<string, string>;
    expect(h['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(call.init.redirect).toBe('error');
    expect(call.init.signal).toBeDefined();
    expect(call.init.method).toBe('GET');
  });

  it('stops at five pages and says truncated', async () => {
    const f = fakeFetch((page) => ({
      body: Array.from({ length: 100 }, (_, i) => repo(page * 1000 + i)),
      link: page === 5 ? NEXT : undefined,
    }));
    const out = await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:me' },
      'repo',
    );
    expect(f.calls).toHaveLength(5);
    expect(out.truncated).toBe(true);
    expect(out.repos).toHaveLength(50);
  });

  it('stops early on a short page and is not truncated', async () => {
    const f = fakeFetch((page) => ({
      body: Array.from({ length: page === 2 ? 3 : 100 }, (_, i) =>
        repo(page * 1000 + i),
      ),
    }));
    const out = await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:me' },
      'zzz',
    );
    expect(f.calls).toHaveLength(2);
    expect(out).toEqual({ repos: [], truncated: false });
  });

  it('five full pages with no next link are not truncated', async () => {
    const f = fakeFetch((page) => ({
      body: Array.from({ length: 100 }, (_, i) => repo(page * 1000 + i)),
    }));
    const out = await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:me' },
      'no-such-thing',
    );
    expect(out.truncated).toBe(false);
  });

  it('says truncated when more than 50 match', async () => {
    const f = fakeFetch(() => ({
      body: Array.from({ length: 60 }, (_, i) => repo(i)),
    }));
    const out = await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:me' },
      '',
    );
    expect(out.repos).toHaveLength(50);
    expect(out.truncated).toBe(true);
  });

  it('serves the cache within 60 s and refetches after', async () => {
    const f = fakeFetch(() => ({ body: [repo(1)] }));
    const c = clock();
    const deps = {
      fetch: f.fn,
      token: TOKEN,
      cacheKey: 'gh:me',
      now: c.now,
    };
    await listRepos(deps, '');
    c.advance(REPO_CACHE_MS - 1);
    await listRepos(deps, 'repo');
    expect(f.calls).toHaveLength(1);
    c.advance(1);
    await listRepos(deps, '');
    expect(f.calls).toHaveLength(2);
  });

  it('keeps caches apart per cacheKey', async () => {
    const f = fakeFetch(() => ({ body: [repo(1)] }));
    await listRepos({ fetch: f.fn, token: TOKEN, cacheKey: 'gh:a' }, '');
    await listRepos({ fetch: f.fn, token: TOKEN, cacheKey: 'gh:b' }, '');
    expect(f.calls).toHaveLength(2);
  });

  it('bounds the cache by evicting the oldest key', async () => {
    const f = fakeFetch(() => ({ body: [repo(1)] }));
    const c = clock();
    const mk = (k: string) => ({
      fetch: f.fn,
      token: TOKEN,
      cacheKey: k,
      now: c.now,
    });
    for (let i = 0; i < 17; i++) {
      await listRepos(mk(`bound:${i}`), '');
      c.advance(1);
    }
    expect(f.calls).toHaveLength(17);
    await listRepos(mk('bound:16'), '');
    expect(f.calls).toHaveLength(17);
    await listRepos(mk('bound:0'), '');
    expect(f.calls).toHaveLength(18);
  });

  it('shares one fetch between concurrent calls for a key', async () => {
    const f = fakeFetch(() => ({ body: [repo(1)] }));
    const deps = { fetch: f.fn, token: TOKEN, cacheKey: 'gh:conc' };
    const [a, b] = await Promise.all([
      listRepos(deps, ''),
      listRepos(deps, 'repo'),
    ]);
    expect(f.calls).toHaveLength(1);
    expect(a.repos).toHaveLength(1);
    expect(b.repos).toHaveLength(1);
  });

  it('does not cache a failure', async () => {
    let n = 0;
    const f = fakeFetch(() =>
      n++ === 0
        ? { status: 500, body: { message: 'oops' } }
        : { body: [repo(1)] },
    );
    const deps = { fetch: f.fn, token: TOKEN, cacheKey: 'gh:fail' };
    await expect(listRepos(deps, '')).rejects.toBeInstanceOf(GitHubApiError);
    const out = await listRepos(deps, '');
    expect(out.repos).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
  });

  it("a 401 throws with GitHub's message and status", async () => {
    const f = fakeFetch(() => ({
      status: 401,
      body: { message: 'Bad credentials' },
    }));
    const err = await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:401' },
      '',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(401);
    expect((err as Error).message).toBe('GitHub answered 401: Bad credentials');
  });

  it('scrubs the token out of an error message', async () => {
    const f = fakeFetch(() => ({
      status: 403,
      body: { message: `token ${TOKEN} lacks scope` },
    }));
    const err = (await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:403' },
      '',
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('403');
    expect(err.message).not.toContain(TOKEN);
  });

  it('a non-JSON error body still names the status', async () => {
    const f = fakeFetch(() => ({ status: 502, body: '<html>bad gateway' }));
    const err = (await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:502' },
      '',
    ).catch((e: unknown) => e)) as GitHubApiError;
    expect(err.status).toBe(502);
    expect(err.message).toBe('GitHub answered 502');
  });

  it('a network error throws without the token', async () => {
    const f = fakeFetch(() => 'network');
    const err = (await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:net' },
      '',
    ).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.message).not.toContain(TOKEN);
  });

  it('throws on a body that is not an array', async () => {
    const f = fakeFetch(() => ({ body: { repos: [] } }));
    await expect(
      listRepos({ fetch: f.fn, token: TOKEN, cacheKey: 'gh:obj' }, ''),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('skips malformed repo objects and unsafe names', async () => {
    const f = fakeFetch(() => ({
      body: [
        repo(1),
        null,
        'str',
        repo(2, { full_name: 'a/b/c' }),
        repo(3, { full_name: '-bad/repo' }),
        repo(4, { full_name: 'owner/--upload-pack=x y' }),
        repo(5, { full_name: 'owner/x.git' }),
        repo(6, { full_name: 42 }),
        repo(7, { private: 'yes' }),
        repo(8, { default_branch: null }),
        repo(9, { description: 5 }),
        repo(10, { pushed_at: 5 }),
        repo(11, { pushed_at: null }),
      ],
    }));
    const out = await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:bad' },
      '',
    );
    expect(out.repos.map((r) => r.fullName)).toEqual([
      'owner/repo-1',
      'owner/repo-11',
    ]);
    expect(out.repos[1]!.pushedAt).toBe('');
  });

  it('caps q at 100 characters', async () => {
    const name = `owner/${'a'.repeat(94)}`;
    expect(name).toHaveLength(100);
    const f = fakeFetch(() => ({ body: [repo(1, { full_name: name })] }));
    const out = await listRepos(
      { fetch: f.fn, token: TOKEN, cacheKey: 'gh:q' },
      `${name}ZZZ`,
    );
    expect(out.repos).toHaveLength(1);
  });
});
