/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The workspaces `qwen-rc attach` has used (InfiniteInsight/Qwen-Code-Remote#194
 * slice D), so a conversation started from a terminal in a folder the phone
 * has never opened still shows in the phone's list.
 *
 * Why a file of its own: the session listing widens its scan to the
 * workspaces in the terminal request log (`TerminalRequestLog.
 * recentWorkspaceEntries`), but that log is the Windows launcher's work queue.
 * Every line in it opens a tab, so a host attach cannot be noted there. This
 * record sits beside it and the listing merges the two
 * (`mergeRecentWorkspaces` in terminals.ts).
 *
 * Shape: `{ "workspaces": [{ "cwd", "at" }] }`, most recent first, one entry
 * per workspace, capped at RECENT_WORKSPACES_CAP. The gateway is its only
 * writer; writes are serialized in-process and land by rename, so a reader
 * never sees half a file. 0600 like the other `~/.qwen/rc` stores: it names
 * the folders this user works in. A missing, unreadable or corrupt file reads
 * as empty, which is the listing it would have produced before this existed.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { RECENT_WORKSPACES_CAP, type RecentWorkspace } from './terminals.js';

/** Base name of the record, beside `terminal-requests.jsonl`. */
export const HOST_ATTACHED_WORKSPACES_BASENAME =
  'host-attached-workspaces.json';

/** Default path, mirroring `defaultTerminalLogPath`. */
export function defaultHostAttachedWorkspacesPath(homeDir: string): string {
  return join(homeDir, '.qwen', 'rc', HOST_ATTACHED_WORKSPACES_BASENAME);
}

/** Put `cwd` first at `at`, drop its older entry, keep at most `cap`. */
export function noteRecentWorkspace(
  list: readonly RecentWorkspace[],
  cwd: string,
  at: number,
  cap: number,
): RecentWorkspace[] {
  return [{ cwd, at }, ...list.filter((e) => e.cwd !== cwd)].slice(
    0,
    Math.max(0, cap),
  );
}

/** The stored entries, or `[]` for anything that is not the stored shape. */
export function parseRecentWorkspaces(raw: string): RecentWorkspace[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { workspaces?: unknown }).workspaces
      : undefined;
  if (!Array.isArray(list)) return [];
  const out: RecentWorkspace[] = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const { cwd, at } = e as { cwd?: unknown; at?: unknown };
    if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) {
      continue;
    }
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    out.push({ cwd, at });
  }
  return out;
}

export interface HostAttachedWorkspacesOptions {
  now?: () => number;
  cap?: number;
}

export class HostAttachedWorkspaces {
  /** Serializes read-modify-write so concurrent attaches all land. */
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly now: () => number,
    private readonly cap: number,
  ) {}

  static open(
    filePath: string,
    opts: HostAttachedWorkspacesOptions = {},
  ): HostAttachedWorkspaces {
    return new HostAttachedWorkspaces(
      filePath,
      opts.now ?? Date.now,
      opts.cap ?? RECENT_WORKSPACES_CAP,
    );
  }

  /** Most recent first. Never throws. */
  async read(): Promise<RecentWorkspace[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    return parseRecentWorkspaces(raw);
  }

  /** Note that `cwd` was attached to now. Rejects only if the write failed. */
  record(cwd: string): Promise<void> {
    const run = this.chain.then(async () => {
      const next = noteRecentWorkspace(
        await this.read(),
        cwd,
        this.now(),
        this.cap,
      );
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ workspaces: next }), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(tmp, this.filePath);
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
