/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Playwright harness for the manual viewer scripts (NOT a CI test).
 * Boots the real gateway (`createGatewayApp`) against the stub daemon, issues
 * an owner token and pre-seeds it into `localStorage['qwen-rc-token']`, and
 * launches headless Chromium (`CHROMIUM_PATH` overrides the browser binary).
 *
 * The page is returned un-navigated: callers `page.goto(url + '/ui/')` (or a
 * route of their own) after attaching whatever listeners/CDP sessions they
 * need. `url` is the gateway origin, e.g. `http://127.0.0.1:41234`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { chromium, type Page } from 'playwright';
import { DaemonClient } from '@qwen-code/sdk';
import {
  startStubDaemon,
  type StubDaemon,
  type StubDaemonOptions,
} from '../../src/testing/stubDaemon.js';
import { DaemonPool } from '../../src/daemonPool.js';
import { TokenStore } from '../../src/tokenStore.js';
import { PairingService } from '../../src/pairing.js';
import { createGatewayApp } from '../../src/server.js';
import { UiPrefsStore } from '../../src/uiPrefsStore.js';
import {
  HostActions,
  type HostActionRunner,
} from '../../src/hostActions.js';
import { HostTabRegistry, type TabProcProbe } from '../../src/hostTabs.js';
import { TerminalRequestLog } from '../../src/terminals.js';
import { openGitHubDeps, type GitHubRouteDeps } from '../../src/routes/github.js';
import type { CloneChild, CloneSpawner } from '../../src/github/clone.js';
import type { GhRunner } from '../../src/github/credentials.js';
import { resetRepoCache } from '../../src/github/repos.js';

/**
 * `_meta` is the envelope the real EventBus stamps when it publishes
 * (`serverTimestamp`, `usage`). The stub echoes it verbatim, so a page scenario
 * can drive a send time without inventing a clock inside the ACP payload.
 */
export type Frame = {
  id: number;
  type: string;
  data: unknown;
  _meta?: Record<string, unknown>;
};

