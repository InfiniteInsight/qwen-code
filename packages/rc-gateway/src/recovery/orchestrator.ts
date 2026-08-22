/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mid-turn recovery orchestrator (add-mid-turn-recovery §2).
 *
 * When a workspace daemon dies, the pool's `onDaemonDeath` hook hands the
 * affected session ids to {@link RecoveryOrchestrator.recover}. The saga is
 * serialized per workspace: one in-flight recovery per workspace key; a
 * second death of the same workspace while the first recovery runs queues
 * behind it; further deaths coalesce into that queued run (the latest
 * `exit` info wins). The saga respawns the daemon (`pool.getOrSpawn`), then
 * resumes each affected session IN PLACE, sequentially
 * (`pool.resumeSession`), and reports one outcome per session through the
 * injected `reportOutcome` sink (Phase 3 supplies the marker/audit/notify
 * implementation; absent here, outcomes are only cached).
 *
 * Outcomes (design §2.3/§2.4):
 * - respawn failure → every affected session is unrecoverable; the saga
 *   ends.
 * - `404 session_not_found` on resume → that session is unrecoverable (its
 *   transcript is gone), no retry; the remaining sessions are still tried.
 * - any OTHER resume error → the just-respawned daemon is suspect: that
 *   session and every remaining one are unrecoverable; the saga ends.
 *
 * The interrupted turn is NEVER re-sent (no auto-replay).
 *
 * The orchestrator keeps its OWN sessionId→state map: `markDead` scrubs the
 * affected ids from the pool's `ownerOf`, so after a death the pool can no
 * longer map a session id back to its workspace key. The map plus the
 * outcome cache back the pool's `recoveryState(sessionId)` (this class
 * implements {@link RecoveryStateProvider}), which the events route uses to
 * hold or short-circuit recovery-pending attaches (§3).
 */

import { isSessionLevelNotFound } from '@qwen-code/sdk/daemon';

import type { AuditRecorder } from '../auditLog.js';
import type { DaemonExitInfo, RecoveryState } from '../daemonPool.js';
import type { OwnerEventBus } from '../ownerEvents.js';
import type { PromptQueue } from '../routes/promptQueue.js';
import { getSharedWal } from '../wal.js';
import type { WalFrame } from '../wal.js';
import type { PushNotifier } from '../webpush/notifier.js';

/** Per-session recovery outcome, reported exactly once per session per
 * death event, after the outcome is known. */
export interface SessionRecoveryOutcome {
  /** The session is live again on the respawned daemon. */
  recovered: boolean;
  /** A prompt was in flight for this session at the moment of death. */
  hadInFlightTurn: boolean;
  /** The dead daemon's exit code (`null` when killed by signal). */
  exitCode: number | null;
  /** Wall time (ms) from the start of this session's recovery to its
   * outcome. */
  tookMs: number;
}

/** The surface of the daemon pool the saga drives. `DaemonPool` satisfies
 * this structurally; tests stub it. */
export interface RecoveryPool {
  getOrSpawn(workspaceKey: string): Promise<unknown>;
  resumeSession(
    sessionId: string,
    req: { workspaceCwd: string },
  ): Promise<unknown>;
}

export interface RecoveryOrchestratorOptions {
  pool: RecoveryPool;
  /** `hadInFlightTurn` source — the prompt route holds the per-session slot
   * across the turn, so a held slot at the moment of death means a prompt
   * was in flight. */
  promptQueue: Pick<PromptQueue, 'isInFlight'>;
  /** One call per affected session, after the outcome is known. Phase 3
   * supplies the marker/audit/notify implementation. A throwing sink must
   * not break the saga. */
  reportOutcome?: (sessionId: string, outcome: SessionRecoveryOutcome) => void;
  /** Injectable clock (default `Date.now`). */
  now?: () => number;
}

interface PendingRun {
  /** Union of the session lists of all deaths coalesced into this run. */
  sessions: Set<string>;
  /** Latest death wins (design §2.1). */
  exit: DaemonExitInfo & { atMs: number };
  /** `recover()` callers coalesced into this run; resolved once the run
   * has settled every one of their sessions. */
  resolvers: Array<() => void>;
}

export class RecoveryOrchestrator {
  private readonly pool: RecoveryPool;
  private readonly promptQueue: Pick<PromptQueue, 'isInFlight'>;
  private readonly reportOutcome?: (
    sessionId: string,
    outcome: SessionRecoveryOutcome,
  ) => void;
  private readonly now: () => number;

  /** workspaceKey → in-flight saga. */
  private readonly running = new Map<string, Promise<void>>();
  /** workspaceKey → deaths queued behind the in-flight saga (coalesced). */
  private readonly pending = new Map<string, PendingRun>();
  /** sessionId → state. Survives the pool's `ownerOf` scrub on death. */
  private readonly state = new Map<string, RecoveryState>();
  /** sessionId → final outcome (design §3 outcome cache: a late reconnect
   * after the saga still gets the right branch instead of re-holding). */
  private readonly outcomes = new Map<string, SessionRecoveryOutcome>();

