/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { relayDaemonAuthFailure } from './daemonAuth.js';

/**
 * Session attachments (add-capability-parity #109, first slice: uploads).
 *
 *   POST /session/:id/attachments?name=<file name>   raw body -> the daemon's
 *                                                      POST /session/:id/attachments
 *   GET  /session/:id/attachments                    -> the daemon's
 *                                                      GET /session/:id/attachments
 *
 * and, for a phone on a connection that drops (#130), the resumable family at
 * the end of this file: `POST /session/:id/attachment-uploads` and its
 * `chunks/:index`, status, `complete` and cancel. See
 * {@link createResumableAttachmentUploads} for why those do not relay the
 * daemon's chunk routes.
 *
 * WHY THE GATEWAY DOES NOT IMPLEMENT THE CHUNKED TRIO
 *
 * The daemon exposes `POST /session/:id/attachment-uploads` plus its `chunks`
 * and `complete` steps, and the issue's warning is that a naive single-POST
 * port would silently skip the completion step. That warning is correct and it
 * is already handled one layer down: `DaemonClient.uploadSessionAttachment`
 * (packages/sdk-typescript/src/daemon/DaemonClient.ts:4458) sizes the payload,
 * probes the daemon once via `supportsAttachmentChunks` (:4517), and only then
 * chooses `uploadAttachmentChunks` (:4601) or the single POST. Re-implementing
 * that sequence here would put a second copy of the chunking decision in the
 * stack, and the two copies would drift apart. So the gateway hands the bytes
 * to the client and does not touch the upload endpoints at all.
 *
 * WHY THE BODY IS RAW, NOT MULTIPART
 *
 * The daemon's own contract is the raw file as the request body with its media
 * type in `Content-Type` and the name in a query parameter, which is exactly
 * what `uploadSessionAttachment` forwards. A browser posts a picked `File` the
 * same way (`fetch(url, { body: file })` sets the file's own type), so the
 * gateway can forward it without a multipart parser and without re-encoding.
 * Adding multipart would mean a second encoding of the same file in the path
 * between the phone and the daemon.
 *
 * WHY THE SIZE CAP IS ENFORCED EARLY
 *
 * `uploadSessionAttachment` throws a bare `RangeError` above its own cap,
 * which is not an HTTP status, so a route that let it through would surface as
 * a 5xx for what is really a too-large upload. The limit (configurable since
 * #196, see {@link effectiveAttachmentLimit}) is therefore applied as the raw
 * parser's `limit`, so the request is refused at the boundary with a 413 and
 * the bytes are never buffered. The boundaries agree: the client rejects
 * strictly above its cap and `limit` rejects strictly above its own too, so a
 * file of exactly the limit is accepted by both. A `RangeError` that still
 * gets through is answered as a 413 as well.
 *
 * WHY THE REFUSAL IS RELAYED
 *
 * The daemon answers an fs refusal with `{errorKind, error, hint, status}` and
 * its own numeric status (the same envelope #107 relays). Those statuses mean
 * specific things and a 413 in particular says the upload was too large, which
 * a caller acts on differently than a retry. Flattening them into 502 would
 * tell a phone to retry something that can never succeed. A 404 with no
 * envelope behind it is not an answer about an attachment; it is a daemon with
 * no attachment routes at all, so it maps to 502 `attachments_unsupported`.
 *
 * WHAT IS AUDITED
 *
 * An upload gets an audit row because it puts a new file into someone else's
 * conversation, which is a state change rather than a look. The row names the
 * session, not the file: the name is the uploader's own text, and the rule
 * carried from #107 is that paths stay out of records.
 */

/** Default for `--max-attachment-bytes`: a phone photo is 3 to 12 MB (#196). */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Ceiling for `--max-attachment-bytes`: the daemon's own per-session budget for
 * queued inline attachments (`MAX_QUEUED_INLINE_ATTACHMENT_BYTES`,
 * packages/acp-bridge/src/session-control-plane.ts), so an operator cannot ask
 * for a limit no session could ever hold.
 */
