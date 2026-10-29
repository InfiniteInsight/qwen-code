/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import type { RunCommand } from './exec.js';
import { ensureUp, nodeIdentity } from './tailscale.js';
import { ensureCert } from './cert.js';
import { startUnit, stopUnit, isActive } from './process.js';
import {
  readState,
  writeState,
  clearState,
  type LauncherState,
} from './state.js';
import { renderQr } from './qr.js';
import {
  BOOTSTRAP_CODE_FILENAME,
  OWNER_BOOTSTRAP_TTL_MS,
} from '../bootstrap.js';

export interface Deps {
  run: RunCommand;
  dir: string; // ~/.qwen/rc
  port: number;
  /** `--port` was given on the command line (vs the 8443 default). */
  portExplicit?: boolean;
  unit: string; // e.g. qwen-rc-gateway
  serveCmd: string[]; // PATH-independent argv prefix for qwen-rc, e.g. [process.argv[0], process.argv[1]]
  // The gateway unit writes owner-bootstrap.code from inside the unit
  // process, hundreds of ms after `systemd-run` merely accepts the job —
  // `up` polls for it. These are injectable purely so tests don't incur
  // real multi-second waits; production uses the defaults below.
  bootstrapTimeoutMs?: number;
  bootstrapPollMs?: number;
}

/** Production polling defaults — see `Deps.bootstrapTimeoutMs`/`bootstrapPollMs`. */
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 15_000;
const DEFAULT_BOOTSTRAP_POLL_MS = 200;

export interface UpResult {
  ok: boolean;
  url?: string;
  host?: string;
  port?: number;
  unit?: string;
  bootstrapCode?: string;
  certExpiry?: string;
  qr?: string;
  hint?: string;
  /** The gateway unit was already active, so `up` started nothing. */
  alreadyRunning?: boolean;
}

function connectUrl(host: string, port: number): string {
  return `https://${host}:${port}/ui/`;
}

function readBootstrapCode(dir: string): string | undefined {
  const p = join(dir, BOOTSTRAP_CODE_FILENAME);
  if (!existsSync(p)) return undefined;
  const c = readFileSync(p, 'utf8').trim();
  return c.length > 0 ? c : undefined;
}

/**
 * Read the code file only while it can still be redeemed. The gateway removes
 * the file when the code is redeemed or lapses; the mtime check backstops a
 * file left by a gateway that died before it could (a crash or reboot). A dead
 * file is removed so nothing downstream can mistake it for a fresh code.
 */
function readLiveBootstrapCode(dir: string): string | undefined {
  const p = join(dir, BOOTSTRAP_CODE_FILENAME);
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
  if (ageMs > OWNER_BOOTSTRAP_TTL_MS) {
    rmSync(p, { force: true });
    return undefined;
  }
  return readBootstrapCode(dir);
}

/**
 * Poll for `<dir>/owner-bootstrap.code` until it exists (with non-empty
 * content) or `timeoutMs` elapses. The gateway unit writes this file from
 * its own process well after `systemd-run` returns, so a same-tick read
 * (the previous behavior) races the gateway's boot and, on a first-ever
 * `up`, reliably loses.
 *
 * The check always runs BEFORE the delay, so a file that is already present
 * (the common case in tests, and on a warm restart if `down` didn't run)
 * returns immediately with no real sleep incurred.
 *
 * Deliberately keyed on `readBootstrapCode`'s non-empty check, not
 * `existsSync`: the gateway creates-then-writes the file, so a bare
 * existence check can observe a truncated/zero-length file mid-write. That
 * would return an incomplete code instead of continuing to poll — so this
 * treats a present-but-empty file the same as absent and keeps polling.
 */
async function waitForBootstrapCode(
  dir: string,
  timeoutMs: number,
  pollMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = readBootstrapCode(dir);
    if (code) return code;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Best-effort read of a cert's `notAfter` as an ISO string. `undefined` on any failure. */
function readCertExpiry(certPath: string): string | undefined {
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    return new Date(cert.validTo).toISOString();
  } catch {
    return undefined;
  }
}

