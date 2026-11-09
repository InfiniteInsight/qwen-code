/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { classifySubagentFailure } from './subagentFailure.js';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

/**
 * POST /session/:id/subagents/:subagentRef/message -- send a message to ONE
 * subagent (queueing onto a running child, resuming a paused child, or
 * continuing a completed child) while leaving the parent session's other work
 * untouched.
 *
 * `subagentRef` matches `task.id` or `task.toolUseId` on the daemon, matching
 * the sibling inspect and cancel routes. Audit records carry `target` and
 * `action`/`reason`, never the message text itself.
 */
export function createSubagentMessageRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const subagentRef = req.params.subagentRef;
    const actorTokenId = req.rcClient?.id;
    const target = sessionId + ':' + subagentRef;

    const rawMessage = (req.body as { message?: unknown } | undefined)?.message;
    const message = typeof rawMessage === 'string' ? rawMessage.trim() : '';
    if (!message) {
      res.status(400).json({
        error: 'message must be a non-empty string',
        code: 'invalid_message',
      });
      return;
    }

    let done: Awaited<ReturnType<SessionDaemon['messageSubagentSession']>>;
    try {
      done = await daemon.messageSubagentSession(
        sessionId,
        subagentRef,
        message,
      );
    } catch (err) {
      const code = classifySubagentFailure(err, subagentRef);
      void audit?.record({
        action: 'subagent_message_failed',
        actorTokenId,
        target,
        detail: { reason: code },
      });
      if (code === 'subagent_not_found') {
        res
          .status(404)
          .json({ error: 'Subagent not found in this session', code });
        return;
      }
      if (code === 'session_unreachable') {
        res
          .status(503)
          .json({ error: 'That session is not reachable right now', code });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    void audit?.record({
      action: done.delivered ? 'subagent_messaged' : 'subagent_message_failed',
      actorTokenId,
      target,
      ...(done.action || done.reason
        ? {
            detail: {
              ...(done.action ? { deliveryAction: done.action } : {}),
              ...(done.reason ? { reason: done.reason } : {}),
            },
          }
        : {}),
    });

    res.status(200).json({
      sessionId,
      subagentRef,
      delivered: done.delivered,
      ...(done.action ? { action: done.action } : {}),
      ...(done.status ? { status: done.status } : {}),
      ...(done.reason ? { reason: done.reason } : {}),
    });
  };
}
