/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request, RequestHandler, Response } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import { CloneJobs } from '../github/clone.js';
import type { CloneJobStatus, CloneJobsDeps } from '../github/clone.js';
import {
  GitHubCredentialError,
  GitHubCredentials,
  OAuthTokenStore,
  OAuthTokenStoreError,
  createGhRunner,
} from '../github/credentials.js';
import type { GhRunner, GitHubAccount } from '../github/credentials.js';
import {
  CLIENT_ID_SHAPE,
  DeviceFlowError,
  DeviceFlows,
} from '../github/deviceFlow.js';
import type {
  DeviceFlowEnd,
  TimerClear,
  TimerSet,
} from '../github/deviceFlow.js';
import { checkDest, parseRepoRef } from '../github/refs.js';
import type { DestCode } from '../github/refs.js';
import { GitHubApiError, listRepos, resetRepoCache } from '../github/repos.js';
import { scrubSecrets } from '../github/scrub.js';

/**
 * Clone a GitHub repo from the phone (InfiniteInsight/Qwen-Code-Remote#257):
 * the OWNER-scoped routes over `src/github/`. Mounted only when the boot
 * wiring built {@link GitHubRouteDeps}, and `/rc/capabilities` then says
 * `githubClone: true`.
 *
 * - `GET /rc/github/accounts` -> `{ accounts, oauthConfigured,
 *   oauthConfigPath }`, plus `ghError` when gh could not list its logins. A gh
 *   login gh reports as failing or timed out carries its `error`.
 *   `oauthConfigError` says why the client id at boot was not usable, and
 *   `oauthStoreError` why the OAuth token store was refused; with the latter
 *   `oauthConfigured` is false, Connect and Forget answer
 *   `409 oauth_store_refused`, and gh logins work as before.
 * - `GET /rc/github/repos?account=<id>&q=<text>` -> `{ repos, truncated }`.
 * - `POST /rc/github/oauth/start` -> `{ flowId, userCode, verificationUri,
 *   expiresIn }`.
 * - `GET /rc/github/oauth/:flowId` -> the flow's state.
 * - `DELETE /rc/github/accounts/:source/:login` -> `{ forgotten: true }` for
 *   an OAuth login; a gh login is `400 not_removable`.
 * - `POST /rc/github/clone { account, repo, dest }` -> `202 { jobId }`, plus
 *   `warning` when gh reports the chosen login as failing.
 * - `GET /rc/github/clone/:jobId` -> the job's status.
 *
 * No answer, log line or audit row carries a token, a device code or a user
 * code, except the one `oauth/start` answer whose purpose is to show the user
 * code. An account id from a request is used only when it equals, exactly, an
 * id the credentials list: `gh auth token --user` is case-sensitive.
 */

/** Device-flow starts that reached GitHub, per window. */
export const OAUTH_STARTS_PER_WINDOW = 5;
export const OAUTH_START_WINDOW_MS = 60_000;
/**
 * How long the account list a repo or clone request is checked against is
 * reused for a match. `gh auth status` checks each login against the GitHub
 * API, which is too slow to run per keystroke of a repo filter. A miss reads
 * it fresh, `GET /rc/github/accounts` always does, and a connect or a forget
 * drops it.
 */
export const ACCOUNTS_CACHE_MS = 30_000;

export const GITHUB_OAUTH_CONFIG_FILE = 'github-oauth.json';
export const GITHUB_OAUTH_TOKENS_FILE = 'github-oauth-tokens.json';
export const GITHUB_CLIENT_ID_ENV = 'QWEN_RC_GITHUB_CLIENT_ID';

/**
 * Lets the routes hear `DeviceFlows`' `onEnd`, which is wired at boot before
 * the gateway's audit log exists. Pass `emit` as `onEnd`.
 */
export class DeviceFlowEndRelay {
  private listener: ((e: DeviceFlowEnd) => void) | undefined;
  readonly emit = (e: DeviceFlowEnd): void => {
    this.listener?.(e);
  };
  listen(fn: (e: DeviceFlowEnd) => void): void {
    this.listener = fn;
  }
}

