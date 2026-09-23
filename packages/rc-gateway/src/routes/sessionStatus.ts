/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * GET /session/:id/status — relay the daemon's per-session status summary so
 * a remote client (the web UI's pending-card recovery) can reconstruct
 * question/permission cards that a dropped event stream lost. The payload is
 * the daemon's `DaemonSessionSummary`; its `pendingInteractions` array (when
 * present) holds the interactions still awaiting an answer, render-ready.
 *
 * Read-scoped, bare namespace (transparent-proxy topology — 1:1 with the
 * daemon's own `GET /session/:id/status`). The gateway holds the daemon token;
 * the daemon does the work. Not audited: a status read is a poll (like the
 * event stream's own idle polling) with no mutation.
 */
export function createSessionStatusRoute(
  daemon: Pick<SessionDaemon, 'sessionStatus'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id before any daemon call —
    // mirrors the sibling session routes (events, fork, rewind, context).
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    try {
      const status = await daemon.sessionStatus(sessionId);
      res.status(200).json(status);
    } catch (err) {
      // A session the daemon no longer knows is a 404, not the generic 502.
      // `DaemonHttpError` carries the daemon's numeric status; but
      // `UnknownSessionError` (pool has no record of the id) only says
      // "Unknown session: <id>", which a "not found" text match would miss,
      // so test the class explicitly.
      const notFound =
        err instanceof UnknownSessionError ||
        (err as { status?: unknown } | undefined)?.status === 404;
      if (notFound) {
        res
          .status(404)
          .json({ error: 'Session not found', code: 'session_not_found' });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}