export const MAX_CONFIGURABLE_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * What a daemon that advertises no per-file cap is assumed to enforce: the
 * 8 MiB that every daemon enforced before the cap became configurable
 * (`limits.maxSessionAttachmentItemBytes` in its `/capabilities`). A current
 * daemon states its real cap, so this is only the answer for an old one.
 */
export const DAEMON_ATTACHMENT_ITEM_BYTES = 8 * 1024 * 1024;

/**
 * The per-file cap a daemon advertises in its capabilities, or `undefined`
 * when it advertises nothing usable. Read defensively: the envelope is the
 * daemon's, and an old one has no such field.
 */
export function advertisedAttachmentCap(
  capabilities: unknown,
): number | undefined {
  const limits = (capabilities as { limits?: unknown } | undefined)?.limits;
  if (!limits || typeof limits !== 'object') return undefined;
  const cap = (limits as { maxSessionAttachmentItemBytes?: unknown })
    .maxSessionAttachmentItemBytes;
  return typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0
    ? cap
    : undefined;
}

/**
 * Validates one `--max-attachment-bytes` / `QWEN_RC_MAX_ATTACHMENT_BYTES`
 * value: a plain positive integer not above
 * {@link MAX_CONFIGURABLE_ATTACHMENT_BYTES}. Unset stays `undefined` so the
 * default stands. `name` is what the error should call the setting.
 */
export function parseMaxAttachmentBytes(
  name: string,
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (
    !Number.isSafeInteger(n) ||
    n < 1 ||
    n > MAX_CONFIGURABLE_ATTACHMENT_BYTES
  ) {
    throw new Error(
      `${name}: expected a positive integer of bytes not above ${MAX_CONFIGURABLE_ATTACHMENT_BYTES}, got "${raw}"`,
    );
  }
  return n;
}

/**
 * The limit the route enforces and `/rc/capabilities` reports: the configured
 * one (default {@link DEFAULT_MAX_ATTACHMENT_BYTES}) held to the per-file cap
 * the daemon advertises, or to {@link DAEMON_ATTACHMENT_ITEM_BYTES} when it
 * advertises none (an old daemon).
 */
export function effectiveAttachmentLimit(
  configured: number | undefined,
  daemonCap?: number,
): number {
  const cap =
    typeof daemonCap === 'number' &&
    Number.isSafeInteger(daemonCap) &&
    daemonCap > 0
      ? daemonCap
      : DAEMON_ATTACHMENT_ITEM_BYTES;
  return Math.min(configured ?? DEFAULT_MAX_ATTACHMENT_BYTES, cap);
}

/** How long a read of the daemon's advertised cap is trusted. */
const ATTACHMENT_LIMIT_TTL_MS = 30_000;

/**
 * A function that answers "what is the enforced limit right now", following
 * the cap the daemon advertises. The read is cached for a short while so an
 * upload does not cost a round trip, and re-made after that so a daemon
 * restarted with a different cap is followed without restarting the gateway.
 * A failed read keeps the last cap seen; with none seen it answers the old
 * 8 MiB, the one number every daemon has enforced.
 */
export function createAttachmentLimitResolver(
  configured: number | undefined,
  readDaemonCapabilities: () => Promise<unknown>,
  opts: { ttlMs?: number; now?: () => number } = {},
): () => Promise<number> {
  const ttlMs = opts.ttlMs ?? ATTACHMENT_LIMIT_TTL_MS;
  const now = opts.now ?? Date.now;
  let known: { cap: number | undefined; at: number } | undefined;
  let inflight: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    inflight ??= Promise.resolve()
      .then(readDaemonCapabilities)
      .then(
        (caps) => {
          known = { cap: advertisedAttachmentCap(caps), at: now() };
        },
        () => {
          // Keep what was known; try again on the next request.
        },
      )
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
  return async () => {
    if (!known || now() - known.at >= ttlMs) await refresh();
    return effectiveAttachmentLimit(configured, known?.cap);
  };
}