export interface GitHubRouteDeps {
  credentials: GitHubCredentials;
  /** The same store `credentials` reads; the forget route writes it. */
  store: Pick<OAuthTokenStore, 'list' | 'forget'>;
  flows: DeviceFlows;
  /** The relay `flows` was built with as its `onEnd`. */
  flowEnds: DeviceFlowEndRelay;
  clones: CloneJobs;
  /** For the repo listing. */
  fetch: typeof globalThis.fetch;
  /** Where the owner puts `{ "clientId": "..." }`. */
  oauthConfigPath: string;
  /**
   * Why the client id read at boot was not used: the path and the cause,
   * never the file's contents or the id.
   */
  oauthConfigError?: string;
  /**
   * Why the OAuth token store refused its file, scrubbed. While set, nothing
   * is stored or forgotten and no device flow starts.
   */
  oauthStoreError?: string;
  /** Test only: the clock of the start window and the account cache. */
  now?: () => number;
}

export interface GitHubRoutes {
  accounts: RequestHandler;
  repos: RequestHandler;
  oauthStart: RequestHandler;
  oauthStatus: RequestHandler;
  forget: RequestHandler;
  clone: RequestHandler;
  cloneStatus: RequestHandler;
}

function fail(
  res: Response,
  status: number,
  code: string,
  error: string,
  extra: Record<string, unknown> = {},
): void {
  if (res.headersSent) return;
  res.status(status).json({ error, code, ...extra });
}

