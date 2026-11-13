/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionNotFoundError } from './bridgeErrors.js';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import {
  BridgeChannelClosedError,
  SERVE_CONTROL_EXT_METHODS,
  type ServeSubagentAbandonResult,
  type ServeSubagentResumeResult,
} from './status.js';

const RESUME = SERVE_CONTROL_EXT_METHODS.sessionTaskResume;
const ABANDON = SERVE_CONTROL_EXT_METHODS.sessionTaskAbandon;

/**
 * #259: resume and abandon of a paused subagent reach the child's own resume
 * service. Both go through the bridge's session-status request, which races
 * the transport through `raceTransportClosed` (#258), so a child that dies
 * mid-request rejects instead of hanging.
 */
describe('subagent resume and abandon through the bridge', () => {
  async function setup(
    answer: (
      method: string,
      params: Record<string, unknown>,
    ) =>
      | Record<string, unknown>
      | Promise<Record<string, unknown>> = () => ({}),
  ) {
    const handle = makeChannel({ extMethodImpl: answer });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const callsTo = (method: string) =>
      handle.agent.extMethodCalls
        .filter((call) => call.method === method)
        .map((call) => call.params);
    return { bridge, handle, session, callsTo };
  }

  it('forwards a resume with its first instruction and returns the child answer', async () => {
    const resumed: ServeSubagentResumeResult = {
      outcome: 'resumed',
      status: 'running',
    };
    const { bridge, session, callsTo } = await setup((method) =>
      method === RESUME ? resumed : {},
    );
    try {
      await expect(
        bridge.resumeSessionTask!(
          session.sessionId,
          'agent-1',
          'pick up the TODO list',
          { clientId: session.clientId },
        ),
      ).resolves.toEqual(resumed);
      expect(callsTo(RESUME)).toEqual([
        {
          sessionId: session.sessionId,
          taskId: 'agent-1',
          message: 'pick up the TODO list',
        },
      ]);
    } finally {
      await bridge.shutdown();
    }
  });

  it('sends no message key for a resume without an instruction', async () => {
    const refused: ServeSubagentResumeResult = {
      outcome: 'refused',
      code: 'capacity_full',
      reason: 'maximum concurrent background agents (1) reached',
      status: 'paused',
    };
    const { bridge, session, callsTo } = await setup((method) =>
      method === RESUME ? refused : {},
    );
    try {
      await expect(
        bridge.resumeSessionTask!(session.sessionId, 'agent-1'),
      ).resolves.toEqual(refused);
      expect(callsTo(RESUME)).toEqual([
        { sessionId: session.sessionId, taskId: 'agent-1' },
      ]);
    } finally {
      await bridge.shutdown();
    }
  });

  it('forwards an abandon and returns the child answer', async () => {
    const abandoned: ServeSubagentAbandonResult = {
      outcome: 'abandoned',
      status: 'cancelled',
    };
    const { bridge, session, callsTo } = await setup((method) =>
      method === ABANDON ? abandoned : {},
    );
    try {
      await expect(
        bridge.abandonSessionTask!(session.sessionId, 'agent-1', {
          clientId: session.clientId,
        }),
      ).resolves.toEqual(abandoned);
      expect(callsTo(ABANDON)).toEqual([
        { sessionId: session.sessionId, taskId: 'agent-1' },
      ]);
    } finally {
      await bridge.shutdown();
    }
  });

  it.each([
    ['a resume', RESUME],
    ['an abandon', ABANDON],
  ] as const)(
    'rejects %s with channel-closed when the child exits mid-request',
    async (_label, method) => {
      const { bridge, handle, session, callsTo } = await setup((called) =>
        called === method ? new Promise(() => {}) : {},
      );
      try {
        const pending = (
          method === RESUME
            ? bridge.resumeSessionTask!(session.sessionId, 'agent-1')
            : bridge.abandonSessionTask!(session.sessionId, 'agent-1')
        ).catch((error: unknown) => error);
        await vi.waitFor(() => expect(callsTo(method)).toHaveLength(1), {
          interval: 5,
        });
        handle.crash({ exitCode: 1, signalCode: null });

        await expect(pending).resolves.toBeInstanceOf(BridgeChannelClosedError);
      } finally {
        await bridge.shutdown();
      }
    },
  );

  it('throws SessionNotFoundError for an unknown session', async () => {
    const { bridge, callsTo } = await setup();
    try {
      await expect(
        bridge.resumeSessionTask!('no-such-session', 'agent-1'),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      await expect(
        bridge.abandonSessionTask!('no-such-session', 'agent-1'),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      expect(callsTo(RESUME)).toEqual([]);
      expect(callsTo(ABANDON)).toEqual([]);
    } finally {
      await bridge.shutdown();
    }
  });
});
