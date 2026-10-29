/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test fixture: daemon frames captured for InfiniteInsight/Qwen-Code-Remote#195
 * from a live daemon with two clients on one thread session (one created it,
 * the other attached with `load`), one prompt sent each way. Abridged (fewer
 * thought tokens); the shapes, field placement and id rhythm are as captured:
 *
 * - Every frame of a turn carries the turn's `promptId` and the sender's
 *   `originatorClientId` at the top level, and both clients receive the same
 *   contiguous ids.
 * - `turn_complete` is its own frame type (not a `session_update`); its
 *   `data` holds `stopReason: 'end_turn'`, the `promptId` and a `branchPoint`.
 * - After `turn_complete` the daemon keeps publishing `agent_message_chunk`
 *   frames with empty text and NEITHER field: the execution-lifecycle markers
 *   of a background request (the managed auto-memory extractor), arriving up
 *   to about 20 s after the turn ended. Inside a turn the same kind of
 *   content-less chunk carries the turn's lifecycle markers and its usage.
 */
import type { DaemonFrame } from './projectDaemonEvent.js';

export const SESSION_ID = 'f69639c9-9e94-460c-b066-9f9e07519f45';
export const PROMPT_TEXT = 'Reply with the single word pong.';
export const HOOK_TEXT =
  '[mem0-hook] recorded 1 memory item(s) from this turn.';

interface WireFrame extends DaemonFrame {
  v: 1;
  promptId?: string;
  _meta: { serverTimestamp: number };
}

interface TurnTag {
  originatorClientId: string;
  promptId: string;
}

function frame(
  id: number,
  type: string,
  data: Record<string, unknown>,
  turn?: TurnTag,
): DaemonFrame {
  const wire: WireFrame = {
    id,
    v: 1,
    type,
    data,
    ...(turn
      ? { promptId: turn.promptId, originatorClientId: turn.originatorClientId }
      : {}),
    _meta: { serverTimestamp: 1793241190000 + id },
  };
  return wire;
}

const update = (
  id: number,
  sessionUpdate: Record<string, unknown>,
  turn?: TurnTag,
): DaemonFrame =>
  frame(
    id,
    'session_update',
    { sessionId: SESSION_ID, update: sessionUpdate },
    turn,
  );

/** A content-less chunk marking a model request's start or end. */
function lifecycleMarker(
  phase: 'started' | 'ended',
  requestPromptId: string,
  model: string,
  subagentId?: string,
): Record<string, unknown> {
  return {
    _meta: {
      executionLifecycle: {
        v: 1,
        kind: 'request',
        executionId: `exec-${requestPromptId}`,
        sessionId: SESSION_ID,
        promptId: requestPromptId,
        model,
        startedAt: 1793241190413,
        ...(subagentId ? { subagentId } : {}),
        phase,
        ...(phase === 'ended'
          ? {
              endedAt: 1793241357927,
              durationMs: 167514,
              outcome: 'success',
            }
          : {}),
      },
    },
    content: { text: '', type: 'text' },
    sessionUpdate: 'agent_message_chunk',
  };
}

/**
 * One turn sent by `originatorClientId`, ids contiguous from `firstId`,
 * through its `turn_complete` (the last frame).
 */
