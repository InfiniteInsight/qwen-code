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

/** One audit row per route per window, with a count of those suppressed. */
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
 * If `err` is a daemon 401, answer 502 `daemon_auth_failed`, audit it, and
 * return true so the caller stops. Otherwise return false and write nothing.
 * `route` names the route family for the audit row.
 */
export function relayDaemonAuthFailure(
  res: Response,
  err: unknown,
  route: string,
  now: () => number = Date.now,
): boolean {
  if ((err as { status?: unknown } | null)?.status !== 401) return false;
  if (!res.headersSent) {
    res.status(502).json({
      error: 'The gateway is not authorised to reach its daemon',
      code: DAEMON_AUTH_FAILED,
    });
  }
  const audit = auditOf(res);
  if (audit) {
    const t = now();
    const prev = lastRow.get(route);
    if (prev !== undefined && t - prev.at < AUDIT_WINDOW_MS) {
      prev.suppressed += 1;
    } else {
      lastRow.set(route, { at: t, suppressed: 0 });
      void audit.record({
        action: 'daemon_auth_failed',
        actorTokenId: (res.req as { rcClient?: { id?: string } } | undefined)
          ?.rcClient?.id,
        detail: {
          route,
          ...(prev !== undefined && prev.suppressed > 0
            ? { suppressedSincePrevious: prev.suppressed }
            : {}),
        },
      });
    }
  }
  return true;
}
