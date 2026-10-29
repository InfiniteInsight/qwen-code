/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { selectAllowOnceOptionId } from '../permissionOptions.js';
import type { DigestSummary } from './digest.js';

/**
 * Metadata-only push payload. Deliberately carries NO tool args, file paths,
 * or prompt text — only enough to render a notification and deep-link back to
 * the session. `url` carries no token; `summary` is capped at 140 chars.
 */
export interface PushPayload {
  v: 1;
  kind: string;
  sessionId: string;
  sessionName?: string;
  summary: string; // <=140
  url: string; // '/ui/?session=<id>'
  requestId?: string; // present for permission.required
  approveOptionId?: string; // opaque option id for inline approve; not sensitive
}

const MAX_SUMMARY = 140;
/** Schema v1 cap for `sessionName` (add-webpush-notifications). */
const MAX_SESSION_NAME = 64;
/**
 * Pre-encryption budget (bytes). Push services cap the encrypted POST at
 * ~4096 bytes; encryption adds framing overhead, so we budget 3800 bytes for
 * the pre-encryption JSON body.
 */
export const MAX_PAYLOAD_BYTES = 3800;

/**
 * Credential-key redaction pattern. Matches common patterns for keys that
 * should never appear in logs or audit fields, or in a push payload: a
 * permission summary carries the tool's title, which for a shell call is the
 * command line (`export API_KEY=...`).
 */
export const CREDENTIAL_REDACT_RE =
  /(?:api[_-]?key|private[_-]?key|secret|password|auth|credential|token)[=:]\s*\S+/gi;

/** Truncate to <=140 chars, ending with a single-char ellipsis if cut. */
function truncate(s: string, max: number = MAX_SUMMARY): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Replace each credential-looking `key=value` / `key: value` value with `•••`. */
export function redactCredentials(s: string): string {
  return s.replace(CREDENTIAL_REDACT_RE, (m) => {
    const sep = m.search(/[=:]/);
    return m.slice(0, sep + 1) + '•••';
  });
}

/** Build the deep link for a session. No token, no secrets. */
function sessionUrl(sessionId: string): string {
  return '/ui/?session=' + encodeURIComponent(sessionId);
}

/**
 * Lifecycle SSE event type → routable notification kind (dot convention,
 * matching 'permission.required'). Exported so wiring/tests share one map.
 */
export const AGENT_EVENT_KINDS: Record<string, string> = {
  agent_spawned: 'agent.spawned',
  agent_completed: 'agent.completed',
  agent_failed: 'agent.failed',
  agent_blocked: 'agent.blocked',
  agent_cancelled: 'agent.cancelled',
};

/**
 * Workflow SSE event type → notification kind. ONLY the two terminal-of-note
 * events map; started/phase/cancelled are stream-only (design: two kinds).
 */
export const WORKFLOW_EVENT_KINDS: Record<string, string> = {
  workflow_completed: 'workflow.completed',
  workflow_failed: 'workflow.failed',
};

/**
 * Review lifecycle SSE event type → notification kind. ONLY the two
 * terminal-of-note events map; started/cancelled are stream-only (mirrors
 * the workflow design: two kinds, no notification noise for non-terminal or
 * user-initiated-cancel transitions).
 */
export const REVIEW_EVENT_KINDS: Record<string, string> = {
  review_completed: 'review.completed',
  review_failed: 'review.failed',
};

/**
 * Map a daemon event to a metadata-only push payload, or null if the event is
 * not notifiable this cycle. `data` is read defensively with optional chaining;
 * only whitelisted, non-sensitive fields ever reach the payload.
 */
