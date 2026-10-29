/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Host-terminal requests (issue #49): the bridge between a conversation started
 * in the web UI and a terminal on the machine the gateway runs on.
 *
 * The gateway CANNOT open the terminal itself. It runs headless (a systemd unit
 * with no controlling terminal), and WSL only lets a process create a Win32
 * window when it already sits in the user's interactive session — verified:
 * `wt`, `cmd /c start notepad` and PowerShell `Start-Process` all fail with
 * "Access is denied" from that context. So the gateway records the request and
 * the Windows-side launcher app (which IS in the interactive session) drains
 * the log and spawns the tab. One writer per file, so no lock is needed:
 * gateway appends requests, launcher appends its own results elsewhere.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A request to open a host terminal showing one daemon session. */
export interface TerminalRequest {
  id: string;
  /** Conversation the tab should show. Carried for tab titles and for
   * attach-by-id. */
  sessionId: string;
  workspaceCwd: string;
  /**
   * Loopback base URL of the daemon bound to `workspaceCwd`. Kept in the log
   * (the launcher validates it) although the tab's argv no longer carries it:
   * the tab's `qwen-rc attach` asks the gateway for the live endpoint.
   */
  daemonUrl: string;
  /** That daemon's `QWEN_SERVER_TOKEN`; never leaves the host filesystem. */
  daemonToken: string;
  /**
   * The command to run inside the distro, composed by the gateway so qwen's
   * flag names have one owner. The launcher only wraps it in
   * `wsl.exe --cd <workspaceCwd> --exec …`.
   */
  linuxArgv: string[];
  /** Tab label shown by the terminal. */
  title: string;
  createdAt: number;
}

/** Arguments for the request log file. */
export interface TerminalRequestLogOptions {
  now?: () => number;
  newId?: () => string;
}

/**
 * Whether a host terminal has any chance of appearing right now, read from the
 * launcher's own poll traffic. A request route answers 202 for "written down",
 * which says nothing about anyone being there to act on it, so this is what
 * turns that 202 into a statement a caller can pass on honestly.
 */
export interface LauncherLiveness {
  /**
   * - `live` a poll landed inside the stale window, so the request will be taken
   * - `stale` polls were arriving and stopped, so the launcher went away
   * - `never` no marker exists, so no launcher has run on this host
   * - `unreadable` a marker exists but holds nothing usable
   *
   * `stale` and `never` are kept apart because the next step differs: one is a
   * launcher to restart, the other is a feature never set up on this machine.
   */
  state: 'live' | 'stale' | 'never' | 'unreadable';
  /** Ms since the last poll, or null when there is nothing to measure from. */
  seenMsAgo: number | null;
}

/** Base name of the launcher's liveness marker, kept beside the request log. */
const LAUNCHER_HEARTBEAT_BASENAME = 'terminal-launcher-heartbeat.json';

/**
 * How many distinct workspaces the session listing may union. The picker is an
 * OWNER endpoint a UI polls, and each workspace adds a directory scan plus one
 * open and first-line read per transcript it holds, so the union needs its own
 * bound independent of the per-listing transcript cap. A host that has worked in
 * more than this many workspaces still gets the most recent ones.
 */
export const RECENT_WORKSPACES_CAP = 16;

/** A workspace this gateway worked in, with when it last did (epoch ms). */
export interface RecentWorkspace {
  cwd: string;
  at: number;
}

/**
 * Union several recent-workspace lists into the one the session listing
 * scans: newest first, each workspace once at its newest time, capped as a
 * whole. Pure, so every source (the terminal request log, the host-attach
 * record) is merged by the same rule and none of them needs to know the
 * others exist.
 */
export function mergeRecentWorkspaces(
  lists: ReadonlyArray<readonly RecentWorkspace[]>,
  cap: number,
): string[] {
  if (!(cap > 0)) return [];
  const newest = new Map<string, number>();
  for (const list of lists) {
    for (const { cwd, at } of list) {
      const seen = newest.get(cwd);
      if (seen === undefined || at > seen) newest.set(cwd, at);
    }
  }
  return [...newest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([cwd]) => cwd);
}

/**
 * Append-only JSONL request log. Sole writer is the gateway process; the
 * launcher only reads it and keeps its own cursor, so concurrent writes are
 * impossible by construction. A missing file reads as empty (never created
 * until the first request, so a host that never uses this gains no file).
 */
export class TerminalRequestLog {
  private readonly heartbeatPath: string;

  private constructor(
    private readonly filePath: string,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {
    this.heartbeatPath = join(dirname(filePath), LAUNCHER_HEARTBEAT_BASENAME);
  }

  static open(
    filePath: string,
    opts: TerminalRequestLogOptions = {},
  ): TerminalRequestLog {
    return new TerminalRequestLog(
      filePath,
      opts.now ?? Date.now,
      opts.newId ?? randomUUID,
    );
  }

  /** Record a new request and return it (id + timestamp assigned here). */
  async enqueue(
    req: Omit<TerminalRequest, 'id' | 'createdAt'>,
  ): Promise<TerminalRequest> {
    const full: TerminalRequest = {
      ...req,
      id: this.newId(),
      createdAt: this.now(),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(full)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return full;
  }

  /**
   * Every request in the log, oldest first. Malformed lines are skipped
   * rather than fatal: a torn final line from a crash mid-append must not make
   * the whole surface unreadable for the launcher.
   */
  async readAll(): Promise<TerminalRequest[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: TerminalRequest[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseRequest(trimmed);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** Requests not yet seen by `cursor` (the launcher's stored line count). */
  async since(cursor: number): Promise<TerminalRequest[]> {
    const all = await this.readAll();
    return all.slice(Math.max(0, cursor));
  }

  /**
   * The distinct `workspaceCwd`s this gateway has handed a terminal to, most
   * recently used first, capped at `cap`.
   *
   * This is the bounded set the session listing unions so a conversation
   * started in one workspace is selectable from another. Both halves matter:
   * the live daemon pool cannot be the source because its idle reaper drops a
   * workspace after 15 minutes, which would make dormant conversations vanish
   * from a picker whose whole job is to show dormant ones; and scanning every
   * project segment is unusable on a real host, where the segment root is
   * mostly throwaway test workspaces. The request log is the record of where
   * this gateway has actually worked, so it is both small and durable across
   * reaping and restarts.
   *
   * A missing/unreadable log reads as empty, so a host that never opened a
   * terminal keeps the single-workspace listing it has today.
   */
  async recentWorkspaces(cap: number): Promise<string[]> {
    return (await this.recentWorkspaceEntries(cap)).map((e) => e.cwd);
  }

  /**
   * The same set as {@link recentWorkspaces}, each with the time of its newest
   * request, so it can be merged newest first with the host-attach record
   * (hostAttachedWorkspaces.ts) by {@link mergeRecentWorkspaces}.
   */
  async recentWorkspaceEntries(cap: number): Promise<RecentWorkspace[]> {
    if (!(cap > 0)) return [];
    const seen = new Set<string>();
    const out: RecentWorkspace[] = [];
    const all = await this.readAll();
    for (let i = all.length - 1; i >= 0; i--) {
      const cwd = all[i].workspaceCwd;
      if (!cwd || seen.has(cwd)) continue;
      seen.add(cwd);
      out.push({ cwd, at: all[i].createdAt });
      if (out.length === cap) break;
    }
    return out;
  }

  /**
   * Record that the launcher polled the request log. The poll IS the heartbeat:
   * the launcher already drives this command on its own interval, so liveness
   * costs no new traffic and no new process to keep alive.
   *
   * The marker is a separate file because the request log's one-writer rule is
   * what makes it lock free. That rule survives here: this file's only writer is
   * the poll process, and the gateway still writes nothing but the request log.
   * `writeFile` rather than append, so the file stays one small object instead
   * of growing without limit on a host that polls every few seconds forever.
   */
  async recordPoll(cursor: number): Promise<void> {
    await mkdir(dirname(this.heartbeatPath), { recursive: true });
    await writeFile(
      this.heartbeatPath,
      JSON.stringify({ at: this.now(), cursor }),
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  /** Read the marker and judge it against `staleMs`. See LauncherLiveness. */
  async launcherLiveness(staleMs: number): Promise<LauncherLiveness> {
    let raw: string;
    try {
      raw = await readFile(this.heartbeatPath, 'utf8');
    } catch {
      return { state: 'never', seenMsAgo: null };
    }
    const at = heartbeatAt(raw);
    if (at === null) return { state: 'unreadable', seenMsAgo: null };
    const ago = this.now() - at;
    return { state: ago <= staleMs ? 'live' : 'stale', seenMsAgo: ago };
  }
}

/** Pull the timestamp out of a heartbeat, or null when it carries none. */
function heartbeatAt(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const at = (parsed as Record<string, unknown>)['at'];
    return typeof at === 'number' && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function parseRequest(line: string): TerminalRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const id = str(r['id']);
  const sessionId = str(r['sessionId']);
  const workspaceCwd = str(r['workspaceCwd']);
  const daemonUrl = str(r['daemonUrl']);
  const daemonToken = str(r['daemonToken']);
  const title = str(r['title']);
  const linuxArgv = Array.isArray(r['linuxArgv'])
    ? r['linuxArgv'].filter(
        (a): a is string => typeof a === 'string' && a.length > 0,
      )
    : [];
  if (
    !id ||
    !sessionId ||
    !workspaceCwd ||
    !daemonUrl ||
    !daemonToken ||
    !title ||
    linuxArgv.length === 0
  ) {
    return null;
  }
  return {
    id,
    sessionId,
    workspaceCwd,
    daemonUrl,
    daemonToken,
    linuxArgv,
    title,
    createdAt: typeof r['createdAt'] === 'number' ? r['createdAt'] : 0,
  };
}

/** Operator config for the command a host terminal should run. */
export interface TerminalPlanOptions {
  /**
   * The qwen command to run inside the distro, as argv. Defaults to `qwen` on
   * PATH. This MUST name a build that has `--attach-daemon`: the published npm
   * qwen does not, and yargs would reject the flag, leaving a TUI running a
   * second, unmirrored agent instead of attaching.
   */
  qwenArgv?: string[];
  /**
   * This gateway's own entry point (`qwen-rc`), as argv. A phone-opened tab runs
   * `<rcArgv> attach --session <id> <cwd>` so it re-attaches when its daemon
   * dies, instead of ending on a dead session. Defaults to `qwen-rc` on PATH;
   * the gateway passes `process.execPath` + its own script so the tab runs the
   * same build that wrote the request.
   */
  rcArgv?: string[];
}

/** The command a host terminal must run, as the gateway decided it. */
export interface TerminalCommand {
  /** Executable + args to run inside the distro. */
  linuxArgv: string[];
  /** Tab label. */
  title: string;
  /** Shell-quoted `wsl.exe …` form, for logs and manual reproduction. */
  displayCommand: string;
}

function titleFor(sessionId: string): string {
  return `qwen ${sessionId.slice(0, 8)}`;
}

/**
 * The TUI itself, attached to one daemon session: what `qwen-rc attach` runs
 * as its child. `--attach-daemon` is what makes it a second client of the SAME
 * daemon session.
 *
 * The session id is passed explicitly: the web UI creates conversations with
 * `scope:'thread'`, so a workspace's daemon holds several sessions and
 * attaching to "the workspace session" would show the wrong conversation.
 */
export function planAttachedTuiCommand(
  req: Pick<TerminalRequest, 'sessionId' | 'daemonUrl' | 'daemonToken'>,
  opts: Pick<TerminalPlanOptions, 'qwenArgv'> = {},
): string[] {
  const qwenArgv = opts.qwenArgv?.length ? opts.qwenArgv : ['qwen'];
  return [
    ...qwenArgv,
    '--attach-daemon',
    req.daemonUrl,
    '--daemon-token',
    req.daemonToken,
    '--attach-session',
    req.sessionId,
  ];
}

/**
 * Compose the command a host terminal runs to show one conversation.
 *
 * The gateway owns this so qwen's flag names live in exactly one place; the
 * Windows-side launcher only wraps it (`wsl.exe --cd … --exec …` inside a
 * `wt new-tab`) and never learns qwen's CLI.
 *
 * The tab runs `qwen-rc attach --session <id> <workspaceCwd>` rather than qwen:
 * that wrapper asks the gateway for the daemon endpoint (so no daemon URL or
 * token appears on the tab's argv, where `ps` would show it) and runs the TUI
 * from {@link planAttachedTuiCommand}, re-attaching when the TUI reports its
 * daemon gone. The wrapper process is what stays alive across re-attaches.
 */
export function planTerminalCommand(
  req: Pick<TerminalRequest, 'sessionId' | 'workspaceCwd'>,
  opts: TerminalPlanOptions = {},
): TerminalCommand {
  const rcArgv = opts.rcArgv?.length ? opts.rcArgv : ['qwen-rc'];
  const linuxArgv = [
    ...rcArgv,
    'attach',
    '--session',
    req.sessionId,
    req.workspaceCwd,
  ];
  return {
    linuxArgv,
    title: titleFor(req.sessionId),
    // Quoted for a POSIX shell so it can be pasted/logged; the launcher runs
    // the argv through execFile and never touches a shell.
    displayCommand: [
      'wsl.exe',
      '--cd',
      req.workspaceCwd,
      '--exec',
      ...linuxArgv,
    ]
      .map(shellQuote)
      .join(' '),
  };
}

/** Default request-log path, mirroring the other `~/.qwen/rc/*.json` stores. */
export function defaultTerminalLogPath(homeDir: string): string {
  return join(homeDir, '.qwen', 'rc', 'terminal-requests.jsonl');
}

const SHELL_SAFE = /^[\w./:=,@+-]+$/;

/** Quote one argument for a POSIX shell, leaving plainly-safe words bare. */
function shellQuote(arg: string): string {
  if (SHELL_SAFE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse the `QWEN_RC_TERMINAL_QWEN` operator setting into argv. Accepts a JSON
 * array (`["node","/path/dist/index.js"]`) or a whitespace-separated command.
 * Empty/unset → undefined, meaning "use `qwen` on PATH".
 */
export function terminalQwenArgv(
  raw: string | undefined,
): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((a) => typeof a === 'string' && a.length > 0)
      ) {
        return parsed as string[];
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  return trimmed.split(/\s+/);
}
