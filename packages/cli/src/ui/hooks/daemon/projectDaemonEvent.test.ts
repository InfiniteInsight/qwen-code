/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  StreamingState,
  ToolCallStatus,
  type HistoryItemWithoutId,
} from '../../types.js';
import {
  initialDaemonProjectionState,
  projectDaemonEvent,
  pendingHistoryItemsOf,
  pendingToolCallsOf,
  activePermissionOf,
  projectReplaySnapshot,
  thoughtOf,
  type DaemonFrame,
  type DaemonProjectionState,
} from './projectDaemonEvent.js';

/**
 * Real frame sequence captured from a live `qwen serve` text turn
 * (`packages/rc-gateway/scripts/capture-daemon-frames.mts`) — abridged to the
 * shapes that matter. Using ground truth, not guesses.
 */
const SELF = 'client_self';
const PHONE = 'client_phone';

const sessionUpdate = (
  update: Record<string, unknown>,
  originatorClientId?: string,
): DaemonFrame => ({
  type: 'session_update',
  data: { sessionId: 's1', update },
  originatorClientId,
});

// A full turn the TERMINAL itself initiated — every frame carries our own
// clientId (verified against a live daemon). The user echo must be DROPPED
// (the submitter rendered it locally); only the assistant message commits.
const CAPTURED_TURN: DaemonFrame[] = [
  {
    type: 'replay_complete',
    data: { replayedCount: 0 },
    originatorClientId: SELF,
  },
  sessionUpdate(
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
      _meta: { availableSkills: ['review'] },
    },
    SELF,
  ),
  sessionUpdate(
    {
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'text',
        text: 'Reply with exactly the word PONG and nothing else.',
      },
      _meta: { serverTimestamp: 1, source: 'bridge' },
    },
    SELF,
  ),
  // streamed reasoning, token by token
  ...['The', ' user', ' wants', ' "', 'P', 'ONG', '"'].map((t) =>
    sessionUpdate(
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: t },
      },
      SELF,
    ),
  ),
  // streamed reply
  sessionUpdate(
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'P' },
    },
    SELF,
  ),
  sessionUpdate(
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'ONG' },
    },
    SELF,
  ),
  // terminal chunk: empty text + usage marker
  sessionUpdate(
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: {
        usage: {
          inputTokens: 23760,
          outputTokens: 22,
          totalTokens: 23782,
          cachedReadTokens: 16896,
        },
        durationMs: 3958,
      },
    },
    SELF,
  ),
  {
    type: 'turn_complete',
    data: { sessionId: 's1', stopReason: 'end_turn', promptId: 'p1' },
    originatorClientId: SELF,
  },
];

function runAll(
  frames: DaemonFrame[],
  ownClientId?: string,
): {
  state: DaemonProjectionState;
  committed: HistoryItemWithoutId[];
} {
  let state = initialDaemonProjectionState(ownClientId);
  const committed: HistoryItemWithoutId[] = [];
  for (const f of frames) {
    const r = projectDaemonEvent(state, f);
    state = r.state;
    committed.push(...r.committed);
  }
  return { state, committed };
}