export function buildPayload(
  event: { type: string; data: unknown },
  ctx: { sessionId: string; sessionName?: string },
): PushPayload | null {
  const data = (event.data ?? {}) as Record<string, unknown>;

  // Agent lifecycle events (add-agent-observability). Metadata only: the
  // agent's TASK TEXT never reaches a push payload — only type + status.
  const agentKind = AGENT_EVENT_KINDS[event.type];
  if (agentKind !== undefined) {
    const agentType =
      typeof data.agentType === 'string' && data.agentType.length > 0
        ? data.agentType
        : 'agent';
    const status =
      typeof data.status === 'string' ? data.status : event.type.slice(6);
    return {
      v: 1,
      kind: agentKind,
      sessionId: ctx.sessionId,
      ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
      summary: truncate(`Agent ${status}: ${agentType}`),
      url: sessionUrl(ctx.sessionId),
    };
  }

  const workflowKind = WORKFLOW_EVENT_KINDS[event.type];
  if (workflowKind !== undefined) {
    const name =
      typeof data.name === 'string' && data.name.length > 0
        ? data.name
        : 'workflow';
    const status =
      typeof data.status === 'string' ? data.status : event.type.slice(9);
    return {
      v: 1,
      kind: workflowKind,
      sessionId: ctx.sessionId,
      ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
      summary: truncate(`Workflow ${status}: ${name}`),
      url: sessionUrl(ctx.sessionId),
    };
  }

  // Review lifecycle events (add-remote-review). Metadata only: no findings,
  // no report content, and — unlike agent/workflow — NO target descriptor
  // beyond a PR number (a `path` target is a filesystem path and, per the
  // PushPayload contract above, must never reach a push payload).
  const reviewKind = REVIEW_EVENT_KINDS[event.type];
  if (reviewKind !== undefined) {
    const status =
      typeof data.status === 'string' ? data.status : event.type.slice(7);
    const target = data.target as
      | { kind?: unknown; number?: unknown }
      | undefined;
    const targetLabel =
      target?.kind === 'pr' && typeof target.number === 'number'
        ? `PR #${target.number}`
        : undefined;
    return {
      v: 1,
      kind: reviewKind,
      sessionId: ctx.sessionId,
      ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
      summary: truncate(
        targetLabel ? `Review ${status}: ${targetLabel}` : `Review ${status}`,
      ),
      url: sessionUrl(ctx.sessionId),
    };
  }

  if (event.type === 'session_rewound') {
    const toTurn = typeof data.toTurn === 'number' ? data.toTurn : undefined;
    return {
      v: 1,
      kind: 'session.rewound',
      sessionId: ctx.sessionId,
      ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
      summary: truncate(
        toTurn !== undefined
          ? `Session rewound to turn ${toTurn}`
          : 'Session rewound',
      ),
      url: sessionUrl(ctx.sessionId),
    };
  }

  if (event.type === 'approval_mode_changed') {
    const d = event.data as { next?: unknown } | undefined;
    const next =
      typeof d?.next === 'string' && d.next.length > 0 ? d.next : undefined;
    return {
      v: 1,
      kind: 'session.approval_mode_changed',
      sessionId: ctx.sessionId,
      ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
      summary: truncate(
        next ? `Approval mode → ${next}` : 'Approval mode changed',
      ),
      url: sessionUrl(ctx.sessionId),
    };
  }

  // add-mid-turn-recovery: marker frames appended by reportOutcome after the
  // recovery saga decides (design §2.5/§6). The interrupted push is used on
  // the unrecovered path (quiet-hours bypass); recovered pushes
  // session.recovered.
  if (event.type === 'session_interrupted') {
    const exitCode =
      typeof data.exitCode === 'number' ? ` (exit ${data.exitCode})` : '';
    return {
      v: 1,
      kind: 'session.interrupted',
      sessionId: ctx.sessionId,
      ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
      summary: truncate(
        data.recovered
          ? `Daemon restarted; session recovered${exitCode}`
          : `Daemon crashed and session was not recovered${exitCode}`,
      ),
      url: sessionUrl(ctx.sessionId),
    };
  }

  if (event.type === 'session_recovered') {
    return {
      v: 1,
      kind: 'session.recovered',
      sessionId: ctx.sessionId,
      ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
      summary: truncate('Session recovered'),
      url: sessionUrl(ctx.sessionId),
    };
  }

  // Turn endings (#40): the prompt route owns the turn lifecycle, so it emits
  // prompt_completed / prompt_failed when the daemon turn reaches a terminal
  // point (success / timeout / daemon error). Metadata only — a stop reason
  // at most; reply text never reaches the payload.
  if (event.type === 'prompt_completed') {
    return {
      v: 1,
      kind: 'session.turn_complete',
      sessionId: ctx.sessionId,
      ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
      summary: truncate('Reply ready'),
      url: sessionUrl(ctx.sessionId),
    };
  }

  if (event.type === 'prompt_failed') {
    const reason =
      typeof data.reason === 'string' && data.reason.length > 0
        ? data.reason
        : 'error';
    return {
      v: 1,
      kind: 'session.turn_failed',
      sessionId: ctx.sessionId,
      ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
      summary: truncate(
        reason === 'timeout' ? 'Turn timed out' : 'Turn failed',
      ),
      url: sessionUrl(ctx.sessionId),
    };
  }

  switch (event.type) {
    case 'permission_request': {
      const toolCall = data.toolCall as { title?: unknown } | undefined;
      const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v.length > 0 ? v : undefined;
      // Real ACP permission frames carry only { toolCallId, title, kind,
      // rawInput } — there is no `toolCall.name`, and no top-level
      // `data.toolName`. Reading those was the same wire-mismatch that silently
      // broke the policy engine: the fields never exist, so the humanized
      // `title` was always what actually rendered. Use it directly.
      const toolLabel: string = str(toolCall?.title) || 'a tool call';
      const requestId = str(data.requestId);
      // The one-time-approve option (kind 'allow_once'), NOT options[0] (which is
      // usually 'allow_always' and would persist a standing grant). Absent → the
      // SW falls back to opening the app instead of casting an inline vote.
      const approveOptionId = selectAllowOnceOptionId(data.options);
      return {
        v: 1,
        kind: 'permission.required',
        sessionId: ctx.sessionId,
        ...(ctx.sessionName ? { sessionName: ctx.sessionName } : {}),
        summary: truncate('Permission needed: ' + toolLabel),
        url: sessionUrl(ctx.sessionId),
        ...(requestId ? { requestId } : {}),
        ...(approveOptionId ? { approveOptionId } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * Build the end-of-quiet-window "while you were away" digest payload (webpush
 * D4) from accumulated suppressed-while-quiet counts. Metadata-only: it carries
 * ONLY the total + per-kind counts (kind enum names), never session content, and
 * `sessionId:''` because a digest is not tied to a single session. `sw.js`
 * renders any `v:1` push generically (no action buttons for an unknown kind).
 */
export function buildDigestPayload(summary: DigestSummary): PushPayload {
  const n = summary.total;
  return {
    v: 1,
    kind: 'digest',
    sessionId: '',
    summary: truncate(
      `${n} notification${n === 1 ? '' : 's'} while you were away`,
    ),
    url: '/ui/',
  };
}

/**
 * Enforce the pre-encryption byte budget (≤3800 bytes). If the serialized
 * payload exceeds the budget, `summary` is shortened with a trailing `…` until
 * it fits. Returns `{ payload, truncated }` where `truncated` is true when the
 * summary was shortened beyond its original value (callers SHOULD emit a
 * `push_payload_truncated` audit entry). Pure: the input payload is never
 * mutated.
 *
 * When no summary cut fits (a daemon-supplied `requestId` or
 * `approveOptionId` that alone exceeds the budget), the optional fields
 * (`sessionName`, `requestId`, `approveOptionId`) are dropped and the summary
 * is restored and cut again: a permission push without its ids still opens
 * the app, where a push service's 413 delivers nothing.
 *
 * Invariant: the returned payload always satisfies
 * `Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_PAYLOAD_BYTES`
 * unless `sessionId` itself (which the deep link repeats) is larger than the
 * budget, which no daemon session id is.
 */
export function enforcePayloadBudget(payload: PushPayload): {
  payload: PushPayload;
  truncated: boolean;
} {
  const fits = (p: PushPayload): boolean =>
    Buffer.byteLength(JSON.stringify(p), 'utf8') <= MAX_PAYLOAD_BYTES;
  if (fits(payload)) return { payload, truncated: false };
  const cut = shortenSummary({ ...payload }, fits);
  if (fits(cut)) return { payload: cut, truncated: true };
  // Degenerate: an optional field is what does not fit. Drop them all and cut
  // the ORIGINAL summary again, so it keeps as much text as the room allows.
  const bare: PushPayload = { ...payload };
  delete bare.sessionName;
  delete bare.requestId;
  delete bare.approveOptionId;
  return { payload: shortenSummary(bare, fits), truncated: true };
}

/**
 * Shorten `copy.summary` (mutating the copy) one character at a time, ending
 * with `…`, until `fits` or nothing is left. Unchanged when it already fits.
 */
function shortenSummary(
  copy: PushPayload,
  fits: (p: PushPayload) => boolean,
): PushPayload {
  if (fits(copy)) return copy;
  let chars = Array.from(copy.summary); // handle multi-byte / surrogate pairs
  while (chars.length > 0) {
    chars = chars.slice(0, chars.length - 1);
    copy.summary = chars.join('') + '…';
    if (fits(copy)) return copy;
  }
  return copy;
}

/**
 * The last step before a payload leaves the gateway, for every transport
 * (#169: `enforcePayloadBudget` and `CREDENTIAL_REDACT_RE` existed but were
 * never called, so neither the budget nor redaction applied). It redacts
 * credential-looking values from the free-text fields (`summary`,
 * `sessionName`), holds `sessionName` to the schema's 64 characters, then
 * enforces the byte budget. `truncated` reports only a budget cut, which the
 * caller audits as `push_payload_truncated`. Pure: returns the input itself
 * when nothing changed.
 */
export function finalizePayload(payload: PushPayload): {
  payload: PushPayload;
  truncated: boolean;
} {
  const summary = truncate(redactCredentials(payload.summary));
  const sessionName =
    payload.sessionName === undefined
      ? undefined
      : truncate(redactCredentials(payload.sessionName), MAX_SESSION_NAME);
  const cleaned =
    summary === payload.summary && sessionName === payload.sessionName
      ? payload
      : {
          ...payload,
          summary,
          ...(sessionName !== undefined ? { sessionName } : {}),
        };
  return enforcePayloadBudget(cleaned);
}
