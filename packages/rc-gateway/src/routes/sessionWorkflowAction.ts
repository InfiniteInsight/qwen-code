/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import {
  UnknownSessionError,
  type SessionDaemon,
  type WorkflowControlAction,
} from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { asDaemonHttpError } from '../daemonHttpError.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * The controls this route relays, as a value (not only a type) because it has
 * to refuse anything else BEFORE the call: a daemon 400 would surface as a
 * throw and read as `502 daemon_unavailable`, the gateway accusing itself of
 * being down over a mistyped body field.
 *
 * The daemon's own vocabulary is these five plus `run-saved` and `run-script`
 * (packages/cli/src/serve/routes/session.ts, the `workflow-action` handler).
 * Those two START a run, `run-script` from source text the caller supplies,
 * which is a way to run code that this route's write scope should not be. They
 * are refused here with their own code, so a caller learns they exist and are
 * withheld rather than being told the word is unknown. There is no `approve`:
 * a run's approvals are the session's permission votes, not a workflow action.
 */
const CONTROL_ACTIONS: readonly WorkflowControlAction[] = [
  'pause',
  'resume',
  'retry',
  'rerun',
  'delete-history',
];
const START_ACTIONS: readonly string[] = ['run-saved', 'run-script'];

/**
 * POST /session/:id/tasks/:taskId/workflow-action: control ONE workflow run.
 *
 * Write-scoped. Stopping a run is not here: `POST .../tasks/:taskId/cancel`
 * with `kind: "workflow"` already does that and reports the daemon's reason.
 *
 * The daemon's answer is relayed as it is: `{changed, status?, taskId?}`. A
 * `changed: false` has no reason, and the gateway invents none. It covers an
 * untrusted folder, workflows switched off, and a run that already moved on,
 * which the daemon does not tell apart, so neither does this route, and a
 * caller must not read it as "done".
 */
export function createSessionWorkflowActionRoute(
  daemon: Pick<SessionDaemon, 'sessionWorkflowTaskAction'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const taskId = req.params.taskId;
    const actorTokenId = req.rcClient?.id;
    const target = sessionId + ':' + taskId;

    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }

    const action = (req.body as { action?: unknown } | undefined)?.action;
    if (typeof action === 'string' && START_ACTIONS.includes(action)) {
      res.status(400).json({
        error: 'Starting a workflow run is not offered here',
        code: 'workflow_action_withheld',
      });
      return;
    }
    if (
      typeof action !== 'string' ||
      !CONTROL_ACTIONS.includes(action as WorkflowControlAction)
    ) {
      res.status(400).json({
        error:
          '`action` must be "pause", "resume", "retry", "rerun" or "delete-history"',
        code: 'invalid_workflow_action',
      });
      return;
    }

    let verdict: Awaited<ReturnType<SessionDaemon['sessionWorkflowTaskAction']>>;
    try {
      verdict = await daemon.sessionWorkflowTaskAction(
        sessionId,
        taskId,
        action as WorkflowControlAction,
      );
    } catch (err) {
      const status = asDaemonHttpError(err)?.status;
      const notFound = err instanceof UnknownSessionError || status === 404;
      void audit?.record({
        action: 'workflow_action_failed',
        actorTokenId,
        target,
        detail: { action, reason: notFound ? 'not_found' : 'daemon_unavailable' },
      });
      if (notFound) {
        res
          .status(404)
          .json({ error: 'Session not found', code: 'session_not_found' });
        return;
      }
      // The daemon's own message is never echoed: it can name a path.
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    void audit?.record({
      action: 'workflow_action',
      actorTokenId,
      target,
      detail: { action, changed: verdict.changed },
    });

    res.status(200).json({ sessionId, ...verdict });
  };
}
