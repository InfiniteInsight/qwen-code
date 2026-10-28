/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { AgentRegistry } from '../agents/agentRegistry.js';
import type { SessionDaemon } from '../daemonPool.js';
import { SessionSpawner } from './sessionSpawner.js';

let stub: StubDaemon | undefined;
afterEach(async () => {
  if (stub) await stub.close();
  stub = undefined;
});

/**
 * A daemon built by hand rather than the HTTP stub, because these guards are
 * about ORDER and about calls the stub cannot observe (which session got a
 * DELETE, how many times a prompt was sent). The stub replays its frames on
 * every /events request, so it can never show that a subscription opened too
 * late missed the turn; this can.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface FakeDaemonOptions {
  frames?: Array<{ type: string; data?: unknown }>;
  /** Keep the stream open after the frames until the subscriber aborts. */
  holdAfterFrames?: boolean;
  /** Hold createOrAttachSession open until the test releases the gate. */
  createGate?: Promise<void>;
  /** Reject prompt() with this error. */
  promptError?: Error;
}

function makeFakeDaemon(opts: FakeDaemonOptions) {
  const calls: string[] = [];
  const closed: string[] = [];
  const promptSignals: Array<AbortSignal | undefined> = [];
  const raw = {
    calls,
    closed,
    promptSignals,
    createOrAttachSession: async () => {
      calls.push('create');
      if (opts.createGate) await opts.createGate;
      return { sessionId: 's-1' };
    },
    subscribeEvents: (_sessionId: string, o?: { signal?: AbortSignal }) => {
      calls.push('subscribe');
      return (async function* gen() {
        for (const f of opts.frames ?? []) yield f;
        if (opts.holdAfterFrames) {
          await new Promise<void>((resolve) => {
            if (o?.signal?.aborted) {
              resolve();
              return;
            }
            o?.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        }
      })();
    },
    prompt: async (_sessionId: string, _req: unknown, signal?: AbortSignal) => {
      calls.push('prompt');
      promptSignals.push(signal);
      if (opts.promptError) throw opts.promptError;
      return { stopReason: 'end_turn' };
    },
    closeSession: async (sessionId: string) => {
      closed.push(sessionId);
    },
  };
  return { daemon: raw as unknown as SessionDaemon, state: raw };
}

/** One assistant text frame, shaped the way the runtime shapes it. */
const chunkFrame = (text: string, usage?: Record<string, unknown>) => ({
  type: 'session_update',
  data: {
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { text },
      ...(usage ? { _meta: { usage } } : {}),
    },
  },
});

const TURN_COMPLETE = { type: 'turn_complete', data: {} };

async function makeRegistry(dir: string) {
  return AgentRegistry.open(join(dir, 'agents.json'));
}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
} as const;

