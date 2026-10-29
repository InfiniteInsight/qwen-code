/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Express error backstop (#155). Two pieces:
 *
 * - {@link installAsyncErrorCapture}: Express 4 ignores the promise an async
 *   handler returns, so a rejection never reaches `next(err)` and Node 22 exits
 *   the process on it. This makes Express 4's layer dispatch forward a rejected
 *   promise to `next(err)`, the way Express 5 does natively. It patches the
 *   layer prototype that every router shares, so it covers handlers registered
 *   on the app AND inside `Router()` instances built by the route modules.
 * - {@link jsonErrorBackstop}: the final 4-arg middleware that answers whatever
 *   reaches it as JSON without a stack: a body-parser syntax error is a 400
 *   `invalid_json`, any other client error keeps its 4xx status, and the rest
 *   is a 500 `internal`.
 *
 * Every explicit error mapping inside the routes still runs first; this only
 * catches what they did not.
 */

import { STATUS_CODES } from 'node:http';
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { describeRejection } from '../processGuard.js';

type Handler = (...args: unknown[]) => unknown;

/** The Express 4 Layer surface the patch replaces. */
interface Express4LayerProto {
  handle: Handler;
  handle_request(req: Request, res: Response, next: NextFunction): void;
  handle_error(
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void;
}

const PATCHED = Symbol.for('qwen-rc.asyncErrorCapture');

function forwardRejection(ret: unknown, next: NextFunction): void {
  if (
    ret !== null &&
    (typeof ret === 'object' || typeof ret === 'function') &&
    typeof (ret as PromiseLike<unknown>).then === 'function'
  ) {
    (ret as PromiseLike<unknown>).then(undefined, (err: unknown) => {
      // next(undefined) would mean "carry on"; a falsy reason is still a failure.
      next(err || new Error('Route handler rejected with a falsy reason'));
    });
  }
}

/**
 * Make Express 4 forward a handler's rejected promise to `next(err)`. Idempotent
 * and process-wide (the layer prototype is shared by every Express 4 app in the
 * process); a no-op on an Express whose layers do not have the Express 4 shape.
 */
export function installAsyncErrorCapture(): void {
  // Reach the Layer prototype through a live instance rather than importing
  // express/lib/router/layer.js, so it is guaranteed to be the copy that this
  // module's `express` uses.
  const probe = express.Router();
  probe.use((_req, _res, next) => next());
  const layer = (probe as unknown as { stack: unknown[] }).stack[0];
  const proto = Object.getPrototypeOf(layer) as Express4LayerProto & {
    [PATCHED]?: true;
  };
  if (proto[PATCHED]) return;
  if (
    typeof proto.handle_request !== 'function' ||
    typeof proto.handle_error !== 'function'
  ) {
    return;
  }

  // Same contract as Express 4.22 lib/router/layer.js, plus the return-value
  // check: arity gates which layers handle requests vs errors, and a
  // synchronous throw still goes to next(err).
  proto.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) {
      next();
      return;
    }
    try {
      forwardRejection(fn(req, res, next), next);
    } catch (err) {
      next(err);
    }
  };
  proto.handle_error = function handle_error(error, req, res, next) {
    const fn = this.handle;
    if (fn.length !== 4) {
      next(error);
      return;
    }
    try {
      forwardRejection(fn(error, req, res, next), next);
    } catch (err) {
      next(err);
    }
  };
  Object.defineProperty(proto, PATCHED, { value: true });
}

function errorField(err: unknown, key: string): unknown {
  return typeof err === 'object' && err !== null
    ? (err as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The 4xx to answer with, kept only for errors Express's own stack raised: an
 * http-errors error (body-parser, serve-static; recognisable by its boolean
 * `expose`) or Express's param-decode URIError. Anything else with a 4xx
 * `status` (a DaemonHttpError a route forgot to map, a web-push error) is a 500:
 * relaying a daemon's 401 as the caller's own would read as the caller's
 * credentials failing. Only the status is used; the message never goes out.
 */
function clientErrorStatus(err: unknown): number | undefined {
  const s = errorField(err, 'status') ?? errorField(err, 'statusCode');
  if (typeof s !== 'number' || !Number.isInteger(s) || s < 400 || s >= 500) {
    return undefined;
  }
  return typeof errorField(err, 'expose') === 'boolean' ||
    err instanceof URIError
    ? s
    : undefined;
}

/** `Payload Too Large` becomes `payload_too_large`. */
function codeForStatus(status: number): string {
  return (STATUS_CODES[status] ?? 'bad_request')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export interface ErrorBackstopOptions {
  /**
   * Stamp the actual-request CORS headers. An error raised by anything mounted
   * ahead of the CORS middleware would otherwise go out without them, so the
   * backstop applies them itself; setting the same headers twice is harmless.
   */
  applyCors?: (req: Request, res: Response) => void;
  /** Where 500s are logged (default console.error). */
  log?: (msg: string) => void;
}

/** The final error middleware: JSON, no stack, client statuses preserved. */
export function jsonErrorBackstop(
  opts: ErrorBackstopOptions = {},
): ErrorRequestHandler {
  // eslint-disable-next-line no-console
  const log = opts.log ?? ((m: string) => console.error(m));
  return (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      // A response (or SSE stream) already under way cannot carry a JSON error;
      // Express's default handler closes the connection so the client sees a
      // failed response rather than a silently truncated one.
      next(err);
      return;
    }
    try {
      opts.applyCors?.(req, res);
    } catch {
      // CORS stamping is best effort here; the error answer still goes out.
    }
    if (errorField(err, 'type') === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', code: 'invalid_json' });
      return;
    }
    const status = clientErrorStatus(err);
    if (status !== undefined) {
      const code = codeForStatus(status);
      res.status(status).json({ error: code, code });
      return;
    }
    // The path without its query string: a query can carry a share or ingest
    // token, the path only ids.
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    try {
      log(
        `gateway: unhandled route error on ${req.method} ${path}: ${describeRejection(err)}`,
      );
    } catch {
      // A broken log sink must not stop the 500 from going out.
    }
    res.status(500).json({ error: 'internal', code: 'internal' });
  };
}
