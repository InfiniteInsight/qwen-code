/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import type {
  DaemonClient,
  CreateSessionRequest,
  DaemonSession,
  SubscribeOptions,
  DaemonEvent,
  PromptRequest,
  PromptResult,
  DaemonSessionContextStatus,
  PermissionResponse,
  DaemonSessionSupportedCommandsStatus,
  DaemonApprovalMode,
  DaemonApprovalModeResult,
  RestoreSessionRequest,
  DaemonRestoredSession,
  DaemonCapabilities,
  DaemonSessionSummary,
  DaemonToolCatalog,
  DaemonToolToggleResult,
  DaemonWorkspaceMcpInitializeResult,
  DaemonWorkspaceMcpStatus,
  DaemonWorkspaceTrustChangeRequest,
  DaemonWorkspaceTrustChangeResult,
  DaemonWorkspaceTrustStatus,
  DaemonWorkspaceTrustStatusResponse,
  DaemonWorkspaceTrustStatusV2,
} from '@qwen-code/sdk';
import {
  DaemonTransportClosedError,
  type DaemonRewindResult,
  type DaemonRewindSnapshotInfo,
  type DaemonPermissionRuleType,
  type DaemonPermissionScope,
  type DaemonSettingUpdateResult,
  type DaemonWorkspaceMcpReloadOptions,
  type DaemonWorkspacePermissionsStatus,
  type DaemonWorkspaceSettingsStatus,
} from '@qwen-code/sdk/daemon';
import type { AuditRecorder } from './auditLog.js';

/** Result of spawning a new daemon bound to a workspace. */
export interface PooledDaemonSpawn {
  client: DaemonClient;
  stop: () => Promise<void>;
  workspaceCwd: string;
  /** Fired exactly once when the daemon child process exits (any reason).
   * The pool fills this at spawn time (add-mid-turn-recovery: death
   * detection); the spawner wires the child's exit into it. */
  onExit?: (info: DaemonExitInfo) => void;
}

/** Exit info for a daemon death, as reported by the child's exit event. */
export interface DaemonExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * The session-routing surface of `DaemonClient` that the gateway's routes
 * actually call through `deps.daemon` — exactly the 24 methods, signatures
 * copied verbatim from `DaemonClient` (packages/sdk-typescript/src/daemon/
 * DaemonClient.ts) so a real `DaemonClient` structurally satisfies this
 * interface with zero changes. `DaemonPool` is the other implementation: a
 * drop-in that routes each call to the pooled daemon owning the session (or
 * workspace) instead of a single daemon connection. Both are accepted
 * wherever the gateway holds `GatewayDeps.daemon`.
 */
