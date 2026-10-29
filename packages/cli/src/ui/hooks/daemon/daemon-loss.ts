/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-loss detection for an attached TUI (InfiniteInsight/Qwen-Code-Remote
 * #194 slice E). `qwen-rc attach` runs the TUI in a loop and treats exit code
 * 75 (EX_TEMPFAIL) as "the daemon is gone, find me a new one"; this module
 * decides, from an error or a stream frame, when the TUI should say that.
 *
 * Everything here is pure (the sleep and the health probe are injected) so the
 * rules are testable exhaustively without a daemon.
 */

/** The exit code `qwen-rc attach` reads as "my daemon is gone". */
export const DAEMON_GONE_EXIT_CODE = 75;

/** The one line shown before exiting, so the user understands the flicker. */
export const DAEMON_GONE_MESSAGE = 'daemon gone, the wrapper will re-attach';

/**
 * - `daemon_gone`: the daemon process or the session is not there (a transport
 *   failure, a 404 for the session, or a `session_died` frame). Transport
 *   failures are only suspected until {@link confirmDaemonGone} agrees.
 * - `retry`: not a loss; the caller's existing handling stays (today: back off
 *   on "already active"; a non-fatal frame needs no action).
 * - `fatal`: not a loss and not recoverable here (bad token, an HTTP failure,
 *   anything unrecognised): surface the message as before.
 */
export type DaemonFailureVerdict = 'daemon_gone' | 'retry' | 'fatal';

export type DaemonFailureInput =
  | { kind: 'error'; error: unknown }
  | { kind: 'frame'; frame: { type?: string } };

/** Socket-level codes that mean nothing is listening or the peer vanished. */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/**
 * What undici/node put in `message` when there is no usable `code`. `terminated`
 * is what undici throws when the response body stream is cut mid-flight.
 */
const TRANSPORT_MESSAGE =
  /fetch failed|socket hang up|other side closed|ECONNREFUSED|ECONNRESET|^terminated$/i;

const MAX_CAUSE_DEPTH = 8;

/** The error and its `cause` chain, bounded and cycle-safe. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = error;
  while (
    cur !== undefined &&
    cur !== null &&
    typeof cur === 'object' &&
    !seen.has(cur) &&
    chain.length < MAX_CAUSE_DEPTH
  ) {
    seen.add(cur);
    chain.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * The HTTP status of a daemon answer. Read by shape, not `instanceof`: the SDK
 * is bundled once per entry point, so the class a client throws is not always
 * the one this package could import.
 */
function httpStatusOf(error: unknown): number | undefined {
  for (const e of causeChain(error)) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isInteger(status)) return status;
  }
  return undefined;
}

/** True when the failure is the connection, not an answer from the daemon. */
export function isTransportError(error: unknown): boolean {
  if (httpStatusOf(error) !== undefined) return false;
  return causeChain(error).some((e) => {
    const o = e as { code?: unknown; message?: unknown; name?: unknown };
    if (o.name === 'AbortError') return false;
    if (typeof o.code === 'string' && TRANSPORT_CODES.has(o.code)) return true;
    return typeof o.message === 'string' && TRANSPORT_MESSAGE.test(o.message);
  });
}

const ALREADY_ACTIVE = /already active|subscription active/i;

export function classifyDaemonFailure(
  input: DaemonFailureInput,
): DaemonFailureVerdict {
  if (input.kind === 'frame') {
    return input.frame?.type === 'session_died' ? 'daemon_gone' : 'retry';
  }
  const { error } = input;
  const status = httpStatusOf(error);
  if (status !== undefined) {
    // 401/403 is a bad token, which a new daemon would not fix. 404 is the
    // daemon answering "I do not have this session": a different daemon (or
    // none) holds it now. Any other answer keeps today's behaviour.
    return status === 404 ? 'daemon_gone' : 'fatal';
  }
  if (isTransportError(error)) return 'daemon_gone';
  const message = String((error as { message?: unknown })?.message ?? error);
  if (ALREADY_ACTIVE.test(message)) return 'retry';
  return 'fatal';
}

export const DEFAULT_RECHECK_DELAY_MS = 1000;
export const DEFAULT_PROBE_TIMEOUT_MS = 3000;

export interface ConfirmDaemonGoneDeps {
  /** One cheap request to the daemon (`GET /health`); rejects when it fails. */
  probe(): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  delayMs?: number;
  probeTimeoutMs?: number;
}

/**
 * After a suspected loss: wait briefly, then ask the daemon once. `true` only
 * when the daemon does not answer. Any HTTP answer, even a 401, proves the
 * process is there, so it is not gone.
 */
export async function confirmDaemonGone(
  deps: ConfirmDaemonGoneDeps,
): Promise<boolean> {
  await deps.sleep(deps.delayMs ?? DEFAULT_RECHECK_DELAY_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      deps.probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('health probe timed out')),
          deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return false;
  } catch (e) {
    return httpStatusOf(e) === undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
