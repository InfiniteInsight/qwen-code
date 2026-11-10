/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure projection from daemon SSE frames → the TUI's history/streaming shapes.
 *
 * This is the heart of the (opt-in) daemon-client TUI mode: when the terminal
 * renders a *daemon-hosted* session instead of its own in-process agent, the
 * `useDaemonStream` hook drives this reducer with frames from
 * `DaemonSessionClient.events()` and feeds the result into the SAME UI contract
 * the in-process `useGeminiStream` produces (`addItem`, `pendingHistoryItems`,
 * `thought`, `streamingState`). See
 * `packages/rc-gateway/docs/phase2-daemon-tui.md`.
 *
 * Design choices (deliberate, see the spec):
 * - **The daemon is the source of truth, but echo is origin-aware.** A
 *   `user_message_chunk` is committed as a user history item ONLY when it
 *   originated on a DIFFERENT client (the phone) — so a turn typed elsewhere
 *   appears on the terminal identically (the point of handoff). The local
 *   submitter echoes its own input immediately (responsive, matching the
 *   in-process contract); the daemon tags each frame with `originatorClientId`
 *   (verified against a live daemon), so we drop the self-echo to avoid a
 *   double-render. With no `ownClientId` configured we project unconditionally
 *   (never silently swallow the user's input).
 * - **Read text from the raw frame stream**, never from a reduced "last update"
 *   snapshot — the SDK's `reduceDaemonSessionEvent` clobbers `lastSessionUpdate`
 *   to the latest frame, which would drop interim streamed text.
 * - **Pure, dependency-free.** The input is typed structurally (a SDK
 *   `DaemonEvent` satisfies {@link DaemonFrame}) so this module adds no
 *   cross-package dependency and is trivially unit-testable against captured
 *   frames.
 *
 * Scope: covers the text turn (user echo, streamed thought + message, completion,
 * usage) AND tool-call display + the permission gate. The `tool_call` /
 * `tool_call_update` shapes + status strings (`in_progress`/`completed`) are
 * grounded in a captured tool turn; `permission_request` / `permission_resolved`
 * are built against the SDK's typed shapes (this daemon config auto-approves
 * builtin reads, so the gate is exercised with synthetic frames in tests). The
 * reducer produces DISPLAY + gate state only — the hook owns the actual vote.
 *
 * Known slice-1 gaps to reconcile at integration:
 * - **A turn ends on `turn_complete` or `turn_error`** (a failed prompt; it
 *   commits an error line). `stream_error` and `session_died` are left to the
 *   hook: the stream closing finalizes the turn there, and `session_died`
 *   ends an attached tab.
 * - **Thoughts stream live and commit as collapsible `gemini_thought` blocks**
 *   when the reasoning sub-turn finishes (on assistant prose, tool activity,
 *   or turn end), and assistant text commits as `gemini`.
 */
import { basename } from 'node:path';
import * as Diff from 'diff';
import { CompressionStatus } from '@qwen-code/qwen-code-core/core/turn.js';
import type { GoalSnapshotV2 } from '@qwen-code/qwen-code-core/goals/index.js';
import {
  StreamingState,
  ToolCallStatus,
  isGoalStatusKind,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
  type ThoughtSummary,
} from '../../types.js';

/**
 * Minimal structural shape of a daemon SSE frame. The SDK's `DaemonEvent`
 * ({ id?, v, type, data, originatorClientId? }) is a superset, so it is
 * assignable here without importing it.
 */
export interface DaemonFrame {
  type: string;
  id?: number;
  data?: unknown;
  /** Client that originated this frame's turn; used to drop self-echoes. */
  originatorClientId?: string;
}

/** Token/usage accounting carried by the terminal `agent_message_chunk`. */
export interface DaemonTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  durationMs?: number;
}

/**
 * An in-flight tool-approval gate. The reducer records WHICH tool needs
 * approval and the daemon-defined option set; the hook builds the actual
 * vote (`respondToSessionPermission`) from this — the in-process
 * `ToolConfirmationOutcome` is NOT 1:1 with these opaque `optionId`s.
 */
export interface PendingPermission {
  requestId: string;
  toolCallId?: string;
  /** Human-readable tool title (e.g. "Writing to /tmp/x"); shown in the prompt. */
  title?: string;
  /** Raw ACP toolCall payload from the permission request (kind, rawInput, content, _meta). */
  toolCall?: Record<string, unknown>;
  /**
   * Daemon-defined options. Each carries an ACP `kind`
   * (`allow_once`/`allow_always`/`reject_once`/`reject_always`) the hook maps a
   * `ToolConfirmationOutcome` onto.
   */
  options: Array<{ optionId: string; kind?: string; [key: string]: unknown }>;
}

export interface DaemonProjectionState {
  streamingState: StreamingState;
  /** In-flight assistant text for the current turn (the pending `gemini` item). */
  pendingText: string;
  /** In-flight reasoning text for the current sub-turn (streamed live, then committed as `gemini_thought`). */
  pendingThought: string;
  /** Usage from the most recent terminal `agent_message_chunk`, if any. */
  lastUsage?: DaemonTurnUsage;
  /** Tool calls seen this turn, in arrival order (live display + tool_group). */
  tools: IndividualToolCallDisplay[];
  /** The active approval gate, if a `permission_request` is outstanding. */
  pendingPermission?: PendingPermission;
  /**
   * This client's daemon clientId. When set, `user_message_chunk` frames whose
   * `originatorClientId` matches are treated as self-echoes and NOT committed
   * (the submitter already rendered its own input locally).
   */
  ownClientId?: string;
  /**
   * Highest daemon event `id` folded in so far (monotonic watermark). Frames with
   * an `id` at or below this are skipped as duplicates — a defense against a
   * double-subscribe / ring re-replay (e.g. React StrictMode remount) delivering
   * already-seen frames. Locally-synthesized frames (no `id`) are never deduped.
   */
  lastEventId?: number;
  /**
   * The model the daemon says this session runs (`model_switched.modelId`, or
   * the load response's `models.currentModelId`). Unset until the daemon says.
   */
  modelId?: string;
  /** The session's approval mode (`approval_mode_changed.next`, or load state). */
  approvalMode?: string;
  /** The session's display title (`session_info_update.title` or `session_metadata_updated.displayName`). */
  sessionTitle?: string;
  /** In-flight user shell command (`user_shell_command`), if any. */
  pendingShellCommand?: string;
  /** Accumulated stdout/stderr for an in-flight user shell command (`shell_output`). */
  pendingShellOutput?: string;
}

export interface ProjectionResult {
  state: DaemonProjectionState;
  /** History items to `addItem` as a result of this frame, in order. */
  committed: HistoryItemWithoutId[];
}

