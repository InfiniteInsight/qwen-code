/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentEventEmitter,
  AgentEventType,
  getSubagentSessionDir,
  Storage,
  type ChatRecord,
} from '@qwen-code/qwen-code-core';
import { attachJsonlTranscriptWriter } from '@qwen-code/qwen-code-core/agents/agent-transcript.js';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import type { WorkspaceRuntime } from './workspace-registry.js';
import {
  createVirtualSubagentSessionId,
  parseVirtualSubagentSessionId,
  preferTerminalTaskStatus,
  VirtualSubagentSessions,
} from './virtual-subagent-sessions.js';

const tempDirs: string[] = [];

it.each([
  new Error('bridge disconnected'),
  new SessionNotFoundError('parent', undefined, 'session_closing'),
])(
  'does not read persisted detail when the live parent fails with %s',
  async (error) => {
    const runtime = {
      bridge: {
        getSessionTasksStatus: async () => {
          throw error;
        },
      },
    } as unknown as WorkspaceRuntime;
    await expect(
      new VirtualSubagentSessions().resolve(runtime, 'parent', 'agent'),
    ).rejects.toBe(error);
  },
);

it.each(['running', 'paused'])(
  'keeps a terminal task status over non-terminal %s metrics',
  (metricsStatus) => {
    expect(preferTerminalTaskStatus(metricsStatus, 'completed')).toBe(
      'completed',
    );
  },
);

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function record(
  uuid: string,
  parentUuid: string | null,
  type: 'user' | 'assistant',
  text: string,
): ChatRecord {
  return {
    uuid,
    parentUuid,
    sessionId: 'parent-session',
    timestamp: new Date().toISOString(),
    type,
    cwd: '/workspace',
    version: 'test',
    message: {
      role: type === 'assistant' ? 'model' : 'user',
      parts: [{ text }],
    },
  };
}

function activeTarget(sessions: VirtualSubagentSessions): {
  refreshLive: () => Promise<void>;
  subscribers: number;
} {
  const targets = (
    sessions as unknown as {
      targets: Map<
        string,
        { refreshLive: () => Promise<void>; subscribers: number }
      >;
    }
  ).targets;
  const target = targets.values().next().value;
  if (!target) throw new Error('Expected an active virtual subagent target');
  return target;
}

