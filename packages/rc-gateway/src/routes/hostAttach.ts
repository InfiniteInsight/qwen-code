/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, RequestHandler, Response } from 'express';
import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  UnknownSessionError,
  WorkspacePoolFullError,
  type DaemonEndpoint,
  type SessionDaemon,
} from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { forwardedPeer } from '../tls/http2Front.js';
import { bearerMatches, isLoopbackRemote } from '../localCredential.js';
import { isValidSessionId } from '../sessions/chatsPath.js';
import {
  planAttachedTuiCommand,
  type TerminalPlanOptions,
} from '../terminals.js';
import { isSessionNotFoundError } from './sessionResume.js';

/** The slice of the pool these routes call. */
export type HostAttachDaemon = Pick<
  SessionDaemon,
  'createOrAttachSession' | 'resumeSession' | 'daemonEndpointForSession'
>;

export interface HostAttachDeps {
  daemon: HostAttachDaemon;
  /** The persistent host-attach token (localCredential.ts). */
  token: string;
  audit?: AuditRecorder;
  /** The same options the terminals route gets (`QWEN_RC_TERMINAL_QWEN`). */
  planOpts?: TerminalPlanOptions;
  /**
   * Where each successful attach notes its workspace, so the phone's session
   * listing widens to it (hostAttachedWorkspaces.ts). Never the request log:
   * the launcher opens a tab for every line in that.
   */
  attachedWorkspaces?: { record(cwd: string): Promise<void> };
}

/** How the session in a 200 was reached. */
type Via = 'created' | 'pooled' | 'resumed';
/** Which step a refused call was on, for the audit row. */
type Step = 'create' | 'attach' | 'resume';

export interface HostAttachRoutes {
  create: RequestHandler;
  attach: RequestHandler;
}

/**
 * Host attach (InfiniteInsight/Qwen-Code-Remote#194 slice D): the
 * terminal-first half of the mirror. A terminal on the gateway's own machine
 * (`qwen-rc attach`) asks for a daemon session and gets back the command that
 * runs the attached TUI on it, so a conversation can start at the keyboard and
 * be picked up from the phone, which sees it as an ordinary pooled session.
 *
 * - `POST /rc/host/attach` body `{ cwd }`: create a fresh `scope: 'thread'`
 *   session on the daemon for `cwd` (spawned or reused through the pool, the
 *   same call `POST /session` makes).
 * - `POST /rc/host/attach/:sessionId` body `{ cwd? }`: hand back a session
 *   that already exists. Two cases, kept apart on purpose:
 *     - the pool tracks the session (its daemon is alive): answer its
 *       endpoint, `cwd` is ignored;
 *     - the pool does not (the daemon died or was reaped, or the gateway
 *       restarted): restore it with `resumeSession(id, { workspaceCwd: cwd })`
 *       exactly as `POST /session/:id/resume` does. `cwd` is required for this
 *       case only (`400 cwd_required`), because nothing in memory says where the
 *       transcript lives, and a session the daemon cannot find there is
 *       `404 session_not_found`. A terminal whose daemon died re-attaches
 *       through this (slice E); the 404 is its signal that there is nothing to
 *       come back to, as opposed to a 502/503, which is worth retrying.
 *
 * Both answer `200 { sessionId, workspaceCwd, daemonUrl, daemonToken,
 * linuxArgv, title, via }`. `linuxArgv` comes from `planAttachedTuiCommand`
 * (the TUI, not the wrapper) with the terminals route's options, so qwen's flag names keep one owner.
 * `workspaceCwd` is the pool's canonical path for the daemon, which is the
 * directory the TUI must run in. `via` (`created` | `pooled` | `resumed`) says
 * which path was taken.
 *
 * Gates, in order: loopback peer (403 `loopback_only`, read through
 * `forwardedPeer` so the HTTP/2 front's loopback hop does not count), then the
 * host-attach bearer in constant time (401). Mounted BEFORE bearerResolve:
 * the host-attach token is not a TokenStore token, so a phone's token never
 * opens these routes and this token never opens a phone route.
 *
 * Trust: the response carries the daemon's own token. It crosses only the
 * loopback hop, to a process that proved it can read a 0600 file in the
 * gateway user's home, so it is a process running as that same user. That is
 * the trust the terminal request log already extends (it holds the same token
 * at 0600 for the launcher), and such a process could read the daemon's
 * environment anyway. On WSL the Windows session is inside that boundary
 * too: Windows loopback is forwarded into the distro and `\\wsl$` reads the
 * home dir as this user. That was already true of the request log, which the
 * Windows launcher reads.
 *
 * Folder list: every 200 notes `workspaceCwd` in the host-attach record, which
 * the session listing merges with the request log's workspaces, so a
 * conversation started in a folder the phone never used still shows there.
 * Refusals note nothing.
 *
 * Audit: one row per call. `host_attach_rejected` with the gate's reason, or
 * `host_attached` with `outcome`, the session id as `target` when there is a
 * valid one, and `via` (or the failing step plus its code). Never a path,
 * never a token.
 */
