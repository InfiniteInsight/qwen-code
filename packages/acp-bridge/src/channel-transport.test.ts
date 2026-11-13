/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { RequestError } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpSessionBridge } from './bridgeTypes.js';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import { _sessionEntryForTest } from './session-control-plane.js';
import {
  BridgeChannelClosedError,
  BridgeTimeoutError,
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
} from './status.js';

describe('channel transport', () => {
  it('forces a hanging teardown at the configured deadline and retains its failure', async () => {
    vi.useFakeTimers();
    const handle = makeChannel();
    const cleanup = handle.channel.kill;
    let release!: () => void;
    const killing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const kill = vi.fn(() => killing);
    const killSync = vi.fn();
    handle.channel = { ...handle.channel, kill, killSync };
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      initializeTimeoutMs: 40,
    });

    try {
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const shutdown = bridge.shutdown();
      const result = shutdown.catch((error: unknown) => error);
      expect(kill).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(39);
      expect(killSync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      const error = await result;
      expect(error).toBeInstanceOf(BridgeTimeoutError);
      expect(error).toMatchObject({
        label: 'bridge shutdown teardown',
        timeoutMs: 40,
      });
      expect(killSync).toHaveBeenCalledOnce();
      expect(bridge.shutdown()).toBe(shutdown);
      release();
      await expect(bridge.shutdown()).rejects.toBe(error);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      await cleanup();
      vi.useRealTimers();
    }
  });

  it.each(['reject', 'throw'])(
    'preserves both failures when kill and killSync fail (%s)',
    async (failureMode) => {
      const handle = makeChannel();
      const cleanup = handle.channel.kill;
      const failure = new Error('graceful teardown failed');
      const forceFailure = new Error('forced teardown failed');
      const kill = vi.fn(() => {
        if (failureMode === 'throw') throw failure;
        return Promise.reject(failure);
      });
      const killSync = vi.fn(() => {
        throw forceFailure;
      });
      handle.channel = { ...handle.channel, kill, killSync };
      const bridge = makeBridge({ channelFactory: async () => handle.channel });

      try {
        await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        const error = await bridge
          .shutdown()
          .catch((reason: unknown) => reason);
        expect(kill).toHaveBeenCalledOnce();
        expect(killSync).toHaveBeenCalledOnce();
        expect(error).toBeInstanceOf(AggregateError);
        expect(error).toMatchObject({
          message: 'ACP channel teardown failed (bridge shutdown)',
          errors: [failure, forceFailure],
        });
        await expect(bridge.shutdown()).rejects.toBe(error);
      } finally {
        await cleanup();
      }
    },
  );

  it('maps rejected transport failure to channel-closed before process exit', async () => {
    let rejectTransport!: (error: Error) => void;
    const transportFailed = new Promise<unknown>((_resolve, reject) => {
      rejectTransport = reject;
    });
    let startPrompt!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      startPrompt = resolve;
    });
    let finishPrompt!: (result: { stopReason: 'end_turn' }) => void;
    const promptResult = new Promise<{ stopReason: 'end_turn' }>((resolve) => {
      finishPrompt = resolve;
    });
    const handle = makeChannel({
      promptImpl: () => {
        startPrompt();
        return promptResult;
      },
    });
    handle.channel = { ...handle.channel, transportFailed };
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const exited = vi.fn();
    void handle.channel.exited.then(exited);

    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const result = bridge
        .sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'wait for transport failure' }],
        })
        .catch((error: unknown) => error);
      await promptStarted;
      rejectTransport(new Error('raw transport failure'));

      const error = await result;
      expect(error).toBeInstanceOf(BridgeChannelClosedError);
      expect(error).toMatchObject({
        context: `mid-request (session ${session.sessionId})`,
      });
      expect(exited).not.toHaveBeenCalled();
      expect(handle.killed).toBe(false);
    } finally {
      finishPrompt({ stopReason: 'end_turn' });
      await bridge.shutdown();
    }
  });
});