export interface SessionDaemon {
  prompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    clientId?: string,
  ): Promise<PromptResult>;
  capabilities(): Promise<DaemonCapabilities>;
  closeSession(sessionId: string, clientId?: string): Promise<void>;
  subscribeEvents(
    sessionId: string,
    opts?: SubscribeOptions,
  ): AsyncGenerator<DaemonEvent>;
  respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
    clientId?: string,
  ): Promise<boolean>;
  health(): Promise<{ status: string }>;
  createOrAttachSession(
    req: CreateSessionRequest,
    clientId?: string,
  ): Promise<DaemonSession>;
  sessionSupportedCommands(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionSupportedCommandsStatus>;
  rewindSession(
    sessionId: string,
    promptId: string,
    opts?: { clientId?: string; rewindFiles?: boolean },
  ): Promise<DaemonRewindResult>;
  getRewindSnapshots(
    sessionId: string,
  ): Promise<{ snapshots: DaemonRewindSnapshotInfo[] }>;
  listWorkspaceSessions(workspaceCwd: string): Promise<DaemonSessionSummary[]>;
  setSessionApprovalMode(
    sessionId: string,
    mode: DaemonApprovalMode,
    opts?: { persist?: boolean; clientId?: string },
  ): Promise<DaemonApprovalModeResult>;
  sessionContext(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionContextStatus>;
  loadSession(
    sessionId: string,
    req?: RestoreSessionRequest,
    clientId?: string,
  ): Promise<DaemonRestoredSession>;
  resumeSession(
    sessionId: string,
    req: { workspaceCwd: string },
  ): Promise<DaemonRestoredSession>;

  // -- Workspace control (rc-workspace-permissions) --------------------
  // Daemon-global methods: no session id, but workspace-scoped — each takes
  // an optional trailing `workspaceCwd` (rc-workspace-scoping, #28) naming
  // the workspace to act on; omitted/empty/the default workspace's cwd
  // targets the default/boot daemon. A `DaemonClient`'s own workspace
  // methods ignore the extra argument (they have no trailing parameter,
  // which is structurally fine), so a real `DaemonClient` still satisfies
  // this interface. Signatures otherwise copied verbatim from `DaemonClient`.

  workspacePermissions(
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspacePermissionsStatus>;
  setWorkspacePermissionRules(
    scope: DaemonPermissionScope,
    ruleType: DaemonPermissionRuleType,
    rules: readonly string[],
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspacePermissionsStatus>;
  workspaceTrust(
    opts?: {
      clientId?: string;
      statusVersion?: 1;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatus>;
  workspaceTrust(
    opts: {
      clientId?: string;
      statusVersion: 2;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatus | DaemonWorkspaceTrustStatusV2>;
  workspaceTrust(
    opts?: {
      clientId?: string;
      statusVersion?: 1 | 2;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatusResponse>;
  requestWorkspaceTrustChange(
    request: DaemonWorkspaceTrustChangeRequest,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustChangeResult>;
  workspaceSettings(
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceSettingsStatus>;
  setWorkspaceSetting(
    scope: 'workspace' | 'user',
    key: string,
    value: unknown,
    opts?: {
      clientId?: string;
      mcpServerMutation?: { operation: 'set' | 'remove'; name: string };
    },
    workspaceCwd?: string,
  ): Promise<DaemonSettingUpdateResult>;
  workspaceToolsCatalog(workspaceCwd?: string): Promise<DaemonToolCatalog>;
  setWorkspaceToolEnabled(
    toolName: string,
    enabled: boolean,
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonToolToggleResult>;
  workspaceMcp(workspaceCwd?: string): Promise<DaemonWorkspaceMcpStatus>;
  reloadWorkspaceMcp(
    options?: DaemonWorkspaceMcpReloadOptions,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceMcpInitializeResult>;

  /** The session's recovery state (add-mid-turn-recovery §3). Optional — a
   * plain `DaemonClient` has no recovery behind it, so the events route
   * treats a missing implementation as `'idle'`. */
  recoveryState?(sessionId: string): RecoveryState;
  /** Live pooled workspace cwds, excl. the default (rc-workspace-scoping,
   * #28). Optional — a plain `DaemonClient` has no pool behind it, so the
   * workspace listing route treats a missing implementation as `[]`. */
  workspaces?(): string[];
}

export interface DaemonPoolOptions {
  /** The boot daemon, already running, used when a create omits cwd. */
  defaultDaemon: DaemonClient;
  defaultWorkspaceCwd: string;
  /** Spawn a NEW daemon bound to `cwd`; returns once it is reachable. */
  spawn: (cwd: string) => Promise<PooledDaemonSpawn>;
  maxDaemons?: number; // default 3
  idleReapMs?: number; // default 15*60_000
  now?: () => number; // injectable clock (default Date.now)
  /** Invoked with the affected session ids when a daemon dies
   * (add-mid-turn-recovery). Absent → the sessions are simply dropped
   * (404s, as today); the `daemon_died` audit row is still written. The
   * recovery orchestrator plugs in here. */
  onDaemonDeath?: (
    workspaceKey: string,
    sessions: string[],
    exit: DaemonExitInfo & { atMs: number },
  ) => void;
}

interface Entry {
  client: DaemonClient;
  stop: () => Promise<void>;
  sessions: Set<string>;
  lastUsed: number;
  /** Set by `markDead`; a second trigger (exit event + transport error
   * racing) is a no-op. */
  dead: boolean;
  /** Captured by `markDead` for the death audit/hook. */
  exit?: DaemonExitInfo & { atMs: number };
}

const DEFAULT_MAX_DAEMONS = 3;
const DEFAULT_IDLE_REAP_MS = 15 * 60_000;

/** Thrown when a session id isn't owned by any known daemon (unrecorded, or
 * its owning daemon was already reaped). Routes map this to a `404
 * session_not_found`. */
export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unknown session: ${sessionId}`);
    this.name = 'UnknownSessionError';
  }
}

/** Thrown when `getOrSpawn` needs to spawn a daemon for a new workspace but
 * the pool is at `maxDaemons` and every entry is busy (no idle victim to
 * evict). Routes map this to a `503 workspace_pool_full`. */
export class WorkspacePoolFullError extends Error {
  constructor(readonly maxDaemons: number) {
    super(`Workspace daemon pool is full (max ${maxDaemons})`);
    this.name = 'WorkspacePoolFullError';
  }
}

/** Per-session recovery state after its owning daemon died (add-mid-turn-
 * recovery §2/§3). `'recovering'` — a recovery saga is in flight for this
 * session (the events route holds the connection); `'recovered'` /
 * `'unrecoverable'` — the saga finished and the outcome cache keeps the
 * branch sticky for late reconnects; `'idle'` — no recovery involved (the
 * default when no orchestrator is wired). */
export type RecoveryState =
  | 'recovering'
  | 'recovered'
  | 'unrecoverable'
  | 'idle';

/** Backing for {@link DaemonPool.recoveryState} — implemented by the
 * recovery orchestrator, which owns the lock map + outcome cache (the pool
 * cannot keep the session→state map itself: `markDead` scrubs the affected
 * ids from `ownerOf`). Absent (never wired) → every session reports
 * `'idle'`. */
export interface RecoveryStateProvider {
  recoveryState(sessionId: string): RecoveryState;
  /** The pool reports the session live again (created/resumed), clearing
   * any stale outcome so the events route attaches normally. */
  sessionLive?(sessionId: string): void;
}

/**
 * Pool of `qwen serve` daemons, one per project workspace, plus the
 * always-on default daemon. Spawns/reuses a daemon per workspace cwd,
 * routes session-id-keyed calls to the daemon that owns the session, reaps
 * idle workspace daemons, and enforces a cap on concurrently running
 * workspace daemons (evicting the LRU idle one, or refusing when all are
 * busy).
 *
 * This is a drop-in for the session-routing surface of `DaemonClient` —
 * routes can hold a `DaemonPool` wherever they previously held a single
 * `DaemonClient`.
 */
export class DaemonPool implements SessionDaemon {
  private readonly byWorkspace = new Map<string, Entry>();
  private readonly spawning = new Map<string, Promise<DaemonClient>>();
  /** sessionId -> owning workspace key (`defaultWorkspaceCwd` for sessions
   * created on the default daemon). */
  private readonly ownerOf = new Map<string, string>();
  /**
   * Count of in-flight `createOrAttachSession` calls per workspace key
   * (never touched for the default workspace). Marked SYNCHRONOUSLY at
   * the very start of `createOrAttachSession`, before any `await` —
   * including before `getOrSpawn`, whose own first `await` already yields
   * a microtask even when its body resolves synchronously (an existing
   * entry's fast path). An entry can look idle (`sessions.size === 0`)
   * for the entire duration of a create's network round-trip; without
   * marking the key pending up front, a concurrent `getOrSpawn`'s cap
   * eviction could reclaim the entry mid-registration — stopping the
   * daemon while this call still returns what looks like a successful
   * `DaemonSession` whose backend is already dead.
   */
  private readonly pendingCreates = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxDaemons: number;
  private readonly idleReapMs: number;
  private readonly reapTimer: ReturnType<typeof setInterval>;
  /** The normalized (see `normalizeCwd`) default workspace cwd — computed
   * once so every `isDefault`/key comparison compares like-for-like. */
  private readonly defaultWorkspaceCwd: string;
  /** Set at the top of `stopAll`; a spawn that resolves after shutdown must
   * not register itself into the (already-cleared) pool. */
  private stopped = false;
  /** Audit sink for `daemon_died` rows (add-mid-turn-recovery), injected
   * post-construction by cli.ts once the gateway app has built it. */
  private audit: AuditRecorder | undefined;
  /** Recovery-state backing (add-mid-turn-recovery), injected post-
   * construction — the orchestrator depends on this pool, so it cannot be
   * passed in the options. Absent → `recoveryState` reports `'idle'`. */
  private recoveryProvider: RecoveryStateProvider | undefined;
  /** Boot-daemon death idempotency flag — the default daemon has no Entry
   * to carry the `dead` flag, so its double-trigger guard lives here. */
  private defaultDead = false;

  /** Wire the audit recorder in (add-mid-turn-recovery: `daemon_died`
   * rows). Called by cli.ts after the gateway app is constructed. */
  setAudit(recorder: AuditRecorder): void {
    this.audit = recorder;
  }

  /** Wire the recovery-state backing (add-mid-turn-recovery). Called by the
   * host after the orchestrator exists (it depends on this pool). Absent →
   * `recoveryState` reports `'idle'` for every session. */
  setRecoveryProvider(provider: RecoveryStateProvider | undefined): void {
    this.recoveryProvider = provider;
  }

  /** Wire the recovery orchestrator's death hook (add-mid-turn-recovery).
   * Called by cli.ts after the orchestrator exists (it depends on this
   * pool). Absent → dead sessions are simply dropped (404s, as today);
   * the `daemon_died` audit row is still written. */
  setOnDaemonDeath(hook: DaemonPoolOptions['onDaemonDeath']): void {
    this.opts.onDaemonDeath = hook;
  }

  constructor(private readonly opts: DaemonPoolOptions) {
    this.now = opts.now ?? Date.now;
    this.maxDaemons = opts.maxDaemons ?? DEFAULT_MAX_DAEMONS;
    this.idleReapMs = opts.idleReapMs ?? DEFAULT_IDLE_REAP_MS;
    this.defaultWorkspaceCwd = this.normalizeCwd(opts.defaultWorkspaceCwd);
    this.reapTimer = setInterval(() => this.reapIdle(), this.idleReapMs / 3);
    this.reapTimer.unref?.();
  }

  /** Canonicalize a workspace cwd into the pool's KEY form: `path.resolve`
   * collapses `.`, `//`, and trailing slashes while keeping it absolute, so
   * `/proj/a` and `/proj/a/` (or `/home/evan` and `/home/evan/`) always map
   * to the exact same `byWorkspace` entry / `isDefault` comparand instead of
   * spawning a duplicate daemon (or a stray non-default daemon bound to what
   * is actually the boot workspace). */
  private normalizeCwd(cwd: string): string {
    return resolve(cwd);
  }

  private isDefault(cwd?: string) {
    return !cwd || this.normalizeCwd(cwd) === this.defaultWorkspaceCwd;
  }

  /** Reachable daemon for `cwd` (spawn if new). Empty/undefined → default. */
  async getOrSpawn(cwd?: string): Promise<DaemonClient> {
    if (this.isDefault(cwd)) return this.opts.defaultDaemon;
    const key = this.normalizeCwd(cwd!);
    const existing = this.byWorkspace.get(key);
    if (existing) {
      existing.lastUsed = this.now();
      return existing.client;
    }
    const inflight = this.spawning.get(key);
    if (inflight) return inflight;

    // Count LIVE entries and IN-FLIGHT spawns together: a new entry only
    // lands in `byWorkspace` once `spawn()` resolves, so counting
    // `byWorkspace.size` alone lets N concurrent creates for N distinct new
    // cwds all pass the check and all spawn, blowing past `maxDaemons`. At
    // this point `key` is guaranteed absent from both maps (the `existing`/
    // `inflight` checks above already returned), so this count never needs
    // to exclude it.
    const pooledCount = () => this.byWorkspace.size + this.spawning.size;
    if (pooledCount() >= this.maxDaemons) {
      this.reapIdle();
      if (pooledCount() >= this.maxDaemons) {
        this.evictLruIdle();
      }
    }

    const p = (async () => {
      try {
        const s = await this.opts.spawn(key);
        if (this.stopped) {
          // `stopAll()` ran while this spawn was in flight — the pool's
          // maps are already cleared and the gateway is shutting down.
          // Registering this entry now would leak a daemon (children are
          // spawned `detached`) that nothing will ever stop again.
          await s.stop().catch(() => {});
          return s.client;
        }
        const entry: Entry = {
          client: s.client,
          stop: s.stop,
          sessions: new Set(),
          lastUsed: this.now(),
          dead: false,
        };
        // Identity-guarded exit wiring (see `markDead`'s `expectedEntry`):
        // the callback captures THIS entry so a stale exit of a superseded
        // entry (same key re-spawned after a death) can't kill the new one.
        // Setting it synchronously before `byWorkspace.set` is race-free —
        // the spawner's `whenExited` settles on a later 'exit' event, never
        // in this microtask.
        s.onExit = (info) => this.markDead(key, info, entry);
        this.byWorkspace.set(key, entry);
        return s.client;
      } finally {
        // Runs on both success AND rejection — a failed spawn must not
        // leave a stuck entry in `spawning` that poisons this cwd forever;
        // the next getOrSpawn(cwd) needs to be able to retry.
        this.spawning.delete(key);
      }
    })();
    this.spawning.set(key, p);
    return p;
  }

  /** An entry is idle only when it has no live sessions AND no in-flight
   * `createOrAttachSession` registering a new one on `key` — both
   * `reapIdle` and `evictLruIdle` must agree on this so a mid-create entry
   * is never reclaimed out from under its caller. */
  private isIdle(key: string, entry: Entry): boolean {
    return entry.sessions.size === 0 && !this.pendingCreates.has(key);
  }

  /** Stop the daemon, drop its entry, and scrub any of its session ids out
   * of `ownerOf` (defensive — under the current invariants an idle entry's
   * `sessions` set is already empty, but this keeps `ownerOf` from ever
   * accumulating a stale mapping if that invariant is ever violated). */
  private discardEntry(key: string, entry: Entry): void {
    for (const id of entry.sessions) {
      this.ownerOf.delete(id);
    }
    entry.stop().catch(() => {});
    this.byWorkspace.delete(key);
  }

  /** Evict the least-recently-used IDLE workspace entry to make room under
   * the cap. Throws `WorkspacePoolFullError` if every entry currently has
   * live sessions or an in-flight registration. */
  private evictLruIdle(): void {
    let lruKey: string | undefined;
    let lruEntry: Entry | undefined;
    for (const [key, entry] of this.byWorkspace) {
      if (this.isIdle(key, entry)) {
        if (!lruEntry || entry.lastUsed < lruEntry.lastUsed) {
          lruKey = key;
          lruEntry = entry;
        }
      }
    }
    if (!lruKey || !lruEntry) {
      throw new WorkspacePoolFullError(this.maxDaemons);
    }
    this.discardEntry(lruKey, lruEntry);
  }

  /** Reap every non-default entry that is idle (see `isIdle`) and has been
   * idle longer than `idleReapMs`. Safe to call directly (tests inject a
   * clock via `now`); also driven from a background timer. */
  reapIdle(): void {
    const cutoff = this.now();
    for (const [key, entry] of this.byWorkspace) {
      if (
        this.isIdle(key, entry) &&
        cutoff - entry.lastUsed > this.idleReapMs
      ) {
        this.discardEntry(key, entry);
      }
    }
  }

  // -- Death detection (add-mid-turn-recovery) -------------------------

  /**
   * Report the exit of the boot (default) daemon by workspace cwd. The pool
   * never pools the default daemon, so its death arrives here rather than
   * through a pooled entry's `onExit`. Normalizes `workspaceCwd` so the
   * caller can pass the raw configured value.
   */
  handleDaemonExit(workspaceCwd: string, info: DaemonExitInfo): void {
    this.markDead(this.normalizeCwd(workspaceCwd), info);
  }

  /**
   * Mark the daemon for `key` dead — idempotent (a second trigger, e.g. the
   * exit event and a transport error racing, is a no-op):
   *
   * - removes the pooled entry IMMEDIATELY (frees the `maxDaemons` slot
   *   for the recovery respawn; the zombie can no longer wedge the cap),
   * - collects the affected session ids — `entry.sessions` ∪ the
   *   `ownerOf` entries mapping to `key` (the union guards against an id
   *   recorded in one structure but not the other),
   * - scrubs them from `ownerOf` (they 404 until recovery re-registers
   *   them via `resumeSession`),
   * - writes ONE `daemon_died` audit row — detail
   *   `{ exitCode, signal, sessionCount }`, no workspace path (the
   *   session-create/resume audit rule),
   * - hands the affected list to `opts.onDaemonDeath` (the recovery
   *   orchestrator; absent → the sessions are simply dropped, 404s as
   *   today — the audit row is still written).
   *
   * `expectedEntry` (set by the pool's own exit wiring in `getOrSpawn`)
   * guards against a STALE exit: if the same key was re-spawned after a
   * death, the old entry's exit event must not kill the new entry.
   */
  private markDead(
    key: string,
    info: DaemonExitInfo,
    expectedEntry?: Entry,
  ): void {
    if (this.stopped) return; // shutdown: no audit, no hook
    const entry = this.byWorkspace.get(key);
    let exit: DaemonExitInfo & { atMs: number };
    if (entry === undefined) {
      // The default daemon is never pooled: its death arrives via
      // `handleDaemonExit` (or a transport error on a default-routed call).
      // A NON-default key with no entry is a late exit of an entry already
      // reaped/evicted/stopped — no audit, no hook.
      if (key !== this.defaultWorkspaceCwd) return;
      if (this.defaultDead) return;
      this.defaultDead = true;
      exit = { code: info.code, signal: info.signal, atMs: this.now() };
    } else {
      if (entry.dead) return;
      if (expectedEntry !== undefined && entry !== expectedEntry) return;
      entry.dead = true;
      exit = { code: info.code, signal: info.signal, atMs: this.now() };
      entry.exit = exit;
      this.byWorkspace.delete(key);
    }
    const affected = new Set<string>(entry ? entry.sessions : []);
    for (const [sid, k] of this.ownerOf) {
      if (k === key) affected.add(sid);
    }
    for (const sid of affected) this.ownerOf.delete(sid);
    this.audit
      ?.record({
        action: 'daemon_died',
        detail: {
          exitCode: exit.code,
          signal: exit.signal,
          sessionCount: affected.size,
        },
      })
      .catch(() => {});
    this.opts.onDaemonDeath?.(key, [...affected], exit);
  }

  /** Transport trigger for a session-keyed call that threw: if it was a
   * transport-level death error, the owning daemon is dead (covers races
   * where the exit handler has not fired yet). */
  private noteTransportDeath(sessionId: string, err: unknown): void {
    const key = this.ownerOf.get(sessionId);
    if (key !== undefined) this.noteTransportDeathByKey(key, err);
  }

  /** Transport trigger for a workspace-keyed call (create/resume/default
   * routes) — same check, key supplied directly. */
  private noteTransportDeathByKey(key: string, err: unknown): void {
    if (isTransportDeathError(err)) {
      // Transport errors carry no exit info; if the exit trigger fires
      // later it is a no-op on this same death.
      this.markDead(key, { code: null, signal: null });
    }
  }

  /** Run a session-keyed pool call, marking the owning workspace dead on a
   * transport-level error (then rethrow; routes keep their 502 mapping).
   * The client resolves OUTSIDE the try so an `UnknownSessionError` (the
   * 404 mapping) never touches the death trigger. */
  private async withSessionDeathTrigger<T>(
    sessionId: string,
    call: (client: DaemonClient) => Promise<T>,
  ): Promise<T> {
    const client = this.daemonForSession(sessionId);
    try {
      return await call(client);
    } catch (err) {
      this.noteTransportDeath(sessionId, err);
      throw err;
    }
  }

  /** Run a default-daemon call, marking the boot workspace dead on a
   * transport-level error (then rethrow). */
  private async withDefaultDeathTrigger<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      this.noteTransportDeathByKey(this.defaultWorkspaceCwd, err);
      throw err;
    }
  }

  /** Run a workspace-scoped pool call (rc-workspace-scoping, #28) against
   * the target workspace's daemon — the default/boot daemon when
   * `workspaceCwd` is omitted/empty/normalizes to the default workspace,
   * otherwise the pooled daemon for that cwd (spawned on demand via
   * `getOrSpawn`, exactly like session creation — a controllable workspace
   * does not need a live session). Marks that workspace dead on a
   * transport-level error (then rethrow; routes keep their 502 mapping) —
   * for the default target this is byte-for-byte the
   * `withDefaultDeathTrigger` behavior. A `WorkspacePoolFullError` from
   * `getOrSpawn` is not a transport death: it propagates untouched for the
   * route's 503 mapping. */
  private async withWorkspaceDeathTrigger<T>(
    workspaceCwd: string | undefined,
    call: (client: DaemonClient) => Promise<T>,
  ): Promise<T> {
    const key = this.isDefault(workspaceCwd)
      ? this.defaultWorkspaceCwd
      : this.normalizeCwd(workspaceCwd!);
    try {
      const client = await this.getOrSpawn(workspaceCwd);
      return await call(client);
    } catch (err) {
      this.noteTransportDeathByKey(key, err);
      throw err;
    }
  }

  // -- Session routing ------------------------------------------------

  /** The session's recovery state (add-mid-turn-recovery §3): delegated to
   * the wired orchestrator, `'idle'` when none is wired. */
  recoveryState(sessionId: string): RecoveryState {
    return this.recoveryProvider?.recoveryState(sessionId) ?? 'idle';
  }

  /** Resolve the owning daemon for a session id. Bumps the entry's
   * `lastUsed` (a live-referenced session never looks idle). Throws
   * `UnknownSessionError` for an unrecorded id, or one whose owning
   * daemon has since been reaped. */
  private daemonForSession(id: string): DaemonClient {
    const key = this.ownerOf.get(id);
    if (key === undefined) throw new UnknownSessionError(id);
    if (key === this.defaultWorkspaceCwd) return this.opts.defaultDaemon;
    const e = this.byWorkspace.get(key);
    if (!e) throw new UnknownSessionError(id); // daemon was reaped
    e.lastUsed = this.now();
    return e.client;
  }

  private removeSession(id: string): void {
    const key = this.ownerOf.get(id);
    if (key === undefined) return;
    this.ownerOf.delete(id);
    if (key === this.defaultWorkspaceCwd) return; // never reaped
    const entry = this.byWorkspace.get(key);
    if (!entry) return;
    entry.sessions.delete(id);
    if (entry.sessions.size === 0) {
      entry.lastUsed = this.now();
    }
  }

  /** Resolve (spawn if needed) the daemon for `req.workspaceCwd`, create or
   * attach the session there, and record which daemon owns the returned
   * session id so later session-keyed calls route correctly.
   *
   * `key` is marked pending in `pendingCreates` SYNCHRONOUSLY, before the
   * `getOrSpawn` await — not after it resolves. Even when `getOrSpawn`
   * resolves an already-spawned entry (no internal await needed), `await
   * this.getOrSpawn(...)` still defers the rest of this function to a
   * later microtask; marking pending only after that await would leave a
   * window where a concurrent `getOrSpawn`'s cap eviction can see this
   * entry as idle (`sessions.size === 0`) and reclaim it mid-registration
   * — stopping the daemon while this call still returns what looks like a
   * successful `DaemonSession`. */
  async createOrAttachSession(
    req: CreateSessionRequest,
    clientId?: string,
  ): Promise<DaemonSession> {
    const key = this.isDefault(req.workspaceCwd)
      ? this.defaultWorkspaceCwd
      : this.normalizeCwd(req.workspaceCwd!);
    const tracksPending = key !== this.defaultWorkspaceCwd;
    if (tracksPending) {
      this.pendingCreates.set(key, (this.pendingCreates.get(key) ?? 0) + 1);
    }
    try {
      const client = await this.getOrSpawn(req.workspaceCwd);
      const session = await client.createOrAttachSession(req, clientId);
      this.ownerOf.set(session.sessionId, key);
      this.byWorkspace.get(key)?.sessions.add(session.sessionId);
      // The session is live again (add-mid-turn-recovery): clear any stale
      // recovery outcome so the events route attaches normally.
      this.recoveryProvider?.sessionLive?.(session.sessionId);
      return session;
    } catch (err) {
      this.noteTransportDeathByKey(key, err);
      throw err;
    } finally {
      if (tracksPending) {
        const n = (this.pendingCreates.get(key) ?? 1) - 1;
        if (n <= 0) this.pendingCreates.delete(key);
        else this.pendingCreates.set(key, n);
      }
    }
  }

  /** Resolve (spawn if needed) the daemon for `req.workspaceCwd`, restore the
   * session there, and record which daemon owns `sessionId` so later
   * session-keyed calls route correctly. Unlike `createOrAttachSession`, the
   * daemon does not mint a new id on restore -- it reuses `sessionId` as
   * passed in, so that's what gets recorded in `ownerOf`, not anything read
   * off the response.
   *
   * Restores via the SDK's `loadSession`, not `resumeSession`: ACP's
   * `session/resume` reactivates a session WITHOUT replaying its transcript,
   * so a cold-restored session has no history anywhere except the daemon's
   * `load` action's response (no-history bug, #37). Since upstream
   * `e23c8e845` that action returns the transcript in-band
   * (`compactedReplay` + `liveJournal`, `lastEventId` watermark) and CLEARS
   * the event bus ring after seeding it -- a cursor-0 SSE watch replays
   * nothing. Callers therefore render the in-band frames and start their
   * watch at `lastEventId` (the resume route forwards all of it; #39).
   * Warm/live sessions are unaffected -- both actions merely attach.
   *
   * Workspace-keyed (like `createOrAttachSession`): a resumed session's
   * owning workspace was never in memory here (this pool didn't create it),
   * so the caller must supply it. Mirrors `createOrAttachSession`'s
   * `pendingCreates` reservation exactly -- marked SYNCHRONOUSLY, before the
   * `getOrSpawn` await -- for the same reason: without it, a concurrent
   * `getOrSpawn`'s cap eviction could reclaim this entry mid-registration. */
  async resumeSession(
    sessionId: string,
    req: { workspaceCwd: string },
  ): Promise<DaemonRestoredSession> {
    const key = this.isDefault(req.workspaceCwd)
      ? this.defaultWorkspaceCwd
      : this.normalizeCwd(req.workspaceCwd);
    const tracksPending = key !== this.defaultWorkspaceCwd;
    if (tracksPending) {
      this.pendingCreates.set(key, (this.pendingCreates.get(key) ?? 0) + 1);
    }
    try {
      const client = await this.getOrSpawn(req.workspaceCwd);
      // `load`, not `resume`: see the doc above -- the history travels in the
      // load response (in-band frames + lastEventId), not the bus ring.
      const restored = await client.loadSession(sessionId, {
        workspaceCwd: key,
      });
      this.ownerOf.set(sessionId, key);
      this.byWorkspace.get(key)?.sessions.add(sessionId);
      // The session is live again (add-mid-turn-recovery): clear any stale
      // recovery outcome so the events route attaches normally.
      this.recoveryProvider?.sessionLive?.(sessionId);
      return restored;
    } catch (err) {
      this.noteTransportDeathByKey(key, err);
      throw err;
    } finally {
      if (tracksPending) {
        const n = (this.pendingCreates.get(key) ?? 1) - 1;
        if (n <= 0) this.pendingCreates.delete(key);
        else this.pendingCreates.set(key, n);
      }
    }
  }

  /**
   * `session_died` and `session_closed` are the SDK's own definition of a
   * session-lifecycle terminal — see `isSessionLifecycleTerminal` in
   * `@qwen-code/sdk`'s `daemon/events.ts` (`type === 'session_died' ||
   * type === 'session_closed'`) — so both reliably mean the daemon session
   * itself ended; pruning on them lets the entry become reapable.
   *
   * `client_evicted` is deliberately NOT included here, despite also being
   * a stream-terminal frame. `daemon/events.ts`'s own doc on
   * `DaemonSessionViewState.alive` says plainly: "For client_evicted and
   * stream_error this only describes the current stream, not the remote
   * daemon session's lifetime." Pruning on it would be actively wrong: a
   * slow SSE consumer can get evicted from ITS OWN stream while the
   * session is still alive on the daemon (and possibly still attached to
   * OTHER clients); treating that as session-terminal would drop the id
   * from tracking and let `reapIdle`/`evictLruIdle` reclaim (and `stop()`)
   * a daemon that is still serving a live session out from under those
   * other clients — worse than the wedge this pruning exists to prevent.
   */
  async *subscribeEvents(
    sessionId: string,
    opts: SubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent> {
    const client = this.daemonForSession(sessionId);
    try {
      for await (const event of client.subscribeEvents(sessionId, opts)) {
        if (event.type === 'session_died' || event.type === 'session_closed') {
          this.removeSession(sessionId);
        }
        yield event;
      }
    } catch (err) {
      this.noteTransportDeath(sessionId, err);
      throw err;
    }
  }

  async prompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    clientId?: string,
  ): Promise<PromptResult> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.prompt(sessionId, req, signal, clientId),
    );
  }

  async sessionContext(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionContextStatus> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionContext(sessionId, clientId),
    );
  }

  async respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
    clientId?: string,
  ): Promise<boolean> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.respondToSessionPermission(
        sessionId,
        requestId,
        response,
        clientId,
      ),
    );
  }

  async closeSession(sessionId: string, clientId?: string): Promise<void> {
    await this.withSessionDeathTrigger(sessionId, (client) =>
      client.closeSession(sessionId, clientId),
    );
    this.removeSession(sessionId);
  }

  async rewindSession(
    sessionId: string,
    promptId: string,
    opts?: { clientId?: string; rewindFiles?: boolean },
  ): Promise<DaemonRewindResult> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.rewindSession(sessionId, promptId, opts),
    );
  }

  async getRewindSnapshots(
    sessionId: string,
  ): Promise<{ snapshots: DaemonRewindSnapshotInfo[] }> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.getRewindSnapshots(sessionId),
    );
  }

  async sessionSupportedCommands(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionSupportedCommandsStatus> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionSupportedCommands(sessionId, clientId),
    );
  }

  async setSessionApprovalMode(
    sessionId: string,
    mode: DaemonApprovalMode,
    opts?: { persist?: boolean; clientId?: string },
  ): Promise<DaemonApprovalModeResult> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.setSessionApprovalMode(sessionId, mode, opts),
    );
  }

  async loadSession(
    sessionId: string,
    req: RestoreSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonRestoredSession> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.loadSession(sessionId, req, clientId),
    );
  }

  // -- Daemon-global (default daemon) ----------------------------------

  health(): Promise<{ status: string }> {
    return this.withDefaultDeathTrigger(() => this.opts.defaultDaemon.health());
  }

  capabilities(): Promise<DaemonCapabilities> {
    return this.withDefaultDeathTrigger(() =>
      this.opts.defaultDaemon.capabilities(),
    );
  }

  listWorkspaceSessions(workspaceCwd: string): Promise<DaemonSessionSummary[]> {
    return this.withDefaultDeathTrigger(() =>
      this.opts.defaultDaemon.listWorkspaceSessions(workspaceCwd),
    );
  }

  // -- Workspace control (rc-workspace-permissions, scoped per #28) -----
  // Each takes an optional trailing `workspaceCwd` and resolves the target
  // through the pool (default/boot daemon when omitted or the default
  // workspace; spawn-on-demand otherwise) with the same transport-death
  // fallback as session-keyed calls.

  workspacePermissions(
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspacePermissionsStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspacePermissions(opts),
    );
  }

  setWorkspacePermissionRules(
    scope: DaemonPermissionScope,
    ruleType: DaemonPermissionRuleType,
    rules: readonly string[],
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspacePermissionsStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.setWorkspacePermissionRules(scope, ruleType, rules, opts),
    );
  }

  workspaceTrust(
    opts?: {
      clientId?: string;
      statusVersion?: 1;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatus>;
  workspaceTrust(
    opts: {
      clientId?: string;
      statusVersion: 2;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatus | DaemonWorkspaceTrustStatusV2>;
  workspaceTrust(
    opts?: {
      clientId?: string;
      statusVersion?: 1 | 2;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatusResponse> {
    // Dispatch by statusVersion so the inner call matches one of the
    // DaemonClient overloads (the union-typed opts matches neither). The
    // consts keep the narrowing intact across the closure boundary.
    const statusVersion = opts?.statusVersion ?? 1;
    const clientId = opts?.clientId;
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      statusVersion === 2
        ? client.workspaceTrust({
            ...(clientId !== undefined ? { clientId } : {}),
            statusVersion: 2,
          })
        : client.workspaceTrust(
            clientId !== undefined ? { clientId } : undefined,
          ),
    );
  }

  requestWorkspaceTrustChange(
    request: DaemonWorkspaceTrustChangeRequest,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustChangeResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.requestWorkspaceTrustChange(request, clientId),
    );
  }

  workspaceSettings(
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceSettingsStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspaceSettings(opts),
    );
  }

  setWorkspaceSetting(
    scope: 'workspace' | 'user',
    key: string,
    value: unknown,
    opts?: {
      clientId?: string;
      mcpServerMutation?: { operation: 'set' | 'remove'; name: string };
    },
    workspaceCwd?: string,
  ): Promise<DaemonSettingUpdateResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.setWorkspaceSetting(scope, key, value, opts),
    );
  }

  workspaceToolsCatalog(workspaceCwd?: string): Promise<DaemonToolCatalog> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspaceToolsCatalog(),
    );
  }

  setWorkspaceToolEnabled(
    toolName: string,
    enabled: boolean,
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonToolToggleResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.setWorkspaceToolEnabled(toolName, enabled, opts),
    );
  }

  workspaceMcp(workspaceCwd?: string): Promise<DaemonWorkspaceMcpStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspaceMcp(),
    );
  }

  reloadWorkspaceMcp(
    options?: DaemonWorkspaceMcpReloadOptions,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceMcpInitializeResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.reloadWorkspaceMcp(options),
    );
  }

  /** Live pooled daemons (excl. default). */
  size() {
    return this.byWorkspace.size;
  }

  workspaces() {
    return [...this.byWorkspace.keys()];
  }

  /**
   * Stop the pool: cancel the background reaper and stop EVERY pooled
   * workspace daemon so none is orphaned when the gateway process exits.
   * The default/boot daemon is NOT touched here — its lifecycle belongs to
   * whoever constructed the pool (cli.ts stops it separately via its own
   * `handle.stop()`, alongside this call). Tolerates an individual entry's
   * `stop()` rejecting (`Promise.allSettled`) — one stuck daemon must not
   * block the others from being asked to stop. Intended for shutdown; not
   * safe to call mid-lifetime (any in-flight session routing is dropped).
   *
   * Sets `stopped` FIRST, synchronously, before anything else: a spawn that
   * was in flight when shutdown began resolves after this returns, and its
   * `getOrSpawn` closure checks this flag to avoid registering a fresh
   * entry into the (already-cleared) pool — which would otherwise leak a
   * detached daemon process that nothing will ever stop.
   */
  async stopAll(): Promise<void> {
    this.stopped = true;
    clearInterval(this.reapTimer);
    const entries = [...this.byWorkspace.values()];
    await Promise.allSettled(entries.map((e) => e.stop()));
    this.byWorkspace.clear();
    this.ownerOf.clear();
    this.pendingCreates.clear();
  }
}

