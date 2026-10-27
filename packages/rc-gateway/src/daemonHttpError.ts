/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