  constructor(options: RecoveryOrchestratorOptions) {
    this.pool = options.pool;
    this.promptQueue = options.promptQueue;
    this.reportOutcome = options.reportOutcome;
    this.now = options.now ?? Date.now;
  }

  /**
   * Run (or queue) the recovery saga for a dead workspace daemon.
   *
   * Returns a promise that settles once EVERY session passed in here has a
   * final outcome. When a saga is already running for the key, this call's
   * sessions and exit are coalesced into the queued follow-up run (latest
   * exit wins) and the returned promise settles with that run.
   */
  recover(
    workspaceKey: string,
    sessions: string[],
    exit: DaemonExitInfo & { atMs: number },
  ): Promise<void> {
    for (const id of sessions) this.markRecovering(id);
    const active = this.running.get(workspaceKey);
    if (active) {
      const queued =
        this.pending.get(workspaceKey) ??
        ({
          sessions: new Set<string>(),
          exit,
          resolvers: [],
        } satisfies PendingRun);
      for (const id of sessions) queued.sessions.add(id);
      queued.exit = exit; // latest death wins for the queued run
      this.pending.set(workspaceKey, queued);
      return new Promise<void>((resolve) => {
        queued.resolvers.push(resolve);
      });
    }
    const run = this.startSaga(workspaceKey, sessions, exit);
    this.running.set(workspaceKey, run);
    return run;
  }

  /** `RecoveryStateProvider` — the pool delegates `recoveryState` here.
   * Unknown session → `'idle'`. */
  recoveryState(sessionId: string): RecoveryState {
    return this.state.get(sessionId) ?? 'idle';
  }

  /** The pool reports the session live again (created/resumed out-of-band —
   * e.g. a manual `POST /session/:id/resume` after a failed recovery), so a
   * stale outcome stops short-circuiting the events route. */
  sessionLive(sessionId: string): void {
    this.state.set(sessionId, 'idle');
    this.outcomes.delete(sessionId);
  }

  /** Final outcome of the most recent saga for this session (the §3 outcome
   * cache; `undefined` when no saga has settled one yet). */
  lastOutcome(sessionId: string): SessionRecoveryOutcome | undefined {
    return this.outcomes.get(sessionId);
  }

  private markRecovering(sessionId: string): void {
    this.state.set(sessionId, 'recovering');
    this.outcomes.delete(sessionId);
  }

  private startSaga(
    workspaceKey: string,
    sessions: string[],
    exit: DaemonExitInfo & { atMs: number },
  ): Promise<void> {
    return this.runSaga(workspaceKey, sessions, exit).finally(() => {
      this.settlePending(workspaceKey);
    });
  }

  /** After a saga settles: start the coalesced queued run, if any. Runs as
   * a microtask after settlement, so a death arriving in that window still
   * sees the old run as active and coalesces into the pending bucket. */
  private settlePending(workspaceKey: string): void {
    this.running.delete(workspaceKey);
    const queued = this.pending.get(workspaceKey);
    if (!queued) return;
    this.pending.delete(workspaceKey);
    const { sessions, exit, resolvers } = queued;
    const run = (async () => {
      try {
        await this.runSaga(workspaceKey, [...sessions], exit);
      } finally {
        for (const resolve of resolvers) resolve();
        this.settlePending(workspaceKey);
      }
    })();
    this.running.set(workspaceKey, run);
  }

  private async runSaga(
    workspaceKey: string,
    sessions: string[],
    exit: DaemonExitInfo & { atMs: number },
  ): Promise<void> {
    const unique = [...new Set(sessions)];
    for (const id of unique) this.markRecovering(id);
    // Snapshot BEFORE respawn (design §2.2) — once the daemon is back, the
    // in-flight prompt has rejected and released its queue slot.
    const inFlight = new Map<string, boolean>();
    for (const id of unique) inFlight.set(id, this.promptQueue.isInFlight(id));

    const report = (
      sessionId: string,
      recovered: boolean,
      startedAt: number,
    ): void => {
      const outcome: SessionRecoveryOutcome = {
        recovered,
        hadInFlightTurn: inFlight.get(sessionId) ?? false,
        exitCode: exit.code,
        tookMs: Math.max(0, this.now() - startedAt),
      };
      this.state.set(sessionId, recovered ? 'recovered' : 'unrecoverable');
      this.outcomes.set(sessionId, outcome);
      try {
        this.reportOutcome?.(sessionId, outcome);
      } catch {
        // A failing sink must not break the saga — the other sessions still
        // get their outcomes.
      }
    };

    const sagaStart = this.now();
    try {
      await this.pool.getOrSpawn(workspaceKey);
    } catch {
      // Respawn failed (spawn error, cap race): every affected session is
      // unrecoverable; the saga ends.
      for (const id of unique) report(id, false, sagaStart);
      return;
    }

    for (let i = 0; i < unique.length; i++) {
      const id = unique[i];
      const startedAt = this.now();
      try {
        await this.pool.resumeSession(id, { workspaceCwd: workspaceKey });
        report(id, true, startedAt);
      } catch (err) {
        if (isSessionLevelNotFound(err)) {
          // The transcript is gone — unrecoverable, no retry; the other
          // sessions are still tried.
          report(id, false, startedAt);
        } else {
          // Any other error (502, timeout): the just-respawned daemon is
          // suspect. This session and every remaining one are
          // unrecoverable; the saga ends.
          report(id, false, startedAt);
          for (let j = i + 1; j < unique.length; j++) {
            report(unique[j], false, this.now());
          }
          return;
        }
      }
    }
  }
}

