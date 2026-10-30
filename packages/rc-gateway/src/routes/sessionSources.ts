/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import type { SessionSourceInput, SessionSourcesResult } from '@qwen-code/sdk';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { asDaemonHttpError, daemonErrorBody } from '../daemonHttpError.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * Issue #110: a conversation's sources, its reference list.
 *
 * WHAT A SOURCE IS
 *
 * A pointer the session keeps, never the thing pointed at
 * (core/src/services/session-sources.ts): a `title` (1 to 200 characters), an
 * optional `description`, and a `locator` that is one of a file in the
 * session's workspace (`workspace_file`, a path relative to it), a file the
 * conversation was sent (`attachment`, by the attachment's id) or a web page
 * (`url`, HTTP or HTTPS without credentials). The daemon adds `id` (a hash of
 * the session, the locator and the workspace, so adding the same path again
 * retitles it rather than doubling it), `kind` (`file` or `link`),
 * `workspaceCwd` for a workspace file, and two times. No size and no content:
 * the model's own `record_source` tool says so in its description,
 * "Registration stores metadata only". At most 200 per session.
 *
 *  - `GET /session/:id/sources`: `{ revision, sources }`, newest first.
 *    SESSION_READ, like the attachment list: the list names what the
 *    conversation already refers to. A share guest gets it without each
 *    file's `workspaceCwd`, the host's absolute folder, which says nothing
 *    about the conversation the share was made for.
 *  - `POST /session/:id/sources`: add or retitle one, `{ revision, source,
 *    change }` with `change` one of created, updated, unchanged. WRITE.
 *  - `DELETE /session/:id/sources/:sourceId`: `{ revision, removed }`. A
 *    `removed: false` is an answer (it was not there), relayed at 200; the
 *    page reads `removed === true` before it says anything was removed.
 *
 * THE CLIENT ID
 *
 * The daemon's two mutations refuse a request without a session-bound client
 * id (403 `client_id_required`, cli/src/serve/routes/session.ts:7245) and the
 * bridge one the session never registered (400 `invalid_client_id`). The pool
 * supplies the id the daemon stamped on this gateway's own attachment
 * (`DaemonPool.boundClientId`); when it has none, or its daemon has since
 * been replaced, both refusals mean the same thing to the person holding the
 * phone, and are answered as one: open the conversation again, which
 * attaches afresh.
 *
 * WHAT IS ECHOED
 *
 * An `invalid_source` carries the daemon's validator message, which names
 * only the field at fault and the rule (`Workspace path must be relative`,
 * `Source URL must be HTTP(S) without credentials`), never the value sent
 * (session-sources.ts:64-178). That is the one daemon message relayed, since
 * without it the page could only say "refused". The shape the gateway checks
 * itself is the daemon's own bounds, so an oversize field never leaves it.
 */

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 1000;
const MAX_WORKSPACE_PATH = 500;
const MAX_ATTACHMENT_ID = 200;
const MAX_URL = 2048;
/** A source id is a sha256 hex digest; the pattern leaves room, not much. */
const SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** The validator's messages are short; anything longer is not one of them. */
const MAX_RELAYED_MESSAGE = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function refuse(res: Response, code: string, error: string): void {
  res.status(400).json({ error, code });
}

type Outcome =
  | 'not_found'
  | 'not_bound'
  | 'rejected'
  | 'unsupported'
  | 'daemon_unavailable';

function sendSourcesError(res: Response, err: unknown): Outcome {
  if (err instanceof UnknownSessionError) {
    res.status(404).json({
      error: 'Session is not loaded in the daemon',
      code: 'session_not_found',
    });
    return 'not_found';
  }
  const http = asDaemonHttpError(err);
  const body = daemonErrorBody(err);
  const code = typeof body?.['code'] === 'string' ? body['code'] : undefined;
  const status = http?.status;
  if (code === 'client_id_required' || code === 'invalid_client_id') {
    res.status(409).json({
      error:
        'This gateway is not attached to the conversation as the daemon ' +
        'needs; open the conversation again and retry',
      code: 'client_not_bound',
    });
    return 'not_bound';
  }
  if (status === 400 && code === 'invalid_source') {
    const msg = typeof body?.['error'] === 'string' ? body['error'] : '';
    res.status(400).json({
      error:
        msg && msg.length <= MAX_RELAYED_MESSAGE
          ? msg
          : 'The daemon refused this source',
      code,
    });
    return 'rejected';
  }
  if (status === 409 && code === 'source_limit_reached') {
    res.status(409).json({
      error: 'This conversation already has 200 sources',
      code,
    });
    return 'rejected';
  }
  if (status === 503 && code === 'source_persistence_unavailable') {
    res.status(503).json({
      error: 'The daemon could not read or save the source list',
      code,
    });
    return 'daemon_unavailable';
  }
  if (status === 404) {
    if (code === 'source_attachment_not_found') {
      res.status(404).json({
        error: 'No such attachment in this conversation',
        code,
      });
      return 'rejected';
    }
    if (body !== undefined) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return 'not_found';
    }
    // Express's own "Cannot GET": a daemon that predates the routes.
    res.status(502).json({
      error: 'Daemon does not serve session sources',
      code: 'sources_unsupported',
    });
    return 'unsupported';
  }
  if (status !== undefined && status >= 400 && status < 500) {
    res.status(status).json({
      error: 'The daemon refused this request',
      code: code ?? 'daemon_rejected',
    });
    return 'rejected';
  }
  res
    .status(502)
    .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
  return 'daemon_unavailable';
}

function refuseMalformedSession(res: Response): void {
  res.status(404).json({ error: 'Session not found', code: 'session_not_found' });
}

