/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';

/**
 * Operator-approved content hashes for watched workspace config files (#242):
 * `<workspace>/.qwen/policy.yaml` and `<workspace>/.qwen/routing.yaml`.
 *
 * Both files sit inside `<workspace>/.qwen/`, where a `git clone` / `git pull`
 * or the model's own edit tool can create or rewrite them without an operator
 * in the loop. The narrowing checks in `policy/loader.ts` and `routing/rules.ts`
 * prevent privilege escalation, while this store records whether an owner
 * actually approved the exact bytes on disk before they take effect.
 *
 * Boundary note: the store lives in the gateway's own state directory
 * (`~/.qwen/rc/workspace-config-approvals.json`, mode 0600), outside any
 * project workspace. When the gateway runs under the same OS user as an
 * unsandboxed local agent, this is an application-level workspace boundary
 * rather than an OS uid boundary.
 */

export type WorkspaceConfigKind = 'policy' | 'routing';
export type WorkspaceConfigHoldPhase = 'boot' | 'reload';

export interface WorkspaceConfigApprovalRecord {
  path: string;
  kind: WorkspaceConfigKind;
  sha256: string;
  approvedBy: string;
  approvedAt: string;
}

export interface HeldWorkspaceConfig {
  path: string;
  kind: WorkspaceConfigKind;
  sha256: string;
  phase: WorkspaceConfigHoldPhase;
  heldAt: string;
}

interface PersistedApprovalsFile {
  version: 1;
  approvals: Record<string, WorkspaceConfigApprovalRecord>;
}

/**
 * Thrown by strict hot-reload loaders when a workspace config file is valid
 * YAML within its narrowing bounds, but its SHA-256 has not been approved by
 * an owner. `DebouncedReloader` retains the previous active ruleset, and
 * `hotReload.ts` records `policy_workspace_held` / `routing_workspace_held`
 * instead of `*_reload_failed`.
 */
export class WorkspaceConfigHeldError extends Error {
  readonly kind: WorkspaceConfigKind;
  readonly filePath: string;
  readonly sha256: string;

  constructor(kind: WorkspaceConfigKind, filePath: string, sha256: string) {
    super(
      `workspace ${kind}.yaml (${filePath}) is not approved for sha256=${sha256}`,
    );
    this.name = 'WorkspaceConfigHeldError';
    this.kind = kind;
    this.filePath = filePath;
    this.sha256 = sha256;
  }
}

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Resolve the canonical path of `<workspaceCwd>/.qwen/<kind>.yaml` and verify
 * that neither `.qwen` nor the target file escapes `workspaceCwd` via symlink.
 * Returns `{ path, bytes, text, sha256 }` when the file exists inside the
 * workspace, `{ path, absent: true }` on ENOENT, or throws an Error when a
 * symlink escapes `workspaceCwd` or the target is not a regular file.
 */
export function readContainedWorkspaceConfig(
  workspaceCwd: string,
  kind: WorkspaceConfigKind,
):
  | { path: string; absent: true }
  | { path: string; absent: false; text: string; sha256: string } {
  const wsResolved = resolve(workspaceCwd);
  const fileName = kind === 'policy' ? 'policy.yaml' : 'routing.yaml';
  const expectedPath = join(wsResolved, '.qwen', fileName);

  if (!existsSync(wsResolved)) {
    return { path: expectedPath, absent: true };
  }
  const wsReal = realpathSync(wsResolved);
  const qwenDir = join(wsResolved, '.qwen');

  let qwenStat;
  try {
    qwenStat = lstatSync(qwenDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { path: expectedPath, absent: true };
    }
    throw err;
  }
  if (qwenStat.isSymbolicLink()) {
    throw new Error(`.qwen directory may not be a symlink (${qwenDir})`);
  }

  let fileStat;
  try {
    fileStat = lstatSync(expectedPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { path: expectedPath, absent: true };
    }
    throw err;
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(
      `workspace ${fileName} may not be a symlink (${expectedPath})`,
    );
  }
  if (!fileStat.isFile()) {
    throw new Error(
      `workspace ${fileName} must be a regular file (${expectedPath})`,
    );
  }

  const fileReal = realpathSync(expectedPath);
  const rel = relative(wsReal, fileReal);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `workspace ${fileName} resolves outside workspace (${expectedPath})`,
    );
  }

  const raw = readFileSync(expectedPath);
  const text = raw.toString('utf8');
  return {
    path: expectedPath,
    absent: false,
    text,
    sha256: sha256Hex(raw),
  };
}