export interface BootViewerOptions {
  /** Frames the stub daemon replays on /session/:id/events. */
  frames?: Frame[];
  /** Keep the stub's SSE response open this long after the frames (ms). */
  holdOpenMs?: number;
  /** Status the stub answers POST /session/:id/prompt with (default 200). */
  promptStatus?: number;
  /**
   * Status the stub daemon answers a permission vote with. The gateway turns a
   * throw from the SDK into 502, so any non-2xx here reaches the page as a
   * failed vote, which is how a scenario drives the retry path.
   */
  permissionStatus?: number;
  /**
   * Body the stub serves on GET /session/:id/status. A card scenario sets this
   * to keep its request listed as pending, because the default body reports no
   * pending interactions and the page's 5s sweep would retire the card on its
   * own, leaving the vote path untested.
   */
  sessionStatus?: unknown;
  /** ms the stub holds a prompt open before answering (models a long turn). */
  promptDelayMs?: number;
  /**
   * Body the stub serves on GET /session/:id/transcript. Left unset it serves
   * its own default page; a scenario that asserts a specific number of paged
   * rows sets this, because otherwise it would be measuring whatever the stub
   * happened to invent rather than what it asked for.
   */
  transcriptPage?: unknown;
  /** Status the stub answers GET /session/:id/transcript with (default 200). */
  transcriptStatusCode?: number;
  /**
   * Body the stub serves on GET /session/:id/turn-index. Left unset it serves
   * its own two-turn default, so a scenario that asserts which turns a reader
   * is shown has to name them, or it is checking the stub's invention rather
   * than its own. The `snapshot` in this body is the value a consumer has to
   * echo back on the anchored transcript read, so a scenario that drives a jump
   * asserts the pair it asked for rather than a guess.
   */
  turnIndexPage?: unknown;
  /**
   * Status the stub answers GET /session/:id/turn-index with (default 200). Set
   * it to drive the refusal note, because there is no other way to make a daemon
   * refuse an index read, and the page prints the reason code it was given.
   */
  turnIndexStatusCode?: number;
  /** Body (or a function returning it) for GET /session/:id/turns/current (#131). */
  currentTurn?: unknown;
  /** Status the stub answers GET /session/:id/turns/current with (#131). */
  currentTurnStatusCode?: number;
  /**
   * Daemon feature tags the stub advertises on GET /capabilities (default:
   * none). The page hides whole panels behind these tags, so a scenario that
   * drives one of them has to advertise it or it is asserting against markup
   * that never becomes visible.
   */
  capabilitiesFeatures?: string[];
  /**
   * Status the stub answers GET /session/:id/export with (default 200). A
   * scenario that drives the refusal note sets this, because the page reads
   * the reason off the response body and there is no other way to make the
   * daemon refuse.
   */
  exportStatusCode?: number;
  /**
   * Status the stub answers POST /session/:id/attachments with (default 201).
   * A scenario that drives the attach failure note sets this, because the page
   * reads the reason off the response body and there is no other way to make
   * the daemon refuse a file.
   */
  attachmentUploadStatus?: number;
  /**
   * Body the stub answers a refused upload with. Left unset the stub says
   * `stub error`, which is not a code the real daemon ever sends, so a
   * scenario asserting the page names a reason has to supply one.
   */
  attachmentUploadErrorBody?: unknown;
  /**
   * Body the stub answers GET /session/:id/attachments with. A scenario that
   * drives the stored list sets this, because the list a reader sees has to be
   * what the daemon holds, and the stub's own default is one file the test
   * never chose.
   */
  attachmentListResult?: unknown;
  /**
   * Status the stub answers the attachment list with (default 200). Set it to
   * drive the refusal note. Leave the body unset to see the gateway's own
   * mapping of that status, which is what a reader actually gets, rather than
   * a body this file composed.
   */
  attachmentListStatus?: number;
  /**
   * Status the stub answers GET /session/:id/stats with (default 200). Set it
   * to drive the failure row, because there is no other way to make a daemon
   * refuse a stats read, and the page prints the reason code it was given.
   */
  statsStatusCode?: number;
  /**
   * Body the stub answers GET /session/:id/stats with. Left unset the stub
   * serves its own default roll-up, which is fine for a scenario that only
   * needs a panel to fill, but a scenario that asserts a printed number has to
   * supply the payload it expects to see, or it is checking the stub's
   * invention rather than its own.
   */
  statsResult?: unknown;
  /**
   * Body the stub answers GET /session/:id/resources with. Left unset the stub
   * serves its own default skills-and-servers payload, so a scenario that
   * asserts a drawn row, or that an unknown level or status still reaches the
   * page, has to supply its own payload or it is checking the two names the
   * stub invented.
   */
  resourcesResult?: unknown;
  /**
   * Status the stub answers GET /session/:id/resources with (default 200). Set
   * it to drive the failure row, since there is no other way to make a daemon
   * refuse a resources read, and the page prints the reason code it was given.
   */
  resourcesStatusCode?: number;
  /**
   * Body the stub answers GET /workspace/permissions with. Left unset the stub
   * serves its own settings object, which now carries the shape the daemon
   * really sends ({ path, rules } per scope, one { allow, ask, deny } merged
   * set). A scenario that asserts a drawn rule chip has to supply its own
   * payload, or it is checking the rules this file invented.
   */
  workspacePermissionsResult?: unknown;
  /**
   * Status the stub answers GET /workspace/permissions with (default 200). Set
   * it to drive the refusal the page reports, since there is no other way to
   * make a daemon refuse a rules read.
   */
  workspacePermissionsStatus?: number;
  /**
   * Body the stub answers GET /workspace/env and /workspace/preflight with.
   * The two diagnostics reads share one envelope, so a scenario that asserts a
   * drawn cell has to name the cell itself: left unset, the stub serves its own
   * default fixture and the assertion would be checking this file's invention.
   */
  workspaceEnvResult?: unknown;
  /** Status the stub answers GET /workspace/env with (default 200). */
  workspaceEnvStatus?: number;
  /** Body the stub answers GET /workspace/preflight with. */
  workspacePreflightResult?: unknown;
  /** Status the stub answers GET /workspace/preflight with (default 200). */
  workspacePreflightStatus?: number;
  /** Body the stub answers GET /workspace/skills with. */
  workspaceSkillsResult?: unknown;
  /** Status the stub answers GET /workspace/skills with. */
  workspaceSkillsStatus?: number;
  /** Body the stub answers GET /workspace/providers with. */
  workspaceProvidersResult?: unknown;
  /** Status the stub answers GET /workspace/providers with. */
  workspaceProvidersStatus?: number;
  /** Body the stub answers GET /workspace/hooks with. */
  workspaceHooksResult?: unknown;
  /** Status the stub answers GET /workspace/hooks with. */
  workspaceHooksStatus?: number;
  /** Body the stub answers GET /workspace/memory with. */
  workspaceMemoryResult?: unknown;
  /** Status the stub answers GET /workspace/memory with. */
  workspaceMemoryStatus?: number;
  /** Body the stub answers GET /workspace/agents with. */
  workspaceAgentsResult?: unknown;
  /** Status the stub answers GET /workspace/agents with. */
  workspaceAgentsStatus?: number;
  /**
   * Body the stub answers GET /session/:id/artifacts with. Left unset the stub
   * serves its own default envelope, so a scenario that asserts a drawn row is
   * checking the stub's invention rather than its own unless it sets this.
   */
  artifactListResult?: unknown;
  /**
   * Status the stub answers GET /session/:id/artifacts with (default 200). Set
   * it to drive the failure row, since there is no other way to make a daemon
   * refuse a list, and the page prints the reason code it was given.
   */
  artifactListStatus?: number;
  /**
   * Status the stub answers the artifact content read with (default 200). Set
   * it to 404 to drive the refusal the page reports when a snapshot is gone.
   */
  artifactContentStatus?: number;
  /**
   * Mount a host-actions store (#192) holding one action, `launcher`, behind
   * a fake runner: its status reads not running until one start has run, then
   * running. The start takes {@link HOST_ACTION_START_MS} so the page's
   * "starting…" is on screen long enough to be read. Left unset the routes are
   * not mounted and answer 404, which is how a scenario checks that the page
   * draws no row. Nothing on the host is ever run.
   */
  hostActions?: boolean;
  /**
   * #190: run the gateway on a real `DaemonPool` rather than the bare stub
   * client, so a scenario can count what the pool holds and what it spawned.
   * The boot stub is the default daemon (workspace `/stub/workspace`, where
   * the stub's capabilities put it); every workspace the pool spawns for gets
   * a stub of its own whose live-state answer is `liveState(cwd)`. Session
   * calls go through the pool too, so a session the pool did not create is
   * unknown to it: a scenario using this reads the list, not a watch.
   */
  pool?: {
    liveState: (cwd: string) => unknown;
    /** #132: what each spawned stub's POST /sessions/catalog serves. */
    catalog?: (cwd: string) => StubDaemonOptions['catalog'];
  };
  /**
   * #110: the roster GET /session/:id/agents answers (default empty). A
   * function is read per request, so a scenario can move an agent along.
   */
  sessionAgentsResult?: unknown | ((sessionId: string) => unknown);
  /** #110: the whole lineage GET /session/:id/agent-trace narrows. */
  agentTraceResult?: unknown;
  /** #132: what the boot stub's POST /sessions/catalog serves (unset: no route). */
  catalog?: StubDaemonOptions['catalog'];
  /** #123 (directories): the tree the stub's list and stat answer from. */
  workspaceTree?: StubDaemonOptions['workspaceTree'];
  /** #123 (directories): force the stub's directory routes to refuse. */
  directoryCreateStatus?: number;
  directoryCreateErrorBody?: unknown;
  directoryDeleteStatus?: number;
  directoryDeleteErrorBody?: unknown;
  /** #123 (memory): force the stub's memory write and reload to refuse, or
   * answer a reload with a body of the scenario's own. */
  memoryWriteStatus?: number;
  memoryWriteErrorBody?: unknown;
  reloadStatus?: number;
  reloadErrorBody?: unknown;
  reloadResult?: unknown;
  /** #211: force the stub's artifact add and remove to refuse. */
  artifactMutationStatus?: number;
  artifactMutationErrorBody?: unknown;
  /** #135: the stub's session goal routes: the goal each session holds, what moves it, a refusal. */
  goal?: StubDaemonOptions['goal'];
  /**
   * #110 (workflow runs): the stub's task list and workflow rows, and who the
   * page's token is. `readerToken` issues a real read-only token instead of the
   * owner one, so the gateway's own scope rule is what the page meets.
   */
  runs?: {
    tasks?: StubDaemonOptions['tasksResult'];
    workflowTasks?: StubDaemonOptions['workflowTasksResult'];
    trusted?: boolean;
    cancelVerdict?: StubDaemonOptions['taskCancelVerdict'];
    actionChanged?: boolean;
    savedWorkflow?: unknown;
    readerToken?: boolean;
  };
  /** #135: the stub's session hooks read: the hooks each session holds, a refusal. */
  hooks?: StubDaemonOptions['hooks'];
  /**
   * #212: mount the host tab routes over a real registry and request log in
   * the boot's temp dir, with a /proc probe that is a table the scenario
   * edits (`viewer.hostTabs.live`): a pid in it is a live tab, any other pid
   * is gone. A reopen attaches to a fixed endpoint and nothing is ever
   * launched; the scenario reads the request log to see what was queued.
   * `mirrored` names sessions a terminal already shows.
   */
  hostTabs?: { mirrored?: string[] };
  /**
   * #257: mount the real GitHub routes (`openGitHubDeps`) over a fake gh
   * runner, a fake GitHub `fetch`, a token store in the boot's temp dir and a
   * fake git spawner. Nothing touches the real `~/.qwen`, gh, a remote or the
   * network, and every token the fakes hold is a made-up string listed in
   * `viewer.github.secrets`.
   *
   * - `ghLogins`: logins `gh auth status` lists (each has a fake token).
   * - `oauthClientId`: written to the temp `github-oauth.json`; absent, OAuth
   *   connect is not set up.
   * - `connected`: OAuth logins already in the token store (not in the brief's
   *   shape; a page scenario cannot reach the store before the gateway reads it).
   * - `repos`: the repos GitHub lists, keyed by account id (`gh:octocat`,
   *   `oauth:octo-new`) or by bare login; each entry is a GitHub API repo
   *   object (`full_name`, `private`, `default_branch`, `pushed_at`,
   *   `description`).
   * - `flow`: how a started device flow ends: `connect` (default; approved
   *   after two pending polls, as the login `octo-new`), `deny` or `expire`.
   * - `settings`: the text the fake clone writes as `.qwen/settings.json` in
   *   the destination; null or absent writes none.
   * - `cloneExit`: the fake git's exit code (default 0). A non-zero exit
   *   writes nothing and prints one line on stderr.
   */
  github?: {
    ghLogins?: string[];
    oauthClientId?: string;
    connected?: string[];
    repos?: Record<string, unknown[]>;
    flow?: 'connect' | 'deny' | 'expire';
    settings?: string | null;
    cloneExit?: number;
  };
}

