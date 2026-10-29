/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface LauncherArgs {
  json: boolean;
  /** Set only when `--port` was given; the caller applies the default. */
  port?: number;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`--port needs a port number (got '${raw ?? ''}')`);
  }
  const n = Number(raw);
  if (n < 1 || n > 65535) {
    throw new Error(`--port must be between 1 and 65535 (got ${n})`);
  }
  return n;
}

/**
 * Parse the flags of `qwen-rc up|down|status`: `--json` and `--port <n>` /
 * `--port=<n>`. Throws on a bad port or an unknown flag; the old parser only
 * understood the space form and turned everything else into 8443 without a
 * word.
 */
export function parseLauncherArgs(argv: string[]): LauncherArgs {
  const out: LauncherArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') {
      out.json = true;
    } else if (a === '--port') {
      out.port = parsePort(argv[i + 1]);
      i++;
    } else if (a.startsWith('--port=')) {
      out.port = parsePort(a.slice('--port='.length));
    } else {
      throw new Error(`unexpected argument '${a}'`);
    }
  }
  return out;
}