export class WorkspaceConfigApprovalStore {
  private readonly storePath: string;
  private readonly now: () => Date;
  private readonly records = new Map<string, WorkspaceConfigApprovalRecord>();
  private readonly held = new Map<string, HeldWorkspaceConfig>();

  constructor(storePath: string, now: () => Date = () => new Date()) {
    this.storePath = resolve(storePath);
    this.now = now;
    this.loadFromDisk();
  }

  static open(
    storePath: string,
    now: () => Date = () => new Date(),
  ): WorkspaceConfigApprovalStore {
    return new WorkspaceConfigApprovalStore(storePath, now);
  }

  private loadFromDisk(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const parsed = JSON.parse(
        readFileSync(this.storePath, 'utf8'),
      ) as Partial<PersistedApprovalsFile>;
      if (
        parsed &&
        parsed.version === 1 &&
        parsed.approvals &&
        typeof parsed.approvals === 'object'
      ) {
        for (const [k, rec] of Object.entries(parsed.approvals)) {
          if (
            rec &&
            typeof rec.path === 'string' &&
            (rec.kind === 'policy' || rec.kind === 'routing') &&
            typeof rec.sha256 === 'string' &&
            /^[0-9a-f]{64}$/.test(rec.sha256) &&
            typeof rec.approvedBy === 'string' &&
            typeof rec.approvedAt === 'string'
          ) {
            this.records.set(resolve(k), {
              path: resolve(rec.path),
              kind: rec.kind,
              sha256: rec.sha256,
              approvedBy: rec.approvedBy,
              approvedAt: rec.approvedAt,
            });
          }
        }
      }
    } catch {
      // Malformed or unreadable file fails closed (empty approvals map).
      this.records.clear();
    }
  }

  private persistToDisk(): void {
    const dir = dirname(this.storePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const approvals: Record<string, WorkspaceConfigApprovalRecord> = {};
    for (const [k, v] of this.records.entries()) {
      approvals[k] = v;
    }
    const payload: PersistedApprovalsFile = { version: 1, approvals };
    const tmp = `${this.storePath}.tmp-${randomBytes(6).toString('hex')}`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best-effort on filesystems without POSIX mode bits.
    }
    renameSync(tmp, this.storePath);
  }

  getApproval(filePath: string): WorkspaceConfigApprovalRecord | undefined {
    return this.records.get(resolve(filePath));
  }

  isApproved(filePath: string, sha256: string): boolean {
    const rec = this.records.get(resolve(filePath));
    return rec !== undefined && rec.sha256 === sha256;
  }

  approve(entry: {
    path: string;
    kind: WorkspaceConfigKind;
    sha256: string;
    approvedBy: string;
  }): WorkspaceConfigApprovalRecord {
    const key = resolve(entry.path);
    const record: WorkspaceConfigApprovalRecord = {
      path: key,
      kind: entry.kind,
      sha256: entry.sha256.toLowerCase(),
      approvedBy: entry.approvedBy,
      approvedAt: this.now().toISOString(),
    };
    this.records.set(key, record);
    this.held.delete(key);
    this.persistToDisk();
    return record;
  }

  recordHeld(entry: {
    path: string;
    kind: WorkspaceConfigKind;
    sha256: string;
    phase: WorkspaceConfigHoldPhase;
  }): HeldWorkspaceConfig {
    const key = resolve(entry.path);
    const prev = this.held.get(key);
    // Preserve 'boot' phase when a file held at boot is re-probed before any
    // reload changes its hash, so the UI continues to report held-at-boot.
    const phase =
      prev && prev.sha256 === entry.sha256 && prev.phase === 'boot'
        ? 'boot'
        : entry.phase;
    const held: HeldWorkspaceConfig = {
      path: key,
      kind: entry.kind,
      sha256: entry.sha256.toLowerCase(),
      phase,
      heldAt:
        prev && prev.sha256 === entry.sha256
          ? prev.heldAt
          : this.now().toISOString(),
    };
    this.held.set(key, held);
    return held;
  }

  clearHeld(filePath: string): void {
    this.held.delete(resolve(filePath));
  }

  getHeld(filePath: string): HeldWorkspaceConfig | undefined {
    return this.held.get(resolve(filePath));
  }

  listHeld(): HeldWorkspaceConfig[] {
    return [...this.held.values()];
  }
}
