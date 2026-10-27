/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { SessionMetadataResult } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';
import { asDaemonHttpError } from '../daemonHttpError.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * The longest title this route will forward. The daemon's own ceiling is 256
 * (`MAX_DISPLAY_NAME_LENGTH`, acp-bridge/session-control-plane.ts:1109) and the
 * HTTP route slices to 256 rather than refusing
 * (cli/src/serve/routes/session.ts:8770), so 201 to 256 characters is accepted,
 * published as a live `session_metadata_updated`, and then thrown away: the
 * child's own writer refuses above `SESSION_TITLE_MAX_LENGTH` = 200
 * (cli/src/acp-integration/acpAgent.ts:11952, core/services/sessionService.ts:455)
 * and the bridge does not await that write, so nothing surfaces the refusal.
 *
 * The gateway's session list is built from the transcript's `custom_title`
 * record (sessions/sessionList.ts:156), which is exactly the write that fails.
 * So a name in that band renames the live view and leaves the list showing the
 * old title, which reads as the rename not having worked. Refusing at 200 is
 * the only option that keeps the two in agreement. Truncating instead would
 * silently store a different title than the one that was typed.
 */
const MAX_DISPLAY_NAME_LENGTH = 200;

/**
 * PATCH /session/:id/metadata: give ONE session a human title.
 *
 * This is the naming half of the session list. The list already prints a title
 * and marks an auto-derived one with `(auto)`, but nothing on the page could
 * set it, so a reader had to leave for the interactive CLI to run `/rename`.
 *
 * Two limits of the daemon's route are load-bearing here and both are stated in
 * what the caller sees rather than hidden:
 *
 * It renames a LOADED session only. The branch that reaches an inactive or
 * archived transcript sits on the workspace-qualified route behind
 * `runtime.trusted` (cli/src/serve/routes/session.ts:8678, :1553). Through this
 * door a session the daemon has not loaded is a 404, not a rename, so a title
 * set here is a title on the session the daemon has open.
 *
 * The reply is the daemon's EFFECTIVE metadata, not an echo of the request. The
 * route answers `{ sessionId, ...effective }`, so `displayName` in the body of
 * the response is the name the daemon says it now holds. A caller that judged on
 * the status code alone would be reporting a name it never confirmed, and the
 * durable write is asynchronous, so even a confirmed name can take a moment to
 * reach the transcript this page's list reads.
 *
 * `pr` is refused rather than dropped. The daemon accepts it on the same call
 * and links pull-request metadata; this route's contract is a title, and a
 * caller whose `pr` was ignored would believe links had been written.
 */
export function createSessionRenameRoute(
  daemon: Pick<SessionDaemon, 'updateSessionMetadata'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;

    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }

    const body = req.body as
      | { displayName?: unknown; pr?: unknown }
      | undefined;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res
        .status(400)
        .json({ error: 'Body must be an object', code: 'invalid_metadata' });
      return;
    }

    if (body.pr !== undefined) {
      res.status(400).json({
        error: 'This route renames a session; `pr` is not supported',
        code: 'pr_not_supported',
      });
      return;
    }

    const displayName = body.displayName;
    if (typeof displayName !== 'string') {
      res.status(400).json({
        error: '`displayName` must be a string',
        code: 'invalid_metadata',
      });
      return;
    }

    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      res.status(400).json({
        error:
          '`displayName` must be at most ' +
          MAX_DISPLAY_NAME_LENGTH +
          ' characters',
        code: 'display_name_too_long',
        maxLength: MAX_DISPLAY_NAME_LENGTH,
      });
      return;
    }

    let effective: SessionMetadataResult;
    try {
      effective = await daemon.updateSessionMetadata(sessionId, {
        displayName,
      });
    } catch (err) {
      const daemonStatus = asDaemonHttpError(err)?.status;
      const notFound =
        err instanceof UnknownSessionError ||
        daemonStatus === 404 ||
        (err as { status?: unknown } | undefined)?.status === 404;
      const rejected = daemonStatus === 400;
      void audit?.record({
        action: 'session_rename_failed',
        actorTokenId,
        target: sessionId,
        detail: {
          reason: notFound
            ? 'not_found'
            : rejected
              ? 'rejected'
              : 'daemon_unavailable',
        },
      });
      if (notFound) {
        res.status(404).json({
          error: 'Session is not loaded in the daemon',
          code: 'session_not_found',
        });
        return;
      }
      // The daemon's own 400 is a verdict on the name (blank, or carrying a
      // control character). Its code is a fixed token, so it is safe to pass
      // on; its message is not, because it can quote what was typed.
      if (rejected) {
        res.status(400).json({
          error: 'The daemon rejected this title',
          code: 'invalid_metadata',
        });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    void audit?.record({
      action: 'session_renamed',
      actorTokenId,
      target: sessionId,
      detail: { renamed: true },
    });

    res.status(200).json({ sessionId, ...effective });
  };
}