export function initialDaemonProjectionState(
  ownClientId?: string,
): DaemonProjectionState {
  return {
    streamingState: StreamingState.Idle,
    pendingText: '',
    pendingThought: '',
    tools: [],
    ownClientId,
  };
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const textOf = (update: Record<string, unknown>): string => {
  const content = asRecord(update['content']);
  return typeof content['text'] === 'string' ? (content['text'] as string) : '';
};

/**
 * Whether a message chunk carries something to show: non-empty text, or a
 * non-text block (an image the assistant produced). Usage and request
 * lifecycle chunks carry `{ type: 'text', text: '' }` plus `_meta` only.
 */
const hasChunkContent = (update: Record<string, unknown>): boolean => {
  const content = asRecord(update['content']);
  if (typeof content['text'] === 'string') return content['text'].length > 0;
  return Object.keys(content).length > 0;
};

const readUsage = (
  update: Record<string, unknown>,
): DaemonTurnUsage | undefined => {
  const meta = asRecord(update['_meta']);
  const usage = asRecord(meta['usage']);
  if (Object.keys(usage).length === 0 && meta['durationMs'] === undefined) {
    return undefined;
  }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : undefined;
  return {
    inputTokens: num(usage['inputTokens']),
    outputTokens: num(usage['outputTokens']),
    totalTokens: num(usage['totalTokens']),
    thoughtTokens: num(usage['thoughtTokens']),
    cachedReadTokens: num(usage['cachedReadTokens']),
    durationMs: num(usage['durationMs'] ?? meta['durationMs']),
  };
};

/**
 * Map the daemon's ACP tool status string → the UI's {@link ToolCallStatus}.
 * Values grounded in a captured tool turn (`in_progress`, `completed`); the
 * remaining ACP states (`pending`, `failed`) round out the set.
 */
function mapToolStatus(s: unknown): ToolCallStatus {
  switch (s) {
    case 'pending':
      return ToolCallStatus.Pending;
    case 'in_progress':
      return ToolCallStatus.Executing;
    case 'completed':
      return ToolCallStatus.Success;
    case 'failed':
      return ToolCallStatus.Error;
    case 'canceled':
    case 'cancelled':
      return ToolCallStatus.Canceled;
    default:
      return ToolCallStatus.Pending;
  }
}

/**
 * Resolve a tool's status across explicit `status` strings and `_meta.toolLifecycle`
 * updates (which omit `update.status` and would otherwise reset an in-progress
 * or completed tool back to `Pending`).
 */
function resolveToolStatus(
  update: Record<string, unknown>,
  meta: Record<string, unknown>,
  prevStatus: ToolCallStatus | undefined,
): ToolCallStatus {
  const lifecycle = asRecord(meta['toolLifecycle']);
  const outcome = lifecycle['outcome'] ?? lifecycle['executionStatus'];
  const isMetaCancelled =
    meta['toolStatus'] === 'cancelled' ||
    meta['toolStatus'] === 'canceled' ||
    meta['preparationDiscarded'] === true ||
    outcome === 'cancelled' ||
    outcome === 'canceled';
  if (typeof update['status'] === 'string') {
    if (
      update['status'] === 'failed' &&
      (isMetaCancelled || prevStatus === ToolCallStatus.Canceled)
    ) {
      return ToolCallStatus.Canceled;
    }
    return mapToolStatus(update['status']);
  }
  if (isMetaCancelled) {
    return ToolCallStatus.Canceled;
  }
  switch (outcome) {
    case 'success':
      return ToolCallStatus.Success;
    case 'error':
    case 'failed':
      return ToolCallStatus.Error;
    case 'canceled':
    case 'cancelled':
      return ToolCallStatus.Canceled;
    case 'running':
      return prevStatus ?? ToolCallStatus.Executing;
    default:
      break;
  }
  if (lifecycle['phase'] === 'started') {
    return prevStatus ?? ToolCallStatus.Executing;
  }
  return prevStatus ?? ToolCallStatus.Pending;
}

function isTerminalToolStatus(status: ToolCallStatus): boolean {
  return (
    status === ToolCallStatus.Success ||
    status === ToolCallStatus.Error ||
    status === ToolCallStatus.Canceled
  );
}

function areAllToolsTerminal(tools: IndividualToolCallDisplay[]): boolean {
  return tools.length > 0 && tools.every((t) => isTerminalToolStatus(t.status));
}

export const MAX_PENDING_THOUGHT_CHARS = 4_096;
export const MAX_TOOL_RESULT_DISPLAY_CHARS = 32_000;

function appendPendingThought(current: string, chunk: string): string {
  if (!chunk || current.length >= MAX_PENDING_THOUGHT_CHARS) {
    return current;
  }
  const remaining = MAX_PENDING_THOUGHT_CHARS - current.length;
  return (
    current + (chunk.length <= remaining ? chunk : chunk.slice(0, remaining))
  );
}

function capToolResultText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_DISPLAY_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_DISPLAY_CHARS)}\n[... truncated from ${text.length} characters for CLI history display ...]`;
}

function isIgnoredSubagentOrProgressUpdate(
  update: Record<string, unknown>,
): boolean {
  const meta = asRecord(update['_meta']);
  if (
    (update['sessionUpdate'] === 'tool_call' ||
      update['sessionUpdate'] === 'tool_call_update') &&
    update['status'] === 'in_progress' &&
    typeof update['kind'] !== 'string' &&
    (meta['shellProgress'] !== undefined || meta['subagentProgress'] === true)
  ) {
    return true;
  }
  const parent = meta['parentToolCallId'];
  return (
    typeof parent === 'string' &&
    parent.length > 0 &&
    parent !== update['toolCallId']
  );
}

/** Join the text of ACP content blocks (`[{content:{text}}]`) into a string. */
function resultTextOf(update: Record<string, unknown>): string | undefined {
  const content = update['content'];
  if (Array.isArray(content)) {
    const text = content
      .map((b) => {
        const inner = asRecord(asRecord(b)['content']);
        return typeof inner['text'] === 'string'
          ? (inner['text'] as string)
          : '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return capToolResultText(text);
  }
  return typeof update['rawOutput'] === 'string'
    ? capToolResultText(update['rawOutput'] as string)
    : undefined;
}

function isAgentToolUpdate(
  toolName: string,
  rawInput: Record<string, unknown>,
  rawOutput: Record<string, unknown>,
): boolean {
  const lower = toolName.toLowerCase();
  return (
    lower === 'agent' ||
    lower === 'task' ||
    typeof rawInput['subagent_type'] === 'string' ||
    rawOutput['type'] === 'task_execution'
  );
}

function mapToolStatusToTaskStatus(
  status: ToolCallStatus,
  runInBackground: boolean,
  explicitStatus: unknown,
): 'running' | 'completed' | 'failed' | 'cancelled' | 'background' {
  if (
    explicitStatus === 'running' ||
    explicitStatus === 'completed' ||
    explicitStatus === 'failed' ||
    explicitStatus === 'cancelled' ||
    explicitStatus === 'background'
  ) {
    return explicitStatus;
  }
  switch (status) {
    case ToolCallStatus.Success:
      return runInBackground ? 'background' : 'completed';
    case ToolCallStatus.Error:
      return 'failed';
    case ToolCallStatus.Canceled:
      return 'cancelled';
    default:
      return runInBackground ? 'background' : 'running';
  }
}

function resolveResultDisplay(
  update: Record<string, unknown>,
  meta: Record<string, unknown>,
  toolName: string,
  title: string | undefined,
  status: ToolCallStatus,
  prevResultDisplay: IndividualToolCallDisplay['resultDisplay'],
): IndividualToolCallDisplay['resultDisplay'] {
  const rawInput = asRecord(update['rawInput']);
  const rawOutput = asRecord(update['rawOutput']);
  const textResult = resultTextOf(update);

  if (isAgentToolUpdate(toolName, rawInput, rawOutput)) {
    const prevTask =
      typeof prevResultDisplay === 'object' &&
      prevResultDisplay !== null &&
      (prevResultDisplay as { type?: unknown }).type === 'task_execution'
        ? (prevResultDisplay as unknown as Record<string, unknown>)
        : undefined;
    const subagentName =
      (typeof rawOutput['subagentName'] === 'string' &&
        rawOutput['subagentName']) ||
      (typeof rawInput['name'] === 'string' && rawInput['name']) ||
      (typeof rawInput['subagent_type'] === 'string' &&
        rawInput['subagent_type']) ||
      (typeof meta['subagentType'] === 'string' && meta['subagentType']) ||
      (typeof prevTask?.['subagentName'] === 'string' &&
        (prevTask['subagentName'] as string)) ||
      'agent';
    const rawDesc =
      (typeof rawOutput['taskDescription'] === 'string' &&
        rawOutput['taskDescription']) ||
      (typeof rawInput['description'] === 'string' &&
        rawInput['description']) ||
      (typeof prevTask?.['taskDescription'] === 'string' &&
        (prevTask['taskDescription'] as string)) ||
      (title ? title.replace(/^(Task|Agent):\s*/i, '') : '');
    const taskPrompt =
      (typeof rawOutput['taskPrompt'] === 'string' &&
        rawOutput['taskPrompt']) ||
      (typeof rawInput['prompt'] === 'string' && rawInput['prompt']) ||
      (typeof prevTask?.['taskPrompt'] === 'string' &&
        (prevTask['taskPrompt'] as string)) ||
      '';
    const runInBackground =
      rawInput['run_in_background'] === true ||
      rawOutput['executionMode'] === 'background' ||
      prevTask?.['executionMode'] === 'background' ||
      prevTask?.['status'] === 'background';
    const taskStatus = mapToolStatusToTaskStatus(
      status,
      runInBackground,
      rawOutput['status'],
    );
    const nextTask: Record<string, unknown> = {
      ...(prevTask ?? {}),
      ...(rawOutput['type'] === 'task_execution' ? rawOutput : {}),
      type: 'task_execution',
      subagentName,
      taskDescription: rawDesc,
      taskPrompt,
      status: taskStatus,
      ...(textResult !== undefined
        ? { result: textResult }
        : prevTask?.['result'] !== undefined
          ? { result: prevTask['result'] }
          : {}),
    };
    if (prevTask && JSON.stringify(prevTask) === JSON.stringify(nextTask)) {
      return prevResultDisplay;
    }
    return nextTask as unknown as IndividualToolCallDisplay['resultDisplay'];
  }

  if (
    rawOutput['type'] === 'todo_list' ||
    rawOutput['type'] === 'plan_summary' ||
    rawOutput['type'] === 'findings_list' ||
    typeof rawOutput['fileDiff'] === 'string'
  ) {
    return rawOutput as unknown as IndividualToolCallDisplay['resultDisplay'];
  }

  if (
    toolName.toLowerCase() === 'todo_write' &&
    Array.isArray(rawInput['todos'])
  ) {
    const todos = (rawInput['todos'] as unknown[]).map((entry, idx) => {
      const item = asRecord(entry);
      const rawStatus = item['status'];
      const todoStatus: 'pending' | 'in_progress' | 'completed' =
        rawStatus === 'in_progress' || rawStatus === 'completed'
          ? rawStatus
          : 'pending';
      return {
        id: String(item['id'] ?? idx + 1),
        content: String(item['content'] ?? ''),
        status: todoStatus,
        ...(Array.isArray(item['blockedBy'])
          ? { blockedBy: (item['blockedBy'] as unknown[]).map(String) }
          : {}),
      };
    });
    return {
      type: 'todo_list',
      todos,
    } as unknown as IndividualToolCallDisplay['resultDisplay'];
  }

  const contentBlocks = Array.isArray(update['content'])
    ? (update['content'] as unknown[])
    : [];
  const diffBlock = contentBlocks
    .map(asRecord)
    .find((b) => b['type'] === 'diff' && typeof b['newText'] === 'string');
  if (diffBlock) {
    const filePath =
      (typeof diffBlock['path'] === 'string' && diffBlock['path']) ||
      (typeof rawInput['file_path'] === 'string' && rawInput['file_path']) ||
      'file';
    const fileName = basename(filePath) || filePath;
    const originalContent =
      typeof diffBlock['oldText'] === 'string' ? diffBlock['oldText'] : '';
    const newContent = diffBlock['newText'] as string;
    const fileDiff = Diff.createPatch(
      fileName,
      originalContent,
      newContent,
      'Current',
      'Proposed',
      { context: 3 },
    );
    return {
      fileDiff,
      fileName,
      filePath,
      originalContent,
      newContent,
    } as unknown as IndividualToolCallDisplay['resultDisplay'];
  }

  return textResult ?? prevResultDisplay;
}

/** Upsert a tool-call display from a `tool_call` / `tool_call_update` frame. */
function upsertTool(
  tools: IndividualToolCallDisplay[],
  update: Record<string, unknown>,
): IndividualToolCallDisplay[] {
  const callId = String(update['toolCallId'] ?? '');
  if (!callId) return tools;
  const meta = asRecord(update['_meta']);
  const title =
    typeof update['title'] === 'string' && update['title'].length > 0
      ? (update['title'] as string)
      : undefined;
  const prev = tools.find((t) => t.callId === callId);
  const name =
    (typeof meta['toolName'] === 'string' && (meta['toolName'] as string)) ||
    prev?.name ||
    title ||
    'tool';
  const description =
    title ??
    (update['rawInput'] !== undefined
      ? JSON.stringify(update['rawInput'])
      : name);
  const status = resolveToolStatus(update, meta, prev?.status);
  const resultDisplay = resolveResultDisplay(
    update,
    meta,
    name,
    title,
    status,
    prev?.resultDisplay,
  );

  const next: IndividualToolCallDisplay = {
    callId,
    name,
    description: title ?? prev?.description ?? description,
    status,
    // The reducer never builds the imperative onConfirm closure; the hook fills
    // confirmationDetails when a permission_request targets this call.
    confirmationDetails: prev?.confirmationDetails,
    resultDisplay,
    renderOutputAsMarkdown: true,
  };
  if (
    prev &&
    prev.name === next.name &&
    prev.description === next.description &&
    prev.status === next.status &&
    prev.confirmationDetails === next.confirmationDetails &&
    prev.resultDisplay === next.resultDisplay &&
    prev.renderOutputAsMarkdown === next.renderOutputAsMarkdown
  ) {
    return tools;
  }
  return prev
    ? tools.map((t) => (t.callId === callId ? next : t))
    : [...tools, next];
}

/** Set a tool's status by id (used by the permission gate transitions). */
function setToolStatus(
  tools: IndividualToolCallDisplay[],
  callId: string | undefined,
  status: ToolCallStatus,
): IndividualToolCallDisplay[] {
  if (!callId) return tools;
  return tools.map((t) => (t.callId === callId ? { ...t, status } : t));
}

/**
 * Commit the in-flight turn (tool group or standalone thought, then assistant
 * message) and clear the pending buffers. Shared by `turn_complete`,
 * `turn_error` and the replay turn-segmentation in `user_message_chunk`
 * (history replay sends no `turn_complete` between turns, so a new user message
 * marks the previous assistant turn done).
 */
function flushPendingTurn(state: DaemonProjectionState): {
  committed: HistoryItemWithoutId[];
  state: DaemonProjectionState;
} {
  const committed: HistoryItemWithoutId[] = [];
  if (state.tools.length > 0) {
    committed.push({ type: 'tool_group', tools: state.tools });
  } else if (state.pendingThought.trim().length > 0) {
    committed.push({ type: 'gemini_thought', text: state.pendingThought });
  }
  if (state.pendingText.trim().length > 0) {
    committed.push({ type: 'gemini', text: state.pendingText });
  }
  return {
    committed,
    state: { ...state, pendingText: '', pendingThought: '', tools: [] },
  };
}

/**
 * Commit any pre-tool reasoning (`gemini_thought`), pre-tool assistant text
 * (`gemini`), and any already-terminal tool group that preceded them when a
 * tool call or approval gate starts, so each sub-turn's thought and prose
 * commit above its tool group (`InfiniteInsight/Qwen-Code-Remote#247`, `#527`).
 */
