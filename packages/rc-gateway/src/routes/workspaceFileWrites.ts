/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workspace file writes (#123, the file-write slice of the #107 family).
 *
 *   GET  /rc/workspace/stat?path=<rel>          -> the daemon's GET /stat
 *   POST /rc/workspace/file/write  {path, content, mode, expectedHash?}
 *                                               -> the daemon's POST /file/write
 *   POST /rc/workspace/file/edit   {path, oldText, newText, expectedHash}
 *                                               -> the daemon's POST /file/edit
 *   POST /rc/workspace/file/upload?path=<rel>   raw body
 *                                               -> the daemon's POST /file/upload
 *   POST /rc/workspace/file/delete {path}       -> the daemon's
 *                                      POST /workspaces/:workspace/file/delete
 *
 * Each takes the family's optional workspace target (#28): a `workspace`
 * query value on the GET and the upload, a `workspace` body field on the JSON
 * posts. It is pool routing only and never reaches the daemon.
 *
 * WHY PATHS PASS THROUGH UNCHANGED
 *
 * Containment is the daemon's decision, exactly as for the reads
 * (routes/workspaceFiles.ts). Every one of these daemon handlers resolves the
 * path against the bound workspace itself, refuses a suspicious pattern, and
 * refuses a workspace root as a delete target. A second copy of those rules
 * here would look like a boundary while the daemon's stayed authoritative.
 * What the gateway does refuse is input that cannot be a request at all: a
 * path that is not a non-empty string, content that is not a string, a mode
 * that is not one of the two the SDK type allows. Those are 400s before any
 * daemon is asked.
 *
 * WHY STALENESS IS THE DAEMON'S HASH, NOT A GATEWAY CHECK
 *
 * `mode: 'replace'` and every edit carry `expectedHash`, the `sha256:` of the
 * file as the caller read it, and the daemon compares it under its own path
 * lock before writing (fs/workspace-file-system.ts, `readExistingTextMeta`).
 * A changed file answers 409 `hash_mismatch`. That check is atomic with the
 * write; anything the gateway could add (a stat before the write) would have
 * a window between its answer and the daemon's write, so the gateway relays
 * the daemon's verdict and adds none of its own.
 *
 * WHY THE BODIES ARE SIZE GATED HERE (#196)
 *
 * The app-wide JSON parser keeps Express's 100 KB default, which would refuse
 * an ordinary source file as `entity.too.large` before this route ran, and an
 * upload is a raw body the JSON parser never reads at all. So these three
 * routes read their own bodies, after the scope check, with the same limit the
 * attachment upload enforces (the configured `--max-attachment-bytes` held to
 * what the daemon advertises). A body over it is refused with 413
 * `file_too_large` and `maxBytes` before it is buffered: the same code and
 * field the daemon's own upload refusal carries, so a page handles one shape
 * whichever side said no.
 *
 * WHY DELETE HAS ITS OWN WAY TO THE DAEMON
 *
 * The daemon mounts file deletion only under the workspace-qualified prefix
 * (`registerWorkspaceQualifiedFileWriteRoutes`), and the SDK carries
 * `deleteWorkspaceFile` only on `WorkspaceDaemonClient`. A bare `DaemonClient`
 * therefore has no method of that name, which is the D61 trap: the pool
 * implements it, the client does not, and tsc cannot see the gap. The
 * interface marks it optional, and this route falls back to the same
 * primary-workspace helper the pool uses when it is handed a bare client.
 *
 * WHAT IS AUDITED
 *
 * Each successful write, edit, upload and delete leaves a row, because each
 * changes the host. The row names the action, the actor and (for a
 * non-default target) the workspace, and never the path, following the #107
 * rule that paths stay out of every audit record. A read (stat) leaves none,
 * like the sibling reads.
 */

import express from 'express';
import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
} from 'express';
import type {
  DaemonWorkspaceFileWriteRequest,
  DaemonWorkspaceFileEditRequest,
} from '@qwen-code/sdk/daemon';
import type { SessionDaemon } from '../daemonPool.js';
import {
  WorkspacePoolFullError,
  deleteWorkspaceFileOnPrimary,
  type PrimaryWorkspaceDeleteClient,
} from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { relayDaemonAuthFailure } from './daemonAuth.js';

/** The daemon surface these routes need. */
export type WorkspaceFileWritesDaemon = Pick<
  SessionDaemon,
  | 'fileStat'
  | 'writeWorkspaceFile'
  | 'editWorkspaceFile'
  | 'uploadWorkspaceFile'
  | 'deleteWorkspaceFile'
>;

/**
 * Resolve the optional workspace target (#28). Absent or empty is the
 * default workspace; a non-empty string is trimmed and used; anything else
 * is a 400 `invalid_workspace`.
 */
function parseWorkspaceTarget(
  raw: unknown,
): { ok: true; cwd: string | undefined } | { ok: false } {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, cwd: undefined };
  }
  if (typeof raw === 'string') return { ok: true, cwd: raw.trim() };
  return { ok: false };
}

