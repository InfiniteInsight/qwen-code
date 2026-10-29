/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileRouting,
  loadLayeredRoutingMatcher,
  loadLayeredRoutingMatcherStrict,
  loadResolvedRoutingRules,
  mergeRoutingConfigs,
  type RoutingConfig,
  type RoutingMatcher,
} from './rules.js';
import { createRoutingHotReload, type HotReload } from '../policy/hotReload.js';
import type { AuditEntry } from '../auditLog.js';
import { RATE_LIMIT_CRITICAL_KINDS } from '../webpush/notifier.js';

// Issue InfiniteInsight/Qwen-Code-Remote#156, routing half. The workspace
// routing layer DOES exist: `<cwd>/.qwen/routing.yaml` is merged over the user
// file (workspace rules first) by mergeRoutingConfigs, at boot and on reload.
// Routing rules can only drop, so "narrowing" here means the workspace layer
// may ADD rules but can never remove or take over a user rule.

const USER_YAML = `
rules:
  - id: quiet-completions
    match: { kind: task.completed }
    route: { drop: true }
`;

const rule = (id: string, kind: string): RoutingConfig['rules'][number] => ({
  id,
  match: { kind },
  route: { drop: true },
});

describe('mergeRoutingConfigs: the workspace layer adds, never takes over a user rule', () => {
  it('keeps every user rule, in order, whatever the workspace file holds', () => {
    const user = { rules: [rule('a', 'x'), rule('b', 'y')] };
    const ws = { rules: [rule('w1', 'x'), rule('w2', 'z')] };
    const merged = mergeRoutingConfigs(ws, user)!;
    expect(merged.rules.slice(-2).map((r) => r.id)).toEqual(['a', 'b']);
    expect(merged.rules).toHaveLength(4);
  });

  it('renames a workspace rule that reuses a user rule id, so the audit cannot confuse the two', () => {
    const user = { rules: [rule('quiet-completions', 'task.completed')] };
    const ws = { rules: [rule('quiet-completions', 'session.idle')] };
    const merged = mergeRoutingConfigs(ws, user)!;
    expect(merged.rules.map((r) => r.id)).toEqual([
      'workspace:quiet-completions',
      'quiet-completions',
    ]);
    const matcher = compileRouting(merged);
    // The user rule is reported under its own id for what it matches.
    expect(matcher.firstDrop({ kind: 'task.completed' })).toBe(
      'quiet-completions',
    );
    expect(matcher.firstDrop({ kind: 'session.idle' })).toBe(
      'workspace:quiet-completions',
    );
  });

  it('leaves a non-colliding workspace id as written', () => {
    const merged = mergeRoutingConfigs(
      { rules: [rule('mine', 'x')] },
      { rules: [rule('theirs', 'y')] },
    )!;
    expect(merged.rules.map((r) => r.id)).toEqual(['mine', 'theirs']);
  });

  it('does not rename anything when there is no user layer', () => {
    const merged = mergeRoutingConfigs({ rules: [rule('mine', 'x')] }, null)!;
    expect(merged.rules.map((r) => r.id)).toEqual(['mine']);
  });
});

