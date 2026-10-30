/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import {
  UnknownSessionError,
  WorkspacePoolFullError,
  type DaemonEndpoint,
  type SessionDaemon,
} from '../daemonPool.js';
import { isSessionMirrored } from '../hostMirrors.js';
import {
  isValidTabId,
  type HostTabRegistry,
  type HostTabView,
} from '../hostTabs.js';
import {
  planTerminalCommand,
  type LauncherLiveness,
  type TerminalPlanOptions,
  type TerminalRequestLog,
} from '../terminals.js';
import { hostAttachGate } from './hostAttach.js';
import { isSessionNotFoundError } from './sessionResume.js';
import { LAUNCHER_STALE_MS } from './terminals.js';

/** The largest exit status a process can report. */
const MAX_EXIT_CODE = 255;

export interface HostTabEndDeps {
  registry: Pick<HostTabRegistry, 'end'>;
  /** The persistent host-attach token the wrapper already holds. */
  token: string;
  audit?: AuditRecorder;
  /** Told of every end that landed, after it is recorded (the automatic reopen listens). */
  onEnded?: (tab: HostTabView) => void;
}

/**
 * `POST /rc/host/tabs/:tabId/end` body `{ exitCode }` (#212): the wrapper's
 * last word, posted from its exit path with a short timeout so a dying tab
 * never hangs on it. Same gates as the host attach routes (loopback peer,
 * then the host-attach bearer) and mounted beside them, before
 * `bearerResolve`: a phone token never reaches it.
 *
 * Answers `200 { tabId, state, reason }`, `404 tab_not_found` for a tab id
 * that is malformed or names no record (a record removed from the phone, so
 * the wrapper has nothing to keep), `400 invalid_exit_code` for anything but
 * a whole number from 0 to 255. A second end for the same record changes
 * nothing: the first one wins.
 *
 * Audit: `host_tab_ended` with the session as `target` and `{ tabId,
 * exitCode, reason }`. Never a path.
 */
export function createHostTabEndRoute(deps: HostTabEndDeps): RequestHandler {
  const admit = hostAttachGate(deps.token, deps.audit);
  return async (req, res) => {
    if (!admit(req, res)) return;
    const tabId = req.params['tabId'];
    if (!isValidTabId(tabId)) {
      res.status(404).json({ error: 'Tab not found', code: 'tab_not_found' });
      return;
    }
    const exitCode = ((req.body ?? {}) as { exitCode?: unknown }).exitCode;
    if (
      typeof exitCode !== 'number' ||
      !Number.isSafeInteger(exitCode) ||
      exitCode < 0 ||
      exitCode > MAX_EXIT_CODE
    ) {
      res.status(400).json({
        error: 'exitCode must be a whole number from 0 to 255',
        code: 'invalid_exit_code',
      });
      return;
    }
    const tab = await deps.registry.end(tabId, exitCode);
    if (!tab) {
      res.status(404).json({ error: 'Tab not found', code: 'tab_not_found' });
      return;
    }
    void deps.audit?.record({
      action: 'host_tab_ended',
      target: tab.sessionId,
      outcome: 'ok',
      detail: { tabId, exitCode: tab.exitCode, reason: tab.reason },
    });
    res
      .status(200)
      .json({ tabId, state: tab.state, reason: tab.reason ?? null });
    try {
      deps.onEnded?.(tab);
    } catch {
      // A listener never costs the wrapper its answer.
    }
  };
}

// ---- The phone's verbs -----------------------------------------------------

/** A daemon endpoint for a session, or why there is none. */
export type TabEndpointAnswer =
  | { ok: true; endpoint: DaemonEndpoint }
  | { ok: false; status: number; code: string; error: string };

/**
 * The endpoint a reopened tab attaches to, from the pool: the daemon that
 * holds the session, or, when none does (reaped, or the gateway restarted
 * since the tab crashed), the session restored in the folder the tab ran in,
 * exactly as the host attach route restores one. A reopen is most wanted
 * right after a restart, so it cannot ask for a daemon that is already up.
 */