interface FsErrorBody {
  errorKind?: unknown;
  error?: unknown;
  hint?: unknown;
}

function readFsError(err: unknown): {
  status?: number;
  kind?: string;
  message?: string;
  hint?: string;
} {
  const status = (err as { status?: unknown }).status;
  const body = (err as { body?: unknown }).body as FsErrorBody | undefined;
  return {
    status: typeof status === 'number' ? status : undefined,
    kind: typeof body?.errorKind === 'string' ? body.errorKind : undefined,
    message: typeof body?.error === 'string' ? body.error : undefined,
    hint: typeof body?.hint === 'string' ? body.hint : undefined,
  };
}

/**
 * Shared refusal mapping for both routes. Exported so a second #109 slice
 * (reads, deletes) answers with this same shape instead of inventing one.
 */
export function sendAttachmentError(res: Response, err: unknown): void {
  if (res.headersSent) return;
  // The SDK's own size guard throws a bare RangeError, not an HTTP status;
  // it means "too large", so it is answered as such.
  if (err instanceof RangeError) {
    res.status(413).json({
      error: err.message,
      code: 'attachment_too_large',
    });
    return;
  }
  if (relayDaemonAuthFailure(res, err, 'attachments')) return;
  const { status, kind, message, hint } = readFsError(err);
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // A 404 with no fs envelope is not "that attachment is not here" - it is a
    // daemon that predates the attachment routes entirely.
    if (status === 404 && kind === undefined) {
      res.status(502).json({
        error: 'Daemon does not support the session attachment routes',
        code: 'attachments_unsupported',
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
 * Wraps the JSON body parser so it stands aside for an attachment upload.
 *
 * The upload carries the file itself as the request body with the file's own
 * media type in Content-Type (the daemon's contract, which
 * `uploadSessionAttachment` forwards unchanged). A file named data.json is
 * therefore indistinguishable by header alone from an API call, and a JSON
 * parser that claimed that body would drain the stream, leaving this family's
 * raw parser nothing to read and the upload arriving silently empty.
 *
 * This has to be a wrapper rather than a middleware mounted ahead of the
 * parser: nothing a preceding handler does to the request can stop a later one
 * from reading it, so the only place the decision can live is the thing that
 * decides whether to invoke the parser at all. Matching is on the path rather
 * than the media type precisely because the media type is the file's, not a
 * signal about the route.
 */
export function gateJsonBody(json: RequestHandler): RequestHandler {
  return (req, res, next) =>
    (req.method === 'POST' && req.path.endsWith('/attachments')) ||
    // #130: one chunk of a resumable upload is a slice of the file, whatever
    // media type the file has.
    (req.method === 'PUT' && /\/attachment-uploads\/[^/]+\/chunks\/[^/]+$/.test(req.path))
      ? next()
      : json(req, res, next);
}

/**
 * Parser failures (over the limit, aborted body) would otherwise fall to
 * Express's default HTML error page, so they are answered in the envelope the
 * rest of this file uses.
 */
function attachmentBodyGuard(
  fallbackBytes: number | undefined,
): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if ((err as { type?: unknown }).type === 'entity.too.large') {
      const maxBytes =
        (res.locals as { attachmentLimit?: number }).attachmentLimit ??
        fallbackBytes;
      res.status(413).json({
        error: `Attachments must not exceed ${maxBytes} bytes`,
        code: 'attachment_too_large',
      });
      return;
    }
    res.status(400).json({
      error: 'Could not read the upload body',
      code: 'invalid_body',
    });
  };
}

/**
 * Reads the uploaded file, refusing anything strictly above `maxBytes` with a
 * 413 before it is buffered. Mounted per-route rather than globally: this is
 * the only family that takes a body that is not a request the gateway itself
 * invented. The same number feeds the parser's `limit` and the 413 text, and
 * `/rc/capabilities` reports it, so the page can size an image to fit.
 */
export function createRawAttachmentBody(
  maxBytes: number | (() => Promise<number>) = effectiveAttachmentLimit(
    undefined,
  ),
): Array<RequestHandler | ErrorRequestHandler> {
  const resolve =
    typeof maxBytes === 'number' ? async () => maxBytes : maxBytes;
  const parsers = new Map<number, RequestHandler>();
  const raw: RequestHandler = (req, res, next) => {
    resolve().then(
      (limit) => {
        (res.locals as { attachmentLimit?: number }).attachmentLimit = limit;
        let parser = parsers.get(limit);
        if (!parser) {
          parser = express.raw({ type: () => true, limit });
          parsers.set(limit, parser);
        }
        parser(req, res, next);
      },
      (err: unknown) => next(err),
    );
  };
  return [
    raw,
    attachmentBodyGuard(typeof maxBytes === 'number' ? maxBytes : undefined),
  ];
}

/**
 * POST /session/:id/attachments?name=<file name> - one file, sent as the raw
 * body with its own media type. The daemon's reference (its id, and whatever
 * metadata it chooses to return) travels untouched.
 */
export function createAttachmentUploadRoute(
  daemon: Pick<SessionDaemon, 'uploadSessionAttachment'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const name = req.query['name'];
    if (typeof name !== 'string' || name.length === 0) {
      res.status(400).json({
        error: '`name` must be a non-empty string',
        code: 'invalid_query',
      });
      return;
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({
        error: 'Upload body must not be empty',
        code: 'empty_body',
      });
      return;
    }
    // The daemon takes the media type from Content-Type; a caller that sent no
    // type gets the byte-stream default rather than a guess at its intent.
    const mimeType = req.get('content-type') ?? 'application/octet-stream';

    let reference: unknown;
    try {
      reference = await daemon.uploadSessionAttachment(
        sessionId,
        new Blob([new Uint8Array(body)], { type: mimeType }),
        name,
        mimeType,
      );
    } catch (err) {
      sendAttachmentError(res, err);
      return;
    }

    void audit?.record({
      action: 'attachment_uploaded',
      actorTokenId: req.rcClient?.id,
      target: sessionId,
    });

    res.status(201).json({ attachment: reference });
  };
}

/**
 * GET /session/:id/attachments - the session's current attachments so a phone
 * can confirm an upload landed and see what is already there. The array is the
 * daemon's; each entry keeps whatever fields it put on it.
 */
export function createAttachmentListRoute(
  daemon: Pick<SessionDaemon, 'listSessionAttachments'>,
): RequestHandler {
  return async (req, res) => {
    try {
      const attachments = await daemon.listSessionAttachments(req.params.id);
      res.status(200).json({ attachments });
    } catch (err) {
      sendAttachmentError(res, err);
    }
  };
}

/**
 * GET /session/:id/attachments/:attachmentId - one stored file back out.
 *
 * The SDK fetches the bytes and hands them over base64 in `{ data, mimeType }`
 * (DaemonClient.ts:4838), so the pair is relayed as it arrived rather than
 * decoded and re-served as a body. Re-encoding here would put a second
 * transform between the phone and the daemon, and `mimeType` is the daemon's
 * own answer about what it stored, which a gateway-chosen Content-Type would
 * overwrite.
 *
 * WRITE-scoped, not SESSION_READ like the list above. The list reveals names
 * and metadata, which the transcript already implies; this reveals the file's
 * contents, and the rule carried from #107 is that host file contents sit at
 * WRITE. No audit row, matching those sibling reads: a read's only identifying
 * field is a path or an id, and paths stay out of records, so a row could name
 * neither the file nor what it contained.
 */
export function createAttachmentReadRoute(
  daemon: Pick<SessionDaemon, 'readSessionAttachment'>,
): RequestHandler {
  return async (req, res) => {
    try {
      res
        .status(200)
        .json(
          await daemon.readSessionAttachment(
            req.params.id,
            req.params.attachmentId,
          ),
        );
    } catch (err) {
      sendAttachmentError(res, err);
    }
  };
}

/**
 * DELETE /session/:id/attachments/:attachmentId - remove one stored file.
 *
 * The boolean is the daemon saying whether the id matched something, so
 * `removed: false` stays a 200: it answered, it did not refuse, and turning a
 * double-tap into an error would report a fault where there was none.
 *
 * Audited because it destroys a file someone else may be relying on, naming
 * the session rather than the file for the same reason an upload does. Carries
 * the upload's guard set including the rate limiter: unlike a stop request,
 * which is never throttled because it is the emergency action, removing a file
 * is never urgent, so a cap on it cannot hurt the person it applies to.
 */
export function createAttachmentRemoveRoute(
  daemon: Pick<SessionDaemon, 'removeSessionAttachment'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    let result: unknown;
    try {
      result = await daemon.removeSessionAttachment(
        sessionId,
        req.params.attachmentId,
      );
    } catch (err) {
      sendAttachmentError(res, err);
      return;
    }
    void audit?.record({
      action: 'attachment_removed',
      actorTokenId: req.rcClient?.id,
      target: sessionId,
    });
    res.status(200).json({ removed: result === true });
  };
}

