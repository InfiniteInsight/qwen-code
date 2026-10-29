/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen-rc attach [cwd] [--session <id>]` (InfiniteInsight/Qwen-Code-Remote#194
 * slice D): start a conversation in a terminal on this machine, as a daemon
 * session the phone can pick up, and run the attached TUI on it.
 *
 * The CLI owns no qwen flags. It asks the gateway's loopback-only
 * `POST /rc/host/attach` route (routes/hostAttach.ts) for a session and gets
 * back the exact argv the host terminal launcher would run, then runs it in the
 * daemon's workspace with the terminal handed straight through.
 *
 * Finding the gateway: the gateway listens on the tailnet address with the
 * same TLS cert also bound to 127.0.0.1 (`--loopback-bind`), so this connects
 * to `https://127.0.0.1:<port>`, port from `~/.qwen/rc/launcher-state.json`
 * (8443 when absent), pinning the cert under `~/.qwen/rc/tls/` as the only
 * trust anchor and verifying it against the host it was issued for.
 */

import { X509Certificate } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { join, resolve } from 'node:path';
import { readState } from './launcher/state.js';
import { readLocalToken } from './localCredential.js';
import { runWithReattach, type ReattachAttempt } from './reattachLoop.js';
import {
  spawnTui,
  startTerminalGuard,
  TERMINAL_GONE_EXIT,
  type TerminalGuard,
} from './terminalGuard.js';

/** Basename of the host-attach token, beside the other `~/.qwen/rc` secrets. */
export const HOST_ATTACH_TOKEN_FILENAME = 'host-attach-token';

/** Where the gateway keeps the host-attach token under its rc dir. */
export function hostAttachTokenPath(rcDir: string): string {
  return join(rcDir, HOST_ATTACH_TOKEN_FILENAME);
}

/** The port `qwen-rc up` binds when launcher state names none. */
export const DEFAULT_GATEWAY_PORT = 8443;

/** The loopback address the gateway's `--loopback-bind` adds. */
export const GATEWAY_LOOPBACK_HOST = '127.0.0.1';

const START_HINT =
  'start the gateway with `systemctl --user start qwen-rc-gateway`';
const RESTART_HINT =
  'restart the gateway with `systemctl --user restart qwen-rc-gateway`';

/** How to reach this host's gateway over loopback. */
export interface GatewayLoopbackTarget {
  host: string;
  port: number;
  /** PEM of the pinned cert file; the request trusts nothing else. */
  ca?: string;
  certPath?: string;
  /** The host the cert was issued for: SNI and hostname check both use it. */
  servername?: string;
}

function validPort(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 65536
    ? v
    : undefined;
}

/** First `DNS:` name in the leaf's SAN, or undefined. */
function certDnsName(pem: string): string | undefined {
  try {
    const san = new X509Certificate(pem).subjectAltName ?? '';
    for (const part of san.split(',')) {
      const t = part.trim();
      if (t.startsWith('DNS:')) return t.slice(4);
    }
  } catch {
    // Not a parseable cert: the caller falls back to the file name.
  }
  return undefined;
}