/** 400 for a destination that is malformed, 409 for one that is taken. */
function destStatus(code: DestCode): number {
  return code === 'dest_not_empty' || code === 'dest_not_directory' ? 409 : 400;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createGitHubRoutes(
  deps: GitHubRouteDeps,
  opts: { audit?: AuditRecorder } = {},
): GitHubRoutes {
  const now = deps.now ?? (() => Date.now());
  const audit = opts.audit;
  /** Who started each live flow, for its audit row. */
  const flowActors = new Map<string, string | undefined>();
  /** Starts that reached GitHub inside the window, oldest first. */
  const starts: number[] = [];
  let cached: { at: number; accounts: GitHubAccount[] } | undefined;

  const freshAccounts = async () => {
    const status = await deps.credentials.status();
    cached = { at: now(), accounts: status.accounts };
    return status;
  };
  /**
   * The listed account whose id is exactly `id`, else undefined. A hit in the
   * cached list is used; a miss reads the list fresh before answering, so a
   * login added since is found.
   */
  const findAccount = async (
    id: unknown,
  ): Promise<GitHubAccount | undefined> => {
    if (typeof id !== 'string') return undefined;
    if (cached) {
      const age = now() - cached.at;
      if (age >= 0 && age < ACCOUNTS_CACHE_MS) {
        const hit = cached.accounts.find((a) => a.id === id);
        if (hit) return hit;
      }
    }
    return (await freshAccounts()).accounts.find((a) => a.id === id);
  };

  deps.flowEnds.listen((e) => {
    const actorTokenId = flowActors.get(e.flowId);
    flowActors.delete(e.flowId);
    if (e.state === 'connected') cached = undefined;
    void audit?.record({
      action:
        e.state === 'connected'
          ? 'github_oauth_connected'
          : 'github_oauth_failed',
      actorTokenId,
      outcome: e.state === 'connected' ? 'ok' : 'failed',
      detail: {
        state: e.state,
        ...(e.login !== undefined ? { login: e.login } : {}),
        ...(e.code !== undefined ? { code: e.code } : {}),
      },
    });
  });

  /** The account's token, or an answer already sent. */
  const tokenFor = async (
    res: Response,
    account: GitHubAccount,
  ): Promise<string | undefined> => {
    try {
      return await deps.credentials.token(account.id);
    } catch (e) {
      if (e instanceof GitHubCredentialError && e.code === 'gh_failed') {
        fail(res, 502, 'gh_failed', scrubSecrets(e.message, []));
      } else {
        fail(res, 404, 'account_not_found', 'No GitHub account by that id');
      }
      return undefined;
    }
  };

  const accounts: RequestHandler = async (_req, res) => {
    try {
      const status = await freshAccounts();
      res.json({
        accounts: status.accounts,
        oauthConfigured:
          deps.flows.configured() && deps.oauthStoreError === undefined,
        oauthConfigPath: deps.oauthConfigPath,
        ...(status.ghError !== undefined ? { ghError: status.ghError } : {}),
        ...(deps.oauthConfigError !== undefined
          ? { oauthConfigError: deps.oauthConfigError }
          : {}),
        ...(deps.oauthStoreError !== undefined
          ? { oauthStoreError: deps.oauthStoreError }
          : {}),
      });
    } catch {
      fail(res, 500, 'github_failed', 'The GitHub accounts could not be read');
    }
  };

  const repos: RequestHandler = async (req, res) => {
    try {
      const account = await findAccount(req.query['account']);
      if (!account) {
        fail(res, 404, 'account_not_found', 'No GitHub account by that id');
        return;
      }
      const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
      const token = await tokenFor(res, account);
      if (token === undefined) return;
      try {
        res.json(
          await listRepos(
            { fetch: deps.fetch, token, cacheKey: account.id },
            q,
          ),
        );
      } catch (e) {
        if (e instanceof GitHubApiError) {
          fail(res, 502, 'github_failed', scrubSecrets(e.message, [token]), {
            ...(e.status !== undefined ? { status: e.status } : {}),
          });
          return;
        }
        fail(res, 502, 'github_failed', 'GitHub could not be asked');
      }
    } catch {
      fail(res, 500, 'github_failed', 'The repo list could not be read');
    }
  };

  /** 409 oauth_store_refused, when the token store was refused at boot. */
  const storeRefused = (res: Response): boolean => {
    if (deps.oauthStoreError === undefined) return false;
    fail(
      res,
      409,
      'oauth_store_refused',
      `GitHub connect is off because the token store was refused: ${deps.oauthStoreError}`,
    );
    return true;
  };

  const oauthStart: RequestHandler = async (req, res) => {
    try {
      if (storeRefused(res)) return;
      if (!deps.flows.configured()) {
        fail(
          res,
          409,
          'oauth_not_configured',
          `No GitHub OAuth client id is set. Write {"clientId": "..."} to ${deps.oauthConfigPath}, or set ${GITHUB_CLIENT_ID_ENV}, and restart the gateway.`,
          { configPath: deps.oauthConfigPath },
        );
        return;
      }
      const t = now();
      while (starts.length > 0 && t - starts[0]! >= OAUTH_START_WINDOW_MS) {
        starts.shift();
      }
      if (starts.length >= OAUTH_STARTS_PER_WINDOW) {
        const wait = Math.max(
          1,
          Math.ceil((starts[0]! + OAUTH_START_WINDOW_MS - t) / 1000),
        );
        res.setHeader('Retry-After', String(wait));
        fail(
          res,
          429,
          'rate_limited',
          `At most ${OAUTH_STARTS_PER_WINDOW} GitHub connections can be started a minute. Try again in ${wait} s.`,
        );
        return;
      }
      // Counted before the await, so concurrent starts cannot pass the cap
      // together; given back below when GitHub was never asked.
      starts.push(t);
      let started;
      try {
        started = await deps.flows.start();
      } catch (e) {
        if (e instanceof DeviceFlowError) {
          if (e.code !== 'github_failed') {
            const i = starts.indexOf(t);
            if (i >= 0) starts.splice(i, 1);
          }
          if (e.code === 'too_many_flows') {
            fail(res, 429, 'too_many_flows', e.message);
          } else if (e.code === 'oauth_not_configured') {
            fail(res, 409, 'oauth_not_configured', e.message, {
              configPath: deps.oauthConfigPath,
            });
          } else if (e.code === 'stopped') {
            fail(res, 503, 'stopped', 'The gateway is shutting down');
          } else {
            fail(res, 502, 'github_failed', scrubSecrets(e.message, []), {
              ...(e.status !== undefined ? { status: e.status } : {}),
            });
          }
          return;
        }
        throw e;
      }
      flowActors.set(started.flowId, req.rcClient?.id);
      res.json({
        flowId: started.flowId,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        expiresIn: started.expiresIn,
      });
    } catch {
      fail(res, 500, 'github_failed', 'The GitHub connection could not start');
    }
  };

  const oauthStatus: RequestHandler = (req, res) => {
    const status = deps.flows.status(String(req.params['flowId'] ?? ''));
    if (!status) {
      fail(res, 404, 'flow_not_found', 'No GitHub connection by that id');
      return;
    }
    res.json(status);
  };

  const forget: RequestHandler = async (req, res) => {
    try {
      const source = req.params['source'];
      const login = req.params['login'];
      if (source === 'gh') {
        fail(
          res,
          400,
          'not_removable',
          'A gh login is removed with gh itself (gh auth logout), not here',
        );
        return;
      }
      if (source === 'oauth' && storeRefused(res)) return;
      const stored =
        source === 'oauth' && typeof login === 'string'
          ? deps.store.list().find((a) => a.login === login)
          : undefined;
      if (!stored) {
        fail(res, 404, 'account_not_found', 'No GitHub account by that id');
        return;
      }
      try {
        await deps.store.forget(stored.login);
      } catch (e) {
        // The store's messages name paths and modes, never a token.
        fail(res, 500, 'store_failed', scrubSecrets(errText(e), []));
        return;
      }
      cached = undefined;
      // A forgotten account's repos must not be served from the cache.
      resetRepoCache();
      void audit?.record({
        action: 'github_oauth_forgotten',
        actorTokenId: req.rcClient?.id,
        outcome: 'ok',
        detail: { login: stored.login },
      });
      res.json({ forgotten: true });
    } catch {
      fail(res, 500, 'store_failed', 'The account could not be forgotten');
    }
  };

  const clone: RequestHandler = async (req: Request, res) => {
    let token: string | undefined;
    try {
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const ref =
        typeof body['repo'] === 'string' ? parseRepoRef(body['repo']) : null;
      if (!ref) {
        fail(
          res,
          400,
          'invalid_repo',
          'The repo must be owner/name or a github.com URL',
        );
        return;
      }
      const account = await findAccount(body['account']);
      if (!account) {
        fail(res, 404, 'account_not_found', 'No GitHub account by that id');
        return;
      }
      const check = await checkDest(
        typeof body['dest'] === 'string' ? body['dest'] : '',
      );
      if (!check.ok) {
        fail(res, destStatus(check.code), check.code, check.error);
        return;
      }
      token = await tokenFor(res, account);
      if (token === undefined) return;
      const actorTokenId = req.rcClient?.id;
      const onEnd = (s: CloneJobStatus) => {
        void audit?.record({
          action: 'github_clone',
          actorTokenId,
          outcome: s.state === 'done' ? 'ok' : 'failed',
          detail: {
            outcome: s.state,
            account: account.id,
            login: account.login,
            repo: s.repo,
            dest: s.dest,
            ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
            ...(s.hasFindings !== undefined
              ? { hasFindings: s.hasFindings }
              : {}),
          },
        });
      };
      let started;
      try {
        started = await deps.clones.start({
          ref,
          dest: check.path,
          token,
          account: account.id,
          onEnd,
        });
      } catch (e) {
        fail(res, 400, 'clone_refused', scrubSecrets(errText(e), [token]));
        return;
      }
      if ('code' in started) {
        fail(
          res,
          started.code === 'too_many_clones' ? 429 : destStatus(started.code),
          started.code,
          scrubSecrets(started.error, [token]),
        );
        return;
      }
      res.status(202).json({
        jobId: started.jobId,
        ...(account.error !== undefined
          ? {
              warning: `gh reports ${account.login} as failing (${account.error}); the clone may fail if its token is no longer valid.`,
            }
          : {}),
      });
    } catch (e) {
      fail(
        res,
        500,
        'clone_failed',
        scrubSecrets(
          `The clone could not start: ${errText(e)}`,
          token ? [token] : [],
        ),
      );
    }
  };

  const cloneStatus: RequestHandler = (req, res) => {
    const status = deps.clones.status(String(req.params['jobId'] ?? ''));
    if (!status) {
      fail(res, 404, 'job_not_found', 'No clone by that id');
      return;
    }
    res.json(status);
  };

  return {
    accounts,
    repos,
    oauthStart,
    oauthStatus,
    forget,
    clone,
    cloneStatus,
  };
}

/**
 * The OAuth client id: `QWEN_RC_GITHUB_CLIENT_ID` when set, else the
 * `clientId` of the file at `path`. A missing file is no client id, said
 * nowhere. A file that cannot be read or is malformed is no client id too,
 * with one log line naming the path and the cause, never the contents; the
 * same reason comes back as `error` for the accounts answer.
 */
export async function readGitHubClientId(
  path: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<{ clientId?: string; source?: 'env' | 'file'; error?: string }> {
  const refused = (error: string) => {
    log(`github clone: ${error}`);
    return { error };
  };
  const fromEnv = env[GITHUB_CLIENT_ID_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    if (CLIENT_ID_SHAPE.test(fromEnv.trim())) {
      return { clientId: fromEnv.trim(), source: 'env' };
    }
    return refused(
      `${GITHUB_CLIENT_ID_ENV} is not a valid client id (letters, digits, . _ - up to 64); OAuth connect is off`,
    );
  }
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      return refused(
        `cannot read ${path} (${code ?? 'error'}); OAuth connect is off`,
      );
    }
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return refused(`${path} is not valid JSON; OAuth connect is off`);
  }
  const id =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['clientId']
      : undefined;
  if (typeof id !== 'string') {
    return refused(`${path} has no "clientId" string; OAuth connect is off`);
  }
  if (!CLIENT_ID_SHAPE.test(id)) {
    return refused(
      `the "clientId" in ${path} is not a valid client id (letters, digits, . _ - up to 64); OAuth connect is off`,
    );
  }
  return { clientId: id, source: 'file' };
}

