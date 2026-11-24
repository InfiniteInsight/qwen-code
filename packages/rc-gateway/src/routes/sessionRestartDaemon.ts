/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAbsolute } from 'node:path';
import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import {
  CannotRestartAttachedDaemonError,
  UnknownSessionError,
  WorkspacePoolFullError,
  type SessionDaemon,
} from '../daemonPool.js';
import {
  isSessionLevelGone,
  workspacePoolFullBodyFromRes,
} from '../daemonHttpError.js';
import { relayDaemonAuthFailure } from './daemonAuth.js';

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * POST /rc/sessions/:id/restart-daemon - OWNER-scoped control-plane route that
 * stops the `qwen serve` workspace daemon owning `:id` (`SIGTERM` with grace,
 * or immediate `SIGKILL` when `{ force: true }`), spawns a fresh replacement
 * daemon, and resumes `:id` (and any sibling sessions on that workspace) in
 * place.
 */
export function createSessionRestartDaemonRoute(
  daemon: Pick<SessionDaemon, 'restartSessionDaemon'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    if (typeof daemon.restartSessionDaemon !== 'function') {
      res.status(501).json({
        error: 'This gateway does not manage workspace daemon lifecycles',
        code: 'daemon_restart_unsupported',
      });
      return;
    }

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const rawForce = body['force'];
    if (rawForce !== undefined && typeof rawForce !== 'boolean') {
      res.status(400).json({
        error: '`force` must be a boolean when provided',
        code: 'invalid_body',
      });
      return;
    }
    const rawCwd = body['workspaceCwd'];
    let workspaceCwd: string | undefined;
    if (rawCwd !== undefined) {
      if (
        typeof rawCwd !== 'string' ||
        rawCwd.trim().length === 0 ||
        !isAbsolute(rawCwd.trim())
      ) {
        res.status(400).json({
          error: '`workspaceCwd` must be an absolute path when provided',
          code: 'invalid_workspace',
        });
        return;
      }
      workspaceCwd = rawCwd.trim();
    }

    try {
      const result = await daemon.restartSessionDaemon(sessionId, {
        force: rawForce === true,
        ...(workspaceCwd !== undefined ? { workspaceCwd } : {}),
      });
      void audit?.record({
        action: 'session_daemon_restarted',
        actorTokenId: req.rcClient?.id,
        target: sessionId,
        outcome: result.recovered ? 'ok' : 'failed',
        detail: {
          force: result.force,
          recovered: result.recovered,
          sessionCount: result.sessionCount,
        },
      });
      res.status(200).json(result);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof CannotRestartAttachedDaemonError) {
        void audit?.record({
          action: 'session_daemon_restarted',
          actorTokenId: req.rcClient?.id,
          target: sessionId,
          outcome: 'failed',
          detail: { force: rawForce === true, reason: err.code },
        });
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof WorkspacePoolFullError) {
        res.status(503).json(workspacePoolFullBodyFromRes(res, err));
        return;
      }
      if (relayDaemonAuthFailure(res, err, 'session_restart_daemon')) return;
      if (
        err instanceof UnknownSessionError ||
        isSessionLevelGone(err) ||
        (err as { status?: unknown } | null)?.status === 404
      ) {
        res
          .status(404)
          .json({ error: 'Session not found', code: 'session_not_found' });
        return;
      }
      void audit?.record({
        action: 'session_daemon_restarted',
        actorTokenId: req.rcClient?.id,
        target: sessionId,
        outcome: 'failed',
        detail: { force: rawForce === true },
      });
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}
