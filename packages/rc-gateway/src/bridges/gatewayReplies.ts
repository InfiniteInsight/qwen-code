/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WriteResult } from './client.js';
import { isSubActorBan } from './banCache.js';

/**
 * What a chat user is told when the gateway does not take their prompt or
 * vote (#168). Shared by the Telegram, Discord and Matrix dispatchers so the
 * three say the same thing for the same gateway answer.
 *
 * Before, a prompt answered 502 (`daemon_unavailable`), 503 (`queue_timeout`,
 * the 120s wait for a busy session) or 504 (`prompt_timeout`) left the chat
 * with no reply at all, and Telegram acknowledged every vote that was not a 403
 * as "Approved", including 404 (no longer pending), 429 and 5xx.
 */

/** The gateway's `code` from a failed write's JSON body, when it sent one. */
function codeOf(r: WriteResult): string | undefined {
  const code = (r.body as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** `503 queue_timeout` or `503`: the answer the user can quote back. */
function statusText(r: WriteResult): string {
  const code = codeOf(r);
  return code ? `${r.status} ${code}` : String(r.status);
}

/**
 * The chat notice for a prompt the gateway did not take, or undefined when the
 * chat should stay quiet: on success (the reply streams back over SSE), on a
 * ban (dropped silently, per the bridge specs) and on a 429 (each dispatcher
 * posts its own slow-down notice with the retry window). A 403 that is not a
 * ban (`scope_required`, `session_locked`) is reported like any refusal.
 */
export function promptFailureNotice(r: WriteResult): string | undefined {
  if (r.ok || isSubActorBan(r) || r.status === 429) return undefined;
  const tag = `(${statusText(r)})`;
  switch (codeOf(r)) {
    case 'queue_timeout':
      return `Prompt not run: the session was still busy with an earlier prompt ${tag}. Send it again when the current turn ends.`;
    case 'prompt_timeout':
      return `The turn timed out on the gateway and was cancelled ${tag}.`;
    case 'daemon_unavailable':
      return `Prompt failed: the qwen daemon is unavailable ${tag}. Try again shortly.`;
    case 'session_not_loaded':
      return `Prompt not run: the session is not open on the gateway ${tag}. Open it in the web client, then send again.`;
    default:
      return `Prompt not run: the gateway answered ${statusText(r)}.`;
  }
}

/** What a reactor is told when the request they voted on is no longer open. */
export const REQUEST_NO_LONGER_PENDING =
  'Vote failed: this request is no longer pending.';

/**
 * The reply for a vote the gateway did not take, or undefined when it was
 * counted. A ban is left to the caller (it caches it and says "blocked").
 */
export function voteFailureNotice(r: WriteResult): string | undefined {
  if (r.ok || isSubActorBan(r)) return undefined;
  if (r.status === 404 || r.status === 409) return REQUEST_NO_LONGER_PENDING;
  if (r.status === 429)
    return `Vote failed: slow down, try again in ${r.retryAfterSec ?? 'a few'} seconds.`;
  return `Vote failed: the gateway answered ${statusText(r)}. Try again from the web client.`;
}
