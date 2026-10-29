/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read-only workspace file browser (add-capability-parity #107, first slice).
 *
 *   GET /rc/workspace/list?path=<rel>            -> the daemon's GET /list
 *   GET /rc/workspace/glob?pattern=<glob>        -> the daemon's GET /glob
 *   GET /rc/workspace/file?path=<rel>&line=&limit=&maxBytes=&cursor=
 *                                                -> the daemon's GET /file
 *   GET /rc/workspace/file/bytes?path=<rel>&offset=&maxBytes=
 *                                                -> the daemon's GET /file/bytes
 *
 * Each takes the family's optional `?workspace=<cwd>` target
 * (rc-workspace-scoping, #28); absent or empty means the default/boot
 * workspace. The target is pool routing only and never reaches the daemon.
 *
 * WHY THE PAYLOAD IS THE DAEMON'S, UNTOUCHED
 *
 * `dirList`, `glob` and `fileStat` are typed `Promise<unknown>` in the built
 * SDK, and `readWorkspaceFile` returns the daemon's own
 * `DaemonWorkspaceFile`. There is no gateway-side type to reshape into, and
 * inventing one would read as authority over a shape the daemon owns: the
 * listing's `truncated` flag, the file's `nextCursor`/`hasMore` pair and the
 * `matchedIgnore` verdict are all things the daemon may extend, and a copy
 * here would silently drop whatever it adds. So every field travels.
 *
 * WHY PATHS ARE NOT CHECKED HERE
 *
 * Containment is the daemon's decision, not ours. It resolves every `path`
 * against the bound workspace and answers `path_outside_workspace` itself
 * (packages/cli/src/serve/routes/workspace-file-read.ts:563), and it returns
 * `workspaceRelative` forms so an absolute host path never leaves the
 * daemon. A second containment check in the gateway would be a copy of that
 * rule, and a copy that drifts is worse than none: it would look like a
 * boundary while the daemon's own answer stayed authoritative.
 *
 * WHY THE FAILURE IS RELAYED, INCLUDING ITS 404
 *
 * The daemon reports an fs refusal as `{errorKind, error, hint, status}` with
 * its own numeric status (sendFsError at workspace-file-read.ts:94). Those
 * statuses mean specific things: 400 a malformed window, 403 a trust or
 * permission refusal, 404 a path that is not there, 422 the file is binary
 * (`binary_file`, fs/errors.ts:21 - which is the caller's cue to ask
 * /file/bytes instead). Flattening any of them into a 502 tells the caller to
 * retry something that can never succeed, so the status and the kind travel.
 *
 * A 404 with no fs envelope behind it is a different animal: that is an old
 * daemon with no file routes at all, which is a capability gap rather than an
 * answer about a path. It maps to 502 `file_reads_unsupported`, the same
 * treatment `routes/workspaceTools.ts` gives a daemon that predates its
 * surface.
 *
 * WHAT IS NOT AUDITED
 *
 * No audit row, matching the sibling workspace reads
 * (`routes/workspaceTools.ts:188`). A file read's only identifying field is
 * its path, and paths are deliberately kept out of every audit record, so a
 * row here could name neither the file nor its contents. A record that cannot
 * say what it recorded is noise, not a trail.
 */

import type { Request, RequestHandler, Response } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import { WorkspacePoolFullError } from '../daemonPool.js';
import { relayDaemonAuthFailure } from './daemonAuth.js';

/** The daemon surface these routes need. */
export type WorkspaceFilesDaemon = Pick<
  SessionDaemon,
  'dirList' | 'glob' | 'readWorkspaceFile' | 'readWorkspaceFileBytes'
>;

/**
 * rc-workspace-scoping (#28): resolve the optional `workspace` target out of
 * a GET query value. Absent or empty string means the default/boot workspace
 * (`undefined`); a non-empty string is trimmed and used as the target cwd;
 * any other shape is a 400 `invalid_workspace`.
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

/**
 * Read a required string query. A repeated param arrives as an array, which
 * is refused rather than guessed at: picking the first of `?path=a&path=b`
 * would answer a question about a file the caller may not have meant.
 */
function requireQuery(
  res: Response,
  raw: unknown,
  name: string,
): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (!res.headersSent) {
    res.status(400).json({
      error: `\`${name}\` must be a non-empty string`,
      code: 'invalid_query',
    });
  }
  return null;
}

/**
 * Parse an optional positive-integer window param. The SHAPE is the
 * gateway's to check, because the SDK's opts are numbers and a non-numeric
 * string cannot be forwarded as one. The RANGE is the daemon's: it answers a
 * value outside its own bounds with 400 plus the limit that applies, and that
 * answer is relayed rather than re-implemented here.
 *
 * Returns `undefined` when absent, `null` when malformed (and sends the 400).
 */
function parsePositiveInt(
  res: Response,
  raw: unknown,
  name: string,
): number | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && Number.isSafeInteger(n)) return n;
  }
  if (!res.headersSent) {
    res.status(400).json({
      error: `\`${name}\` must be a positive integer`,
      code: 'invalid_query',
    });
  }
  return null;
}

/** The daemon's fs refusal envelope, as `sendFsError` builds it. */
interface FsErrorBody {
  errorKind?: unknown;
  error?: unknown;
  hint?: unknown;
}

/**
 * Map a daemon failure to this route family's response, relaying the daemon's
 * own status and `errorKind`. See the file header for why a refusal is never
 * flattened into a 502.
 */
