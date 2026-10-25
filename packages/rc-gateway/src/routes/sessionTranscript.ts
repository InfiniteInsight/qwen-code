/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonSessionTranscriptPageOptions } from '@qwen-code/sdk/daemon';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * GET /session/:id/transcript — relay one page of the daemon's STORED
 * transcript. The viewer already holds a transcript, but only the one the live
 * watch stream has handed it since the page opened. This route is the stored
 * form: what the session actually persisted, readable from the first record,
 * paginated, and available whether or not the stream is connected.
 *
 * The query is RELAYED, never re-implemented. The daemon owns the paging
 * vocabulary (`cursor`, `beforeRecordId`, `atRecordId` + `snapshot`,
 * `direction`, `limit`, `compactedReplayMode`) and it owns the rules about
 * which of them may appear together — `atRecordId` needs `snapshot`,
 * `direction` excludes every other anchor, and a cursor and a record boundary
 * are mutually exclusive. Answering 400 `invalid_transcript_cursor` is that
 * validator's job. A copy of those combination rules in this file would read as
 * authority and go stale the day the daemon widens them, so the caller's
 * params are carried untouched to the thing that decides.
 *
 * `limit` is carried as the caller sent it rather than parsed into a number
 * here. A value the daemon rejects must reach the daemon, so the caller gets
 * the daemon's own refusal; a local parse would either swallow the parameter
 * (silently answering with the default page, which reads as success) or turn a
 * paging question into a gateway error.
 *
 * Read-scoped, bare namespace (1:1 with the daemon's own
 * `GET /session/:id/transcript`), sitting alongside `/export` rather than
 * below it. Audited, because like the export this is conversation text leaving
 * the gateway: the record carries how many events the page held and whether
 * more remain, never any of the events themselves.
 */
export function createSessionTranscriptRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id before any daemon call —
    // mirrors the sibling session routes (events, fork, rewind, export).
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const actorTokenId = req.rcClient?.id;
    const q = req.query as Record<string, unknown>;
    const text = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined;

    // Only the keys the daemon accepts, and only when the caller sent them:
    // an absent paging parameter means "use the daemon's default", which is
    // not the same request as one that pins a cursor.
    const opts: DaemonSessionTranscriptPageOptions = {};
    const compactedReplayMode = text(q['compactedReplayMode']);
    const cursor = text(q['cursor']);
    const direction = text(q['direction']);
    const atRecordId = text(q['atRecordId']);
    const snapshot = text(q['snapshot']);
    const beforeRecordId = text(q['beforeRecordId']);
    const limit = text(q['limit']);
    if (compactedReplayMode !== undefined) {
      opts.compactedReplayMode =
        compactedReplayMode as DaemonSessionTranscriptPageOptions['compactedReplayMode'];
    }
    if (cursor !== undefined) opts.cursor = cursor;
    if (direction !== undefined) {
      opts.direction =
        direction as DaemonSessionTranscriptPageOptions['direction'];
    }
    if (atRecordId !== undefined) opts.atRecordId = atRecordId;
    if (snapshot !== undefined) opts.snapshot = snapshot;
    if (beforeRecordId !== undefined) opts.beforeRecordId = beforeRecordId;
    if (limit !== undefined) {
      // Carried as sent; see the module note on why the number is not parsed
      // here. The cast is the relay, not a claim that it is well-formed.
      opts.limit = limit as unknown as number;
    }

    try {
      const page = await daemon.getSessionTranscriptPage(sessionId, opts);
      void audit?.record({
        action: 'session_transcript_read',
        actorTokenId,
        target: sessionId,
        detail: {
          records: page.events.length,
          hasMore: page.hasMore,
        },
      });
      res.status(200).json(page);
    } catch (err) {
      // Three failures, three answers, none of them a laundered 502 — the same
      // discipline as the export route.
      //
      // The daemon's 400 is a bad paging combination. Flattening it into a
      // gateway error sends the caller to retry a request that can never
      // succeed, and hides which anchor they got wrong.
      const status = (err as { status?: unknown }).status;
      if (status === 400) {
        res.status(400).json({
          error: 'Invalid transcript paging parameters',
          code: 'invalid_transcript_query',
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
      // when a session dies or closes, so this is NOT proof the transcript is
      // gone: it is on disk and the daemon would render it if asked. What is
      // missing is a binding to the daemon that owns it, which
      // `POST /session/:id/resume` restores.
      if (err instanceof UnknownSessionError) {
        res.status(409).json({
          error: 'Open this conversation before reading its transcript',
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