export function sessionEndpointResolver(
  daemon: Pick<SessionDaemon, 'daemonEndpointForSession' | 'resumeSession'>,
): (sessionId: string, cwd: string) => Promise<TabEndpointAnswer> {
  const down: TabEndpointAnswer = {
    ok: false,
    status: 502,
    code: 'daemon_unavailable',
    error: 'Daemon unavailable',
  };
  return async (sessionId, cwd) => {
    const lookup = daemon.daemonEndpointForSession?.bind(daemon);
    if (!lookup) {
      return {
        ok: false,
        status: 501,
        code: 'host_terminals_unsupported',
        error: 'This gateway cannot open host terminals',
      };
    }
    let endpoint: DaemonEndpoint | undefined;
    try {
      endpoint = lookup(sessionId);
    } catch (err) {
      if (!(err instanceof UnknownSessionError)) return down;
      try {
        await daemon.resumeSession(sessionId, { workspaceCwd: cwd });
      } catch (e) {
        if (e instanceof WorkspacePoolFullError) {
          return {
            ok: false,
            status: 503,
            code: 'workspace_pool_full',
            error: 'Workspace pool full',
          };
        }
        if (isSessionNotFoundError(e)) {
          return {
            ok: false,
            status: 404,
            code: 'session_not_found',
            error: 'Session not found',
          };
        }
        return down;
      }
      try {
        endpoint = lookup(sessionId);
      } catch {
        return down;
      }
    }
    if (!endpoint?.token) {
      return {
        ok: false,
        status: 409,
        code: 'daemon_unavailable',
        error: 'No credentials for this session daemon',
      };
    }
    return { ok: true, endpoint };
  };
}

export interface HostTabRoutesDeps {
  registry: HostTabRegistry;
  /** The launcher's request log; without it a reopen answers 501. */
  requests?: TerminalRequestLog;
  audit?: AuditRecorder;
  /** The same options POST /rc/terminals gets, so both queue one command shape. */
  planOpts?: TerminalPlanOptions;
  endpointFor: (sessionId: string, cwd: string) => Promise<TabEndpointAnswer>;
  /** Whether a terminal on this host already shows the session (hostMirrors.ts). */
  isMirrored?: (sessionId: string) => Promise<boolean>;
  launcherStaleMs?: number;
  /**
   * Reopen a crashed tab without being asked (`--reopen-crashed-tabs`, off
   * by default). See {@link autoReopenEligible} for the rules.
   */
  autoReopen?: boolean;
  /** Clock for the automatic reopen's window; defaults to the registry's. */
  now?: () => number;
}

/** How often the automatic reopen looks, when it is on. */
export const HOST_TAB_SWEEP_MS = 5_000;

/**
 * How recent a crash must be for the automatic reopen to act on it, measured
 * from its moment (the end, or the first read that found the tab gone). It
 * keeps the switch from reopening a pile of old crashes the moment it is
 * turned on, and keeps a launcher that comes back after a long absence from
 * opening tabs nobody is waiting for. A reboot still counts: its tabs are
 * found gone by the gateway's first read after it starts.
 */
export const AUTO_REOPEN_WINDOW_MS = 10 * 60_000;

/** Reasons the automatic reopen never acts on: the user's own acts. */
const NEVER_AUTO: ReadonlySet<string> = new Set([
  'quit',
  'terminal_closed',
  'interrupted',
]);

/**
 * Whether the automatic reopen may reopen this record now: crashed, not
 * dismissed, never automatically reopened before, not itself a tab the
 * automatic reopen opened (so a tab that crashes again after its reopen is
 * left to the user), not ended by the user (quit, a closed tab, Ctrl-C in
 * the wait), and crashed within {@link AUTO_REOPEN_WINDOW_MS}. The launcher
 * gate is the caller's.
 */
export function autoReopenEligible(
  t: HostTabView,
  now: number,
  windowMs: number = AUTO_REOPEN_WINDOW_MS,
): boolean {
  if (t.state !== 'crashed' || t.dismissed) return false;
  if (t.autoReopenedAt !== undefined) return false;
  if (t.origin === 'auto_reopen') return false;
  if (t.reason !== undefined && NEVER_AUTO.has(t.reason)) return false;
  const at = t.endedAt ?? t.lostAt;
  return at !== undefined && now - at <= windowMs;
}

/** What one reopen came to, for the route and for the automatic reopen. */
export interface ReopenOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** The fields the phone reads; the scan's own bookkeeping stays home. */
function publicTab(t: HostTabView): Record<string, unknown> {
  return {
    tabId: t.tabId,
    sessionId: t.sessionId,
    cwd: t.cwd,
    pid: t.pid,
    state: t.state,
    reason: t.reason ?? null,
    exitCode: t.exitCode ?? null,
    startedAt: t.startedAt,
    endedAt: t.endedAt ?? null,
    lostAt: t.lostAt ?? null,
    dismissed: t.dismissed,
    reopenedAt: t.reopenedAt ?? null,
    autoReopenedAt: t.autoReopenedAt ?? null,
    origin: t.origin ?? null,
  };
}

function liveness(l: LauncherLiveness): Record<string, unknown> {
  return { launcherState: l.state, launcherSeenMsAgo: l.seenMsAgo };
}

