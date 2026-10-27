/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * Read a daemon error's 409 `code` without asking what class the error is.
 *
 * The class question is unusable here: `DaemonHttpError` has three distinct
 * identities in this build, because `@qwen-code/sdk/daemon` ships separate
 * `import` and `require` copies and the root entry ships a third, so
 * `err instanceof DaemonHttpError` is false on some live paths no matter how
 * correctly the code is written. See InfiniteInsight/Qwen-Code-Remote#139 and
 * the note on the same kind of helper in routes/sessionBtw.ts. `status` and
 * `body` are plain fields and arrive intact.
 */
function daemonRejection(err: unknown): {
  status?: number;
  code?: string;
} {
  const e = err as { status?: unknown; body?: unknown } | null;
  const out: { status?: number; code?: string } = {};
  if (typeof e?.status === 'number') out.status = e.status;
  const body = e?.body;
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const code = (body as Record<string, unknown>)['code'];
    if (typeof code === 'string') out.code = code;
  }
  return out;
}

/**
 * The three 409 codes this route can be answered with, and the copy each one
 * gets. They are deliberately kept apart rather than collapsed into one
 * "cannot reset" message, because they call for different actions from the
 * operator and only one of them can be fixed by trying again.
 *
 * The daemon sends no reason on the wire: the specific detail goes to its own
 * log and never to the response (packages/cli/src/serve/routes/session.ts
 * :4795-4800), so these three strings are the whole of what this surface can
 * say, and each has to carry as much as it honestly can.
 */
const REFUSALS: Record<string, { status: number; error: string }> = {
  // Not a worktree session. Nothing is wrong and nothing is pending; the
  // action simply does not apply to what is on screen.
  worktree_reset_unsupported: {
    status: 400,
    error:
      'This conversation is not a worktree session, so there is no checkout to hand over',
  },
  // A session involved is busy. This is the one that clears on its own.
  worktree_reset_active: {
    status: 409,
    error:
      'A conversation in this transfer is still working; try again when it finishes',
  },
  // Corrupt or ambiguous ownership state. The SDK documents that a retry
  // re-reads the same state and returns the same 409, so this copy must NOT
  // invite a retry loop: it says plainly that a person has to look.
  worktree_reset_invalid_state: {
    status: 409,
    error:
      'The checkout ownership for this conversation is in a state the daemon will not guess at; a retry returns the same answer, so this needs someone to look at the daemon log',
  },
};

/**
 * POST /session/:id/worktree-reset - hand a worktree session's checkout over
 * to a fresh replacement conversation.
 *
 * WHAT IT DOES, IN THE OPERATOR'S TERMS
 *
 * A worktree conversation runs in its own git checkout. A reset spawns a new
 * session in the root workspace, moves the checkout's ownership to it, links
 * the pair so the old one records that it was superseded, and flips the
 * on-disk marker. The conversation on screen therefore STOPS being the thing
 * that owns the work, and a different conversation becomes it. That is why the
 * page has to say so out loud rather than quietly refresh: an operator who is
 * not told will keep typing into a conversation that no longer has a checkout.
 *
 * WHY THE RESPONSE IS NOT JUST A SUCCESS
 *
 * Two things arrive on the happy path that a relay can get wrong, and both are
 * load-bearing.
 *
 * 1. The body is the REPLACEMENT's create-shape response, so it carries a
 *    different session id from the one that was posted. A caller that keeps
 *    addressing the id it started with is talking to a superseded session.
 * 2. A fresh transfer mints an owner-style `clientId`, registers it on the
 *    replacement, and returns it in that same body. The SDK documents the
 *    consequence plainly: that registration is not an attachment, the
 *    replacement's attach count is unaffected, and nothing detaches it for you
 *    - a caller that does not keep using the id must pass it to
 *    `detachSession`, or the replacement never reaches the daemon's idle
 *    cleanup (packages/sdk-typescript/src/daemon/DaemonClient.ts:3685-3700).
 *
 * So a relay that forwards the body and forgets about the id leaks a session on
 * every reset, and the leak is invisible: the daemon holds a registration
 * nobody will ever use, on a session that therefore cannot be reaped.
 *
 * WHY THIS ROUTE DETACHES RATHER THAN ADOPTS
 *
 * The channels layer adopts, and for it that is correct: `SessionRouter` is a
 * long-lived owner that keeps talking to the replacement, so it registers the
 * new id in its live set and holds the client for the rest of its life
 * (packages/channels/base/src/SessionRouter.ts:913-955). This gateway is not
 * that. Its next contact with the replacement is the page's own watch, which
 * registers a client id of its own through the normal path. Adopting the
 * minted id here would therefore put two registrations on the replacement where
 * only one of them is ever released, which is the same leak wearing a hat.
 *
 * Releasing it in this request path is exact rather than approximate because
 * `detachSession` takes a specific `clientId` rather than "all clients", so it
 * cannot pull the page's own registration, and because the SDK's method no-ops
 * on an absent id and treats both 204 and 404 as success. That last part also
 * covers the second half of the protocol: an idempotent resume of an already
 * committed transfer returns no `clientId` at all, and there is nothing to
 * release.
 *
 * A release that FAILS is reported rather than swallowed. The transfer
 * happened; retracting the success would be the bigger lie, since the checkout
 * really did move. So the response says the reset succeeded and that the
 * leftover registration could not be released, and the operator can re-run it:
 * a committed transfer resumes idempotently, and the second attempt is the one
 * that gets to detach.
 *
 * WHY NO `cwd` IS ACCEPTED FROM THE CALLER
 *
 * The daemon resolves the runtime from the session's own workspace when the
 * body carries no `cwd` (`parseOptionalWorkspaceCwd` falling back to the bound
 * workspace, packages/cli/src/serve/routes/session.ts:1764), and this gateway
 * already knows which daemon owns the session, which is how the call is routed
 * at all. Letting a caller name a different workspace would let it aim a
 * transfer at a daemon that does not own the checkout, so the body is not read
 * for a workspace here. This is the opposite of routes/sessionResume.ts, which
 * must require one because a resumed session was never in this process's
 * memory.
 *
 * WHAT IS AUDITED
 *
 * Both ids, because the whole event is that one conversation became another,
 * and a record naming only the old one would leave the successor untraceable.
 * No paths and no request fields: the transfer's arguments are workspace
 * locations, and the gateway's rule through #107 and the attachment family is
 * that those stay out of the record.
 */