/** #257: the fake device code GitHub hands the harness gateway. */
export const GITHUB_HARNESS_DEVICE_CODE = 'harness-device-code-secret-0123456789';
/** #257: the user code the fake GitHub shows. */
export const GITHUB_HARNESS_USER_CODE = 'WDJB-MJHT';
/** #257: the login a `connect` flow connects. */
export const GITHUB_HARNESS_NEW_LOGIN = 'octo-new';

class HarnessGitChild extends EventEmitter implements CloneChild {
  readonly pid = undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(): boolean {
    void this.exit(null);
    return true;
  }
  async exit(code: number | null, stderrLine?: string) {
    const ends = [once(this.stdout, 'end'), once(this.stderr, 'end')];
    if (stderrLine) this.stderr.write(`${stderrLine}\n`);
    this.stdout.end();
    this.stderr.end();
    await Promise.all(ends);
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

function harnessJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The label the harness's one host action carries. */
export const HOST_ACTION_LABEL = 'Qwen Remote Launcher';
/** How long the harness's fake start takes before it answers. */
export const HOST_ACTION_START_MS = 400;

/**
 * The fake behind the `hostActions` option. Programs are told apart by the
 * argv's first word, which the harness config names below. Once a start has
 * run, every probe after it reads running, as the real launcher would.
 */
function harnessHostActions(): HostActions {
  let started = false;
  const run: HostActionRunner = async (argv) => {
    if (argv[0] === 'harness-start') {
      await new Promise((r) => setTimeout(r, HOST_ACTION_START_MS));
      started = true;
      return { code: 0 };
    }
    return { code: started ? 0 : 1 };
  };
  return HostActions.fromConfig(
    {
      launcher: {
        label: HOST_ACTION_LABEL,
        status: ['harness-status'],
        start: ['harness-start'],
      },
    },
    run,
  );
}

/**
 * The fakes behind the `github` option, over the REAL `openGitHubDeps` (the
 * token store, the device flows and the clone jobs are the production ones).
 */
async function harnessGitHub(
  o: NonNullable<BootViewerOptions['github']>,
  dir: string,
): Promise<NonNullable<Viewer['github']>> {
  const rcDir = join(dir, 'rc');
  mkdirSync(rcDir, { mode: 0o700 });
  if (o.oauthClientId !== undefined) {
    writeFileSync(
      join(rcDir, 'github-oauth.json'),
      JSON.stringify({ clientId: o.oauthClientId }),
    );
  }
  const plain = (login: string) => login.replace(/[^A-Za-z0-9]/g, '');
  const ghToken = (login: string) =>
    `gho_harnessFakeGh${plain(login)}AAAAAAAAAAAAAAAA`;
  const oauthToken = (login: string) =>
    `gho_harnessFakeOauth${plain(login)}BBBBBBBBBBBBBBBB`;
  const ghLogins = o.ghLogins ?? [];
  const connected = o.connected ?? [];
  const newLogin = GITHUB_HARNESS_NEW_LOGIN;
  const accountOf = new Map<string, string>();
  for (const l of ghLogins) accountOf.set(ghToken(l), `gh:${l}`);
  for (const l of connected) accountOf.set(oauthToken(l), `oauth:${l}`);
  accountOf.set(oauthToken(newLogin), `oauth:${newLogin}`);
  const secrets = [...accountOf.keys(), GITHUB_HARNESS_DEVICE_CODE];
  const requests: string[] = [];
  const ghCalls: string[][] = [];
  const clones: Array<{ args: string[]; dest: string }> = [];

  const run: GhRunner = async (argv) => {
    ghCalls.push([...argv]);
    if (argv[1] === 'auth' && argv[2] === 'status') {
      if (ghLogins.length === 0) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'You are not logged into any GitHub hosts.\n',
        };
      }
      const text = ghLogins
        .map((l, i) =>
          [
            'github.com',
            `  \u2713 Logged in to github.com account ${l} (keyring)`,
            `  - Active account: ${i === 0}`,
            "  - Token scopes: 'gist', 'read:org', 'repo'",
          ].join('\n'),
        )
        .join('\n');
      return { exitCode: 0, stdout: text + '\n', stderr: '' };
    }
    if (argv[1] === 'auth' && argv[2] === 'token') {
      const user = argv[argv.indexOf('--user') + 1] ?? '';
      if (ghLogins.includes(user)) {
        return { exitCode: 0, stdout: `${ghToken(user)}\n`, stderr: '' };
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'no oauth token found for github.com',
      };
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected' };
  };

  let polls = 0;
  let flow = o.flow ?? 'connect';
  const fetchFake = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
    if (url.startsWith('https://github.com/login/device/code')) {
      return harnessJson({
        device_code: GITHUB_HARNESS_DEVICE_CODE,
        user_code: GITHUB_HARNESS_USER_CODE,
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 1,
      });
    }
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      polls++;
      if (flow === 'deny') return harnessJson({ error: 'access_denied' });
      if (flow === 'expire') return harnessJson({ error: 'expired_token' });
      if (polls <= 2) return harnessJson({ error: 'authorization_pending' });
      return harnessJson({
        access_token: oauthToken(newLogin),
        token_type: 'bearer',
        scope: 'repo',
      });
    }
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const account = accountOf.get(auth.replace(/^(?:token|bearer)\s+/i, ''));
    if (url === 'https://api.github.com/user') {
      return account
        ? harnessJson({ login: account.slice(account.indexOf(':') + 1) })
        : harnessJson({ message: 'Bad credentials' }, 401);
    }
    if (url.startsWith('https://api.github.com/user/repos')) {
      if (!account) return harnessJson({ message: 'Bad credentials' }, 401);
      const login = account.slice(account.indexOf(':') + 1);
      return harnessJson(o.repos?.[account] ?? o.repos?.[login] ?? []);
    }
    return harnessJson({ message: 'not found' }, 404);
  }) as typeof globalThis.fetch;

  const spawn: CloneSpawner = (_program, args) => {
    const child = new HarnessGitChild();
    const dest = args[args.length - 1] ?? '';
    clones.push({ args: [...args], dest });
    setImmediate(() => {
      const code = o.cloneExit ?? 0;
      if (code !== 0) {
        void child.exit(code, 'fatal: harness clone failed');
        return;
      }
      try {
        mkdirSync(join(dest, '.git'), { recursive: true });
        if (typeof o.settings === 'string') {
          mkdirSync(join(dest, '.qwen'), { recursive: true });
          writeFileSync(join(dest, '.qwen', 'settings.json'), o.settings);
        }
      } catch {
        void child.exit(128, 'fatal: harness could not write the destination');
        return;
      }
      void child.exit(0);
    });
    return child;
  };

  const deps = await openGitHubDeps({
    rcDir,
    env: { PATH: process.env['PATH'] },
    log: () => {},
    fetch: fetchFake,
    run,
    clones: {
      spawn,
      processGroups: false,
      env: { PATH: process.env['PATH'] },
    },
    flows: {
      // A poll every 10 ms instead of every second, so a flow ends well
      // inside the page's own 2 s check.
      setTimeout: (fn, ms) => setTimeout(fn, ms / 100),
    },
  });
  if (!deps) throw new Error('github deps did not open');
  const put = (
    deps.store as unknown as {
      put(l: string, t: string, s: string[]): Promise<void>;
    }
  ).put.bind(deps.store);
  for (const l of connected) await put(l, oauthToken(l), ['repo']);
  const setFlow = (f: 'connect' | 'deny' | 'expire') => {
    flow = f;
    polls = 0;
  };
  return { deps, requests, ghCalls, clones, secrets, rcDir, setFlow };
}