export interface HostTabRoutes {
  list: RequestHandler;
  reopen: RequestHandler;
  dismiss: RequestHandler;
  remove: RequestHandler;
  /** The reopen itself, shared with the automatic reopen (`auto: true`). */
  reopenTab(
    tabId: string,
    opts: { auto: boolean; actorTokenId?: string },
  ): Promise<ReopenOutcome>;
  /**
   * One pass of the automatic reopen; a no-op unless it is on. Never throws,
   * and never runs twice at once.
   */
  sweep(): Promise<void>;
}

/**
 * The phone's view of the host's tabs (#212), modelled on
 * Claude-Remote-Rescue's dashboard verbs. All WRITE scope (owner and write
 * tokens; a reader or a share never reaches them), mounted after
 * `bearerResolve`.
 *
 * - `GET /rc/host/tabs`: every record with its derived state (see
 *   hostTabs.ts), newest first, the launcher's liveness, so the page can
 *   say whether Reopen can work before it is pressed, and `autoReopen`,
 *   whether the gateway reopens crashed tabs on its own.
 * - `POST /rc/host/tabs/:tabId/reopen`: queue a terminal request for the
 *   record's conversation through the same request log POST /rc/terminals
 *   writes, so the launcher opens it like any other. Only a crashed or ghost
 *   record is reopened (`409 tab_live` or `409 tab_not_reopenable` with the
 *   state otherwise). A launcher that is `stale` or `never` refuses it with
 *   `409 launcher_unavailable` and the liveness, the same fields the open
 *   route answers with: a request queued for an absent launcher would open a
 *   tab whenever it next ran, long after anyone asked. A terminal already
 *   showing the conversation answers `200 { alreadyMirrored: true }` and
 *   queues nothing. A session no daemon holds is restored in the record's
 *   folder first ({@link sessionEndpointResolver}). Success is `202 { tabId,
 *   requestId, launcherState, launcherSeenMsAgo }`, and the record notes the
 *   reopen, so the tab that answers it is linked to it and replaces it.
 * - `POST /rc/host/tabs/:tabId/dismiss`: keep the record, drop its badge.
 * - `DELETE /rc/host/tabs/:tabId`: delete the record.
 *
 * Dismiss and delete refuse a live tab (`409 tab_live`): every verb that
 * changes something is gated on the derived state, never on a pid alone.
 * An unknown or malformed tab id is `404 tab_not_found`.
 *
 * Audit: `host_tab_reopened` (outcome ok or failed, with the code),
 * `host_tab_dismissed`, `host_tab_removed`, each with the session as `target`
 * and the tab id in `detail`. Never a path, never a token.
 */
