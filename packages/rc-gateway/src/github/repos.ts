/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * List the repos a connected GitHub account can reach, with a name filter
 * (InfiniteInsight/Qwen-Code-Remote#257). The token goes only in the
 * `Authorization` header of a request that refuses redirects: never in a URL,
 * an error message or the cache key. An error names GitHub's status and
 * `message`, scrubbed of the token first.
 *
 * The unfiltered pages are cached per `cacheKey` (the account id) for
 * {@link REPO_CACHE_MS}, so typing a filter reuses one fetch; concurrent
 * calls for a key share one fetch; a failed fetch is not cached.
 */

import { parseRepoRef } from './refs.js';
import { scrubSecrets } from './scrub.js';

export const REPOS_URL = 'https://api.github.com/user/repos';
export const REPO_CACHE_MS = 60_000;
/** Accounts whose repo lists are kept at once, oldest dropped first. */
export const MAX_CACHED_ACCOUNTS = 16;
export const MAX_PAGES = 5;
export const PAGE_SIZE = 100;
export const MAX_RESULTS = 50;
export const MAX_QUERY_CHARS = 100;
/** One HTTP request's time cap. */
export const REPOS_REQUEST_TIMEOUT_MS = 15_000;

const MAX_BODY_CHARS = 8 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_BRANCH_CHARS = 255;
const USER_AGENT = 'qwen-code-rc-gateway';

export interface RepoSummary {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string;
  description: string | null;
}

export interface RepoList {
  repos: RepoSummary[];
  truncated: boolean;
}

export interface ListReposDeps {
  fetch: typeof globalThis.fetch;
  /** Sent in the Authorization header only. */
  token: string;
  /** The account id; the cache is kept per key. Never the token. */
  cacheKey: string;
  now?: () => number;
}

/** A failed listing; the message holds GitHub's status and message, no token. */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

interface Cached {
  at: number;
  repos: RepoSummary[];
  /** More pages existed than were read. */
  pagesCut: boolean;
}

const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<Cached>>();

/** Drops every cached list and shared fetch; for tests. */
export function resetRepoCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * The account's repos whose `full_name` contains `q` (case-insensitive),
 * in the order GitHub sent them (most recently pushed first), at most
 * {@link MAX_RESULTS}. `truncated` when pages or matches were cut. Throws
 * {@link GitHubApiError}.
 */
export async function listRepos(
  deps: ListReposDeps,
  q: string,
): Promise<RepoList> {
  const now = deps.now ?? (() => Date.now());
  const data = await load(deps, now);
  const needle = (typeof q === 'string' ? q : '')
    .slice(0, MAX_QUERY_CHARS)
    .toLowerCase();
  const matches =
    needle === ''
      ? data.repos
      : data.repos.filter((r) => r.fullName.toLowerCase().includes(needle));
  return {
    repos: matches.slice(0, MAX_RESULTS).map((r) => ({ ...r })),
    truncated: data.pagesCut || matches.length > MAX_RESULTS,
  };
}

async function load(deps: ListReposDeps, now: () => number): Promise<Cached> {
  const key = deps.cacheKey;
  const hit = cache.get(key);
  if (hit) {
    const age = now() - hit.at;
    if (age >= 0 && age < REPO_CACHE_MS) return hit;
    cache.delete(key);
  }
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchAll(deps, now).then((data) => {
    cache.delete(key);
    cache.set(key, data);
    while (cache.size > MAX_CACHED_ACCOUNTS) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return data;
  });
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

async function fetchAll(
  deps: ListReposDeps,
  now: () => number,
): Promise<Cached> {
  const repos: RepoSummary[] = [];
  let pagesCut = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items, link } = await fetchPage(deps, page);
    for (const item of items) {
      const repo = toSummary(item);
      if (repo) repos.push(repo);
    }
    if (items.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) pagesCut = hasNextLink(link);
  }
  return { at: now(), repos, pagesCut };
}

async function fetchPage(
  deps: ListReposDeps,
  page: number,
): Promise<{ items: unknown[]; link: string | null }> {
  const url =
    `${REPOS_URL}?` +
    new URLSearchParams({
      affiliation: 'owner,collaborator,organization_member',
      sort: 'pushed',
      per_page: String(PAGE_SIZE),
      page: String(page),
    }).toString();
  const secrets = [deps.token];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REPOS_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let status: number;
  let ok: boolean;
  let text: string;
  let link: string | null;
  try {
    const res = await deps.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${deps.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
      signal: ctl.signal,
      redirect: 'error',
    });
    status = res.status;
    ok = res.ok;
    link = res.headers.get('link');
    text = await res.text();
  } catch {
    // The underlying error text may echo request details: say nothing of it.
    throw new GitHubApiError('GitHub request failed: network error or timeout');
  } finally {
    clearTimeout(timer);
  }
  if (!ok) {
    throw new GitHubApiError(errorMessage(status, text, secrets), status);
  }
  let parsed: unknown;
  if (text.length <= MAX_BODY_CHARS) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (!Array.isArray(parsed)) {
    throw new GitHubApiError('GitHub answered with an unexpected body', status);
  }
  return { items: parsed, link };
}

function errorMessage(status: number, body: string, secrets: string[]): string {
  let message = '';
  if (body.length <= MAX_BODY_CHARS) {
    try {
      const j = JSON.parse(body) as unknown;
      if (j && typeof j === 'object') {
        const m = (j as Record<string, unknown>)['message'];
        if (typeof m === 'string') message = m;
      }
    } catch {
      // not JSON: the status alone
    }
  }
  const clean = scrubSecrets(message, secrets)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
  return clean === ''
    ? `GitHub answered ${status}`
    : `GitHub answered ${status}: ${clean}`;
}

function hasNextLink(link: string | null): boolean {
  if (!link) return false;
  return link
    .split(',')
    .some((part) =>
      /;\s*rel\s*=\s*"?([^";]*\s)?next(\s[^";]*)?"?\s*(;|$)/i.test(part),
    );
}

/** The fields the page needs, or null when the object is not a usable repo. */
function toSummary(item: unknown): RepoSummary | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const fullName = o['full_name'];
  if (typeof fullName !== 'string') return null;
  const ref = parseRepoRef(fullName);
  // Round trip: refuses a `.git` suffix, a URL form or stray whitespace.
  if (!ref || `${ref.owner}/${ref.name}` !== fullName) return null;
  const isPrivate = o['private'];
  if (typeof isPrivate !== 'boolean') return null;
  const branch = o['default_branch'];
  if (
    typeof branch !== 'string' ||
    branch === '' ||
    branch.length > MAX_BRANCH_CHARS
  ) {
    return null;
  }
  const pushed = o['pushed_at'];
  // GitHub sends null for a repo that was never pushed to.
  if (pushed !== null && typeof pushed !== 'string') return null;
  const desc = o['description'];
  if (desc !== null && desc !== undefined && typeof desc !== 'string') {
    return null;
  }
  return {
    fullName,
    private: isPrivate,
    defaultBranch: branch,
    pushedAt: pushed ?? '',
    description:
      typeof desc === 'string' ? desc.slice(0, MAX_DESCRIPTION_CHARS) : null,
  };
}
