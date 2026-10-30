/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import type { GoalControlRequest, GoalStateResponse } from '@qwen-code/sdk';
import {
  UnknownSessionError,
  WorkspacePoolFullError,
  type SessionDaemon,
} from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { asDaemonHttpError, daemonErrorBody } from '../daemonHttpError.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * Issue #135: the session goal, the one slice of that issue the user chose to
 * build (read, set, clear).
 *
 * WHAT A GOAL IS
 *
 * The CLI's `/goal` (core/src/goals): an objective in the user's words that
 * the agent keeps taking turns toward until it judges it met or something
 * stops it. A snapshot is `{ v: 2, goal, activity }`; `goal` is null or a
 * record with `goalId`, `revision`, `objective`, a `status` of `active`,
 * `paused`, `blocked`, `usage_limited` or `complete`, counters (`turnCount`,
 * `activeTimeMs`, optional `tokensUsed` and the three budgets) and an
 * optional human-readable `lastReason`; `activity` is `idle`, `running` or
 * `verifying`. There is one goal per session.
 *
 *  - `GET /session/:id/goal`: `{ snapshot }`, relayed as the daemon sends it.
 *    SESSION_READ: the objective and reason are the same words the transcript
 *    already holds.
 *  - `POST /session/:id/goal` `{ objective }`: set it. WRITE. This is what
 *    `/goal <text>` does (goalCommand.ts): `create` when the session has no
 *    goal, `replace` (carrying the current id and revision, so a goal that
 *    moved in between is a 409 and not a silent overwrite) when it has one.
 *    The body carries the objective only: the page has no business choosing
 *    the action or sending a version, and pause, resume and edit are not
 *    offered. The daemon refuses a set in an untrusted folder.
 *  - `POST /session/:id/goal/clear`: drop it. WRITE. `{ cleared, snapshot? }`:
 *    `cleared: false` is an answer (there was none), relayed at 200.
 *
 * WHAT IS NOT ECHOED
 *
 * The daemon's error messages for a goal conflict quote the goal; they are
 * not relayed. A 409 carries the daemon's `current` snapshot instead, so the
 * page can show what the goal now is.
 */

/** The daemon sets no ceiling on an objective; the gateway does. */
export const MAX_GOAL_OBJECTIVE_CHARACTERS = 4000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type Outcome =
  | 'not_found'
  | 'untrusted'
  | 'conflict'
  | 'rejected'
  | 'unsupported'
  | 'daemon_unavailable';

function sendGoalError(res: Response, err: unknown): Outcome {
  if (err instanceof UnknownSessionError) {
    res.status(404).json({
      error: 'Session is not loaded in the daemon',
      code: 'session_not_found',
    });
    return 'not_found';
  }
  if (err instanceof WorkspacePoolFullError) {
    res.status(503).json({
      error: 'Workspace pool is full',
      code: 'workspace_pool_full',
    });
    return 'daemon_unavailable';
  }
  const http = asDaemonHttpError(err);
  const body = daemonErrorBody(err);
  const code = typeof body?.['code'] === 'string' ? body['code'] : undefined;
  const status = http?.status;
  if (status === 403 && code === 'untrusted_workspace') {
    res.status(403).json({
      error: 'This conversation\'s folder is not trusted, so it cannot take a goal',
      code,
    });
    return 'untrusted';
  }
  if (
    status === 409 &&
    (code === 'goal_conflict' || code === 'goal_invalid_transition')
  ) {
    const current = body?.['current'];
    res.status(409).json({
      error: 'The goal changed while this was sent',
      code,
      ...(isPlainObject(current) ? { snapshot: current } : {}),
    });
    return 'conflict';
  }
  if (status === 500 && code === 'goal_persist_failed') {
    res.status(502).json({
      error: 'The daemon could not save the goal',
      code,
    });
    return 'daemon_unavailable';
  }
  if (status === 404) {
    if (body !== undefined) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return 'not_found';
    }
    // Express's own "Cannot GET": a daemon that predates the routes.
    res.status(502).json({
      error: 'Daemon does not serve session goals',
      code: 'goal_unsupported',
    });
    return 'unsupported';
  }
  if (status !== undefined && status >= 400 && status < 500) {
    res.status(status).json({
      error: 'The daemon refused this request',
      code: code ?? 'daemon_rejected',
    });
    return 'rejected';
  }
  res
    .status(502)
    .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
  return 'daemon_unavailable';
}