// A workspace drop rule that can match an action-required event is refused: a
// file the model can write must not be able to mute the pushes that tell the
// operator a human is needed. The critical set is the notifier's own.
describe('workspace routing cannot suppress critical kinds (issue #156)', () => {
  const dropOf = (id: string, match: Record<string, unknown>) => ({
    id,
    match,
    route: { drop: true },
  });

  it('refuses a workspace drop on every critical kind the notifier knows', () => {
    expect(RATE_LIMIT_CRITICAL_KINDS.has('permission.required')).toBe(true);
    for (const kind of RATE_LIMIT_CRITICAL_KINDS) {
      const refused: string[] = [];
      const merged = mergeRoutingConfigs(
        { rules: [dropOf('w', { kind })] },
        null,
        (r) => refused.push(r.id ?? ''),
      );
      expect(merged?.rules).toEqual([]);
      expect(refused).toEqual(['w']);
    }
  });

  it('refuses a workspace drop whose kind list includes a critical kind', () => {
    const merged = mergeRoutingConfigs(
      { rules: [dropOf('w', { kind: ['task.completed', 'session.died'] })] },
      null,
    );
    expect(merged?.rules).toEqual([]);
  });

  it('refuses a workspace drop with no kind, which would match every kind', () => {
    const merged = mergeRoutingConfigs(
      { rules: [dropOf('all', { sessionTag: 'x*' })] },
      null,
    );
    expect(merged?.rules).toEqual([]);
  });

  it('still applies a workspace drop on a non-critical kind', () => {
    const merged = mergeRoutingConfigs(
      { rules: [dropOf('w', { kind: 'turn_complete' })] },
      null,
    )!;
    expect(compileRouting(merged).firstDrop({ kind: 'turn_complete' })).toBe(
      'w',
    );
  });

  it('still applies a USER drop on a critical kind', () => {
    const merged = mergeRoutingConfigs(null, {
      rules: [dropOf('u', { kind: 'permission.required' })],
    })!;
    expect(
      compileRouting(merged).firstDrop({ kind: 'permission.required' }),
    ).toBe('u');
  });

  describe('through the loaders', () => {
    let dir: string;
    let userPath: string;
    let cwd: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'rc-routing-crit-'));
      userPath = join(dir, 'routing.yaml');
      cwd = join(dir, 'ws');
      await mkdir(join(cwd, '.qwen'), { recursive: true });
      await writeFile(
        join(cwd, '.qwen', 'routing.yaml'),
        `rules:
  - id: mute-prompts
    match: { kind: permission.required }
    route: { drop: true }
  - id: mute-turns
    match: { kind: turn_complete }
    route: { drop: true }
`,
        'utf8',
      );
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('boot load warns and drops it; the inspector omits it too', async () => {
      const warnings: string[] = [];
      const { matcher, ruleCount } = await loadLayeredRoutingMatcher(
        userPath,
        cwd,
        (m) => warnings.push(m),
      );
      expect(ruleCount).toBe(1);
      expect(matcher?.firstDrop({ kind: 'permission.required' })).toBeNull();
      expect(matcher?.firstDrop({ kind: 'turn_complete' })).toBe('mute-turns');
      expect(warnings.join('\n')).toContain('mute-prompts');
      const resolved = await loadResolvedRoutingRules(userPath, cwd);
      expect(resolved.map((r) => r.rule.id)).toEqual(['mute-turns']);
    });

    it('the strict (reload) loader reports how many it dropped', async () => {
      const res = await loadLayeredRoutingMatcherStrict(userPath, cwd);
      expect(res.ruleCount).toBe(1);
      expect(res.ignored).toBe(1);
    });
  });
});