/** Bytes per chunk of a resumable upload: the unit a dropped connection costs. */
export const ATTACHMENT_UPLOAD_CHUNK_BYTES = 512 * 1024;

/** An upload nobody has touched for this long is forgotten (a phone in a tunnel). */
const UPLOAD_IDLE_MS = 15 * 60 * 1000;
/** How long the answer to a finished upload stays readable, for a lost reply. */
const UPLOAD_RECEIPT_MS = 5 * 60 * 1000;
const MAX_STAGED_UPLOADS = 16;
const MAX_STAGED_UPLOAD_BYTES = 96 * 1024 * 1024;

interface StagedUpload {
  id: string;
  sessionId: string;
  actor: string;
  name: string;
  mimeType: string;
  size: number;
  chunkCount: number;
  chunks: Map<number, Buffer>;
  state: 'receiving' | 'completing' | 'completed';
  completion?: Promise<unknown>;
  reference?: unknown;
  expiresAt: number;
}

export interface ResumableAttachmentUploads {
  /** POST /session/:id/attachment-uploads - begin; JSON `{name, mimeType, size}`. */
  begin: RequestHandler;
  /** The raw parser for one chunk; mount it ahead of {@link chunk}. */
  chunkBody: Array<RequestHandler | ErrorRequestHandler>;
  /** PUT /session/:id/attachment-uploads/:uploadId/chunks/:index */
  chunk: RequestHandler;
  /** GET /session/:id/attachment-uploads/:uploadId - which chunks landed. */
  status: RequestHandler;
  /** POST /session/:id/attachment-uploads/:uploadId/complete */
  complete: RequestHandler;
  /** DELETE /session/:id/attachment-uploads/:uploadId */
  cancel: RequestHandler;
}

