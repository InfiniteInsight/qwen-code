/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * Session artifacts (add-capability-parity #127, the read pair).
 *
 *   GET /session/:id/artifacts                      -> the daemon's list
 *   GET /session/:id/artifacts/:artifactId/content  -> one saved snapshot
 *
 * WHY ONLY TWO OF THE FOUR ROUTES
 *
 * The daemon also has `POST /session/:id/artifacts` and
 * `DELETE /session/:id/artifacts/:artifactId`, and the issue counted four
 * relays. Both mutation routes call `requireSessionArtifactClientId`
 * (packages/cli/src/serve/routes/session.ts:466) and answer 403
 * `client_id_required` when the request carries no session-bound client id,
 * and no gateway route forwards a client id at all - there is no such plumbing
 * anywhere in src/routes. So those two are not a relay waiting to be wired;
 * they need a client-id story the gateway has never had, which is its own
 * slice. The read pair is the opposite: `resolveTrustedClientId`
 * (packages/acp-bridge/src/session-control-plane.ts:4750) returns undefined
 * rather than throwing when no id is sent, and `getSessionArtifacts` discards
 * the result, so an unbound read is the daemon's supported path, not an
 * accident.
 *
 * WHY THE HEADERS ARE RESTATED AND NOT FORWARDED
 *
 * The issue's framing is that the daemon already chose the headers and the
 * gateway should preserve them. That is the right instinct and it is not
 * achievable through the client: `DaemonClient.readSessionArtifactContent`
 * (packages/sdk-typescript/src/daemon/DaemonClient.ts:4816) reads the response
 * with `res.text()` and returns the decoded string, so every header is gone
 * before the gateway sees a value. The four are therefore re-stated here from
 * the daemon's own literals
 * (packages/cli/src/serve/routes/session.ts:7331-7336).
 *
 * This is the one place in the gateway where a response's headers are a
 * security control rather than a cosmetic detail. The body is HTML the daemon
 * saved off the web, it is served from the gateway's origin, and the gateway
 * sets no Content-Security-Policy anywhere (there is no such header in src).
 * `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff` is
 * what stops that body rendering as a document on an origin that holds the
 * operator's token. Dropping either one - or "just sending the string" and
 * letting Express default to text/html - is the vulnerability, so the four
 * headers are set explicitly and a test pins each of them.
 *
 * WHY THE LIST IS SESSION-READ AND THE CONTENT IS WRITE
 *
 * The same split the attachment pair already ships. The list names artifacts
 * the transcript already implies, which sits at SESSION_READ
 * (server.ts:971); the content returns the file itself, and the rule carried
 * from #107 is that host file contents sit at WRITE (server.ts:980).
 *
 * WHY NOTHING HERE IS AUDITED
 *
 * Matching those same two siblings: a read's only identifying field is an id,
 * and paths stay out of records, so a row could name neither the artifact nor
 * what it held.
 *
 * WHY A MISSING POOL BINDING IS 409
 *
 * Both routes follow `sessionStats` here rather than `sessionStatus`: the
 * pool's session-to-daemon map is in memory and drops the entry when a
 * session dies, so a missing binding proves the gateway has no one to ask,
 * not that the conversation is gone. 404 would send the reader looking for a
 * file that is still there.
 */

/** The daemon's own literals, restated. See the header note above. */
const SNAPSHOT_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Disposition': 'attachment; filename="saved-webpage.html"',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store',
} as const;

/**
 * GET /session/:id/artifacts - what the session produced. The envelope is the
 * daemon's (`v`, `sessionId`, `artifacts`, `generatedAt`, `limits`) and each
 * entry keeps whatever fields it put on it, so a kind the gateway has never
 * heard of still arrives intact.
 */
export function createSessionArtifactListRoute(
  daemon: Pick<SessionDaemon, 'listSessionArtifacts'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    try {
      const envelope = await daemon.listSessionArtifacts(sessionId);
      res.status(200).json(envelope);
    } catch (err) {
      const daemonStatus = (err as { status?: unknown } | undefined)?.status;
      if (daemonStatus === 404) {
        res
          .status(404)
          .json({ error: 'Session not found', code: 'session_not_found' });
        return;
      }
      if (err instanceof UnknownSessionError) {
        res.status(409).json({
          error: 'Open this conversation before reading its artifacts',
          code: 'session_not_loaded',
        });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}

/**
 * GET /session/:id/artifacts/:artifactId/content - one saved snapshot.
 *
 * The daemon answers a missing or changed snapshot with 404
 * `{ error: 'artifact_snapshot_unavailable', message: 'Saved webpage version
 * is missing or has changed.' }` (session.ts:7322-7327). That pair is relayed
 * rather than folded into 502: it is a specific verdict about one artifact,
 * and a reader acts on it differently than on a daemon that did not answer.
 */
export function createSessionArtifactContentRoute(
  daemon: Pick<SessionDaemon, 'readSessionArtifactContent'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const artifactId = req.params.artifactId;
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    // The daemon looks the id up in its own list, so a shaped id cannot
    // escape into a path here. Refusing it at the boundary anyway keeps a
    // traversal-shaped request from costing a daemon round trip, which is the
    // same reason the sibling routes check the session id first.
    if (!artifactId || artifactId.includes('/') || artifactId.includes('..')) {
      res.status(400).json({
        error: '`artifactId` is not a valid artifact id',
        code: 'invalid_artifact_id',
      });
      return;
    }
    let content: unknown;
    try {
      content = await daemon.readSessionArtifactContent(sessionId, artifactId);
    } catch (err) {
      const daemonStatus = (err as { status?: unknown } | undefined)?.status;
      const body = (err as { body?: unknown } | undefined)?.body as
        | { error?: unknown; message?: unknown }
        | undefined;
      if (daemonStatus === 404) {
        // Relay the daemon's own pair when it sent one; a bare 404 with
        // nothing behind it is a daemon with no artifact routes, which is a
        // capability answer and not a verdict about this artifact.
        if (body && body.error === 'artifact_snapshot_unavailable') {
          res.status(404).json({
            error: 'artifact_snapshot_unavailable',
            message:
              typeof body.message === 'string'
                ? body.message
                : 'Saved webpage version is missing or has changed.',
          });
          return;
        }
        res.status(502).json({
          error: 'This daemon cannot read artifact snapshots',
          code: 'artifact_snapshot_unsupported',
        });
        return;
      }
      if (err instanceof UnknownSessionError) {
        res.status(409).json({
          error: 'Open this conversation before reading its artifacts',
          code: 'session_not_loaded',
        });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }
    // The SDK hands back a string. Anything else would be a shape change in
    // the layer below, and serving `undefined` as a body is not an option.
    if (typeof content !== 'string') {
      res.status(502).json({
        error: 'Daemon returned an unreadable artifact',
        code: 'daemon_unavailable',
      });
      return;
    }
    res.status(200).set(SNAPSHOT_HEADERS).send(content);
  };
}