describe('projectDaemonEvent', () => {
  it('starts Idle with nothing pending', () => {
    const s = initialDaemonProjectionState();
    expect(s.streamingState).toBe(StreamingState.Idle);
    expect(pendingHistoryItemsOf(s)).toEqual([]);
    expect(thoughtOf(s)).toBeNull();
  });

  it('projects our OWN captured turn into assistant history only (self-echo dropped)', () => {
    // ownClientId === SELF, frames originated by SELF → the user echo is the
    // submitter's own input (already rendered locally), so only the assistant
    // message is committed.
    const { state, committed } = runAll(CAPTURED_TURN, SELF);
    expect(committed).toEqual([{ type: 'gemini', text: 'PONG' }]);
    // Turn finished: back to Idle, nothing left pending.
    expect(state.streamingState).toBe(StreamingState.Idle);
    expect(pendingHistoryItemsOf(state)).toEqual([]);
    expect(thoughtOf(state)).toBeNull();
    // Usage captured from the terminal chunk.
    expect(state.lastUsage).toMatchObject({
      inputTokens: 23760,
      outputTokens: 22,
      totalTokens: 23782,
      durationMs: 3958,
    });
  });

  it('projects a turn from ANOTHER client (the phone) including its user line', () => {
    // A phone-initiated turn: originator != our clientId → we DO render the
    // user line so the handoff conversation stays in sync on the terminal.
    const phoneTurn = CAPTURED_TURN.map((f) =>
      f.type === 'session_update' &&
      (f.data as { update?: { sessionUpdate?: string } }).update
        ?.sessionUpdate === 'user_message_chunk'
        ? { ...f, originatorClientId: PHONE }
        : f,
    );
    const { committed } = runAll(phoneTurn, SELF);
    expect(committed).toEqual([
      {
        type: 'user',
        text: 'Reply with exactly the word PONG and nothing else.',
      },
      { type: 'gemini', text: 'PONG' },
    ]);
  });

  it('projects the user line when ownClientId is unconfigured (never swallow input)', () => {
    const { committed } = runAll(CAPTURED_TURN); // no ownClientId
    expect(committed).toContainEqual({
      type: 'user',
      text: 'Reply with exactly the word PONG and nothing else.',
    });
  });

  it('accumulates streamed text/thought live before the turn completes', () => {
    // Feed everything EXCEPT the final turn_complete (our own turn).
    const { state, committed } = runAll(CAPTURED_TURN.slice(0, -1), SELF);
    expect(state.streamingState).toBe(StreamingState.Responding);
    // Mid-turn, the assistant text is live in the pending section…
    expect(pendingHistoryItemsOf(state)).toEqual([
      { type: 'gemini', text: 'PONG' },
    ]);
    // …reasoning is exposed for the loading indicator…
    expect(thoughtOf(state)?.description).toContain('The user wants');
    // …and nothing is committed yet (self-echo dropped, assistant not final).
    expect(committed).toEqual([]);
  });

  it('parses a **bold** thought subject into the summary', () => {
    let s = initialDaemonProjectionState();
    s = projectDaemonEvent(
      s,
      sessionUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'text',
          text: '**Checking the files** then I will edit them.',
        },
      }),
    ).state;
    expect(thoughtOf(s)).toEqual({
      subject: 'Checking the files',
      description: 'then I will edit them.',
    });
  });

  it('does not commit an assistant item for an empty turn', () => {
    // turn_complete with no streamed text must not emit a blank gemini item.
    const s = initialDaemonProjectionState();
    const r = projectDaemonEvent(s, {
      type: 'turn_complete',
      data: { sessionId: 's1', stopReason: 'end_turn' },
    });
    expect(r.committed).toEqual([]);
    expect(r.state.streamingState).toBe(StreamingState.Idle);
  });

  it('ignores replay_complete and unknown frame types (no spurious commits)', () => {
    let s = initialDaemonProjectionState();
    for (const f of [
      { type: 'replay_complete', data: { replayedCount: 5 } },
      { type: 'some_future_frame', data: { whatever: true } },
      sessionUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
      }),
    ] satisfies DaemonFrame[]) {
      const r = projectDaemonEvent(s, f);
      s = r.state;
      expect(r.committed).toEqual([]);
    }
    expect(s.streamingState).toBe(StreamingState.Idle);
  });

  it('is pure — does not mutate the input state', () => {
    const s0 = initialDaemonProjectionState();
    const snapshot = JSON.stringify(s0);
    projectDaemonEvent(
      s0,
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      }),
    );
    expect(JSON.stringify(s0)).toBe(snapshot);
  });

  it('treats hook-noise chunks as ordinary stream text (faithful to the daemon)', () => {
    // The daemon may inject a non-model chunk mid-stream; the reducer reflects
    // exactly what was sent rather than trying to filter it.
    const frames: DaemonFrame[] = [
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'PONG' },
      }),
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '[hook] note' },
      }),
      { type: 'turn_complete', data: {} },
    ];
    const { committed } = runAll(frames);
    expect(committed).toEqual([{ type: 'gemini', text: 'PONG[hook] note' }]);
  });

  // --- slice 2: tool-call display + permission gate ---

  // Real captured shapes from a `list_directory` tool turn (status strings,
  // toolCallId, _meta.toolName, title, content/rawOutput) — ground truth.
  const TOOL_CALL = sessionUpdate({
    sessionUpdate: 'tool_call',
    _meta: { toolName: 'list_directory', provenance: 'builtin' },
    kind: 'search',
    rawInput: { path: '/work' },
    status: 'in_progress',
    title: 'ListFiles: .',
    toolCallId: 'call_1',
  });
  const TOOL_UPDATE = sessionUpdate({
    sessionUpdate: 'tool_call_update',
    _meta: { toolName: 'list_directory', provenance: 'builtin' },
    content: [
      { content: { text: 'Listed 3 items', type: 'text' }, type: 'content' },
    ],
    rawOutput: 'Listed 3 items',
    status: 'completed',
    toolCallId: 'call_1',
  });

  it('projects a captured tool call into a tool_group with mapped status + result', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, TOOL_CALL).state;
    // Live during the turn: one Executing tool.
    expect(pendingToolCallsOf(s)).toEqual([
      expect.objectContaining({
        callId: 'call_1',
        name: 'list_directory',
        description: 'ListFiles: .',
        status: ToolCallStatus.Executing,
      }),
    ]);

    s = projectDaemonEvent(s, TOOL_UPDATE).state;
    expect(pendingToolCallsOf(s)[0]).toMatchObject({
      status: ToolCallStatus.Success,
      resultDisplay: 'Listed 3 items',
    });

    // On turn end the tool group commits and live tools clear.
    const r = projectDaemonEvent(s, { type: 'turn_complete', data: {} });
    expect(r.committed).toEqual([
      {
        type: 'tool_group',
        tools: [
          expect.objectContaining({
            callId: 'call_1',
            status: ToolCallStatus.Success,
          }),
        ],
      },
    ]);
    expect(pendingToolCallsOf(r.state)).toEqual([]);
    expect(r.state.streamingState).toBe(StreamingState.Idle);
  });

  it('renders tools LIVE via pendingHistoryItems (tool_group above streaming text)', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, TOOL_CALL).state;
    // Mid-turn, before any assistant text: just the live tool group.
    expect(pendingHistoryItemsOf(s)).toEqual([
      {
        type: 'tool_group',
        tools: [
          expect.objectContaining({
            callId: 'call_1',
            status: ToolCallStatus.Executing,
          }),
        ],
      },
    ]);

    // Once the assistant starts streaming, text appears BELOW the tool group —
    // the same order the turn_complete commit uses (`[tool_group, gemini]`).
    s = projectDaemonEvent(
      s,
      sessionUpdate(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Listing…' },
        },
        SELF,
      ),
    ).state;
    expect(pendingHistoryItemsOf(s)).toEqual([
      {
        type: 'tool_group',
        tools: [expect.objectContaining({ callId: 'call_1' })],
      },
      { type: 'gemini', text: 'Listing…' },
    ]);
  });

  it('commits tool_group AND the assistant message together at turn end', () => {
    const frames: DaemonFrame[] = [
      TOOL_CALL,
      TOOL_UPDATE,
      sessionUpdate(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        },
        SELF,
      ),
      { type: 'turn_complete', data: {} },
    ];
    const { committed } = runAll(frames, SELF);
    expect(committed).toEqual([
      {
        type: 'tool_group',
        tools: [expect.objectContaining({ callId: 'call_1' })],
      },
      { type: 'gemini', text: 'done' },
    ]);
  });

  it('opens an approval gate on permission_request (tool → Confirming)', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, TOOL_CALL).state;
    s = projectDaemonEvent(s, {
      type: 'permission_request',
      data: {
        requestId: 'req_1',
        sessionId: 's1',
        toolCall: { toolCallId: 'call_1' },
        options: [
          { optionId: 'proceed_once', name: 'Yes' },
          { optionId: 'cancel', name: 'No' },
        ],
      },
    }).state;
    expect(s.streamingState).toBe(StreamingState.WaitingForConfirmation);
    expect(pendingToolCallsOf(s)[0].status).toBe(ToolCallStatus.Confirming);
    expect(activePermissionOf(s)).toEqual({
      requestId: 'req_1',
      toolCallId: 'call_1',
      options: [
        { optionId: 'proceed_once', name: 'Yes' },
        { optionId: 'cancel', name: 'No' },
      ],
    });
  });

  it('seeds the gated tool from the request when no tool_call preceded it (edit)', () => {
    // Real captured shape: a write_file/edit gate arrives ONLY as a
    // permission_request — there is NO prior `tool_call` frame — so the reducer
    // must materialize the tool from the request's own `toolCall`.
    let s = initialDaemonProjectionState(SELF);
    expect(pendingToolCallsOf(s)).toEqual([]); // nothing yet
    s = projectDaemonEvent(s, {
      type: 'permission_request',
      data: {
        requestId: 'b95e50a2',
        sessionId: 's1',
        toolCall: {
          content: [
            {
              newText: 'hi',
              oldText: '',
              path: '/tmp/capture_probe.txt',
              type: 'diff',
            },
          ],
          kind: 'edit',
          locations: [{ path: '/tmp/capture_probe.txt' }],
          rawInput: { file_path: '/tmp/capture_probe.txt', content: 'hi' },
          status: 'pending',
          title: 'Writing to /tmp/capture_probe.txt',
          toolCallId: 'eZfspYl89m4FgWl2OUmlx4KXUHRJNZk0',
        },
        options: [
          {
            kind: 'allow_always',
            name: 'Allow All Edits',
            optionId: 'proceed_always',
          },
          { kind: 'allow_once', name: 'Allow', optionId: 'proceed_once' },
          { kind: 'reject_once', name: 'Reject', optionId: 'cancel' },
        ],
      },
    }).state;

    // The tool now exists and is Confirming, with its title as the label.
    expect(pendingToolCallsOf(s)).toEqual([
      expect.objectContaining({
        callId: 'eZfspYl89m4FgWl2OUmlx4KXUHRJNZk0',
        description: 'Writing to /tmp/capture_probe.txt',
        status: ToolCallStatus.Confirming,
      }),
    ]);
    // And it renders live (so the user sees what they're approving).
    expect(pendingHistoryItemsOf(s)).toEqual([
      {
        type: 'tool_group',
        tools: [
          expect.objectContaining({
            callId: 'eZfspYl89m4FgWl2OUmlx4KXUHRJNZk0',
            status: ToolCallStatus.Confirming,
          }),
        ],
      },
    ]);
    // The gate carries the title + kind-tagged options for the hook to map.
    expect(activePermissionOf(s)).toEqual({
      requestId: 'b95e50a2',
      toolCallId: 'eZfspYl89m4FgWl2OUmlx4KXUHRJNZk0',
      title: 'Writing to /tmp/capture_probe.txt',
      options: [
        {
          kind: 'allow_always',
          name: 'Allow All Edits',
          optionId: 'proceed_always',
        },
        { kind: 'allow_once', name: 'Allow', optionId: 'proceed_once' },
        { kind: 'reject_once', name: 'Reject', optionId: 'cancel' },
      ],
    });
  });

  it('clears the gate on permission_resolved — approved → Executing', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, TOOL_CALL).state;
    s = projectDaemonEvent(s, {
      type: 'permission_request',
      data: {
        requestId: 'req_1',
        toolCall: { toolCallId: 'call_1' },
        options: [],
      },
    }).state;
    s = projectDaemonEvent(s, {
      type: 'permission_resolved',
      data: {
        requestId: 'req_1',
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      },
    }).state;
    expect(activePermissionOf(s)).toBeUndefined();
    expect(s.streamingState).toBe(StreamingState.Responding);
    expect(pendingToolCallsOf(s)[0].status).toBe(ToolCallStatus.Executing);
  });

  it('clears the gate on permission_resolved — cancelled → Canceled', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, TOOL_CALL).state;
    s = projectDaemonEvent(s, {
      type: 'permission_request',
      data: {
        requestId: 'req_1',
        toolCall: { toolCallId: 'call_1' },
        options: [],
      },
    }).state;
    s = projectDaemonEvent(s, {
      type: 'permission_resolved',
      data: { requestId: 'req_1', outcome: { outcome: 'cancelled' } },
    }).state;
    expect(activePermissionOf(s)).toBeUndefined();
    expect(pendingToolCallsOf(s)[0].status).toBe(ToolCallStatus.Canceled);
  });

  it('leaves our gate intact when a DIFFERENT request resolves', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, {
      type: 'permission_request',
      data: { requestId: 'req_1', toolCall: {}, options: [] },
    }).state;
    s = projectDaemonEvent(s, {
      type: 'permission_resolved',
      data: { requestId: 'OTHER', outcome: { outcome: 'cancelled' } },
    }).state;
    expect(activePermissionOf(s)?.requestId).toBe('req_1');
    expect(s.streamingState).toBe(StreamingState.WaitingForConfirmation);
  });
});