/**
 * The resumable upload family (#130): begin, `PUT chunks/:index`, status,
 * complete and cancel.
 *
 * WHY THE GATEWAY STAGES THE CHUNKS ITSELF
 *
 * The daemon has chunk routes, but the SDK exposes them only inside
 * `uploadSessionAttachment`, which runs begin, every chunk and complete as one
 * call. The daemon's own routes are also strictly sequential by byte offset
 * (it replays only the chunk it just took), have no status read, and bind an
 * upload to a five minute life from the moment it opens. None of that helps a
 * phone, and the weak link is the phone's connection to this gateway, not the
 * gateway's loopback hop to the daemon. So the gateway keeps what the phone
 * sent, by index, and hands the assembled file to the same one-call SDK upload
 * the single POST uses. The daemon-side chunking decision stays in one place.
 *
 * WHAT RESUME FINDS
 *
 * `status` lists the indices that have landed. A chunk may arrive in any
 * order and any number of times; the same index twice is one chunk. Staged
 * bytes live in this process only, so a gateway restart ends the upload (a
 * 404 on the next call), which the page answers by starting again.
 *
 * BOUNDS
 *
 * The declared size is held to the same limit as the single POST (#196) when
 * the upload begins, every chunk must be exactly one chunk long (the last one
 * the remainder), and the gateway stages at most {@link MAX_STAGED_UPLOADS}
 * uploads and {@link MAX_STAGED_UPLOAD_BYTES} declared bytes at once. An
 * upload belongs to the session and token that began it; anyone else gets the
 * 404 an unknown id gets.
 */
