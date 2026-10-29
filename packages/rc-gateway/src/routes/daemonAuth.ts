/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import type { AuditRecorder } from '../auditLog.js';

/**
 * A daemon answering 401 means the GATEWAY's credential for the daemon is bad,
 * not the caller's: the caller already authenticated to the gateway. Relayed
 * verbatim, that 401 reaches a page that treats any same-origin 401 as "my
 * token is dead" and logs the user out over a fault they cannot fix by
 * signing in again. So the routes that relay daemon errors answer this one
 * with the gateway's own code, as a 502 (a bad upstream), and leave a trace
 * for the operator, who is the one who can fix it.
 */
export const DAEMON_AUTH_FAILED = 'daemon_auth_failed' as const;

/**
 * The daemon's request wall answers 403 before any route runs: a request
 * carrying an `Origin` header ("Request denied by CORS policy") or a `Host`
 * the daemon does not serve ("Invalid Host header"), see `denyBrowserOriginCors`
 * and the host check in the daemon's `serve/auth.ts`. Like a 401, that is the
 * gateway's own request being refused, a deployment fault the caller cannot
 * fix, and it would otherwise reach a page as a 403 about the caller.
 *
 * Not every daemon 403 is this. A trust or permission verdict (an untrusted
 * folder, a read-only agent) is about the request and is relayed on purpose by
 * the routes that handle it, so only the wall's own two bodies match, and only
 * when they carry no `errorKind` or `code`.
 */
export const DAEMON_REQUEST_DENIED = 'daemon_request_denied' as const;

const WALL_MESSAGES: ReadonlySet<string> = new Set([
  'Invalid Host header',
  'Request denied by CORS policy',
]);

/** True iff `err` is a daemon 403 from its request wall (see above). */
export function isDaemonRequestDenied(err: unknown): boolean {
  const e = err as { status?: unknown; body?: unknown } | null;
  if (e?.status !== 403) return false;
  const body = e.body as
    | { error?: unknown; errorKind?: unknown; code?: unknown }
    | null
    | undefined;
  if (body === null || typeof body !== 'object') return false;
  return (
    typeof body.error === 'string' &&
    WALL_MESSAGES.has(body.error) &&
    body.errorKind === undefined &&
    body.code === undefined
  );
}

/** One audit row per route and status per window, with a count suppressed. */
const AUDIT_WINDOW_MS = 60_000;
const lastRow = new Map<string, { at: number; suppressed: number }>();

/** Test seam: forget what has been rate-limited. */
export function resetDaemonAuthAuditThrottle(): void {
  lastRow.clear();
}

function auditOf(res: Response): AuditRecorder | undefined {
  const audit = (res.app?.locals as { audit?: unknown } | undefined)?.audit;
  return audit && typeof (audit as AuditRecorder).record === 'function'
    ? (audit as AuditRecorder)
    : undefined;
}

/**
 * If `err` is a daemon 401, answer 502 `daemon_auth_failed`; if it is a daemon
 * request-wall 403, answer 502 `daemon_request_denied`. Either way audit it
 * (throttled), and return true so the caller stops. Otherwise return false and
 * write nothing. `route` names the route family for the audit row.
 */
export function relayDaemonAuthFailure(
  res: Response,
  err: unknown,
  route: string,
  now: () => number = Date.now,
): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  const denied = isDaemonRequestDenied(err);
  if (status !== 401 && !denied) return false;
  if (!res.headersSent) {
    res.status(502).json(
      denied
        ? {
            error: 'The daemon refused the gateway request',
            code: DAEMON_REQUEST_DENIED,
          }
        : {
            error: 'The gateway is not authorised to reach its daemon',
            code: DAEMON_AUTH_FAILED,
          },
    );
  }
  const audit = auditOf(res);
  if (audit) {
    const t = now();
    const key = `${route}:${denied ? 403 : 401}`;
    const prev = lastRow.get(key);
    if (prev !== undefined && t - prev.at < AUDIT_WINDOW_MS) {
      prev.suppressed += 1;
    } else {
      lastRow.set(key, { at: t, suppressed: 0 });
      void audit.record({
        action: 'daemon_auth_failed',
        actorTokenId: (res.req as { rcClient?: { id?: string } } | undefined)
          ?.rcClient?.id,
        detail: {
          route,
          ...(denied ? { status: 403 } : {}),
          ...(prev !== undefined && prev.suppressed > 0
            ? { suppressedSincePrevious: prev.suppressed }
            : {}),
        },
      });
    }
  }
  return true;
}