export interface Viewer {
  page: Page;
  /** Gateway origin, without a trailing slash. */
  url: string;
  /** A session id the page can `startWatch()` (the stub serves any id). */
  sessionId: string;
  /** Set when booted with `pool`: what the pool holds and has spawned. */
  pool?: { workspaces(): string[]; spawned: string[] };
  /** #110: the boot stub, for what a scenario needs to read back from it. */
  stub: StubDaemon;
  /** #212: set when booted with `hostTabs`. */
  hostTabs?: {
    registry: HostTabRegistry;
    requests: TerminalRequestLog;
    /** Pids the probe reads as live tabs; edit it to kill or start one. */
    live: Set<number>;
    /** Folders that no longer exist: a reopen into one is refused. */
    gone: Set<string>;
    /** The registry's clock: `advance(ms)` moves it on. */
    advance(ms: number): void;
    /** A launcher poll, now on the registry's clock. */
    poll(): Promise<void>;
  };
  /** #257: set when booted with `github`. */
  github?: {
    deps: GitHubRouteDeps;
    /** The GitHub requests the fake saw, as `METHOD url`. */
    requests: string[];
    /** `gh` argvs the fake runner saw. */
    ghCalls: string[][];
    /** Each git clone the fake spawner ran: its argv and destination. */
    clones: Array<{ args: string[]; dest: string }>;
    /** Every fake token, and the device code: none may reach the page. */
    secrets: string[];
    /** The temp dir holding github-oauth.json and the token store. */
    rcDir: string;
    /** How the next device flow ends (restarts the pending count). */
    setFlow(flow: 'connect' | 'deny' | 'expire'): void;
  };
  close(): Promise<void>;
}

