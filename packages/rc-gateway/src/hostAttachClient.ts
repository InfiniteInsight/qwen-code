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
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { join, resolve } from 'node:path';
import { readState } from './launcher/state.js';
import { readLocalToken } from './localCredential.js';

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
  spawn?: (
    command: string,
    args: string[],
    options: SpawnSyncOptions,
  ) => SpawnSyncReturns<Buffer | string>;
  request?: typeof postHostAttach;
  shieldSignals?: () => () => void;
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
  const spawn = deps.spawn ?? nodeSpawnSync;
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
  const [command, ...rest] = attachment.linuxArgv;
  const restore = (deps.shieldSignals ?? shieldParentSignals)();
  let result: SpawnSyncReturns<Buffer | string>;
  try {
    result = spawn(command, rest, {
      stdio: 'inherit',
      cwd: attachment.workspaceCwd,
    });
  } finally {
    restore();
  }
  if (result.error) {
    stderr(`qwen-rc attach: could not run ${command}: ${result.error.message}`);
    return 1;
  }
  if (typeof result.status === 'number') return result.status;
  if (result.signal) {
    const n = osConstants.signals[result.signal];
    return typeof n === 'number' ? 128 + n : 1;
  }
  return 1;
}