// -- Transport-death classification (add-mid-turn-recovery) ------------

/** Socket codes (found anywhere in the `cause` chain) that mean the daemon
 * transport is gone — the process is dead or the socket was torn down. */
const TRANSPORT_DEATH_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

/** Node/undici socket-teardown messages (no stable `code` property). */
const TRANSPORT_DEATH_MESSAGE = /socket hang up|other side closed/i;

/** True when `err` is a transport-level "the daemon is gone" error: the
 * SDK's own stream-terminal error, a socket code anywhere in the `cause`
 * chain (`fetch` wraps the socket error under a `TypeError: fetch failed`),
 * or a socket-teardown message. Walks at most 8 `cause` hops. */
function isTransportDeathError(err: unknown): boolean {
  let cur: unknown = err;
  for (
    let depth = 0;
    cur !== null && typeof cur === 'object' && depth < 8;
    depth++
  ) {
    if (cur instanceof DaemonTransportClosedError) return true;
    if (cur instanceof Error) {
      // The name check covers an SDK loaded from a second copy of the
      // package, where `instanceof` would fail.
      if (cur.name === 'DaemonTransportClosedError') return true;
      if (TRANSPORT_DEATH_MESSAGE.test(cur.message)) return true;
    }
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSPORT_DEATH_CODES.has(code)) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