/** Collects garbage until every target is gone; returns how many survive. */
async function survivorsAfterGc(refs: Array<WeakRef<object>>) {
  v8.setFlagsFromString('--expose_gc');
  const gc = runInNewContext('gc') as () => void;
  // deref() keeps its target alive until the current job ends, so collect
  // in a job that has not dereferenced anything.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  let alive = refs.length;
  for (let attempt = 0; attempt < 10 && alive > 0; attempt++) {
    await tick();
    gc();
    await tick();
    alive = refs.filter((ref) => ref.deref() !== undefined).length;
  }
  return alive;
}

/** Resolves once the fake agent has received `count` calls of `method`. */
function agentCalls(
  handle: ReturnType<typeof makeChannel>,
  method: string,
  count: number,
): Promise<void> {
  return vi.waitFor(
    () => {
      expect(
        handle.agent.extMethodCalls.filter((call) => call.method === method),
      ).toHaveLength(count);
    },
    { interval: 5 },
  );
}

describe('session requests racing the transport-closed rejection', () => {
  const CONTEXT = SERVE_STATUS_EXT_METHODS.sessionContext;
  const SOURCE = SERVE_CONTROL_EXT_METHODS.sessionSource;

  // The bridge logs its reaper start and the child exit; keep the run quiet.
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const waiterCount = (bridge: AcpSessionBridge, sessionId: string) =>
    _sessionEntryForTest(bridge, sessionId)?.transportClosedFanout?.waiters
      .size;

  it('settles with the agent reply or the agent error', async () => {
    let fail = false;
    const handle = makeChannel({
      extMethodImpl: (method, params) => {
        if (method !== CONTEXT) return {};
        if (fail) throw RequestError.invalidParams(undefined, 'no context');
        return { v: 1, sessionId: params['sessionId'], marker: 'reply' };
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });

    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await expect(
        bridge.getSessionContextStatus(session.sessionId),
      ).resolves.toEqual({
        v: 1,
        sessionId: session.sessionId,
        marker: 'reply',
      });

      fail = true;
      const error = await bridge
        .getSessionContextStatus(session.sessionId)
        .catch((reason: unknown) => reason);
      expect(error).not.toBeInstanceOf(BridgeChannelClosedError);
      expect(error).toMatchObject({
        code: -32602,
        message: 'Invalid params: no context',
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it('rejects every pending request with the session channel-closed error when the child exits', async () => {
    const handle = makeChannel({
      extMethodImpl: (method) =>
        method === CONTEXT ? new Promise(() => {}) : {},
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });

    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const pending = [1, 2, 3].map(() =>
        bridge
          .getSessionContextStatus(session.sessionId)
          .catch((reason: unknown) => reason),
      );
      await agentCalls(handle, CONTEXT, 3);
      handle.crash({ exitCode: 1, signalCode: null });

      for (const error of await Promise.all(pending)) {
        expect(error).toBeInstanceOf(BridgeChannelClosedError);
        expect(error).toMatchObject({
          message: `agent channel closed mid-request (session ${session.sessionId})`,
          context: `mid-request (session ${session.sessionId})`,
        });
      }
    } finally {
      await bridge.shutdown();
    }
  });

  it('rejects a request started after the transport failed without waiting for the agent', async () => {
    let rejectTransport!: (error: Error) => void;
    const transportFailed = new Promise<unknown>((_resolve, reject) => {
      rejectTransport = reject;
    });
    const handle = makeChannel({
      extMethodImpl: (method) =>
        method === CONTEXT || method === SOURCE ? new Promise(() => {}) : {},
    });
    handle.channel = { ...handle.channel, transportFailed };
    const bridge = makeBridge({ channelFactory: async () => handle.channel });

    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const first = bridge
        .getSessionContextStatus(session.sessionId)
        .catch((reason: unknown) => reason);
      await agentCalls(handle, CONTEXT, 1);
      rejectTransport(new Error('raw transport failure'));
      expect(await first).toBeInstanceOf(BridgeChannelClosedError);

      const late = bridge.ensureDefaultSessionPersisted!(
        session.sessionId,
      ).catch((reason: unknown) => reason);
      // Microtasks drain before an immediate, so a request that has to wait
      // for the agent (which never answers) is still pending here.
      const outcome = await Promise.race([
        late,
        new Promise((resolve) => setImmediate(() => resolve('pending'))),
      ]);
      expect(outcome).toBeInstanceOf(BridgeChannelClosedError);
      expect(outcome).toMatchObject({
        message: `agent channel closed mid-request (session ${session.sessionId})`,
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it('leaves no waiter behind after 1,000 settled requests on a live session', async () => {
    let calls = 0;
    let hold = false;
    let release!: () => void;
    const held = new Promise<Record<string, unknown>>((resolve) => {
      release = () => resolve({ held: true });
    });
    const handle = makeChannel({
      extMethodImpl: (method) => {
        if (method !== CONTEXT) return {};
        if (hold) return held;
        calls += 1;
        if (calls % 2 === 0) {
          throw RequestError.internalError(undefined, 'every second call');
        }
        return { v: 1, call: calls };
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });

    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const id = session.sessionId;
      const outcomes = await Promise.allSettled(
        Array.from({ length: 1000 }, () => bridge.getSessionContextStatus(id)),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(
        500,
      );
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(500);
      expect(waiterCount(bridge, id)).toBe(0);

      // The count is live, not vacuously zero: a pending request is in it.
      hold = true;
      const pending = bridge.getSessionContextStatus(id);
      expect(waiterCount(bridge, id)).toBe(1);
      release();
      await expect(pending).resolves.toEqual({ held: true });
      expect(waiterCount(bridge, id)).toBe(0);
    } finally {
      await bridge.shutdown();
    }
  });

  it('lets the replies of settled requests be collected while the session lives', async () => {
    const handle = makeChannel({
      extMethodImpl: (method, params) =>
        method === CONTEXT
          ? { v: 1, sessionId: params['sessionId'], body: 'x'.repeat(4096) }
          : {},
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    // Only the WeakRef leaves this frame, so the test itself holds no reply.
    const replyRef = async (
      target: AcpSessionBridge,
      sessionId: string,
    ): Promise<WeakRef<object>> =>
      new WeakRef(
        (await target.getSessionContextStatus(sessionId)) as unknown as object,
      );

    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const refs: Array<WeakRef<object>> = [];
      for (let i = 0; i < 200; i++) {
        refs.push(await replyRef(bridge, session.sessionId));
      }
      // The ACP SDK's read loop holds the most recent message until the next
      // one arrives; one more request moves that hold off the tracked replies.
      await bridge.getSessionContextStatus(session.sessionId);
      expect(await survivorsAfterGc(refs)).toBe(0);
    } finally {
      await bridge.shutdown();
    }
  });

  it('does not keep a closed session reachable while its channel lives', async () => {
    const handle = makeChannel({
      extMethodImpl: (method) =>
        method === SERVE_CONTROL_EXT_METHODS.sessionClose
          ? { closed: true }
          : {},
    });
    const channelFactory = vi.fn(async () => handle.channel);
    const bridge = makeBridge({ channelFactory });
    // Only the WeakRef leaves this frame, so the test itself holds no entry.
    const entryRef = (sessionId: string): WeakRef<object> =>
      new WeakRef(_sessionEntryForTest(bridge, sessionId)!);

    try {
      const anchor = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const closing = await bridge.spawnOrAttach({
        workspaceCwd: WS_A,
        sessionScope: 'thread',
      });
      expect(closing.sessionId).not.toBe(anchor.sessionId);
      // Both sessions share the one channel, which outlives the closed one.
      expect(channelFactory).toHaveBeenCalledOnce();
      // Arm the closing session's fan-out on the shared channel.
      await bridge.getSessionContextStatus(closing.sessionId);
      const ref = entryRef(closing.sessionId);
      await bridge.closeSession(closing.sessionId);
      // Move the SDK read loop's last-message hold off the closed session.
      await bridge.getSessionContextStatus(anchor.sessionId);
      expect(bridge.sessionCount).toBe(1);
      expect(handle.killed).toBe(false);

      expect(await survivorsAfterGc([ref])).toBe(0);
    } finally {
      await bridge.shutdown();
    }
  });
});

describe('channel requests racing the channel-unavailable rejection', () => {
  const TOOLS = SERVE_STATUS_EXT_METHODS.workspaceTools;
  const TRANSCRIPT = SERVE_STATUS_EXT_METHODS.sessionTranscript;
  const ARTIFACTS = SERVE_CONTROL_EXT_METHODS.sessionArtifactsPersist;

  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('settles workspace-scope requests, and rejects them with the workspace channel-closed error when the child exits', async () => {
    let hang = false;
    const handle = makeChannel({
      extMethodImpl: (method) => {
        if (method !== TOOLS && method !== TRANSCRIPT) return {};
        if (hang) return new Promise(() => {});
        return { v: 1, marker: method };
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const page = (sessionId: string) =>
      bridge.getSessionTranscriptPage({
        sessionId,
        direction: 'backward',
        limit: 1,
      });

    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await expect(bridge.getWorkspaceToolsStatus()).resolves.toMatchObject({
        marker: TOOLS,
      });
      await expect(page(session.sessionId)).resolves.toMatchObject({
        marker: TRANSCRIPT,
      });

      hang = true;
      const pending = [
        bridge.getWorkspaceToolsStatus(),
        page(session.sessionId),
      ].map((request) => request.catch((reason: unknown) => reason));
      await agentCalls(handle, TOOLS, 2);
      await agentCalls(handle, TRANSCRIPT, 2);
      handle.crash({ exitCode: 1, signalCode: null });

      for (const error of await Promise.all(pending)) {
        expect(error).toBeInstanceOf(BridgeChannelClosedError);
        expect(error).toMatchObject({
          message: 'agent channel closed mid-request (workspace status)',
        });
      }
    } finally {
      await bridge.shutdown();
    }
  });

  it('rejects a restore with the restore channel-closed error when the child exits mid-load', async () => {
    const handle = makeChannel({
      loadSessionImpl: () => new Promise(() => {}),
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });

    try {
      const loading = bridge
        .loadSession({
          sessionId: 'persisted-mid-load',
          workspaceCwd: WS_A,
          suppressWorktreeContextRestore: true,
        })
        .catch((reason: unknown) => reason);
      await vi.waitFor(
        () => expect(handle.agent.loadSessionCalls).toHaveLength(1),
        { interval: 5 },
      );
      handle.crash({ exitCode: 1, signalCode: null });

      const error = await loading;
      expect(error).toBeInstanceOf(BridgeChannelClosedError);
      expect(error).toMatchObject({
        message: 'agent channel closed during session/load',
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it('rejects a session create with the newSession channel-closed error when the child exits', async () => {
    const handle = makeChannel({
      newSessionImpl: (p, self) =>
        self.newSessionCalls.length > 1
          ? new Promise(() => {})
          : { sessionId: `sess:${p.cwd}` },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });

    try {
      await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const creating = bridge
        .spawnOrAttach({ workspaceCwd: WS_A, sessionScope: 'thread' })
        .catch((reason: unknown) => reason);
      await vi.waitFor(
        () => expect(handle.agent.newSessionCalls).toHaveLength(2),
        { interval: 5 },
      );
      handle.crash({ exitCode: 1, signalCode: null });

      const error = await creating;
      expect(error).toBeInstanceOf(BridgeChannelClosedError);
      expect(error).toMatchObject({
        message: 'agent channel closed during newSession',
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it('cuts off an artifact write when the child exits instead of waiting out its timeout', async () => {
    let hang = false;
    const handle = makeChannel({
      extMethodImpl: (method) =>
        method === ARTIFACTS && hang ? new Promise(() => {}) : {},
    });
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      initializeTimeoutMs: 60_000,
    });

    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      hang = true;
      const writing = bridge.addSessionArtifact(
        session.sessionId,
        { title: 'cut off', url: 'https://example.com/cut-off' },
        { clientId: session.clientId },
      );
      await agentCalls(handle, ARTIFACTS, 1);
      handle.crash({ exitCode: 1, signalCode: null });

      const result = await writing;
      expect(result.changes[0]?.artifact).toMatchObject({
        retention: 'ephemeral',
        persistenceWarning: 'persistence_unavailable',
      });
      expect(result.warningDetails).toEqual([
        expect.objectContaining({ code: 'ARTIFACT_PERSISTENCE_UNAVAILABLE' }),
      ]);
    } finally {
      await bridge.shutdown();
    }
  });
});