export async function up(deps: Deps): Promise<UpResult> {
  const { run, dir, unit, serveCmd } = deps;

  // 1. Tailnet.
  const upOutcome = await ensureUp(run);
  if (upOutcome.kind !== 'running') {
    const hint =
      upOutcome.kind === 'needs-auth'
        ? `Authenticate this device, then re-run \`qwen-rc up\`:\n  ${upOutcome.authUrl}`
        : upOutcome.kind === 'not-installed'
          ? 'Tailscale is not installed in WSL. Install it, then re-run.'
          : upOutcome.kind === 'needs-operator'
            ? 'Run `tailscale set --operator=$USER` once so up can manage Tailscale without sudo.'
            : `tailscale up failed: ${upOutcome.message}`;
    return { ok: false, hint };
  }

  const id = await nodeIdentity(run);
  if (!id)
    return {
      ok: false,
      hint: 'Could not read the Tailscale node identity (status --json).',
    };

  // 2. TLS cert.
  const cert = await ensureCert(run, id.host, join(dir, 'tls'));
  if (cert.kind !== 'ok') {
    const hint =
      cert.kind === 'https-not-enabled'
        ? 'Enable HTTPS/MagicDNS for your tailnet in the Tailscale admin console, then re-run.'
        : `tailscale cert failed: ${cert.message}`;
    return { ok: false, hint };
  }

  // 3. Is the gateway unit already running? A unit started by an earlier `up`
  // keeps listening on the port it was started with, whatever this run asked
  // for, so connect info and state must describe that port, not the request.
  const alreadyRunning = await isActive(run, unit);
  const recorded = alreadyRunning ? readState(dir) : null;
  const port =
    recorded !== null && Number.isInteger(recorded.port)
      ? recorded.port
      : deps.port;
  const portNote =
    alreadyRunning && deps.portExplicit && port !== deps.port
      ? `The gateway is already listening on port ${port}; --port ${deps.port} was ignored. Run \`qwen-rc down\` first to change the port.`
      : undefined;

  const url = connectUrl(id.host, port);
  const certExpiry = readCertExpiry(cert.pair.certPath);

  // Start the gateway unit unless already active (idempotent).
  if (!alreadyRunning) {
    // Any code file here belongs to a previous boot (the gateway only removes
    // it on redeem/expiry, and a crash or reboot skips both). Clear it first so
    // the poll below can only ever return the code the unit started here mints.
    rmSync(join(dir, BOOTSTRAP_CODE_FILENAME), { force: true });
    const serveArgv = [
      ...serveCmd, // PATH-independent (systemd --user has systemd's env, not the shell's)
      'serve',
      '--host',
      id.ip,
      '--tls',
      cert.pair.certPath,
      '--tls-key',
      cert.pair.keyPath,
      '--port',
      String(port),
    ];
    const started = await startUnit(run, unit, serveArgv);
    if (started.code !== 0) {
      const err = started.stderr || started.stdout;
      // The Electron path (`wsl.exe -- qwen-rc up`) may have no user-session
      // D-Bus, so systemd --user fails; give the specific remedy, not a raw error.
      const busDown =
        /failed to connect to bus|XDG_RUNTIME_DIR|no medium found/i.test(err);
      const hint = busDown
        ? 'systemd --user is unavailable in this shell (no session D-Bus). Set `XDG_RUNTIME_DIR=/run/user/$(id -u)` and run `loginctl enable-linger $USER` once — this is the usual cause when launched via wsl.exe.'
        : `Failed to start the gateway unit: ${err.trim().slice(0, 500)}`;
      return { ok: false, hint };
    }
  }

  const state: LauncherState = {
    unit,
    url,
    host: id.host,
    port,
    certExpiry,
  };
  writeState(dir, state);

  // 4. Connect info. A unit we just started writes owner-bootstrap.code from
  // inside its own process, so poll for it rather than reading synchronously,
  // which would race the gateway's boot. A unit that was already active is past
  // its boot: its code is either still pending (file present) or already
  // redeemed/expired (file gone), so read once and never wait.
  const bootstrapCode = alreadyRunning
    ? readLiveBootstrapCode(dir)
    : await waitForBootstrapCode(
        dir,
        deps.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
        deps.bootstrapPollMs ?? DEFAULT_BOOTSTRAP_POLL_MS,
      );
  // Embed the pairing code in the URL fragment so a scanned QR auto-fills and
  // pairs (the /ui/ page reads `#code=`, then scrubs it). Human terminal output
  // only — `upJson()` omits `qr`, so the code never reaches the `--json` stream;
  // it rides the fragment, which never hits server logs/Referer.
  const qrTarget =
    bootstrapCode === undefined
      ? url
      : `${url}#code=${encodeURIComponent(bootstrapCode)}`;
  const qr = await renderQr(qrTarget).catch(() => undefined);
  const codeHint =
    bootstrapCode !== undefined
      ? undefined
      : alreadyRunning
        ? 'The gateway is already running and has no pairing code pending (a code is single-use and expires after 30 minutes). Run `qwen-rc down` then `qwen-rc up` for a fresh one, or re-run in a moment if it was only just started.'
        : 'The pairing code was not ready yet; the gateway may still be starting. Run `qwen-rc status`, then retry `qwen-rc up` to fetch it.';
  const hint =
    [codeHint, portNote].filter((h) => h !== undefined).join(' ') || undefined;
  return {
    ok: true,
    url,
    host: id.host,
    port,
    unit,
    bootstrapCode,
    certExpiry,
    qr,
    hint,
    ...(alreadyRunning ? { alreadyRunning: true } : {}),
  };
}

