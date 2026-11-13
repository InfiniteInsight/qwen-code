/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where clone-to-conversation gets a GitHub token
 * (InfiniteInsight/Qwen-Code-Remote#257). Two sources:
 *
 * - `gh:<login>`: an account the laptop's `gh` CLI is already logged in to.
 *   The gateway reads the login list from `gh auth status` and one account's
 *   token from `gh auth token --user <login>`, which does not switch gh's
 *   active account. It never runs `gh auth login`, `gh auth switch` or
 *   `--show-token`.
 * - `oauth:<login>`: a token the gateway itself obtained through the device
 *   flow and keeps in {@link OAuthTokenStore}, a 0600 file in a 0700 dir.
 *
 * A token leaves this module only through `token(id)`. Lists carry the login,
 * scopes and dates, never a token, and no error message here ever holds a
 * child's stdout (which is where `gh auth token` prints the token).
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, stat } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { readJsonStore, writeFileAtomic } from '../atomicWrite.js';
import { NON_OWNER_WRITE_MASK } from '../policy/permissions.js';
import { scrubSecrets } from './scrub.js';

export type GitHubAccountId = `gh:${string}` | `oauth:${string}`;

export interface GitHubAccount {
  id: GitHubAccountId;
  source: 'gh' | 'oauth';
  login: string;
  scopes?: string[];
  connectedAt?: string;
  error?: string;
}

/** A GitHub login. Checked before a login reaches an argv or a store key. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A token as stored or handed on: printable ASCII, no space, bounded. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,4096}$/;

/** An OAuth scope name such as `repo` or `read:org`. */
const SCOPE_SHAPE = /^[A-Za-z0-9:_.-]{1,100}$/;

/**
 * GitHub token shapes (classic, OAuth, user-to-server, server, refresh and
 * fine-grained). Scrubbed from any child text kept here as a second guard,
 * after the known token itself.
 */
const TOKEN_LIKE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g;

export const GH_STATUS_TIMEOUT_MS = 10_000;
export const GH_TOKEN_TIMEOUT_MS = 10_000;

/**
 * Where `gh` is looked for when it is not on the gateway's PATH. The gateway
 * runs as a systemd user unit whose PATH usually lacks `/snap/bin`, where the
 * snap puts gh.
 */
export const GH_FALLBACK_DIRS: readonly string[] = [
  '/snap/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/opt/homebrew/bin',
  '/home/linuxbrew/.linuxbrew/bin',
];

/**
 * How a child exited. `exitCode` is null when there is none (killed on the
 * timeout or by a signal, or never started). `error` is the errno code
 * (`ENOENT`, `EACCES`) when the program could not be spawned at all.
 */
export interface GhRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Runs one argv with a time cap. Never rejects. `argv[0]` is the bare program
 * name `gh`; the real runner resolves it. Injected so tests never run gh.
 */
export type GhRunner = (
  argv: readonly string[],
  timeoutMs: number,
) => Promise<GhRunResult>;

/** A failure with a stable code; the message never holds a token. */
export class GitHubCredentialError extends Error {
  constructor(
    readonly code:
      | 'invalid_login'
      | 'invalid_token'
      | 'invalid_scopes'
      | 'account_not_found'
      | 'gh_failed',
    message: string = code,
  ) {
    super(message);
    this.name = 'GitHubCredentialError';
  }
}

function isLogin(login: unknown): login is string {
  return typeof login === 'string' && GITHUB_LOGIN.test(login);
}

function assertLogin(login: unknown): asserts login is string {
  if (!isLogin(login)) throw new GitHubCredentialError('invalid_login');
}

/** One line of child text, safe to keep: secrets and token shapes masked. */
function safeLine(text: string, secrets: string[]): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return scrubSecrets(line, secrets).replace(TOKEN_LIKE, '***').slice(0, 200);
}

/** `ENOENT: gh` for a gh the OS could not spawn, else undefined. */
function spawnError(out: GhRunResult): string | undefined {
  if (typeof out.error === 'string') {
    const errno =
      out.error.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'ERROR';
    return `${errno}: gh`;
  }
  // A shell's "command not found"; the real runner reports ENOENT itself.
  if (out.exitCode === 127) return 'ENOENT: gh';
  return undefined;
}

