/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * The "sessions at rest" actions (add-capability-parity #111): archive,
 * unarchive, delete. Each forwards a batch of session ids to the daemon, which
 * already serves them — only the gateway path was missing.
 *
 * Archive and delete are deliberately NOT one route with a flag. Archiving is
 * reversible and deleting is not, so delete carries a confirmation the others
 * do not: a `confirm: true` body field, checked here rather than trusted from
 * the client. Without it the request is refused 400 `confirm_required` and
 * nothing reaches the daemon, so a stray call cannot destroy a transcript. The
 * asymmetry is enforced server-side, so it holds for every client rather than
 * only the one that happens to draw a dialog.
 *
 * The daemon's per-id outcome (`removed` / `notFound` / `errors`) is passed
 * through untouched — a partial failure is real information, and flattening it
 * into a bare 200 is the silently-swallowed-failure bug class this issue is
 * about.
 *
 * Audit records the session ids as `target`, never the cwd: the audit trail
 * stays free of paths.
 */
export type SessionRestAction = 'archive' | 'unarchive' | 'delete';

/** The daemon surface this route file needs. */
export type SessionRestDaemon = Pick<
  SessionDaemon,
  'archiveSessionsData' | 'unarchiveSessionsData' | 'deleteSessionsData'
>;

type ParseError = 'sessionIds_required' | 'sessionIds_invalid';

interface ParsedBody {
  ids: string[];
  cwd?: string;
  confirm: boolean;
  error?: ParseError;
}

function parseBody(body: unknown): ParsedBody {
  const src = (body ?? {}) as {
    sessionIds?: unknown;
    cwd?: unknown;
    confirm?: unknown;
  };
  const confirm = src.confirm === true;
  const raw = src.sessionIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ids: [], confirm, error: 'sessionIds_required' };
  }
  const ids = raw.filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
  // Reject a malformed id before any daemon call, like every sibling session
  // route, so a traversal-shaped id never reaches the daemon.
  if (ids.length !== raw.length || ids.some((id) => !isValidSessionId(id))) {
    return { ids: [], confirm, error: 'sessionIds_invalid' };
  }
  const cwd =
    typeof src.cwd === 'string' && src.cwd.trim() !== ''
      ? src.cwd.trim()
      : undefined;
  return { ids, cwd, confirm };
}

export function createSessionRestRoute(
  daemon: SessionRestDaemon,
  action: SessionRestAction,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const { ids, cwd, confirm, error } = parseBody(req.body);
    if (error) {
      res.status(400).json({
        error:
          error === 'sessionIds_required'
            ? 'sessionIds required'
            : 'invalid sessionIds',
        code: error,
      });
      return;
    }
    if (action === 'delete' && !confirm) {
      res.status(400).json({
        error: 'deleting sessions is irreversible; send confirm: true',
        code: 'confirm_required',
      });
      return;
    }
    const actorTokenId = req.rcClient?.id;
    try {
      const result =
        action === 'archive'
          ? await daemon.archiveSessionsData(ids, undefined, cwd)
          : action === 'unarchive'
            ? await daemon.unarchiveSessionsData(ids, undefined, cwd)
            : await daemon.deleteSessionsData(ids, undefined, cwd);
      void audit?.record({
        action: `sessions_${action}d`,
        actorTokenId,
        target: ids.join(','),
        detail: { count: ids.length },
      });
      res.status(200).json({ action, requested: ids.length, ...result });
    } catch {
      // A daemon refusal is a 502, never a 200 with an empty body. The daemon's
      // message is not echoed, so a workspace path cannot leak through it.
      void audit?.record({
        action: `sessions_${action}_failed`,
        actorTokenId,
        target: ids.join(','),
        detail: { count: ids.length },
      });
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}