function flushBeforeToolActivity(state: DaemonProjectionState): {
  committed: HistoryItemWithoutId[];
  state: DaemonProjectionState;
} {
  const canFlushThought =
    state.tools.length === 0 || areAllToolsTerminal(state.tools);
  const hasThought = canFlushThought && state.pendingThought.trim().length > 0;
  const hasText = state.pendingText.trim().length > 0;
  if (!hasThought && !hasText) {
    if (state.pendingText === '' && state.pendingThought === '') {
      return { committed: [], state };
    }
    return {
      committed: [],
      state: {
        ...state,
        pendingText: '',
        pendingThought: '',
      },
    };
  }
  const committed: HistoryItemWithoutId[] = [];
  let tools = state.tools;
  if (areAllToolsTerminal(tools)) {
    committed.push({ type: 'tool_group', tools });
    tools = [];
  }
  if (hasThought) {
    committed.push({ type: 'gemini_thought', text: state.pendingThought });
  }
  if (hasText) {
    committed.push({ type: 'gemini', text: state.pendingText });
  }
  return {
    committed,
    state: {
      ...state,
      tools,
      pendingText: '',
      pendingThought: '',
    },
  };
}

function projectSessionUpdate(
  state: DaemonProjectionState,
  data: Record<string, unknown>,
  originatorClientId: string | undefined,
): ProjectionResult {
  const update = asRecord(data['update']);
  if (isIgnoredSubagentOrProgressUpdate(update)) {
    return { state, committed: [] };
  }
  const kind = update['sessionUpdate'];
  const text = textOf(update);

  switch (kind) {
    case 'user_message_chunk': {
      // A new user message ends the previous assistant turn — flush it first
      // (replay sends no `turn_complete` between turns). In the live path the
      // previous turn already committed, so the flush is a no-op.
      const flushed = flushPendingTurn(state);
      // Drop our OWN echo (the submitter rendered it locally); render turns that
      // originated on another client (the phone) or on replay (the original
      // originator, not us). Unknown origin → render.
      const isSelfEcho =
        state.ownClientId !== undefined &&
        originatorClientId === state.ownClientId;
      const meta = asRecord(update['_meta']);
      const promptId =
        typeof meta['promptId'] === 'string' && meta['promptId'].length > 0
          ? meta['promptId']
          : undefined;
      const committed = [...flushed.committed];
      if (text && !isSelfEcho) {
        committed.push({
          type: 'user',
          text,
          ...(promptId ? { promptId } : {}),
        });
      }
      return {
        state: {
          ...flushed.state,
          streamingState: StreamingState.Responding,
        },
        committed,
      };
    }

    case 'agent_thought_chunk': {
      // A new reasoning sub-turn after a completed tool batch (or after prior
      // assistant text) commits the finished sub-turn and starts fresh
      // reasoning instead of concatenating thoughts across the entire turn.
      if (
        areAllToolsTerminal(state.tools) ||
        state.pendingText.trim().length > 0
      ) {
        const flushed = flushPendingTurn(state);
        return {
          state: {
            ...flushed.state,
            streamingState: StreamingState.Responding,
            pendingThought: appendPendingThought('', text),
          },
          committed: flushed.committed,
        };
      }
      const nextPendingThought = appendPendingThought(
        state.pendingThought,
        text,
      );
      if (
        nextPendingThought === state.pendingThought &&
        state.streamingState === StreamingState.Responding
      ) {
        return { state, committed: [] };
      }
      return {
        state: {
          ...state,
          streamingState: StreamingState.Responding,
          pendingThought: nextPendingThought,
        },
        committed: [],
      };
    }

    case 'agent_message_chunk': {
      const usage = readUsage(update);
      const meta = asRecord(update['_meta']);
      const committed: HistoryItemWithoutId[] = [];
      let tools = state.tools;
      let pendingThought = state.pendingThought;
      let suppressChunkText = false;

      const goalStatus = asRecord(meta['goalStatus']);
      if (
        isGoalStatusKind(goalStatus['kind']) &&
        typeof goalStatus['condition'] === 'string'
      ) {
        committed.push({
          type: 'goal_status',
          kind: goalStatus['kind'],
          condition: goalStatus['condition'],
          ...(typeof goalStatus['iterations'] === 'number'
            ? { iterations: goalStatus['iterations'] }
            : {}),
          ...(typeof goalStatus['setAt'] === 'number'
            ? { setAt: goalStatus['setAt'] }
            : {}),
          ...(typeof goalStatus['durationMs'] === 'number'
            ? { durationMs: goalStatus['durationMs'] }
            : {}),
          ...(typeof goalStatus['lastReason'] === 'string'
            ? { lastReason: goalStatus['lastReason'] }
            : {}),
        });
      } else {
        const goalState = asRecord(meta['goalState']);
        if (typeof goalState['v'] === 'number') {
          committed.push({
            type: 'goal_state',
            snapshot: goalState as unknown as GoalSnapshotV2,
          });
        }
      }

      const stopHookLoop = asRecord(meta['stopHookLoop']);
      if (typeof stopHookLoop['iterationCount'] === 'number') {
        committed.push({
          type: 'stop_hook_loop',
          iterationCount: stopHookLoop['iterationCount'],
          reasons: Array.isArray(stopHookLoop['reasons'])
            ? (stopHookLoop['reasons'] as unknown[]).map(String)
            : [],
          stopHookCount:
            typeof stopHookLoop['stopHookCount'] === 'number'
              ? stopHookLoop['stopHookCount']
              : 0,
        });
      }

      if (meta['source'] === 'vision_bridge_notice' && text.trim().length > 0) {
        committed.push({
          type: 'vision_notice',
          text: text.trim(),
        });
        suppressChunkText = true;
      }

      const cc = asRecord(meta['contextCompression']);
      if (typeof cc['phase'] === 'string') {
        suppressChunkText = true;
        if (
          cc['phase'] === 'done' &&
          typeof cc['originalTokenCount'] === 'number' &&
          typeof cc['newTokenCount'] === 'number'
        ) {
          committed.push({
            type: 'compression',
            compression: {
              isPending: false,
              originalTokenCount: cc['originalTokenCount'],
              newTokenCount: cc['newTokenCount'],
              compressionStatus: CompressionStatus.COMPRESSED,
              ...(cc['originalTokenCountIsEstimated'] === true
                ? { originalTokenCountIsEstimated: true }
                : {}),
              ...(cc['newTokenCountIsEstimated'] === true
                ? { newTokenCountIsEstimated: true }
                : {}),
            },
          });
        } else if (cc['phase'] === 'noop') {
          committed.push({
            type: 'compression',
            compression: {
              isPending: false,
              originalTokenCount: null,
              newTokenCount: null,
              compressionStatus: CompressionStatus.NOOP,
            },
          });
        }
      }

      const effectiveText = suppressChunkText ? '' : text;
      if (effectiveText.trim().length > 0) {
        if (areAllToolsTerminal(tools)) {
          committed.push({ type: 'tool_group', tools });
          tools = [];
          pendingThought = '';
        } else if (tools.length === 0 && pendingThought.trim().length > 0) {
          committed.push({ type: 'gemini_thought', text: pendingThought });
          pendingThought = '';
        }
      }
      // A chunk with nothing to show is not evidence that a turn is
      // running. The daemon sends such chunks for usage and for model
      // request lifecycle markers, and keeps sending them AFTER
      // `turn_complete` for background requests (the memory extractor),
      // with no promptId or originator. Letting one set Responding
      // reopened a finished turn: the tab kept its thinking row and
      // `esc to cancel` after the reply had rendered (#195).
      const nextStreamingState = hasChunkContent(update)
        ? StreamingState.Responding
        : state.streamingState;
      const nextPendingText = state.pendingText + effectiveText;
      const nextLastUsage = usage ?? state.lastUsage;
      if (
        committed.length === 0 &&
        tools === state.tools &&
        pendingThought === state.pendingThought &&
        nextPendingText === state.pendingText &&
        nextStreamingState === state.streamingState &&
        nextLastUsage === state.lastUsage
      ) {
        return { state, committed: [] };
      }
      return {
        state: {
          ...state,
          streamingState: nextStreamingState,
          tools,
          pendingThought,
          pendingText: nextPendingText,
          lastUsage: nextLastUsage,
        },
        committed,
      };
    }

    case 'session_info_update': {
      const title =
        typeof update['title'] === 'string' ? update['title'].trim() : '';
      if (!title || state.sessionTitle === title) {
        return { state, committed: [] };
      }
      return {
        state: {
          ...state,
          sessionTitle: title,
        },
        committed: [],
      };
    }

    case 'shell_output': {
      const chunk =
        typeof update['output'] === 'string' ? update['output'] : '';
      if (!chunk) {
        return { state, committed: [] };
      }
      const nextShellOutput = capToolResultText(
        (state.pendingShellOutput ?? '') + chunk,
      );
      const shellTool: IndividualToolCallDisplay = {
        callId: 'user-shell',
        name: 'Shell Command',
        description: state.pendingShellCommand ?? 'Shell Command',
        status: ToolCallStatus.Executing,
        confirmationDetails: undefined,
        resultDisplay: nextShellOutput,
        renderOutputAsMarkdown: false,
      };
      const prevIdx = state.tools.findIndex((t) => t.callId === 'user-shell');
      const tools =
        prevIdx >= 0
          ? state.tools.map((t, i) => (i === prevIdx ? shellTool : t))
          : [...state.tools, shellTool];
      return {
        state: {
          ...state,
          streamingState: StreamingState.Responding,
          pendingShellOutput: nextShellOutput,
          tools,
        },
        committed: [],
      };
    }

    case 'plan': {
      const rawEntries = Array.isArray(update['entries'])
        ? (update['entries'] as unknown[])
        : [];
      const todos = rawEntries.map((entry, idx) => {
        const item = asRecord(entry);
        const entryMeta = asRecord(item['_meta']);
        const qwenTodo = asRecord(entryMeta['qwenTodo']);
        const rawStatus = item['status'];
        const status: 'pending' | 'in_progress' | 'completed' =
          rawStatus === 'in_progress' || rawStatus === 'completed'
            ? rawStatus
            : 'pending';
        return {
          id: String(qwenTodo['id'] ?? idx + 1),
          content: String(item['content'] ?? ''),
          status,
          ...(Array.isArray(qwenTodo['blockedBy'])
            ? { blockedBy: (qwenTodo['blockedBy'] as unknown[]).map(String) }
            : {}),
        };
      });
      const meta = asRecord(update['_meta']);
      const qwenTranscript = asRecord(meta['qwenTranscript']);
      const callId =
        typeof qwenTranscript['planToolCallId'] === 'string' &&
        qwenTranscript['planToolCallId'].length > 0
          ? qwenTranscript['planToolCallId']
          : 'todo_write_plan';
      const flushed = flushBeforeToolActivity(state);
      const todoTool: IndividualToolCallDisplay = {
        callId,
        name: 'todo_write',
        description: 'TodoWrite',
        status: ToolCallStatus.Success,
        confirmationDetails: undefined,
        resultDisplay: {
          type: 'todo_list',
          todos,
        } as unknown as IndividualToolCallDisplay['resultDisplay'],
        renderOutputAsMarkdown: false,
      };
      const prevIdx = flushed.state.tools.findIndex((t) => t.callId === callId);
      const tools =
        prevIdx >= 0
          ? flushed.state.tools.map((t, i) => (i === prevIdx ? todoTool : t))
          : [...flushed.state.tools, todoTool];
      return {
        state: {
          ...flushed.state,
          streamingState: StreamingState.Responding,
          tools,
        },
        committed: flushed.committed,
      };
    }

    case 'usage_update': {
      const used = update['used'];
      if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) {
        return { state, committed: [] };
      }
      if (state.lastUsage?.inputTokens === used) {
        return { state, committed: [] };
      }
      return {
        state: {
          ...state,
          lastUsage: {
            ...state.lastUsage,
            inputTokens: used,
          },
        },
        committed: [],
      };
    }

    case 'tool_call':
    case 'tool_call_update': {
      const flushed = flushBeforeToolActivity(state);
      const tools = upsertTool(flushed.state.tools, update);
      if (
        flushed.state === state &&
        flushed.committed.length === 0 &&
        tools === state.tools &&
        state.streamingState === StreamingState.Responding
      ) {
        return { state, committed: [] };
      }
      return {
        state: {
          ...flushed.state,
          streamingState: StreamingState.Responding,
          tools,
        },
        committed: flushed.committed,
      };
    }

    // `available_commands_update` (and any other update kind) does not affect
    // the streamed turn in this slice.
    default:
      return { state, committed: [] };
  }
}

