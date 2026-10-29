/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Is a host terminal already showing this conversation? (issue #194, slice C)
 *
 * A host terminal is a TUI started as `qwen --attach-daemon <url>
 * --daemon-token <t> --attach-session <id>` on the same machine as the gateway.
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
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Lists the argv of every live process. A test seam; the default reads /proc. */
export type ProcessLister = () => Promise<string[][]>;

const ATTACH_FLAG = '--attach-session';

/**
 * Argv of every readable process under a /proc-shaped directory. Entries that
 * are not pids, have an empty cmdline (kernel threads), or cannot be read (a
 * process that exited mid-scan, or one owned by someone else) are skipped
 * rather than failing the scan. An unreadable directory is an empty host.
 */
export async function readProcArgv(procDir = '/proc'): Promise<string[][]> {
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
        return parts;
      } catch {
        return undefined;
      }
    }),
  );
  return read.filter((a): a is string[] => a !== undefined);
}

/** Whether `argv` attaches to exactly `sessionId` (never a longer id it prefixes). */
function attachesTo(argv: string[], sessionId: string): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === ATTACH_FLAG && argv[i + 1] === sessionId) return true;
    if (a === `${ATTACH_FLAG}=${sessionId}`) return true;
  }
  return false;
}

/**
 * True when any live process on this host is attached to `sessionId`. A lister
 * that fails answers false: the check only exists to avoid a duplicate tab, and
 * a missing tab is the worse failure than a rare duplicate one.
 */
export async function isSessionMirrored(
  sessionId: string,
  lister: ProcessLister = () => readProcArgv(),
): Promise<boolean> {
  if (!sessionId) return false;
  let procs: string[][];
  try {
    procs = await lister();
  } catch {
    return false;
  }
  return procs.some((argv) => attachesTo(argv, sessionId));
}
