/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { isValidSessionId } from '../sessions/chatsPath.js';
import { WRITE, hasScope } from '../scopes.js';

/**
 * GET /session/:id/tasks — relay the daemon's task list, which is the run log
 * this issue's title calls the "runs" half: every agent, shell, monitor and
 * workflow the session has going or has finished.
 *
 * Read-scoped, bare namespace (transparent-proxy topology — 1:1 with the
 * daemon's own `GET /session/:id/tasks`). Not audited: a task read is a poll
 * with no mutation, like the status and context reads beside it.
 *
 * Workflow runs are listed for owner and write tokens only (#110, the user's
 * decision of 2026-10-30): for those the daemon is asked with its
 * `includeWorkflows` opt-in, for everyone else it is not. The daemon adds
 * them only on a trusted workspace even then.
 *
 * The payload is passed through verbatim, including each shell task's `cwd` and
 * `outputFile`. That is a deliberate call, not an oversight, and it is recorded
 * on the pool method: `GET /session/:id/context` already relays the workspace
 * cwd to this same read scope, so nothing reaches a reader here that it cannot
 * already ask for.
 *
 * A session the daemon has dropped stays a 404. Flattening it to 502 would tell
 * someone looking at a finished conversation that the gateway is broken, which
 * is the exact failure this issue is filed against.
 */
export function createSessionTasksRoute(
  daemon: Pick<SessionDaemon, 'sessionTasks' | 'sessionWorkflowTasks'>,
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
      // #110: workflow rows carry a run's prompts, logs, output path and
      // approvals, which is more than the agent, shell and monitor rows say.
      // The user's call (2026-10-30) is that only owner and write tokens get
      // them, so the daemon is asked to expand them only for those. A reader,
      // an approve-only token and a share link (session-locked, never write)
      // get the list as it was before: the daemon's default shape, which has
      // no workflow rows. Scope decides the QUERY, not a filter on the answer,
      // so a reader's request never makes the daemon assemble the rows.
      const scopes = req.rcClient?.scopes;
      const mayHaveWorkflows =
        Array.isArray(scopes) &&
        req.rcClient?.sessionLockId === undefined &&
        hasScope(scopes, WRITE);
      const status = mayHaveWorkflows
        ? await daemon.sessionWorkflowTasks(sessionId)
        : await daemon.sessionTasks(sessionId);
      res.status(200).json(status);
    } catch (err) {
      // `UnknownSessionError` says only "Unknown session: <id>", which a
      // "not found" text match would miss, so test the class explicitly —
      // same as sessionStatus.ts.
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