/** The one history line a `turn_error` adds (`data.message`, `errorKind`). */
function turnErrorText(data: Record<string, unknown>): string {
  const message =
    typeof data['message'] === 'string' && data['message'].trim()
      ? data['message'].trim()
      : 'unknown error';
  return data['errorKind'] === 'model_stream_interrupted'
    ? `The reply stopped: the connection to the model was lost (${message}).`
    : `The turn failed: ${message}`;
}

/** Extract a `toolCallId` from an opaque ACP `toolCall` object if present. */
function toolCallIdOf(toolCall: unknown): string | undefined {
  const tc = asRecord(toolCall);
  const id = tc['toolCallId'] ?? tc['callId'] ?? tc['id'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * Fold one daemon frame into the projection state, returning the next state and
 * any history items to commit. Pure: same input → same output, no side effects.
 *
 * Dedups by the monotonic event `id`: a frame at or below the watermark was
 * already folded in (a double-subscribe / ring re-replay can re-deliver it), so it
 * is skipped. Frames without an `id` (locally-synthesized `turn_complete`) always
 * apply. On apply, the watermark advances to the frame's `id`.
 */
export function projectDaemonEvent(
  state: DaemonProjectionState,
  frame: DaemonFrame,
): ProjectionResult {
  if (
    typeof frame.id === 'number' &&
    state.lastEventId !== undefined &&
    frame.id <= state.lastEventId
  ) {
    return { state, committed: [] };
  }
  const result = projectFrame(state, frame);
  if (typeof frame.id === 'number') {
    result.state = {
      ...result.state,
      lastEventId: Math.max(state.lastEventId ?? 0, frame.id),
    };
  }
  return result;
}

function projectFrame(
  state: DaemonProjectionState,
  frame: DaemonFrame,
): ProjectionResult {
  const data = asRecord(frame.data);
  switch (frame.type) {
    case 'session_update':
      return projectSessionUpdate(state, data, frame.originatorClientId);

    case 'permission_request': {
      // A tool wants approval. Mark the targeted call Confirming and record the
      // gate so the hook can render options + post a vote. (Typed-shape based:
      // this daemon config auto-approves builtin reads, so it's exercised with
      // synthetic frames; the shape is the SDK's DaemonPermissionRequestData.)
      const requestId = String(data['requestId'] ?? '');
      if (!requestId) return { state, committed: [] };
      const toolCall = asRecord(data['toolCall']);
      const toolCallId = toolCallIdOf(data['toolCall']);
      const title =
        typeof toolCall['title'] === 'string'
          ? (toolCall['title'] as string)
          : undefined;
      const options = Array.isArray(data['options'])
        ? (data['options'] as PendingPermission['options'])
        : [];
      // Seed the tool display from the request's OWN toolCall, then mark it
      // Confirming. Edits arrive ONLY as a permission_request — no preceding
      // `tool_call` frame (verified against a live daemon) — so without this the
      // gated tool would never render. A run_shell_command DOES send a prior
      // `tool_call`; there `upsertTool` just refreshes the existing entry.
      const flushed = flushBeforeToolActivity(state);
      let tools = flushed.state.tools;
      if (toolCallId) {
        tools = setToolStatus(
          upsertTool(tools, toolCall),
          toolCallId,
          ToolCallStatus.Confirming,
        );
      }
      return {
        state: {
          ...flushed.state,
          streamingState: StreamingState.WaitingForConfirmation,
          tools,
          pendingPermission: {
            requestId,
            toolCallId,
            title,
            ...(Object.keys(toolCall).length > 0 ? { toolCall } : {}),
            options,
          },
        },
        committed: flushed.committed,
      };
    }

    case 'permission_resolved':
    case 'permission_already_resolved': {
      const requestId = String(data['requestId'] ?? '');
      if (
        state.pendingPermission &&
        requestId &&
        state.pendingPermission.requestId !== requestId
      ) {
        // A different gate resolved — leave ours intact.
        return { state, committed: [] };
      }
      const outcome = asRecord(data['outcome'])['outcome'] ?? data['outcome'];
      const cancelled = outcome === 'cancelled';
      const callId =
        state.pendingPermission?.toolCallId ??
        (typeof data['toolCallId'] === 'string'
          ? data['toolCallId']
          : undefined);
      return {
        state: {
          ...state,
          streamingState: StreamingState.Responding,
          tools: setToolStatus(
            state.tools,
            callId,
            cancelled ? ToolCallStatus.Canceled : ToolCallStatus.Executing,
          ),
          pendingPermission: undefined,
        },
        committed: [],
      };
    }

    case 'prompt_cancelled':
    case 'turn_complete': {
      // Commit this turn (tool group, then assistant message) and go Idle.
      const flushed = flushPendingTurn(state);
      return {
        state: {
          ...flushed.state,
          streamingState: StreamingState.Idle,
          pendingPermission: undefined,
        },
        committed: flushed.committed,
      };
    }

    case 'turn_error': {
      // A failed prompt's terminal: the daemon publishes this INSTEAD of
      // `turn_complete` (the model request died mid-stream, a rate limit, a
      // loop guard), for whichever client sent the turn. Keep what was said
      // so far, say why it stopped, and go Idle.
      const flushed = flushPendingTurn(state);
      return {
        state: {
          ...flushed.state,
          streamingState: StreamingState.Idle,
          pendingPermission: undefined,
        },
        committed: [
          ...flushed.committed,
          { type: 'error', text: turnErrorText(data) },
        ],
      };
    }

    // The daemon is the source of truth for the model and mode in an attached
    // tab. Both frames are broadcast to every client, including the one that
    // asked for the change, so origin is deliberately not consulted: the
    // requester learns the outcome the same way the phone does.
    case 'model_switched': {
      const modelId = data['modelId'];
      if (typeof modelId !== 'string' || modelId.length === 0) {
        return { state, committed: [] };
      }
      return { state: { ...state, modelId }, committed: [] };
    }

    case 'approval_mode_changed': {
      const next = data['next'];
      if (typeof next !== 'string' || next.length === 0) {
        return { state, committed: [] };
      }
      return { state: { ...state, approvalMode: next }, committed: [] };
    }

    case 'session_metadata_updated': {
      const displayName =
        typeof data['displayName'] === 'string'
          ? data['displayName'].trim()
          : '';
      if (!displayName || state.sessionTitle === displayName) {
        return { state, committed: [] };
      }
      return {
        state: {
          ...state,
          sessionTitle: displayName,
        },
        committed: [],
      };
    }

    case 'user_shell_command': {
      const command =
        typeof data['command'] === 'string' ? data['command'].trim() : '';
      if (!command) {
        return { state, committed: [] };
      }
      const flushed = flushPendingTurn(state);
      const isSelfEcho =
        state.ownClientId !== undefined &&
        frame.originatorClientId === state.ownClientId;
      const committed: HistoryItemWithoutId[] = [...flushed.committed];
      if (!isSelfEcho) {
        committed.push({ type: 'user_shell', text: command });
      }
      const shellTool: IndividualToolCallDisplay = {
        callId: 'user-shell',
        name: 'Shell Command',
        description: command,
        status: ToolCallStatus.Executing,
        confirmationDetails: undefined,
        resultDisplay: '',
        renderOutputAsMarkdown: false,
      };
      return {
        state: {
          ...flushed.state,
          streamingState: StreamingState.Responding,
          pendingShellCommand: command,
          pendingShellOutput: '',
          tools: [shellTool],
        },
        committed,
      };
    }

    case 'user_shell_result': {
      const command = state.pendingShellCommand ?? 'Shell Command';
      const rawOutput = (state.pendingShellOutput ?? '').trim();
      const mainContent = rawOutput || '(Command produced no output)';
      let finalOutput = mainContent;
      let finalStatus = ToolCallStatus.Success;
      const errText =
        typeof data['error'] === 'string' && data['error'].trim().length > 0
          ? data['error'].trim()
          : undefined;
      const aborted = data['aborted'] === true;
      const signal = data['signal'];
      const exitCode =
        typeof data['exitCode'] === 'number' ? data['exitCode'] : null;
      if (errText) {
        finalStatus = ToolCallStatus.Error;
        finalOutput = `${errText}\n${finalOutput}`;
      } else if (aborted) {
        finalStatus = ToolCallStatus.Canceled;
        finalOutput = `Command was cancelled.\n${finalOutput}`;
      } else if (
        (typeof signal === 'string' && signal.length > 0) ||
        (typeof signal === 'number' && signal !== 0)
      ) {
        finalStatus = ToolCallStatus.Error;
        finalOutput = `Command terminated by signal: ${String(signal)}.\n${finalOutput}`;
      } else if (exitCode !== null && exitCode !== 0) {
        finalStatus = ToolCallStatus.Error;
        finalOutput = `Command exited with code ${exitCode}.\n${finalOutput}`;
      }
      const finalToolDisplay: IndividualToolCallDisplay = {
        callId: 'user-shell',
        name: 'Shell Command',
        description: command,
        status: finalStatus,
        confirmationDetails: undefined,
        resultDisplay: capToolResultText(finalOutput),
        renderOutputAsMarkdown: false,
      };
      const remainingTools = state.tools.filter(
        (t) => t.callId !== 'user-shell',
      );
      return {
        state: {
          ...state,
          streamingState: StreamingState.Idle,
          pendingShellCommand: undefined,
          pendingShellOutput: undefined,
          tools: remainingTools,
        },
        committed: [
          {
            type: 'tool_group',
            tools: [finalToolDisplay],
            isUserInitiated: true,
          },
        ],
      };
    }

    case 'mid_turn_message_injected': {
      const messages = Array.isArray(data['messages'])
        ? (data['messages'] as unknown[])
            .filter((m): m is string => typeof m === 'string')
            .map((m) => m.trim())
            .filter((m) => m.length > 0)
        : [];
      if (messages.length === 0) {
        return { state, committed: [] };
      }
      const flushed = flushPendingTurn(state);
      return {
        state: {
          ...flushed.state,
          streamingState: StreamingState.Responding,
        },
        committed: [
          ...flushed.committed,
          ...messages.map(
            (text): HistoryItemWithoutId => ({ type: 'user', text }),
          ),
        ],
      };
    }

    case 'pending_prompt_started': {
      const text = typeof data['text'] === 'string' ? data['text'].trim() : '';
      const isSelfOrigin =
        state.ownClientId !== undefined &&
        frame.originatorClientId === state.ownClientId;
      if (!text || !isSelfOrigin) {
        return { state, committed: [] };
      }
      const flushed = flushPendingTurn(state);
      return {
        state: {
          ...flushed.state,
          streamingState: StreamingState.Responding,
        },
        committed: [...flushed.committed, { type: 'user', text }],
      };
    }

    case 'session_rewound': {
      return {
        state: {
          ...state,
          streamingState: StreamingState.Idle,
          pendingText: '',
          pendingThought: '',
          tools: [],
          pendingPermission: undefined,
          pendingShellCommand: undefined,
          pendingShellOutput: undefined,
        },
        committed: [],
      };
    }

    case 'state_resync_required': {
      if (data['reason'] === 'epoch_reset') {
        return {
          state: {
            ...state,
            streamingState: StreamingState.Idle,
            pendingText: '',
            pendingThought: '',
            tools: [],
            pendingPermission: undefined,
            lastEventId: undefined,
            pendingShellCommand: undefined,
            pendingShellOutput: undefined,
          },
          committed: [],
        };
      }
      return { state, committed: [] };
    }

    // `replay_complete` and unknown frame types are inert for this slice.
    default:
      return { state, committed: [] };
  }
}

/**
 * The transcript a daemon `session/load` returns, as
 * `DaemonSessionClient.replaySnapshot` retains it: the compacted turns, then
 * the live journal of the turn in flight since the last boundary. (A
 * `lifecycleReplay` may ride along; the web shell feeds it only to its
 * trajectory view, never the transcript, so it is not read here.)
 */
export interface DaemonReplaySnapshotFrames {
  compactedReplay: readonly DaemonFrame[];
  liveJournal: readonly DaemonFrame[];
}

export interface ReplaySeedOptions {
  /** This client's daemon clientId; self-echo suppression arms AFTER replay. */
  ownClientId?: string;
  /**
   * The cursor the live subscription resumes after (the load response's
   * `lastEventId`). It becomes the dedup watermark, so the live loop continues
   * from the seeded projection without re-applying anything the replay held.
   */
  lastEventId?: number;
  /** The daemon reports a prompt in flight: leave the trailing turn live. */
  hasActivePrompt?: boolean;
  /** Older persisted records precede the snapshot (this view has no paging). */
  historyHasMore?: boolean;
  /** The persisted replay was only partly reconstructed. */
  replayPartial?: boolean;
  /** Compaction failed at least once, so the snapshot may lag live events. */
  replayDegraded?: boolean;
}

export const REPLAY_HISTORY_HIDDEN_TEXT =
  'Earlier messages in this conversation are not shown here.';

function replayIncompleteText(partial: boolean, degraded: boolean): string {
  const reasons = [
    ...(partial ? ['only partly rebuilt'] : []),
    ...(degraded ? ['reported degraded by the daemon'] : []),
  ];
  return `The conversation history shown here is incomplete (${reasons.join(
    ', ',
  )}), so some messages may be missing or out of date.`;
}

/**
 * Seed the projection from a load response's replay snapshot, so a terminal
 * attached to an existing conversation shows what was said before it opened.
 * Pure: returns the committed history items (in order) and the state the live
 * loop continues from.
 *
 * Semantics follow the web shell's `DaemonSessionProvider` injection:
 * - `compactedReplay` first, then `liveJournal`, folded in array order.
 * - Replay is history, not an echo of input this client just rendered, so no
 *   user line is suppressed while folding (the web shell replays with
 *   `suppressOwnUserEcho: false`). `ownClientId` is armed afterwards for the
 *   live stream.
 * - Frames are folded through `projectFrame`, bypassing the id watermark:
 *   compaction stamps a merged event with the id of its LAST source chunk and
 *   keeps latest-wins updates in their first slot, so ids inside a compacted
 *   turn are not monotonic and the watermark would silently drop real history.
 * - Turns are segmented by their compacted `turn_complete` or `turn_error`
 *   boundary (a replayed failure keeps its error line), or by the next user
 *   message when a turn ended any other way.
 * - With no prompt in flight the trailing turn is committed and the state goes
 *   Idle (no stuck spinner); with one in flight it stays pending and live.
 * - Older history this view cannot page in (`historyHasMore`, or a
 *   `history_truncated` marker in the window) gets ONE leading info line, and
 *   a partial or degraded replay gets one more.
 */
export function projectReplaySnapshot(
  snapshot: DaemonReplaySnapshotFrames,
  opts: ReplaySeedOptions = {},
): ProjectionResult {
  const frames = [...snapshot.compactedReplay, ...snapshot.liveJournal];
  const committed: HistoryItemWithoutId[] = [];
  if (
    opts.historyHasMore === true ||
    frames.some((frame) => frame.type === 'history_truncated')
  ) {
    committed.push({ type: 'info', text: REPLAY_HISTORY_HIDDEN_TEXT });
  }
  if (opts.replayPartial === true || opts.replayDegraded === true) {
    committed.push({
      type: 'info',
      text: replayIncompleteText(
        opts.replayPartial === true,
        opts.replayDegraded === true,
      ),
    });
  }

  let state = initialDaemonProjectionState();
  let maxId: number | undefined;
  for (const frame of frames) {
    const result = projectFrame(state, frame);
    state = result.state;
    committed.push(...result.committed);
    if (typeof frame.id === 'number') {
      maxId = maxId === undefined ? frame.id : Math.max(maxId, frame.id);
    }
  }
  if (opts.hasActivePrompt !== true) {
    const flushed = projectFrame(state, { type: 'turn_complete', data: {} });
    state = flushed.state;
    committed.push(...flushed.committed);
  } else if (state.streamingState === StreamingState.Idle) {
    state = { ...state, streamingState: StreamingState.Responding };
  }

  return {
    state: {
      ...state,
      ownClientId: opts.ownClientId,
      lastEventId:
        maxId !== undefined
          ? Math.max(opts.lastEventId ?? 0, maxId)
          : opts.lastEventId !== undefined && opts.lastEventId > 0
            ? opts.lastEventId
            : undefined,
    },
    committed,
  };
}

/** Live tool-call display for the current turn (the UI's `pendingToolCalls`). */
export function pendingToolCallsOf(
  state: Pick<DaemonProjectionState, 'tools'>,
): IndividualToolCallDisplay[] {
  return state.tools;
}

/** The outstanding approval gate, if any (the hook turns this into a prompt). */
export function activePermissionOf(
  state: Pick<DaemonProjectionState, 'pendingPermission'>,
): PendingPermission | undefined {
  return state.pendingPermission;
}

/**
 * The live (uncommitted) history items for the current turn — fed to the UI's
 * pending-section the same way `useGeminiStream.pendingHistoryItems` is.
 */
export function pendingHistoryItemsOf(
  state: Pick<DaemonProjectionState, 'tools' | 'pendingText'> & {
    pendingThought?: string;
  },
): HistoryItemWithoutId[] {
  // Mirror the sub-turn commit order (`[gemini_thought, tool_group, gemini]`)
  // so the live view matches committed history: active reasoning renders while
  // thinking, then commits above the tool group or streaming assistant text.
  const items: HistoryItemWithoutId[] = [];
  if (state.tools.length > 0) {
    items.push({ type: 'tool_group', tools: state.tools });
  } else if (
    state.pendingThought &&
    state.pendingThought.trim().length > 0 &&
    state.pendingText.trim().length === 0
  ) {
    items.push({ type: 'gemini_thought', text: state.pendingThought });
  }
  if (state.pendingText.trim().length > 0) {
    items.push({ type: 'gemini', text: state.pendingText });
  }
  return items;
}

/**
 * Project the in-flight reasoning into a {@link ThoughtSummary} for the loading
 * indicator. Convention (matching the in-process path): the subject is the
 * first `**bold**` span; the remainder is the description.
 */
export function thoughtOf(
  state: Pick<DaemonProjectionState, 'pendingThought'>,
): ThoughtSummary | null {
  const raw = state.pendingThought.trim();
  if (!raw) return null;
  const m = raw.match(/\*\*(.+?)\*\*/s);
  if (m) {
    return {
      subject: m[1].trim(),
      description: raw.replace(m[0], '').trim(),
    };
  }
  return { subject: '', description: raw };
}
