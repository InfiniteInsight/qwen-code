/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { BTW_MAX_INPUT_LENGTH } from '@qwen-code/qwen-code-core';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { isValidSessionId } from '../sessions/chatsPath.js';
import { relayDaemonAuthFailure } from './daemonAuth.js';

/**
 * The daemon's "this id resolves to no session, or to a workspace that is not
 * active right now" 404: `{ code: 'session_not_found' }` with no
 * `toolCallId` on it.
 *
 * Written against the shape rather than with the SDK's own
 * `isSessionLevelNotFound`, which encodes the same rule, because that guard
 * starts with `error instanceof DaemonHttpError` and the identity test fails
 * here. The live `DaemonClient` is loaded from the built bundle while this
 * package's import of the class resolves elsewhere, so the two are different
 * class objects wearing one name: a probe through the real client reported
 * `name === 'DaemonHttpError'` and `instanceof DaemonHttpError === false`, with
 * a minified prototype on one side. `status` and `body` are plain fields on the
 * error and arrive intact, so reading them works whatever the bundler decided,
 * and a rule that silently never fires is worse than a rule written twice.
 */
function isDaemonSessionNotFound(err: unknown): boolean {
  const e = err as { status?: unknown; body?: unknown } | null;
  if (!e || e.status !== 404) return false;
  const body = e.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return false;
  }
  const record = body as Record<string, unknown>;
  if (record['code'] !== 'session_not_found') return false;
  // A 404 that names a tool call is about a missing subagent rather than
  // about this conversation, which is a different problem to report.
  return record['toolCallId'] === undefined || record['toolCallId'] === null;
}

/**
 * POST /session/:id/btw - ask one conversation a side question without putting
 * the question, or the answer, into it.
 *
 * WHY THIS IS A WRITE AND RECAP IS A READ
 *
 * Both cost a model call and neither mutates session state, so the two look
 * alike and get treated differently on purpose. A recap is a reduction of
 * content the reader can already pull down through `GET /session/:id/transcript`,
 * which is why #107 could file it as SESSION_READ: it reveals nothing the
 * transcript does not. A side question reveals something the transcript does
 * not hold. The caller supplies a question and the model answers it from the
 * conversation's context, and the answer is deliberately never written to the
 * transcript, so there is no read the caller could have done instead. Under the
 * #107 rule that makes it the same kind of act as a prompt, and it sits at
 * WRITE beside one.
 *
 * WHY IT IS RATE LIMITED
 *
 * The daemon bounds the question at BTW_MAX_INPUT_LENGTH characters and bounds
 * nothing else. There is no per-session or per-caller budget on how many side
 * questions may be asked, so the only thing between a phone being tapped
 * repeatedly and a model call per tap is this limiter. `subActorBan` comes
 * first so a banned chat user is refused before any budget is spent, and the
 * limiter is the same one a prompt and a recap go through, because what it
 * guards is the spending rather than the revealing. Like the recap, it keys
 * on the token when no sub-actor is asserted (#165), so the cap binds every
 * caller and not only a bridge.
 *
 * WHY THE CLIENT DISCONNECT IS PROPAGATED, WHICH THE PROMPT ROUTE DELIBERATELY
 * DOES NOT DO
 *
 * `prompt.ts` refuses to cancel on a client disconnect, and that is correct
 * over there (#38): a prompt's output is a turn that belongs to the
 * conversation, so a backgrounded phone still has it waiting when it comes
 * back. A side answer has nowhere to wait. It is not in the transcript, it is
 * not in any store, and the only place it can appear is the box that asked for
 * it. If that box is gone, finishing the generation produces a fact nobody will
 * ever read, at the cost of the tokens it takes to produce it.
 *
 * The daemon already takes this position on its own route: it builds an
 * `AbortController` and aborts it from `res.once('close')`
 * (packages/cli/src/serve/routes/session.ts:9894), so it stops the generation
 * when its caller hangs up. The gateway is that caller. A relay that swallowed
 * the disconnect would leave a generation running against a daemon that was
 * waiting for a signal the gateway never sent, which is the one case where
 * being a polite middleman costs more than being an honest one.
 *
 * So the abort is wired to the response's `close` and handed to the pool as a
 * signal, and an abort that arrives while the answer is on its way is not an
 * error to report. The response is already unsendable and the caller has
 * already moved on.
 *
 * WHY THE LENGTH CAP IS IMPORTED RATHER THAN COPIED
 *
 * The number is the daemon's, defined once at
 * `packages/core/src/utils/btwUtils.ts:14` and re-exported from the core entry.
 * The channels layer copied it as `CHANNEL_BTW_MAX_INPUT_LENGTH`
 * (packages/channels/base/src/ChannelBase.ts:429), which is a second place to
 * remember. This route takes the original, so a question this gateway refuses
 * for length is a question the daemon would also have refused, and the two
 * cannot drift apart.
 *
 * WHY A NULL ANSWER IS A SUCCESS
 *
 * `DaemonSessionBtwResult.answer` is `string | null`
 * (packages/sdk-typescript/src/daemon/types.ts:4513). The pair is relayed
 * untouched, because "the model had nothing to say about that" and "the request
 * failed" are different facts and the gateway is not the thing that can tell
 * them apart. The page gives the first one its own sentence rather than drawing
 * an empty bubble.
 *
 * WHAT A 404 MEANS HERE, WHICH IS NOT WHAT IT MEANS FOR RECAP
 *
 * The recap route reads any 404 as a daemon from before that route existed,
 * because that is what the SDK documents for it. That reading does not
 * transfer, and copying it would have been a quiet lie. The daemon's own
 * session guard answers 404 with `code: 'session_not_found'`
 * (packages/cli/src/serve/routes/session-runtime.ts:101), reached through
 * `withOwnerMutableSession`, which is what guards this route. So a 404 here has
 * two causes with opposite meanings, and they are told apart by the body, on
 * the same rule the SDK's `isSessionLevelNotFound` encodes. It is re-expressed
 * here rather than called because that guard's first test is an `instanceof`
 * against a class that has two identities in this build; see the note on
 * `isDaemonSessionNotFound`.
 *
 * That rule carries a second reason not to answer 404: the SDK documents that
 * the same shape is also produced while an owning workspace is merely not
 * active, draining before removal or transitioning to a replacement runtime,
 * and says to treat it as recoverable rather than as proof the session is
 * permanently gone. Since the gateway cannot tell the reversible case from the
 * real one, it reports the recoverable reading of the pair, 409
 * `session_not_loaded`, the same code a session the pool holds no binding for
 * already raises. Telling a phone its conversation is deleted because a
 * workspace was mid-drain would send it to look somewhere the problem is not.
 *
 * A 404 with nothing behind it is the third case, a daemon with no btw route,
 * reported as 502 `btw_unsupported` so the phone learns the daemon is old
 * rather than that the conversation is missing.
 *
 * A malformed id never reaches any of these. It is refused locally before any
 * daemon call, exactly as the sibling reads do.
 *
 * WHAT IS AUDITED
 *
 * A row is written only when an answer actually came back. The row names the
 * session and never the question or the answer: the question is the caller's
 * words and the answer is a reduction of the conversation, and the rule carried
 * through #107 and the attachment family is that conversation content stays out
 * of the record.
 */
