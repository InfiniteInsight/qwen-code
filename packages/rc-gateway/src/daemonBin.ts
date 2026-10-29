/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which `qwen` the gateway's daemons run (`--qwen-bin`, env
 * `QWEN_RC_QWEN_BIN`), and whether it is the same build the host terminals
 * run (`QWEN_RC_TERMINAL_QWEN`). The supervisor used to spawn `qwen` from PATH
 * with nothing to say which one that was, so a daemon built weeks before the
 * terminals could run silently. Everything here is pure or touches only the
 * local filesystem and the one `--version` child; nothing talks to a network.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

const DEFAULT_BIN = 'qwen';

/** A daemon binary setting that cannot work, reported as one plain line. */
export class DaemonBinError extends Error {}

/** Why `path` cannot be run, or undefined when it can. */
function notRunnableReason(path: string): string | undefined {
  let st;
  try {
    st = statSync(path);
  } catch {
    return 'does not exist';
  }
  if (!st.isFile()) return 'is not a file';
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return 'is not executable';
  }
  return undefined;
}

/**
 * Validate one `--qwen-bin` / `QWEN_RC_QWEN_BIN` value at parse time. A value
 * with a `/` is a path: it is made absolute (the daemons are spawned from other
 * working directories) and must exist and be executable, else this throws a
 * line that names `source`. A bare name is returned unchanged, to be resolved
 * on PATH at boot.
 */
export function validateQwenBinPath(
  raw: string,
  source: string,
  cwd: string = process.cwd(),
): string {
  if (raw.trim() === '' || raw.startsWith('-')) {
    throw new DaemonBinError(
      `${source}: needs a path to the qwen executable, got "${raw}"`,
    );
  }
  if (!raw.includes('/')) return raw;
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const why = notRunnableReason(abs);
  if (why) {
    throw new DaemonBinError(`${source}: "${abs}" ${why}`);
  }
  return abs;
}

/** First executable file called `name` on `pathEnv`, or undefined. */
export function resolveOnPath(
  name: string,
  pathEnv: string | undefined,
): string | undefined {
  if (!pathEnv) return undefined;
  for (const entry of pathEnv.split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, name);
    if (notRunnableReason(candidate) === undefined) return candidate;
  }
  return undefined;
}

export interface ResolvedDaemonBin {
  /** What to hand to the spawn: absolute when found, else the bare name. */
  path: string;
  /** False only when a bare name is not on PATH. */
  found: boolean;
  /** True when the operator set the flag or env, rather than the default. */
  explicit: boolean;
}

/**
 * Resolve the configured value (already through {@link validateQwenBinPath}, or
 * undefined for the default `qwen`) to the path the daemons will be spawned
 * with.
 */
export function resolveDaemonBin(
  configured: string | undefined,
  pathEnv: string | undefined,
): ResolvedDaemonBin {
  const explicit = configured !== undefined;
  const wanted = configured ?? DEFAULT_BIN;
  if (wanted.includes('/')) return { path: wanted, found: true, explicit };
  const onPath = resolveOnPath(wanted, pathEnv);
  return onPath
    ? { path: onPath, found: true, explicit }
    : { path: wanted, found: false, explicit };
}

/**
 * `<bin> --version`, first line, trimmed. Undefined on any failure or after
 * `timeoutMs` (the child is killed): a version is for the log, never a reason
 * to stop a boot.
 */
export function readDaemonVersion(
  bin: string,
  timeoutMs = 5000,
): Promise<string | undefined> {
  return new Promise((resolveVersion) => {
    try {
      execFile(
        bin,
        ['--version'],
        { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' },
        (err, stdout) => {
          if (err) return resolveVersion(undefined);
          const first = String(stdout).split('\n')[0]?.trim();
          resolveVersion(first ? first : undefined);
        },
      );
    } catch {
      resolveVersion(undefined);
    }
  });
}

export function formatDaemonBinLine(
  path: string,
  version: string | undefined,
): string {
  return `qwen-rc serve: daemon qwen = ${path} (${version ?? 'version unknown'})`;
}

/**
 * The file a `QWEN_RC_TERMINAL_QWEN` argv runs: its last element ending in
 * `.js` (`node [flags] dist/index.js`), else its first element (a binary or
 * wrapper).
 */
export function terminalScriptPath(argv: string[]): string {
  for (let i = argv.length - 1; i >= 0; i--) {
    if (argv[i]!.endsWith('.js')) return argv[i]!;
  }
  return argv[0]!;
}

function realOf(path: string, pathEnv: string | undefined): string | undefined {
  const file = path.includes('/') ? path : resolveOnPath(path, pathEnv);
  if (!file) return undefined;
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

export interface BuildDrift {
  daemonReal: string;
  terminalReal: string;
  /**
   * True when either file is not a `.js` file, so it may be a shell wrapper
   * that runs the other build. A wrapper is never parsed: the two real paths
   * are all that is compared.
   */
  maybeWrapper: boolean;
}

/**
 * Compare the real file behind the daemon binary with the real file behind the
 * terminal command. Same file (through any symlinks) or either side
 * unresolvable returns undefined; otherwise the two real paths.
 */
export function detectBuildDrift(
  daemonBin: string,
  terminalArgv: string[] | undefined,
  pathEnv: string | undefined,
): BuildDrift | undefined {
  if (!terminalArgv || terminalArgv.length === 0) return undefined;
  const daemonReal = realOf(daemonBin, pathEnv);
  const terminalReal = realOf(terminalScriptPath(terminalArgv), pathEnv);
  if (!daemonReal || !terminalReal || daemonReal === terminalReal) {
    return undefined;
  }
  return {
    daemonReal,
    terminalReal,
    maybeWrapper: !daemonReal.endsWith('.js') || !terminalReal.endsWith('.js'),
  };
}

export function formatDriftWarning(d: BuildDrift): string {
  return (
    `qwen-rc serve: WARNING: the terminal (QWEN_RC_TERMINAL_QWEN) runs ${d.terminalReal} but the daemons run ${d.daemonReal}: the terminal and the daemons run different builds` +
    (d.maybeWrapper
      ? ' (only the real paths were compared; a wrapper script is not read, so if one of these wraps the other, ignore this)'
      : '')
  );
}
