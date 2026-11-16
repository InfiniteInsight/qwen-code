/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { sendSubagentControlError } from './subagentFailure.js';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * POST /session/:id/subagents/:subagentRef/resume - resume ONE paused
 * background subagent with an optional first continuation instruction (#267).
 * Audit entries never record the message text itself.
 */
export function createSubagentResumeRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const subagentRef = req.params.subagentRef;
    const actorTokenId = req.rcClient?.id;
    const target = sessionId + ':' + subagentRef;

    const rawMessage = (req.body as { message?: unknown } | undefined)?.message;
    if (rawMessage !== undefined && typeof rawMessage !== 'string') {
      res.status(400).json({
        error: 'message must be a string when present',
        code: 'invalid_message',
      });
      return;
    }
    if (
      typeof rawMessage === 'string' &&
      Buffer.byteLength(rawMessage, 'utf8') > MAX_MESSAGE_BYTES
    ) {
      res.status(413).json({
        error: 'message too large',
        code: 'message_too_large',
      });
      return;
    }
    const trimmed = typeof rawMessage === 'string' ? rawMessage.trim() : '';
    const message = trimmed.length > 0 ? trimmed : undefined;

    let done: Awaited<ReturnType<SessionDaemon['resumeSubagentSession']>>;
    try {
      done = await daemon.resumeSubagentSession(
        sessionId,
        subagentRef,
        message,
      );
    } catch (err) {
      sendSubagentControlError({
        res,
        err,
        op: 'resume',
        auditAction: 'subagent_resume_failed',
        actorTokenId,
        target,
        audit,
      });
      return;
    }

    if (done.outcome === 'resumed') {
      void audit?.record({
        action: 'subagent_resumed',
        actorTokenId,
        target,
      });
      res.status(200).json({
        sessionId,
        subagentRef,
        taskId: done.taskId,
        outcome: 'resumed',
        status: done.status,
      });
      return;
    }

    void audit?.record({
      action: 'subagent_resume_failed',
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
