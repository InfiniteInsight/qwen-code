/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { sendSubagentControlError } from './subagentFailure.js';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

/**
 * POST /session/:id/subagents/:subagentRef/abandon - discard ONE paused
 * background subagent and mark its sidecar cancelled (#267).
 */
export function createSubagentAbandonRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const subagentRef = req.params.subagentRef;
    const actorTokenId = req.rcClient?.id;
    const target = sessionId + ':' + subagentRef;

    let done: Awaited<ReturnType<SessionDaemon['abandonSubagentSession']>>;
    try {
      done = await daemon.abandonSubagentSession(sessionId, subagentRef);
    } catch (err) {
      sendSubagentControlError({
        res,
        err,
        op: 'abandon',
        auditAction: 'subagent_abandon_failed',
        actorTokenId,
        target,
        audit,
      });
      return;
    }

    if (done.outcome === 'abandoned') {
      void audit?.record({
        action: 'subagent_abandoned',
        actorTokenId,
        target,
      });
      res.status(200).json({
        sessionId,
        subagentRef,
        taskId: done.taskId,
        outcome: 'abandoned',
        status: done.status,
      });
      return;
    }

    void audit?.record({
      action: 'subagent_abandon_failed',
      actorTokenId,
      target,
      detail: {
        code: done.code,
        reason: done.reason,
      },
    });
    res.status(200).json({
      sessionId,
      subagentRef,
      taskId: done.taskId,
      outcome: 'refused',
      code: done.code,
      reason: done.reason,
      ...(done.status !== undefined ? { status: done.status } : {}),
    });
  };
}