export function createResumableAttachmentUploads(deps: {
  daemon: Pick<SessionDaemon, 'uploadSessionAttachment'>;
  /** The enforced size limit right now (see {@link createAttachmentLimitResolver}). */
  limit: () => Promise<number> | number;
  audit?: AuditRecorder;
  now?: () => number;
  idleMs?: number;
  maxUploads?: number;
  maxStagedBytes?: number;
}): ResumableAttachmentUploads {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? UPLOAD_IDLE_MS;
  const maxUploads = deps.maxUploads ?? MAX_STAGED_UPLOADS;
  const maxStagedBytes = deps.maxStagedBytes ?? MAX_STAGED_UPLOAD_BYTES;
  const uploads = new Map<string, StagedUpload>();

  const actorOf = (req: Parameters<RequestHandler>[0]): string =>
    req.rcClient?.id ?? '';

  const sweep = (): void => {
    const t = now();
    for (const [id, up] of uploads) {
      if (up.state !== 'completing' && up.expiresAt <= t) uploads.delete(id);
    }
  };

  /** The caller's own upload for this session, kept alive by the touch. */
  const find = (
    req: Parameters<RequestHandler>[0],
    touch = true,
  ): StagedUpload | undefined => {
    sweep();
    const up = uploads.get(req.params.uploadId ?? '');
    if (!up || up.sessionId !== req.params.id || up.actor !== actorOf(req)) {
      return undefined;
    }
    if (touch && up.state === 'receiving') up.expiresAt = now() + idleMs;
    return up;
  };

  const notFound = (res: Response): void => {
    res.status(404).json({
      error: 'Attachment upload is unavailable',
      code: 'attachment_upload_not_found',
    });
  };

  const landedOf = (up: StagedUpload): number[] =>
    [...up.chunks.keys()].sort((a, b) => a - b);

  const missingOf = (up: StagedUpload): number[] => {
    const missing: number[] = [];
    for (let i = 0; i < up.chunkCount; i++) if (!up.chunks.has(i)) missing.push(i);
    return missing;
  };

  const begin: RequestHandler = async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { name, mimeType, size } = body;
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      (mimeType !== undefined &&
        (typeof mimeType !== 'string' || mimeType.length === 0))
    ) {
      res.status(400).json({
        error: '`name`, a positive whole `size` and a `mimeType` are required',
        code: 'invalid_upload',
      });
      return;
    }
    const limit = await deps.limit();
    if (size > limit) {
      res.status(413).json({
        error: `Attachments must not exceed ${limit} bytes`,
        code: 'attachment_too_large',
      });
      return;
    }
    sweep();
    let staged = 0;
    for (const up of uploads.values()) {
      if (up.state !== 'completed') staged += up.size;
    }
    const active = [...uploads.values()].filter(
      (u) => u.state !== 'completed',
    ).length;
    if (active >= maxUploads || staged + size > maxStagedBytes) {
      res.status(429).json({
        error: 'Too many uploads are in progress; try again shortly',
        code: 'attachment_upload_capacity_exceeded',
      });
      return;
    }
    const up: StagedUpload = {
      id: randomUUID(),
      sessionId: req.params.id,
      actor: actorOf(req),
      name,
      mimeType: (mimeType as string | undefined) ?? 'application/octet-stream',
      size,
      chunkCount: Math.ceil(size / ATTACHMENT_UPLOAD_CHUNK_BYTES),
      chunks: new Map(),
      state: 'receiving',
      expiresAt: now() + idleMs,
    };
    uploads.set(up.id, up);
    res.status(201).json({
      uploadId: up.id,
      chunkSize: ATTACHMENT_UPLOAD_CHUNK_BYTES,
      chunkCount: up.chunkCount,
      size,
    });
  };

  const chunk: RequestHandler = (req, res) => {
    const up = find(req);
    if (!up) return notFound(res);
    if (up.state !== 'receiving') {
      res.status(409).json({
        error: 'This upload no longer takes chunks',
        code: 'attachment_upload_finalizing',
      });
      return;
    }
    const raw = req.params.index ?? '';
    const index = /^[0-9]{1,9}$/.test(raw) ? Number(raw) : -1;
    const expected =
      index < 0 || index >= up.chunkCount
        ? -1
        : index === up.chunkCount - 1
          ? up.size - index * ATTACHMENT_UPLOAD_CHUNK_BYTES
          : ATTACHMENT_UPLOAD_CHUNK_BYTES;
    if (expected < 0 || !Buffer.isBuffer(req.body) || req.body.length !== expected) {
      res.status(400).json({
        error:
          expected < 0
            ? `Chunk index must be a whole number below ${up.chunkCount}`
            : `Chunk ${index} must be exactly ${expected} bytes`,
        code: 'invalid_chunk',
      });
      return;
    }
    // The same index again replaces itself: a retry whose first try landed.
    up.chunks.set(index, req.body);
    res.status(200).json({
      uploadId: up.id,
      index,
      landed: up.chunks.size,
      chunkCount: up.chunkCount,
    });
  };

  const status: RequestHandler = (req, res) => {
    const up = find(req);
    if (!up) return notFound(res);
    res.status(200).json({
      uploadId: up.id,
      state: up.state,
      size: up.size,
      chunkSize: ATTACHMENT_UPLOAD_CHUNK_BYTES,
      chunkCount: up.chunkCount,
      landed: landedOf(up),
      ...(up.state === 'completed' ? { attachment: up.reference } : {}),
    });
  };

  const complete: RequestHandler = async (req, res) => {
    const up = find(req);
    if (!up) return notFound(res);
    let leader = false;
    if (!up.completion) {
      const missing = missingOf(up);
      if (missing.length > 0) {
        res.status(409).json({
          error: `${missing.length} chunk(s) have not landed`,
          code: 'attachment_upload_incomplete',
          missing,
        });
        return;
      }
      leader = true;
      up.state = 'completing';
      const bytes = Buffer.concat(
        Array.from({ length: up.chunkCount }, (_, i) => up.chunks.get(i)!),
        up.size,
      );
      const completion = deps.daemon.uploadSessionAttachment(
        up.sessionId,
        new Blob([new Uint8Array(bytes)], { type: up.mimeType }),
        up.name,
        up.mimeType,
      );
      up.completion = completion;
      completion.then(
        (reference) => {
          up.state = 'completed';
          up.reference = reference;
          up.chunks.clear();
          up.expiresAt = now() + UPLOAD_RECEIPT_MS;
        },
        () => {
          // The staged chunks stay: complete can be asked again.
          up.state = 'receiving';
          up.completion = undefined;
          up.expiresAt = now() + idleMs;
        },
      );
    }
    let reference: unknown;
    try {
      reference = await up.completion;
    } catch (err) {
      sendAttachmentError(res, err);
      return;
    }
    if (leader) {
      void deps.audit?.record({
        action: 'attachment_uploaded',
        actorTokenId: req.rcClient?.id,
        target: up.sessionId,
      });
    }
    res.status(201).json({ attachment: reference });
  };

  const cancel: RequestHandler = (req, res) => {
    const up = find(req, false);
    // Cancelling what is gone is a done thing, not a fault: a retried delete
    // after a lost reply must not read as an error.
    if (!up || up.state === 'completing') {
      res.status(200).json({ cancelled: false });
      return;
    }
    uploads.delete(up.id);
    res.status(200).json({ cancelled: up.state === 'receiving' });
  };

  return {
    begin,
    chunkBody: createRawAttachmentBody(ATTACHMENT_UPLOAD_CHUNK_BYTES),
    chunk,
    status,
    complete,
    cancel,
  };
}