// --- slice 3: replay (ring re-attach) — dedup + turn segmentation ---

const withId = (frame: DaemonFrame, id: number): DaemonFrame => ({
  ...frame,
  id,
});

describe('projectDaemonEvent — replay', () => {
  it('dedups frames at or below the event-id watermark (no double-render)', () => {
    let s = initialDaemonProjectionState(SELF);
    const a = withId(
      sessionUpdate(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'A' },
        },
        SELF,
      ),
      5,
    );
    s = projectDaemonEvent(s, a).state;
    expect(s.lastEventId).toBe(5);

    // A re-delivered frame (id ≤ watermark) is skipped — text is NOT doubled.
    const dup = projectDaemonEvent(s, a);
    expect(dup.committed).toEqual([]);
    expect(pendingHistoryItemsOf(dup.state)).toEqual([
      { type: 'gemini', text: 'A' },
    ]);

    // A newer id applies and advances the watermark.
    const b = withId(
      sessionUpdate(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'B' },
        },
        SELF,
      ),
      6,
    );
    const r = projectDaemonEvent(dup.state, b);
    expect(pendingHistoryItemsOf(r.state)).toEqual([
      { type: 'gemini', text: 'AB' },
    ]);
    expect(r.state.lastEventId).toBe(6);
  });

  it('segments a replayed history stream into turns without turn_complete frames', () => {
    // Ring replay (lastEventId:0 re-attach) sends a turn typed on the PHONE with
    // no turn_complete between turns. A new user_message_chunk flushes the prior
    // assistant turn so history renders as discrete turns.
    const replay: DaemonFrame[] = [
      withId(
        sessionUpdate(
          {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
          PHONE,
        ),
        1,
      ),
      withId(
        sessionUpdate(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hi there' },
          },
          PHONE,
        ),
        2,
      ),
      withId(
        sessionUpdate(
          {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'how are you' },
          },
          PHONE,
        ),
        3,
      ),
      withId(
        sessionUpdate(
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'great' },
          },
          PHONE,
        ),
        4,
      ),
    ];
    const { committed, state } = runAll(replay, SELF);

    // The first two turns committed; the last assistant turn stays pending until
    // a boundary (a later user message or a turn_complete).
    expect(committed).toEqual([
      { type: 'user', text: 'hello' },
      { type: 'gemini', text: 'hi there' },
      { type: 'user', text: 'how are you' },
    ]);
    expect(pendingHistoryItemsOf(state)).toEqual([
      { type: 'gemini', text: 'great' },
    ]);

    // A turn_complete (or the next live user turn) flushes the final turn.
    const end = projectDaemonEvent(state, { type: 'turn_complete', data: {} });
    expect(end.committed).toEqual([{ type: 'gemini', text: 'great' }]);
    expect(end.state.streamingState).toBe(StreamingState.Idle);
  });
});

