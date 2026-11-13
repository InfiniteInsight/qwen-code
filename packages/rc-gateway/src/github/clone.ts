/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Clone jobs for clone-to-conversation (InfiniteInsight/Qwen-Code-Remote#257).
 *
 * The token reaches one git process only, through its environment
 * (`QWEN_RC_GIT_TOKEN`), and is read by a credential helper scoped to
 * `https://github.com`. It is never in argv, never in the clone's
 * `.git/config`, and every kept output line passes through `scrubSecrets`
 * after being cut into whole lines, so a token split across two output
 * chunks is still masked. Nothing is ever deleted: a failed or timed-out
 * clone leaves its folder where it is and says so.
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { GitHubAccountId } from './credentials.js';
import { GH_FALLBACK_DIRS, locateProgram } from './credentials.js';
import { checkDest, repoUrl } from './refs.js';
import type { DestCode, RepoRef } from './refs.js';
import { hasRepoFindings, inspectRepoSettings } from './repoSettings.js';
import type { RepoSettingsFindings } from './repoSettings.js';
import { scrubSecrets } from './scrub.js';

export const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
export const CLONE_KILL_GRACE_MS = 5_000;
export const CLONE_MAX_CONCURRENT = 2;
/** Progress lines kept per job, newest last. */
export const CLONE_MAX_LINES = 50;
/** Finished jobs kept for lookup, newest first; older ones are dropped. */
export const CLONE_MAX_FINISHED = 20;
/** Longest single output line kept; a longer one is cut. */
export const CLONE_LINE_MAX = 8 * 1024;
/**
 * How long after git exits its output pipes may stay open (a helper it
 * started still holding them) before the job's process group is killed and
 * the job finished anyway.
 */
export const CLONE_CLOSE_GRACE_MS = 2_000;
/** Shortest token prefix masked at the end of a cut line. */
const MIN_FRAGMENT = 4;

const MASK = '***';

/**
 * The credential helper, run by git through `sh`: it prints the token from
 * the child's own environment, so the value never appears in argv.
 */
const TOKEN_HELPER =
  '!f() { echo username=x-access-token; echo "password=$QWEN_RC_GIT_TOKEN"; }; f';

/**
 * The `-c` options before `clone`. `credential.helper=` empties the helper
 * list built from the owner's config files (scoped and unscoped alike); the
 * token helper then answers `https://github.com` only, so a redirect or an
 * `insteadOf` rewrite to another host gets no token; redirects are refused
 * outright as well. An empty `core.askPass` stops git from running the
 * owner's askpass (or `SSH_ASKPASS`) when no helper answers, which could
 * otherwise hold the clone on a prompt nobody sees. `http.sslVerify=true`
 * overrides an owner's config that turns certificate checks off, since the
 * token is sent over that connection.
 */
export const CLONE_GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'credential.helper=',
  '-c',
  `credential.https://github.com.helper=${TOKEN_HELPER}`,
  '-c',
  'http.followRedirects=false',
  '-c',
  'core.askPass=',
  '-c',
  'http.sslVerify=true',
];

/** The full git argv after the program name. */
export function cloneArgs(url: string, dest: string): string[] {
  return [...CLONE_GIT_CONFIG_ARGS, 'clone', '--progress', '--', url, dest];
}

/**
 * Variables removed from the child's environment: trace output prints the
 * Basic auth header (base64, which `scrubSecrets` cannot see); askpass
 * programs would prompt; `GIT_SSL_NO_VERIFY` would send the token over an
 * unchecked connection; the rest would point git at another repository or
 * inject config.
 */
function droppedEnvKey(key: string): boolean {
  return (
    key.startsWith('GIT_TRACE') ||
    key === 'GIT_CURL_VERBOSE' ||
    key === 'GIT_DIR' ||
    key === 'GIT_WORK_TREE' ||
    key === 'GIT_INDEX_FILE' ||
    key === 'GIT_CONFIG_PARAMETERS' ||
    key === 'GIT_CONFIG_COUNT' ||
    key === 'GIT_ASKPASS' ||
    key === 'SSH_ASKPASS' ||
    key === 'GIT_SSL_NO_VERIFY' ||
    key.startsWith('GIT_CONFIG_KEY_') ||
    key.startsWith('GIT_CONFIG_VALUE_')
  );
}

/** The child's environment: `base` minus the dropped keys, plus the token. */
export function cloneEnv(
  base: NodeJS.ProcessEnv,
  token: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!droppedEnvKey(k)) env[k] = v;
  }
  env['QWEN_RC_GIT_TOKEN'] = token;
  env['GIT_TERMINAL_PROMPT'] = '0';
  return env;
}