function badRequest(res: Response, error: string, code: string): void {
  if (!res.headersSent) res.status(400).json({ error, code });
}

/** A required non-empty string, or a 400 naming the field. */
function requireString(
  res: Response,
  raw: unknown,
  name: string,
  code: string,
): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  badRequest(res, `\`${name}\` must be a non-empty string`, code);
  return null;
}

/** The daemon's fs refusal envelope, as `sendFsError` builds it. */
interface FsErrorBody {
  errorKind?: unknown;
  error?: unknown;
  hint?: unknown;
  maxBytes?: unknown;
  retryAfterSeconds?: unknown;
}

/**
 * Map a daemon failure to this family's response, relaying the daemon's own
 * status and `errorKind`: 400 a malformed request, 403 trust, 404 a missing
 * path, 409 `hash_mismatch` or `file_already_exists`, 413 `file_too_large`
 * (with the daemon's `maxBytes`), 415, 422, 429 `upload_busy` (with its
 * `retryAfterSeconds`). Flattening any of them into a 502 would tell the page
 * to retry something that cannot succeed, and the 409 in particular is how a
 * stale save is refused.
 *
 * A 404 with no envelope is a daemon without these routes at all, so it is a
 * capability gap: 502 `file_writes_unsupported`. So is a daemon whose
 * capabilities name no primary workspace for the delete to address.
 */
export function sendWorkspaceFileWriteError(res: Response, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof WorkspacePoolFullError) {
    res.status(503).json({
      error: `Workspace daemon pool is full (max ${err.maxDaemons})`,
      code: 'workspace_pool_full',
    });
    return;
  }
  if ((err as { name?: unknown } | null)?.name === 'DaemonCapabilityMissingError') {
    res.status(502).json({
      error: 'Daemon does not say which workspace to delete from',
      code: 'file_writes_unsupported',
    });
    return;
  }
  if (relayDaemonAuthFailure(res, err, 'workspace_file_writes')) return;
  const status = (err as { status?: unknown } | null)?.status;
  const body = (err as { body?: unknown } | null)?.body as
    | FsErrorBody
    | undefined;
  const kind = typeof body?.errorKind === 'string' ? body.errorKind : undefined;
  const message = typeof body?.error === 'string' ? body.error : undefined;
  const hint = typeof body?.hint === 'string' ? body.hint : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    if (status === 404 && kind === undefined) {
      res.status(502).json({
        error: 'Daemon does not support the workspace file write routes',
        code: 'file_writes_unsupported',
      });
      return;
    }
    res.status(status).json({
      error: message ?? 'Daemon rejected the request',
      code: kind ?? 'daemon_rejected',
      ...(hint !== undefined ? { hint } : {}),
      ...(typeof body?.maxBytes === 'number' ? { maxBytes: body.maxBytes } : {}),
      ...(typeof body?.retryAfterSeconds === 'number'
        ? { retryAfterSeconds: body.retryAfterSeconds }
        : {}),
    });
    return;
  }
  res.status(502).json({
    error: 'Daemon unavailable',
    code: 'daemon_unavailable',
  });
}

/**
 * Body readers for the write family, gated on the #196 limit. `kind: 'json'`
 * for write and edit, `'raw'` for the upload. (Delete's body is one path, so
 * the app-wide JSON parser reads it.) The limit is resolved per
 * request (it follows the daemon's advertised cap) and one parser is kept per
 * distinct limit. Parser failures are answered here in this family's
 * envelope rather than falling to the app's backstop.
 */