export function createHostTabRoutes(deps: HostTabRoutesDeps): HostTabRoutes {
  const { registry, audit } = deps;
  const staleMs = deps.launcherStaleMs ?? LAUNCHER_STALE_MS;
  const isMirrored = deps.isMirrored ?? ((id: string) => isSessionMirrored(id));

  const notFound = { error: 'Tab not found', code: 'tab_not_found' };

  const reopenTab = async (
    tabId: string,
    opts: { auto: boolean; actorTokenId?: string },
  ): Promise<ReopenOutcome> => {
    const refuse = (
      status: number,
      body: Record<string, unknown>,
      sessionId?: string,
    ): ReopenOutcome => {
      void audit?.record({
        action: 'host_tab_reopened',
        ...(opts.actorTokenId ? { actorTokenId: opts.actorTokenId } : {}),
        ...(sessionId !== undefined ? { target: sessionId } : {}),
        outcome: 'failed',
        detail: {
          ...(isValidTabId(tabId) ? { tabId } : {}),
          code: body.code,
          auto: opts.auto,
        },
      });
      return { status, body };
    };
    if (!isValidTabId(tabId)) return refuse(404, notFound);
    const tab = await registry.view(tabId);
    if (!tab) return refuse(404, notFound);
    const sid = tab.sessionId;
    if (tab.state === 'live') {
      return refuse(
        409,
        { error: 'This tab is open', code: 'tab_live', state: tab.state },
        sid,
      );
    }
    if (tab.state !== 'crashed' && tab.state !== 'ghost') {
      return refuse(
        409,
        {
          error: 'Only a crashed or lost tab is reopened',
          code: 'tab_not_reopenable',
          state: tab.state,
        },
        sid,
      );
    }
    if (!deps.requests) {
      return refuse(
        501,
        {
          error: 'This gateway cannot open host terminals',
          code: 'host_terminals_unsupported',
        },
        sid,
      );
    }
    // A terminal already on the conversation is the answer, as on the open
    // route. A check that throws counts as none.
    let mirrored = false;
    try {
      mirrored = await isMirrored(sid);
    } catch {
      mirrored = false;
    }
    if (mirrored) {
      return {
        status: 200,
        body: { alreadyMirrored: true, sessionId: sid, tabId },
      };
    }
    const before = await deps.requests.launcherLiveness(staleMs);
    // The automatic reopen waits for a launcher it has heard from; a person
    // pressing Reopen may queue for one that is merely unreadable.
    const absent = opts.auto
      ? before.state !== 'live'
      : before.state === 'stale' || before.state === 'never';
    if (absent) {
      return refuse(
        409,
        {
          error:
            before.state === 'never'
              ? 'No launcher has ever checked in on this host'
              : 'The launcher is not checking in',
          code: 'launcher_unavailable',
          ...liveness(before),
        },
        sid,
      );
    }
    const found = await deps.endpointFor(sid, tab.cwd);
    if (!found.ok) {
      return refuse(
        found.status,
        { error: found.error, code: found.code },
        sid,
      );
    }
    const command = planTerminalCommand(
      { sessionId: sid, workspaceCwd: found.endpoint.workspaceCwd },
      deps.planOpts,
    );
    const request = await deps.requests.enqueue({
      sessionId: sid,
      workspaceCwd: found.endpoint.workspaceCwd,
      daemonUrl: found.endpoint.url,
      daemonToken: found.endpoint.token!,
      linuxArgv: command.linuxArgv,
      title: command.title,
    });
    await registry.noteReopen(tabId, opts.auto);
    void audit?.record({
      action: 'host_tab_reopened',
      ...(opts.actorTokenId ? { actorTokenId: opts.actorTokenId } : {}),
      target: sid,
      outcome: 'ok',
      detail: { tabId, requestId: request.id, auto: opts.auto },
    });
    const after = await deps.requests.launcherLiveness(staleMs);
    return {
      status: 202,
      body: { tabId, requestId: request.id, ...liveness(after) },
    };
  };

  const list: RequestHandler = async (_req, res) => {
    const tabs = await registry.list();
    const launcher = deps.requests
      ? await deps.requests.launcherLiveness(staleMs)
      : undefined;
    res.status(200).json({
      tabs: tabs.map(publicTab),
      launcher: launcher
        ? { state: launcher.state, seenMsAgo: launcher.seenMsAgo }
        : null,
      autoReopen: deps.autoReopen === true,
    });
  };

  const reopen: RequestHandler = async (req, res) => {
    const out = await reopenTab(String(req.params['tabId'] ?? ''), {
      auto: false,
      actorTokenId: req.rcClient?.id,
    });
    res.status(out.status).json(out.body);
  };

  /** Dismiss and delete: the record, refused while its tab is live. */
  const change =
    (verb: 'dismiss' | 'remove'): RequestHandler =>
    async (req, res) => {
      const tabId = String(req.params['tabId'] ?? '');
      const tab = isValidTabId(tabId) ? await registry.view(tabId) : undefined;
      if (!tab) {
        res.status(404).json(notFound);
        return;
      }
      if (tab.state === 'live') {
        res.status(409).json({
          error: 'This tab is open',
          code: 'tab_live',
          state: tab.state,
        });
        return;
      }
      if (verb === 'dismiss') await registry.dismiss(tabId);
      else await registry.remove(tabId);
      void audit?.record({
        action: verb === 'dismiss' ? 'host_tab_dismissed' : 'host_tab_removed',
        ...(req.rcClient?.id ? { actorTokenId: req.rcClient.id } : {}),
        target: tab.sessionId,
        outcome: 'ok',
        detail: { tabId },
      });
      if (verb === 'remove') {
        res.status(200).json({ tabId, removed: true });
        return;
      }
      const after = await registry.view(tabId);
      res.status(200).json({ tab: after ? publicTab(after) : null });
    };

  // The automatic reopen. Each record is tried at most once per gateway
  // run whatever came of it (a refusal is not retried every five seconds),
  // and a success is written on the record, so it holds across restarts too.
  // Nothing is tried while the launcher is not live: the pass returns before
  // reading a single record, so a launcher that is away costs no audit rows.
  const tried = new Set<string>();
  let sweeping = false;
  const sweep = async (): Promise<void> => {
    if (!deps.autoReopen || !deps.requests || sweeping) return;
    sweeping = true;
    try {
      const l = await deps.requests.launcherLiveness(staleMs);
      if (l.state !== 'live') return;
      const now = (deps.now ?? registry.now)();
      for (const t of await registry.list()) {
        if (tried.has(t.tabId) || !autoReopenEligible(t, now)) continue;
        tried.add(t.tabId);
        await reopenTab(t.tabId, { auto: true });
      }
    } catch {
      // The next pass tries again; a sweep never takes the gateway down.
    } finally {
      sweeping = false;
    }
  };

  return {
    list,
    reopen,
    dismiss: change('dismiss'),
    remove: change('remove'),
    reopenTab,
    sweep,
  };
}
