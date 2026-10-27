/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thrown for any non-2xx daemon response. `status` and `body` are surfaced
 * so callers can branch on the standard daemon HTTP semantics (404 missing
 * session, 401 bad token, 400 malformed body, 500 agent failure).
 *
 * Extracted to its own module so that transports (e.g. `RestSseTransport`)
 * can import it without pulling in the entire `DaemonClient` module,
 * keeping the browser bundle under budget.
 */
export class DaemonHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'DaemonHttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Read a daemon HTTP failure without asking which copy of the class threw it.
 *
 * This class is bundled once per entry point: `scripts/build.js` runs one
 * independent esbuild bundle for `.` and another for `./daemon`, so the copy
 * a client throws is not the copy a caller imported. `instanceof` across that
 * line answers false for a perfectly ordinary production 404, which is why
 * these guards used to answer `false` for every real error reaching a caller
 * that imported the other entry. The two entries cannot share a chunk instead:
 * `.` is built for node and `./daemon` for the browser, gated by
 * `assertNoNodeBuiltins`, so unifying them would force one platform and break
 * that assertion.
 *
 * `name` and `status` are assigned on the instance by the constructor above,
 * so they survive bundling and the duplicate class alike; `status` is required
 * alongside the name so an unrelated `Error` that happens to carry the name
 * cannot be read as a daemon answer. A genuine `DaemonHttpError` always
 * satisfies this test, so there is no `instanceof` path left to keep.
 */
function asDaemonFailure(
  error: unknown,
): { readonly status: number; readonly body: unknown } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const shaped = error as {
    name?: unknown;
    status?: unknown;
    body?: unknown;
  };
  if (shaped.name !== 'DaemonHttpError') return undefined;
  if (typeof shaped.status !== 'number') return undefined;
  return { status: shaped.status, body: shaped.body };
}

// Kept local (instead of reusing `isRecord` from `acpTransportUtils.ts` or
// `ui/utils.ts`) so this leaf module stays dependency-free: those modules
// pull the ACP route table / UI helpers into the budgeted browser bundles.
function getErrorBodyRecord(
  body: unknown,
): Record<string, unknown> | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

/**
 * The keys a 404 can name the missing child under, in the order the daemon
 * writes them.
 *
 * `subagentRef` is the one the daemon actually sends: the route names the child
 * after its own path parameter
 * (`packages/cli/src/serve/routes/session.ts:5481` for the read and `:5538`
 * for the cancel), and `toolCallId` appears nowhere in that file. `toolCallId`
 * is the spelling these guards were originally written against and is still
 * accepted, because a caller that was given that shape must keep getting the
 * same answer.
 */
const CHILD_REFERENCE_KEYS = ['subagentRef', 'toolCallId'] as const;

/**
 * The child a `session_not_found` body names, or undefined when it names none,
 * which is what distinguishes a gone child from a gone parent. An explicitly
 * `null` reference counts as naming none.
 */
function childReference(body: Record<string, unknown>): string | undefined {
  for (const key of CHILD_REFERENCE_KEYS) {
    const value = body[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Type guard for the daemon's `GET /session/:id/subagents/:subagentRef` 404
 * contract: `{ code: 'session_not_found', sessionId, subagentRef? }`. Pass the
 * reference THIS request sent to require the body to identify that specific
 * missing agent; a 404 naming a different child is not this caller's answer,
 * and a session-level 404 names none. Omit it to accept both shapes.
 */
export function isSubagentSessionNotFound(
  error: unknown,
  subagentRef?: string,
): boolean {
  const failure = asDaemonFailure(error);
  if (failure === undefined || failure.status !== 404) return false;
  const body = getErrorBodyRecord(failure.body);
  if (body?.['code'] !== 'session_not_found') return false;
  if (subagentRef === undefined) return true;
  return childReference(body) === subagentRef;
}

/**
 * Type guard for the session-level variant of that same 404 contract: the
 * daemon could not find the parent session itself, so the body carries
 * `code: 'session_not_found'` and names no child under either spelling.
 *
 * A missing parent session is not the only producer: a multi-workspace
 * daemon answers this same shape while the owning workspace entry is
 * merely not active (for example draining before removal, or transitioning
 * to a replacement runtime), which the daemon treats as reversible. Treat
 * this error as recoverable, not as proof the session is permanently gone.
 */
export function isSessionLevelNotFound(error: unknown): boolean {
  const failure = asDaemonFailure(error);
  if (failure === undefined || failure.status !== 404) return false;
  const body = getErrorBodyRecord(failure.body);
  if (body?.['code'] !== 'session_not_found') return false;
  return childReference(body) === undefined;
}
