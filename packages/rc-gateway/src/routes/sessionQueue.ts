/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { relayDaemonAuthFailure } from './daemonAuth.js';

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
  if (relayDaemonAuthFailure(res, err, 'queue')) return;
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

/**
 * POST /session/:id/mid-turn-message - put one message into the daemon's
 * mid-turn queue, and POST /session/:id/mid-turn-messages/send-now - ask the
 * agent to cut a streaming response and drain what is already queued.
 *
 * WHY THE WRITE HALF MATTERS WHEN THE READ HALF ALREADY EXISTED
 *
 * The read routes (this module's first four) made the queue visible, which is
 * what #110 asked for and what #84's counterpart needed. Visibility was the
 * whole bar and it is met. What they left is an asymmetry the panel states out
 * loud: its help text says withdrawing a message is "the only way to take it
 * back", which is only true because nothing in this gateway can put a message
 * IN. So a phone user watching a long turn has exactly one option for something
 * they meant to add -- wait for the turn to end, or cancel it. The daemon's own
 * queue drains between tool batches (`craft/drainMidTurnQueue`), so the model
 * would have seen the message before the turn ended. That path exists on the
 * daemon and was simply never reachable here.
 *
 * This does not touch the composer. #70 decided, deliberately, that queueing in
 * the chat UI is its own client-side control rather than an inverted Send, and
 * that stands; see the ledger. These two routes belong to the ops panel, which
 * is the surface that already shows this queue.
 *
 * WHY `accepted: false` IS A 200 AND NOT AN ERROR
 *
 * `DaemonMidTurnMessageResult` is `{ accepted, messageId?, reason? }`, and the
 * SDK documents `reason: 'session_idle'` as "an open session has no prompt
 * admitted to its prompt FIFO and no active Goal turn, which lets a client
 * resubmit as an ordinary prompt instead of reporting a failure". That is a
 * verdict about the session, delivered by a daemon that answered fully and
 * correctly. Answering 502 to it would be the exact failure the queue routes
 * exist to prevent: the caller could not tell "the turn just ended, send it
 * normally" from "the daemon is down". So the daemon's body travels verbatim at
 * 200, including `accepted: false`, and only a transport-level failure or a
 * daemon refusal becomes an error status. `sendMidTurnMessagesNow` is the same
 * shape: `{ requested: false }` means nothing was waiting, which is an answer.
 *
 * WHY ONLY THE SHAPE IS CHECKED, NOT THE LENGTH
 *
 * The daemon owns `MID_TURN_MESSAGE_MAX_LENGTH` (16 KiB,
 * `packages/cli/src/serve/routes/session.ts:9957`) and answers its own 400 over
 * it. Re-imposing the number here would put the same limit in two files that
 * can drift, and the second one to change would be wrong in silence. What the
 * gateway does check is the shape -- a `message` that is not a non-empty
 * trimmed string is not a message, and sending it would spend a session round
 * trip to learn something already known.
 *
 * WHY THE AUDIT ROW NEVER CARRIES THE TEXT
 *
 * The queued text is user chat content. The sibling removal records only the
 * session id, and the same rule applies with more force here, since this is the
 * route that handles the text itself: an audit trail that stores message bodies
 * is a transcript in a place that was never designed to hold one, replicated to
 * every reader of the log. So the row names the session, and a test asserts the
 * text is absent rather than asserting the row looks reasonable.
 *
 * WHY THE ENQUEUE IS RATE-LIMITED AND THE DRAIN IS NOT
 *
 * An enqueue is a chat act with a body, exactly like `POST /session/:id/prompt`,
 * so it carries the same `subActorRateLimit` (bridge fan-in) that the prompt
 * route does. Draining is a nudge over something already admitted -- it adds no
 * content and cannot grow the queue -- so it follows the cancel and withdraw
 * routes above, which are deliberately not rate-limited: throttling a control
 * act punishes the operator for reacting to a problem they are trying to close.
 */

interface MidTurnEnqueueBody {
  message?: unknown;
  messageId?: unknown;
}

/**
 * Parse the enqueue body. Returns the trimmed message and an optional
 * caller-supplied id, or a short code naming what was wrong. A `messageId` that
 * is not a string is ignored rather than rejected: it is an idempotency hint,
 * and a caller that sent a junk one still said what it meant to say.
 */
function parseMidTurnEnqueue(body: unknown): {
  message?: string;
  messageId?: string;
  error?: string;
} {
  const src = (body ?? {}) as MidTurnEnqueueBody;
  const raw = typeof src.message === 'string' ? src.message.trim() : '';
  if (raw === '') return { error: 'invalid_message' };
  const messageId =
    typeof src.messageId === 'string' && src.messageId.trim() !== ''
      ? src.messageId.trim()
      : undefined;
  return { message: raw, messageId };
}

export function createMidTurnMessageEnqueueRoute(
  daemon: Pick<SessionDaemon, 'enqueueMidTurnMessage'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const parsed = parseMidTurnEnqueue(req.body);
    if (parsed.error !== undefined) {
      res.status(400).json({
        error: 'A non-empty `message` string is required',
        code: parsed.error,
      });
      return;
    }
    try {
      const result = await daemon.enqueueMidTurnMessage(
        sessionId,
        parsed.message as string,
        parsed.messageId === undefined
          ? undefined
          : { messageId: parsed.messageId },
      );
      void audit?.record({
        action: 'mid_turn_message_queued',
        actorTokenId: req.rcClient?.id,
        target: sessionId,
      });
      res.status(200).json(result);
    } catch (err) {
      sendQueueError(res, err);
    }
  };
}

export function createMidTurnMessagesSendNowRoute(
  daemon: Pick<SessionDaemon, 'sendMidTurnMessagesNow'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    try {
      const result = await daemon.sendMidTurnMessagesNow(sessionId);
      void audit?.record({
        action: 'mid_turn_messages_sent_now',
        actorTokenId: req.rcClient?.id,
        target: sessionId,
      });
      res.status(200).json(result);
    } catch (err) {
      sendQueueError(res, err);
    }
  };
}