describe('VirtualSubagentSessions', () => {
  it('rejects invalid, oversized, or non-round-trippable id parts', () => {
    expect(() =>
      createVirtualSubagentSessionId('parent session', 'agent-1'),
    ).toThrow('valid id parts');
    expect(() =>
      createVirtualSubagentSessionId('parent/session', 'agent-1'),
    ).toThrow('valid id parts');
    expect(() =>
      createVirtualSubagentSessionId('parent:session', 'agent-1'),
    ).toThrow('valid id parts');
    expect(() =>
      createVirtualSubagentSessionId('parent.session', 'agent-1'),
    ).toThrow('valid id parts');
    expect(() => createVirtualSubagentSessionId('', 'agent-1')).toThrow(
      'valid id parts',
    );
    expect(() =>
      createVirtualSubagentSessionId('a'.repeat(501), 'agent-1'),
    ).toThrow('valid id parts');
    expect(() => createVirtualSubagentSessionId('parent-session', '')).toThrow(
      'valid id parts',
    );
    expect(() =>
      createVirtualSubagentSessionId('parent-session', 'a'.repeat(501)),
    ).toThrow('valid id parts');
    expect(() =>
      createVirtualSubagentSessionId('parent-session', '界'.repeat(493)),
    ).toThrow('exceeds 2000 characters');
    expect(() =>
      createVirtualSubagentSessionId('parent-session', '\ud800'),
    ).toThrow('valid id parts');
  });

  it.each([
    ['a'.repeat(500), 696],
    [`${'界'.repeat(492)}aa`, 2_000],
  ])(
    'round-trips an agent id at an accepted length boundary',
    (agentId, expectedSessionIdLength) => {
      const sessionId = createVirtualSubagentSessionId(
        'parent-session',
        agentId,
      );

      expect(sessionId).toHaveLength(expectedSessionIdLength);
      expect(parseVirtualSubagentSessionId(sessionId)).toEqual({
        parentSessionId: 'parent-session',
        agentId,
      });
    },
  );

  it.each([
    ['non-canonical parent encoding', true, false],
    ['non-canonical agent encoding', false, true],
  ])('rejects %s', (_name, padParent, padAgent) => {
    const sessionId = createVirtualSubagentSessionId(
      'parent-session',
      'agent-1',
    );
    const [parentPart, agentPart] = sessionId
      .slice('subagent.'.length)
      .split('.');
    const nonCanonicalSessionId = `subagent.${parentPart}${padParent ? '=' : ''}.${agentPart}${padAgent ? '=' : ''}`;

    expect(
      parseVirtualSubagentSessionId(nonCanonicalSessionId),
    ).toBeUndefined();
  });

  it('rejects a non-canonical agent encoding that decodes as garbage', () => {
    const sessionId = createVirtualSubagentSessionId(
      'parent-session',
      'agent-1',
    );
    const [parentPart] = sessionId.slice('subagent.'.length).split('.');

    expect(
      parseVirtualSubagentSessionId(`subagent.${parentPart}.garbage`),
    ).toBeUndefined();
  });

  it('rejects a parent part outside the strict charset', () => {
    const parentPart = Buffer.from('../foo', 'utf8').toString('base64url');
    const agentPart = Buffer.from('agent-1', 'utf8').toString('base64url');

    expect(
      parseVirtualSubagentSessionId(`subagent.${parentPart}.${agentPart}`),
    ).toBeUndefined();
  });

  it('rejects an oversized parent part above the part length cap', () => {
    const parentPart = Buffer.from('a'.repeat(600), 'utf8').toString(
      'base64url',
    );
    const agentPart = Buffer.from('agent-1', 'utf8').toString('base64url');

    expect(
      parseVirtualSubagentSessionId(`subagent.${parentPart}.${agentPart}`),
    ).toBeUndefined();
  });

  it('rejects an oversized session id at the parse-side total length cap', () => {
    // Both decoded parts sit exactly at the part length cap, so only the
    // total length check can reject this id.
    const parentPart = Buffer.from('a'.repeat(500), 'utf8').toString(
      'base64url',
    );
    const agentPart = Buffer.from('界'.repeat(500), 'utf8').toString(
      'base64url',
    );
    const sessionId = `subagent.${parentPart}.${agentPart}`;

    expect(sessionId).toHaveLength(2677);
    expect(parseVirtualSubagentSessionId(sessionId)).toBeUndefined();
  });

  it.each(['general-purpose-agent:8', 'general-purpose-agent/8'])(
    'round-trips an existing agent id containing reserved characters: %s',
    (agentId) => {
      const sessionId = createVirtualSubagentSessionId(
        'parent-session',
        agentId,
      );

      expect(parseVirtualSubagentSessionId(sessionId)).toEqual({
        parentSessionId: 'parent-session',
        agentId,
      });
    },
  );

  it.each(['fork-agent-1', 'general-purpose-agent:8'])(
    'resolves an out-of-band task by agent task id: %s',
    async (taskId) => {
      const runtime = {
        workspaceId: 'workspace-1',
        workspaceCwd: '/workspace',
        env: { mode: 'parent-process', overlayKeys: [] },
        bridge: {
          getSessionTasksStatus: async () => ({
            v: 1 as const,
            sessionId: 'parent-session',
            now: Date.now(),
            tasks: [
              {
                kind: 'agent' as const,
                id: taskId,
                label: 'Review current changes',
                description: 'Review current changes',
                status: 'running' as const,
                startTime: Date.now(),
                runtimeMs: 1,
                outputFile: `/tmp/${taskId}.jsonl`,
                isBackgrounded: true,
              },
            ],
          }),
        },
      } as unknown as WorkspaceRuntime;

      const resolved = await new VirtualSubagentSessions().resolve(
        runtime,
        'parent-session',
        taskId,
      );

      expect(resolved).toMatchObject({
        taskId,
        title: 'Review current changes',
        status: 'running',
      });
      expect(parseVirtualSubagentSessionId(resolved!.sessionId)).toEqual({
        parentSessionId: 'parent-session',
        agentId: taskId,
      });
    },
  );

  it('resolves, fully loads, and independently streams an agent transcript', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-'));
    tempDirs.push(dir);
    const outputFile = path.join(dir, 'agent.jsonl');
    await fs.writeFile(
      outputFile,
      `${JSON.stringify(record('one', null, 'user', 'task'))}\n${JSON.stringify(
        {
          ...record('two', 'one', 'assistant', 'first'),
          timestamp: new Date(1_000).toISOString(),
          agentRunId: 'run-one',
          agentRound: 1,
        },
      )}\n`,
    );
    await fs.writeFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        runId: 'run-one',
        round: 1,
        text: 'completed round duplicate',
        thought: false,
        timestamp: 500,
      })}\n${JSON.stringify({
        v: 1,
        runId: 'run-one',
        round: 2,
        text: 'already streaming',
        thought: false,
        timestamp: Date.now(),
      })}\n`,
    );

    const runtime = {
      workspaceId: 'workspace-1',
      workspaceCwd: '/workspace',
      sessionRuntimeBaseDir: Storage.getRuntimeBaseDir(),
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: 'parent-session',
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'general-purpose-call-1',
              label: 'agent: research',
              description: 'research',
              status: 'running' as const,
              startTime: Date.now(),
              runtimeMs: 1,
              stats: {
                totalTokens: 321,
                toolUses: 2,
                durationMs: 4_500,
              },
              outputFile,
              isBackgrounded: false,
              toolUseId: 'call-1',
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sessions = new VirtualSubagentSessions();
    const resolved = await sessions.resolve(
      runtime,
      'parent-session',
      'call-1',
    );

    expect(resolved?.title).toBe('agent: research');
    expect(resolved).toMatchObject({
      taskId: 'general-purpose-call-1',
      status: 'running',
      durationMs: 4_500,
      totalTokens: 321,
    });
    expect(parseVirtualSubagentSessionId(resolved!.sessionId)).toEqual({
      parentSessionId: 'parent-session',
      agentId: 'general-purpose-call-1',
    });

    const loaded = await sessions.load(runtime, resolved!.sessionId, 'detail');
    expect(loaded).toMatchObject({
      sessionId: resolved!.sessionId,
      attached: true,
      clientId: 'detail',
      historyHasMore: false,
    });
    expect(loaded?.compactedReplay.length).toBeGreaterThan(0);
    expect(JSON.stringify(loaded?.compactedReplay)).toContain(
      'already streaming',
    );
    expect(JSON.stringify(loaded?.compactedReplay)).not.toContain(
      'completed round duplicate',
    );

    const abort = new AbortController();
    const stream = await sessions.subscribe(runtime, resolved!.sessionId, {
      signal: abort.signal,
      lastEventId: loaded?.lastEventId,
    });
    const iterator = stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('replay_complete');
    const nestedCall: ChatRecord = {
      ...record('nested-call', 'two', 'assistant', ''),
      message: {
        role: 'model',
        parts: [{ functionCall: { id: 'nested', name: 'agent', args: {} } }],
      },
    };
    const nestedReadiness = (ready: boolean): ChatRecord => ({
      ...record(
        ready ? 'nested-ready' : 'nested-creating',
        ready ? 'nested-creating' : 'nested-call',
        'assistant',
        '',
      ),
      type: 'system',
      message: undefined,
      subtype: 'agent_session_ready',
      systemPayload: { callId: 'nested', subagentSessionReady: ready },
    });
    await fs.appendFile(
      outputFile,
      [nestedCall, nestedReadiness(false)]
        .map((entry) => JSON.stringify(entry) + '\n')
        .join(''),
    );
    await activeTarget(sessions).refreshLive();
    expect(JSON.stringify((await iterator.next()).value)).toContain(
      '"toolCallId":"nested"',
    );
    expect(JSON.stringify((await iterator.next()).value)).toContain(
      '"subagentSessionReady":false',
    );
    await fs.appendFile(
      outputFile,
      JSON.stringify(nestedReadiness(true)) + '\n',
    );
    await activeTarget(sessions).refreshLive();
    const readyUpdate = JSON.stringify((await iterator.next()).value);
    expect(readyUpdate).toContain('"toolCallId":"nested"');
    expect(readyUpdate).toContain('"subagentSessionReady":true');
    const readyReload = await sessions.load(runtime, resolved!.sessionId);
    expect(JSON.stringify(readyReload?.compactedReplay)).toContain(
      '"subagentSessionReady":true',
    );
    await fs.rm(`${outputFile}.stream`);
    await activeTarget(sessions).refreshLive();
    await fs.writeFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        runId: 'run-two',
        round: 1,
        text: `resumed round live ${'x'.repeat(512)}`,
        thought: false,
        timestamp: Date.now(),
      })}\n`,
    );
    await activeTarget(sessions).refreshLive();
    const streamed = await iterator.next();
    const reloaded = await sessions.load(runtime, resolved!.sessionId);
    await fs.writeFile(
      outputFile,
      `${JSON.stringify({
        ...record('replacement', null, 'assistant', 'replacement canonical'),
        timestamp: new Date(100).toISOString(),
      })}\n`,
    );
    await activeTarget(sessions).refreshLive();
    const replaced = await iterator.next();
    await fs.writeFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        text: 'stream after rewind',
        thought: false,
        timestamp: 200,
      })}\n`,
    );
    await activeTarget(sessions).refreshLive();
    const afterRewind = await iterator.next();
    abort.abort();
    await iterator.return?.();
    expect(streamed?.value).toMatchObject({ type: 'session_update' });
    expect(JSON.stringify(reloaded?.compactedReplay)).toContain(
      'resumed round live',
    );
    expect(JSON.stringify(replaced?.value)).toContain('replacement canonical');
    expect(JSON.stringify(afterRewind.value)).toContain('stream after rewind');
  });

  it('releases the subscriber count when the initial refresh fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-'));
    tempDirs.push(dir);
    // The property under test: any non-ENOENT failure of the initial refresh
    // releases the subscriber count (readNewRecords swallows only ENOENT and
    // rethrows the rest). A NUL byte makes Node's path argument validation throw
    // a non-ENOENT error on any fs access, deterministically on every platform
    // (the EISDIR-via-directory trick is not portable to Windows).
    const outputFile = path.join(dir, 'invalid\0transcript');
    const runtime = {
      workspaceId: 'workspace-refresh-error',
      workspaceCwd: '/workspace',
      sessionRuntimeBaseDir: Storage.getRuntimeBaseDir(),
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: 'parent-session',
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'agent-error',
              label: 'agent',
              description: 'agent',
              status: 'running' as const,
              startTime: Date.now(),
              runtimeMs: 1,
              outputFile,
              isBackgrounded: false,
              toolUseId: 'call-error',
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sessions = new VirtualSubagentSessions();
    const sessionId = createVirtualSubagentSessionId(
      'parent-session',
      'agent-error',
    );
    const stream = await sessions.subscribe(runtime, sessionId, {
      signal: new AbortController().signal,
    });

    await expect(stream![Symbol.asyncIterator]().next()).rejects.toThrow();
    expect(activeTarget(sessions).subscribers).toBe(0);
  });

  it('isolates cached targets by workspace runtime', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-'));
    tempDirs.push(dir);
    const makeRuntime = async (workspaceId: string, text: string) => {
      const outputFile = path.join(dir, `${workspaceId}.jsonl`);
      await fs.writeFile(
        outputFile,
        `${JSON.stringify(record('one', null, 'user', text))}\n`,
      );
      await fs.writeFile(
        `${outputFile}.stream`,
        `${JSON.stringify({
          v: 1,
          round: 1,
          text: `${text} stale stream`,
          thought: false,
          timestamp: Date.now(),
        })}\n`,
      );
      return {
        workspaceId,
        workspaceCwd: `/workspace/${workspaceId}`,
        sessionRuntimeBaseDir: Storage.getRuntimeBaseDir(),
        env: { mode: 'parent-process', overlayKeys: [] },
        bridge: {
          getSessionTasksStatus: async () => ({
            v: 1 as const,
            sessionId: 'parent-session',
            now: Date.now(),
            tasks: [
              {
                kind: 'agent' as const,
                id: 'agent-1',
                label: 'agent',
                description: 'agent',
                status: 'completed' as const,
                startTime: Date.now(),
                runtimeMs: 1,
                outputFile,
                isBackgrounded: false,
                toolUseId: 'call-1',
              },
            ],
          }),
        },
      } as unknown as WorkspaceRuntime;
    };
    const firstRuntime = await makeRuntime('workspace-1', 'first workspace');
    const secondRuntime = await makeRuntime('workspace-2', 'second workspace');
    const sessionId = 'subagent.cGFyZW50LXNlc3Npb24.YWdlbnQtMQ';
    const sessions = new VirtualSubagentSessions();

    const first = await sessions.load(firstRuntime, sessionId);
    const second = await sessions.load(secondRuntime, sessionId);

    expect(first?.workspaceCwd).toBe('/workspace/workspace-1');
    expect(second?.workspaceCwd).toBe('/workspace/workspace-2');
    expect(JSON.stringify(second?.compactedReplay)).toContain(
      'second workspace',
    );
    expect(JSON.stringify(second?.compactedReplay)).not.toContain(
      'first workspace',
    );
    expect(JSON.stringify(second?.compactedReplay)).not.toContain(
      'stale stream',
    );
  });

  it('keeps later canonical rounds when one streamed round is reconciled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-'));
    tempDirs.push(dir);
    const outputFile = path.join(dir, 'agent.jsonl');
    await fs.writeFile(
      outputFile,
      `${JSON.stringify(record('one', null, 'user', 'task'))}\n`,
    );
    await fs.writeFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        runId: 'run-batch',
        round: 1,
        text: 'streamed first round',
        thought: false,
        timestamp: Date.now(),
      })}\n`,
    );
    const runtime = {
      workspaceId: 'workspace-batch',
      workspaceCwd: '/workspace',
      sessionRuntimeBaseDir: Storage.getRuntimeBaseDir(),
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: 'parent-session',
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'agent-batch',
              label: 'agent',
              description: 'agent',
              status: 'running' as const,
              startTime: Date.now(),
              runtimeMs: 1,
              outputFile,
              isBackgrounded: false,
              toolUseId: 'call-batch',
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sessions = new VirtualSubagentSessions();
    const resolved = await sessions.resolve(
      runtime,
      'parent-session',
      'call-batch',
    );
    const loaded = await sessions.load(runtime, resolved!.sessionId);
    const abort = new AbortController();
    const stream = await sessions.subscribe(runtime, resolved!.sessionId, {
      signal: abort.signal,
      lastEventId: loaded!.lastEventId,
    });
    const iterator = stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('replay_complete');

    await fs.appendFile(
      outputFile,
      `${JSON.stringify({
        ...record('two', 'one', 'assistant', 'streamed first round'),
        agentRunId: 'run-batch',
        agentRound: 1,
      })}\n${JSON.stringify({
        ...record('three', 'two', 'assistant', 'canonical second round'),
        agentRunId: 'run-batch',
        agentRound: 2,
      })}\n`,
    );

    const update = await iterator.next();
    abort.abort();
    await iterator.return?.();
    expect(JSON.stringify(update.value)).toContain('canonical second round');
  });

  it('does not replay a second load snapshot again on subscribe', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-'));
    tempDirs.push(dir);
    const outputFile = path.join(dir, 'agent.jsonl');
    await fs.writeFile(
      outputFile,
      `${JSON.stringify(record('one', null, 'user', 'task'))}\n`,
    );
    const runtime = {
      workspaceId: 'workspace-reload',
      workspaceCwd: '/workspace',
      sessionRuntimeBaseDir: Storage.getRuntimeBaseDir(),
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: 'parent-session',
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'agent-reload',
              label: 'agent',
              description: 'agent',
              status: 'running' as const,
              startTime: Date.now(),
              runtimeMs: 1,
              outputFile,
              isBackgrounded: false,
              toolUseId: 'call-reload',
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;
    const sessions = new VirtualSubagentSessions();
    const resolved = await sessions.resolve(
      runtime,
      'parent-session',
      'call-reload',
    );
    await sessions.load(runtime, resolved!.sessionId);
    await fs.appendFile(
      outputFile,
      `${JSON.stringify({
        ...record('two', 'one', 'assistant', 'between snapshots'),
        agentRunId: 'run-reload',
        agentRound: 1,
      })}\n`,
    );

    const loaded = await sessions.load(runtime, resolved!.sessionId);
    expect(JSON.stringify(loaded!.compactedReplay)).toContain(
      'between snapshots',
    );
    await fs.writeFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        runId: 'run-reload',
        round: 1,
        text: 'between snapshots',
        thought: false,
        timestamp: Date.now(),
      })}\n`,
    );
    const abort = new AbortController();
    const stream = await sessions.subscribe(runtime, resolved!.sessionId, {
      signal: abort.signal,
      lastEventId: loaded!.lastEventId,
    });
    const iterator = stream![Symbol.asyncIterator]();
    const replayed: unknown[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.value?.type === 'replay_complete') break;
      replayed.push(next.value);
    }
    abort.abort();
    await iterator.return?.();
    expect(JSON.stringify(replayed)).not.toContain('between snapshots');
  });

  it('keeps task status while supplementing terminal metrics', async () => {
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-subagent-runtime-'),
    );
    tempDirs.push(runtimeDir);
    const workspaceCwd = path.join(runtimeDir, 'workspace');
    const projectDir = Storage.runWithRuntimeBaseDir(
      runtimeDir,
      workspaceCwd,
      () => new Storage(workspaceCwd).getProjectDir(),
    );
    const parentSessionId = 'running-parent';
    const toolCallId = 'call-running';
    const outputFile = path.join(runtimeDir, 'running-agent.jsonl');
    await fs.mkdir(path.join(projectDir, 'chats'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'chats', `${parentSessionId}.jsonl`),
      `${JSON.stringify({
        ...record('result', null, 'user', ''),
        sessionId: parentSessionId,
        type: 'tool_result',
        toolCallResult: {
          callId: toolCallId,
          status: 'success',
          resultDisplay: {
            type: 'task_execution',
            status: 'running',
            executionSummary: { totalTokens: 999 },
          },
        },
      })}\n`,
    );
    await fs.writeFile(
      outputFile,
      `${JSON.stringify(record('child', null, 'user', 'task'))}\n`,
    );
    let taskStatus: 'running' | 'completed' = 'running';
    const runtime = {
      workspaceId: 'running-workspace',
      workspaceCwd,
      sessionRuntimeBaseDir: runtimeDir,
      env: {
        mode: 'runtime-overlay',
        overlayKeys: ['QWEN_RUNTIME_DIR'],
        effectiveEnv: { QWEN_RUNTIME_DIR: runtimeDir },
      },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: parentSessionId,
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'general-purpose-running',
              label: 'running agent',
              description: 'running agent',
              status: taskStatus,
              startTime: Date.now(),
              runtimeMs: 1,
              stats: { totalTokens: 123, toolUses: 1, durationMs: 500 },
              outputFile,
              isBackgrounded: false,
              toolUseId: toolCallId,
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;

    const sessions = new VirtualSubagentSessions();
    const resolved = await sessions.resolve(
      runtime,
      parentSessionId,
      toolCallId,
    );

    expect(resolved).toMatchObject({
      status: 'running',
      durationMs: 500,
      totalTokens: 123,
    });
    const loaded = await sessions.load(runtime, resolved!.sessionId);
    const abort = new AbortController();
    const stream = await sessions.subscribe(runtime, resolved!.sessionId, {
      signal: abort.signal,
      lastEventId: loaded!.lastEventId,
    });
    const iterator = stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('replay_complete');

    taskStatus = 'completed';
    await fs.appendFile(
      outputFile,
      `${JSON.stringify(
        record('final', 'child', 'assistant', 'final canonical output'),
      )}\n`,
    );
    expect(
      await sessions.resolve(runtime, parentSessionId, toolCallId),
    ).toMatchObject({ status: 'completed', totalTokens: 999 });
    await activeTarget(sessions).refreshLive();
    const finalUpdate = await iterator.next();
    expect(JSON.stringify(finalUpdate?.value)).toContain(
      'final canonical output',
    );
    const turnComplete = await iterator.next();
    expect(turnComplete.value).toMatchObject({
      type: 'turn_complete',
      data: {
        sessionId: resolved!.sessionId,
        stopReason: 'end_turn',
      },
    });

    await fs.appendFile(
      `${outputFile}.stream`,
      `${JSON.stringify({
        v: 1,
        round: 1,
        text: 'must not be polled after completion',
        thought: false,
        timestamp: Date.now(),
      })}\n`,
    );
    const next = iterator.next();
    let settled = false;
    void next.then(() => {
      settled = true;
    });
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    vi.useRealTimers();
    abort.abort();
    await next;
    await iterator.return?.();
  });

  it('keeps terminal legacy sidecar status over the background launch result', async () => {
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-subagent-runtime-'),
    );
    tempDirs.push(runtimeDir);
    const workspaceCwd = path.join(runtimeDir, 'workspace');
    const projectDir = Storage.runWithRuntimeBaseDir(
      runtimeDir,
      workspaceCwd,
      () => new Storage(workspaceCwd).getProjectDir(),
    );
    const parentSessionId = 'legacy-parent';
    const toolCallId = 'call-old';
    const prompt = 'legacy launch prompt';
    await fs.mkdir(path.join(projectDir, 'chats'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'chats', `${parentSessionId}.jsonl`),
      `${JSON.stringify({
        ...record('root', null, 'assistant', ''),
        sessionId: parentSessionId,
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: toolCallId,
                name: 'agent',
                args: {
                  description: 'legacy task',
                  prompt,
                  subagent_type: 'general-purpose',
                },
              },
            },
          ],
        },
      })}\n${JSON.stringify({
        ...record('result', 'root', 'user', ''),
        sessionId: parentSessionId,
        type: 'tool_result',
        toolCallResult: {
          callId: toolCallId,
          status: 'success',
          resultDisplay: {
            type: 'task_execution',
            status: 'background',
            tokenCount: 123,
            executionSummary: {
              totalDurationMs: 88_610,
              totalTokens: 1_234,
              inputTokens: 1_000,
              outputTokens: 234,
              cachedTokens: 800,
            },
          },
        },
      })}\n`,
    );
    const sessionDir = getSubagentSessionDir(projectDir, parentSessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    const outputFile = path.join(
      sessionDir,
      'agent-general-purpose-random.jsonl',
    );
    await fs.writeFile(
      outputFile,
      `${JSON.stringify({
        ...record('child', null, 'user', prompt),
        sessionId: parentSessionId,
      })}\n`,
    );
    await fs.writeFile(
      outputFile.replace(/\.jsonl$/, '.meta.json'),
      JSON.stringify({
        agentId: 'general-purpose-random',
        agentType: 'general-purpose',
        description: 'legacy task',
        parentSessionId,
        parentAgentId: null,
        createdAt: new Date().toISOString(),
        status: 'completed',
      }),
    );
    const runtime = {
      workspaceId: 'legacy-workspace',
      workspaceCwd,
      sessionRuntimeBaseDir: runtimeDir,
      env: {
        mode: 'runtime-overlay',
        overlayKeys: ['QWEN_RUNTIME_DIR'],
        effectiveEnv: { QWEN_RUNTIME_DIR: runtimeDir },
      },
      bridge: {
        getSessionTasksStatus: async () => ({
          v: 1 as const,
          sessionId: parentSessionId,
          now: Date.now(),
          tasks: [
            {
              kind: 'agent' as const,
              id: 'general-purpose-random',
              label: 'legacy task',
              description: 'legacy task',
              status: 'completed' as const,
              startTime: Date.now(),
              runtimeMs: 1,
              outputFile,
              isBackgrounded: true,
            },
          ],
        }),
      },
    } as unknown as WorkspaceRuntime;

    const resolved = await new VirtualSubagentSessions().resolve(
      runtime,
      parentSessionId,
      toolCallId,
    );

    expect(parseVirtualSubagentSessionId(resolved!.sessionId)?.agentId).toBe(
      'general-purpose-random',
    );
    expect(resolved).toMatchObject({
      status: 'completed',
      durationMs: 88_610,
      totalTokens: 1_234,
      inputTokens: 1_000,
      outputTokens: 234,
      cachedTokens: 800,
    });
  });
});

it.each([
  { unloaded: false, dead: false },
  { unloaded: true, dead: false },
  { unloaded: false, dead: true },
  { unloaded: true, dead: true },
])(
  'resolves a workflow dispatch with owner state %j',
  async ({ unloaded, dead }) => {
    const runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-workflow-detail-'),
    );
    tempDirs.push(runtimeDir);
    const workspaceCwd = path.join(runtimeDir, 'workspace');
    const projectDir = Storage.runWithRuntimeBaseDir(
      runtimeDir,
      workspaceCwd,
      () => new Storage(workspaceCwd).getProjectDir(),
    );
    const parentSessionId = 'workflow-parent';
    const agentId = 'workflow-agent-1234';
    const sessionDir = getSubagentSessionDir(projectDir, parentSessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    const outputFile = path.join(sessionDir, `agent-${agentId}.jsonl`);
    await fs.writeFile(
      outputFile,
      `${JSON.stringify({ ...record('prompt', null, 'user', 'Inspect workflow activity'), sessionId: parentSessionId })}\n`,
    );
    const metaPath = outputFile.replace(/\.jsonl$/, '.meta.json');
    const meta = {
      agentId,
      agentType: 'reviewer',
      description: 'Inspect workflow activity',
      parentSessionId,
      parentAgentId: null,
      createdAt: new Date(1_000).toISOString(),
      status: 'running',
      isBackgrounded: false,
      workflowOwner: {
        pid: dead ? 2147483647 : process.pid,
        hostname: os.hostname(),
      },
    };
    await fs.writeFile(metaPath, JSON.stringify(meta));
    const runtime = {
      workspaceId: 'workflow-workspace',
      workspaceCwd,
      sessionRuntimeBaseDir: runtimeDir,
      env: {
        mode: 'runtime-overlay',
        overlayKeys: ['QWEN_RUNTIME_DIR'],
        effectiveEnv: { QWEN_RUNTIME_DIR: runtimeDir },
      },
      bridge: {
        getSessionTasksStatus: async () => {
          if (unloaded) throw new SessionNotFoundError(parentSessionId);
          return {
            v: 1,
            sessionId: parentSessionId,
            now: Date.now(),
            tasks: [],
          };
        },
      },
    } as unknown as WorkspaceRuntime;
    const sessions = new VirtualSubagentSessions();
    if (!dead) {
      await fs.writeFile(
        metaPath,
        JSON.stringify({
          ...meta,
          workflowOwner: {
            pid: 2147483647,
            hostname: `${os.hostname()}-other-host`,
          },
        }),
      );
      expect(
        await sessions.resolve(runtime, parentSessionId, agentId),
      ).toMatchObject({ status: 'running' });
      await fs.writeFile(
        metaPath,
        JSON.stringify({ ...meta, workflowOwner: undefined }),
      );
      expect(
        await sessions.resolve(runtime, parentSessionId, agentId),
      ).toMatchObject({ status: 'running' });
      await fs.writeFile(metaPath, JSON.stringify(meta));
    }
    const running = await sessions.resolve(runtime, parentSessionId, agentId);
    expect(running).toMatchObject({
      taskId: agentId,
      status: dead ? 'failed' : 'running',
    });
    expect(parseVirtualSubagentSessionId(running!.sessionId)).toEqual({
      parentSessionId,
      agentId,
    });
    expect(
      await sessions.resolve(runtime, 'another-parent', agentId),
    ).toBeUndefined();
    const loaded = await sessions.load(runtime, running!.sessionId);
    expect(JSON.stringify(loaded)).toContain('Inspect workflow activity');
    expect(loaded?.hasActivePrompt).toBe(!dead);
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    const abort = new AbortController();
    const stream = await sessions.subscribe(runtime, running!.sessionId, {
      signal: abort.signal,
      lastEventId: 0,
    });
    const iterator = stream![Symbol.asyncIterator]();
    try {
      await iterator.next();
      expect(
        intervals.mock.calls.filter((call) => call[1] === 250),
      ).toHaveLength(dead ? 0 : 1);
      if (!dead) {
        await fs.writeFile(
          metaPath,
          JSON.stringify({
            ...meta,
            workflowOwner: { ...meta.workflowOwner, pid: 2147483647 },
          }),
        );
        expect(
          await sessions.resolve(runtime, parentSessionId, agentId),
        ).toMatchObject({ status: 'failed' });
        expect(cleared).toHaveBeenCalled();
        expect(
          (await sessions.load(runtime, running!.sessionId))?.hasActivePrompt,
        ).toBe(false);
      }
    } finally {
      abort.abort();
      await iterator.return?.();
      intervals.mockRestore();
      cleared.mockRestore();
    }

    await fs.writeFile(
      metaPath,
      JSON.stringify({
        ...meta,
        status: 'completed',
        lastUpdatedAt: new Date(2_000).toISOString(),
      }),
    );
    expect(
      await sessions.resolve(runtime, parentSessionId, agentId),
    ).toMatchObject({
      taskId: agentId,
      status: 'completed',
      durationMs: 1_000,
    });
  },
);

it('prefers parent transcript terminal status in resolve and does not duplicate committed stream chunks on second load', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-'));
  tempDirs.push(dir);
  const workspaceCwd = path.join(dir, 'workspace');
  const runtimeBaseDir = path.join(dir, 'runtime');
  await fs.mkdir(workspaceCwd, { recursive: true });
  const projectDir = Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, () =>
    new Storage(workspaceCwd).getProjectDir(),
  );
  const chatsDir = path.join(projectDir, 'chats');
  await fs.mkdir(chatsDir, { recursive: true });
  const parentSessionId = 'parent-session';
  const toolCallId = 'call-terminal';
  const outputFile = path.join(dir, 'agent.jsonl');

  await fs.writeFile(
    path.join(chatsDir, `${parentSessionId}.jsonl`),
    `${JSON.stringify({
      uuid: 'parent-call',
      parentUuid: null,
      sessionId: parentSessionId,
      timestamp: new Date(1_000).toISOString(),
      type: 'assistant',
      cwd: workspaceCwd,
      version: 'test',
      message: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: toolCallId,
              name: 'agent',
              args: { description: 'subagent task' },
            },
          },
        ],
      },
    })}\n${JSON.stringify({
      uuid: 'parent-result',
      parentUuid: 'parent-call',
      sessionId: parentSessionId,
      timestamp: new Date(2_000).toISOString(),
      type: 'tool_result',
      cwd: workspaceCwd,
      version: 'test',
      toolCallResult: {
        callId: toolCallId,
        status: 'error',
        resultDisplay: {
          type: 'task_execution',
          status: 'cancelled',
          executionSummary: {
            totalDurationMs: 1_234,
            totalTokens: 99,
          },
        },
      },
    })}\n`,
  );

  await fs.writeFile(
    outputFile,
    `${JSON.stringify(record('u1', null, 'user', 'start task'))}\n`,
  );
  await fs.writeFile(
    `${outputFile}.stream`,
    `${JSON.stringify({
      v: 1,
      runId: 'run-1',
      round: 1,
      text: 'round one stream delta',
      thought: false,
      timestamp: 5_000,
    })}\n`,
  );

  let reportedStatus: 'running' | 'paused' | 'cancelled' = 'running';
  const runtime = {
    workspaceId: 'workspace-issue-465',
    workspaceCwd,
    sessionRuntimeBaseDir: runtimeBaseDir,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: {
      getSessionTasksStatus: async () => ({
        v: 1 as const,
        sessionId: parentSessionId,
        now: Date.now(),
        tasks: [
          {
            kind: 'agent' as const,
            id: 'agent-issue-465',
            label: 'subagent task',
            description: 'subagent task',
            status: reportedStatus,
            startTime: 1_000,
            runtimeMs: 1,
            outputFile,
            isBackgrounded: false,
            toolUseId: toolCallId,
          },
        ],
      }),
    },
  } as unknown as WorkspaceRuntime;

  const sessions = new VirtualSubagentSessions();
  const initialResolved = await sessions.resolve(
    runtime,
    parentSessionId,
    toolCallId,
  );
  expect(initialResolved?.status).toBe('running');

  const firstLoad = await sessions.load(runtime, initialResolved!.sessionId);
  expect(JSON.stringify(firstLoad?.compactedReplay)).toContain(
    'round one stream delta',
  );

  await fs.appendFile(
    outputFile,
    `${JSON.stringify({
      ...record('a1', 'u1', 'assistant', 'round one canonical reply'),
      timestamp: new Date(2_000).toISOString(),
    })}\n`,
  );
  await fs.appendFile(
    `${outputFile}.stream`,
    `${JSON.stringify({
      v: 1,
      runId: 'run-1',
      round: 2,
      text: 'round two live stream',
      thought: false,
      timestamp: 6_000,
    })}\n`,
  );

  const secondLoad = await sessions.load(runtime, initialResolved!.sessionId);
  const secondLoadJson = JSON.stringify(secondLoad?.compactedReplay);
  expect(secondLoadJson).toContain('round one canonical reply');
  expect(secondLoadJson).toContain('round two live stream');
  expect(secondLoadJson).not.toContain('round one stream delta');

  reportedStatus = 'paused';
  const resolvedWhilePaused = await sessions.resolve(
    runtime,
    parentSessionId,
    toolCallId,
  );
  expect(resolvedWhilePaused).toMatchObject({
    status: 'paused',
    durationMs: 1_234,
    totalTokens: 99,
  });

  reportedStatus = 'cancelled';
  const resolvedAfterFinish = await sessions.resolve(
    runtime,
    parentSessionId,
    toolCallId,
  );
  expect(resolvedAfterFinish).toMatchObject({
    status: 'cancelled',
    durationMs: 1_234,
    totalTokens: 99,
  });
});

it('resolves nested subagents via virtual parent session id and reads metrics from parent subagent transcript', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-nested-subagent-'));
  tempDirs.push(dir);
  const workspaceCwd = path.join(dir, 'workspace');
  const runtimeBaseDir = path.join(dir, 'runtime');
  await fs.mkdir(workspaceCwd, { recursive: true });
  const projectDir = Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, () =>
    new Storage(workspaceCwd).getProjectDir(),
  );
  const rootSessionId = 'root-session-1';
  const parentAgentId = 'parent-agent-1';
  const nestedAgentId = 'nested-agent-1';
  const nestedCallId = 'nested-call-1';
  const sessionDir = getSubagentSessionDir(projectDir, rootSessionId);
  await fs.mkdir(sessionDir, { recursive: true });

  const parentOutputFile = path.join(
    sessionDir,
    `agent-${parentAgentId}.jsonl`,
  );
  const nestedOutputFile = path.join(
    sessionDir,
    `agent-${nestedAgentId}.jsonl`,
  );
  await fs.writeFile(
    parentOutputFile,
    `${JSON.stringify({
      ...record('p-call', null, 'assistant', ''),
      sessionId: rootSessionId,
      message: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: nestedCallId,
              name: 'agent',
              args: {
                description: 'nested research',
                prompt: 'inspect child details',
                subagent_type: 'general-purpose',
              },
            },
          },
        ],
      },
    })}\n${JSON.stringify({
      ...record('p-result', 'p-call', 'user', ''),
      sessionId: rootSessionId,
      type: 'tool_result',
      toolCallResult: {
        callId: nestedCallId,
        status: 'success',
        resultDisplay: {
          type: 'task_execution',
          status: 'completed',
          executionSummary: {
            totalDurationMs: 2_500,
            totalToolCalls: 4,
            totalTokens: 640,
            inputTokens: 500,
            outputTokens: 140,
            cachedTokens: 200,
          },
        },
      },
    })}\n`,
  );
  await fs.writeFile(
    nestedOutputFile,
    `${JSON.stringify({
      ...record('n-u1', null, 'user', 'inspect child details'),
      sessionId: rootSessionId,
    })}\n`,
  );
  await fs.writeFile(
    nestedOutputFile.replace(/\.jsonl$/, '.meta.json'),
    JSON.stringify({
      agentId: nestedAgentId,
      agentType: 'general-purpose',
      description: 'nested research',
      parentSessionId: rootSessionId,
      parentAgentId,
      toolUseId: nestedCallId,
      createdAt: new Date(1_000).toISOString(),
      lastUpdatedAt: new Date(3_000).toISOString(),
      status: 'completed',
    }),
  );

  const requestedSessionIds: string[] = [];
  const runtime = {
    workspaceId: 'workspace-nested',
    workspaceCwd,
    sessionRuntimeBaseDir: runtimeBaseDir,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: {
      getSessionTasksStatus: async (sessionId: string) => {
        requestedSessionIds.push(sessionId);
        return {
          v: 1 as const,
          sessionId,
          now: Date.now(),
          tasks: [],
        };
      },
    },
  } as unknown as WorkspaceRuntime;

  const virtualParentSessionId = createVirtualSubagentSessionId(
    rootSessionId,
    parentAgentId,
  );
  const sessions = new VirtualSubagentSessions();
  const resolved = await sessions.resolve(
    runtime,
    virtualParentSessionId,
    nestedCallId,
  );

  expect(requestedSessionIds).toEqual([rootSessionId]);
  expect(resolved).toMatchObject({
    sessionId: createVirtualSubagentSessionId(rootSessionId, nestedAgentId),
    taskId: nestedAgentId,
    title: 'nested research',
    status: 'completed',
    durationMs: 2_500,
    toolCalls: 4,
    totalTokens: 640,
    inputTokens: 500,
    outputTokens: 140,
    cachedTokens: 200,
  });
});

it('preserves paused status over background or completed parent toolCallResult and prefers larger continued metrics', async () => {
  expect(preferTerminalTaskStatus('running', 'paused')).toBe('paused');
  expect(preferTerminalTaskStatus('completed', 'paused')).toBe('paused');
  expect(preferTerminalTaskStatus('completed', 'running')).toBe('completed');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-paused-metrics-'));
  tempDirs.push(dir);
  const workspaceCwd = path.join(dir, 'workspace');
  const runtimeBaseDir = path.join(dir, 'runtime');
  await fs.mkdir(workspaceCwd, { recursive: true });
  const projectDir = Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, () =>
    new Storage(workspaceCwd).getProjectDir(),
  );
  const chatsDir = path.join(projectDir, 'chats');
  await fs.mkdir(chatsDir, { recursive: true });
  const parentSessionId = 'parent-paused';
  const toolCallId = 'call-paused';
  const outputFile = path.join(dir, 'agent-paused.jsonl');

  await fs.writeFile(
    path.join(chatsDir, `${parentSessionId}.jsonl`),
    `${JSON.stringify({
      ...record('result-bg', null, 'user', ''),
      sessionId: parentSessionId,
      type: 'tool_result',
      toolCallResult: {
        callId: toolCallId,
        status: 'success',
        resultDisplay: {
          type: 'task_execution',
          status: 'background',
          executionSummary: {
            totalDurationMs: 1_000,
            totalToolCalls: 2,
            totalTokens: 300,
            inputTokens: 200,
            outputTokens: 100,
          },
        },
      },
    })}\n`,
  );
  await fs.writeFile(
    outputFile,
    `${JSON.stringify(record('u1', null, 'user', 'initial prompt'))}\n`,
  );

  let taskStatus: 'paused' | 'completed' = 'paused';
  const runtime = {
    workspaceId: 'workspace-paused',
    workspaceCwd,
    sessionRuntimeBaseDir: runtimeBaseDir,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: {
      getSessionTasksStatus: async () => ({
        v: 1 as const,
        sessionId: parentSessionId,
        now: Date.now(),
        tasks: [
          {
            kind: 'agent' as const,
            id: 'agent-paused',
            label: 'paused agent',
            description: 'paused agent',
            status: taskStatus,
            startTime: 1_000,
            runtimeMs: 4_500,
            stats: {
              durationMs: 4_500,
              toolUses: 6,
              totalTokens: 950,
            },
            outputFile,
            isBackgrounded: true,
            toolUseId: toolCallId,
          },
        ],
      }),
    },
  } as unknown as WorkspaceRuntime;

  const sessions = new VirtualSubagentSessions();
  const pausedResolved = await sessions.resolve(
    runtime,
    parentSessionId,
    toolCallId,
  );
  expect(pausedResolved).toMatchObject({
    status: 'paused',
    durationMs: 4_500,
    toolCalls: 6,
    totalTokens: 950,
    inputTokens: 200,
    outputTokens: 100,
  });

  taskStatus = 'completed';
  const completedResolved = await sessions.resolve(
    runtime,
    parentSessionId,
    toolCallId,
  );
  expect(completedResolved).toMatchObject({
    status: 'completed',
    durationMs: 4_500,
    toolCalls: 6,
    totalTokens: 950,
  });
});

it('flushes new canonical transcript records to active subscribers when a completed subagent completes a fast follow-up turn', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-fast-followup-'));
  tempDirs.push(dir);
  const outputFile = path.join(dir, 'agent.jsonl');
  await fs.writeFile(
    outputFile,
    `${JSON.stringify(record('u1', null, 'user', 'turn 1 prompt'))}\n${JSON.stringify(
      record('a1', 'u1', 'assistant', 'turn 1 answer'),
    )}\n`,
  );

  const runtime = {
    workspaceId: 'workspace-fast-followup',
    workspaceCwd: '/workspace',
    sessionRuntimeBaseDir: Storage.getRuntimeBaseDir(),
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: {
      getSessionTasksStatus: async () => ({
        v: 1 as const,
        sessionId: 'parent-session',
        now: Date.now(),
        tasks: [
          {
            kind: 'agent' as const,
            id: 'agent-fast',
            label: 'fast agent',
            description: 'fast agent',
            status: 'completed' as const,
            startTime: 1_000,
            runtimeMs: 500,
            outputFile,
            isBackgrounded: true,
            toolUseId: 'call-fast',
          },
        ],
      }),
    },
  } as unknown as WorkspaceRuntime;

  const sessions = new VirtualSubagentSessions();
  const resolved = await sessions.resolve(
    runtime,
    'parent-session',
    'call-fast',
  );
  const loaded = await sessions.load(runtime, resolved!.sessionId);
  const abort = new AbortController();
  const stream = await sessions.subscribe(runtime, resolved!.sessionId, {
    signal: abort.signal,
    lastEventId: loaded!.lastEventId,
  });
  const iterator = stream![Symbol.asyncIterator]();
  expect((await iterator.next()).value?.type).toBe('replay_complete');

  await fs.appendFile(
    outputFile,
    `${JSON.stringify(record('u2', 'a1', 'user', 'turn 2 follow-up'))}\n${JSON.stringify(
      record('a2', 'u2', 'assistant', 'turn 2 fast reply'),
    )}\n`,
  );

  // Even though status was 'completed' before and is already 'completed' again
  // when resolve() runs after messageSessionTask, updateStatus('completed')
  // flushes the new turn to the active subscriber.
  await sessions.resolve(runtime, 'parent-session', 'call-fast');

  const userUpdate = await iterator.next();
  const assistantUpdate = await iterator.next();
  abort.abort();
  await iterator.return?.();

  expect(JSON.stringify(userUpdate.value)).toContain('turn 2 follow-up');
  expect(JSON.stringify(assistantUpdate.value)).toContain('turn 2 fast reply');
});

it('streams live chunks on follow-up resident turns when START rotates streamRunId and truncates .stream', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-resident-stream-'));
  tempDirs.push(dir);
  const outputFile = path.join(dir, 'agent-resident.jsonl');
  const emitter = new AgentEventEmitter();
  const { cleanup } = attachJsonlTranscriptWriter(emitter, outputFile, {
    agentId: 'agent-resident',
    sessionId: 'parent-session',
    cwd: '/workspace',
    version: '1.0.0',
    initialUserPrompt: 'turn 1 prompt',
  });

  let taskStatus: 'running' | 'completed' = 'running';
  const runtime = {
    workspaceId: 'workspace-resident',
    workspaceCwd: '/workspace',
    sessionRuntimeBaseDir: Storage.getRuntimeBaseDir(),
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: {
      getSessionTasksStatus: async () => ({
        v: 1 as const,
        sessionId: 'parent-session',
        now: Date.now(),
        tasks: [
          {
            kind: 'agent' as const,
            id: 'agent-resident',
            label: 'resident agent',
            description: 'resident agent',
            status: taskStatus,
            startTime: 1_000,
            runtimeMs: 100,
            outputFile,
            isBackgrounded: true,
            toolUseId: 'call-resident',
          },
        ],
      }),
    },
  } as unknown as WorkspaceRuntime;

  try {
    const sessions = new VirtualSubagentSessions();
    const resolved = await sessions.resolve(
      runtime,
      'parent-session',
      'call-resident',
    );
    const loaded = await sessions.load(runtime, resolved!.sessionId);
    const abort = new AbortController();
    const stream = await sessions.subscribe(runtime, resolved!.sessionId, {
      signal: abort.signal,
      lastEventId: loaded!.lastEventId,
    });
    const iterator = stream![Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('replay_complete');

    // Turn 1 starts at round 0
    emitter.emit(AgentEventType.START, {
      subagentId: 'agent-resident',
      name: 'general-purpose',
      model: 'test-model',
      tools: ['*'],
      timestamp: 10,
    });
    emitter.emit(AgentEventType.STREAM_TEXT, {
      subagentId: 'agent-resident',
      round: 0,
      text: `turn 1 streaming ${'a'.repeat(64 * 1024)}`,
      thought: false,
      timestamp: 11,
    });
    await activeTarget(sessions).refreshLive();
    const turn1Streamed = await iterator.next();
    expect(JSON.stringify(turn1Streamed.value)).toContain('turn 1 streaming');

    emitter.emit(AgentEventType.ROUND_TEXT, {
      subagentId: 'agent-resident',
      round: 0,
      text: `turn 1 streaming ${'a'.repeat(64 * 1024)}`,
      thoughtText: '',
      timestamp: 12,
    });
    emitter.emit(AgentEventType.FINISH, {
      subagentId: 'agent-resident',
      terminateReason: 'GOAL' as never,
      timestamp: 13,
      rounds: 1,
      totalDurationMs: 10,
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
    });
    taskStatus = 'completed';
    await sessions.resolve(runtime, 'parent-session', 'call-resident');
    const turn1Complete = await iterator.next();
    expect(turn1Complete.value).toMatchObject({ type: 'turn_complete' });

    // Resident continuation (Turn 2) starts at round 0 again
    taskStatus = 'running';
    await sessions.resolve(runtime, 'parent-session', 'call-resident');
    emitter.emit(AgentEventType.EXTERNAL_MESSAGE, {
      subagentId: 'agent-resident',
      kind: 'message',
      text: 'turn 2 prompt',
      timestamp: 20,
    });
    emitter.emit(AgentEventType.START, {
      subagentId: 'agent-resident',
      name: 'general-purpose',
      model: 'test-model',
      tools: ['*'],
      timestamp: 21,
    });
    emitter.emit(AgentEventType.STREAM_TEXT, {
      subagentId: 'agent-resident',
      round: 0,
      text: `turn 2 live delta ${'b'.repeat(64 * 1024)}`,
      thought: false,
      timestamp: 22,
    });
    await activeTarget(sessions).refreshLive();

    const turn2User = await iterator.next();
    const turn2Streamed = await iterator.next();
    expect(JSON.stringify(turn2User.value)).toContain('turn 2 prompt');
    expect(JSON.stringify(turn2Streamed.value)).toContain('turn 2 live delta');

    abort.abort();
    await iterator.return?.();
  } finally {
    cleanup();
  }
});

it('refreshes cached target status on getTarget, emits terminal events on updateTargetStatus, and stops pollTimer when .meta.json completes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-subagent-status-'));
  tempDirs.push(dir);
  const outputFile = path.join(dir, 'agent-status.jsonl');
  const metaPath = path.join(dir, 'agent-status.meta.json');
  await fs.writeFile(
    outputFile,
    `${JSON.stringify(record('u1', null, 'user', 'run task'))}\n`,
  );
  await fs.writeFile(
    metaPath,
    JSON.stringify({
      agentId: 'agent-status',
      agentType: 'general-purpose',
      description: 'status test',
      parentSessionId: 'parent-session',
      parentAgentId: null,
      createdAt: new Date(1_000).toISOString(),
      status: 'running',
    }),
  );

  let liveStatus: 'running' | 'completed' | 'failed' | 'cancelled' = 'running';
  const runtime = {
    workspaceId: 'workspace-status-496',
    workspaceCwd: '/workspace',
    sessionRuntimeBaseDir: Storage.getRuntimeBaseDir(),
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: {
      getSessionTasksStatus: async () => ({
        v: 1 as const,
        sessionId: 'parent-session',
        now: Date.now(),
        tasks: [
          {
            kind: 'agent' as const,
            id: 'agent-status',
            label: 'status test',
            description: 'status test',
            status: liveStatus,
            startTime: 1_000,
            runtimeMs: 100,
            outputFile,
            isBackgrounded: true,
            toolUseId: 'call-status',
          },
        ],
      }),
    },
  } as unknown as WorkspaceRuntime;

  const sessions = new VirtualSubagentSessions();
  const sessionId = createVirtualSubagentSessionId(
    'parent-session',
    'agent-status',
  );

  // 1. Initial load caches target as running
  const firstLoad = await sessions.load(runtime, sessionId);
  expect(firstLoad?.hasActivePrompt).toBe(true);

  // 2. Without calling resolve(), liveStatus transitions to completed; load() via getTarget() refreshes status
  liveStatus = 'completed';
  const secondLoad = await sessions.load(runtime, sessionId);
  expect(secondLoad?.hasActivePrompt).toBe(false);

  // 3. Subscribe while running and verify pollTimer transitions status automatically when .meta.json completes
  liveStatus = 'running';
  await sessions.resolve(runtime, 'parent-session', 'call-status');
  const abort = new AbortController();
  const stream = await sessions.subscribe(runtime, sessionId, {
    signal: abort.signal,
    lastEventId: secondLoad!.lastEventId,
  });
  const iterator = stream![Symbol.asyncIterator]();
  expect((await iterator.next()).value?.type).toBe('replay_complete');

  await fs.writeFile(
    metaPath,
    JSON.stringify({
      agentId: 'agent-status',
      agentType: 'general-purpose',
      description: 'status test',
      parentSessionId: 'parent-session',
      parentAgentId: null,
      createdAt: new Date(1_000).toISOString(),
      status: 'completed',
    }),
  );
  // Wait for 250ms pollTimer to detect .meta.json completion and emit turn_complete
  const autoComplete = await iterator.next();
  expect(autoComplete.value).toMatchObject({
    type: 'turn_complete',
    data: {
      sessionId,
      stopReason: 'end_turn',
    },
  });
  expect((await sessions.load(runtime, sessionId))?.hasActivePrompt).toBe(
    false,
  );

  // 4. Verify failed and cancelled terminal events via updateTargetStatus
  await fs.writeFile(
    metaPath,
    JSON.stringify({
      agentId: 'agent-status',
      agentType: 'general-purpose',
      description: 'status test',
      parentSessionId: 'parent-session',
      parentAgentId: null,
      createdAt: new Date(1_000).toISOString(),
      status: 'running',
    }),
  );
  sessions.updateTargetStatus(runtime, sessionId, 'running');
  sessions.updateTargetStatus(runtime, sessionId, 'failed');
  const errorEvent = await iterator.next();
  expect(errorEvent.value).toMatchObject({
    type: 'turn_error',
    data: {
      sessionId,
      message: 'Subagent failed',
    },
  });

  sessions.updateTargetStatus(runtime, sessionId, 'running');
  sessions.updateTargetStatus(runtime, sessionId, 'cancelled');
  const cancelledEvent = await iterator.next();
  expect(cancelledEvent.value).toMatchObject({
    type: 'prompt_cancelled',
    data: {
      sessionId,
      reason: 'cancelled',
    },
  });

  abort.abort();
  await iterator.return?.();
});
