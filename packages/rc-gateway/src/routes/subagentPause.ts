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
 * POST /session/:id/subagents/:subagentRef/pause - pause ONE running background
 * subagent cleanly without emitting a terminal task-notification (#267).
 */
export function createSubagentPauseRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const subagentRef = req.params.subagentRef;
    const actorTokenId = req.rcClient?.id;
    const target = sessionId + ':' + subagentRef;

    let done: Awaited<ReturnType<SessionDaemon['pauseSubagentSession']>>;
    try {
      done = await daemon.pauseSubagentSession(sessionId, subagentRef);
    } catch (err) {
      sendSubagentControlError({
        res,
        err,
        op: 'pause',
        auditAction: 'subagent_pause_failed',
        actorTokenId,
        target,
        audit,
      });
      return;
    }

    if (done.outcome === 'paused') {
      void audit?.record({
        action: 'subagent_paused',
        actorTokenId,
        target,
      });
      res.status(200).json({
        sessionId,
        subagentRef,
        taskId: done.taskId,
        outcome: 'paused',
        status: done.status,
        ...(done.agentId !== undefined ? { agentId: done.agentId } : {}),
      });
      return;
    }

    void audit?.record({
      action: 'subagent_pause_failed',
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
