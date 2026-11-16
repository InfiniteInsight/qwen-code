/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stamp `dist/build-stamp.json` after `tsc --build` so the running gateway can
 * compare its own commit and build timestamp against the Windows launcher's
 * heartbeat (#210).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const distDir = path.join(root, 'dist');

let commit = 'unknown';
try {
  const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (out) commit = out;
} catch {
  commit = 'unknown';
}

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(
  path.join(distDir, 'build-stamp.json'),
  `${JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2)}\n`,
);
