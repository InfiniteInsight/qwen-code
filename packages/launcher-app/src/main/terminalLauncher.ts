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
  /**
   * Requests not opened because a tab was already opened for the same
   * session by a request stamped within `TERMINAL_COALESCE_MS`. Worded as what
   * happened rather than as current state: the launcher cannot observe the tab
   * being closed, so it cannot say one is open now (issue #68).
   */
  skipped: string[];
  /**
   * The queue could not be read at all (no `qwen-rc`, gateway down). Distinct
   * from an empty queue: the caller cannot tell "nothing to do" from "cannot
   * see anything" without this, and a packaged app has no console to say so.
   */
  fetchFailed: boolean;
}

/** How to reach the WSL side and Windows Terminal. Injectable for tests. */
export interface LauncherDeps {
  /** Run a command inside the distro (`wsl.exe -- bash -lc …`). */
  runWsl: (command: string) => Promise<{ code: number; stdout: string }>;
  /** Launch Windows Terminal with `args`; resolves when it is accepted. */
  execWt: (args: string[]) => Promise<void>;
}

/**
 * How long a second request for the same session is still treated as the same
 * ask rather than a new one. Three polls, which is the tolerance the gateway
 * already uses for a launcher that has gone quiet (`rc-gateway/src/routes/
 * terminals.ts`, `LAUNCHER_STALE_MS`), so the two ends do not disagree about
 * what a missed poll means.
 *
 * This is a bound on how far apart two duplicates can be, not a guess about how
 * long a tab lives. Nothing here measures the latter: `wt.exe` hands the tab to
 * the terminal process and returns. What is measurable is that this run opened a
 * tab for a request at a moment the gateway stamped, and the requests carry that
 * moment, so the window is read off data rather than off a timer this app sets.
 */
export const TERMINAL_COALESCE_MS = 3 * 4_000;

/**
 * The gateway's stamp on a request, or null when it has none.
 *
 * A missing stamp arrives as 0 on the way through the log, and 0 against a real
 * epoch stamp is a difference of half a century: taken as a time it would either
 * suppress forever or never, depending on which side was missing. So an
 * unstamped request is never coalesced with anything, which is the direction
 * that cannot leave a user staring at a control that appears to do nothing.
 */
function stampOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
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
 * `openedTabs` is the caller's map, for this app run, of session id to the
 * gateway stamp on the request this run opened a tab for. It is not a claim
 * about what is on screen now: `wt.exe` hands the tab to the terminal process
 * and returns, so closure is invisible from here.
 *
 * A repeat request is therefore coalesced with the one it duplicates only while
 * it is close enough in time to be the same ask (`TERMINAL_COALESCE_MS`), and a
 * later request opens a tab even though an earlier one was opened for the same
 * session. Coalescing forever was the bug: it meant a tab the user closed
 * suppressed every future tab for that conversation for the life of the process,
 * which is days, so the control went dead with nothing on screen to explain it
 * (issue #68). The dedup itself still matters: with the daemon's default
 * `sessionScope:'single'`, every "New conversation" in a workspace resolves the
 * SAME session id, so without it a user clicking twice gets two identical tabs.
 *
 * A request whose tab fails to open is reported and left un-recorded, so the
 * next pass retries it (the cursor only advances past what was handled).
 */
export async function drainTerminalRequests(
  cursor: number,
  openedTabs: Map<string, number>,
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
    fetchFailed: false,
  };
  if (run.code !== 0 && page.requests.length === 0) {
    // Nothing readable came back (gateway down, `qwen-rc` not on PATH). Leave
    // the cursor put so the next tick retries the same window.
    result.fetchFailed = true;
    return result;
  }
  // The page is a contiguous slice starting at `cursor`, so the cursor is just
  // how many of them were handled in order.
  let advanced = cursor;
  // The newest stamp on this page. The launcher has no reason to read a clock
  // when the requests it is asked about already carry the time the gateway
  // wrote them, so this is its only hold on "now".
  let newest = 0;
  for (const req of page.requests) {
    const arrived = stampOf(req.createdAt);
    if (arrived !== null && arrived > newest) newest = arrived;
    const since = openedTabs.get(req.sessionId);
    if (
      arrived !== null &&
      since !== undefined &&
      arrived - since <= TERMINAL_COALESCE_MS
    ) {
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
    if (arrived !== null) openedTabs.set(req.sessionId, arrived);
    result.opened.push(req.id);
    advanced++;
  }
  // Past the window an entry can coalesce nothing, and the log only moves
  // forward, so it is dropped rather than kept for the life of the process.
  // Unbounded growth is the other half of issue #68.
  if (newest > 0) {
    for (const [sessionId, since] of openedTabs) {
      if (newest - since > TERMINAL_COALESCE_MS) openedTabs.delete(sessionId);
    }
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
