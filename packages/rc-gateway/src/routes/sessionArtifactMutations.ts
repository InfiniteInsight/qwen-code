/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, RequestHandler, Response } from 'express';
import type {
  DaemonSessionArtifactInput,
  DaemonSessionArtifactMutationResult,
} from '@qwen-code/sdk/daemon';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import {
  asDaemonHttpError,
  canSeeDaemonDetail,
  daemonErrorBody,
  daemonFailureDetail,
} from '../daemonHttpError.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * Issue #128: the artifact mutation pair, the relays #127 left out.
 *
 *   POST   /session/:id/artifacts               -> record one artifact
 *   DELETE /session/:id/artifacts/:artifactId   -> drop one
 *
 * WHY THIS WAS BLOCKED AND IS NOT NOW
 *
 * The daemon's two routes call `requireSessionArtifactClientId`
 * (cli/src/serve/routes/session.ts:468) and answer 403 `client_id_required`
 * to a request without a session-bound client id, and the gateway had none to
 * send (routes/sessionArtifacts.ts, the read pair, says so). The #110 sources
 * slice settled it: the daemon stamps a client id on the gateway's own
 * attachment (the answer to a create or a load), `DaemonPool` keeps it for the
 * session, and `boundClientId` hands it back for as long as the daemon that
 * stamped it still owns the session. The pool methods below this route use
 * that id exactly as the sources writes do, so nothing here knows about it.
 *
 * WHAT THE DAEMON DOES WITH THE ID, AND WHAT FOLLOWS
 *
 * The id names the owner of what the call records: an artifact added with it
 * is client-owned by this gateway's attachment, and the daemon refuses another
 * client's change to it (403 `session_artifact_forbidden`, relayed as is). So
 * every phone served by one gateway acts as the same client, and an artifact
 * the model or a hook recorded cannot be removed from the phone either. That
 * is the daemon's rule, relayed, not restated.
 *
 * WHAT THIS ROUTE CHECKS AND WHAT IT LEAVES TO THE DAEMON
 *
 * The body's SHAPE only: an object, with the daemon's own input fields, each
 * of the type the daemon reads it as. Lengths, the locator rule (exactly one of
 * `workspacePath`, `managedId`, `url`), the allowed kinds, the markup check and
 * the path and URL rules are the daemon's, and its refusal is passed through
 * with its status and code. The body is rebuilt from the known fields, so a
 * field nobody asked about (`source`, `clientId`) is refused here rather than
 * dropped quietly on the daemon's side.
 *
 * WHAT IS ECHOED (issue #211 changed this)
 *
 * The daemon's code, always, and its `field` when the field is one of the
 * input's own names, which is what the page needs to point at the field.
 *
 * The daemon's message depends on who asked. A caller holding write or owner
 * (every caller that reaches this file in production, since both routes are
 * mounted at write) gets the daemon's own message in `error`: a refusal to
 * inspect a `workspacePath` says so in the daemon's words, and a cross-client
 * refusal names the artifact, because "The daemon refused this request" tells
 * the person holding the phone nothing they can act on. A transport failure
 * (the daemon unreachable) names the error and its text the same way. Anyone
 * else (a share guest, a token without write, a request with no resolved
 * client) gets the gateway's fixed sentence and the code, which is the
 * strictest reduction: nothing the daemon said, since its text can carry a host
 * path or an artifact id the guest has no business with. `canSeeDaemonDetail`
 * in daemonHttpError.ts decides, and fails closed.
 *
 * SCOPE
 *
 * WRITE, like the content read beside it: recording a workspace file as an
 * artifact makes that file readable at WRITE, which is a write-class act. A
 * share token never holds WRITE, and the handler asks for a share before it
 * touches the body, so a guest's request is refused without being read.
 *
 * AUDIT
 *
 * One row per attempt, with the count of changes the daemon reported or the
 * reason it failed. No title, path, link or id: the audit log carries none.
 */

/** The names a body may carry, and the type the daemon reads each as. */
const STRING_FIELDS = [
  'title',
  'kind',
  'storage',
  'description',
  'workspacePath',
  'managedId',
  'url',
  'mimeType',
  'retention',
] as const;
const INPUT_FIELDS: readonly string[] = [
  ...STRING_FIELDS,
  'sizeBytes',
  'metadata',
  'clientRetained',
];
/** Sanity bound on the route parameter; the daemon looks the id up itself. */
const MAX_ARTIFACT_ID = 512;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function refuse(res: Response, code: string, error: string): void {
  res.status(400).json({ error, code });
}

type Outcome =
  | 'not_loaded'
  | 'not_bound'
  | 'rejected'
  | 'unsupported'
  | 'daemon_unavailable';

/**
 * The body checked for shape and rebuilt from the known fields. Nothing about
 * a value is judged beyond its type: that is the daemon's call.
 */
function parseArtifactInput(
  body: unknown,
):
  | { ok: true; input: DaemonSessionArtifactInput }
  | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: 'Body must be an object' };
  const stray = Object.keys(body).find((k) => !INPUT_FIELDS.includes(k));
  if (stray !== undefined) {
    return {
      ok: false,
      error: `Only ${INPUT_FIELDS.map((k) => '`' + k + '`').join(', ')} can be sent`,
    };
  }
  const input: Record<string, unknown> = {};
  for (const key of STRING_FIELDS) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') {
      return { ok: false, error: `\`${key}\` must be a string` };
    }
    input[key] = v;
  }
  if (typeof input['title'] !== 'string') {
    return { ok: false, error: '`title` is required' };
  }
  const sizeBytes = body['sizeBytes'];
  if (sizeBytes !== undefined) {
    if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes)) {
      return { ok: false, error: '`sizeBytes` must be a number' };
    }
    input['sizeBytes'] = sizeBytes;
  }
  const clientRetained = body['clientRetained'];
  if (clientRetained !== undefined) {
    if (typeof clientRetained !== 'boolean') {
      return { ok: false, error: '`clientRetained` must be true or false' };
    }
    input['clientRetained'] = clientRetained;
  }
  const metadata = body['metadata'];
  if (metadata !== undefined) {
    if (
      !isPlainObject(metadata) ||
      !Object.values(metadata).every(
        (v) =>
          v === null ||
          typeof v === 'string' ||
          typeof v === 'boolean' ||
          (typeof v === 'number' && Number.isFinite(v)),
      )
    ) {
      return {
        ok: false,
        error: '`metadata` must be an object of strings, numbers, true, false or null',
      };
    }
    input['metadata'] = { ...metadata };
  }
  return { ok: true, input: input as unknown as DaemonSessionArtifactInput };
}

