/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { classifySubagentFailure } from './subagentFailure.js';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

/**
 * POST /session/:id/subagents/:subagentRef/cancel — stop ONE running subagent
 * while leaving the parent turn alive.
 *
 * This is the gap the route exists to close: before it, the only way to stop a
 * runaway subagent from the remote was `POST /session/:id/cancel`, which throws
 * away the whole turn along with it. Same guard set as that route, because
 * cancelling one child is strictly less destructive than cancelling the turn.
 *
 * `subagentRef` is the PARENT transcript's tool-call id, not a session id (the
 * daemon matches it against `task.toolUseId`). The page already holds it as
 * `_meta.parentToolCallId`, so no new identifier is introduced here. It is not
 * path-joined by this process — the SDK url-encodes it into the daemon URL and
 * the daemon bounds its length — so there is no local traversal surface to
 * guard and no duplicate length check to drift from the daemon's own.
 *
 * A 404 is answered as a 404. Flattening "no such subagent" into a 502 would
 * tell the user the gateway is broken when what they did was press cancel on a
 * row that had already settled, which is the common case rather than an edge
 * case: the button and the child's completion race by one frame.
 */
export function createSubagentCancelRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const subagentRef = req.params.subagentRef;
    const actorTokenId = req.rcClient?.id;
    const target = sessionId + ':' + subagentRef;

    let cancelled: boolean;
    try {
      const done = await daemon.cancelSubagentSession(sessionId, subagentRef);
      cancelled = done.cancelled;
    } catch (err) {
      // Three different failures, three different answers, classified by the
      // shared helper because the key that names the child on the wire is
      // `subagentRef`, not the `toolCallId` the SDK guard reads. See
      // `subagentFailure.ts`.
      const code = classifySubagentFailure(err, subagentRef);
      void audit?.record({
        action: 'subagent_cancel_failed',
        actorTokenId,
        target,
        detail: { reason: code },
      });
      // The daemon's own message is never echoed, so a workspace path cannot
      // leak through it.
      if (code === 'subagent_not_found') {
        res
          .status(404)
          .json({ error: 'Subagent not found in this session', code });
        return;
      }
      if (code === 'session_unreachable') {
        res
          .status(503)
          .json({ error: 'That session is not reachable right now', code });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    void audit?.record({ action: 'subagent_cancelled', actorTokenId, target });

    // The daemon's verdict is passed through rather than assumed true: a 200
    // carrying `cancelled: false` is information, not a success to dress up.
    res.status(200).json({ sessionId, subagentRef, cancelled });
  };
}
