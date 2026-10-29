/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { isValidSessionId } from '../sessions/chatsPath.js';
import { relayDaemonAuthFailure } from './daemonAuth.js';

/**
 * POST /session/:id/recap - ask the daemon for its one-sentence "where did I
 * leave off" summary of one conversation.
 *
 * WHY THIS IS A POST THAT STILL READS
 *
 * The daemon's own route is `POST /session/:id/recap` and its SDK wrapper is
 * `DaemonClient.recapSession` (packages/sdk-typescript/src/daemon/DaemonClient.ts:4402).
 * It is a POST because it costs tokens: the daemon runs a side-query against
 * the fast model. It mutates no state, which is why the daemon gates it
 * non-strictly, the same posture it gives `/session/:id/prompt`. The gateway
 * keeps the verb rather than inventing a GET that would read as cacheable,
 * because nothing about a model call is cacheable and a second press is
 * supposed to ask again.
 *
 * WHY THE SCOPE IS SESSION_READ AND NOT WRITE
 *
 * The prompt sits at WRITE because it puts a new turn into someone else's
 * conversation. A recap puts nothing anywhere: the sentence it returns is a
 * reduction of content the reader can already pull down through
 * `GET /session/:id/transcript`, which sits at SESSION_READ for exactly that
 * reason. Raising this to WRITE would mean a reader with the transcript could
 * see the conversation but not be told what it was about, which is a
 * distinction without a difference.
 *
 * WHY IT IS STILL RATE LIMITED
 *
 * The rate limiter that a stop request is exempt from applies here, because a
 * recap costs a model call and a phone could be tapped repeatedly. Being a read
 * is about what it reveals; the cap is about what it spends, and the two
 * questions have different answers. `subActorBan` comes first so a banned chat
 * user is refused before any budget is spent. The limiter keys on the asserted
 * sub-actor for a bridge and on the token for everyone else (#165): keyed on
 * sub-actors alone it passed every non-bridge caller, so a view-only guest
 * could loop one model call per request.
 *
 * WHY NO TIMEOUT IS APPLIED HERE
 *
 * `recapSession` deliberately skips the SDK's per-call `fetchTimeoutMs` wrapper
 * because the side-query can take longer than the 30s default under a slow
 * model, and the bridge waits on a 60s backstop of its own. Adding a gateway
 * timeout shorter than either would cut off a recap that was going to arrive,
 * which is a worse answer than a slow one: the reader would see a failure for a
 * request the daemon is still working on.
 *
 * WHY A NULL RECAP IS A SUCCESS
 *
 * The core helper is best-effort and never throws. It answers `recap: null`
 * when the conversation has fewer than two turns, when the side-query produced
 * nothing extractable, and when the model failed. All three come back as a 200.
 * That pair is relayed untouched, because "there is nothing to say yet about
 * this conversation" and "the model could not answer" are different facts and
 * the gateway is not the thing that can tell them apart.
 *
 * WHAT A 404 MEANS HERE, AND WHY IT IS NOT "SESSION NOT FOUND"
 *
 * A malformed id is refused locally before any daemon call, matching the
 * sibling reads. Past that, a session the pool holds no binding for raises
 * `UnknownSessionError` and answers 409, so it never reaches the daemon either.
 * What is left for a 404 to mean is the one thing the SDK documents: a daemon
 * from before the recap route existed, which answers 404 for a route it does
 * not have. That is reported as 502 `recap_unsupported` rather than as a missing
 * conversation, because telling a phone the conversation is gone when the
 * daemon is merely old sends it to look in the wrong place. The same reasoning
 * gave `attachments_unsupported` in the attachment family.
 *
 * WHAT IS AUDITED
 *
 * A row is written only when a sentence actually came back. The row names the
 * session and never the summary: the text is a reduction of the conversation,
 * and the rule carried through #107 and the attachment family is that
 * conversation content stays out of the record.
 */
export function createSessionRecapRoute(
  daemon: Pick<SessionDaemon, 'recapSession'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id before any daemon call,
    // exactly as the transcript and turn-index reads do.
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const actorTokenId = req.rcClient?.id;

    let result: unknown;
    try {
      result = await daemon.recapSession(sessionId);
    } catch (err) {
      if (relayDaemonAuthFailure(res, err, 'recap')) return;
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        // A 404 with nothing behind it is a daemon with no recap route at all;
        // see the module note on why that is not a missing conversation.
        if (status === 404) {
          res.status(502).json({
            error: 'Daemon does not support session recaps',
            code: 'recap_unsupported',
          });
          return;
        }
        res.status(status).json({
          error: 'Daemon rejected the recap request',
          code: 'daemon_rejected',
        });
        return;
      }
      if (err instanceof UnknownSessionError) {
        res.status(409).json({
          error: 'Open this conversation before asking for its recap',
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
    // as it arrived. `recap: null` stays a 200; see the module note.
    const recap = (result as { recap?: unknown } | null)?.recap;
    if (typeof recap === 'string' && recap.length > 0) {
      void audit?.record({
        action: 'session_recap_generated',
        actorTokenId,
        target: sessionId,
      });
    }

    res.status(200).json(result as object);
  };
}