/** The injected runner held to its contract: a throw reads as "could not run". */
async function runSafe(
  run: GhRunner,
  argv: readonly string[],
  timeoutMs: number,
): Promise<GhRunResult | undefined> {
  try {
    const out = await run(argv, timeoutMs);
    return {
      exitCode: typeof out?.exitCode === 'number' ? out.exitCode : null,
      stdout: typeof out?.stdout === 'string' ? out.stdout : '',
      stderr: typeof out?.stderr === 'string' ? out.stderr : '',
      ...(typeof out?.error === 'string' ? { error: out.error } : {}),
    };
  } catch {
    return undefined;
  }
}

/** One account `gh auth status` reported. */
export interface GhStatusEntry {
  login: string;
  scopes?: string[];
  /** Set for a `Failed to log in` entry: gh holds a token it cannot use. */
  error?: string;
}

const LOGGED_IN = /Logged in to github\.com account (\S+)/;
const FAILED = /Failed to log in to github\.com account (\S+)/;
const SCOPES = /^\s*-\s*Token scopes:\s*(.*)$/;

/**
 * Parse gh 2.74's text status. Each account starts with a `Logged in to` or
 * `Failed to log in to` line; a `Token scopes:` line belongs to the account
 * above it. A login that is not a valid GitHub login is skipped, so nothing
 * odd in gh's output can become an argv later.
 */
export function parseGhAuthStatus(text: string): GhStatusEntry[] {
  const out: GhStatusEntry[] = [];
  let current: GhStatusEntry | undefined;
  for (const line of text.split(/\r?\n/)) {
    const ok = LOGGED_IN.exec(line);
    const failed = ok ? null : FAILED.exec(line);
    const m = ok ?? failed;
    if (m) {
      current = undefined;
      const login = m[1]!;
      if (!isLogin(login)) continue;
      if (out.some((e) => e.login.toLowerCase() === login.toLowerCase())) {
        continue;
      }
      current = failed
        ? { login, error: 'gh: the token for this login is invalid' }
        : { login };
      out.push(current);
      continue;
    }
    const s = current && !current.error ? SCOPES.exec(line) : null;
    if (s && current) {
      const scopes = [...s[1]!.matchAll(/'([^']*)'/g)]
        .map((x) => x[1]!)
        .filter((x) => SCOPE_SHAPE.test(x));
      current.scopes = scopes;
    }
  }
  return out;
}

/**
 * The github.com logins gh holds, from `gh auth status --hostname github.com`
 * (gh 2.74 has no `--json`). Both stdout and stderr are read: gh has printed
 * the status to either. gh exits 1 when any login is failing, so a non-zero
 * exit with parsable accounts is not an error. `logins` lists only the
 * working ones; `accounts` also carries scopes and failed logins.
 */
export async function listGhLogins(
  run: GhRunner,
): Promise<{ logins: string[]; accounts: GhStatusEntry[]; error?: string }> {
  const out = await runSafe(
    run,
    ['gh', 'auth', 'status', '--hostname', 'github.com'],
    GH_STATUS_TIMEOUT_MS,
  );
  if (!out) {
    return { logins: [], accounts: [], error: 'gh auth status could not run' };
  }
  const missing = spawnError(out);
  if (missing) return { logins: [], accounts: [], error: missing };
  const accounts = parseGhAuthStatus(`${out.stdout}\n${out.stderr}`);
  const logins = accounts.filter((a) => !a.error).map((a) => a.login);
  if (accounts.length > 0) return { logins, accounts };
  if (out.exitCode === null) {
    return { logins, accounts, error: 'gh auth status timed out' };
  }
  const all = `${out.stdout}\n${out.stderr}`;
  // No logins at all is an empty list, not a failure.
  if (out.exitCode === 0 || /not logged in/i.test(all)) {
    return { logins, accounts };
  }
  const why = safeLine(out.stderr || out.stdout, []);
  return {
    logins,
    accounts,
    error: `gh auth status exited ${out.exitCode}` + (why ? `: ${why}` : ''),
  };
}

/**
 * One account's token, from `gh auth token --hostname github.com --user
 * <login>`. Does not switch gh's active account. The login is checked first,
 * so it can never be read as a flag. A failure throws
 * {@link GitHubCredentialError} whose message holds the exit code and at most
 * one scrubbed stderr line, never stdout.
 */
