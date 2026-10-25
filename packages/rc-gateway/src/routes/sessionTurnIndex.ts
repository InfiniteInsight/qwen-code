/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonSessionTurnIndexPageOptions } from '@qwen-code/sdk/daemon';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * GET /session/:id/turn-index — relay one page of the daemon's TURN INDEX.
 *
 * The transcript route hands back records; this hands back the list those
 * records are indexed by: one entry per navigation turn, with its ordinal, its
 * kind and the label the daemon derived for it. That is what a reader needs to
 * jump somewhere in a long conversation, which the transcript page cannot do on
 * its own: paging a transcript by record only gets you there one screen at a
 * time, and `atRecordId` needs a record id the viewer has never seen.
 *
 * The query is RELAYED, never re-implemented. The daemon owns the paging
 * vocabulary here (`snapshot`, `start`, `limit`) and it owns the rule that
 * binds two of them together: `start` is an offset INTO a snapshot, so it is
 * meaningless alone, and the daemon answers that combination with 400
 * `invalid_transcript_cursor` (`packages/cli/src/serve/routes/session.ts:6755`).
 * Repeating that check here would read as authority and go stale the day the
 * daemon allows a bare `start`, so the caller's params are carried untouched to
 * the thing that decides. Only the keys the caller sent are sent onward: an
 * absent `start` means "the daemon's own window", which is not the same request
 * as one that pins an offset.
 *
 * `start` and `limit` are carried as the caller sent them rather than parsed
 * into numbers here. A value the daemon rejects must reach the daemon, so the
 * caller gets the daemon's own refusal; a local parse would either swallow the
 * parameter (answering with the default window, which reads as success) or turn
 * a paging question into a gateway error.
 *
 * Read-scoped, bare namespace (1:1 with the daemon's own
 * `GET /session/:id/turn-index`). Audited, because the entry labels are text
 * derived from the conversation: the record carries how many turns the page
 * held and how many the index claims, never the entries themselves.
 */
export function createSessionTurnIndexRoute(
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

    const opts: DaemonSessionTurnIndexPageOptions = {};
    const snapshot = text(q['snapshot']);
    const start = text(q['start']);
    const limit = text(q['limit']);
    if (snapshot !== undefined) opts.snapshot = snapshot;
    if (start !== undefined) {
      // Carried as sent; see the module note on why the number is not parsed
      // here. The cast is the relay, not a claim that it is well-formed.
      opts.start = start as unknown as number;
    }
    if (limit !== undefined) {
      opts.limit = limit as unknown as number;
    }

    try {
      const page = await daemon.getSessionTurnIndexPage(sessionId, opts);
      void audit?.record({
        action: 'session_turn_index_read',
        actorTokenId,
        target: sessionId,
        detail: {
          turns: page.turns.length,
          totalTurns: page.totalTurns,
        },
      });
      res.status(200).json(page);
    } catch (err) {
      // Three failures, three answers, none of them a laundered 502 — the same
      // discipline as the transcript and export routes.
      //
      // The daemon's 400 is a bad paging combination (a `start` with no
      // `snapshot`, or a snapshot past the size cap). Flattening it into a
      // gateway error sends the caller to retry a request that can never
      // succeed, and hides which parameter they got wrong.
      const status = (err as { status?: unknown }).status;
      if (status === 400) {
        res.status(400).json({
          error: 'Invalid turn index paging parameters',
          code: 'invalid_turn_index_query',
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
      // when a session dies or closes, so this is NOT proof the index is gone:
      // it is on disk and the daemon would build it if asked. What is missing is
      // a binding to the daemon that owns it, which `POST /session/:id/resume`
      // restores.
      if (err instanceof UnknownSessionError) {
        res.status(409).json({
          error: 'Open this conversation before reading its turn index',
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