/** `timed out after 10 minutes` for the default; seconds or ms otherwise. */
export function describeTimeout(ms: number): string {
  if (ms > 0 && ms % 60_000 === 0) {
    const m = ms / 60_000;
    return `timed out after ${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms > 0 && ms % 1000 === 0) {
    const s = ms / 1000;
    return `timed out after ${s} second${s === 1 ? '' : 's'}`;
  }
  return `timed out after ${ms} ms`;
}

/** The parts of a child process a clone job uses. */
export interface CloneChild {
  /** Also the process group id, since the child is spawned detached. */
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface CloneSpawnOptions {
  env: NodeJS.ProcessEnv;
  /**
   * True on POSIX: git leads a process group of its own, so its helpers
   * (`git remote-https`, which holds the token in its env) are signalled
   * with it.
   */
  detached: boolean;
  windowsHide: true;
  stdio: ['ignore', 'pipe', 'pipe'];
}

/** Starts `program` with an argv array, never a shell. */
export type CloneSpawner = (
  program: string,
  args: readonly string[],
  options: CloneSpawnOptions,
) => CloneChild;

const defaultSpawner: CloneSpawner = (program, args, options) =>
  spawn(program, [...args], options);

/** Signals every process in group `pid`. */
export type CloneGroupKiller = (pid: number, signal: NodeJS.Signals) => void;

const defaultGroupKiller: CloneGroupKiller = (pid, signal) => {
  process.kill(-pid, signal);
};

/**
 * Process groups of clones still running, killed if the gateway exits
 * first: a detached group would otherwise outlive it.
 */
const liveGroups = new Map<number, CloneGroupKiller>();
let exitHookInstalled = false;

function trackGroup(pid: number, kill: CloneGroupKiller): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const [p, k] of liveGroups) {
        try {
          k(p, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    });
  }
  liveGroups.set(pid, kill);
}

export interface CloneJobStatus {
  state: 'running' | 'done' | 'failed';
  lines: string[];
  dest: string;
  repo: string;
  account: GitHubAccountId;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  error?: string;
  findings?: RepoSettingsFindings;
  /**
   * Whether the page must ask before starting a conversation in the clone:
   * `hasRepoFindings(findings)`, or true when the inspection itself failed.
   */
  hasFindings?: boolean;
}

export type CloneStartResult =
  | { jobId: string }
  | { code: 'too_many_clones' | DestCode; error: string };

export interface CloneJobsDeps {
  spawn?: CloneSpawner;
  now?: () => number;
  timeoutMs?: number;
  /** Between SIGTERM and SIGKILL on the timeout. */
  killGraceMs?: number;
  /** After git exits, how long its pipes may stay open. */
  closeGraceMs?: number;
  /**
   * Test only: signals a process group. A fake child with a `pid` must come
   * with this, or the real `process.kill(-pid)` would run.
   */
  killGroup?: CloneGroupKiller;
  /** Test only: whether to spawn detached and signal the group. */
  processGroups?: boolean;
  maxConcurrent?: number;
  /** Base environment for git; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
  /** Test only: the clone URL for a ref. Never read from a request. */
  urlFor?: (ref: RepoRef) => string;
  /** Test only: the settings inspection. */
  inspect?: (dir: string) => Promise<RepoSettingsFindings>;
}

/**
 * Masks a trailing prefix of `secret` (at least {@link MIN_FRAGMENT} long),
 * for a line that was cut before the rest of a secret arrived.
 */
function maskTail(text: string, secret: string): string {
  for (
    let k = Math.min(secret.length - 1, text.length);
    k >= MIN_FRAGMENT;
    k--
  ) {
    if (text.endsWith(secret.slice(0, k))) return text.slice(0, -k) + MASK;
  }
  return text;
}

/**
 * Cuts one output stream into lines on `\r` or `\n` (git progress redraws
 * with `\r`) and hands each one on scrubbed. A line longer than
 * {@link CLONE_LINE_MAX} is scrubbed, cut, and the rest of it up to the
 * next line break is dropped, so a child cannot grow the buffer.
 */
class LineBuffer {
  private buf = '';
  private skipping = false;

  constructor(
    private readonly secret: string,
    private readonly emit: (line: string) => void,
  ) {}

  push(chunk: string): void {
    let data = chunk;
    if (this.skipping) {
      const i = data.search(/[\r\n]/);
      if (i < 0) return;
      this.skipping = false;
      data = data.slice(i + 1);
    }
    this.buf += data;
    const parts = this.buf.split(/[\r\n]/);
    this.buf = parts.pop() ?? '';
    for (const p of parts) this.keep(p, false);
    if (this.buf.length > CLONE_LINE_MAX) {
      this.keep(this.buf, true, true);
      this.buf = '';
      this.skipping = true;
    }
  }

  end(): void {
    if (this.buf.length > 0) this.keep(this.buf, true);
    this.buf = '';
  }

  /**
   * Scrubs `raw`, masks a trailing token prefix when the line is unfinished
   * (`partial`), then cuts it to the cap. `cut` says the rest of the line is
   * being dropped, so it is marked even when scrubbing made it fit.
   */
  private keep(raw: string, partial: boolean, cut = false): void {
    let line = scrubSecrets(raw, [this.secret]);
    if (partial) line = maskTail(line, this.secret);
    if (cut || line.length > CLONE_LINE_MAX) {
      line = maskTail(line.slice(0, CLONE_LINE_MAX), this.secret) + ' [cut]';
    }
    const trimmed = line.trimEnd();
    if (trimmed.length > 0) this.emit(trimmed);
  }
}

interface Job {
  status: CloneJobStatus;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isUnder(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  );
}

export class CloneJobs {
  private readonly spawner: CloneSpawner;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly closeGraceMs: number;
  private readonly killGroup: CloneGroupKiller;
  private readonly processGroups: boolean;
  private readonly maxConcurrent: number;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly urlFor: (ref: RepoRef) => string;
  private readonly inspect: (dir: string) => Promise<RepoSettingsFindings>;
  private readonly jobs = new Map<string, Job>();
  private readonly finished: string[] = [];
  /** Normalised dests of clones being checked or running. */
  private readonly active = new Set<string>();
  /** Clones being checked or running, including those not yet named. */
  private activeCount = 0;

  constructor(deps: CloneJobsDeps = {}) {
    this.spawner = deps.spawn ?? defaultSpawner;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? CLONE_TIMEOUT_MS;
    this.killGraceMs = deps.killGraceMs ?? CLONE_KILL_GRACE_MS;
    this.closeGraceMs = deps.closeGraceMs ?? CLONE_CLOSE_GRACE_MS;
    this.killGroup = deps.killGroup ?? defaultGroupKiller;
    this.processGroups = deps.processGroups ?? process.platform !== 'win32';
    this.maxConcurrent = deps.maxConcurrent ?? CLONE_MAX_CONCURRENT;
    this.env = deps.env;
    this.urlFor = deps.urlFor ?? repoUrl;
    this.inspect = deps.inspect ?? inspectRepoSettings;
  }

  /**
   * Starts a clone of `ref` into `dest`. Refuses before git runs when
   * `maxConcurrent` clones are already running, when a running clone's folder is `dest` or
   * contains it or lies inside it, or when `checkDest` refuses `dest`.
   * Throws only on a ref that `repoUrl` refuses or an empty token, which a
   * route has already ruled out.
   */
  async start(args: {
    ref: RepoRef;
    dest: string;
    token: string;
    account: GitHubAccountId;
  }): Promise<CloneStartResult> {
    const url = this.urlFor(args.ref);
    const { token } = args;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('a clone needs a token');
    }
    if (this.activeCount >= this.maxConcurrent) {
      return {
        code: 'too_many_clones',
        error: `${this.maxConcurrent} clones are already running. Wait for one to finish.`,
      };
    }
    const wanted =
      typeof args.dest === 'string' && isAbsolute(args.dest)
        ? resolve(args.dest)
        : undefined;
    if (wanted !== undefined) {
      for (const other of this.active) {
        if (isUnder(wanted, other) || isUnder(other, wanted)) {
          return {
            code: 'dest_not_empty',
            error: `A clone into ${other} is already running.`,
          };
        }
      }
      this.active.add(wanted);
    }
    this.activeCount++;
    const release = () => {
      this.activeCount--;
      if (wanted !== undefined) this.active.delete(wanted);
    };

    let check;
    try {
      check = await checkDest(args.dest);
    } catch (e) {
      release();
      throw e;
    }
    if (!check.ok) {
      release();
      return { code: check.code, error: check.error };
    }
    const dest = check.path;
    const jobId = randomUUID();
    const job: Job = {
      status: {
        state: 'running',
        lines: [],
        dest,
        repo: `${args.ref.owner}/${args.ref.name}`,
        account: args.account,
        startedAt: this.now(),
      },
    };
    this.jobs.set(jobId, job);
    void this.run(job, url, dest, token)
      .catch((e: unknown) => {
        job.status.state = 'failed';
        job.status.error = scrubSecrets(
          `The clone could not run: ${errText(e)}`,
          [token],
        );
      })
      .finally(() => {
        job.status.finishedAt = this.now();
        release();
        this.finished.push(jobId);
        while (this.finished.length > CLONE_MAX_FINISHED) {
          const old = this.finished.shift();
          if (old !== undefined) this.jobs.delete(old);
        }
      });
    return { jobId };
  }

  /** A copy of the job's status, or null for an unknown or dropped id. */
  status(jobId: string): CloneJobStatus | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const s = job.status;
    return {
      ...s,
      lines: [...s.lines],
      ...(s.findings ? { findings: structuredClone(s.findings) } : {}),
    };
  }

  private async run(
    job: Job,
    url: string,
    dest: string,
    token: string,
  ): Promise<void> {
    const base = this.env ?? process.env;
    const program = await locateProgram('git', base['PATH'], GH_FALLBACK_DIRS);
    if (!program) {
      job.status.state = 'failed';
      job.status.error = 'git was not found on this host.';
      return;
    }

    const lines = job.status.lines;
    let lastErr: string | undefined;
    const keep = (fromStderr: boolean) => (line: string) => {
      lines.push(line);
      if (lines.length > CLONE_MAX_LINES) lines.shift();
      if (fromStderr) lastErr = line;
    };
    const outBuf = new LineBuffer(token, keep(false));
    const errBuf = new LineBuffer(token, keep(true));

    const outcome = await new Promise<{
      code: number | null;
      timedOut: boolean;
      spawnError?: string;
    }>((settle) => {
      let done = false;
      let timedOut = false;
      let exitCode: number | null = null;
      let killTimer: NodeJS.Timeout | undefined;
      let closeTimer: NodeJS.Timeout | undefined;
      let child: CloneChild | undefined;
      let group: number | undefined;
      /** The whole group when there is one, else the child alone. */
      const signal = (sig: NodeJS.Signals) => {
        if (group !== undefined) {
          try {
            this.killGroup(group, sig);
            return;
          } catch {
            // the group is gone; the child alone below
          }
        }
        try {
          child?.kill(sig);
        } catch {
          // already gone
        }
      };
      /**
       * `killRest`: git has exited but something of its group may be left
       * (pipes still open, or the timeout fired), so the group is killed
       * before the job lets go of its slot and folder.
       */
      const finish = (spawnError?: string, killRest = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(closeTimer);
        if (killRest || timedOut) signal('SIGKILL');
        if (group !== undefined) liveGroups.delete(group);
        outBuf.end();
        errBuf.end();
        settle({
          code: exitCode,
          timedOut,
          ...(spawnError ? { spawnError } : {}),
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        signal('SIGTERM');
        killTimer = setTimeout(() => signal('SIGKILL'), this.killGraceMs);
      }, this.timeoutMs);
      try {
        child = this.spawner(program, cloneArgs(url, dest), {
          env: cloneEnv(base, token),
          detached: this.processGroups,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Never unref: the gateway keeps its clones as its own children.
        if (
          this.processGroups &&
          typeof child.pid === 'number' &&
          child.pid > 0
        ) {
          group = child.pid;
          trackGroup(group, this.killGroup);
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code;
        finish(typeof code === 'string' ? code : 'ERR_SPAWN');
        return;
      }
      const attach = (stream: Readable | null, buf: LineBuffer) => {
        if (!stream) return;
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          if (!done) buf.push(chunk);
        });
        stream.on('error', () => {
          // the close or exit event finishes the job
        });
      };
      attach(child.stdout, outBuf);
      attach(child.stderr, errBuf);
      child.on('error', (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code;
        finish(typeof code === 'string' ? code : 'ERR_SPAWN');
      });
      child.on('exit', (code) => {
        exitCode = code;
        closeTimer = setTimeout(
          () => finish(undefined, true),
          this.closeGraceMs,
        );
      });
      child.on('close', (code) => {
        if (exitCode === null) exitCode = code;
        finish();
      });
    });

    if (outcome.code !== null) job.status.exitCode = outcome.code;
    if (outcome.code === 0 && !outcome.timedOut && !outcome.spawnError) {
      try {
        const findings = await this.inspect(dest);
        job.status.findings = findings;
        job.status.hasFindings = hasRepoFindings(findings);
      } catch (e) {
        job.status.hasFindings = true;
        job.status.error = scrubSecrets(
          `The clone finished but its settings could not be inspected: ${errText(e)}`,
          [token],
        );
      }
      job.status.state = 'done';
      return;
    }

    let error: string;
    if (outcome.spawnError) {
      error = `git could not be started (${outcome.spawnError}).`;
    } else if (outcome.timedOut) {
      error = describeTimeout(this.timeoutMs);
    } else {
      error =
        lastErr ??
        lines[lines.length - 1] ??
        (outcome.code !== null
          ? `git exited with code ${outcome.code}`
          : 'git was stopped by a signal');
    }
    if (await exists(dest)) {
      error = `${error.replace(/[.\s]+$/, '')}. The folder was left at ${dest}.`;
    }
    job.status.state = 'failed';
    job.status.error = scrubSecrets(error, [token]);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