export const SESSION_ID = '11111111-2222-3333-4444-555555555555';

/**
 * The runtime root a harness page reads conversations from (#178).
 *
 * The chats dir is resolved per request by `sessions/chatsPath.ts#runtimeBaseDir`,
 * which falls back to the real `~/.qwen`. Left alone, a harness page's rail lists
 * this machine's own conversations: `GET /rc/fs` with no path defaults to `$HOME`,
 * the folder browser renders that, and `renderDirList` then asks for that folder's
 * conversations. So any rail assertion is a statement about the host rather than
 * about the page, and a full run prints the user's session titles.
 *
 * The root is created ONCE PER PROCESS rather than once per boot. The variable is
 * read at request time, not captured at construction, and the pool in
 * `verify-transcript-virtualization.mts` boots up to four viewers inside one Node
 * process, so a per-boot value with a restore would let one scenario's request
 * resolve against another scenario's directory. Nothing in `scripts/` seeds a
 * chats dir (the scenarios needing particular rows intercept `/rc/sessions` with
 * `page.route`), so one shared empty root is deterministic.
 *
 * An inherited `QWEN_RUNTIME_DIR` is respected rather than replaced: whoever set
 * it already owns the isolation, and moving the ground under them would be the
 * same fault pointed the other way.
 */