export function createWorkspaceFileBody(
  kind: 'json' | 'raw',
  maxBytes: number | (() => Promise<number>),
): Array<RequestHandler | ErrorRequestHandler> {
  const resolve =
    typeof maxBytes === 'number' ? async () => maxBytes : maxBytes;
  const parsers = new Map<number, RequestHandler>();
  const read: RequestHandler = (req, res, next) => {
    resolve().then(
      (limit) => {
        (res.locals as { workspaceFileLimit?: number }).workspaceFileLimit =
          limit;
        let parser = parsers.get(limit);
        if (!parser) {
          parser =
            kind === 'json'
              ? express.json({ limit })
              : express.raw({ type: () => true, limit });
          parsers.set(limit, parser);
        }
        parser(req, res, next);
      },
      (err: unknown) => next(err),
    );
  };
  const guard: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const type = (err as { type?: unknown }).type;
    if (type === 'entity.too.large') {
      const limit = (res.locals as { workspaceFileLimit?: number })
        .workspaceFileLimit;
      res.status(413).json({
        error: `Files must not exceed ${limit} bytes`,
        code: 'file_too_large',
        ...(typeof limit === 'number' ? { maxBytes: limit } : {}),
      });
      return;
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON body', code: 'invalid_json' });
      return;
    }
    res.status(400).json({
      error: 'Could not read the request body',
      code: 'invalid_body',
    });
  };
  return [read, guard];
}

function auditWorkspaceFile(
  audit: AuditRecorder | undefined,
  req: Request,
  action:
    | 'workspace_file_written'
    | 'workspace_file_edited'
    | 'workspace_file_uploaded'
    | 'workspace_file_deleted',
  cwd: string | undefined,
  extra: Record<string, unknown> = {},
): void {
  void audit?.record({
    action,
    actorTokenId: req.rcClient?.id,
    subActor: req.rcClient?.subActor,
    // Never the path (#107): only what kind of change, and where when the
    // target is not the default workspace.
    detail: { ...extra, ...(cwd !== undefined ? { workspace: cwd } : {}) },
  });
}

function jsonBody(req: Request): Record<string, unknown> {
  const body = req.body as unknown;
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * GET /rc/workspace/stat?path=<rel> - one path's kind, size and mtime, as the
 * daemon shaped them (`{kind:'stat', path, type, sizeBytes, modifiedMs}`). The
 * page reads it for the delete confirmation, which names the size.
 */
export function createWorkspaceStatRoute(
  daemon: Pick<SessionDaemon, 'fileStat'>,
): RequestHandler {
  return async (req, res) => {
    const target = parseWorkspaceTarget(req.query['workspace']);
    if (!target.ok) {
      badRequest(res, 'Invalid workspace target', 'invalid_workspace');
      return;
    }
    const path = requireString(res, req.query['path'], 'path', 'invalid_query');
    if (path === null) return;
    try {
      res.status(200).json(await daemon.fileStat(path, target.cwd));
    } catch (err) {
      sendWorkspaceFileWriteError(res, err);
    }
  };
}

/**
 * POST /rc/workspace/file/write - create a file (`mode: 'create'`, refused
 * with 409 `file_already_exists` when the name is taken) or replace one
 * (`mode: 'replace'`, which requires the `expectedHash` of the version the
 * caller read). Answers 201 for a create and 200 for a replace, as the daemon
 * does, with the daemon's result untouched: its `hash` is what the next save
 * of the same file must carry.
 */
export function createWorkspaceFileWriteRoute(
  daemon: Pick<SessionDaemon, 'writeWorkspaceFile'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const body = jsonBody(req);
    const target = parseWorkspaceTarget(body['workspace']);
    if (!target.ok) {
      badRequest(res, 'Invalid workspace target', 'invalid_workspace');
      return;
    }
    const path = requireString(res, body['path'], 'path', 'invalid_body');
    if (path === null) return;
    const content = body['content'];
    if (typeof content !== 'string') {
      badRequest(res, '`content` must be a string', 'invalid_body');
      return;
    }
    const mode = body['mode'];
    if (mode !== 'create' && mode !== 'replace') {
      badRequest(res, '`mode` must be "create" or "replace"', 'invalid_body');
      return;
    }
    const rawHash = body['expectedHash'];
    if (
      (mode === 'replace' || rawHash !== undefined) &&
      (typeof rawHash !== 'string' || rawHash.length === 0)
    ) {
      badRequest(
        res,
        mode === 'replace'
          ? '`expectedHash` is required to replace a file'
          : '`expectedHash` must be a non-empty string',
        'invalid_body',
      );
      return;
    }
    // The shape is checked; the `sha256:<hex>` grammar is the daemon's to
    // judge, and its 400 is relayed.
    const expectedHash = rawHash as DaemonWorkspaceFileWriteRequest['expectedHash'];
    const request: DaemonWorkspaceFileWriteRequest =
      mode === 'replace'
        ? { path, content, mode, expectedHash: expectedHash! }
        : {
            path,
            content,
            mode,
            ...(expectedHash !== undefined ? { expectedHash } : {}),
          };
    try {
      const result = await daemon.writeWorkspaceFile(
        request,
        undefined,
        target.cwd,
      );
      auditWorkspaceFile(audit, req, 'workspace_file_written', target.cwd, {
        mode,
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      sendWorkspaceFileWriteError(res, err);
    }
  };
}

/**
 * POST /rc/workspace/file/edit - the daemon's single search-and-replace:
 * `oldText` must occur exactly once in the version whose hash is
 * `expectedHash`. Mounted for completeness of the family; the page saves
 * through `file/write` in replace mode (see the report on #123).
 */
export function createWorkspaceFileEditRoute(
  daemon: Pick<SessionDaemon, 'editWorkspaceFile'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const body = jsonBody(req);
    const target = parseWorkspaceTarget(body['workspace']);
    if (!target.ok) {
      badRequest(res, 'Invalid workspace target', 'invalid_workspace');
      return;
    }
    const path = requireString(res, body['path'], 'path', 'invalid_body');
    if (path === null) return;
    const oldText = body['oldText'];
    const newText = body['newText'];
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      badRequest(
        res,
        '`oldText` and `newText` must be strings',
        'invalid_body',
      );
      return;
    }
    const expectedHash = requireString(
      res,
      body['expectedHash'],
      'expectedHash',
      'invalid_body',
    );
    if (expectedHash === null) return;
    const request: DaemonWorkspaceFileEditRequest = {
      path,
      oldText,
      newText,
      expectedHash: expectedHash as DaemonWorkspaceFileEditRequest['expectedHash'],
    };
    try {
      const result = await daemon.editWorkspaceFile(
        request,
        undefined,
        target.cwd,
      );
      auditWorkspaceFile(audit, req, 'workspace_file_edited', target.cwd);
      res.status(200).json(result);
    } catch (err) {
      sendWorkspaceFileWriteError(res, err);
    }
  };
}

