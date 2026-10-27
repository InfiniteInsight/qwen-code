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
 * SDK's own guards (`isSubagentSessionNotFound`, `isSessionLevelNotFound`) run
 * that same identity test internally and are therefore unusable here too.
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