/**
 * Stands in for a token store that refused its file: it holds no logins,
 * and a write or a forget throws the refusal. The routes answer
 * `oauth_store_refused` before reaching it; this only keeps a stray call
 * from touching the refused file.
 */
function refusedTokenStore(
  reason: string,
): Pick<OAuthTokenStore, 'list' | 'token' | 'put' | 'forget'> {
  const refuse = async (): Promise<never> => {
    throw new OAuthTokenStoreError(reason);
  };
  return {
    list: () => [],
    token: () => undefined,
    put: refuse,
    forget: refuse,
  };
}

/**
 * Builds the one set of GitHub clone pieces a gateway uses: the token store
 * at `<rcDir>/github-oauth-tokens.json`, the gh runner, the device flows and
 * the clone jobs. When the token store refuses its file the routes still
 * mount with `oauthStoreError` set: gh logins list and clone, and OAuth
 * connect is off with that reason, logged in one line. Nothing here runs gh
 * or asks GitHub.
 */
export async function openGitHubDeps(opts: {
  rcDir: string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Test only. */
  fetch?: typeof globalThis.fetch;
  run?: GhRunner;
  clones?: CloneJobsDeps;
  flows?: {
    setTimeout?: TimerSet;
    clearTimeout?: TimerClear;
    now?: () => number;
  };
}): Promise<GitHubRouteDeps> {
  const oauthConfigPath = join(opts.rcDir, GITHUB_OAUTH_CONFIG_FILE);
  const tokensPath = join(opts.rcDir, GITHUB_OAUTH_TOKENS_FILE);
  let store: Pick<OAuthTokenStore, 'list' | 'token' | 'put' | 'forget'>;
  let oauthStoreError: string | undefined;
  try {
    store = await OAuthTokenStore.open(tokensPath, { log: opts.log });
  } catch (e) {
    oauthStoreError = scrubSecrets(errText(e), []);
    store = refusedTokenStore(oauthStoreError);
  }
  const {
    clientId,
    source,
    error: oauthConfigError,
  } = await readGitHubClientId(oauthConfigPath, opts.env, opts.log);
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const flowEnds = new DeviceFlowEndRelay();
  const flows = new DeviceFlows({
    clientId: oauthStoreError === undefined ? clientId : undefined,
    fetch: fetchFn,
    store,
    onEnd: flowEnds.emit,
    ...opts.flows,
  });
  const credentials = new GitHubCredentials({
    run: opts.run ?? createGhRunner({ env: opts.env }),
    store,
  });
  const clones = new CloneJobs({ env: opts.env, ...opts.clones });
  opts.log(
    oauthStoreError !== undefined
      ? `github clone: on; OAuth connect off: ${oauthStoreError}`
      : clientId !== undefined
        ? `github clone: on; OAuth connect on (client id from ${source === 'env' ? GITHUB_CLIENT_ID_ENV : oauthConfigPath})`
        : `github clone: on; OAuth connect off (no client id in ${oauthConfigPath})`,
  );
  return {
    credentials,
    store,
    flows,
    flowEnds,
    clones,
    fetch: fetchFn,
    oauthConfigPath,
    ...(oauthConfigError !== undefined ? { oauthConfigError } : {}),
    ...(oauthStoreError !== undefined ? { oauthStoreError } : {}),
  };
}