export async function ghToken(login: string, run: GhRunner): Promise<string> {
  assertLogin(login);
  const out = await runSafe(
    run,
    ['gh', 'auth', 'token', '--hostname', 'github.com', '--user', login],
    GH_TOKEN_TIMEOUT_MS,
  );
  if (!out) {
    throw new GitHubCredentialError('gh_failed', 'gh auth token could not run');
  }
  const missing = spawnError(out);
  if (missing) throw new GitHubCredentialError('gh_failed', missing);
  const secrets = [out.stdout, ...out.stdout.split(/\s+/)];
  if (out.exitCode !== 0) {
    const why = safeLine(out.stderr, secrets);
    throw new GitHubCredentialError(
      'gh_failed',
      out.exitCode === null
        ? 'gh auth token timed out'
        : `gh auth token exited ${out.exitCode}` + (why ? `: ${why}` : ''),
    );
  }
  const token = out.stdout.trim();
  if (token.length === 0) {
    throw new GitHubCredentialError(
      'gh_failed',
      `gh holds no token for ${login}`,
    );
  }
  if (!TOKEN_SHAPE.test(token)) {
    throw new GitHubCredentialError(
      'gh_failed',
      'gh auth token gave unexpected output',
    );
  }
  return token;
}

/**
 * Absolute path of `program`: the first executable in `pathEnv`, then in
 * `fallbackDirs`. Undefined when it is in neither.
 */
export async function locateProgram(
  program: string,
  pathEnv: string | undefined,
  fallbackDirs: readonly string[] = GH_FALLBACK_DIRS,
): Promise<string | undefined> {
  const dirs = [...(pathEnv ?? '').split(delimiter), ...fallbackDirs];
  for (const dir of dirs) {
    if (dir.length === 0 || !dir.startsWith('/')) continue;
    const candidate = join(dir, program);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Variables that would make gh use an env token instead of its logins. */
const GH_ENV_TOKENS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

/**
 * The real runner over `execFile` (argv, never a shell). `gh` is resolved
 * with {@link locateProgram}; not found reads as `ENOENT`. gh is run without
 * prompts, without the update check and without any env token, so it reports
 * its own logins. Never rejects.
 */
export function createGhRunner(
  opts: {
    pathEnv?: string | undefined;
    fallbackDirs?: readonly string[];
    env?: NodeJS.ProcessEnv;
  } = {},
): GhRunner {
  const baseEnv = opts.env ?? process.env;
  return async (argv, timeoutMs) => {
    const program =
      argv[0] === 'gh'
        ? await locateProgram(
            'gh',
            'pathEnv' in opts ? opts.pathEnv : baseEnv['PATH'],
            opts.fallbackDirs ?? GH_FALLBACK_DIRS,
          )
        : argv[0];
    if (!program) {
      return { exitCode: null, stdout: '', stderr: '', error: 'ENOENT' };
    }
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
    };
    for (const k of GH_ENV_TOKENS) delete env[k];
    return new Promise<GhRunResult>((resolve) => {
      try {
        execFile(
          program,
          argv.slice(1),
          {
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
            env,
          },
          (err, stdout, stderr) => {
            const so = typeof stdout === 'string' ? stdout : '';
            const se = typeof stderr === 'string' ? stderr : '';
            if (!err) {
              resolve({ exitCode: 0, stdout: so, stderr: se });
              return;
            }
            const e = err as NodeJS.ErrnoException & {
              code?: string | number;
              killed?: boolean;
            };
            if (typeof e.code === 'string') {
              resolve({
                exitCode: null,
                stdout: so,
                stderr: se,
                error: e.code,
              });
            } else if (typeof e.code === 'number' && !e.killed) {
              resolve({ exitCode: e.code, stdout: so, stderr: se });
            } else {
              resolve({ exitCode: null, stdout: so, stderr: se });
            }
          },
        );
      } catch {
        resolve({ exitCode: null, stdout: '', stderr: '', error: 'ERR_SPAWN' });
      }
    });
  };
}

interface StoredAccount {
  login: string;
  token: string;
  scopes: string[];
  connectedAt: string;
}

/** The store refuses the file; the message names why, never a token. */
export class OAuthTokenStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthTokenStoreError';
  }
}

