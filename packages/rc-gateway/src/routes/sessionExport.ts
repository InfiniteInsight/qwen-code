/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonSessionExportFormat } from '@qwen-code/sdk/daemon';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * GET /session/:id/export — hand the caller a copy of the whole conversation.
 *
 * This is the gap the route exists to close: a phone holding a token can watch
 * a session and type into it, but it has no way to get the conversation OUT of
 * the remote. The terminal has the disk; the remote has neither the disk nor a
 * link it could follow, because the daemon token rides in an Authorization
 * header and a browser cannot put one on a plain anchor.
 *
 * So the answer is JSON, not bytes. The daemon serves the export as a file with
 * `Content-Disposition: attachment`; the SDK already unwraps that into
 * `{ content, filename, mimeType, format }`, and this route passes those four
 * fields through untouched. The page rebuilds the file from them (a Blob plus a
 * programmatic anchor click), which is the same download the terminal would
 * have produced, from a token that never leaves the header.
 *
 * `format` is RELAYED, never re-listed here. The daemon owns the vocabulary —
 * four today — and answers a format it does not know with 400 plus
 * `allowedFormats`. A copy of that list in this file would read as authority
 * and go stale the day the daemon grows a fifth, so the caller's string is
 * carried to the validator that actually decides. Omitted means the daemon's
 * own default, which the SDK applies and reports back in `format`.
 *
 * Audited as a read, because it is the one read that moves the entire
 * conversation out of the gateway. The record carries the format and the byte
 * count, never the content — the same rule that keeps paths out of every other
 * record. No failure twin: `search_performed` established that a read records
 * what left, not what was refused.
 */
export function createSessionExportRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id before any daemon call —
    // mirrors the sibling session routes (events, fork, rewind, context).
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const actorTokenId = req.rcClient?.id;
    const requested =
      typeof req.query.format === 'string' && req.query.format.length > 0
        ? req.query.format
        : undefined;

    try {
      // The cast hands the caller's string to the daemon's validator instead of
      // guessing at it here; see the module doc on why the vocabulary stays
      // single-sourced.
      const file = await daemon.exportSession(sessionId, {
        format: requested as DaemonSessionExportFormat | undefined,
      });
      void audit?.record({
        action: 'session_exported',
        actorTokenId,
        target: sessionId,
        detail: {
          format: file.format,
          bytes: Buffer.byteLength(file.content, 'utf8'),
        },
      });
      res.status(200).json(file);
    } catch (err) {
      // Three failures, three answers, none of them a laundered 502.
      //
      // The daemon's 400 is a bad format. Flattening it into a gateway error
      // would send the caller to retry a request that can never succeed, and
      // hide the `allowedFormats` list that tells them what to ask for instead.
      // The daemon's 404 is a session it cannot load at all.
      const status = (err as { status?: unknown }).status;
      if (status === 400) {
        res.status(400).json({
          error: 'Unsupported export format',
          code: 'invalid_export_format',
        });
        return;
      }
      if (status === 404) {
        res
          .status(404)
          .json({ error: 'Session not found', code: 'session_not_found' });
        return;
      }
      // The pool keeps its session-to-daemon map in memory and drops the entry
      // when a session dies or closes, so this is NOT proof the conversation is
      // gone: its transcript is still on disk and the daemon would render it if
      // asked. What is missing is a binding to the daemon that owns it, which
      // `POST /session/:id/resume` restores. Saying 404 here would tell the
      // operator to stop looking when one click gets them the file.
      if (err instanceof UnknownSessionError) {
        res.status(409).json({
          error: 'Open this conversation before exporting it',
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