/**
 * Shape the `--json` payload for `qwen-rc up`. Deliberately OMITS
 * `bootstrapCode`: `--json` targets a machine-captured stream (e.g. the
 * Electron/wsl.exe launcher path), and the bootstrap code is a one-time OWNER
 * credential that must not be echoed onto a surface that may be logged or
 * relayed. The human-readable path (cli.ts, non-`--json`) still prints it to
 * the terminal.
 */
export function upJson(r: UpResult): Record<string, unknown> {
  return {
    status: r.ok ? 'running' : 'error',
    url: r.url,
    host: r.host,
    port: r.port,
    unit: r.unit,
    certExpiry: r.certExpiry,
    hint: r.hint,
  };
}

/**
 * The terminal text for a successful `qwen-rc up`. With no code to show it says
 * why, using the result's hint: the gateway's logs never carry the code, so
 * pointing the operator there (as this used to) sent them nowhere.
 */
export function formatUpHuman(r: UpResult): string {
  const head = `\nConnect from your phone:\n  ${r.url}\n\n`;
  const tail = `\n\n${r.qr ?? ''}`;
  if (r.bootstrapCode === undefined) {
    return `${head}No pairing code: ${r.hint ?? 'none is pending.'}${tail}`;
  }
  return `${head}Pairing code: ${r.bootstrapCode}${r.hint ? `\n${r.hint}` : ''}${tail}`;
}

export async function down(
  deps: Deps,
): Promise<{ ok: boolean; hint?: string }> {
  const { run, dir, unit } = deps;
  const st = readState(dir);
  const target = st?.unit ?? unit;
  const stopped = await stopUnit(run, target);
  // `systemctl stop` on a unit that is not loaded exits nonzero, and a stopped
  // unit is the goal, so only a failure that leaves the unit active is an
  // error. Reporting "stopped" while the gateway is still serving, and having
  // already dropped its state, would leave the operator with no handle on it.
  if (stopped.code !== 0 && (await isActive(run, target))) {
    const err = (stopped.stderr || stopped.stdout).trim().slice(0, 500);
    return {
      ok: false,
      hint: `Could not stop ${target}; it is still running${err ? `: ${err}` : '.'}`,
    };
  }
  clearState(dir);
  // Each gateway boot mints a fresh owner-bootstrap code. Leaving the old
  // file behind would let a subsequent `up` read a STALE code that doesn't
  // match the next boot's — pairing would then fail. Removing it here means
  // a following `up` only ever sees a code minted by the gateway it started.
  rmSync(join(dir, BOOTSTRAP_CODE_FILENAME), { force: true });
  return { ok: true };
}

export async function status(
  deps: Deps,
): Promise<{ running: boolean; url?: string; certExpiry?: string }> {
  const { run, dir, unit } = deps;
  const st = readState(dir);
  const running = await isActive(run, st?.unit ?? unit);
  return { running, url: st?.url, certExpiry: st?.certExpiry };
}