export function createSessionBtwRoute(
  daemon: Pick<SessionDaemon, 'btwSession'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id before any daemon call,
    // exactly as the transcript, turn-index and recap routes do.
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const actorTokenId = req.rcClient?.id;

    const body = (req.body ?? {}) as { question?: unknown };
    const question = body.question;
    // Checked here rather than left to the daemon so a question that is far too
    // long costs a local comparison instead of a round trip. The bound is the
    // daemon's own constant, imported, so the two cannot disagree; see the
    // module note.
    if (
      typeof question !== 'string' ||
      question.trim().length === 0 ||
      question.length > BTW_MAX_INPUT_LENGTH
    ) {
      res.status(400).json({
        error: `\`question\` is required, must be a non-empty string, and at most ${BTW_MAX_INPUT_LENGTH} characters`,
        code: 'question_invalid',
      });
      return;
    }

    // The caller hanging up ends the request, because the answer has nowhere
    // else to go. See the module note on why this is the opposite of the
    // prompt route's rule and why both are right.
    //
    // Listened for on the RESPONSE, not the request. A request's `close` fires
    // when its readable side finishes, which for a body this small is before
    // the daemon has even been called, so watching it aborts the route's own
    // call on every request that goes perfectly well. The response's `close`
    // fires both when an answer was delivered and when the connection died
    // early, so `writableEnded` is what tells the two apart. Same guard the
    // daemon puts on its own side of this call, for the same reason
    // (packages/cli/src/serve/routes/session.ts:9894), and the same listener
    // the slash-command route uses for the same shape of wait
    // (packages/rc-gateway/src/routes/commands.ts:211).
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    let result: unknown;
    try {
      result = await daemon.btwSession(sessionId, question, {
        signal: abort.signal,
      });
    } catch (err) {
      // The caller stopped listening. There is no response to send and nothing
      // to report to anyone; the daemon stopped generating for the same reason.
      if (abort.signal.aborted) return;
      if (relayDaemonAuthFailure(res, err, 'btw')) return;
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        if (status === 404) {
          // Two causes, opposite meanings, told apart by the body. The rule is
          // non-obvious: the daemon answers this shape both for an id that
          // resolves to no session and for an owning workspace that is merely
          // not active right now, and documents the second as reversible. So
          // this is reported as the recoverable code it is, never as a
          // conversation that has gone missing. See the note on the helper.
          if (isDaemonSessionNotFound(err)) {
            res.status(409).json({
              error: 'This conversation is not answering right now',
              code: 'session_not_loaded',
            });
            return;
          }
          // A 404 with nothing behind it is a daemon with no btw route at all.
          // Reported as 502 rather than as a missing conversation, because
          // telling a phone the conversation is gone when the daemon is merely
          // old sends it to look in the wrong place.
          res.status(502).json({
            error: 'Daemon does not support side questions',
            code: 'btw_unsupported',
          });
          return;
        }
        res.status(status).json({
          error: 'Daemon rejected the side question',
          code: 'daemon_rejected',
        });
        return;
      }
      if (err instanceof UnknownSessionError) {
        res.status(409).json({
          error: 'Open this conversation before asking it a side question',
          code: 'session_not_loaded',
        });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    // The pair is the daemon's answer about its own conversation, so it travels
    // as it arrived. `answer: null` stays a 200; see the module note.
    const answer = (result as { answer?: unknown } | null)?.answer;
    if (typeof answer === 'string' && answer.length > 0) {
      void audit?.record({
        action: 'session_btw_answered',
        actorTokenId,
        target: sessionId,
      });
    }

    res.status(200).json(result as object);
  };
}