describe('SessionSpawner', () => {
  it('spawns a real session per agent and tags workflowRunId', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const map: Array<{ agentId: string; sessionId: string }> = [];
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
      onAgentSpawned: (agentId, sessionId) => map.push({ agentId, sessionId }),
    });
    const out = await spawner.spawn({
      prompt: 'do a thing',
      systemContext: '',
    });
    expect(typeof out.tokens).toBe('number');
    expect(map).toHaveLength(1);
    expect(registry.list({ workflowRunId: 'run-1' })).toHaveLength(1);
    expect(stub!.createdSessionCount).toBe(1);
  });

  it('prepends systemContext to the prompt text sent to the daemon', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    const distinctiveSystemContext = 'YOU ARE A DISTINCTIVE SYSTEM PROMPT';
    await spawner.spawn({
      prompt: 'do a thing',
      systemContext: distinctiveSystemContext,
    });
    const body = stub.lastPromptBody as {
      prompt: Array<{ type: string; text: string }>;
    };
    expect(body.prompt[0]!.text).toContain(distinctiveSystemContext);
    expect(body.prompt[0]!.text).toContain('do a thing');
  });

  it('does not add spurious whitespace when systemContext is empty', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    await spawner.spawn({ prompt: 'do a thing', systemContext: '' });
    const body = stub.lastPromptBody as {
      prompt: Array<{ type: string; text: string }>;
    };
    expect(body.prompt[0]!.text).toBe('do a thing');
  });

  it('passes req.cwd through as workspaceCwd on session creation', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    await spawner.spawn({
      prompt: 'do a thing',
      systemContext: '',
      cwd: '/some/workspace',
    });
    const body = stub.lastCreateSessionBody as { cwd?: string };
    expect(body.cwd).toBe('/some/workspace');
  });

  it('does not send a workspaceCwd when req.cwd is not provided', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    await spawner.spawn({ prompt: 'do a thing', systemContext: '' });
    const body = stub.lastCreateSessionBody as { cwd?: string };
    expect(body.cwd).toBeUndefined();
  });

  it('forwards req.signal through to daemon.prompt for built-in cancellation', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const promptSpy = vi.spyOn(daemon, 'prompt');
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    const controller = new AbortController();
    await spawner.spawn({
      prompt: 'do a thing',
      systemContext: '',
      signal: controller.signal,
    });
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy.mock.calls[0]![2]).toBe(controller.signal);
  });

  it('returns the reply streamed as agent_message_chunk frames', async () => {
    // The regression this guards: prompt() answers { stopReason } only, so the
    // old reader returned '' for every real turn and a workflow agent looked
    // like it had said nothing at all.
    stub = await startStubDaemon({
      frames: [
        { id: 1, ...chunkFrame('Hello ') },
        { id: 2, ...chunkFrame('world') },
        { id: 3, ...TURN_COMPLETE },
      ],
    });
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await makeRegistry(dir);
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    const out = await spawner.spawn({ prompt: 'say hi', systemContext: '' });
    expect(out.text).toBe('Hello world');
  });

  it('opens the event subscription before the prompt is sent', async () => {
    // Order is the whole fix. A reader attached after prompt() resolves sees a
    // turn that already happened, which is why the frames have to be subscribed
    // for first.
    const { daemon, state } = makeFakeDaemon({
      frames: [chunkFrame('hi'), TURN_COMPLETE],
    });
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await makeRegistry(dir);
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    await spawner.spawn({ prompt: 'say hi', systemContext: '' });
    expect(state.calls).toEqual(['create', 'subscribe', 'prompt']);
  });

  it('prices the turn off the agent_message_chunk usage locus', async () => {
    const { daemon } = makeFakeDaemon({
      frames: [
        chunkFrame('partial'),
        chunkFrame(' rest', { inputTokens: 10, outputTokens: 5 }),
        TURN_COMPLETE,
      ],
    });
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await makeRegistry(dir);
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    const out = await spawner.spawn({ prompt: 'say hi', systemContext: '' });
    expect(out.tokens).toBe(15);
  });

  it('settles the registry record as completed', async () => {
    // Nothing used to call setStatus, so every workflow agent stayed `running`
    // forever and reconciliation could only ever call it orphaned.
    const { daemon } = makeFakeDaemon({
      frames: [chunkFrame('done'), TURN_COMPLETE],
    });
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await makeRegistry(dir);
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    await spawner.spawn({ prompt: 'say hi', systemContext: '' });
    expect(registry.list({ workflowRunId: 'run-1' })[0]?.status).toBe(
      'completed',
    );
  });

  it('closes the session on the success path, not only on cancel', async () => {
    const { daemon, state } = makeFakeDaemon({
      frames: [chunkFrame('done'), TURN_COMPLETE],
    });
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await makeRegistry(dir);
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    await spawner.spawn({ prompt: 'say hi', systemContext: '' });
    expect(state.closed).toEqual(['s-1']);
  });

  it('closes the session exactly once when the turn also fails', async () => {
    const { daemon, state } = makeFakeDaemon({
      promptError: new Error('boom'),
    });
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await makeRegistry(dir);
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    await expect(
      spawner.spawn({ prompt: 'say hi', systemContext: '' }),
    ).rejects.toThrow('boom');
    expect(state.closed).toEqual(['s-1']);
    expect(registry.list({ workflowRunId: 'run-1' })[0]?.status).toBe('failed');
  });

  it('retries a schema-invalid reply and settles the record as failed', async () => {
    const { daemon, state } = makeFakeDaemon({
      frames: [chunkFrame('not json at all'), TURN_COMPLETE],
    });
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await makeRegistry(dir);
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    await expect(
      spawner.spawn({
        prompt: 'answer',
        systemContext: '',
        schema: ANSWER_SCHEMA,
      }),
    ).rejects.toThrow(/schema validation failed after 3 attempts/);
    expect(state.calls.filter((c) => c === 'prompt')).toHaveLength(3);
    expect(registry.list({ workflowRunId: 'run-1' })[0]?.status).toBe('failed');
  });

  it('returns the structured value once a streamed reply validates', async () => {
    const { daemon } = makeFakeDaemon({
      frames: [chunkFrame('{"answer":"ok"}'), TURN_COMPLETE],
    });
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await makeRegistry(dir);
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    const out = await spawner.spawn({
      prompt: 'answer',
      systemContext: '',
      schema: ANSWER_SCHEMA,
    });
    expect(out.structured).toEqual({ answer: 'ok' });
  });

  it('closes the session created during a cancel, and settles it cancelled', async () => {
    // The window that leaked: the handler used to be attached after both awaits,
    // so a cancel landing here closed nothing.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { daemon, state } = makeFakeDaemon({ createGate: gate });
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await makeRegistry(dir);
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    const controller = new AbortController();
    const running = spawner.spawn({
      prompt: 'say hi',
      systemContext: '',
      signal: controller.signal,
    });
    await sleep(10);
    controller.abort();
    await sleep(10);
    release();
    await expect(running).rejects.toThrow('workflow cancelled');
    expect(state.closed).toEqual(['s-1']);
    expect(registry.list({ workflowRunId: 'run-1' })[0]?.status).toBe(
      'cancelled',
    );
  });

  it('never creates a session for a signal that already fired', async () => {
    // An already-aborted signal never runs the listener, so this had to be read
    // directly rather than only handled by the handler.
    const { daemon, state } = makeFakeDaemon({ frames: [] });
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await makeRegistry(dir);
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      spawner.spawn({
        prompt: 'say hi',
        systemContext: '',
        signal: controller.signal,
      }),
    ).rejects.toThrow('workflow cancelled before the session was created');
    expect(state.calls).toEqual([]);
    expect(stub?.createdSessionCount).toBeUndefined();
  });

  it('returns the collected text when a turn never puts turn_complete on the stream', async () => {
    // Bounded by TURN_DRAIN_GRACE_MS rather than hanging: a daemon that ends a
    // turn without that frame must not wedge the workflow. This test waits out
    // the grace, so it is slow by design.
    const { daemon } = makeFakeDaemon({
      frames: [chunkFrame('some answer')],
      holdAfterFrames: true,
    });
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await makeRegistry(dir);
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    const out = await spawner.spawn({ prompt: 'say hi', systemContext: '' });
    expect(out.text).toBe('some answer');
  });
});
