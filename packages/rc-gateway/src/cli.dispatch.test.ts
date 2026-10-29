/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the real cli.ts entry through tsx so the fall-through at the end of the
// subcommand dispatch is exercised, not just its pure helper.
const require_ = createRequire(import.meta.url);
let tsxImport: string | undefined;
try {
  tsxImport = require_.resolve('tsx');
} catch {
  tsxImport = undefined;
}
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

function run(...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', tsxImport as string, CLI, ...args],
    { encoding: 'utf8', timeout: 60_000 },
  );
}

describe.skipIf(!tsxImport)(
  'qwen-rc top-level dispatch fall-through',
  { timeout: 30_000 },
  () => {
    it('exits 2 with usage on stderr for an unknown subcommand', () => {
      const r = run('sever');
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("unknown command 'sever'");
      expect(r.stderr).toContain('usage: qwen-rc');
    });

    it('exits 2 for bare qwen-rc and for a command missing its subcommand', () => {
      expect(run().status).toBe(2);
      const r = run('audit');
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("'audit' needs a subcommand");
    });

    it('prints usage on stdout and exits 0 for help', () => {
      const r = run('help');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('usage: qwen-rc');
    });

    it('prints the package version and exits 0 for --version', () => {
      const r = run('--version');
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    describe('audit verify', () => {
      it('fails on a directory that does not exist, in both --dir forms', () => {
        const missing = join(tmpdir(), 'qwen-rc-no-such-audit-dir-167');
        for (const args of [['--dir', missing], [`--dir=${missing}`]]) {
          const r = run('audit', 'verify', ...args);
          expect(r.status).toBe(2);
          expect(r.stderr).toContain('not a directory');
        }
      });

      it('honours the documented --dir <path> form and catches a tampered chain there', () => {
        const d = mkdtempSync(join(tmpdir(), 'qwen-rc-audit-'));
        try {
          writeFileSync(
            join(d, 'audit-2026-07-09.log'),
            JSON.stringify({ prevHash: 'not-the-genesis-hash' }) + '\n',
          );
          const r = run('audit', 'verify', '--dir', d);
          expect(r.status).toBe(1);
          expect(r.stderr).toContain('FAILED');
        } finally {
          rmSync(d, { recursive: true, force: true });
        }
      });

      it('rejects a dangling --dir with a usage error', () => {
        const r = run('audit', 'verify', '--dir');
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('--dir needs');
      });
    });
  },
);