/** The daemon's refusal code: top-level `code`, or the validation envelope's. */
function daemonCode(body: Record<string, unknown> | undefined): {
  code: string | undefined;
  field: string | undefined;
} {
  if (body === undefined) return { code: undefined, field: undefined };
  if (typeof body['code'] === 'string') {
    return { code: body['code'], field: undefined };
  }
  const nested = body['error'];
  if (isPlainObject(nested)) {
    return {
      code: typeof nested['code'] === 'string' ? nested['code'] : undefined,
      field:
        typeof nested['field'] === 'string' &&
        INPUT_FIELDS.includes(nested['field'])
          ? nested['field']
          : undefined,
    };
  }
  return { code: undefined, field: undefined };
}

function sendArtifactError(
  req: Pick<Request, 'rcClient'>,
  res: Response,
  err: unknown,
): Outcome {
  // Write or owner: the daemon's own words go back. Everyone else: the fixed
  // sentence below, which is also what this function said before #211.
  const detail = canSeeDaemonDetail(req) ? daemonFailureDetail(err) : undefined;
  if (err instanceof UnknownSessionError) {
    // The pool's session-to-daemon map is in memory and drops the entry when
    // a session dies, so this proves the gateway has no one to ask, not that
    // the conversation is gone: the sibling artifact reads answer it the same.
    res.status(409).json({
      error: 'Open this conversation before changing its artifacts',
      code: 'session_not_loaded',
    });
    return 'not_loaded';
  }
  const http = asDaemonHttpError(err);
  const body = daemonErrorBody(err);
  const { code, field } = daemonCode(body);
  const status = http?.status;
  if (code === 'client_id_required' || code === 'invalid_client_id') {
    // The sources routes' answer, word for word: both refusals mean the same
    // thing to the person holding the phone. Open the conversation again.
    res.status(409).json({
      error:
        'This gateway is not attached to the conversation as the daemon ' +
        'needs; open the conversation again and retry',
      code: 'client_not_bound',
    });
    return 'not_bound';
  }
  if (status === 404 && body === undefined) {
    // Express's own "Cannot POST": a daemon that predates the routes.
    res.status(502).json({
      error: 'Daemon does not serve artifact changes',
      code: 'artifact_mutations_unsupported',
    });
    return 'unsupported';
  }
  if (status !== undefined && status >= 400 && status < 500) {
    res.status(status).json({
      error:
        detail?.message ??
        (code === 'VALIDATION_FAILED'
          ? field
            ? `The daemon refused the ${field} field`
            : 'The daemon refused this artifact'
          : 'The daemon refused this request'),
      code: code ?? (status === 404 ? 'session_not_found' : 'daemon_rejected'),
      ...(field ? { field } : {}),
    });
    return 'rejected';
  }
  if (status === 503 && code !== undefined) {
    res.status(503).json({
      error: detail?.message ?? 'The daemon could not complete this change',
      code,
    });
    return 'daemon_unavailable';
  }
  // Anything else: a dead socket, a 5xx the daemon sent, a body that was not
  // JSON. The owner is told which, and with what text.
  const head = detail
    ? [
        detail.status !== undefined ? `HTTP ${detail.status}` : undefined,
        detail.code,
        detail.errorName,
      ]
        .filter((p) => p !== undefined)
        .join(' ')
    : '';
  res.status(502).json({
    error: detail
      ? 'Daemon unavailable: ' +
        [head, detail.message].filter((p) => p).join(': ')
      : 'Daemon unavailable',
    code: 'daemon_unavailable',
  });
  return 'daemon_unavailable';
}