/**
 * The gateway's own GitHub OAuth tokens, one per login, kept as JSON in a
 * 0600 file inside a 0700 directory. Logins are matched case-insensitively,
 * as GitHub does; the spelling of the latest `put` is kept.
 *
 * On open, a file someone left with looser permissions is handled by what the
 * looseness means. Group/world-writable (or a symlink, another owner's file,
 * or a group/world-writable directory): refused, because anyone who could
 * write it could plant a token and make the gateway clone as their account.
 * Only group/world-readable: tightened to 0600 with a warning, because the
 * content is still the owner's but may have been read, so the warning says to
 * revoke the tokens.
 */
export class OAuthTokenStore {
  private readonly accounts = new Map<string, StoredAccount>();

  private constructor(
    private readonly path: string,
    private readonly now: () => Date,
  ) {}

  static async open(
    path: string,
    opts: { log?: (line: string) => void; now?: () => Date } = {},
  ): Promise<OAuthTokenStore> {
    // eslint-disable-next-line no-console
    const log = opts.log ?? ((line: string) => console.warn(line));
    const store = new OAuthTokenStore(path, opts.now ?? (() => new Date()));
    await checkDir(dirname(path));
    let st;
    try {
      st = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw new OAuthTokenStoreError(
        `github oauth store: cannot stat ${path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new OAuthTokenStoreError(
        `github oauth store: ${path} is not a regular file`,
      );
    }
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) {
      throw new OAuthTokenStoreError(
        `github oauth store: ${path} is owned by uid ${st.uid}, not ${uid}`,
      );
    }
    const octal = (st.mode & 0o777).toString(8).padStart(3, '0');
    if ((st.mode & NON_OWNER_WRITE_MASK) !== 0) {
      throw new OAuthTokenStoreError(
        `github oauth store: ${path} is group/world-writable (mode 0${octal}); ` +
          `its tokens cannot be trusted. Remove it, or run: chmod 600 ${path}`,
      );
    }
    if ((st.mode & 0o077) !== 0) {
      await chmod(path, 0o600);
      log(
        `github oauth store: ${path} had mode 0${octal}, tightened to 0600; ` +
          `its tokens may have been read, so revoke them on GitHub and connect again`,
      );
    }
    const raw = await readJsonStore(path);
    const entries =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { accounts?: unknown }).accounts
        : undefined;
    let dropped = 0;
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
      for (const value of Object.values(entries as Record<string, unknown>)) {
        const a = parseStored(value);
        if (a) store.accounts.set(a.login.toLowerCase(), a);
        else dropped++;
      }
    }
    if (dropped > 0) {
      log(
        `github oauth store: dropped ${dropped} malformed entries in ${path}`,
      );
    }
    return store;
  }

  /** Login, scopes and connection time of each stored token; never a token. */
  list(): Array<{ login: string; scopes: string[]; connectedAt: string }> {
    return [...this.accounts.values()].map((a) => ({
      login: a.login,
      scopes: [...a.scopes],
      connectedAt: a.connectedAt,
    }));
  }

  token(login: string): string | undefined {
    if (!isLogin(login)) return undefined;
    return this.accounts.get(login.toLowerCase())?.token;
  }

  /** Store (or replace) a login's token. Throws on a bad login, token or scopes. */
  async put(login: string, token: string, scopes: string[]): Promise<void> {
    assertLogin(login);
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) {
      throw new GitHubCredentialError('invalid_token');
    }
    if (
      !Array.isArray(scopes) ||
      !scopes.every((s) => typeof s === 'string' && SCOPE_SHAPE.test(s))
    ) {
      throw new GitHubCredentialError('invalid_scopes');
    }
    const key = login.toLowerCase();
    const before = this.accounts.get(key);
    const entry: StoredAccount = {
      login,
      token,
      scopes: [...scopes],
      connectedAt: this.now().toISOString(),
    };
    this.accounts.delete(key);
    this.accounts.set(key, entry);
    try {
      await this.persist();
    } catch (err) {
      if (this.accounts.get(key) === entry) {
        this.accounts.delete(key);
        if (before) this.accounts.set(key, before);
      }
      throw err;
    }
  }

  /** Remove a login's token. False when there was none. */
  async forget(login: string): Promise<boolean> {
    if (!isLogin(login)) return false;
    const key = login.toLowerCase();
    const before = this.accounts.get(key);
    if (!before) return false;
    this.accounts.delete(key);
    try {
      await this.persist();
    } catch (err) {
      if (!this.accounts.has(key)) this.accounts.set(key, before);
      throw err;
    }
    return true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      this.path,
      () =>
        JSON.stringify(
          {
            version: 1,
            accounts: Object.fromEntries(this.accounts.entries()),
          },
          null,
          2,
        ) + '\n',
      { mode: 0o600 },
    );
  }
}

/** Refuse a store directory others can write: they could swap the file. */
async function checkDir(dir: string): Promise<void> {
  let st;
  try {
    st = await stat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new OAuthTokenStoreError(
      `github oauth store: cannot stat ${dir}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
    );
  }
  if ((st.mode & NON_OWNER_WRITE_MASK) !== 0) {
    const octal = (st.mode & 0o777).toString(8).padStart(3, '0');
    throw new OAuthTokenStoreError(
      `github oauth store: directory ${dir} is group/world-writable (mode 0${octal}); run: chmod 700 ${dir}`,
    );
  }
}

function parseStored(value: unknown): StoredAccount | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const { login, token, scopes, connectedAt } = v;
  if (!isLogin(login)) return undefined;
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return undefined;
  if (
    !Array.isArray(scopes) ||
    !scopes.every((s) => typeof s === 'string' && SCOPE_SHAPE.test(s))
  ) {
    return undefined;
  }
  if (typeof connectedAt !== 'string') return undefined;
  return { login, token, scopes: [...(scopes as string[])], connectedAt };
}

