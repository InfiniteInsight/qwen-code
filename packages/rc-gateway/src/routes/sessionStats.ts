/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * GET /session/:id/stats — relay the daemon's roll-up of one conversation:
 * how long it ran, how many prompts it took, what each model spent, which
 * tools were called, and how many lines were written.
 *
 * WHY THIS IS NOT A SECOND COPY OF /rc/usage
 *
 * `/rc/usage` reads the GATEWAY's own cost store, which only exists when a
 * usage store is wired and which reports money over a time window grouped by
 * session or model. This reports the DAEMON's accounting of one conversation:
 * prompt count, tool calls with their accept/reject decisions, lines added and
 * removed. Neither can answer the other's question, and when no usage store is
 * wired this is the only cost-shaped read the page has at all.
 *
 * WHY NOTHING HERE IS AUDITED
 *
 * The transcript and turn-index reads are audited because they carry
 * conversation text. This carries counts. The closest precedent is
 * `GET /session/:id/tasks`, which is passed through un-audited while relaying
 * shell `cwd` and `outputFile` paths - strictly more disclosing than a tool
 * call count. Auditing a number would add a row without naming anything a
 * reader could not already reach at the same scope.
 *
 * WHY A MISSING POOL BINDING IS 409 AND NOT 404
 *
 * `sessionStatus` and `sessionTasks` both answer `UnknownSessionError` with a
 * 404. This route follows `sessionTurnIndex` instead, because the pool keeps
 * its session-to-daemon map in memory and drops the entry when a session
 * dies, while the roll-up itself is built from data on disk. So a missing
 * binding is proof the gateway has no one to ask, not proof the conversation
 * is gone, and 404 would send a reader to look for a file that is still
 * there. `POST /session/:id/resume` restores the binding, which is what the
 * error text says to do.
 *
 * WHY A DAEMON 404 STAYS A 404
 *
 * `session_stats` is advertised `since: 'v1'`
 * (packages/cli/src/serve/capabilities.ts:162), so there is no daemon version
 * that lacks this route. That is the opposite of the recap read, where a bare
 * 404 had to be reported as `recap_unsupported` because the route is newer
 * than some daemons in the field. Here a 404 from the daemon can only mean
 * the conversation is not there, so it is relayed as one rather than
 * invented into a capability verdict.
 */
export function createSessionStatsRoute(
  daemon: Pick<SessionDaemon, 'sessionStats'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id before any daemon call -
    // mirrors the sibling session routes (context, status, tasks).
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    try {
      const status = await daemon.sessionStats(sessionId);
      res.status(200).json(status);
    } catch (err) {
      const daemonStatus = (err as { status?: unknown } | undefined)?.status;
      if (daemonStatus === 404) {
        res
          .status(404)
          .json({ error: 'Session not found', code: 'session_not_found' });
        return;
      }
      // Test the class rather than a text match: `UnknownSessionError` says
      // only "Unknown session: <id>", which a "not found" match would miss.
      if (err instanceof UnknownSessionError) {
        res.status(409).json({
          error: 'Open this conversation before reading its stats',
          code: 'session_not_loaded',
        });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}