export function createHostAttachRoutes(deps: HostAttachDeps): HostAttachRoutes {
  const { daemon, audit } = deps;

  /** The two gates. Answers and audits a refusal; true when the call may go on. */
  const admit = (req: Request, res: Response): boolean => {
    if (!isLoopbackRemote(forwardedPeer(req))) {
      void audit?.record({
        action: 'host_attach_rejected',
        detail: { reason: 'non_loopback' },
      });
      res.status(403).json({ error: 'Loopback only', code: 'loopback_only' });
      return false;
    }
    if (!bearerMatches(req.headers.authorization, deps.token)) {
      void audit?.record({
        action: 'host_attach_rejected',
        detail: { reason: 'bad_token' },
      });
      res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      return false;
    }
    return true;
  };

  const fail = (
    res: Response,
    step: Step,
    status: number,
    code: string,
    error: string,
    sessionId?: string,
  ): void => {
    void audit?.record({
      action: 'host_attached',
      ...(sessionId !== undefined ? { target: sessionId } : {}),
      outcome: 'failed',
      detail: { via: step, code },
    });
    res.status(status).json({ error, code });
  };

  /**
   * Answer the attach material for a session the pool now tracks, after
   * noting its workspace for the session listing. The note is best effort: a
   * record that cannot be written costs the listing one folder, never the
   * attach.
   */
  const answer = async (
    res: Response,
    step: Step,
    via: Via,
    sessionId: string,
    endpoint: DaemonEndpoint | undefined,
  ): Promise<void> => {
    if (!endpoint?.token) {
      // Reachable in attach mode (the gateway did not mint the daemon's token)
      // and for a daemon registered without endpoint material; mirrors the
      // terminals route.
      fail(
        res,
        step,
        409,
        'daemon_unavailable',
        'No credentials for this session daemon',
        sessionId,
      );
      return;
    }
    // The TUI itself, never the `qwen-rc attach` wrapper a phone-opened tab
    // runs: the caller here IS that wrapper and would otherwise run itself.
    const linuxArgv = planAttachedTuiCommand(
      {
        sessionId,
        daemonUrl: endpoint.url,
        daemonToken: endpoint.token,
      },
      deps.planOpts,
    );
    try {
      await deps.attachedWorkspaces?.record(endpoint.workspaceCwd);
    } catch {
      // See above: the listing loses a folder, the terminal still attaches.
    }
    void audit?.record({
      action: 'host_attached',
      target: sessionId,
      outcome: 'ok',
      detail: { via },
    });
    res.status(200).json({
      sessionId,
      workspaceCwd: endpoint.workspaceCwd,
      daemonUrl: endpoint.url,
      daemonToken: endpoint.token,
      linuxArgv,
      title: `qwen ${sessionId.slice(0, 8)}`,
      via,
    });
  };

  /**
   * The body's `cwd`, checked like sessionCreate.ts checks it, plus one rule
   * of its own: it must be absolute. A relative path would be resolved
   * against the gateway's own cwd, which is never what a terminal meant. Any
   * failure is the same 400 and never echoes the path.
   */
  const readCwd = async (
    req: Request,
  ): Promise<{
    cwd?: string;
    error?: 'cwd_required' | 'invalid_workspace';
  }> => {
    const raw = (req.body ?? {}) as { cwd?: unknown };
    if (typeof raw.cwd !== 'string' || raw.cwd.length === 0) {
      return { error: 'cwd_required' };
    }
    if (!isAbsolute(raw.cwd)) return { error: 'invalid_workspace' };
    try {
      if ((await stat(raw.cwd)).isDirectory()) return { cwd: raw.cwd };
    } catch {
      // ENOENT, EACCES, ...: all the same 400 below.
    }
    return { error: 'invalid_workspace' };
  };

  const cwdError = (
    res: Response,
    step: Step,
    error: 'cwd_required' | 'invalid_workspace',
    sessionId?: string,
  ): void =>
    fail(
      res,
      step,
      400,
      error,
      error === 'cwd_required'
        ? 'cwd is required'
        : 'cwd must be an existing absolute directory',
      sessionId,
    );

  const create: RequestHandler = async (req, res) => {
    if (!admit(req, res)) return;
    // Checked before the session exists: without an endpoint lookup the
    // session would be created and then unusable from a terminal.
    if (typeof daemon.daemonEndpointForSession !== 'function') {
      fail(
        res,
        'create',
        501,
        'host_attach_unsupported',
        'This gateway cannot attach host terminals',
      );
      return;
    }
    const { cwd, error } = await readCwd(req);
    if (error || cwd === undefined) {
      cwdError(res, 'create', error ?? 'invalid_workspace');
      return;
    }

    let sessionId: string;
    try {
      ({ sessionId } = await daemon.createOrAttachSession({
        workspaceCwd: cwd,
        sessionScope: 'thread',
      }));
    } catch (err) {
      if (err instanceof WorkspacePoolFullError) {
        fail(res, 'create', 503, 'workspace_pool_full', 'Workspace pool full');
        return;
      }
      fail(res, 'create', 502, 'daemon_unavailable', 'Daemon unavailable');
      return;
    }

    let endpoint: DaemonEndpoint | undefined;
    try {
      endpoint = daemon.daemonEndpointForSession(sessionId);
    } catch {
      // The pool records the session before createOrAttachSession resolves,
      // so this is only a daemon that died in between.
      fail(
        res,
        'create',
        502,
        'daemon_unavailable',
        'Daemon unavailable',
        sessionId,
      );
      return;
    }
    await answer(res, 'create', 'created', sessionId, endpoint);
  };

  const attach: RequestHandler = async (req, res) => {
    if (!admit(req, res)) return;
    const sessionId = req.params['sessionId'];
    // A malformed id is refused before any lookup, like every sibling session
    // route; it is not echoed into the audit either.
    if (typeof sessionId !== 'string' || !isValidSessionId(sessionId)) {
      fail(res, 'attach', 404, 'session_not_found', 'Session not found');
      return;
    }
    const lookup = daemon.daemonEndpointForSession?.bind(daemon);
    if (!lookup) {
      fail(
        res,
        'attach',
        501,
        'host_attach_unsupported',
        'This gateway cannot attach host terminals',
        sessionId,
      );
      return;
    }

    // Case 1: the pool tracks the session, so its daemon is alive.
    let pooled: DaemonEndpoint | undefined;
    let tracked = true;
    try {
      pooled = lookup(sessionId);
    } catch (err) {
      if (!(err instanceof UnknownSessionError)) {
        fail(
          res,
          'attach',
          502,
          'daemon_unavailable',
          'Daemon unavailable',
          sessionId,
        );
        return;
      }
      tracked = false;
    }
    if (tracked) {
      await answer(res, 'attach', 'pooled', sessionId, pooled);
      return;
    }

    // Case 2: nothing in memory owns it. Restore it in the caller's cwd.
    const { cwd, error } = await readCwd(req);
    if (error || cwd === undefined) {
      cwdError(res, 'resume', error ?? 'invalid_workspace', sessionId);
      return;
    }
    try {
      await daemon.resumeSession(sessionId, { workspaceCwd: cwd });
    } catch (err) {
      if (err instanceof WorkspacePoolFullError) {
        fail(
          res,
          'resume',
          503,
          'workspace_pool_full',
          'Workspace pool full',
          sessionId,
        );
        return;
      }
      if (isSessionNotFoundError(err)) {
        fail(
          res,
          'resume',
          404,
          'session_not_found',
          'Session not found',
          sessionId,
        );
        return;
      }
      fail(
        res,
        'resume',
        502,
        'daemon_unavailable',
        'Daemon unavailable',
        sessionId,
      );
      return;
    }

    let endpoint: DaemonEndpoint | undefined;
    try {
      endpoint = lookup(sessionId);
    } catch {
      fail(
        res,
        'resume',
        502,
        'daemon_unavailable',
        'Daemon unavailable',
        sessionId,
      );
      return;
    }
    await answer(res, 'resume', 'resumed', sessionId, endpoint);
  };

  return { create, attach };
}
