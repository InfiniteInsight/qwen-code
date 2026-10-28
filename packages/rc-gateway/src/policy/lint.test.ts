/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintPolicyFile, formatPolicyLint } from './loader.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-policylint-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, body);
  return p;
}

describe('lintPolicyFile', () => {
  it('reports a valid file with its rule count', async () => {
    const p = await write(
      'ok.yaml',
      `rules:\n  - id: a\n    match: { tool: execute }\n    action: allow\n  - id: b\n    match: { tool: read }\n    action: deny\n`,
    );
    const r = await lintPolicyFile(p);
    expect(r.ok).toBe(true);
    expect(r.ruleCount).toBe(2);
    expect(r.deferred).toEqual([]);
  });

  it('reports a malformed file as invalid with the loader error', async () => {
    const p = await write(
      'bad.yaml',
      `rules:\n  - id: a\n    match: { tool: execute }\n    action: maybe\n`,
    );
    const r = await lintPolicyFile(p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/action must be allow\/deny\/prompt/);
  });

  it('reports a non-mapping document as invalid', async () => {
    const p = await write('list.yaml', `- 1\n- 2\n`);
    const r = await lintPolicyFile(p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must be a mapping/);
  });

  it('reports a missing file as invalid (not a silent pass)', async () => {
    const r = await lintPolicyFile(join(dir, 'nope.yaml'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/file not found/);
  });

  it('reports a non-ENOENT read error (e.g. a directory) as invalid without throwing', async () => {
    // Passing the temp DIR as the path → readFile rejects with EISDIR, the
    // non-ENOENT arm → {ok:false, "cannot read …"} (never throws).
    const r = await lintPolicyFile(dir);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot read/);
    expect(r.error).not.toMatch(/file not found/);
  });

  it('lints a maxPerWindow rule clean — honored at runtime, not deferred (cycle 43)', async () => {
    const p = await write(
      'quota.yaml',
      `rules:\n  - id: quota\n    match: { tool: execute }\n    action: allow\n    maxPerWindow: { count: 5, windowSec: 60 }\n  - id: plain\n    match: { tool: read }\n    action: allow\n`,
    );
    const r = await lintPolicyFile(p);
    expect(r.ok).toBe(true);
    expect(r.ruleCount).toBe(2);
    expect(r.deferred).toEqual([]); // no longer deferred
  });

  it('rejects a malformed maxPerWindow (now validated, fail-closed)', async () => {
    const p = await write(
      'badquota.yaml',
      `rules:\n  - id: q\n    match: { tool: execute }\n    action: allow\n    maxPerWindow: 5\n`,
    );
    const r = await lintPolicyFile(p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/maxPerWindow must be a mapping/);
  });

  describe('workspace files (issue #156: the workspace layer can only narrow)', () => {
    async function writeWorkspace(body: string): Promise<string> {
      const wsDir = join(dir, 'repo', '.qwen');
      await mkdir(wsDir, { recursive: true });
      const p = join(wsDir, 'policy.yaml');
      await writeFile(p, body);
      return p;
    }
    const PROBE = `defaults: { action: allow }\nrules:\n  - id: ws-allow-all\n    match: {}\n    action: allow\n    priority: 1000\n  - id: ws-deny-fetch\n    match: { tool: fetch }\n    action: deny\n`;

    it('reports a <dir>/.qwen/policy.yaml that allows or sets defaults instead of passing it', async () => {
      const p = await writeWorkspace(PROBE);
      const r = await lintPolicyFile(p);
      expect(r.ok).toBe(false);
      expect(r.violations).toHaveLength(2);
      expect(r.violations!.some((v) => v.includes("'ws-allow-all'"))).toBe(
        true,
      );
      expect(r.violations!.some((v) => v.includes('defaults'))).toBe(true);
      const out = formatPolicyLint(p, r);
      expect(out).toMatch(/^✖ /);
      expect(out).toContain('ignored:');
      expect(out).toContain("'ws-allow-all'");
    });

    it('a workspace file with only deny/prompt rules lints clean', async () => {
      const p = await writeWorkspace(
        `rules:\n  - id: d\n    match: { tool: fetch }\n    action: deny\n  - id: q\n    match: { tool: edit }\n    action: prompt\n`,
      );
      const r = await lintPolicyFile(p);
      expect(r.ok).toBe(true);
      expect(r.ruleCount).toBe(2);
      expect(r.violations ?? []).toEqual([]);
    });

    it('the same allow rule and defaults in a USER file are fine', async () => {
      await mkdir(join(dir, 'rc'), { recursive: true });
      const p = join(dir, 'rc', 'policy.yaml');
      await writeFile(p, PROBE);
      const r = await lintPolicyFile(p);
      expect(r.ok).toBe(true);
      expect(r.violations ?? []).toEqual([]);
    });

    it('{ workspace: true } applies the workspace bounds to any path', async () => {
      const p = await write('ws-copy.yaml', PROBE);
      expect((await lintPolicyFile(p)).ok).toBe(true);
      const r = await lintPolicyFile(p, { workspace: true });
      expect(r.ok).toBe(false);
      expect(r.violations).toHaveLength(2);
    });

    it('a malformed workspace file still reports the schema error', async () => {
      const p = await writeWorkspace(`rules: 5\n`);
      const r = await lintPolicyFile(p);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/rules must be a sequence/);
    });
  });

  it('surfaces alias-widening + newly-live warnings through formatPolicyLint', async () => {
    const p = await write(
      'warn.yaml',
      `rules:\n  - id: a\n    match: { tool: write_file }\n    action: allow\n`,
    );
    const r = await lintPolicyFile(p);
    expect(r.warnings?.length).toBeGreaterThan(0);
    const out = formatPolicyLint(p, r);
    expect(out).toContain('warning:');
    expect(out).toMatch(/also matches/i);
  });
});

describe('formatPolicyLint', () => {
  it('renders a valid result', () => {
    expect(
      formatPolicyLint('/p.yaml', { ok: true, ruleCount: 3, deferred: [] }),
    ).toBe('✓ /p.yaml: valid (3 rule(s))');
  });

  it('appends a note when deferred rules are present', () => {
    const out = formatPolicyLint('/p.yaml', {
      ok: true,
      ruleCount: 2,
      deferred: ['quota'],
    });
    expect(out).toContain('✓ /p.yaml: valid (2 rule(s))');
    expect(out).toContain('not-yet-evaluated field');
    expect(out).toContain('quota');
  });

  it('renders an invalid result', () => {
    expect(formatPolicyLint('/p.yaml', { ok: false, error: 'boom' })).toBe(
      '✖ /p.yaml: boom',
    );
  });
});
