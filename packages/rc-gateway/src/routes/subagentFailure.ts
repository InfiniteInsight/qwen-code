/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DaemonHttpError,
  isSessionLevelNotFound,
  isSubagentSessionNotFound,
} from '@qwen-code/sdk/daemon';

/**
 * How a failed subagent call must be answered, and why the three answers are
 * not interchangeable:
 *
 * - `subagent_not_found` — the child this request named is gone. The row was
 *   already settled when it was pressed, which is the common case, so the UI
 *   can act on it (grey the button, drop the row).
 * - `session_unreachable` — the PARENT could not be reached. A multi-workspace
 *   daemon answers the same 404 while the owning runtime is merely not active,
 *   which is reversible, so the UI should retry rather than delete the row.
 * - `daemon_unavailable` — anything else. Genuinely the gateway's problem.
 *
 * Telling an operator to wait for something that will never come back, or to
 * delete a row that would have answered on a retry, are the two failures this
 * split exists to prevent.
 */
export type SubagentFailure =
  | 'subagent_not_found'
  | 'session_unreachable'
  | 'daemon_unavailable';

function httpErrorBody(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof DaemonHttpError)) return undefined;
  const body: unknown = err.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

/**
 * Classify a subagent failure against the reference THIS request sent.
 *
 * The SDK's `isSubagentSessionNotFound` reads `body.toolCallId`, but the daemon
 * names the child under the route parameter's own name, `subagentRef`
 * (`packages/cli/src/serve/routes/session.ts:5484` for the read and `:5538`
 * for the cancel), and no error body anywhere in `packages/cli/src/serve/`
 * carries a `toolCallId` key. Classifying on that guard alone therefore never
 * matches a real response: the child-gone 404 has no `toolCallId`, so it fails
 * the subagent guard and then satisfies `isSessionLevelNotFound`, arriving at
 * 503. Read the key the daemon actually writes first, and keep the SDK guards
 * as the fallback for whatever shape they were written against.
 */
export function classifySubagentFailure(
  err: unknown,
  subagentRef: string,
): SubagentFailure {
  if (err instanceof DaemonHttpError && err.status === 404) {
    const body = httpErrorBody(err);
    if (body?.['code'] === 'session_not_found') {
      const named = body['subagentRef'];
      // A 404 naming a DIFFERENT child is not this row's 404: answering it as
      // one would let one agent's absence settle another's fate.
      if (typeof named === 'string') {
        return named === subagentRef
          ? 'subagent_not_found'
          : 'daemon_unavailable';
      }
    }
  }
  if (isSubagentSessionNotFound(err, subagentRef)) return 'subagent_not_found';
  if (isSessionLevelNotFound(err)) return 'session_unreachable';
  return 'daemon_unavailable';
}