export function sendWorkspaceFileError(res: Response, err: unknown): void {
  if (res.headersSent) return;
  // Targeting a non-default workspace spawns on demand; at the pool cap with
  // no idle victim that is a 503, not a daemon failure.
  if (err instanceof WorkspacePoolFullError) {
    res.status(503).json({
      error: `Workspace daemon pool is full (max ${err.maxDaemons})`,
      code: 'workspace_pool_full',
    });
    return;
  }
  if (relayDaemonAuthFailure(res, err, 'workspace_files')) return;
  const status = (err as { status?: unknown }).status;
  const body = (err as { body?: unknown }).body as FsErrorBody | undefined;
  const kind = typeof body?.errorKind === 'string' ? body.errorKind : undefined;
  const message = typeof body?.error === 'string' ? body.error : undefined;
  const hint = typeof body?.hint === 'string' ? body.hint : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // A 404 that carries no fs envelope is not the daemon answering "that
    // path is not here" - it is a daemon with no file routes at all.
    if (status === 404 && kind === undefined) {
      res.status(502).json({
        error: 'Daemon does not support the workspace file routes',
        code: 'file_reads_unsupported',
      });
      return;
    }
    res.status(status).json({
      error: message ?? 'Daemon rejected the request',
      code: kind ?? 'daemon_rejected',
      ...(hint !== undefined ? { hint } : {}),
    });
    return;
  }
  res.status(502).json({
    error: 'Daemon unavailable',
    code: 'daemon_unavailable',
  });
}

/**
 * GET /rc/workspace/list?path=<rel> - one directory, entries as the daemon
 * shaped them: `{ name, kind, ignored }` plus the response's `truncated`
 * flag, which is the daemon saying it stopped at its own entry cap.
 */
export function createWorkspaceListRoute(
  daemon: Pick<SessionDaemon, 'dirList'>,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const target = parseWorkspaceTarget(req.query['workspace']);
    if (!target.ok) {
      res
        .status(400)
        .json({ error: 'Invalid workspace target', code: 'invalid_workspace' });
      return;
    }
    const path = requireQuery(res, req.query['path'], 'path');
    if (path === null) return;
    try {
      res.status(200).json(await daemon.dirList(path, target.cwd));
    } catch (err) {
      sendWorkspaceFileError(res, err);
    }
  };
}

/**
 * GET /rc/workspace/glob?pattern=<glob> - names only, workspace-relative.
 * The daemon caps results and says so with `truncated`; both travel.
 */
export function createWorkspaceGlobRoute(
  daemon: Pick<SessionDaemon, 'glob'>,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const target = parseWorkspaceTarget(req.query['workspace']);
    if (!target.ok) {
      res
        .status(400)
        .json({ error: 'Invalid workspace target', code: 'invalid_workspace' });
      return;
    }
    const pattern = requireQuery(res, req.query['pattern'], 'pattern');
    if (pattern === null) return;
    try {
      res.status(200).json(await daemon.glob(pattern, target.cwd));
    } catch (err) {
      sendWorkspaceFileError(res, err);
    }
  };
}

/**
 * GET /rc/workspace/file?path=<rel> - text content plus the daemon's own
 * window fields. `line`/`limit`/`maxBytes`/`cursor` are forwarded when
 * well-formed so a caller can page a large file the way the daemon intends;
 * `truncated` and `nextCursor` come back so the page can say "there is more"
 * instead of showing a partial file as if it were whole.
 */
export function createWorkspaceFileRoute(
  daemon: Pick<SessionDaemon, 'readWorkspaceFile'>,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const target = parseWorkspaceTarget(req.query['workspace']);
    if (!target.ok) {
      res
        .status(400)
        .json({ error: 'Invalid workspace target', code: 'invalid_workspace' });
      return;
    }
    const path = requireQuery(res, req.query['path'], 'path');
    if (path === null) return;
    const maxBytes = parsePositiveInt(res, req.query['maxBytes'], 'maxBytes');
    if (maxBytes === null) return;
    const line = parsePositiveInt(res, req.query['line'], 'line');
    if (line === null) return;
    const limit = parsePositiveInt(res, req.query['limit'], 'limit');
    if (limit === null) return;
    const rawCursor = req.query['cursor'];
    const cursor =
      typeof rawCursor === 'string' && rawCursor.length > 0
        ? rawCursor
        : undefined;
    try {
      res.status(200).json(
        await daemon.readWorkspaceFile(
          path,
          {
            ...(maxBytes !== undefined ? { maxBytes } : {}),
            ...(line !== undefined ? { line } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(cursor !== undefined ? { cursor } : {}),
          },
          undefined,
          target.cwd,
        ),
      );
    } catch (err) {
      sendWorkspaceFileError(res, err);
    }
  };
}

/**
 * GET /rc/workspace/file/bytes?path=<rel> - the binary read, which is what a
 * caller reaches for after `/file` answers 422 `binary_file`. The daemon
 * returns base64 rather than raw bytes, so the payload is JSON like the
 * others and needs no download dance around an Authorization header.
 */
export function createWorkspaceFileBytesRoute(
  daemon: Pick<SessionDaemon, 'readWorkspaceFileBytes'>,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const target = parseWorkspaceTarget(req.query['workspace']);
    if (!target.ok) {
      res
        .status(400)
        .json({ error: 'Invalid workspace target', code: 'invalid_workspace' });
      return;
    }
    const path = requireQuery(res, req.query['path'], 'path');
    if (path === null) return;
    const offset = parsePositiveInt(res, req.query['offset'], 'offset');
    if (offset === null) return;
    const maxBytes = parsePositiveInt(res, req.query['maxBytes'], 'maxBytes');
    if (maxBytes === null) return;
    try {
      res.status(200).json(
        await daemon.readWorkspaceFileBytes(
          path,
          {
            ...(offset !== undefined ? { offset } : {}),
            ...(maxBytes !== undefined ? { maxBytes } : {}),
          },
          undefined,
          target.cwd,
        ),
      );
    } catch (err) {
      sendWorkspaceFileError(res, err);
    }
  };
}
