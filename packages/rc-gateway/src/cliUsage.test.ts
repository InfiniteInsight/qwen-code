/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  USAGE_TEXT,
  resolveTopLevel,
  isRunAsCli,
  parseAuditVerifyArgs,
} from './cliUsage.js';

describe('resolveTopLevel', () => {
  it.each(['help', '--help', '-h'])('%s is a help request', (w) => {
    expect(resolveTopLevel(w)).toEqual({ kind: 'help' });
  });

  it.each(['--version', '-v'])('%s is a version request', (w) => {
    expect(resolveTopLevel(w)).toEqual({ kind: 'version' });
  });

  it('a bare invocation is a usage error', () => {
    expect(resolveTopLevel(undefined)).toMatchObject({ kind: 'usage-error' });
  });

  it.each(['sever', 'polcy', 'audit-verify'])(
    'an unknown word (%s) is a usage error naming it',
    (w) => {
      const r = resolveTopLevel(w);
      expect(r.kind).toBe('usage-error');
      expect((r as { message: string }).message).toContain(`'${w}'`);
    },
  );
});

describe('resolveTopLevel, commands missing their subcommand', () => {
  it('names the missing subcommand rather than calling the command unknown', () => {
    expect(resolveTopLevel('audit', undefined)).toEqual({
      kind: 'usage-error',
      message: "'audit' needs a subcommand (verify)",
    });
    expect(resolveTopLevel('policy', 'lnt')).toEqual({
      kind: 'usage-error',
      message: "unknown policy subcommand 'lnt' (expected lint | explain)",
    });
  });
});

describe('USAGE_TEXT', () => {
  it('lists the commands an operator needs, including the audit --dir form', () => {
    for (const w of ['serve', 'up', 'policy', 'audit verify', '--dir <path>']) {
      expect(USAGE_TEXT).toContain(w);
    }
  });
});

describe('isRunAsCli', () => {
  it('is true when argv[1] is the module file, also through a symlink (npm bin)', () => {
    const d = mkdtempSync(join(tmpdir(), 'cliusage-'));
    try {
      const real = join(d, 'cli.js');
      writeFileSync(real, '');
      const link = join(d, 'qwen-rc');
      symlinkSync(real, link);
      const url = pathToFileURL(real).href;
      expect(isRunAsCli(real, url)).toBe(true);
      expect(isRunAsCli(link, url)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('is false for some other entry file, a missing argv[1], or a missing path', () => {
    const url = pathToFileURL(process.execPath).href;
    expect(isRunAsCli('/definitely/not/here', url)).toBe(false);
    expect(isRunAsCli(undefined, url)).toBe(false);
    expect(isRunAsCli(process.argv[1], url)).toBe(false);
  });
});

describe('parseAuditVerifyArgs', () => {
  it('has no dir when none is given, so the caller applies its default', () => {
    expect(parseAuditVerifyArgs([])).toEqual({});
  });

  it('reads the --dir=<path> form', () => {
    expect(parseAuditVerifyArgs(['--dir=/var/a'])).toEqual({ dir: '/var/a' });
  });

  it('reads the documented --dir <path> form', () => {
    expect(parseAuditVerifyArgs(['--dir', '/var/a'])).toEqual({
      dir: '/var/a',
    });
  });

  it('rejects --dir without a value, with an empty value, or followed by another flag', () => {
    expect(() => parseAuditVerifyArgs(['--dir'])).toThrow(/--dir/);
    expect(() => parseAuditVerifyArgs(['--dir='])).toThrow(/--dir/);
    expect(() => parseAuditVerifyArgs(['--dir', '--x'])).toThrow(/--dir/);
  });

  it('rejects an unknown argument rather than silently checking the default dir', () => {
    expect(() => parseAuditVerifyArgs(['/var/a'])).toThrow(/unexpected/);
    expect(() => parseAuditVerifyArgs(['--drr', '/var/a'])).toThrow(
      /unexpected/,
    );
  });
});
