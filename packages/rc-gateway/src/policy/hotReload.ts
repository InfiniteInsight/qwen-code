/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import {
  DebouncedReloader,
  type DebouncedReloaderOptions,
} from '../reload/debouncedReloader.js';
import type { AuditEntry } from '../auditLog.js';
import { loadLayeredPolicy, type Policy } from './loader.js';

/**
 * Hot reload of the policy and routing files (issue #156, second half).
 *
 * The workspace files (`<cwd>/.qwen/policy.yaml`, `.qwen/routing.yaml`) can be
 * written by the model's own edit tool, and the gateway watches them. So a
 * reload is held to everything the initial load is held to, because it runs
 * the very same loader:
 *
 * - the workspace layer can only narrow (the loader's merge drops what exceeds
 *   its bounds), with the same field validation;
 * - a reload that fails for any reason keeps the last good value, user layer
 *   included, and audits a refusal naming the file and the reason; nothing is
 *   swapped in half-way;
 * - reloads are debounced and rate-bounded, so a writer in a loop cannot spin
 *   the gateway (or the audit log).
 */

/**
 * Reload timing. A reload runs 250 ms after the last write, at most 5 s after
 * the first write of a streak (a writer that never pauses still gets applied),
 * and never within 2 s of the previous reload starting: at most one reload,
 * and so at most one audit row, per 2 s per watched resource.
 */
export const RELOAD_TIMING = {
  debounceMs: 250,
  minIntervalMs: 2000,
  maxWaitMs: 5000,
} as const;

/** What the watcher hands to the reloader: the changed file, if known. */
export interface HotReload {
  /**
   * Note a change to `file`. Omit it when the watcher could not name the file
   * (some platforms report a null filename); every watched file is then named.
   */
  trigger(file?: string): void;
  stop(): void;
}

export interface HotReloadLog {
  info(msg: string): void;
  warn(msg: string): void;
}

type Timing = Partial<
  Pick<
    DebouncedReloaderOptions<unknown>,
    'debounceMs' | 'minIntervalMs' | 'maxWaitMs' | 'now' | 'schedule' | 'cancel'
  >
>;

const REASON_MAX = 200;

/**
 * A one-line, bounded reason for the audit row. The message can quote the file
 * the model wrote, so it is flattened and truncated rather than stored whole.
 */
export function reloadFailureReason(err: unknown): string {
  const name = (err as Error)?.name ?? 'Error';
  const message = String((err as Error)?.message ?? err)
    .replace(/\s+/g, ' ')
    .trim();
  const full = message ? `${name}: ${message}` : name;
  return full.length > REASON_MAX ? `${full.slice(0, REASON_MAX)}...` : full;
}

interface HotReloadSpec<T> {
  /** The files this reloader watches, named in an audit row when unknown. */
  files: string[];
  load: (note: (msg: string) => void) => Promise<T>;
  apply: (value: T) => void;
  reloaded: AuditEntry['action'];
  failed: AuditEntry['action'];
  /** Detail for the applied row beyond `file`. */
  appliedDetail: (value: T, notes: string[]) => Record<string, unknown>;
  label: string;
  audit: { record(entry: AuditEntry): Promise<void> };
  log: HotReloadLog;
  timing?: Timing;
}

function createHotReload<T>(spec: HotReloadSpec<T>): HotReload {
  // Files changed since the reload that is about to run began. One reload
  // reads both layers, so it can cover several files; the row names them all.
  let changed = new Set<string>();
  // The files and notes of the reload in flight (reloads never overlap).
  let current: { files: string; notes: string[] } = { files: '', notes: [] };

  const reloader = new DebouncedReloader<T>({
    ...RELOAD_TIMING,
    ...spec.timing,
    load: () => {
      const files = [...(changed.size ? changed : spec.files)].join(', ');
      changed = new Set();
      current = { files, notes: [] };
      return spec.load((msg) => current.notes.push(msg));
    },
    // apply MUST stay synchronous (atomic against an in-flight decision).
    apply: spec.apply,
    onReloaded: (value) => {
      const detail: Record<string, unknown> = {
        file: current.files,
        ...spec.appliedDetail(value, current.notes),
      };
      void spec.audit.record({ action: spec.reloaded, detail });
      spec.log.info(
        `${spec.label}: reloaded ${current.files} (${String(detail['ruleCount'])} rule(s))`,
      );
    },
    onError: (err) => {
      const reason = reloadFailureReason(err);
      void spec.audit.record({
        action: spec.failed,
        detail: { file: current.files, reason },
      });
      spec.log.warn(
        `${spec.label}: reload of ${current.files} refused, keeping the previous ruleset (${reason})`,
      );
    },
  });

  return {
    trigger(file) {
      if (file === undefined) for (const f of spec.files) changed.add(f);
      else changed.add(file);
      reloader.trigger();
    },
    stop: () => reloader.stop(),
  };
}

const defaultLog: HotReloadLog = {
  // eslint-disable-next-line no-console
  info: (m) => console.log(m),
  // eslint-disable-next-line no-console
  warn: (m) => console.warn(m),
};

export interface PolicyHotReloadOptions {
  userPath: string;
  workspaceCwd: string | undefined;
  /** Swap the loaded policy in. MUST be synchronous. */
  apply: (policy: Policy) => void;
  audit: { record(entry: AuditEntry): Promise<void> };
  log?: HotReloadLog;
  timing?: Timing;
}

/** The files the policy reload reads, for naming them in an audit row. */
function policyFiles(
  userPath: string,
  workspaceCwd: string | undefined,
): string[] {
  return [
    userPath,
    ...(workspaceCwd ? [join(workspaceCwd, '.qwen', 'policy.yaml')] : []),
  ];
}

const IGNORING = /^\[policy\] workspace policy\.yaml: ignoring /;

/**
 * Hot reload of the layered policy. Runs {@link loadLayeredPolicy} in strict
 * mode, so a malformed or unreadable workspace file throws (and is refused)
 * instead of silently dropping the layer.
 */
export function createPolicyHotReload(opts: PolicyHotReloadOptions): HotReload {
  const log = opts.log ?? defaultLog;
  return createHotReload<Policy>({
    files: policyFiles(opts.userPath, opts.workspaceCwd),
    load: (note) =>
      loadLayeredPolicy(
        opts.userPath,
        opts.workspaceCwd,
        (msg) => {
          note(msg);
          log.warn(msg);
        },
        { strictWorkspace: true },
      ),
    apply: opts.apply,
    reloaded: 'policy_reloaded',
    failed: 'policy_reload_failed',
    appliedDetail: (policy, notes) => ({
      ruleCount: policy.rules.length,
      // Parts of the workspace file that exceeded its bounds and were dropped.
      ignored: notes.filter((n) => IGNORING.test(n)).length,
    }),
    label: 'policy',
    audit: opts.audit,
    log,
    timing: opts.timing,
  });
}
