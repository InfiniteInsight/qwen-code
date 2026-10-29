/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import express from 'express';
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
    req.method === 'POST' && req.path.endsWith('/attachments')
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
