/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Is a host terminal already showing this conversation? (issue #194, slice C)
 *
 * A host terminal is a TUI started as `qwen --attach-daemon <url>
 * --daemon-token <t> --attach-session <id>` on the same machine as the gateway,
 * run under the `qwen-rc attach --session <id> <cwd>` wrapper (slice E) that
 * re-attaches it when its daemon dies.
 * The launcher coalesces duplicate requests for one session only within a few
 * seconds, so picking the same conversation twice an hour apart opened a second
 * tab on it. The gateway now looks for the tab itself.
 *
 * Detection is a scan of live processes for that argv rather than a question to
 * the daemon. The daemon's client registry would not do: it forgets a TUI the
 * moment its daemon dies, and a tab attached to a dead daemon (the gateway just
 * restarted) is still a tab on screen that will re-attach, so a new one must
 * not be opened beside it. A process scan counts it. No shell and no `pgrep`:
 * `/proc/<pid>/cmdline` is read directly, so there is no pattern to quote and
 * no second process that could match its own argv.
 *
 * A match counts only when its fd 0 is a terminal that still exists (issue
 * #207): closing a Windows Terminal tab can leave the wrapper and its TUI
 * running with stdin on `/dev/pts/N (deleted)`, and such a process is not a tab
 * on screen. Counting it told the phone the conversation was already open on
 * the host, so no new tab opened until someone killed the orphans.
 */

import { readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/** One live process: its pid and argv. */
export interface ProcessEntry {
  pid: number;
  argv: string[];
}

/** Lists every live process. A test seam; the default reads /proc. */
export type ProcessLister = () => Promise<ProcessEntry[]>;

/**
 * Where a process's fd 0 points, as `readlink` reports it, or undefined when it
 * cannot be read (the process exited mid-scan, or belongs to someone else). A
 * test seam; the default reads `/proc/<pid>/fd/0`.
 */
export type StdinTargetReader = (pid: number) => Promise<string | undefined>;

const ATTACH_FLAG = '--attach-session';
const WRAPPER_SUBCOMMAND = 'attach';
const WRAPPER_FLAG = '--session';

/**
 * Argv of every readable process under a /proc-shaped directory. Entries that
 * are not pids, have an empty cmdline (kernel threads), or cannot be read (a
 * process that exited mid-scan, or one owned by someone else) are skipped
 * rather than failing the scan. An unreadable directory is an empty host.
 */
export async function readProcEntries(
  procDir = '/proc',
): Promise<ProcessEntry[]> {
  let names: string[];
  try {
    names = await readdir(procDir);
  } catch {
    return [];
  }
  const pids = names.filter((n) => /^\d+$/.test(n));
  const read = await Promise.all(
    pids.map(async (pid) => {
      try {
        const raw = await readFile(join(procDir, pid, 'cmdline'), 'utf8');
        if (raw.length === 0) return undefined;
        const parts = raw.split('\0');
        // cmdline ends with a NUL, which leaves one empty trailing element.
        if (parts[parts.length - 1] === '') parts.pop();
        return { pid: Number(pid), argv: parts };
      } catch {
        return undefined;
      }
    }),
  );
  return read.filter((e): e is ProcessEntry => e !== undefined);
}

/** Argv of every readable process; see {@link readProcEntries}. */
export async function readProcArgv(procDir = '/proc'): Promise<string[][]> {
  return (await readProcEntries(procDir)).map((e) => e.argv);
}

/** The default {@link StdinTargetReader}: `readlink /proc/<pid>/fd/0`. */
export function readStdinTarget(procDir = '/proc'): StdinTargetReader {
  return async (pid) => {
    try {
      return await readlink(join(procDir, String(pid), 'fd', '0'));
    } catch {
      return undefined;
    }
  };
}

/**
 * Whether a `/proc/<pid>/fd/0` target is a terminal that still exists. A tab
 * whose window was closed leaves its processes running with fd 0 reading
 * `/dev/pts/N (deleted)` (issue #207): the pty is gone, so nobody is looking
 * at that tab. A process with its stdin on `/dev/null`, a pipe or a file is no
 * tab on screen either.
 */
export function isLiveTerminalTarget(target: string | undefined): boolean {
  if (target === undefined) return false;
  if (target.endsWith(' (deleted)')) return false;
  return /^\/dev\/(pts\/\d+|tty[^/]*)$/.test(target);
}

/**
 * Whether `argv` attaches to exactly `sessionId` (never a longer id it
 * prefixes). Two shapes count:
 * - the TUI: `... --attach-session <id>`;
 * - the wrapper a phone-opened tab runs: `qwen-rc attach ... --session <id>`.
 *   The wrapper is what stays alive across re-attaches (the TUI under it is
 *   gone while it waits for a daemon), so it must count. A bare `--session` is
 *   too common a flag to trust alone, so it only counts after an `attach`
 *   argument.
 */
function attachesTo(argv: string[], sessionId: string): boolean {
  const attachAt = argv.indexOf(WRAPPER_SUBCOMMAND);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === ATTACH_FLAG && argv[i + 1] === sessionId) return true;
    if (a === `${ATTACH_FLAG}=${sessionId}`) return true;
    if (attachAt !== -1 && i > attachAt) {
      if (a === WRAPPER_FLAG && argv[i + 1] === sessionId) return true;
      if (a === `${WRAPPER_FLAG}=${sessionId}`) return true;
    }
  }
  return false;
}

/**
 * True when a live process on this host is attached to `sessionId` and has a
 * live terminal on fd 0. A process whose terminal is gone (a closed tab whose
 * wrapper outlived its pty, issue #207) is not a tab on screen, so it does not
 * count; neither does one whose fd 0 cannot be read. A lister that fails
 * answers false: the check only exists to avoid a duplicate tab, and a missing
 * tab is the worse failure than a rare duplicate one.
 */
export async function isSessionMirrored(
  sessionId: string,
  lister: ProcessLister = () => readProcEntries(),
  readStdin: StdinTargetReader = readStdinTarget(),
): Promise<boolean> {
  if (!sessionId) return false;
  let procs: ProcessEntry[];
  try {
    procs = await lister();
  } catch {
    return false;
  }
  for (const proc of procs) {
    if (!attachesTo(proc.argv, sessionId)) continue;
    let target: string | undefined;
    try {
      target = await readStdin(proc.pid);
    } catch {
      target = undefined;
    }
    if (isLiveTerminalTarget(target)) return true;
  }
  return false;
}
