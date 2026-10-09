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

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A request to open a host terminal showing one daemon session. */
export interface TerminalRequest {
  id: string;
  /** Conversation the tab should show. Carried for tab titles and for
   * attach-by-id once the TUI grows `--attach-session`. */
  sessionId: string;
  workspaceCwd: string;
  /** Loopback base URL of the daemon bound to `workspaceCwd`. */
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
 * Append-only JSONL request log. Sole writer is the gateway process; the
 * launcher only reads it and keeps its own cursor, so concurrent writes are
 * impossible by construction. A missing file reads as empty (never created
 * until the first request, so a host that never uses this gains no file).
 */
export class TerminalRequestLog {
  private constructor(
    private readonly filePath: string,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {}

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

/**
 * Compose the command a host terminal runs to show one conversation.
 *
 * The gateway owns this so qwen's flag names live in exactly one place; the
 * Windows-side launcher only wraps it (`wsl.exe --cd … --exec …` inside a
 * `wt new-tab`) and never learns qwen's CLI. `--attach-daemon` is what makes
 * the terminal a second client of the SAME daemon session.
 */
export function planTerminalCommand(
  req: Pick<
    TerminalRequest,
    'sessionId' | 'workspaceCwd' | 'daemonUrl' | 'daemonToken'
  >,
  opts: TerminalPlanOptions = {},
): TerminalCommand {
  const qwenArgv = opts.qwenArgv?.length ? opts.qwenArgv : ['qwen'];
  // The session id is passed explicitly: the web UI creates conversations with
  // `scope:'thread'`, so a workspace's daemon holds several sessions and
  // attaching to "the workspace session" would show the wrong conversation.
  const linuxArgv = [
    ...qwenArgv,
    '--attach-daemon',
    req.daemonUrl,
    '--daemon-token',
    req.daemonToken,
    '--attach-session',
    req.sessionId,
  ];
  return {
    linuxArgv,
    title: `qwen ${req.sessionId.slice(0, 8)}`,
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
