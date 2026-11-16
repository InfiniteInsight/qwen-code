/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistent pending-clone ledger for server-enforced ask-before-start
 * (InfiniteInsight/Qwen-Code-Remote#266).
 *
 * Stored in `<rcDir>/github-pending-clones.json` (mode 0600, atomic replace)
 * rather than inside the cloned repository so the repository's working tree
 * stays clean while surviving tab closes, cleared/blocked sessionStorage, and
 * gateway restarts.
 */

import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { readJsonStore, writeFileAtomic } from '../atomicWrite.js';
import type { GitHubAccountId } from './credentials.js';

export const GITHUB_PENDING_CLONES_FILE = 'github-pending-clones.json';
export const PENDING_CLONES_MAX = 100;

export interface PendingCloneEntry {
  dest: string;
  repo: string;
  account: GitHubAccountId;
  startedAt: number;
  jobId?: string;
  hadError?: boolean;
  /** Dismissed from auto-opening in `Clone from GitHub`, while `POST /session` still asks. */
  dismissed?: boolean;
}

function isUnder(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  );
}

async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

export class PendingCloneStore {
  private readonly entries = new Map<string, PendingCloneEntry>();

  private constructor(private readonly filePath: string | null) {}

  static inMemory(): PendingCloneStore {
    return new PendingCloneStore(null);
  }

  static async open(filePath: string): Promise<PendingCloneStore> {
    const store = new PendingCloneStore(filePath);
    const raw = await readJsonStore(filePath);
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      Array.isArray((raw as Record<string, unknown>)['entries'])
    ) {
      for (const item of (raw as Record<string, unknown>)['entries'] as unknown[]) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        if (
          typeof rec['dest'] !== 'string' ||
          !isAbsolute(rec['dest']) ||
          typeof rec['repo'] !== 'string' ||
          typeof rec['account'] !== 'string' ||
          typeof rec['startedAt'] !== 'number'
        ) {
          continue;
        }
        const norm = resolve(rec['dest']);
        store.entries.set(norm, {
          dest: norm,
          repo: rec['repo'],
          account: rec['account'] as GitHubAccountId,
          startedAt: rec['startedAt'],
          ...(typeof rec['jobId'] === 'string' ? { jobId: rec['jobId'] } : {}),
          ...(rec['hadError'] === true ? { hadError: true } : {}),
          ...(rec['dismissed'] === true ? { dismissed: true } : {}),
        });
      }
    }
    return store;
  }

  list(options: { includeDismissed?: boolean } = {}): PendingCloneEntry[] {
    const all = [...this.entries.values()].filter(
      (e) => options.includeDismissed === true || !e.dismissed,
    );
    all.sort((a, b) => b.startedAt - a.startedAt);
    return all.map((e) => ({ ...e }));
  }

  async record(entry: PendingCloneEntry): Promise<void> {
    const norm = resolve(entry.dest);
    this.entries.delete(norm);
    this.entries.set(norm, { ...entry, dest: norm });
    while (this.entries.size > PENDING_CLONES_MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    await this.persist();
  }

  async markError(dest: string): Promise<void> {
    const norm = resolve(dest);
    const cur = this.entries.get(norm);
    if (!cur) return;
    cur.hadError = true;
    await this.persist();
  }

  async dismiss(dest: string): Promise<boolean> {
    const matched = await this.findCovering(dest);
    if (!matched) return false;
    const cur = this.entries.get(matched.dest);
    if (!cur) return false;
    cur.dismissed = true;
    await this.persist();
    return true;
  }

  async acknowledge(dest: string): Promise<PendingCloneEntry | null> {
    const matched = await this.findCovering(dest);
    if (!matched) {
      const norm = resolve(dest);
      const exact = this.entries.get(norm);
      if (!exact) return null;
      this.entries.delete(norm);
      await this.persist();
      return { ...exact };
    }
    this.entries.delete(matched.dest);
    await this.persist();
    return { ...matched };
  }

  /**
   * Finds the most specific pending clone whose `dest` equals or contains
   * `targetPath` (checked both lexically after `resolve` and after `realpath`
   * so neither `..` segments nor symlinks bypass the gate).
   */
  async findCovering(targetPath: string): Promise<PendingCloneEntry | null> {
    if (!targetPath || !isAbsolute(targetPath) || this.entries.size === 0) {
      return null;
    }
    const resolvedTarget = resolve(targetPath);
    const realTarget = await safeRealpath(resolvedTarget);

    let best: PendingCloneEntry | null = null;
    for (const entry of this.entries.values()) {
      let covers = isUnder(resolvedTarget, entry.dest);
      if (!covers && realTarget !== null) {
        const realEntry = await safeRealpath(entry.dest);
        if (realEntry !== null && isUnder(realTarget, realEntry)) {
          covers = true;
        }
      }
      if (covers && (!best || entry.dest.length > best.dest.length)) {
        best = entry;
      }
    }
    return best ? { ...best } : null;
  }

  private async persist(): Promise<void> {
    if (this.filePath === null) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      this.filePath,
      () =>
        JSON.stringify(
          {
            version: 1,
            entries: [...this.entries.values()],
          },
          null,
          2,
        ) + '\n',
      { mode: 0o600 },
    );
  }
}