export function createSessionWorktreeResetRoute(
  daemon: Pick<SessionDaemon, 'resetWorktreeSession' | 'detachSession'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Refuse a malformed id before any daemon call, as every sibling session
    // route does.
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const actorTokenId = req.rcClient?.id;

    let replacement;
    try {
      replacement = await daemon.resetWorktreeSession(sessionId, {});
    } catch (err) {
      const { status, code } = daemonRejection(err);
      if (code !== undefined && REFUSALS[code] !== undefined) {
        const refusal = REFUSALS[code];
        res.status(refusal.status).json({ error: refusal.error, code });
        return;
      }
      // A 404 with no taxonomy behind it. On a session route this is not
      // evidence the conversation is deleted (see the note in
      // routes/sessionBtw.ts on the same shape), so it is reported as the
      // recoverable reading it is.
      if (status === 404) {
        res.status(409).json({
          error: 'This conversation is not answering right now',
          code: 'session_not_loaded',
        });
        return;
      }
      if (err instanceof UnknownSessionError) {
        res.status(409).json({
          error: 'Open this conversation before resetting its checkout',
          code: 'session_not_loaded',
        });
        return;
      }
      if (typeof status === 'number' && status >= 400 && status < 500) {
        res.status(status).json({
          error: 'Daemon rejected the checkout handover',
          code: 'daemon_rejected',
        });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    // Read the two fields the protocol puts on the body. The replacement's id
    // is what the caller has to address next, and the minted client id is the
    // thing that must not be left registered.
    const body = (replacement ?? {}) as {
      sessionId?: unknown;
      clientId?: unknown;
    };
    const replacementId =
      typeof body.sessionId === 'string' && body.sessionId.length > 0
        ? body.sessionId
        : sessionId;
    const mintedClientId =
      typeof body.clientId === 'string' && body.clientId.length > 0
        ? body.clientId
        : undefined;

    void audit?.record({
      action: 'session_worktree_reset',
      actorTokenId,
      target: sessionId,
      // Both ids, because the event IS one conversation becoming another. A
      // row naming only the superseded one leaves the successor untraceable.
      detail: { replacementSessionId: replacementId },
    });

    // The minted registration is released here or nowhere. Absent id means an
    // idempotent resume of a committed transfer, which registered nothing.
    let released = true;
    if (mintedClientId !== undefined) {
      try {
        await daemon.detachSession(replacementId, mintedClientId);
      } catch {
        // The transfer itself succeeded and the checkout really did move, so
        // this stays a success. What it is allowed not to do is pretend the
        // leftover is not there: that is the leak, named.
        released = false;
      }
    }

    // The minted id is deliberately NOT forwarded. It has just been released
    // (or is about to be reaped), so handing it to the page would offer the
    // caller a registration it cannot use.
    res.status(200).json({
      sessionId: replacementId,
      supersededSessionId: sessionId,
      changedIdentity: replacementId !== sessionId,
      registrationReleased: released,
    });
  };
}
