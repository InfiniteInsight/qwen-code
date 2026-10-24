/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * GET /session/:id/context-usage — relay the daemon's per-session context
 * USAGE so the status footer can show how full the context window actually
 * is. The payload is the daemon's `DaemonSessionContextUsageStatus` verbatim:
 * `usage.totalTokens` (what the window currently holds), `usage
 * .contextWindowSize`, a per-category `breakdown`, and `usage.isEstimated`.
 *
 * This is NOT the sibling `GET /session/:id/context`. That route reports the
 * session's CONFIGURED state (available models and their limits, approval
 * modes, cwd); this one reports how much of a window the live conversation
 * occupies. The two share no fields, so neither call can stand in for the
 * other.
 *
 * `?detail=true` is passed through to the daemon, which answers with the
 * per-tool / per-memory-file / per-skill lists. The footer does not ask for
 * it: those lists are the payload's bulk and nothing on this page renders
 * them.
 *
 * Read-scoped, bare namespace (transparent-proxy topology — 1:1 with the
 * daemon's own `GET /session/:id/context-usage`). Not audited: a usage read
 * is a status poll, identical in kind to `GET /session/:id/context`.
 */
export function createSessionContextUsageRoute(
  daemon: SessionDaemon,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id before any daemon call —
    // mirrors the sibling session routes (context, status).
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    try {
      const status = await daemon.sessionContextUsage(sessionId, {
        detail: req.query['detail'] === 'true',
      });
      res.status(200).json(status);
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}
