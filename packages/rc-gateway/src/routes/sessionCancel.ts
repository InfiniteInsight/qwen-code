/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { isSessionLevelGone } from '../daemonHttpError.js';
import type { AuditRecorder } from '../auditLog.js';

/**
 * POST /session/:id/cancel — abort the session's in-flight turn.
 *
 * Write-scoped, and deliberately NOT owner-scoped: cancelling is strictly less
 * destructive than `POST /session/:id/end`, which is itself WRITE. Anyone who
 * can start a turn can stop one.
 *
 * The session survives — only the running prompt is aborted — so unlike the end
 * route there is no `session_died`; the daemon settles the turn on its own
 * event stream and the live SSE relay carries that through unchanged. Nothing
 * needs fanning out here.
 *
 * Idempotent by construction: the daemon answers 204 whether or not a turn was
 * actually running, so a double-tap on a mobile stop button is harmless.
 */
export function createSessionCancelRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;

    try {
      await daemon.cancel(sessionId);
    } catch (err) {
      if (err instanceof UnknownSessionError || isSessionLevelGone(err)) {
        res.status(404).json({
          error: 'Session not found',
          code: 'session_not_found',
        });
        return;
      }
      res.status(502).json({
        error: 'Daemon unavailable',
        code: 'daemon_unavailable',
      });
      return;
    }

    void audit?.record({
      action: 'session_cancelled',
      actorTokenId,
      target: sessionId,
    });

    res.status(200).json({ sessionId, cancelled: true });
  };
}
