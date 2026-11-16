/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getServeFeatures } from '../capabilities.js';
import {
  buildSessionTaskOutputStatus,
  DEFAULT_TASK_OUTPUT_MAX_BYTES,
  MAX_TASK_OUTPUT_MAX_BYTES,
  parseTaskOutputKind,
  parseTaskOutputMaxBytes,
} from './session-task-output.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-task-output-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('sessionTaskOutput', () => {
  it('advertises session_task_output in daemon capabilities', () => {
    expect(getServeFeatures()).toContain('session_task_output');
  });

  it('validates maxBytes and kind query parameters strictly', () => {
    expect(parseTaskOutputMaxBytes(undefined)).toEqual({
      ok: true,
      maxBytes: DEFAULT_TASK_OUTPUT_MAX_BYTES,
    });
    expect(parseTaskOutputMaxBytes('4096')).toEqual({
      ok: true,
      maxBytes: 4096,
    });
    expect(parseTaskOutputMaxBytes('0').ok).toBe(false);
    expect(parseTaskOutputMaxBytes('-5').ok).toBe(false);
    expect(
      parseTaskOutputMaxBytes(String(MAX_TASK_OUTPUT_MAX_BYTES + 1)).ok,
    ).toBe(false);
    expect(parseTaskOutputMaxBytes('abc').ok).toBe(false);

    expect(parseTaskOutputKind(undefined)).toEqual({
      ok: true,
      kind: undefined,
    });
    expect(parseTaskOutputKind('shell')).toEqual({
      ok: true,
      kind: 'shell',
    });
    expect(parseTaskOutputKind('bogus').ok).toBe(false);
  });

  it('reads bounded shell output tail, strips control/bidi chars, and aligns UTF-8 codepoints', () => {
    const dir = makeTempDir();
    const outFile = path.join(dir, 'shell-1.log');
    // Multi-byte UTF-8 sequence across boundary + control/bidi characters
    const prefix = 'A'.repeat(20) + '\u{1F680}';
    const suffix = '\nline-two\u0007\u202E-clean\n';
    fs.writeFileSync(outFile, prefix + suffix, 'utf8');
    const total = Buffer.byteLength(prefix + suffix, 'utf8');

    const res = buildSessionTaskOutputStatus(
      'sess-1',
      {
        kind: 'shell',
        id: 'sh-1',
        label: 'npm test',
        description: 'run tests',
        status: 'running',
        startTime: 1000,
        runtimeMs: 500,
        outputFile: outFile,
        command: 'npm test',
        cwd: dir,
      },
      // Cut right inside the 4-byte rocket emoji so continuation bytes are skipped
      Buffer.byteLength(suffix, 'utf8') + 2,
    );

    expect(res).toEqual({
      v: 1,
      sessionId: 'sess-1',
      taskId: 'sh-1',
      kind: 'shell',
      label: 'npm test',
      status: 'running',
      available: true,
      content: '\nline-two-clean\n',
      truncated: true,
      byteLength: Buffer.byteLength('\nline-two-clean\n', 'utf8'),
      totalBytes: total,
    });
    expect('outputFile' in res).toBe(false);
  });

  it('refuses symlinked shell output files via O_NOFOLLOW', () => {
    const dir = makeTempDir();
    const secretFile = path.join(dir, 'secret.txt');
    const linkFile = path.join(dir, 'shell-link.log');
    fs.writeFileSync(secretFile, 'top-secret', 'utf8');
    fs.symlinkSync(secretFile, linkFile);

    const res = buildSessionTaskOutputStatus(
      'sess-1',
      {
        kind: 'shell',
        id: 'sh-symlink',
        label: 'echo hi',
        description: 'echo hi',
        status: 'completed',
        startTime: 1000,
        runtimeMs: 100,
        outputFile: linkFile,
        command: 'echo hi',
        cwd: dir,
      },
      4096,
    );

    expect(res).toEqual({
      v: 1,
      sessionId: 'sess-1',
      taskId: 'sh-symlink',
      kind: 'shell',
      label: 'echo hi',
      status: 'completed',
      available: false,
      reason: 'unreadable_output_file',
      content: '',
      truncated: false,
      byteLength: 0,
      totalBytes: 0,
    });
  });

  it('reports missing_output_file when shell output file was removed and no_output_file for monitors', () => {
    const dir = makeTempDir();
    const missing = buildSessionTaskOutputStatus(
      'sess-1',
      {
        kind: 'shell',
        id: 'sh-gone',
        label: 'ls',
        description: 'ls',
        status: 'completed',
        startTime: 1000,
        runtimeMs: 50,
        outputFile: path.join(dir, 'gone.log'),
        command: 'ls',
        cwd: dir,
      },
      4096,
    );
    expect(missing.available).toBe(false);
    expect(missing.reason).toBe('missing_output_file');

    const monitor = buildSessionTaskOutputStatus(
      'sess-1',
      {
        kind: 'monitor',
        id: 'mon-1',
        label: 'watch logs',
        description: 'watch logs',
        status: 'running',
        startTime: 1000,
        runtimeMs: 200,
        command: 'tail -f app.log',
        eventCount: 5,
        lastEventTime: 1100,
        droppedLines: 1,
      },
      4096,
    );
    expect(monitor).toEqual({
      v: 1,
      sessionId: 'sess-1',
      taskId: 'mon-1',
      kind: 'monitor',
      label: 'watch logs',
      status: 'running',
      available: false,
      reason: 'no_output_file',
      content: '',
      truncated: false,
      byteLength: 0,
      totalBytes: 0,
    });
  });

  it('formats agent messages cleanly and falls back to workflow recentLogs when outputFile is absent', () => {
    const agentRes = buildSessionTaskOutputStatus(
      'sess-1',
      {
        kind: 'agent',
        id: 'ag-1',
        label: 'Researcher',
        description: 'inspect repo',
        status: 'completed',
        startTime: 1000,
        runtimeMs: 900,
        isBackgrounded: true,
        messages: [
          { role: 'user', content: 'Check routes', timestamp: 1001 },
          {
            role: 'assistant',
            content: 'Inspecting files',
            timestamp: 1002,
            thought: true,
          },
          { role: 'assistant', content: 'Found 3 routes.', timestamp: 1003 },
        ],
      },
      4096,
    );
    expect(agentRes.available).toBe(true);
    expect(agentRes.content).toContain('[user] Check routes');
    expect(agentRes.content).toContain('[thinking] Inspecting files');
    expect(agentRes.content).toContain('[assistant] Found 3 routes.');

    const wfRes = buildSessionTaskOutputStatus(
      'sess-1',
      {
        kind: 'workflow',
        id: 'wf-1',
        label: 'deploy-check',
        description: 'deploy check',
        status: 'completed',
        startTime: 1000,
        runtimeMs: 1200,
        outputFile: '',
        isBackgrounded: false,
        currentPhase: 'verify',
        phaseVisits: [],
        dispatches: [],
        agentsDispatched: 1,
        agentsCompleted: 1,
        agentsRespawned: 0,
        tokensSpent: 100,
        tokenBudgetTotal: 1000,
        recentLogs: ['phase 1 ok', 'phase 2 ok'],
        events: [],
        pendingApprovalCount: 0,
        pendingApprovals: [],
      },
      4096,
    );
    expect(wfRes.available).toBe(true);
    expect(wfRes.content).toBe('phase 1 ok\nphase 2 ok');
  });
});