export interface ReportOutcomeOptions {
  /** When present, marker frames are appended to the session WAL (design
   * §4) and published on the owner stream with their real WAL ids. Absent
   * (the production wiring is WAL-dark today) → the audit rows and push
   * notifications still happen; there is simply no durable marker frame.
   * Must be the same dir the events relay uses, so marker ids interleave
   * gaplessly with relay ids through the shared WAL instance. */
  walDir?: string;
  ownerEvents?: OwnerEventBus;
  audit?: AuditRecorder;
  notifier?: PushNotifier;
}

/**
 * The `reportOutcome` sink (design §2.5/§4/§6), ready to inject into
 * {@link RecoveryOrchestratorOptions.reportOutcome}. Per session, exactly
 * once per death event, after the saga outcome is known:
 *
 * - append one `session_interrupted` WAL frame
 *   (`{ sessionId, recovered, hadInFlightTurn, exitCode? }`, id =
 *   `latestId() + 1` through the shared WAL) and publish it on the owner
 *   events stream as a `session_event`;
 * - audit `session_interrupted` (target = sessionId; `outcome` `ok` when
 *   recovered, `failed` otherwise; detail per §6);
 * - on success: append + publish `session_recovered`
 *   (`{ sessionId, tookMs }`), audit `session_recovered` (detail
 *   `{ tookMs }`), push `session.recovered` (respects quiet hours);
 * - when unrecoverable: push `session.interrupted` (quiet-hours bypass),
 *   and NO `session_recovered` at all.
 *
 * The push payload's kind comes from the event `type` via `buildPayload`,
 * so the notify call passes the WAL frame `type`, not the push kind.
 */
export function createReportOutcome(
  options: ReportOutcomeOptions,
): (sessionId: string, outcome: SessionRecoveryOutcome) => void {
  const { walDir, ownerEvents, audit, notifier } = options;

  /** Append a marker frame through the shared WAL and publish it on the
   * owner stream. A WAL failure must not suppress the audit row or the
   * push — the session's state is still reported (§4's durability is
   * best-effort relative to the notify path). */
  const appendMarker = (
    sessionId: string,
    type: 'session_interrupted' | 'session_recovered',
    data: Record<string, unknown>,
  ): void => {
    if (!walDir) return;
    try {
      const wal = getSharedWal(walDir, sessionId);
      const frame: WalFrame = {
        id: (wal.latestId() ?? 0) + 1,
        v: 1,
        type,
        data,
      };
      wal.append(frame);
      ownerEvents?.publish({ type: 'session_event', sessionId, event: frame });
    } catch {
      // Durability loss only — audit + push still run.
    }
  };

  return (sessionId, outcome) => {
    const { recovered, hadInFlightTurn, exitCode, tookMs } = outcome;
    const interruptedData: Record<string, unknown> = {
      sessionId,
      recovered,
      hadInFlightTurn,
      ...(exitCode !== null ? { exitCode } : {}),
    };
    appendMarker(sessionId, 'session_interrupted', interruptedData);
    void audit?.record({
      action: 'session_interrupted',
      target: sessionId,
      outcome: recovered ? 'ok' : 'failed',
      detail: {
        recovered,
        hadInFlightTurn,
        ...(exitCode !== null ? { exitCode } : {}),
      },
    });
    if (recovered) {
      const recoveredData: Record<string, unknown> = { sessionId, tookMs };
      appendMarker(sessionId, 'session_recovered', recoveredData);
      void audit?.record({
        action: 'session_recovered',
        target: sessionId,
        detail: { tookMs },
      });
      void notifier?.notify(
        { type: 'session_recovered', data: recoveredData },
        { sessionId },
      );
    } else {
      void notifier?.notify(
        { type: 'session_interrupted', data: interruptedData },
        { sessionId },
      );
    }
  };
}