let harnessRoot: string | undefined;

/** The runtime root the booted pages scan for conversations. */
export function harnessRuntimeRoot(): string {
  if (harnessRoot) return harnessRoot;
  const inherited = process.env['QWEN_RUNTIME_DIR'];
  if (inherited) {
    harnessRoot = inherited;
    return harnessRoot;
  }
  const dir = mkdtempSync(join(tmpdir(), 'rc-viewer-home-'));
  process.env['QWEN_RUNTIME_DIR'] = dir;
  process.once('exit', () => {
    rmSync(dir, { recursive: true, force: true });
  });
  harnessRoot = dir;
  return dir;
}

/**
 * The host name the harness gateway reports on /rc/capabilities (#190). The
 * folder line shows its first label, so a scenario reads `on harness-host`.
 */
export const HARNESS_HOST_NAME = 'harness-host.test';

/**
 * Stands in for what a write-scope token reads off /rc/capabilities (#190):
 * `hostName`, and `homeDir` as the folder the scenarios plant theirs under
 * (`harnessRuntimeRoot()`), so a planted folder reads as `~/name` the way a
 * folder under the host's $HOME does. Without it the page would see this
 * machine's real hostname and $HOME, and the lists would depend on the host
 * running them. Only a body that already carries the two (the audience that
 * may read them) is touched, so a reader's view stays without them.
 */
