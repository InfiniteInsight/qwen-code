/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Host-terminal launcher (issue #49).
 *
 * This runs inside the user's interactive Windows session, which is the only
 * context where a Win32 window can be created — the gateway itself is headless
 * and every `wt`/`notepad` launch from there is refused by Windows. So the
 * gateway records requests and this drains them.
 *
 * Deliberately dumb: the gateway composes the command to run (see
 * `rc-gateway/src/terminals.ts`) and this only wraps it in
 * `wsl.exe --cd … --exec …` inside a `wt new-tab`. No qwen flag names live
 * here, so they cannot drift from the gateway's.
 */
import { execFile } from 'node:child_process';

/** One queued request, as written by the gateway. */
export interface TerminalRequest {
  id: string;
  sessionId: string;
  workspaceCwd: string;
  daemonUrl: string;
  daemonToken: string;
  /** Command to run inside the distro, composed by the gateway. */
  linuxArgv: string[];
  title: string;
  createdAt: number;
}

/** A page of the request log, as printed by `qwen-rc terminals pending`. */
export interface PendingPage {
  cursor: number;
  requests: TerminalRequest[];
}

/** Outcome of one drain pass. */
export interface DrainResult {
  /** New cursor to persist (the log's total length). */
  cursor: number;
  opened: string[];
  failed: Array<{ id: string; error: string }>;
  /** Requests skipped because a tab for that session is already open. */
  skipped: string[];
}

/** How to reach the WSL side and Windows Terminal. Injectable for tests. */
export interface LauncherDeps {
  /** Run a command inside the distro (`wsl.exe -- bash -lc …`). */
  runWsl: (command: string) => Promise<{ code: number; stdout: string }>;
  /** Launch Windows Terminal with `args`; resolves when it is accepted. */
  execWt: (args: string[]) => Promise<void>;
}

/**
 * Parse `qwen-rc terminals pending --json` output. Unparseable output yields an
 * empty page at the SAME cursor we asked about, so a transient failure retries
 * next tick rather than silently dropping requests or skipping ahead.
 */
export function parsePending(raw: string, fallbackCursor: number): PendingPage {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cursor =
      typeof parsed.cursor === 'number' && parsed.cursor >= 0
        ? parsed.cursor
        : fallbackCursor;
    const requests = Array.isArray(parsed.requests)
      ? (parsed.requests as TerminalRequest[]).filter(isRequest)
      : [];
    return { cursor, requests };
  } catch {
    return { cursor: fallbackCursor, requests: [] };
  }
}

function isRequest(r: unknown): r is TerminalRequest {
  if (!r || typeof r !== 'object') return false;
  const v = r as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.workspaceCwd === 'string' &&
    typeof v.title === 'string' &&
    Array.isArray(v.linuxArgv) &&
    v.linuxArgv.length > 0 &&
    v.linuxArgv.every((a) => typeof a === 'string')
  );
}

/**
 * Build the `wt.exe` argv opening one tab in the given distro and directory.
 *
 * `--exec` (rather than `--`) makes wsl.exe pass the argv through verbatim, so
 * no shell re-parses the daemon token. `distro` is omitted when unconfigured,
 * which uses the Windows default distro.
 */
export function buildWtArgs(
  req: Pick<TerminalRequest, 'workspaceCwd' | 'linuxArgv' | 'title'>,
  opts: { distro?: string } = {},
): string[] {
  return [
    'new-tab',
    '--title',
    req.title,
    'wsl.exe',
    ...(opts.distro ? ['-d', opts.distro] : []),
    '--cd',
    req.workspaceCwd,
    '--exec',
    ...req.linuxArgv,
  ];
}

/** Command that fetches the queue, from the launcher's own cursor onward. */
export function pendingCommand(cursor: number): string {
  return `qwen-rc terminals pending --after=${Math.max(0, Math.floor(cursor))} --json`;
}

/**
 * Fetch queued requests and open a tab for each.
 *
 * `openSessions` is the caller's long-lived set of session ids with a tab
 * already open. Skipping repeats matters: with the daemon's default
 * `sessionScope:'single'`, every "New conversation" in a workspace resolves the
 * SAME session id, so without this a user clicking twice gets two identical
 * tabs.
 *
 * A request whose tab fails to open is reported and left un-recorded, so the
 * next pass retries it (the cursor only advances past what was handled).
 */
export async function drainTerminalRequests(
  cursor: number,
  openSessions: Set<string>,
  deps: LauncherDeps,
  opts: { distro?: string } = {},
): Promise<DrainResult> {
  const run = await deps.runWsl(pendingCommand(cursor));
  const page = parsePending(run.stdout, cursor);
  const result: DrainResult = {
    cursor,
    opened: [],
    failed: [],
    skipped: [],
  };
  if (run.code !== 0 && page.requests.length === 0) {
    // Nothing readable came back (gateway down, `qwen-rc` not on PATH). Leave
    // the cursor put so the next tick retries the same window.
    return result;
  }
  // The page is a contiguous slice starting at `cursor`, so the cursor is just
  // how many of them were handled in order.
  let advanced = cursor;
  for (const req of page.requests) {
    if (openSessions.has(req.sessionId)) {
      result.skipped.push(req.id);
      advanced++;
      continue;
    }
    try {
      await deps.execWt(buildWtArgs(req, opts));
    } catch (err) {
      result.failed.push({
        id: req.id,
        error: (err as Error)?.message ?? String(err),
      });
      // Stop WITHOUT advancing: a refused launch means Windows is not
      // reachable from here, so the rest would fail identically. They stay
      // queued and are retried next tick. A permanently-failing request blocks
      // the queue, which is the honest failure mode — a host that cannot open
      // one tab cannot open any.
      break;
    }
    openSessions.add(req.sessionId);
    result.opened.push(req.id);
    advanced++;
  }
  result.cursor = Math.min(advanced, page.cursor);
  return result;
}

/** Real Windows Terminal launch. `wt` resolves from the user PATH. */
export function realExecWt(exe = 'wt.exe'): LauncherDeps['execWt'] {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(exe, args, { encoding: 'utf8' }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
}