function readPem(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Resolve the gateway's loopback address and the cert to pin, from what is on
 * disk under `rcDir` (`~/.qwen/rc`). Pure apart from the reads; never throws.
 *
 * - Port: launcher state's `port` when it is a valid port, else 8443.
 * - Cert: `tls/<host>.crt` when launcher state names a host and that file
 *   exists (`qwen-rc up` names certs that way), its servername that host.
 *   Otherwise the newest `tls/*.crt`, its servername the first DNS name in
 *   its SAN (the file name without `.crt` if it has none).
 * - No cert: no pin, and the servername is launcher state's host if any, so
 *   the request falls back to the system trust store for that name.
 */
export function resolveGatewayLoopback(rcDir: string): GatewayLoopbackTarget {
  const state = readState(rcDir);
  const port = validPort(state?.port) ?? DEFAULT_GATEWAY_PORT;
  const stateHost =
    typeof state?.host === 'string' && state.host.length > 0
      ? state.host
      : undefined;
  const base: GatewayLoopbackTarget = { host: GATEWAY_LOOPBACK_HOST, port };

  const tlsDir = join(rcDir, 'tls');
  let names: string[] = [];
  try {
    names = readdirSync(tlsDir).filter((n) => n.endsWith('.crt'));
  } catch {
    names = [];
  }

  if (stateHost && names.includes(`${stateHost}.crt`)) {
    const certPath = join(tlsDir, `${stateHost}.crt`);
    const ca = readPem(certPath);
    if (ca !== undefined) {
      return { ...base, ca, certPath, servername: stateHost };
    }
  }

  const byNewest = names
    .map((n) => {
      const p = join(tlsDir, n);
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { n, p, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { n, p } of byNewest) {
    const ca = readPem(p);
    if (ca === undefined) continue;
    const servername = certDnsName(ca) ?? n.slice(0, -'.crt'.length);
    return { ...base, ca, certPath: p, servername };
  }

  return stateHost ? { ...base, servername: stateHost } : base;
}

export type ParsedAttachArgs =
  | { ok: true; cwd: string; sessionId?: string }
  | { ok: false; error: string };

export const ATTACH_USAGE = 'usage: qwen-rc attach [cwd] [--session <id>]';

/** Parse `attach`'s own argv. The folder resolves against `processCwd`. */
export function parseAttachArgs(
  argv: string[],
  processCwd: string,
): ParsedAttachArgs {
  let sessionId: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0 || v.startsWith('--')) {
        return { ok: false, error: '--session needs a session id' };
      }
      sessionId = v;
      i++;
    } else if (a.startsWith('--session=')) {
      const v = a.slice('--session='.length);
      if (v.length === 0) {
        return { ok: false, error: '--session needs a session id' };
      }
      sessionId = v;
    } else if (a.startsWith('-')) {
      return { ok: false, error: `unknown option ${a}` };
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) {
    return { ok: false, error: 'at most one folder' };
  }
  const cwd = resolve(processCwd, positional[0] ?? '.');
  return sessionId !== undefined
    ? { ok: true, cwd, sessionId }
    : { ok: true, cwd };
}

export interface HostAttachResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Creating a session may spawn a daemon and a resume reads a transcript. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * POST a JSON body to the gateway's loopback front with the host-attach
 * bearer. With a pinned cert, that cert file is the ONLY trust anchor (`ca`
 * replaces the system store); `allowPartialTrustChain` lets a file that holds
 * only the leaf, or a chain that stops short of a self-signed root as a
 * `tailscale cert` file does, act as one. Rejects with the transport error
 * (its `code` intact) when no HTTP answer arrives.
 */
export function postHostAttach(
  target: GatewayLoopbackTarget,
  token: string,
  path: string,
  body: unknown,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<HostAttachResponse> {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest(
      {
        host: target.host,
        port: target.port,
        path,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        ...(target.servername ? { servername: target.servername } : {}),
        ...(target.ca !== undefined
          ? { ca: target.ca, allowPartialTrustChain: true }
          : {}),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          try {
            const v: unknown = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            );
            if (v && typeof v === 'object')
              parsed = v as Record<string, unknown>;
          } catch {
            parsed = {};
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(
        Object.assign(new Error(`no answer within ${timeoutMs}ms`), {
          code: 'ETIMEDOUT',
        }),
      );
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'EPIPE',
]);

/** One line for a request that got no HTTP answer. */
function describeTransportError(
  err: unknown,
  target: GatewayLoopbackTarget,
): string {
  const where = `https://${target.host}:${target.port}`;
  const code = (err as { code?: unknown } | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) {
    return `qwen-rc attach: no gateway answering at ${where} (${code}); ${START_HINT}`;
  }
  // Anything else on a TLS connect is the pin or the name not matching what
  // the gateway serves, e.g. a cert renewed on disk while the gateway still
  // holds the old one in memory.
  const pin = target.certPath ?? 'the system trust store';
  return (
    `qwen-rc attach: the gateway at ${where} did not verify against ${pin}` +
    `${target.servername ? ` as ${target.servername}` : ''} (${typeof code === 'string' ? code : message}); ` +
    `if its cert changed on disk, ${RESTART_HINT}`
  );
}

/** One line for an HTTP answer other than 200. */
function describeRefusal(
  res: HostAttachResponse,
  args: { cwd: string; sessionId?: string },
): string {
  const code = typeof res.body.code === 'string' ? res.body.code : undefined;
  const error =
    typeof res.body.error === 'string' ? res.body.error : 'request failed';
  if (res.status === 401) {
    // An old gateway build has no route here and its bearer check answers
    // 401 too, so the same fix covers both.
    return (
      'qwen-rc attach: the gateway refused the host-attach token ' +
      `(401); if it was started before this build or before the token file ` +
      `existed, ${RESTART_HINT}`
    );
  }
  if (code === 'session_not_found' && args.sessionId) {
    return `qwen-rc attach: no conversation ${args.sessionId} in ${args.cwd} (session_not_found)`;
  }
  if (code === 'invalid_workspace') {
    return `qwen-rc attach: ${args.cwd} is not a directory the gateway can use (invalid_workspace)`;
  }
  return `qwen-rc attach: ${error} (${res.status}${code ? ` ${code}` : ''})`;
}

/**
 * Read one answer from the re-attach poll (slice E) as the loop needs it.
 * Retry only what can heal on its own: 502 and 503 (the daemon is restarting
 * or the pool is full) and a gateway that is not listening yet. Everything
 * else, a 404 (nothing to come back to), a refused token, a body that names no
 * session, a certificate that does not verify, ends the wait with its reason.
 */
export function classifyReattach(
  outcome: { res: HostAttachResponse } | { err: unknown },
  args: { cwd: string; sessionId: string },
  target: GatewayLoopbackTarget,
): ReattachAttempt {
  if ('err' in outcome) {
    const code = (outcome.err as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) {
      return { kind: 'retry', reason: `no gateway answering (${code})` };
    }
    return {
      kind: 'stop',
      message: describeTransportError(outcome.err, target),
    };
  }
  const { res } = outcome;
  if (res.status === 200) {
    const attachment = readAttachment(res.body);
    if (attachment) {
      return {
        kind: 'ready',
        linuxArgv: attachment.linuxArgv,
        workspaceCwd: attachment.workspaceCwd,
      };
    }
    return {
      kind: 'stop',
      message:
        'qwen-rc attach: the gateway answered without a session to attach to; ' +
        RESTART_HINT,
    };
  }
  if (res.status === 502 || res.status === 503) {
    const code = typeof res.body.code === 'string' ? ` ${res.body.code}` : '';
    return { kind: 'retry', reason: `gateway answered ${res.status}${code}` };
  }
  return { kind: 'stop', message: describeRefusal(res, args) };
}

/** Sleep that ends early when `signal` aborts. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Report an interrupt (Ctrl-C, or a terminate) during the re-attach wait. The
 * TUI is not running then, so nothing else would take the signal and the
 * default would be to die with the signal's status; this turns it into a clean
 * exit through the loop. Returns the undo.
 */
export function watchWaitInterrupts(onInterrupt: () => void): () => void {
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  return () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  };
}

/** The fields the CLI needs from a 200, or undefined when any is missing. */
function readAttachment(
  body: Record<string, unknown>,
):
  | { sessionId: string; workspaceCwd: string; linuxArgv: string[] }
  | undefined {
  const { sessionId, workspaceCwd, linuxArgv } = body;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  if (typeof workspaceCwd !== 'string' || workspaceCwd.length === 0) {
    return undefined;
  }
  if (
    !Array.isArray(linuxArgv) ||
    linuxArgv.length === 0 ||
    !linuxArgv.every((a) => typeof a === 'string' && a.length > 0)
  ) {
    return undefined;
  }
  return { sessionId, workspaceCwd, linuxArgv: linuxArgv as string[] };
}

/**
 * While the TUI owns the terminal, a Ctrl-C or Ctrl-\ reaches the whole
 * foreground process group. The TUI handles its own; this process must not
 * die on it and hand the shell back a terminal the TUI is still drawing on.
 * Returns the undo, called once the TUI has exited.
 */
export function shieldParentSignals(): () => void {
  const ignore = (): void => {};
  process.on('SIGINT', ignore);
  process.on('SIGQUIT', ignore);
  return () => {
    process.off('SIGINT', ignore);
    process.off('SIGQUIT', ignore);
  };
}

export interface HostAttachRunDeps {
  /** `attach`'s own argv (after the subcommand). */
  argv: string[];
  /** The directory the command was run from. */
  cwd: string;
  /** `~/.qwen/rc`. */
  rcDir: string;
  stderr?: (line: string) => void;
  /**
   * Run the TUI to completion. The default is the async, terminal-aware
   * `spawnTui`; a test may answer synchronously.
   */
  spawn?: (
    command: string,
    args: string[],
    options: SpawnSyncOptions,
  ) =>
    | SpawnSyncReturns<Buffer | string>
    | Promise<
        Pick<SpawnSyncReturns<Buffer | string>, 'status' | 'signal' | 'error'>
      >;
  /** The watcher for this process's terminal (#207); the default is the real one. */
  terminalGuard?: TerminalGuard;
  request?: typeof postHostAttach;
  shieldSignals?: () => () => void;
  /** Re-attach loop seams (slice E); the defaults are the real clock and signals. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  watchInterrupt?: (onInterrupt: () => void) => () => void;
}

/**
 * The whole command. Returns the exit code: the TUI's own when it ran, 1 for
 * anything that stopped it running (one plain line on stderr saying what and
 * how to fix it), 2 for bad arguments.
 */
export async function runHostAttach(deps: HostAttachRunDeps): Promise<number> {
  const stderr =
    deps.stderr ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  const request = deps.request ?? postHostAttach;

  const args = parseAttachArgs(deps.argv, deps.cwd);
  if (!args.ok) {
    stderr(`qwen-rc attach: ${args.error}`);
    stderr(ATTACH_USAGE);
    return 2;
  }

  const tokenPath = hostAttachTokenPath(deps.rcDir);
  const token = await readLocalToken(tokenPath);
  if (token === undefined) {
    stderr(
      `qwen-rc attach: no host-attach token at ${tokenPath} (the gateway ` +
        `writes it when it starts); ${START_HINT}`,
    );
    return 1;
  }

  const target = resolveGatewayLoopback(deps.rcDir);
  const path = args.sessionId
    ? `/rc/host/attach/${encodeURIComponent(args.sessionId)}`
    : '/rc/host/attach';

  let res: HostAttachResponse;
  try {
    res = await request(target, token, path, { cwd: args.cwd });
  } catch (err) {
    stderr(describeTransportError(err, target));
    return 1;
  }
  if (res.status !== 200) {
    stderr(describeRefusal(res, args));
    return 1;
  }
  const attachment = readAttachment(res.body);
  if (!attachment) {
    stderr(
      'qwen-rc attach: the gateway answered without a session to attach to; ' +
        RESTART_HINT,
    );
    return 1;
  }

  stderr(`attached ${attachment.sessionId} in ${attachment.workspaceCwd}`);
  // Node has no execvp, so the TUI runs as a child with this terminal handed
  // straight through, and its exit code becomes this process's. The argv
  // carries the daemon token, so it is never printed.
  //
  // When the daemon dies (the gateway restarted) the TUI exits 75; the loop
  // then asks the gateway for the session again and runs the TUI again, so a
  // tab survives the restart (slice E). Any other exit code ends this process.
  //
  // The terminal is watched from here to the end (#207, see terminalGuard.ts):
  // when its tab is closed the pty goes away but this wrapper and the TUI do
  // not, so the guard ends the TUI and the loop, including during the wait.
  const guard = deps.terminalGuard ?? startTerminalGuard();
  const spawn =
    deps.spawn ??
    ((command: string, args: string[], options: SpawnSyncOptions) =>
      spawnTui(command, args, options, guard));
  const runTui = async (linuxArgv: string[], cwd: string): Promise<number> => {
    const [command, ...rest] = linuxArgv;
    const restore = (deps.shieldSignals ?? shieldParentSignals)();
    let result: Awaited<ReturnType<typeof spawn>>;
    try {
      result = await spawn(command, rest, { stdio: 'inherit', cwd });
    } finally {
      restore();
    }
    if (result.error) {
      stderr(
        `qwen-rc attach: could not run ${command}: ${result.error.message}`,
      );
      return 1;
    }
    if (typeof result.status === 'number') return result.status;
    if (result.signal) {
      const n = osConstants.signals[result.signal];
      return typeof n === 'number' ? 128 + n : 1;
    }
    return 1;
  };
  const reattachArgs = {
    cwd: attachment.workspaceCwd,
    sessionId: attachment.sessionId,
  };
  const reattachPath = `/rc/host/attach/${encodeURIComponent(attachment.sessionId)}`;
  const watchInterrupt = deps.watchInterrupt ?? watchWaitInterrupts;
  const code = await runWithReattach(
    { linuxArgv: attachment.linuxArgv, workspaceCwd: attachment.workspaceCwd },
    {
      sessionId: attachment.sessionId,
      run: runTui,
      terminalGone: () => guard.gone(),
      attach: async () => {
        // The token is read again each time: a gateway restart does not change
        // it, but an operator who rotated the file while the tab waited should
        // not have to close the tab.
        const fresh = (await readLocalToken(tokenPath)) ?? token;
        // The target is resolved again too, so a gateway that came back on a
        // new port or with a renewed cert is found.
        const where = resolveGatewayLoopback(deps.rcDir);
        try {
          return classifyReattach(
            {
              res: await request(where, fresh, reattachPath, {
                cwd: attachment.workspaceCwd,
              }),
            },
            reattachArgs,
            where,
          );
        } catch (err) {
          return classifyReattach({ err }, reattachArgs, where);
        }
      },
      sleep: deps.sleep ?? sleepUnlessAborted,
      now: deps.now ?? Date.now,
      log: stderr,
      // A terminal that goes during the wait aborts it like Ctrl-C does.
      watchInterrupt: (onInterrupt) => {
        const undoInterrupt = watchInterrupt(onInterrupt);
        const undoGone = guard.onGone(onInterrupt);
        return () => {
          undoInterrupt();
          undoGone();
        };
      },
    },
  ).finally(() => guard.stop());
  return guard.reason() !== undefined ? TERMINAL_GONE_EXIT : code;
}
