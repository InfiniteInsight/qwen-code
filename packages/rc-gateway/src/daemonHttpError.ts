/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { hasScope, WRITE } from './scopes.js';

/**
 * Read a daemon HTTP failure without asking which copy of the class threw it.
 *
 * `DaemonHttpError` exists more than once in the installed SDK: the package
 * root entry and the `/daemon` subpath each bundle their own copy, and they are
 * not the same object. The gateway builds its clients through the root entry
 * (`daemonPool.ts:43`), while a route may import the class from the subpath, so
 * `err instanceof DaemonHttpError` answers false for a perfectly ordinary
 * production error and the caller falls through to its fallback silently. The
 * SDK's own guards used to carry that same defect and were changed to read
 * `name` plus a numeric `status` (`asDaemonFailure` in
 * `sdk-typescript/src/daemon/DaemonHttpError.ts`); this module predates that
 * fix and is the reason it was found.
 *
 * `name` and `status` are assigned on the instance by the constructor
 * (`sdk-typescript/src/daemon/DaemonHttpError.ts:19-24`), so they survive both
 * bundling and the duplicate class. `status` is required alongside the name so
 * an unrelated `Error` that happens to carry the name cannot be mistaken for a
 * daemon response.
 */
export interface DaemonHttpErrorLike {
  readonly status: number;
  readonly body: unknown;
}

export function asDaemonHttpError(
  err: unknown,
): DaemonHttpErrorLike | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const shaped = err as { name?: unknown; status?: unknown; body?: unknown };
  if (shaped.name !== 'DaemonHttpError') return undefined;
  if (typeof shaped.status !== 'number') return undefined;
  return { status: shaped.status, body: shaped.body };
}

/** The daemon's error body as an object, or undefined if it is not one. */
export function daemonErrorBody(
  err: unknown,
): Record<string, unknown> | undefined {
  const http = asDaemonHttpError(err);
  if (http === undefined) return undefined;
  const body: unknown = http.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

/**
 * The session-level 404: the daemon could not find the parent session itself,
 * so the body carries `code: 'session_not_found'` with no identifying
 * `toolCallId` (an explicit `null` counts as absent).
 *
 * This is the contract the SDK's `isSessionLevelNotFound` tests, read without
 * that guard. The guard opens with `error instanceof DaemonHttpError` against
 * its own bundle's copy of the class, so it answers false for an error thrown
 * through the package root, which is the only way the gateway can receive one.
 *
 * A missing parent session is not the only producer. A multi-workspace daemon
 * answers this same shape while the owning entry is merely not active, which
 * the daemon treats as reversible, so read this as "this session is not
 * resumable right now", not as proof the transcript is permanently gone.
 */
export function isSessionLevelGone(err: unknown): boolean {
  const http = asDaemonHttpError(err);
  if (http === undefined || http.status !== 404) return false;
  const body = daemonErrorBody(err);
  if (body?.['code'] !== 'session_not_found') return false;
  const toolCallId = body['toolCallId'];
  return toolCallId === undefined || toolCallId === null;
}

/**
 * Issue #211: failure details for the person holding the phone.
 *
 * The owner's rule is that a failure names what failed and what the answer
 * was, so a relay that turns a daemon refusal into a fixed gateway sentence
 * ("Daemon unavailable", "The daemon refused this request") hides the one thing
 * the owner needs. A relay therefore passes the daemon's own status, code and
 * message through to a caller who holds write or owner, and keeps the fixed
 * sentence for anyone else.
 *
 * WHO SEES THE DAEMON'S WORDS: {@link canSeeDaemonDetail}. A share guest never
 * does, whatever scopes the share carries (a share holds `session:read` and
 * `approve`, and may hold `write` on an older token), and a request with no
 * resolved client is treated as a reader, so a route mounted without auth in a
 * test or a future refactor fails closed.
 *
 * WHAT A READER GETS INSTEAD: today, the relay's fixed sentence and the code,
 * which is the strictest reduction (nothing the daemon said). The routes that
 * use this are mounted at write scope, so no reader reaches them; the branch is
 * the guard for the day one does. Text a reader can reach on the page is cut
 * down by `reduceFailureTextForReader` in `public/index.html`, which is the one
 * place host paths, client ids, ids of things in the conversation and internal
 * error strings are taken out of a failure line.
 */
export interface DaemonFailureDetail {
  /** The daemon's HTTP status, when the failure was an HTTP answer. */
  status?: number;
  /** The daemon's error code (top level, or inside the validation envelope). */
  code?: string;
  /** The daemon's message, or the transport error's, bounded. */
  message?: string;
  /** The thrown error's name when it was not an HTTP answer (a dead socket). */
  errorName?: string;
}

const MAX_DETAIL_MESSAGE = 500;

function boundedString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t.slice(0, MAX_DETAIL_MESSAGE);
}

/** What a failed daemon call said, read without trusting its shape. */
export function daemonFailureDetail(err: unknown): DaemonFailureDetail {
  const http = asDaemonHttpError(err);
  const body = daemonErrorBody(err);
  if (http === undefined) {
    if (typeof err === 'object' && err !== null) {
      const shaped = err as { name?: unknown; message?: unknown };
      return {
        errorName: boundedString(shaped.name),
        message: boundedString(shaped.message),
      };
    }
    return { message: boundedString(err) };
  }
  const nested = body?.['error'];
  const nestedObj =
    typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : undefined;
  return {
    status: http.status,
    code: boundedString(body?.['code']) ?? boundedString(nestedObj?.['code']),
    message:
      boundedString(nested) ??
      boundedString(nestedObj?.['message']) ??
      boundedString(body?.['message']) ??
      (typeof http.body === 'string' ? boundedString(http.body) : undefined),
  };
}

/** True when the caller holds write or owner and is not a share guest. */
export function canSeeDaemonDetail(req: {
  rcClient?: { scopes?: readonly string[]; shareId?: string };
}): boolean {
  const client = req.rcClient;
  if (client === undefined || client.shareId !== undefined) return false;
  return hasScope(client.scopes ?? [], WRITE);
}

/**
 * The 502 body the relays send when a daemon call failed in a way they have no
 * better sentence for. The fixed `error` and `code` are what every caller has
 * always had; a caller who {@link canSeeDaemonDetail} also gets `daemon`, the
 * status, code and message the daemon (or the socket) gave, which is what the
 * page prints after "the daemon answered". Additive: an older page ignores it.
 */
export function daemonUnavailableBody(
  req: { rcClient?: { scopes?: readonly string[]; shareId?: string } },
  err: unknown,
): { error: string; code: string; daemon?: DaemonFailureDetail } {
  const base = { error: 'Daemon unavailable', code: 'daemon_unavailable' };
  if (!canSeeDaemonDetail(req)) return base;
  const detail = daemonFailureDetail(err);
  return Object.keys(detail).length === 0 ? base : { ...base, daemon: detail };
}