function stubHostFacts(app: express.Express): express.Express {
  const outer = express();
  outer.use((req, res, next) => {
    if (req.path === '/rc/capabilities' || req.path === '/capabilities') {
      const json = res.json.bind(res);
      res.json = (body: unknown) => {
        const rc = (body as { remoteControl?: Record<string, unknown> } | null)
          ?.remoteControl;
        if (rc && 'hostName' in rc) rc['hostName'] = HARNESS_HOST_NAME;
        if (rc && 'homeDir' in rc) rc['homeDir'] = harnessRuntimeRoot();
        return json(body);
      };
    }
    next();
  });
  outer.use(app);
  return outer;
}

export async function bootViewer(
  opts: BootViewerOptions = {},
): Promise<Viewer> {
  // Before anything can be served, so no request ever resolves against the
  // host's `~/.qwen` (#178).
  harnessRuntimeRoot();
  const stub = await startStubDaemon({
    frames: opts.frames,
    holdOpenMs: opts.holdOpenMs,
    promptStatus: opts.promptStatus,
    permissionStatus: opts.permissionStatus,
    sessionStatus: opts.sessionStatus,
    promptDelayMs: opts.promptDelayMs,
    transcriptPage: opts.transcriptPage,
    transcriptStatusCode: opts.transcriptStatusCode,
    turnIndexPage: opts.turnIndexPage,
    turnIndexStatusCode: opts.turnIndexStatusCode,
    currentTurn: opts.currentTurn,
    currentTurnStatusCode: opts.currentTurnStatusCode,
    capabilitiesFeatures: opts.capabilitiesFeatures,
    exportStatusCode: opts.exportStatusCode,
    attachmentUploadStatus: opts.attachmentUploadStatus,
    attachmentUploadErrorBody: opts.attachmentUploadErrorBody,
    attachmentListResult: opts.attachmentListResult,
    attachmentListStatus: opts.attachmentListStatus,
    statsStatusCode: opts.statsStatusCode,
    statsResult: opts.statsResult,
    resourcesResult: opts.resourcesResult,
    resourcesStatusCode: opts.resourcesStatusCode,
    workspacePermissionsResult: opts.workspacePermissionsResult,
    workspacePermissionsStatus: opts.workspacePermissionsStatus,
    workspaceEnvResult: opts.workspaceEnvResult,
    workspaceEnvStatus: opts.workspaceEnvStatus,
    workspacePreflightResult: opts.workspacePreflightResult,
    workspacePreflightStatus: opts.workspacePreflightStatus,
    workspaceSkillsResult: opts.workspaceSkillsResult,
    workspaceSkillsStatus: opts.workspaceSkillsStatus,
    workspaceProvidersResult: opts.workspaceProvidersResult,
    workspaceProvidersStatus: opts.workspaceProvidersStatus,
    workspaceHooksResult: opts.workspaceHooksResult,
    workspaceHooksStatus: opts.workspaceHooksStatus,
    workspaceMemoryResult: opts.workspaceMemoryResult,
    workspaceMemoryStatus: opts.workspaceMemoryStatus,
    workspaceAgentsResult: opts.workspaceAgentsResult,
    workspaceAgentsStatus: opts.workspaceAgentsStatus,
    artifactListResult: opts.artifactListResult,
    artifactListStatus: opts.artifactListStatus,
    artifactContentStatus: opts.artifactContentStatus,
    sessionAgentsResult: opts.sessionAgentsResult,
    agentTraceResult: opts.agentTraceResult,
    catalog: opts.catalog,
    workspaceTree: opts.workspaceTree,
    directoryCreateStatus: opts.directoryCreateStatus,
    directoryCreateErrorBody: opts.directoryCreateErrorBody,
    directoryDeleteStatus: opts.directoryDeleteStatus,
    directoryDeleteErrorBody: opts.directoryDeleteErrorBody,
    memoryWriteStatus: opts.memoryWriteStatus,
    memoryWriteErrorBody: opts.memoryWriteErrorBody,
    reloadStatus: opts.reloadStatus,
    reloadErrorBody: opts.reloadErrorBody,
    reloadResult: opts.reloadResult,
    artifactMutationStatus: opts.artifactMutationStatus,
    artifactMutationErrorBody: opts.artifactMutationErrorBody,
    goal: opts.goal,
    tasksResult: opts.runs?.tasks,
    workflowTasksResult: opts.runs?.workflowTasks,
    workspaceTrusted: opts.runs?.trusted,
    taskCancelVerdict: opts.runs?.cancelVerdict,
    workflowActionChanged: opts.runs?.actionChanged,
    savedWorkflowResult: opts.runs?.savedWorkflow,
    hooks: opts.hooks,
  });
  const dir = mkdtempSync(join(tmpdir(), 'rc-viewer-'));
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const { token } = await store.issue(
    opts.runs?.readerToken ? ['session:read'] : ['owner'],
    'viewer-harness',
  );
  const spawned: string[] = [];
  const spawnedStubs: StubDaemon[] = [];
  const poolOpt = opts.pool;
  const daemonPool = poolOpt
    ? new DaemonPool({
        defaultDaemon: new DaemonClient({ baseUrl: stub.baseUrl }),
        defaultWorkspaceCwd: '/stub/workspace',
        spawn: async (cwd) => {
          spawned.push(cwd);
          const own = await startStubDaemon({
            workspaceCwd: cwd,
            liveStateResult: poolOpt.liveState(cwd),
            catalog: poolOpt.catalog?.(cwd),
          });
          spawnedStubs.push(own);
          return {
            client: new DaemonClient({ baseUrl: own.baseUrl }),
            stop: async () => {},
            workspaceCwd: cwd,
          };
        },
      })
    : undefined;
  // #212: the host tab registry and its request log, on a clock the
  // scenario can move, so a ghost can turn crashed without a 12 s wait.
  let tabClock = Date.now();
  const tabLive = new Set<number>();
  const tabProbe: TabProcProbe = {
    startTime: async (pid) => (tabLive.has(pid) ? '1' : undefined),
    stdinTarget: async (pid) => (tabLive.has(pid) ? '/dev/pts/1' : undefined),
    bootId: async () => 'harness-boot',
  };
  const tabRequests = opts.hostTabs
    ? TerminalRequestLog.open(join(dir, 'terminal-requests.jsonl'), {
        now: () => tabClock,
      })
    : undefined;
  const tabRegistry = opts.hostTabs
    ? await HostTabRegistry.open(join(dir, 'host-tabs.json'), {
        now: () => tabClock,
        probe: tabProbe,
        ghostGraceMs: 12_000,
      })
    : undefined;
  const mirrored = new Set(opts.hostTabs?.mirrored ?? []);
  const goneFolders = new Set<string>();
  const github = opts.github ? await harnessGitHub(opts.github, dir) : undefined;
  const { app } = createGatewayApp({
    ...(github ? { github: github.deps } : {}),
    ...(tabRegistry && tabRequests
      ? {
          terminalRequests: tabRequests,
          terminalRcArgv: ['qwen-rc'],
          hostTabs: {
            registry: tabRegistry,
            endpointFor: async (_sessionId: string, cwd: string) => ({
              ok: true as const,
              endpoint: {
                url: stub.baseUrl,
                token: 'harness-daemon-token',
                workspaceCwd: cwd,
              },
            }),
            isMirrored: async (id: string) => mirrored.has(id),
            // The harness's folders are made up: all exist but the ones a
            // scenario puts in `gone`.
            folderExists: async (cwd: string) => !goneFolders.has(cwd),
          },
        }
      : {}),
    daemon: daemonPool ?? new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(dir, 'audit.log'),
    // The page reads /rc/ui-prefs at boot. Left unmounted, every scenario
    // would silently run the fallback path and the saved-zone feature could
    // never be observed, so the harness carries it the way cli.ts does.
    uiPrefs: await UiPrefsStore.open(join(dir, 'ui-prefs.json')),
    hostActions: opts.hostActions ? harnessHostActions() : undefined,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = stubHostFacts(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const browser = await chromium.launch({
    args: ['--enable-precise-memory-info'],
    executablePath: process.env['CHROMIUM_PATH'] || undefined,
  });
  // An explicit context rather than browser.newPage(), which would create an
  // implicit one that refuses a second page. A scenario that needs two windows
  // on the same origin takes them from page.context(): they then share
  // localStorage and do not share sessionStorage, which is the seam #50 turns
  // on. Separate contexts would not model it, since each gets its own storage.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('qwen-rc-token', t);
  }, token);

  let closed = false;
  return {
    page,
    url,
    sessionId: SESSION_ID,
    stub,
    ...(daemonPool
      ? { pool: { workspaces: () => daemonPool.workspaces(), spawned } }
      : {}),
    ...(github ? { github } : {}),
    ...(tabRegistry && tabRequests
      ? {
          hostTabs: {
            registry: tabRegistry,
            requests: tabRequests,
            live: tabLive,
            gone: goneFolders,
            advance: (ms: number) => {
              tabClock += ms;
            },
            poll: () => tabRequests.recordPoll(0),
          },
        }
      : {}),
    async close() {
      if (closed) return;
      closed = true;
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (daemonPool) await daemonPool.stopAll();
      if (github) {
        github.deps.flows.stopAll();
        github.deps.clones.stopAll();
        resetRepoCache();
      }
      for (const own of spawnedStubs) await own.close();
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
