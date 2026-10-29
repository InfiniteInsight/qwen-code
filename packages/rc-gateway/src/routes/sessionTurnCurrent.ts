/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * GET /session/:id/turns/current - relay the daemon's answer about the turn a
 * conversation is on right now (#131).
 *
 * The daemon answers with its `BridgeTurnStatus`: the running turn, else the
 * oldest queued one, else the newest ended one, else `{ state: 'idle' }`. The
 * body travels untouched, because the daemon owns the vocabulary (`state`,
 * `startedAt`, `queuedAt`, `promptText`, `stopReason`) and a gateway summary
 * would read as authority over a shape it does not own. The caller decides what
 * "live" means from `state`; this route does not filter an ended turn out,
 * since "the last turn ended at T" is also an answer.
 *
 * What the daemon does NOT report here is a phase or the tools run so far. That
 * record is the turn's identity and clock, nothing more; tool calls are in the
 * transcript. A caller that wants them has to ask for the transcript.
 *
 * Read-scoped, bare namespace (1:1 with the daemon's own route). Not audited:
 * a page polls this every few seconds while a sheet is open, and a row per
 * poll would bury the rows that mean something.
 *
 * Failures, none of them a laundered 502:
 *  - a daemon 404 that carries `session_not_found` is the daemon answering
 *    about this id, and relays as 404;
 *  - a bare 404 with no code is a daemon that predates the route, which is not
 *    a missing session, and maps to 502 `turns_unsupported` so a caller can
 *    tell the two apart;
 *  - the pool no longer holding the session is 409 `session_not_loaded`: the
 *    turns are on disk, what is missing is the binding to the daemon.
 */
export function createSessionTurnCurrentRoute(
  daemon: Pick<SessionDaemon, 'getCurrentSessionTurn'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Same malformed-id gate as the sibling session reads, before any daemon call.
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    try {
      const turn = await daemon.getCurrentSessionTurn(sessionId);
      res.status(200).json(turn);
    } catch (err) {
      if (err instanceof UnknownSessionError) {
        res.status(409).json({
          error: 'Open this conversation before reading its current turn',
          code: 'session_not_loaded',
        });
        return;
      }
      const status = (err as { status?: unknown }).status;
      if (status === 404) {
        const body = (err as { body?: unknown }).body as
          | { code?: unknown }
          | undefined;
        if (body?.code === 'session_not_found') {
          res
            .status(404)
            .json({ error: 'Session not found', code: 'session_not_found' });
          return;
        }
        res.status(502).json({
          error: 'Daemon does not support the current-turn route',
          code: 'turns_unsupported',
        });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}