/** A share guest's request, refused before anything of it is read. */
function refuseShare(
  req: { rcClient?: { shareId?: string } },
  res: Response,
): boolean {
  if (req.rcClient?.shareId === undefined) return false;
  res.status(403).json({ error: 'Insufficient scope', code: 'scope_required' });
  return true;
}

function changeCount(result: DaemonSessionArtifactMutationResult): number {
  return Array.isArray(result?.changes) ? result.changes.length : 0;
}

/** POST /session/:id/artifacts: record one artifact. */
export function createSessionArtifactAddRoute(
  daemon: Pick<SessionDaemon, 'addSessionArtifact'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    if (refuseShare(req, res)) return;
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const parsed = parseArtifactInput(req.body);
    if (!parsed.ok) return refuse(res, 'invalid_artifact', parsed.error);
    let result: DaemonSessionArtifactMutationResult;
    try {
      result = await daemon.addSessionArtifact(sessionId, parsed.input);
    } catch (err) {
      const reason = sendArtifactError(req, res, err);
      void audit?.record({
        action: 'session_artifact_add_failed',
        actorTokenId,
        target: sessionId,
        detail: { reason },
      });
      return;
    }
    // A count, never the title, path or link: the audit log carries none.
    void audit?.record({
      action: 'session_artifact_added',
      actorTokenId,
      target: sessionId,
      detail: { changes: changeCount(result) },
    });
    res.status(200).json(result);
  };
}

/** DELETE /session/:id/artifacts/:artifactId: drop one artifact. */
export function createSessionArtifactRemoveRoute(
  daemon: Pick<SessionDaemon, 'removeSessionArtifact'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    if (refuseShare(req, res)) return;
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const artifactId = req.params.artifactId;
    if (
      typeof artifactId !== 'string' ||
      artifactId.length === 0 ||
      artifactId.length > MAX_ARTIFACT_ID ||
      artifactId.includes('/') ||
      artifactId.includes('..')
    ) {
      return refuse(res, 'invalid_artifact_id', 'Not an artifact id');
    }
    let result: DaemonSessionArtifactMutationResult;
    try {
      result = await daemon.removeSessionArtifact(sessionId, artifactId);
    } catch (err) {
      const reason = sendArtifactError(req, res, err);
      void audit?.record({
        action: 'session_artifact_remove_failed',
        actorTokenId,
        target: sessionId,
        detail: { reason },
      });
      return;
    }
    void audit?.record({
      action: 'session_artifact_removed',
      actorTokenId,
      target: sessionId,
      detail: { changes: changeCount(result) },
    });
    res.status(200).json(result);
  };
}