// --- attach-time seeding from the load response's replay snapshot (#194) ---

describe('projectReplaySnapshot', () => {
  // The shape of a compacted daemon replay: each turn is folded at its
  // boundary, so a merged event carries the id of its LAST source chunk and a
  // latest-wins update keeps its first slot but the newest id. Ids inside a
  // turn are therefore NOT monotonic. Replayed user chunks carry no
  // originatorClientId (verified against a live daemon).
  const compactedReplay: DaemonFrame[] = [
    withId(
      sessionUpdate({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'first question' },
      }),
      3,
    ),
    withId(
      sessionUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
      }),
      40,
    ),
    withId(
      sessionUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' },
      }),
      20,
    ),
    withId(
      sessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'Read file',
        status: 'completed',
        _meta: { toolName: 'read_file' },
      }),
      12,
    ),
    withId(
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'first answer' },
      }),
      30,
    ),
    withId({ type: 'turn_complete', data: { stopReason: 'end_turn' } }, 31),
    withId(
      sessionUpdate({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'second question' },
      }),
      41,
    ),
    withId(
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'second answer' },
      }),
      50,
    ),
    withId({ type: 'turn_complete', data: { stopReason: 'end_turn' } }, 51),
  ];
  const liveJournal: DaemonFrame[] = [
    withId(
      sessionUpdate(
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'third question' },
        },
        PHONE,
      ),
      52,
    ),
    withId(
      sessionUpdate(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'third answer so far' },
        },
        PHONE,
      ),
      53,
    ),
  ];

  it('folds compacted replay then the live journal, in order, ignoring non-monotonic ids', () => {
    const { committed, state } = projectReplaySnapshot(
      { compactedReplay, liveJournal },
      { ownClientId: SELF, lastEventId: 53 },
    );
    expect(committed.map((i) => i.type)).toEqual([
      'user',
      'tool_group',
      'gemini',
      'user',
      'gemini',
      'user',
      'gemini',
    ]);
    expect(committed[0]).toEqual({ type: 'user', text: 'first question' });
    expect(committed[2]).toEqual({ type: 'gemini', text: 'first answer' });
    expect(committed[3]).toEqual({ type: 'user', text: 'second question' });
    expect(committed[4]).toEqual({ type: 'gemini', text: 'second answer' });
    expect(committed[5]).toEqual({ type: 'user', text: 'third question' });
    // No prompt in flight: the trailing journal turn is committed and the
    // projection returns to Idle instead of a stuck spinner.
    expect(committed[6]).toEqual({
      type: 'gemini',
      text: 'third answer so far',
    });
    expect(state.streamingState).toBe(StreamingState.Idle);
    expect(pendingHistoryItemsOf(state)).toEqual([]);
    // The live loop continues from the subscription cursor with our identity.
    expect(state.ownClientId).toBe(SELF);
    expect(state.lastEventId).toBe(53);
  });

  it('keeps the in-flight journal turn pending when the daemon reports an active prompt', () => {
    const { committed, state } = projectReplaySnapshot(
      { compactedReplay, liveJournal },
      { ownClientId: SELF, lastEventId: 53, hasActivePrompt: true },
    );
    expect(committed.at(-1)).toEqual({ type: 'user', text: 'third question' });
    expect(state.streamingState).toBe(StreamingState.Responding);
    expect(pendingHistoryItemsOf(state)).toEqual([
      { type: 'gemini', text: 'third answer so far' },
    ]);
  });

  it('renders a replayed user line even when it carries our own clientId', () => {
    // Replay is history, not an echo of input this client just rendered.
    const { committed, state } = projectReplaySnapshot(
      {
        compactedReplay: [
          withId(
            sessionUpdate(
              {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'typed here earlier' },
              },
              SELF,
            ),
            1,
          ),
        ],
        liveJournal: [],
      },
      { ownClientId: SELF },
    );
    expect(committed).toEqual([{ type: 'user', text: 'typed here earlier' }]);
    // ...but live self-echo suppression is armed for what follows.
    const echo = projectDaemonEvent(
      state,
      withId(
        sessionUpdate(
          {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'new input' },
          },
          SELF,
        ),
        2,
      ),
    );
    expect(echo.committed).toEqual([]);
  });

  it('puts one info line first when earlier history is not included', () => {
    const viaFlag = projectReplaySnapshot(
      { compactedReplay, liveJournal: [] },
      { historyHasMore: true },
    ).committed;
    expect(viaFlag[0]?.type).toBe('info');
    expect(viaFlag.filter((i) => i.type === 'info')).toHaveLength(1);
    expect(viaFlag[1]).toEqual({ type: 'user', text: 'first question' });

    // A history_truncated marker in the window means the same thing.
    const viaMarker = projectReplaySnapshot(
      {
        compactedReplay: [
          {
            type: 'history_truncated',
            data: { reason: 'replay_window_exceeded' },
          },
          ...compactedReplay,
        ],
        liveJournal: [],
      },
      {},
    ).committed;
    expect(viaMarker[0]?.type).toBe('info');
    expect(viaMarker.filter((i) => i.type === 'info')).toHaveLength(1);
  });

  it('adds one info line when the replay is partial or degraded', () => {
    for (const flags of [
      { replayPartial: true },
      { replayDegraded: true },
      { replayPartial: true, replayDegraded: true },
    ]) {
      const { committed } = projectReplaySnapshot(
        { compactedReplay, liveJournal: [] },
        flags,
      );
      const infos = committed.filter((i) => i.type === 'info');
      expect(infos).toHaveLength(1);
      expect(committed[0]?.type).toBe('info');
    }
    // Both conditions at once: two separate lines (history hidden + incomplete).
    const both = projectReplaySnapshot(
      { compactedReplay, liveJournal: [] },
      { historyHasMore: true, replayPartial: true },
    ).committed;
    expect(both.slice(0, 2).map((i) => i.type)).toEqual(['info', 'info']);
  });

  it('commits nothing and leaves the watermark alone for an empty snapshot', () => {
    const { committed, state } = projectReplaySnapshot(
      { compactedReplay: [], liveJournal: [] },
      { ownClientId: SELF, lastEventId: 0 },
    );
    expect(committed).toEqual([]);
    expect(state.streamingState).toBe(StreamingState.Idle);
    expect(state.lastEventId).toBeUndefined();
    expect(state.ownClientId).toBe(SELF);
  });
});

