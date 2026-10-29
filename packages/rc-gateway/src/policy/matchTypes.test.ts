/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintPolicyFile, loadPolicy, PolicyError } from './loader.js';
import { evaluate } from './evaluator.js';

/** Issue #166: match fields must be validated by type at load. */
describe('match field types', () => {
  it.each([
    ['tool as a list', 'tool: [execute, edit]'],
    ['tool as a number', 'tool: 5'],
    ['tool as a mapping', 'tool: { a: b }'],
    ['blank tool (null)', 'tool:'],
    ['empty-string tool', 'tool: ""'],
    ['whitespace-only tool', 'tool: "  "'],
    ['argsGlob as a number', 'argsGlob: 5'],
    ['argsGlob as a mapping', 'argsGlob: { a: b }'],
    ['blank argsGlob (null)', 'argsGlob:'],
    ['argsGlob list with a non-string', 'argsGlob: ["ok", 3]'],
    ['argsGlob as an empty list', 'argsGlob: []'],
    ['pathGlob as a boolean', 'pathGlob: true'],
    ['pathGlob list with a null', 'pathGlob: ["a", null]'],
    ['originScope as a list', 'originScope: [owner]'],
    ['sessionTag as a number', 'sessionTag: 1'],
  ])('loadPolicy rejects %s with a PolicyError naming the rule', (_n, line) => {
    const yaml = `rules:\n  - id: r1\n    match:\n      ${line}\n    action: deny\n`;
    expect(() => loadPolicy(yaml)).toThrow(PolicyError);
    expect(() => loadPolicy(yaml)).toThrow(/rule\[0\]/);
  });

  it('still accepts every well-typed shape', () => {
    const p = loadPolicy(`
rules:
  - match:
      tool: execute
      argsGlob: ["a*", "b*"]
      pathGlob: "src/**"
      originScope: owner
      sessionTag: ci-*
    action: deny
  - match: {}
    action: prompt
`);
    expect(p.rules).toHaveLength(2);
  });

  it('a blank tool can no longer reach evaluate and throw in specificity', () => {
    // Programmatic policy, bypassing the loader: evaluation must not throw.
    const policy = {
      defaults: { action: 'prompt' as const },
      rules: [
        {
          id: 'x',
          match: { tool: null as unknown as string },
          action: 'deny' as const,
        },
        { id: 'y', match: { tool: 'execute' }, action: 'allow' as const },
      ],
    };
    expect(() =>
      evaluate(policy, { tool: 'execute', args: 'ls' }),
    ).not.toThrow();
  });
});

describe('lintPolicyFile on mistyped match fields', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-policytypes-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports tool: [execute, edit] as not ok instead of lint-clean', async () => {
    const p = join(dir, 'policy.yaml');
    await writeFile(
      p,
      'rules:\n  - id: d\n    match:\n      tool: [execute, edit]\n    action: deny\n',
    );
    const r = await lintPolicyFile(p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rule\[0\]\.match\.tool/);
  });

  it('reports a blank tool as not ok', async () => {
    const p = join(dir, 'policy.yaml');
    await writeFile(p, 'rules:\n  - match:\n      tool:\n    action: deny\n');
    const r = await lintPolicyFile(p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tool/);
  });
});
