/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { RequestError } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
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
});
