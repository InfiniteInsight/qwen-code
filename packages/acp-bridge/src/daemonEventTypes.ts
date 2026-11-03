/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon SSE event-`type` wire literals shared across the daemon publisher
 * (`acp-bridge`), the SDK validator/reducer, and the browser consumer.
 *
 * Kept in this DEPENDENCY-FREE module (no `import type` from core, unlike
 * `bridgeTypes.ts`) so the SDK can re-export these from `@qwen-code/sdk/daemon`
 * via its build-time devDep on acp-bridge WITHOUT pulling acp-bridge's type
 * graph into the SDK's bundled `.d.ts` — the same lightweight pattern as
 * `mcpTimeouts.ts`.
 */

/**
 * Published when the daemon drains queued mid-turn messages into the running
 * turn. The browser consumes it to move those messages out of its pending queue
 * so they aren't resent as the next turn (a transient dedupe signal). Single
 * source of truth: a rename here propagates to every importer, so it can't
 * silently break browser-side dedup. `data: { sessionId, messages: string[] }`.
 */
export const MID_TURN_MESSAGE_INJECTED_EVENT = 'mid_turn_message_injected';

/**
 * Published when a prompt is accepted into the per-session FIFO queue
 * (i.e. a previous prompt is still running, so this one must wait).
 * The first prompt on an idle session does NOT publish this event —
 * it starts immediately without queueing.
 * `data: { sessionId, promptId, text, queuedAt }`.
 */
export const PENDING_PROMPT_ADDED_EVENT = 'pending_prompt_added';

/**
 * Published when a queued prompt begins dispatch (reaches the head of the
 * FIFO). `data: { sessionId, promptId, text }`.
 */
export const PENDING_PROMPT_STARTED_EVENT = 'pending_prompt_started';

/**
 * Published when a pending prompt settles (completed normally or
 * explicitly removed). `data: { sessionId, promptId, state:
 * 'completed' | 'removed' }`. Errors during prompt execution still
 * produce `'completed'` — the terminal SSE event (`turn_error`)
 * carries the actual error detail.
 */
export const PENDING_PROMPT_COMPLETED_EVENT = 'pending_prompt_completed';

/**
 * Published when a background task (agent / shell / monitor / workflow)
 * transitions, so a viewer can follow task state without polling
 * `GET /session/:id/tasks`. Carries the same numbers as the roster row it
 * replaces: `runtimeMs` reuses the roster's own formula rather than a second
 * one, so the two sources cannot disagree while both are live.
 *
 * `status` is the roster's vocabulary, which for `kind: 'workflow'` includes
 * `'pausing'` - a dispatch-scheduler state a run occupies between `running`
 * and `paused`. The roster already ships it on
 * `ServeSessionWorkflowTaskStatus.status`; a validator that admitted only the
 * five shared lifecycle states would drop those frames silently, and a
 * mapping onto `paused` would report a pause that has not settled yet.
 * `data: { sessionId, taskId, kind, status, runtimeMs }`.
 */
export const TASK_CHANGED_EVENT = 'task_changed';

/**
 * The `kind` values a `task_changed` frame may carry: the four registries
 * behind the task roster, matching core's `TaskKind`.
 */
export const TASK_CHANGED_KIND_VALUES: readonly string[] = [
  'agent',
  'shell',
  'monitor',
  'workflow',
];

/**
 * The `status` values a `task_changed` frame may carry. Deliberately the
 * roster's vocabulary and not the five-state `ServeSessionTaskLifecycleStatus`
 * alone: `ServeSessionWorkflowTaskStatus.status` is that union plus
 * `'pausing'`, the workflow dispatch scheduler's mid-pause state, and the
 * roster serializes a workflow's status verbatim. Excluding it here would have
 * the validator drop a state the roster reports and the task viewer already
 * treats as live, which is the silent drop this module exists to avoid.
 */
export const TASK_CHANGED_STATUS_VALUES: readonly string[] = [
  'running',
  'paused',
  'pausing',
  'completed',
  'failed',
  'cancelled',
];