/**
 * Both sources behind one id space. `accounts()` lists gh logins first, then
 * the gateway's OAuth logins; `token(id)` resolves one, and is the only way a
 * token leaves this module.
 */
export class GitHubCredentials {
  private readonly run: GhRunner;
  private readonly store: OAuthTokenStore;

  constructor(deps: { run: GhRunner; store: OAuthTokenStore }) {
    this.run = deps.run;
    this.store = deps.store;
  }

  /** {@link accounts} plus why gh gave none, when it failed. */
  async status(): Promise<{ accounts: GitHubAccount[]; ghError?: string }> {
    const gh = await listGhLogins(this.run);
    const accounts: GitHubAccount[] = gh.accounts.map((a) => ({
      id: `gh:${a.login}` as const,
      source: 'gh' as const,
      login: a.login,
      ...(a.scopes ? { scopes: [...a.scopes] } : {}),
      ...(a.error ? { error: a.error } : {}),
    }));
    for (const a of this.store.list()) {
      accounts.push({
        id: `oauth:${a.login}`,
        source: 'oauth',
        login: a.login,
        scopes: a.scopes,
        connectedAt: a.connectedAt,
      });
    }
    return gh.error === undefined
      ? { accounts }
      : { accounts, ghError: gh.error };
  }

  async accounts(): Promise<GitHubAccount[]> {
    return (await this.status()).accounts;
  }

  /**
   * The token for one account. An id that is malformed, names a crafted
   * login, or names a login neither source holds throws `account_not_found`.
   * A gh login is checked against gh's current list before its token is read.
   */
  async token(id: GitHubAccountId): Promise<string> {
    const notFound = () => new GitHubCredentialError('account_not_found');
    if (typeof id !== 'string') throw notFound();
    const colon = id.indexOf(':');
    const source = id.slice(0, colon);
    const login = id.slice(colon + 1);
    if (colon < 0 || !isLogin(login)) throw notFound();
    if (source === 'oauth') {
      const t = this.store.token(login);
      if (t === undefined) throw notFound();
      return t;
    }
    if (source === 'gh') {
      const gh = await listGhLogins(this.run);
      const held = gh.accounts.find(
        (a) => a.login.toLowerCase() === login.toLowerCase(),
      );
      if (!held) throw notFound();
      // Listed but failing: say so instead of handing on a dead token.
      if (held.error) throw new GitHubCredentialError('gh_failed', held.error);
      return ghToken(held.login, this.run);
    }
    throw notFound();
  }
}
