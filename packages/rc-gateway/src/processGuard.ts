/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-level backstop for promise rejections nobody handled (#155).
 *
 * Node 22 exits on an unhandled rejection by default, so before this guard
 * every `await` outside a `try` (a route handler, a bridge dispatch, a
 * fire-and-forget `void` call) was a process kill for the whole gateway. The
 * listener logs the reason in one line (name, message, first stack frame) and
 * lets the process keep serving. The local fixes (the Express backstop, the
 * mDNS error listener, the bridge catches) remain the real handling; this only
 * stops the next missed site from taking the gateway down.
 *
 * There is deliberately NO `uncaughtException` counterpart: a synchronous throw
 * that escaped to the top can leave state half-mutated, and exiting is the
 * honest response to that.
 *
 * This file has no imports and uses only erasable TypeScript syntax, so a test
 * can load it with Node's built-in type stripping in a child process.
 */

/** The slice of `process` the guard needs (a stand-in in tests). */
export interface RejectionEmitter {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

const MAX_MESSAGE_CHARS = 500;

const installed = new WeakMap<RejectionEmitter, (reason: unknown) => void>();

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[object]';
  }
}

/**
 * One-line description of a rejection reason: `Name: message (at <frame>)` for
 * an error, the stringified value otherwise. Never the full stack, never throws.
 */
export function describeRejection(reason: unknown): string {
  if (typeof reason === 'object' && reason !== null && 'message' in reason) {
    const r = reason as { name?: unknown; message?: unknown; stack?: unknown };
    const name = typeof r.name === 'string' && r.name ? r.name : 'Error';
    const message = safeString(r.message).slice(0, MAX_MESSAGE_CHARS);
    const frame =
      typeof r.stack === 'string'
        ? r.stack
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.startsWith('at '))
        : undefined;
    return frame ? `${name}: ${message} (${frame})` : `${name}: ${message}`;
  }
  return safeString(reason).slice(0, MAX_MESSAGE_CHARS);
}

/**
 * Install the guard on `target` (the real `process` by default). Idempotent
 * per target, so a second boot in the same process does not double-log.
 * Returns the listener that is registered.
 */
export function installUnhandledRejectionGuard(
  label: string,
  target: RejectionEmitter = process,
  // eslint-disable-next-line no-console
  log: (msg: string) => void = (m) => console.error(m),
): (reason: unknown) => void {
  const existing = installed.get(target);
  if (existing) return existing;
  const listener = (reason: unknown): void => {
    try {
      log(
        `${label}: unhandled promise rejection (process kept running): ${describeRejection(reason)}`,
      );
    } catch {
      // A broken log sink must not turn the backstop into the crash.
    }
  };
  target.on('unhandledRejection', listener);
  installed.set(target, listener);
  return listener;
}
