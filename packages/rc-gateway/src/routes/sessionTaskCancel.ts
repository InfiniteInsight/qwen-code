/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

type TaskKind = DaemonSessionTaskWithWorkflowStatus['kind'];

/**
 * The four kinds the daemon will stop, stated as a value (not only as the type)
 * because the route has to refuse anything else BEFORE the call. The daemon
 * answers a bad `kind` with a 400, the SDK surfaces that as a throw, and a
 * thrown daemon-400 reaching the catch below would be reported as
 * `502 daemon_unavailable` — the gateway accusing itself of being down because
 * a caller mistyped a body field. Refusing here is what keeps the two failures
 * distinguishable. Same set as the daemon's own guard
 * (packages/cli/src/serve/routes/session.ts:7451).
 */
const CANCELLABLE_KINDS: readonly TaskKind[] = [
  'agent',
  'shell',
  'monitor',
  'workflow',
];

/**
 * POST /session/:id/tasks/:taskId/cancel — stop ONE run while leaving the
 * session and every other run alive.
 *
 * This is the act half of the run log: D22 put the task list on the wire and
 * D24 drew it, so a reader could see a runaway shell or a stuck subagent but
 * could not stop it from the page. `taskId` is the id that row already prints,
 * so no new identifier is introduced — unlike `subagentCancel`, which reaches a
 * child through the PARENT's tool-call id.
 *
 * Write-scoped, and not owner-scoped at this layer, on the same reasoning as
 * the two cancels beside it: stopping one run is strictly less destructive than
 * stopping the turn, and anyone who can start a turn can stop part of it. The
 * daemon applies its own owner guard on top of this.
 *
 * The daemon's verdict is passed through rather than dressed up as success. A
 * `workflow` kind on an untrusted workspace answers
 * `{cancelled: false, reason: 'disabled'}`, which is a policy answer, not a
 * failure to reach the daemon, and a reader has to be able to tell them apart.
 *
 * A task that has already settled stays a 404 rather than becoming a 502, for
 * the reason `subagentCancel` records: the button and the run's completion race
 * by about one frame, so "it was already finished" is the common case.
 */
export function createSessionTaskCancelRoute(
  daemon: Pick<SessionDaemon, 'cancelSessionTask'>,
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

    const kind = (req.body as { kind?: unknown } | undefined)?.kind;
    if (
      typeof kind !== 'string' ||
      !CANCELLABLE_KINDS.includes(kind as TaskKind)
    ) {
      res.status(400).json({
        error: '`kind` must be "agent", "shell", "monitor", or "workflow"',
        code: 'invalid_task_kind',
      });
      return;
    }

    let verdict: { cancelled: boolean; reason?: string };
    try {
      verdict = await daemon.cancelSessionTask(
        sessionId,
        taskId,
        kind as TaskKind,
      );
    } catch (err) {
      const notFound =
        err instanceof UnknownSessionError ||
        (err as { status?: unknown } | undefined)?.status === 404;
      void audit?.record({
        action: 'task_cancel_failed',
        actorTokenId,
        target,
        detail: { reason: notFound ? 'not_found' : 'daemon_unavailable' },
      });
      if (notFound) {
        res
          .status(404)
          .json({ error: 'Session not found', code: 'session_not_found' });
        return;
      }
      // The daemon's own message is never echoed, so a workspace path cannot
      // ride it out to a reader.
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    void audit?.record({
      action: 'task_cancelled',
      actorTokenId,
      target,
      detail: { kind, cancelled: verdict.cancelled },
    });

    res.status(200).json({ sessionId, taskId, ...verdict });
  };
}