/**
 * POST /rc/workspace/file/upload?path=<rel> - the file as the raw body. The
 * daemon never overwrites: an occupied name is numbered (`name (1).ext`), so
 * the `path` in the 201 is the name the file actually got and the page shows
 * that one. Zero bytes is a legitimate (empty) file, so it is not refused.
 */
export function createWorkspaceFileUploadRoute(
  daemon: Pick<SessionDaemon, 'uploadWorkspaceFile'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const target = parseWorkspaceTarget(req.query['workspace']);
    if (!target.ok) {
      badRequest(res, 'Invalid workspace target', 'invalid_workspace');
      return;
    }
    const path = requireString(res, req.query['path'], 'path', 'invalid_query');
    if (path === null) return;
    const raw = req.body as unknown;
    const data = Buffer.isBuffer(raw) ? new Uint8Array(raw) : new Uint8Array(0);
    try {
      const result = await daemon.uploadWorkspaceFile(
        { path, data },
        undefined,
        target.cwd,
      );
      auditWorkspaceFile(audit, req, 'workspace_file_uploaded', target.cwd, {
        sizeBytes: result.sizeBytes,
      });
      res.status(201).json(result);
    } catch (err) {
      sendWorkspaceFileWriteError(res, err);
    }
  };
}

/**
 * POST /rc/workspace/file/delete {path} - one regular file. The daemon
 * refuses a directory, a symlink and a workspace root itself; directories are
 * a separate daemon route this slice does not mount. 204 on success: the SDK
 * returns nothing from the daemon's answer, and inventing a body here would
 * read as the daemon's.
 */
export function createWorkspaceFileDeleteRoute(
  daemon: Pick<SessionDaemon, 'deleteWorkspaceFile'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const body = jsonBody(req);
    const target = parseWorkspaceTarget(body['workspace']);
    if (!target.ok) {
      badRequest(res, 'Invalid workspace target', 'invalid_workspace');
      return;
    }
    const path = requireString(res, body['path'], 'path', 'invalid_body');
    if (path === null) return;
    try {
      if (typeof daemon.deleteWorkspaceFile === 'function') {
        await daemon.deleteWorkspaceFile(path, undefined, target.cwd);
      } else {
        // A bare DaemonClient: one daemon, so the target cannot pick another
        // one, the same as every other route handed a bare client.
        await deleteWorkspaceFileOnPrimary(
          daemon as unknown as PrimaryWorkspaceDeleteClient,
          path,
        );
      }
      auditWorkspaceFile(audit, req, 'workspace_file_deleted', target.cwd);
      res.status(204).end();
    } catch (err) {
      sendWorkspaceFileWriteError(res, err);
    }
  };
}
