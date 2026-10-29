/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { StrictMode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import { StreamingState, type HistoryItemWithoutId } from '../../types.js';
import {
  useDaemonStream,
  type DaemonSessionDriver,
  type DaemonPermissionResponse,
} from './useDaemonStream.js';
import type { DaemonFrame } from './projectDaemonEvent.js';
import {
  HOOK_TEXT,
  PROMPT_TEXT,
  afterTurn,
  capturedTurn,
  compactedTurn,
  turnError,
} from './two-client-turn.fixture.js';

/**
 * A controllable fake daemon driver: tests `push()` frames into the live
 * `events()` subscription and assert the hook's projected state, plus record
 * prompt/cancel/permission calls.
 */
function makeFakeDriver(
  opts: {
    clientId?: string;
    throwOnce?: string;
    manualPrompt?: boolean;
    /** Load-response transcript, as `DaemonSessionClient.load` retains it. */
    replay?: { compactedReplay: DaemonFrame[]; liveJournal: DaemonFrame[] };
    historyHasMore?: boolean;
    replayPartial?: boolean;
    replayDegraded?: boolean;
    hasActivePrompt?: boolean;
    lastEventId?: number;
    /** The load response's ACP state (`models`, `modes`). */
    state?: { models?: unknown; modes?: unknown };
    /** Shared ordering log: `subscribe` is pushed when events() starts. */
    log?: string[];
  } = {},
) {
  const queue: DaemonFrame[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let eventsCalls = 0;
  let consumeCalls = 0;
  let replay = opts.replay;
  let resolvePrompt: ((v: unknown) => void) | null = null;
  let rejectPrompt: ((e: unknown) => void) | null = null;
  const prompts: Array<{ prompt: Array<{ type: 'text'; text: string }> }> = [];
  const permissions: Array<{
    requestId: string;
    response: DaemonPermissionResponse;
  }> = [];
  let cancels = 0;
  let lastSignal: AbortSignal | undefined;

  const driver: DaemonSessionDriver & {
    push: (f: DaemonFrame) => void;
    end: () => void;
    finishPrompt: (result?: unknown) => void;
    failPrompt: (error: unknown) => void;
    stats: () => {
      eventsCalls: number;
      prompts: typeof prompts;
      permissions: typeof permissions;
      cancels: number;
      aborted: boolean;
      consumeCalls: number;
    };
  } = {
    clientId: opts.clientId,
    state: opts.state,
    get replaySnapshot() {
      return replay;
    },
    consumeReplaySnapshot: opts.replay
      ? () => {
          consumeCalls += 1;
          const snapshot = replay;
          replay = { compactedReplay: [], liveJournal: [] };
          return snapshot;
        }
      : undefined,
    historyHasMore: opts.historyHasMore,
    replayPartial: opts.replayPartial,
    replayDegraded: opts.replayDegraded,
    hasActivePrompt: opts.hasActivePrompt,
    lastEventId: opts.lastEventId,
    async *events({ signal } = {}) {
      eventsCalls += 1;
      opts.log?.push('subscribe');
      lastSignal = signal;
      if (opts.throwOnce && eventsCalls === 1) {
        throw new Error(opts.throwOnce);
      }
      for (;;) {
        if (signal?.aborted) return;
        if (queue.length) {
          const next = queue.shift()!;
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    },
    async prompt(req) {
      prompts.push(req);
      if (opts.manualPrompt) {
        return new Promise((resolve, reject) => {
          resolvePrompt = resolve;
          rejectPrompt = reject;
        });
      }
      return { stopReason: 'end_turn' };
    },
    async cancel() {
      cancels += 1;
    },
    async respondToSessionPermission(requestId, response) {
      permissions.push({ requestId, response });
      return true;
    },
    push(f) {
      queue.push(f);
      wake?.();
      wake = null;
    },
    end() {
      ended = true;
      wake?.();
      wake = null;
    },
    finishPrompt(result: unknown = { stopReason: 'end_turn' }) {
      resolvePrompt?.(result);
      resolvePrompt = null;
    },
    failPrompt(error: unknown) {
      rejectPrompt?.(error);
      rejectPrompt = null;
    },
    stats() {
      return {
        eventsCalls,
        prompts,
        permissions,
        cancels,
        aborted: lastSignal?.aborted ?? false,
        consumeCalls,
      };
    },
  };
  return driver;
}

const su = (
  update: Record<string, unknown>,
  originatorClientId?: string,
): DaemonFrame => ({
  type: 'session_update',
  data: { sessionId: 's1', update },
  originatorClientId,
});

describe('useDaemonStream', () => {
  it('streams a text turn into history and tracks streaming state', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const added: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      added.push(item);
      return added.length;
    });
    const { result } = renderHook(() => useDaemonStream(driver, addItem));

    act(() => {
      driver.push(
        su(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'PO' },
          },
          'me',
        ),
      );
      driver.push(
        su(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'NG' },
          },
          'me',
        ),
      );
    });

    await waitFor(() =>
      expect(result.current.streamingState).toBe(StreamingState.Responding),
    );
    await waitFor(() =>
      expect(result.current.pendingHistoryItems).toEqual([
        { type: 'gemini', text: 'PONG' },
      ]),
    );

    act(() => driver.push({ type: 'turn_complete', data: {} }));

    await waitFor(() =>
      expect(result.current.streamingState).toBe(StreamingState.Idle),
    );
    expect(added).toContainEqual({ type: 'gemini', text: 'PONG' });
    expect(result.current.pendingHistoryItems).toEqual([]);
  });

  it('finalizes the turn when prompt() resolves — no turn_complete frame (0.17.x)', async () => {
    // The fork's daemon signals completion via the prompt() HTTP response, not a
    // turn_complete SSE frame. The hook must finalize (commit + Idle) on resolve.
    const driver = makeFakeDriver({ clientId: 'me', manualPrompt: true });
    const committed: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      committed.push(item);
      return committed.length;
    });
    const { result } = renderHook(() => useDaemonStream(driver, addItem));

    let p: Promise<void> = Promise.resolve();
    act(() => {
      p = result.current.submitQuery('hey');
    });
    // Stream the reply WITHOUT any turn_complete frame.
    act(() => {
      driver.push(
        su(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Going' },
          },
          'me',
        ),
      );
      driver.push(
        su(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' well' },
          },
          'me',
        ),
      );
    });
    await waitFor(() =>
      expect(result.current.pendingHistoryItems).toEqual([
        { type: 'gemini', text: 'Going well' },
      ]),
    );
    expect(result.current.streamingState).toBe(StreamingState.Responding);

    // The daemon's prompt() HTTP call resolves with the turn's stopReason.
    await act(async () => {
      driver.finishPrompt({ stopReason: 'end_turn' });
      await p;
    });

    expect(committed).toContainEqual({ type: 'user', text: 'hey' });
    expect(committed).toContainEqual({ type: 'gemini', text: 'Going well' });
    expect(result.current.streamingState).toBe(StreamingState.Idle);
    expect(result.current.pendingHistoryItems).toEqual([]);
  });

  it('submitQuery echoes locally and forwards to the daemon', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const added: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      added.push(item);
      return added.length;
    });
    const { result } = renderHook(() => useDaemonStream(driver, addItem));

    await act(async () => {
      await result.current.submitQuery('hello');
    });

    expect(added).toEqual([{ type: 'user', text: 'hello' }]);
    expect(driver.stats().prompts).toEqual([
      { prompt: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('does NOT double-render our own turn: local echo + dropped daemon self-echo', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const userItems: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      if (item.type === 'user') userItems.push(item);
      return userItems.length;
    });
    const { result } = renderHook(() => useDaemonStream(driver, addItem));

    await act(async () => {
      await result.current.submitQuery('hello');
    });
    // The daemon echoes our own input back, tagged with OUR clientId.
    act(() =>
      driver.push(
        su(
          {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
          'me',
        ),
      ),
    );
    act(() => driver.push({ type: 'turn_complete', data: {} }));
    await waitFor(() =>
      expect(result.current.streamingState).toBe(StreamingState.Idle),
    );

    // Exactly ONE user line — the local echo; the self-echo was dropped.
    expect(userItems).toEqual([{ type: 'user', text: 'hello' }]);
  });

  it('renders a turn from another client (the phone) — different originator', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const userItems: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      if (item.type === 'user') userItems.push(item);
      return userItems.length;
    });
    renderHook(() => useDaemonStream(driver, addItem));

    act(() =>
      driver.push(
        su(
          {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'from phone' },
          },
          'phone',
        ),
      ),
    );

    await waitFor(() =>
      expect(userItems).toEqual([{ type: 'user', text: 'from phone' }]),
    );
  });

  it('cancelOngoingRequest cancels the daemon turn', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));
    act(() => result.current.cancelOngoingRequest());
    await waitFor(() => expect(driver.stats().cancels).toBe(1));
  });

  it('exposes the permission gate and posts a vote (select / cancel)', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));

    act(() => {
      driver.push(
        su(
          {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_1',
            _meta: { toolName: 'write_file' },
            title: 'Write file',
            status: 'in_progress',
          },
          'me',
        ),
      );
      driver.push({
        type: 'permission_request',
        data: {
          requestId: 'req_1',
          toolCall: { toolCallId: 'call_1' },
          options: [{ optionId: 'proceed_once' }, { optionId: 'cancel' }],
        },
      });
    });

    await waitFor(() =>
      expect(result.current.activePermission?.requestId).toBe('req_1'),
    );
    expect(result.current.streamingState).toBe(
      StreamingState.WaitingForConfirmation,
    );

    await act(async () => {
      await result.current.respondToPermission('proceed_once');
    });
    expect(driver.stats().permissions).toEqual([
      {
        requestId: 'req_1',
        response: {
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
        },
      },
    ]);

    await act(async () => {
      await result.current.respondToPermission(null);
    });
    expect(driver.stats().permissions[1]).toEqual({
      requestId: 'req_1',
      response: { outcome: { outcome: 'cancelled' } },
    });
  });

  it('attaches an answerable confirmation to the gated tool (outcome → optionId)', async () => {
    // An edit gate arrives as a permission_request with no prior tool_call; the
    // reducer seeds the tool and the hook attaches a confirmation whose
    // onConfirm maps the chosen outcome to the daemon optionId by `kind`.
    const driver = makeFakeDriver({ clientId: 'me' });
    const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));

    act(() => {
      driver.push({
        type: 'permission_request',
        data: {
          requestId: 'req_1',
          toolCall: {
            toolCallId: 'call_1',
            title: 'Writing to /tmp/x.txt',
            status: 'pending',
          },
          options: [
            { kind: 'allow_always', optionId: 'proceed_always' },
            { kind: 'allow_once', optionId: 'proceed_once' },
            { kind: 'reject_once', optionId: 'cancel' },
          ],
        },
      });
    });

    await waitFor(() =>
      expect(result.current.streamingState).toBe(
        StreamingState.WaitingForConfirmation,
      ),
    );

    const group = result.current.pendingHistoryItems.find(
      (i) => i.type === 'tool_group',
    );
    if (!group || group.type !== 'tool_group') {
      throw new Error('expected a tool_group in pendingHistoryItems');
    }
    const tool = group.tools.find((t) => t.callId === 'call_1');
    const details = tool?.confirmationDetails;
    expect(details?.type).toBe('info');

    // "Allow always" → the daemon's allow_always optionId.
    await act(async () => {
      await details!.onConfirm(ToolConfirmationOutcome.ProceedAlways);
    });
    expect(driver.stats().permissions).toEqual([
      {
        requestId: 'req_1',
        response: {
          outcome: { outcome: 'selected', optionId: 'proceed_always' },
        },
      },
    ]);

    // Esc/No → the reject_once optionId.
    await act(async () => {
      await details!.onConfirm(ToolConfirmationOutcome.Cancel);
    });
    expect(driver.stats().permissions[1]).toEqual({
      requestId: 'req_1',
      response: { outcome: { outcome: 'selected', optionId: 'cancel' } },
    });
  });

  it('retries when the daemon reports an existing subscription (StrictMode race)', async () => {
    const driver = makeFakeDriver({
      clientId: 'me',
      throwOnce:
        'Another event subscription is already active on this session.',
    });
    const added: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      added.push(item);
      return added.length;
    });
    const { result } = renderHook(() => useDaemonStream(driver, addItem));

    // First events() call threw; the hook must retry and then stream normally.
    await waitFor(() => expect(driver.stats().eventsCalls).toBeGreaterThan(1));
    act(() =>
      driver.push(
        su(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'ok' },
          },
          'me',
        ),
      ),
    );
    await waitFor(() =>
      expect(result.current.pendingHistoryItems).toEqual([
        { type: 'gemini', text: 'ok' },
      ]),
    );
    expect(result.current.initError).toBeNull();
  });

  describe('model and approval mode follow the daemon', () => {
    const loadState = {
      models: { currentModelId: 'flint(openai)', availableModels: [] },
      modes: { currentModeId: 'default', availableModes: [] },
    };

    it('starts from the load response state', () => {
      const driver = makeFakeDriver({ clientId: 'c1', state: loadState });
      const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));
      expect(result.current.daemonModelId).toBe('flint(openai)');
      expect(result.current.daemonApprovalMode).toBe('default');
    });

    it('has neither before the daemon says anything', () => {
      const driver = makeFakeDriver({ clientId: 'c1' });
      const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));
      expect(result.current.daemonModelId).toBeUndefined();
      expect(result.current.daemonApprovalMode).toBeUndefined();
    });

    it('follows a model_switched frame', async () => {
      const driver = makeFakeDriver({ clientId: 'c1', state: loadState });
      const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));
      await waitFor(() => expect(driver.stats().eventsCalls).toBe(1));
      act(() => {
        driver.push({
          id: 5,
          type: 'model_switched',
          data: { sessionId: 's1', modelId: 'qwen3-coder(openai)' },
          originatorClientId: 'phone',
        });
      });
      await waitFor(() =>
        expect(result.current.daemonModelId).toBe('qwen3-coder(openai)'),
      );
    });

    it('follows an approval_mode_changed frame', async () => {
      const driver = makeFakeDriver({ clientId: 'c1', state: loadState });
      const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));
      await waitFor(() => expect(driver.stats().eventsCalls).toBe(1));
      act(() => {
        driver.push({
          id: 6,
          type: 'approval_mode_changed',
          data: { previous: 'default', next: 'yolo', persisted: false },
        });
      });
      await waitFor(() =>
        expect(result.current.daemonApprovalMode).toBe('yolo'),
      );
    });

    it('lets the load state win over older replayed frames', () => {
      const driver = makeFakeDriver({
        clientId: 'c1',
        state: loadState,
        replay: {
          compactedReplay: [
            { id: 1, type: 'model_switched', data: { modelId: 'ancient' } },
            {
              id: 2,
              type: 'approval_mode_changed',
              data: { next: 'plan' },
            },
          ],
          liveJournal: [],
        },
      });
      const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));
      expect(result.current.daemonModelId).toBe('flint(openai)');
      expect(result.current.daemonApprovalMode).toBe('default');
    });

    it('falls back to replayed frames when the load state names nothing', () => {
      const driver = makeFakeDriver({
        clientId: 'c1',
        state: {},
        replay: {
          compactedReplay: [
            { id: 1, type: 'model_switched', data: { modelId: 'replayed' } },
          ],
          liveJournal: [],
        },
      });
      const { result } = renderHook(() => useDaemonStream(driver, vi.fn()));
      expect(result.current.daemonModelId).toBe('replayed');
    });
  });

  describe('attach-time history (replay snapshot from load)', () => {
    // Two compacted turns typed on the phone: user chunks carry no
    // originatorClientId (verified against a live daemon), and compacted
    // turns end with their turn_complete boundary.
    const replayTurns = (): DaemonFrame[] => [
      {
        id: 4,
        ...su({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Please review the size' },
        }),
      },
      {
        id: 9,
        ...su({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'It looks fine.' },
        }),
      },
      { id: 10, type: 'turn_complete', data: { stopReason: 'end_turn' } },
      {
        id: 11,
        ...su({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Thanks' },
        }),
      },
      {
        id: 15,
        ...su({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'You are welcome.' },
        }),
      },
      { id: 16, type: 'turn_complete', data: { stopReason: 'end_turn' } },
    ];

    const recordingAddItem = (log: string[]) => {
      const added: HistoryItemWithoutId[] = [];
      const addItem = vi.fn((item: HistoryItemWithoutId) => {
        added.push(item);
        log.push(`add:${item.type}`);
        return added.length;
      });
      return { added, addItem };
    };

    it('renders the replayed turns as history before any live frame', async () => {
      const log: string[] = [];
      const driver = makeFakeDriver({
        clientId: 'me',
        replay: { compactedReplay: replayTurns(), liveJournal: [] },
        lastEventId: 16,
        log,
      });
      const { added, addItem } = recordingAddItem(log);
      const { result } = renderHook(() => useDaemonStream(driver, addItem));

      await waitFor(() => expect(driver.stats().eventsCalls).toBe(1));
      expect(added).toEqual([
        { type: 'user', text: 'Please review the size' },
        { type: 'gemini', text: 'It looks fine.' },
        { type: 'user', text: 'Thanks' },
        { type: 'gemini', text: 'You are welcome.' },
      ]);
      // Every seeded item was committed before the live subscription opened.
      expect(log.indexOf('subscribe')).toBe(4);
      expect(result.current.streamingState).toBe(StreamingState.Idle);
      expect(result.current.pendingHistoryItems).toEqual([]);
      // The raw snapshot is released once it is in history.
      expect(driver.stats().consumeCalls).toBe(1);
      expect(driver.replaySnapshot).toEqual({
        compactedReplay: [],
        liveJournal: [],
      });
    });

    it('still drops a self-originated live echo after seeding, and renders the phone', async () => {
      const log: string[] = [];
      const driver = makeFakeDriver({
        clientId: 'me',
        replay: { compactedReplay: replayTurns(), liveJournal: [] },
        lastEventId: 16,
        log,
      });
      const { added, addItem } = recordingAddItem(log);
      renderHook(() => useDaemonStream(driver, addItem));
      await waitFor(() => expect(driver.stats().eventsCalls).toBe(1));
      expect(added).toHaveLength(4);

      act(() => {
        driver.push({
          id: 17,
          ...su(
            {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'typed in this tab' },
            },
            'me',
          ),
        });
        driver.push({ id: 18, type: 'turn_complete', data: {} });
        driver.push({
          id: 19,
          ...su(
            {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'from phone' },
            },
            'phone',
          ),
        });
      });

      await waitFor(() =>
        expect(added.at(-1)).toEqual({ type: 'user', text: 'from phone' }),
      );
      expect(added.filter((i) => i.type === 'user')).toEqual([
        { type: 'user', text: 'Please review the size' },
        { type: 'user', text: 'Thanks' },
        { type: 'user', text: 'from phone' },
      ]);
    });

    it('commits one info line first when earlier history is not shown', async () => {
      const log: string[] = [];
      const driver = makeFakeDriver({
        clientId: 'me',
        replay: { compactedReplay: replayTurns(), liveJournal: [] },
        historyHasMore: true,
        log,
      });
      const { added, addItem } = recordingAddItem(log);
      renderHook(() => useDaemonStream(driver, addItem));
      await waitFor(() => expect(driver.stats().eventsCalls).toBe(1));

      expect(added[0]?.type).toBe('info');
      expect(added.filter((i) => i.type === 'info')).toHaveLength(1);
      expect(added.slice(1).map((i) => i.type)).toEqual([
        'user',
        'gemini',
        'user',
        'gemini',
      ]);
    });

    it('commits one info line when the replay is partial or degraded', async () => {
      const log: string[] = [];
      const driver = makeFakeDriver({
        clientId: 'me',
        replay: { compactedReplay: replayTurns(), liveJournal: [] },
        replayPartial: true,
        replayDegraded: true,
        log,
      });
      const { added, addItem } = recordingAddItem(log);
      renderHook(() => useDaemonStream(driver, addItem));
      await waitFor(() => expect(driver.stats().eventsCalls).toBe(1));

      expect(added.filter((i) => i.type === 'info')).toHaveLength(1);
      expect(added[0]?.type).toBe('info');
    });

    it('seeds exactly once under StrictMode (effects run twice)', async () => {
      const log: string[] = [];
      const driver = makeFakeDriver({
        clientId: 'me',
        replay: { compactedReplay: replayTurns(), liveJournal: [] },
        log,
      });
      const { added, addItem } = recordingAddItem(log);
      renderHook(() => useDaemonStream(driver, addItem), {
        wrapper: StrictMode,
      });
      await waitFor(() =>
        expect(driver.stats().eventsCalls).toBeGreaterThanOrEqual(1),
      );
      expect(added).toHaveLength(4);
      expect(driver.stats().consumeCalls).toBe(1);
    });

    it('keeps an in-flight replayed turn live when the daemon reports an active prompt', async () => {
      const log: string[] = [];
      const driver = makeFakeDriver({
        clientId: 'me',
        replay: {
          compactedReplay: replayTurns(),
          liveJournal: [
            {
              id: 17,
              ...su(
                {
                  sessionUpdate: 'user_message_chunk',
                  content: { type: 'text', text: 'still running' },
                },
                'phone',
              ),
            },
            {
              id: 18,
              ...su(
                {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Work' },
                },
                'phone',
              ),
            },
          ],
        },
        hasActivePrompt: true,
        lastEventId: 18,
        log,
      });
      const { added, addItem } = recordingAddItem(log);
      const { result } = renderHook(() => useDaemonStream(driver, addItem));
      await waitFor(() => expect(driver.stats().eventsCalls).toBe(1));

      expect(added.at(-1)).toEqual({ type: 'user', text: 'still running' });
      expect(result.current.streamingState).toBe(StreamingState.Responding);
      expect(result.current.pendingHistoryItems).toEqual([
        { type: 'gemini', text: 'Work' },
      ]);

      // The live stream continues the same turn and completes it.
      act(() => {
        driver.push({
          id: 19,
          ...su(
            {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: ' done' },
            },
            'phone',
          ),
        });
        driver.push({ id: 20, type: 'turn_complete', data: {} });
      });
      await waitFor(() =>
        expect(result.current.streamingState).toBe(StreamingState.Idle),
      );
      expect(added.at(-1)).toEqual({ type: 'gemini', text: 'Work done' });
    });
  });

  // #195: frames as a live daemon sends them with a phone and this tab on one
  // session. After each turn_complete the daemon still publishes content-less
  // chunks (a background request's lifecycle markers); the tab must stay idle.
  describe('turn end with another client attached (#195)', () => {
    // A frame the reducer applies visibly, pushed last: once the hook shows
    // it, every frame before it has been folded in.
    const marker = (modelId: string): DaemonFrame => ({
      type: 'model_switched',
      data: { modelId },
    });

    const recording = () => {
      const added: HistoryItemWithoutId[] = [];
      const addItem = vi.fn((item: HistoryItemWithoutId) => {
        added.push(item);
        return added.length;
      });
      return { added, addItem };
    };

    it('a phone-sent turn goes idle on its turn_complete and stays idle', async () => {
      const driver = makeFakeDriver({ clientId: 'me' });
      const { added, addItem } = recording();
      const { result } = renderHook(() => useDaemonStream(driver, addItem));

      const turn = capturedTurn(2, 'phone', 'prompt-phone');
      act(() => {
        for (const f of turn) driver.push(f);
      });
      await waitFor(() =>
        expect(added).toContainEqual({
          type: 'gemini',
          text: `pong${HOOK_TEXT}`,
        }),
      );
      act(() => {
        for (const f of afterTurn(2 + turn.length)) driver.push(f);
        driver.push(marker('after-phone'));
      });
      await waitFor(() =>
        expect(result.current.daemonModelId).toBe('after-phone'),
      );

      expect(result.current.streamingState).toBe(StreamingState.Idle);
      expect(result.current.pendingHistoryItems).toEqual([]);
      expect(added.filter((i) => i.type === 'user')).toEqual([
        { type: 'user', text: PROMPT_TEXT },
      ]);
    });

    it("the tab's own turn goes idle while the phone is attached", async () => {
      const driver = makeFakeDriver({ clientId: 'me', manualPrompt: true });
      const { added, addItem } = recording();
      const { result } = renderHook(() => useDaemonStream(driver, addItem));

      // The phone's turn first, then the tab answers.
      const phone = capturedTurn(2, 'phone', 'prompt-phone');
      act(() => {
        for (const f of [...phone, ...afterTurn(2 + phone.length)]) {
          driver.push(f);
        }
        driver.push(marker('after-phone'));
      });
      await waitFor(() =>
        expect(result.current.daemonModelId).toBe('after-phone'),
      );
      expect(result.current.streamingState).toBe(StreamingState.Idle);

      let sent: Promise<void> = Promise.resolve();
      act(() => {
        sent = result.current.submitQuery(PROMPT_TEXT);
      });
      const tab = capturedTurn(4 + phone.length, 'me', 'prompt-tab');
      act(() => {
        for (const f of tab) driver.push(f);
      });
      await waitFor(() =>
        expect(added.at(-1)).toEqual({
          type: 'gemini',
          text: `pong${HOOK_TEXT}`,
        }),
      );
      // The SDK resolves prompt() off that same turn_complete.
      await act(async () => {
        driver.finishPrompt({ stopReason: 'end_turn' });
        await sent;
      });
      act(() => {
        for (const f of afterTurn(4 + phone.length + tab.length)) {
          driver.push(f);
        }
        driver.push(marker('after-tab'));
      });
      await waitFor(() =>
        expect(result.current.daemonModelId).toBe('after-tab'),
      );

      expect(result.current.streamingState).toBe(StreamingState.Idle);
      expect(result.current.pendingHistoryItems).toEqual([]);
      // Phone's line rendered from the stream, the tab's own line once (local
      // echo; the daemon's self-echo is dropped).
      expect(added.filter((i) => i.type === 'user')).toEqual([
        { type: 'user', text: PROMPT_TEXT },
        { type: 'user', text: PROMPT_TEXT },
      ]);
      expect(added.filter((i) => i.type === 'gemini')).toHaveLength(2);
    });

    it('renders every live frame after a seeded load and ends the turn', async () => {
      // Attached with `load` after the phone's first turn; the live stream
      // resumes at the load's lastEventId + 1 (as captured).
      const loaded = compactedTurn(2, 'phone', 'prompt-1');
      const driver = makeFakeDriver({
        clientId: 'me',
        replay: { compactedReplay: loaded.compactedReplay, liveJournal: [] },
        lastEventId: loaded.lastEventId,
      });
      const { added, addItem } = recording();
      const { result } = renderHook(() => useDaemonStream(driver, addItem));
      await waitFor(() => expect(driver.stats().eventsCalls).toBe(1));
      expect(added).toHaveLength(2);

      const next = capturedTurn(loaded.lastEventId + 1, 'phone', 'prompt-2');
      act(() => {
        for (const f of next) driver.push(f);
      });
      await waitFor(() => expect(added).toHaveLength(4));
      act(() => {
        for (const f of afterTurn(loaded.lastEventId + 1 + next.length)) {
          driver.push(f);
        }
        driver.push(marker('after-live'));
      });
      await waitFor(() =>
        expect(result.current.daemonModelId).toBe('after-live'),
      );

      expect(added.slice(2)).toEqual([
        { type: 'user', text: PROMPT_TEXT },
        { type: 'gemini', text: `pong${HOOK_TEXT}` },
      ]);
      expect(result.current.streamingState).toBe(StreamingState.Idle);
      expect(result.current.pendingHistoryItems).toEqual([]);
    });
  });

  // A failed prompt: the daemon publishes turn_error (not turn_complete) and
  // the SDK rejects prompt() with its turn error, before it hands the frame on.
  it("the tab's own failed turn goes idle, shows the error once, and does not throw", async () => {
    const driver = makeFakeDriver({ clientId: 'me', manualPrompt: true });
    const added: HistoryItemWithoutId[] = [];
    const addItem = vi.fn((item: HistoryItemWithoutId) => {
      added.push(item);
      return added.length;
    });
    const { result } = renderHook(() => useDaemonStream(driver, addItem));

    let sent: Promise<void> = Promise.resolve();
    act(() => {
      sent = result.current.submitQuery(PROMPT_TEXT);
    });
    // The turn streams 'pong', then the model request dies.
    act(() => {
      for (const f of capturedTurn(2, 'me', 'prompt-tab').slice(0, 9)) {
        driver.push(f);
      }
    });
    await waitFor(() =>
      expect(result.current.pendingHistoryItems).toEqual([
        { type: 'gemini', text: 'pong' },
      ]),
    );
    await act(async () => {
      driver.failPrompt(
        Object.assign(new Error('terminated'), {
          status: 500,
          code: 'turn_error',
          _daemonTurnError: true,
        }),
      );
      await sent;
    });
    act(() => {
      driver.push(turnError(11, 'me', 'prompt-tab'));
      driver.push({ type: 'model_switched', data: { modelId: 'after' } });
    });
    await waitFor(() => expect(result.current.daemonModelId).toBe('after'));

    expect(result.current.streamingState).toBe(StreamingState.Idle);
    expect(result.current.pendingHistoryItems).toEqual([]);
    expect(added.map((i) => i.type)).toEqual(['user', 'gemini', 'error']);
    expect(added[1]).toEqual({ type: 'gemini', text: 'pong' });
  });

  it('aborts the subscription on unmount', async () => {
    const driver = makeFakeDriver({ clientId: 'me' });
    const { unmount } = renderHook(() => useDaemonStream(driver, vi.fn()));
    // Let the subscription establish.
    await waitFor(() => expect(driver.stats().eventsCalls).toBe(1));
    unmount();
    await waitFor(() => expect(driver.stats().aborted).toBe(true));
  });
});