function refuseMalformedSession(res: Response): void {
  res
    .status(404)
    .json({ error: 'Session not found', code: 'session_not_found' });
}

/** GET /session/:id/goal: the goal snapshot, verbatim. */
export function createSessionGoalReadRoute(
  daemon: Pick<SessionDaemon, 'sessionGoal'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    if (!isValidSessionId(sessionId)) return refuseMalformedSession(res);
    let result: GoalStateResponse;
    try {
      result = await daemon.sessionGoal(sessionId);
    } catch (err) {
      sendGoalError(res, err);
      return;
    }
    if (!isPlainObject(result) || !isPlainObject(result.snapshot)) {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }
    res.status(200).json({ snapshot: result.snapshot });
  };
}

/** POST /session/:id/goal: set the goal (create, or replace the current one). */
export function createSessionGoalSetRoute(
  daemon: Pick<SessionDaemon, 'sessionGoal' | 'sessionGoalControl'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;
    if (!isValidSessionId(sessionId)) return refuseMalformedSession(res);
    const body: unknown = req.body;
    if (
      !isPlainObject(body) ||
      Object.keys(body).some((k) => k !== 'objective')
    ) {
      res.status(400).json({
        error: 'Body must be an object with `objective` only',
        code: 'invalid_goal',
      });
      return;
    }
    const objective =
      typeof body['objective'] === 'string' ? body['objective'].trim() : '';
    if (
      objective.length === 0 ||
      [...objective].length > MAX_GOAL_OBJECTIVE_CHARACTERS
    ) {
      res.status(400).json({
        error: `A goal is 1 to ${MAX_GOAL_OBJECTIVE_CHARACTERS} characters`,
        code: 'invalid_goal',
      });
      return;
    }

    let action: 'create' | 'replace' = 'create';
    let result: GoalStateResponse;
    try {
      const before = await daemon.sessionGoal(sessionId);
      const current = before?.snapshot?.goal ?? null;
      const request: GoalControlRequest = current
        ? {
            action: 'replace',
            objective,
            expectedGoalId: current.goalId,
            expectedRevision: current.revision,
          }
        : { action: 'create', objective };
      action = request.action === 'replace' ? 'replace' : 'create';
      result = await daemon.sessionGoalControl(sessionId, request);
    } catch (err) {
      const reason = sendGoalError(res, err);
      void audit?.record({
        action: 'session_goal_set_failed',
        actorTokenId,
        target: sessionId,
        detail: { reason },
      });
      return;
    }
    if (!isPlainObject(result) || !isPlainObject(result.snapshot)) {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }
    // The goal's words are the user's own; the record carries the action only.
    void audit?.record({
      action: 'session_goal_set',
      actorTokenId,
      target: sessionId,
      detail: { action },
    });
    res.status(200).json({ snapshot: result.snapshot });
  };
}

/** POST /session/:id/goal/clear: drop the goal. */
export function createSessionGoalClearRoute(
  daemon: Pick<SessionDaemon, 'sessionGoalClear'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;
    if (!isValidSessionId(sessionId)) return refuseMalformedSession(res);
    let result: unknown;
    try {
      result = await daemon.sessionGoalClear(sessionId);
    } catch (err) {
      const reason = sendGoalError(res, err);
      void audit?.record({
        action: 'session_goal_clear_failed',
        actorTokenId,
        target: sessionId,
        detail: { reason },
      });
      return;
    }
    const r = isPlainObject(result) ? result : {};
    const cleared = r['cleared'] === true;
    void audit?.record({
      action: 'session_goal_cleared',
      actorTokenId,
      target: sessionId,
      detail: { cleared },
    });
    res.status(200).json({
      cleared,
      ...(isPlainObject(r['snapshot']) ? { snapshot: r['snapshot'] } : {}),
    });
  };
}
