/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '../../scripts/install-win.mjs');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function plantUnpacked(dir: string, commit: string, builtAt: string): void {
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Qwen Remote Launcher.exe'), 'fake-exe');
  fs.writeFileSync(
    path.join(dir, 'resources', 'build-stamp.json'),
    JSON.stringify({ commit, builtAt }, null, 2),
  );
}

describe('scripts/install-win.mjs (#210)', () => {
  it('backs up an existing drifted install, copies win-unpacked, and passes --check', () => {
    const base = makeTempDir('launcher-install-210-');
    const unpacked = path.join(base, 'win-unpacked');
    const installDir = path.join(base, 'QwenRemoteLauncher');

    // Existing pre-#210 install with no build-stamp.json -> --check fails.
    fs.mkdirSync(path.join(installDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(installDir, 'Qwen Remote Launcher.exe'), 'old');

    let failedMsg = '';
    try {
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--check',
          `--install-dir=${installDir}`,
          '--expected-commit=abc1234567',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      failedMsg = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(failedMsg).toContain('predates #210');

    // Fresh unpacked build -> install backs up old dir and installs new one.
    plantUnpacked(unpacked, 'abc1234567', '2026-11-16T14:00:00.000Z');
    const installOut = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--no-process-control',
        `--unpacked-dir=${unpacked}`,
        `--install-dir=${installDir}`,
        '--expected-commit=abc1234567',
      ],
      { encoding: 'utf8' },
    );
    expect(installOut).toContain('backed up previous install to');
    expect(installOut).toContain('matches fork (abc1234567');

    const entries = fs.readdirSync(base);
    expect(entries.some((e) => e.startsWith('QwenRemoteLauncher.bak-'))).toBe(
      true,
    );

    // --check passes on matching commit and fails when fork advances.
    const checkOk = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--check',
        `--install-dir=${installDir}`,
        '--expected-commit=abc1234',
      ],
      { encoding: 'utf8' },
    );
    expect(checkOk).toContain('launcher-app check ok');

    let driftedMsg = '';
    try {
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--check',
          `--install-dir=${installDir}`,
          '--expected-commit=def9876543',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      driftedMsg = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(driftedMsg).toContain('is at abc1234567');
    expect(driftedMsg).toContain('fork HEAD is def9876543');
  });
});