/** GET /session/:id/sources: the reference list, verbatim (but see guests). */
export function createSessionSourcesRoute(
  daemon: Pick<SessionDaemon, 'listSessionSources'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    if (!isValidSessionId(sessionId)) return refuseMalformedSession(res);
    let result: SessionSourcesResult;
    try {
      result = await daemon.listSessionSources(sessionId);
    } catch (err) {
      sendSourcesError(res, err);
      return;
    }
    if (req.rcClient?.sessionLockId !== undefined && Array.isArray(result?.sources)) {
      res.status(200).json({
        ...result,
        sources: result.sources.map((s) => {
          if (!isPlainObject(s) || !('workspaceCwd' in s)) return s;
          const copy: Record<string, unknown> = { ...s };
          delete copy['workspaceCwd'];
          return copy;
        }),
      });
      return;
    }
    res.status(200).json(result);
  };
}

/**
 * The body checked against the daemon's own shape and bounds, and rebuilt
 * from the known fields only: the daemon refuses an unknown field, and a
 * field passed through unread is how one would reach it.
 */
function parseSourceInput(
  body: unknown,
): { ok: true; input: SessionSourceInput } | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: 'Body must be an object' };
  if (Object.keys(body).some((k) => !['title', 'description', 'locator'].includes(k))) {
    return {
      ok: false,
      error: 'Only `title`, `description` and `locator` can be sent',
    };
  }
  const title = body['title'];
  if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE) {
    return { ok: false, error: 'A title is 1 to 200 characters' };
  }
  const description = body['description'];
  if (
    description !== undefined &&
    (typeof description !== 'string' || description.length > MAX_DESCRIPTION)
  ) {
    return { ok: false, error: 'A description is at most 1000 characters' };
  }
  const loc = body['locator'];
  if (!isPlainObject(loc)) {
    return { ok: false, error: '`locator` must be an object' };
  }
  const str = (v: unknown, max: number) =>
    typeof v === 'string' && v.length > 0 && v.length <= max;
  let locator: SessionSourceInput['locator'];
  if (loc['type'] === 'workspace_file') {
    if (Object.keys(loc).some((k) => k !== 'type' && k !== 'workspacePath')) {
      return { ok: false, error: 'A workspace file locator takes `workspacePath`' };
    }
    if (!str(loc['workspacePath'], MAX_WORKSPACE_PATH)) {
      return { ok: false, error: 'A workspace path is 1 to 500 characters' };
    }
    locator = { type: 'workspace_file', workspacePath: loc['workspacePath'] as string };
  } else if (loc['type'] === 'url') {
    if (Object.keys(loc).some((k) => k !== 'type' && k !== 'url')) {
      return { ok: false, error: 'A link locator takes `url`' };
    }
    if (!str(loc['url'], MAX_URL)) {
      return { ok: false, error: 'A link is 1 to 2048 characters' };
    }
    locator = { type: 'url', url: loc['url'] as string };
  } else if (loc['type'] === 'attachment') {
    if (Object.keys(loc).some((k) => k !== 'type' && k !== 'attachmentId')) {
      return { ok: false, error: 'An attachment locator takes `attachmentId`' };
    }
    if (!str(loc['attachmentId'], MAX_ATTACHMENT_ID)) {
      return { ok: false, error: 'An attachment id is 1 to 200 characters' };
    }
    locator = { type: 'attachment', attachmentId: loc['attachmentId'] as string };
  } else {
    return {
      ok: false,
      error: '`locator.type` is workspace_file, url or attachment',
    };
  }
  return {
    ok: true,
    input: {
      title,
      locator,
      ...(description !== undefined ? { description: description as string } : {}),
    },
  };
}

/** POST /session/:id/sources: add or retitle one source. */
export function createSessionSourceAddRoute(
  daemon: Pick<SessionDaemon, 'upsertSessionSource'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;
    if (!isValidSessionId(sessionId)) return refuseMalformedSession(res);
    const parsed = parseSourceInput(req.body);
    if (!parsed.ok) return refuse(res, 'invalid_source', parsed.error);
    let result;
    try {
      result = await daemon.upsertSessionSource(sessionId, parsed.input);
    } catch (err) {
      const reason = sendSourcesError(res, err);
      void audit?.record({
        action: 'session_source_add_failed',
        actorTokenId,
        target: sessionId,
        detail: { reason },
      });
      return;
    }
    // The kind, never the path or the link: the audit log carries no paths.
    void audit?.record({
      action: 'session_source_added',
      actorTokenId,
      target: sessionId,
      detail: {
        locator: parsed.input.locator.type,
        change: typeof result?.change === 'string' ? result.change : 'unknown',
      },
    });
    res.status(200).json(result);
  };
}

/** DELETE /session/:id/sources/:sourceId: drop one source. */
export function createSessionSourceRemoveRoute(
  daemon: Pick<SessionDaemon, 'removeSessionSource'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;
    if (!isValidSessionId(sessionId)) return refuseMalformedSession(res);
    const sourceId = req.params.sourceId;
    if (typeof sourceId !== 'string' || !SOURCE_ID_RE.test(sourceId)) {
      return refuse(res, 'invalid_source_id', 'Not a source id');
    }
    let result;
    try {
      result = await daemon.removeSessionSource(sessionId, sourceId);
    } catch (err) {
      const reason = sendSourcesError(res, err);
      void audit?.record({
        action: 'session_source_remove_failed',
        actorTokenId,
        target: sessionId,
        detail: { reason },
      });
      return;
    }
    void audit?.record({
      action: 'session_source_removed',
      actorTokenId,
      target: sessionId,
      detail: { removed: result?.removed === true },
    });
    res.status(200).json(result);
  };
}