export function capturedTurn(
  firstId: number,
  originatorClientId: string,
  promptId: string,
): DaemonFrame[] {
  const turn = { originatorClientId, promptId };
  const request = `${SESSION_ID}########1`;
  let id = firstId;
  return [
    update(
      id++,
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: PROMPT_TEXT },
      },
      turn,
    ),
    update(id++, lifecycleMarker('started', request, 'flint'), turn),
    ...['The', ' user', ' asked', ' for', ' pong', '.'].map((text) =>
      update(
        id++,
        {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text },
        },
        turn,
      ),
    ),
    update(
      id++,
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'pong' },
      },
      turn,
    ),
    update(id++, lifecycleMarker('ended', request, 'flint'), turn),
    update(
      id++,
      {
        _meta: {
          usage: {
            inputTokens: 27203,
            outputTokens: 134,
            totalTokens: 27337,
            thoughtTokens: 134,
            cachedReadTokens: 14288,
          },
          durationMs: 167603,
        },
        content: { text: '', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      },
      turn,
    ),
    update(
      id++,
      { sessionUpdate: 'usage_update', used: 27337, size: 262144 },
      turn,
    ),
    update(
      id++,
      { sessionUpdate: 'session_info_update', title: 'Pong reply' },
      turn,
    ),
    frame(id++, 'session_metadata_updated', {
      sessionId: SESSION_ID,
      displayName: 'Pong reply',
      titleSource: 'auto',
    }),
    update(
      id++,
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: HOOK_TEXT },
      },
      turn,
    ),
    frame(
      id++,
      'turn_complete',
      {
        sessionId: SESSION_ID,
        stopReason: 'end_turn',
        promptId,
        branchPoint: {
          assistantRecordUuid: '108ed4d9-5979-4342-b14c-838dcdc77865',
          checkpointUuid: 'befb850e-32f4-419d-bda8-444a26bac977',
        },
      },
      turn,
    ),
  ];
}

/**
 * What followed every captured `turn_complete`: the memory extractor's
 * request markers, with no `promptId` and no `originatorClientId`.
 */
export function afterTurn(firstId: number): DaemonFrame[] {
  const subagentId = 'managed-auto-memory-extractor-d26bd9e2';
  const request = `${SESSION_ID}#${subagentId}#0`;
  return [
    update(
      firstId,
      lifecycleMarker('started', request, 'qwen3-classifier', subagentId),
    ),
    update(
      firstId + 1,
      lifecycleMarker('ended', request, 'qwen3-classifier', subagentId),
    ),
  ];
}

/**
 * A finished turn plus what followed it, as a later `load` returns it in
 * `compactedReplay`: the streamed thought chunks are merged into one event
 * that keeps the id of its LAST source chunk, everything else keeps its id,
 * and the load's `lastEventId` is the newest id (captured: replay ids
 * 1-5, 39-49 with `lastEventId: 49`; the live stream then went on at 50).
 */
export function compactedTurn(
  firstId: number,
  originatorClientId: string,
  promptId: string,
): { compactedReplay: DaemonFrame[]; lastEventId: number } {
  const turn = capturedTurn(firstId, originatorClientId, promptId);
  const frames = [...turn, ...afterTurn(firstId + turn.length)];
  const isThought = (f: DaemonFrame) =>
    (f.data as { update?: { sessionUpdate?: string } }).update
      ?.sessionUpdate === 'agent_thought_chunk';
  const thoughts = frames.filter(isThought);
  const last = thoughts.at(-1)!;
  const merged: DaemonFrame = {
    ...last,
    data: {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'text',
          text: thoughts
            .map(
              (f) =>
                (f.data as { update: { content: { text: string } } }).update
                  .content.text,
            )
            .join(''),
        },
      },
    },
  };
  const compactedReplay: DaemonFrame[] = [];
  for (const f of frames) {
    if (!isThought(f)) compactedReplay.push(f);
    else if (f === last) compactedReplay.push(merged);
  }
  return { compactedReplay, lastEventId: frames.at(-1)!.id! };
}

/**
 * The terminal the daemon publishes INSTEAD of `turn_complete` when the
 * prompt fails (shape from the bridge's `broadcastTurnError`, not captured
 * live): a model request that dies mid-stream surfaces as message
 * `terminated`, classified `model_stream_interrupted`.
 */
export function turnError(
  id: number,
  originatorClientId: string,
  promptId: string,
  message = 'terminated',
): DaemonFrame {
  return frame(
    id,
    'turn_error',
    {
      sessionId: SESSION_ID,
      message,
      ...(message === 'terminated'
        ? { errorKind: 'model_stream_interrupted' }
        : {}),
      promptId,
    },
    { originatorClientId, promptId },
  );
}
