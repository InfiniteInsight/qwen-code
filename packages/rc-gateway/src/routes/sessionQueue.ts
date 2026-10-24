/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

/**
 * The visible queue (add-capability-parity #110, second slice).
 *
 *   GET    /session/:id/pending-prompts                -> the daemon's list
 *   DELETE /session/:id/pending-prompts/:promptId      -> drop one, or cancel
 *                                                         the running one
 *   GET    /session/:id/mid-turn-messages              -> the daemon's
 *                                                         reconciliation snapshot
 *   DELETE /session/:id/mid-turn-messages/:messageId   -> withdraw one before
 *                                                         it is delivered
 *
 * WHY THIS EXISTS AT ALL
 *
 * Issue #84 is that a prompt admitted during an active turn is accepted with
 * 202 and then discarded. That is a daemon bug and it is not fixed here. What
 * is fixed here is the second half of the same complaint: with no route, the
 * queue is invisible, so a user cannot tell a queued prompt from a lost one.
 * The issue says it plainly, that a queue the user can see is the honest
 * counterpart to that bug. These four routes are that counterpart. They report
 * what the daemon holds; they do not promise it will be delivered.
 *
 * WHY THE PAYLOAD IS THE DAEMON'S, UNTOUCHED
 *
 * `getPendingPrompts` returns `DaemonPendingPromptsResult` and
 * `getMidTurnMessages` returns `DaemonMidTurnMessagesResult`, both of which
 * carry fields the daemon owns and may extend: each pending prompt's `state`
 * (`running` or `queued`), the mid-turn snapshot's bounded terminal id rings.
 * A gateway-side summary would read as authority over a shape it does not own,
 * and would silently drop whatever the daemon adds. So every field travels.
 *
 * WHY A BARE 404 IS NOT AN ANSWER ABOUT A MESSAGE
 *
 * The SDK documents that `getMidTurnMessages` is only available when the daemon
 * advertises `session_mid_turn_message_query`, and that older daemons answer
 * 404. A 404 carrying no fs envelope is therefore a daemon that predates these
 * routes, not a queue that is empty or a message that is missing, and the two
 * need different answers from a caller. It maps to 502 `queue_unsupported`.
 * A 404 that does carry an envelope is the daemon answering about an id, and
 * relays as itself.
 *
 * WHY A REMOVAL IS AUDITED AND A LOOK IS NOT
 *
 * Dropping a queued prompt destroys something the user was owed: it aborts a
 * queued prompt so the FIFO skips it, or cancels the running one. That is a
 * state change with a consequence, so it gets a row naming the session. A read
 * gets none, matching the sibling reads in #107 and #109. The prompt and
 * message ids are the daemon's handles rather than user content, but they are
 * still not what the row is for, so the row names only the session.
 */

interface FsErrorBody {
  errorKind?: unknown;
  error?: unknown;
  hint?: unknown;
}

/**
 * Refusal mapping for the queue family. Deliberately not shared with the
 * attachment routes: the bare-404 verdict names a different capability, and
 * folding the two together would report a daemon that predates the queue
 * routes as one that predates the attachment routes.
 */
function sendQueueError(res: Response, err: unknown): void {
  if (res.headersSent) return;
  const status = (err as { status?: unknown }).status;
  const body = (err as { body?: unknown }).body as FsErrorBody | undefined;
  const kind = typeof body?.errorKind === 'string' ? body.errorKind : undefined;
  const message = typeof body?.error === 'string' ? body.error : undefined;
  const hint = typeof body?.hint === 'string' ? body.hint : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    if (status === 404 && kind === undefined) {
      res.status(502).json({
        error: 'Daemon does not support the session queue routes',
        code: 'queue_unsupported',
      });
      return;
    }
    res.status(status).json({
      error: message ?? 'Daemon rejected the request',
      code: kind ?? 'daemon_rejected',
      ...(hint !== undefined ? { hint } : {}),
    });
    return;
  }
  res.status(502).json({
    error: 'Daemon unavailable',
    code: 'daemon_unavailable',
  });
}

/**
 * GET /session/:id/pending-prompts - the daemon's per-session queue, including
 * the currently running prompt and any FIFO-waiting ones. An empty array is a
 * real answer, not a failure: nothing is pending.
 */
export function createPendingPromptsRoute(
  daemon: Pick<SessionDaemon, 'getPendingPrompts'>,
): RequestHandler {
  return async (req, res) => {
    try {
      const result = await daemon.getPendingPrompts(req.params.id);
      res.status(200).json(result);
    } catch (err) {
      sendQueueError(res, err);
    }
  };
}

/**
 * DELETE /session/:id/pending-prompts/:promptId - drop one prompt from the
 * queue. The daemon's own answer travels, including `{ removed: false }` for an
 * id it does not hold, which is a 200 rather than a 404 because the daemon
 * chose to answer rather than refuse.
 */
export function createPendingPromptRemoveRoute(
  daemon: Pick<SessionDaemon, 'removePendingPrompt'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    try {
      const result = await daemon.removePendingPrompt(
        sessionId,
        req.params.promptId,
      );
      void audit?.record({
        action: 'pending_prompt_removed',
        actorTokenId: req.rcClient?.id,
        target: sessionId,
      });
      res.status(200).json(result);
    } catch (err) {
      sendQueueError(res, err);
    }
  };
}

/**
 * GET /session/:id/mid-turn-messages - the daemon's reconciliation snapshot:
 * messages still waiting plus the bounded terminal id rings.
 */
export function createMidTurnMessagesRoute(
  daemon: Pick<SessionDaemon, 'getMidTurnMessages'>,
): RequestHandler {
  return async (req, res) => {
    try {
      const result = await daemon.getMidTurnMessages(req.params.id);
      res.status(200).json(result);
    } catch (err) {
      sendQueueError(res, err);
    }
  };
}

/**
 * DELETE /session/:id/mid-turn-messages/:messageId - withdraw a typed message
 * before the daemon delivers it.
 */
export function createMidTurnMessageRemoveRoute(
  daemon: Pick<SessionDaemon, 'removeMidTurnMessage'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    try {
      const result = await daemon.removeMidTurnMessage(
        sessionId,
        req.params.messageId,
      );
      void audit?.record({
        action: 'mid_turn_message_withdrawn',
        actorTokenId: req.rcClient?.id,
        target: sessionId,
      });
      res.status(200).json(result);
    } catch (err) {
      sendQueueError(res, err);
    }
  };
}
