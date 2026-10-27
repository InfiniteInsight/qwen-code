/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isSessionLevelNotFound,
  isSubagentSessionNotFound,
} from '@qwen-code/sdk/daemon';
import { asDaemonHttpError, daemonErrorBody } from '../daemonHttpError.js';

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

/**
 * Classify a subagent failure against the reference THIS request sent.
 *
 * The read is structural on purpose. `DaemonClient` is built through the SDK
 * package root (`daemonPool.ts:43`) while this module's imports come from the
 * `/daemon` subpath, and the two entries each bundle their own `DaemonHttpError`
 * class. A real production error therefore fails `instanceof DaemonHttpError`
 * here and in the SDK's own guards, which run that same test internally
 * (`sdk-typescript/src/daemon/DaemonHttpError.ts:46`, `:70`); an earlier revision
 * of this file relied on both and silently answered every gone child as
 * `daemon_unavailable`. See `daemonHttpError.ts`.
 *
 * The daemon names the child under the route parameter's own name, `subagentRef`
 * (`packages/cli/src/serve/routes/session.ts:5484` for the read and `:5538` for
 * the cancel), not the `toolCallId` the SDK guards were written against, so the
 * structural read is also the only one that can match a real response at all.
 */
export function classifySubagentFailure(
  err: unknown,
  subagentRef: string,
): SubagentFailure {
  const http = asDaemonHttpError(err);
  if (http !== undefined && http.status === 404) {
    const body = daemonErrorBody(err);
    if (body?.['code'] === 'session_not_found') {
      const named = body['subagentRef'];
      if (typeof named === 'string') {
        // A 404 naming a DIFFERENT child is not this row's 404: answering it as
        // one would let one agent's absence settle another's fate.
        return named === subagentRef
          ? 'subagent_not_found'
          : 'daemon_unavailable';
      }
      if (typeof body['toolCallId'] !== 'string') {
        // Nothing in the body names a child at all, so it is the PARENT that is
        // missing, which is reversible.
        return 'session_unreachable';
      }
      // Named under the SDK's own `toolCallId` key rather than the daemon's, so
      // it is left to the guards written against that key below.
    }
  }
  // Kept for shapes these guards were written against. Neither can match an
  // error thrown through the other SDK entry, for the identity reason above.
  if (isSubagentSessionNotFound(err, subagentRef)) return 'subagent_not_found';
  if (isSessionLevelNotFound(err)) return 'session_unreachable';
  return 'daemon_unavailable';
}