describe('model and approval-mode frames', () => {
  it('model_switched sets modelId and commits nothing', () => {
    const { state, committed } = projectDaemonEvent(
      initialDaemonProjectionState(SELF),
      {
        id: 3,
        type: 'model_switched',
        data: { sessionId: 's1', modelId: 'flint(openai)' },
        originatorClientId: PHONE,
      },
    );
    expect(state.modelId).toBe('flint(openai)');
    expect(committed).toEqual([]);
  });

  it('applies model_switched that this client itself originated', () => {
    const { state } = projectDaemonEvent(initialDaemonProjectionState(SELF), {
      type: 'model_switched',
      data: { modelId: 'qwen3' },
      originatorClientId: SELF,
    });
    expect(state.modelId).toBe('qwen3');
  });

  it('ignores a model_switched frame with no usable modelId', () => {
    const start = { ...initialDaemonProjectionState(SELF), modelId: 'keep' };
    for (const data of [{}, { modelId: '' }, { modelId: 7 }]) {
      const { state } = projectDaemonEvent(start, {
        type: 'model_switched',
        data,
      });
      expect(state.modelId).toBe('keep');
    }
  });

  it('approval_mode_changed sets approvalMode from data.next', () => {
    const { state, committed } = projectDaemonEvent(
      initialDaemonProjectionState(SELF),
      {
        type: 'approval_mode_changed',
        data: { sessionId: 's1', previous: 'default', next: 'yolo' },
      },
    );
    expect(state.approvalMode).toBe('yolo');
    expect(committed).toEqual([]);
  });

  it('ignores an approval_mode_changed frame with no next', () => {
    const start = {
      ...initialDaemonProjectionState(SELF),
      approvalMode: 'plan',
    };
    const { state } = projectDaemonEvent(start, {
      type: 'approval_mode_changed',
      data: { previous: 'plan' },
    });
    expect(state.approvalMode).toBe('plan');
  });

  it('does not disturb an in-flight turn', () => {
    let state = initialDaemonProjectionState(SELF);
    state = projectDaemonEvent(
      state,
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'partial' },
      }),
    ).state;
    const next = projectDaemonEvent(state, {
      type: 'model_switched',
      data: { modelId: 'm2' },
    }).state;
    expect(next.streamingState).toBe(StreamingState.Responding);
    expect(next.pendingText).toBe('partial');
    expect(next.modelId).toBe('m2');
  });

  it('a replayed model_switched seeds modelId through projectReplaySnapshot', () => {
    const { state } = projectReplaySnapshot({
      compactedReplay: [{ type: 'model_switched', data: { modelId: 'old' } }],
      liveJournal: [],
    });
    expect(state.modelId).toBe('old');
  });
});