describe('routing hot reload (issue #156)', () => {
  let dir: string;
  let userPath: string;
  let workspaceCwd: string;
  let workspaceFile: string;
  let live: RoutingMatcher | undefined;
  let applied: number;
  let audit: AuditEntry[];
  let reload: HotReload | undefined;

  const start = async (extra: { debounceMs?: number } = {}) => {
    live = (await loadLayeredRoutingMatcherStrict(userPath, workspaceCwd))
      .matcher;
    reload = createRoutingHotReload({
      userPath,
      workspaceCwd,
      apply: (m) => {
        live = m;
        applied += 1;
      },
      audit: {
        record: async (e) => {
          audit.push(e);
        },
      },
      log: { info: () => {}, warn: () => {} },
      timing: { debounceMs: 20, minIntervalMs: 0, maxWaitMs: 1000, ...extra },
    });
  };
  const rows = (action: string) => audit.filter((e) => e.action === action);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-routing-hot-'));
    userPath = join(dir, 'routing.yaml');
    workspaceCwd = join(dir, 'ws');
    workspaceFile = join(workspaceCwd, '.qwen', 'routing.yaml');
    await mkdir(join(workspaceCwd, '.qwen'), { recursive: true });
    await writeFile(userPath, USER_YAML, 'utf8');
    applied = 0;
    audit = [];
    reload = undefined;
  });
  afterEach(async () => {
    reload?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('a routing reload cannot remove a user rule, even from a workspace rule with the same id', async () => {
    await start();
    expect(live?.firstDrop({ kind: 'task.completed' })).toBe(
      'quiet-completions',
    );
    // The workspace file claims the user rule's id, with a rule that does not
    // match what the user rule matches.
    await writeFile(
      workspaceFile,
      `
rules:
  - id: quiet-completions
    match: { kind: session.idle }
    route: { drop: true }
  - id: not-a-drop
    match: { kind: task.completed }
    route: { drop: false }
`,
      'utf8',
    );
    reload!.trigger(workspaceFile);
    await vi.waitFor(() => expect(applied).toBe(1));
    expect(live?.firstDrop({ kind: 'task.completed' })).toBe(
      'quiet-completions',
    );
    // The workspace rule was added, under its own id.
    expect(live?.firstDrop({ kind: 'session.idle' })).toBe(
      'workspace:quiet-completions',
    );
  });

  it('deleting the workspace routing file leaves the user rules in force', async () => {
    await writeFile(
      workspaceFile,
      `rules:\n  - id: w\n    match: { kind: x }\n    route: { drop: true }\n`,
      'utf8',
    );
    await start();
    await rm(workspaceFile);
    reload!.trigger(workspaceFile);
    await vi.waitFor(() => expect(applied).toBe(1));
    expect(live?.firstDrop({ kind: 'task.completed' })).toBe(
      'quiet-completions',
    );
    expect(live?.firstDrop({ kind: 'x' })).toBeNull();
  });

  it('a broken workspace routing file keeps the previous matcher and audits the refusal', async () => {
    await start();
    const before = live;
    await writeFile(workspaceFile, 'rules: [ {{{ nope', 'utf8');
    reload!.trigger(workspaceFile);
    await vi.waitFor(() =>
      expect(rows('routing_reload_failed')).toHaveLength(1),
    );
    expect(applied).toBe(0);
    expect(live).toBe(before);
    expect(live?.firstDrop({ kind: 'task.completed' })).toBe(
      'quiet-completions',
    );
    const row = rows('routing_reload_failed')[0]!;
    expect(row.detail?.['file']).toBe(workspaceFile);
    expect(String(row.detail?.['reason'])).not.toBe('');
    expect(rows('routing_reloaded')).toHaveLength(0);
  });

  it('audits one row per applied reload with the file and the rule count', async () => {
    await start();
    await writeFile(
      workspaceFile,
      `rules:\n  - id: w\n    match: { kind: x }\n    route: { drop: true }\n`,
      'utf8',
    );
    reload!.trigger(workspaceFile);
    await vi.waitFor(() => expect(rows('routing_reloaded')).toHaveLength(1));
    expect(rows('routing_reloaded')[0]!.detail).toEqual({
      file: workspaceFile,
      ruleCount: 2,
      ignored: 0,
    });
  });

  it('a burst of 20 writes applies once', async () => {
    await start({ debounceMs: 60 });
    for (let i = 0; i < 20; i++) {
      await writeFile(
        workspaceFile,
        `rules:\n  - id: w${i}\n    match: { kind: x }\n    route: { drop: true }\n`,
        'utf8',
      );
      reload!.trigger(workspaceFile);
      await new Promise((r) => setTimeout(r, 5));
    }
    await vi.waitFor(() => expect(applied).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(applied).toBe(1);
    expect(rows('routing_reloaded')).toHaveLength(1);
    expect(live?.firstDrop({ kind: 'x' })).toBe('w19');
  });

  it('a workspace drop on permission.required is ignored and audited; one on turn_complete applies', async () => {
    await start();
    await writeFile(
      workspaceFile,
      `
rules:
  - id: mute-prompts
    match: { kind: permission.required }
    route: { drop: true }
  - id: mute-turns
    match: { kind: turn_complete }
    route: { drop: true }
`,
      'utf8',
    );
    reload!.trigger(workspaceFile);
    await vi.waitFor(() => expect(rows('routing_reloaded')).toHaveLength(1));
    expect(live?.firstDrop({ kind: 'permission.required' })).toBeNull();
    expect(live?.firstDrop({ kind: 'turn_complete' })).toBe('mute-turns');
    expect(rows('routing_reloaded')[0]!.detail).toEqual({
      file: workspaceFile,
      ruleCount: 2,
      ignored: 1,
    });
  });

  it('a user drop on permission.required still applies across a reload', async () => {
    await writeFile(
      userPath,
      `rules:\n  - id: user-mute\n    match: { kind: permission.required }\n    route: { drop: true }\n`,
      'utf8',
    );
    await start();
    await writeFile(
      workspaceFile,
      `rules:\n  - id: w\n    match: { kind: turn_complete }\n    route: { drop: true }\n`,
      'utf8',
    );
    reload!.trigger(workspaceFile);
    await vi.waitFor(() => expect(applied).toBe(1));
    expect(live?.firstDrop({ kind: 'permission.required' })).toBe('user-mute');
  });
});
