/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DaemonSessionSummary } from '@qwen-code/sdk';
import type { DaemonRewindSnapshotInfo } from '@qwen-code/sdk/daemon';
import { gateJsonBody } from '../routes/sessionAttachments.js';

/**
 * The five media types the daemon's attachment store treats as images
 * (`packages/acp-bridge/src/sessionAttachments.ts:26-32`, membership tested by
 * `isSupportedImageMimeType` at :263). The store uses this set rather than an
 * `image/` prefix to choose a reference's `type`, so an `image/tiff` upload
 * comes back as a `resource`. Restated here because that predicate is not
 * exported and rc-gateway has no acp-bridge dependency.
 */
const STUB_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export interface StubDaemon {
  baseUrl: string;
  /** Last-Event-ID header value seen on the most recent /events request. */
  lastEventIdHeader: string | undefined;
  /** True once an /events request socket closed before the stub ended it. */
  eventsAbortedByClient: boolean;
  /** Session id passed to the most recent DELETE /session/:id request. */
  lastEndedSessionId: string | undefined;
  /** Session id passed to the most recent POST /session/:id/cancel request. */
  lastCancelledSessionId: string | undefined;
  /** How many POST /session/:id/cancel requests have arrived. */
  cancelCount: number;
  /** Number of POST /session calls the stub has served. */
  createdSessionCount: number;
  /** Body of the most recent POST /session request. */
  lastCreateSessionBody: unknown;
  /** Body of the most recent POST /session/:id/resume request. */
  lastResumeSessionBody: unknown;
  /** Body of the most recent POST /session/:id/load request. */
  lastLoadSessionBody: unknown;
  /** Body of the most recent POST /session/:id/prompt request. */
  lastPromptBody: unknown;
  /** Body of the most recent POST /session/:id/rewind request. */
  lastRewindBody: unknown;
  /** Body of the most recent POST /session/:id/approval-mode request. */
  lastApprovalModeBody: unknown;
  /** Body of the most recent PATCH /session/:id/metadata request. */
  lastMetadataBody: unknown;
  /**
   * `{ requestId, response }` captured from the most recent
   * POST /session/:id/permission/:requestId request. Lets a test assert
   * which vote the review permission bridge actually sent upstream.
   */
  lastRespondedPermission: { requestId: string; response: unknown } | undefined;
  /**
   * Start/end wall-clock timestamps (ms, `Date.now()`) for every
   * POST /session/:id/prompt call the stub has served, in completion order.
   * Lets a test assert non-overlap ("call B started after call A ended") to
   * prove per-session prompt serialization without relying on fragile
   * fixed-delay timing assumptions.
   */
  promptCallLog: Array<{
    sessionId: string;
    startedAt: number;
    endedAt: number;
  }>;
  /** Body of the most recent POST /workspace/permissions request. */
  lastPermissionRulesBody: unknown;
  /** Body of the most recent POST /workspace/trust/request request. */
  lastTrustRequestBody: unknown;
  /**
   * Body of the most recent POST /workspace/settings request — captures
   * `mcpServerMutation` so MCP server tests can assert the operation/name
   * without inspecting the raw value.
   */
  lastSetSettingBody: unknown;
  /** Every POST /workspace/settings body, in order (#141: one write, not two). */
  setSettingBodies: unknown[];
  /** Body of the most recent POST /workspace/tools/:name/enable request. */
  lastToolToggleBody: unknown;
  /**
   * `toolName` of the most recent POST /workspace/tools/:name/enable
   * request, so per-name `toolToggleResult`/`toolToggleStatus` opts can
   * target a specific tool.
   */
  lastToolToggleName: string | undefined;
  /** Body of the most recent POST /workspace/mcp/reload request. */
  lastMcpReloadBody: unknown;
  /** Query the most recent GET /list request carried. */
  lastListQuery: Record<string, unknown> | undefined;
  /** Query the most recent GET /glob request carried. */
  lastGlobQuery: Record<string, unknown> | undefined;
  /**
   * Query the most recent GET /workspace/memory request carried. Recorded so
   * a test can prove the gateway never forwards a content flag, whatever the
   * caller sent it: see routes/workspaceContext.ts.
   */
  lastMemoryQuery: Record<string, unknown> | undefined;
  /** Query the most recent GET /file request carried. */
  lastFileQuery: Record<string, unknown> | undefined;
  /** Query the most recent GET /file/bytes request carried. */
  lastFileBytesQuery: Record<string, unknown> | undefined;
  /**
   * Query the most recent GET /session/:id/transcript request carried. The
   * gateway relays the caller's paging parameters untouched, so a test can
   * only prove that by reading what actually arrived here.
   */
  lastTranscriptQuery: Record<string, unknown> | undefined;
  /**
   * Query the most recent GET /session/:id/turn-index request carried. Same
   * reason as the transcript one: the gateway relays the paging parameters
   * untouched, so a test can only prove that by reading what arrived here.
   */
  lastTurnIndexQuery: Record<string, unknown> | undefined;
  /** How many GET /session/:id/turns/current requests have arrived (#131). */
  currentTurnReads: number;
  /**
   * Session id the most recent POST /session/:id/recap carried. The gateway
   * is supposed to carry the watched id through to the daemon, and only what
   * arrived here can prove that it did.
   */
  lastRecapSessionId: string | undefined;
  /**
   * Session id and question the most recent POST /session/:id/btw carried.
   * The gateway is meant to forward the watched id and the caller's own
   * words, and only what arrived here can prove it did rather than sent
   * something else.
   */
  lastBtwSessionId: string | undefined;
  lastBtwQuestion: string | undefined;
  /**
   * Session id and body the most recent POST /session/:id/worktree-reset
   * carried. A transfer is the one relay whose request id and response id
   * legitimately differ, so a test can only prove the gateway relayed the
   * replacement rather than echoed the request by reading both here and in
   * the route's response.
   */
  lastWorktreeReset: { sessionId: string; body: unknown } | undefined;
  /**
   * Every POST /session/:id/detach that arrived here, in order, with the
   * client id it named. The gateway is meant to release the registration the
   * transfer mints inside the same request that made it, so the count and the
   * id are the whole proof: one call, naming the minted id, not the
   * superseded one.
   */
  detachCalls: Array<{ sessionId: string; clientId: string | undefined }>;
  /** Session id the most recent GET /session/:id/stats carried. */
  lastStatsSessionId: string | undefined;
  /** Session id the most recent GET /session/:id/resources carried. */
  lastResourcesSessionId: string | undefined;
  /** What the most recent POST /session/:id/attachments carried. */
  lastAttachmentUpload:
    | {
        name: unknown;
        contentType: string | undefined;
        byteLength: number;
      }
    | undefined;
  /** Session id of the most recent GET /session/:id/attachments. */
  lastAttachmentListSessionId: string | undefined;
  /** What the most recent GET .../attachments/:attachmentId carried. */
  lastAttachmentRead: { sessionId: string; attachmentId: string } | undefined;
  /** What the most recent DELETE .../attachments/:attachmentId carried. */
  lastAttachmentRemove: { sessionId: string; attachmentId: string } | undefined;
  /** Session id of the most recent GET /session/:id/pending-prompts. */
  lastPendingPromptsSessionId: string | undefined;
  /** What the most recent DELETE /session/:id/pending-prompts/:promptId carried. */
  lastPendingPromptRemove: { sessionId: string; promptId: string } | undefined;
  /** Session id of the most recent GET /session/:id/mid-turn-messages. */
  lastMidTurnMessagesSessionId: string | undefined;
  /** What the most recent DELETE /session/:id/mid-turn-messages/:messageId carried. */
  lastMidTurnMessageRemove:
    | { sessionId: string; messageId: string }
    | undefined;
  /** What the most recent POST /session/:id/mid-turn-message carried. The
   * `message` is recorded so a test can assert what reached the daemon; it is
   * stub state, never an audit row. */
  lastEnqueueMidTurnMessage:
    | { sessionId: string; message: string; messageId?: string }
    | undefined;
  /** Session id of the most recent POST .../mid-turn-messages/send-now. */
  lastSendMidTurnMessagesNowSessionId: string | undefined;
  /** Workspace the most recent GET .../sessions/live-state named, decoded. */
  lastLiveStateWorkspace: string | undefined;
  close: () => Promise<void>;
  /**
   * Simulate a hard daemon crash: immediately destroy all open connections
   * (including live SSE streams) and then close the listener. Unlike
   * `close()`, this never hangs with open sockets (add-mid-turn-recovery
   * §8: "server close + synthetic onExit").
   */
  crash: () => Promise<void>;
}

export interface StubDaemonOptions {
  /**
   * Frames to emit on /session/:id/events, as {id, type, data}. `_meta` is
   * optional and emitted verbatim when set, so a test can drive the fields the
   * real EventBus stamps (`serverTimestamp`, `usage`) and assert the relay
   * preserves them.
   */
  frames?: Array<{
    id: number;
    type: string;
    data: unknown;
    _meta?: Record<string, unknown>;
  }>;
  /**
   * Extra frames emitted on /session/:id/events immediately after `frames`,
   * for tests that want to script permission-request notifications a
   * `subscribeEvents` consumer (e.g. the review permission bridge, which
   * subscribes with `lastEventId: 0` and expects a full replay) will see.
   * Ids are assigned sequentially continuing on from `frames` — so with the
   * default two `frames`, the first `permissionFrames` entry lands at id 3.
   * Pass `frames: []` alongside this if a test needs the replay to contain
   * only the scripted permission frames.
   */
  permissionFrames?: Array<{ type: string; data: unknown }>;
  /** When set, /events responds with this status instead of streaming. */
  eventsStatus?: number;
  /**
   * Keep the SSE response open for this many ms after emitting frames
   * (instead of ending immediately). Lets a test disconnect mid-stream and
   * observe that the upstream subscription was aborted.
   */
  holdOpenMs?: number;
  /** Status for POST /session/:id/permission/:requestId (default 200 = accepted). */
  permissionStatus?: number;
  /** Status for POST /session/:id/prompt (default 200). */
  promptStatus?: number;
  /**
   * Answer POST /session/:id/prompt with the daemon's non-blocking 202
   * envelope (`{ promptId, lastEventId }`) instead of the legacy blocking 200.
   * The SDK's `prompt()` then subscribes to /events and waits for the matching
   * `turn_complete`, and, when its AbortSignal fires, sends a cancel. Pair with
   * `frames: []` and `holdOpenMs` so the turn stays open.
   */
  promptAccepts?: boolean;
  /** stopReason returned by POST /session/:id/prompt on success (default 'end_turn'). */
  promptStopReason?: string;
  /**
   * Artificial delay (ms) before the stub daemon responds to a prompt POST.
   * Lets tests drive queue-wait and prompt-execution timeout scenarios without
   * real timing dependencies in the production code path.
   */
  promptDelayMs?: number;
  /** workspaceCwd reported by GET /capabilities (default '/stub/workspace'). */
  workspaceCwd?: string;
  /**
   * Sessions returned by GET /workspace/:cwd/sessions (default []). Read live
   * per-request, so a test can mutate the passed array (e.g. `sessions.length=0`)
   * and have the next poll tick observe the change.
   */
  sessions?: DaemonSessionSummary[];
  /** Status for GET /capabilities (default 200). Non-200 → { error }. */
  capabilitiesStatus?: number;
  /**
   * The `features` list GET /capabilities advertises (default: none). The page
   * gates whole panels on these tags — index.html reads `workspace_file_read`
   * before it will even show the file browser — so a scenario that drives such
   * a panel has to advertise the tag. Left empty, the panel stays hidden and
   * the scenario would assert against markup no user can reach.
   */
  capabilitiesFeatures?: string[];
  /**
   * Status for DELETE /session/:id (default 204). The "success" statuses
   * (200/204) respond 204 (the SDK's closeSession accepts 204/404); any other
   * value is returned verbatim as an error.
   */
  endSessionStatus?: number;
  /**
   * Status for POST /session/:id/cancel (default 204). The SDK's `cancel`
   * resolves on any ok status and on 204; anything else throws.
   */
  cancelSessionStatus?: number;
  /** Status for POST /session/:id/rewind (default 200). */
  rewindStatus?: number;
  /**
   * Response body for POST /session/:id/rewind on success. Defaults to
   * `{ rewound: true, targetTurnIndex: 0, filesChanged: [], filesFailed: [] }`.
   */
  rewindResult?: {
    rewound: boolean;
    targetTurnIndex: number;
    filesChanged: string[];
    filesFailed: string[];
  };
  /**
   * Snapshots served by GET /session/:id/rewind/snapshots (default []). The
   * SDK's `daemon.getRewindSnapshots(sessionId)` hits this route; the
   * gateway's rewind route maps a resolved `toTurn` onto
   * `snapshots.find(s => s.turnIndex === toTurn).promptId`.
   */
  rewindSnapshots?: DaemonRewindSnapshotInfo[];
  /** Status for POST /session/:id/approval-mode (default 200). */
  approvalModeStatus?: number;
  /**
   * Response body for POST /session/:id/approval-mode on success. Defaults to
   * `{ sessionId, mode, previous, persisted }` so a test that doesn't care
   * about the exact value still gets one that's consistent with what it sent.
   */
  approvalModeResult?: {
    sessionId?: string;
    mode: string;
    previous: string;
    persisted: boolean;
  };
  /** JSON body to return on a non-200 approval-mode response. */
  approvalModeBody?: unknown;
  /** Status for PATCH /session/:id/metadata (default 200). */
  metadataStatus?: number;
  /**
   * Response body for PATCH /session/:id/metadata on success. Defaults to
   * `{ displayName: req.body.displayName }`, which is the daemon echoing what
   * it was sent. Set this to a DIFFERENT name to prove a gateway route reports
   * the daemon's verdict rather than its own request.
   */
  metadataResult?: { displayName?: string; prs?: unknown[] };
  /** JSON body to return on a non-200 PATCH /session/:id/metadata response. */
  metadataBody?: unknown;
  /** Status for POST /session/:id/model (default 200). */
  setModelStatus?: number;
  /**
   * Response body for POST /session/:id/model on success. Defaults to
   * `{ modelId: req.body.modelId }` so a test that doesn't care about the
   * exact value still gets one consistent with what it sent.
   */
  setModelResult?: Record<string, unknown>;
  /** JSON body to return on a non-200 POST /session/:id/model response. */
  setModelBody?: unknown;
  /** Status for POST /session (default 200). Non-200 → { error }. */
  createSessionStatus?: number;
  /**
   * Mints the sessionId returned by POST /session (default
   * `(n) => 'stub-agent-${n}'`). Tests that route the minted id through a
   * gateway route that enforces `isValidSessionId` (e.g. the events route)
   * must supply a mint returning a 32-36 char hex/dash id.
   */
  createSessionId?: (n: number) => string;
  /** Status for POST /session/:id/resume (default 200). Non-200 → { error }. */
  resumeSessionStatus?: number;
  /** Status for POST /session/:id/load (default 200). Non-200 → { error }. */
  loadSessionStatus?: number;
  /**
   * Skills reported by GET /session/:id/supported-commands, the route the
   * SDK's `daemon.sessionSupportedCommands(sessionId)` hits (default
   * `['review']`).
   */
  supportedSkills?: string[];
  /**
   * Commands reported by GET /session/:id/supported-commands (default `[]`).
   * Each entry is a `DaemonAvailableCommand` (`name`, optional `description`,
   * `input`, `_meta`). A test that exercises the Commands panel's session rows
   * or the invoke route's membership guard sets this, since the default empty
   * list advertises nothing.
   */
  supportedCommands?: unknown[];
  /**
   * Status for GET /session/:id/supported-commands (default 200). Non-200 makes
   * the list read fail, which is how a test drives the invoke route's
   * fail-closed path.
   */
  supportedCommandsStatus?: number;
  /** Status for GET /session/:id/context (default 200). Non-200 → { error }. */
  contextStatusCode?: number;
  /** Full body to return from GET /session/:id/context (overrides the default). */
  contextStatus?: unknown;
  /** Status for GET /session/:id/context-usage (default 200). Non-200 → { error }. */
  contextUsageStatusCode?: number;
  /**
   * Full body to return from GET /session/:id/context-usage (overrides the
   * default). The default reports a real fill against a 262144-token window.
   */
  contextUsageStatus?: unknown;
  /** Status for GET /session/:id/export (default 200). Non-200 → { error }. */
  exportStatusCode?: number;
  /**
   * Body for GET /session/:id/export (default a short markdown document). The
   * daemon serves this route as raw file bytes, so the stub sends a string
   * rather than a JSON body.
   */
  exportContent?: string;
  /**
   * Status for GET /session/:id/transcript (default 200). Non-200 makes the
   * page read fail, which is how a test proves the gateway relays the daemon's
   * paging refusal instead of laundering it into a 502.
   */
  transcriptStatusCode?: number;
  /** Full body for GET /session/:id/transcript (overrides the default page). */
  transcriptPage?: unknown;
  /**
   * Status for GET /session/:id/turn-index (default 200). Non-200 makes the
   * read fail, which is how a test proves the gateway relays the daemon's
   * paging refusal instead of laundering it into a 502.
   */
  turnIndexStatusCode?: number;
  /** Full body for GET /session/:id/turn-index (overrides the default page). */
  turnIndexPage?: unknown;
  /**
   * Body for GET /session/:id/turns/current (#131), a daemon `BridgeTurnStatus`.
   * A function is called on every read, so a scenario can stamp `startedAt`
   * relative to the moment of the read rather than the moment it was written.
   * Left unset the stub answers `{ sessionId, state: 'idle' }`, which is what a
   * daemon answers for a session that has never run a turn.
   */
  currentTurn?: unknown;
  /**
   * Status for GET /session/:id/turns/current (default 200). A 404 with no
   * `code` is how a daemon from before the route answers.
   */
  currentTurnStatusCode?: number;
  /**
   * Status for POST /session/:id/recap (default 200). A 404 is how a daemon
   * from before the recap route answers a request for it, which is the one
   * failure the gateway must not report as a missing conversation.
   */
  recapStatusCode?: number;
  /** Full body for POST /session/:id/recap (overrides the default pair). */
  recapResult?: unknown;
  /**
   * Status for POST /session/:id/btw (default 200). Two different 404s matter
   * here and they mean opposite things, so the stub can produce both: a bare
   * 404 is how a daemon from before the btw route answers, and a 404 carrying
   * { code: 'session_not_found' } is how the daemon's own session guard
   * answers for an id it cannot resolve or an owning workspace that is mid
   * drain. Pair with btwResult to choose which.
   */
  btwStatusCode?: number;
  /** Full body for POST /session/:id/btw (overrides the default pair). */
  btwResult?: unknown;
  /**
   * Status for POST /session/:id/worktree-reset (default 200). The 409 family
   * matters most and the stub cannot guess which one a scenario wants, because
   * the gateway gives each of { worktree_reset_unsupported,
   * worktree_reset_active, worktree_reset_invalid_state } different copy: a
   * retry helps one and never helps another. Supply the code through
   * worktreeResetResult.
   */
  worktreeResetStatusCode?: number;
  /**
   * Full body for POST /session/:id/worktree-reset. The default mints a new
   * session id AND an owner-style client id, which is what a fresh transfer
   * returns and the case the gateway must release. A scenario wanting the
   * idempotent resume of a committed transfer - same id back, no client id,
   * nothing to release - supplies it here.
   */
  worktreeResetResult?: unknown;
  /** Status for POST /session/:id/detach (default 204). */
  detachStatusCode?: number;
  /** Status for GET /session/:id/stats (default 200). Non-200 -> { error }. */
  statsStatusCode?: number;
  /**
   * Full body for GET /session/:id/stats (overrides the default roll-up). A
   * scenario that asserts the page draws nothing for an absent field sets
   * this, because the default body has every optional block present.
   */
  statsResult?: unknown;
  /** Status for GET /session/:id/resources (default 200). */
  resourcesStatusCode?: number;
  /**
   * Full body for GET /session/:id/resources (overrides the default). A
   * scenario that asserts what a reader is shown has to supply its own
   * payload, or it is checking the two names this file invented.
   */
  resourcesResult?: unknown;
  /** Status for GET /session/:id/artifacts (default 200). */
  artifactListStatus?: number;
  /**
   * Full body for GET /session/:id/artifacts (overrides the default envelope).
   * A scenario that asserts an unknown kind still reaches the page sets this,
   * because the default envelope holds only kinds this repo has named.
   */
  artifactListResult?: unknown;
  /** Status for GET /session/:id/artifacts/:artifactId/content (default 200). */
  artifactContentStatus?: number;
  /** JSON body for a non-200 content read (default the daemon's own pair). */
  artifactContentErrorBody?: unknown;
  /** Body the content read serves on success. Defaults to a saved snapshot. */
  artifactContentBody?: string;
  /** Status for GET /session/:id/status (default 200). Non-200 → { error }. */
  sessionStatusCode?: number;
  /**
   * Full body to return from GET /session/:id/status (overrides the default
   * minimal summary). Read live per request, so a test can mutate
   * `pendingInteractions` and have the next poll observe the change.
   */
  sessionStatus?: unknown;
  /**
   * Status for GET /workspace/permissions (default 200). Non-200 →
   * `workspacePermissionsErrorBody ?? { error, code }`.
   */
  workspacePermissionsStatus?: number;
  /** Full body for GET /workspace/permissions (overrides the default v:1 shape). */
  workspacePermissionsResult?: unknown;
  /** JSON body to return on a non-200 GET /workspace/permissions response. */
  workspacePermissionsErrorBody?: unknown;
  /**
   * Status for POST /workspace/permissions (default 200). Non-200 →
   * `workspacePermissionsErrorBody ?? { error, code }`.
   */
  setPermissionRulesStatus?: number;
  /**
   * Full body for POST /workspace/permissions on success (overrides the
   * default echo shape).
   */
  setPermissionRulesResult?: unknown;
  /** Status for GET /workspace/trust (default 200). Non-200 → { error, code }. */
  workspaceTrustStatus?: number;
  /**
   * Full body for GET /workspace/trust. When omitted the stub derives it
   * from `?statusVersion=2`: v:2 when requested, v:1 otherwise.
   */
  workspaceTrustResult?: unknown;
  /**
   * Status for POST /workspace/trust/request (default 202 — the daemon
   * accepts the request and reconciles asynchronously). Non-202 →
   * `trustRequestErrorBody ?? { error }`.
   */
  trustRequestStatus?: number;
  /** Full body for POST /workspace/trust/request on success. */
  trustRequestResult?: unknown;
  /** JSON body to return on a non-202 POST /workspace/trust/request response. */
  trustRequestErrorBody?: unknown;
  /** Status for GET /workspace/env (default 200). Non-200 → { error }. */
  workspaceEnvStatus?: number;
  /** Full body for GET /workspace/env (overrides the default v:1 shape). */
  workspaceEnvResult?: unknown;
  /** Status for GET /workspace/preflight (default 200). Non-200 → { error }. */
  workspacePreflightStatus?: number;
  /** Full body for GET /workspace/preflight (overrides the default v:1). */
  workspacePreflightResult?: unknown;
  /** Status for GET /workspace/skills (default 200). Non-200 → { error }. */
  workspaceSkillsStatus?: number;
  /** Full body for GET /workspace/skills (overrides the default v:1 shape). */
  workspaceSkillsResult?: unknown;
  /** Status for GET /workspace/providers (default 200). Non-200 → { error }. */
  workspaceProvidersStatus?: number;
  /** Full body for GET /workspace/providers (overrides the default v:1). */
  workspaceProvidersResult?: unknown;
  /** Status for GET /workspace/hooks (default 200). Non-200 → { error }. */
  workspaceHooksStatus?: number;
  /** Full body for GET /workspace/hooks (overrides the default v:1 shape). */
  workspaceHooksResult?: unknown;
  /** Status for GET /workspace/memory (default 200). Non-200 -> { error }. */
  workspaceMemoryStatus?: number;
  /** Full body for GET /workspace/memory (overrides the default v:1 shape). */
  workspaceMemoryResult?: unknown;
  /** Status for GET /workspace/agents (default 200). Non-200 -> { error }. */
  workspaceAgentsStatus?: number;
  /** Full body for GET /workspace/agents (overrides the default v:1 shape). */
  workspaceAgentsResult?: unknown;
  /** Status for GET /workspace/settings (default 200). Non-200 → { error }. */
  workspaceSettingsStatus?: number;
  /** Full body for GET /workspace/settings (overrides the default v:1 shape). */
  workspaceSettingsResult?: unknown;
  /**
   * Status for POST /workspace/settings (default 200). Non-200 →
   * `setWorkspaceSettingBody ?? { error, code }`.
   */
  setWorkspaceSettingStatus?: number;
  /** JSON body to return on a non-200 POST /workspace/settings response. */
  setWorkspaceSettingBody?: unknown;
  /** Full body for POST /workspace/settings on success (per-tool or global). */
  setWorkspaceSettingResult?: unknown;
  /**
   * Status for POST /workspace/tools/:name/enable (default 200). Per-tool
   * override via `toolToggleStatusByName` (name-keyed). Non-200 →
   * `toolToggleBody ?? { error, code }`.
   */
  toolToggleStatus?: number;
  /** Per-tool status override, keyed by tool name (wins over toolToggleStatus). */
  toolToggleStatusByName?: Record<string, number>;
  /** Full body for POST /workspace/tools/:name/enable on success. */
  toolToggleResult?: { toolName: string; enabled: boolean };
  /** JSON body to return on a non-200 tool-toggle response. */
  toolToggleBody?: unknown;
  /** Status for GET /workspace/tools/catalog (default 200). Non-200 → error body. */
  workspaceToolsStatus?: number;
  /** JSON body to return on a non-200 GET /workspace/tools/catalog response. */
  workspaceToolsErrorBody?: unknown;
  /** Full body for GET /workspace/tools/catalog (overrides the default v:1 shape). */
  workspaceToolsResult?: unknown;
  /** Status for GET /workspace/mcp (default 200). Non-200 → { error }. */
  workspaceMcpStatus?: number;
  /** Full body for GET /workspace/mcp (overrides the default v:1 shape). */
  workspaceMcpResult?: unknown;
  /** Status for POST /workspace/mcp/reload (default 200). Non-200 → { error }. */
  mcpReloadStatus?: number;
  /** Full body for POST /workspace/mcp/reload on success. */
  mcpReloadResult?: { accepted: boolean };
  /** Status for GET /list (default 200). Non-200 -> error body. */
  listStatus?: number;
  /** JSON body to return on a non-200 GET /list response. */
  listErrorBody?: unknown;
  /** Full body for GET /list (overrides the default shape). */
  listResult?: unknown;
  /** Status for GET /glob (default 200). Non-200 -> error body. */
  globStatus?: number;
  /** JSON body to return on a non-200 GET /glob response. */
  globErrorBody?: unknown;
  /** Full body for GET /glob (overrides the default shape). */
  globResult?: unknown;
  /** Status for GET /file (default 200). Non-200 -> error body. */
  fileStatus?: number;
  /** JSON body to return on a non-200 GET /file response. */
  fileErrorBody?: unknown;
  /** Full body for GET /file (overrides the default shape). */
  fileResult?: unknown;
  /** Status for GET /file/bytes (default 200). Non-200 -> error body. */
  fileBytesStatus?: number;
  /** JSON body to return on a non-200 GET /file/bytes response. */
  fileBytesErrorBody?: unknown;
  /** Full body for GET /file/bytes (overrides the default shape). */
  fileBytesResult?: unknown;
  /** Status for POST /session/:id/attachments (default 201). */
  attachmentUploadStatus?: number;
  /** JSON body to return on a non-201 POST /session/:id/attachments. */
  attachmentUploadErrorBody?: unknown;
  /** Full body for POST /session/:id/attachments on success. */
  attachmentUploadResult?: unknown;
  /** Status for GET /session/:id/attachments (default 200). */
  attachmentListStatus?: number;
  /** JSON body to return on a non-200 GET /session/:id/attachments. */
  attachmentListErrorBody?: unknown;
  /** Full body for GET /session/:id/attachments (overrides the default). */
  attachmentListResult?: unknown;
  /** Status for GET /session/:id/attachments/:attachmentId (default 200). */
  attachmentReadStatus?: number;
  /** JSON body to return on a non-200 GET .../:attachmentId. */
  attachmentReadErrorBody?: unknown;
  /**
   * Raw bytes the GET .../:attachmentId answers with on success. The daemon
   * serves the file itself, not a JSON envelope: the SDK base64 encodes the
   * response body and reads the media type off the response header
   * (DaemonClient.ts:4858), so a stub that answered with JSON would get
   * encoded twice and the test would pass on the shape while proving nothing
   * about the bytes.
   */
  attachmentReadBody?: string;
  /**
   * Media type the GET .../:attachmentId answers with. Defaults to
   * application/octet-stream rather than a text type: express appends
   * `; charset=utf-8` to any text/* Content-Type whatever the body type
   * (verified on 4.22.2), so a text default would put a suffix in the relayed
   * media type that the gateway had nothing to do with.
   */
  attachmentReadContentType?: string;
  /** Status for DELETE /session/:id/attachments/:attachmentId (default 200). */
  attachmentRemoveStatus?: number;
  /** JSON body to return on a non-200 DELETE .../:attachmentId. */
  attachmentRemoveErrorBody?: unknown;
  /**
   * Value the DELETE .../:attachmentId answers with on success. Defaults to
   * `true`; set it false to exercise the double-tap case, where the daemon
   * answers that nothing matched without refusing.
   */
  attachmentRemoveResult?: boolean;
  /** Status for GET /session/:id/pending-prompts (default 200). */
  pendingPromptsStatus?: number;
  pendingPromptsErrorBody?: unknown;
  pendingPromptsResult?: unknown;
  /** Status for DELETE /session/:id/pending-prompts/:promptId (default 200). */
  removePendingPromptStatus?: number;
  removePendingPromptErrorBody?: unknown;
  removePendingPromptResult?: unknown;
  /** Status for GET /session/:id/mid-turn-messages (default 200). */
  midTurnMessagesStatus?: number;
  midTurnMessagesErrorBody?: unknown;
  midTurnMessagesResult?: unknown;
  /** Status for DELETE /session/:id/mid-turn-messages/:messageId (default 200). */
  removeMidTurnMessageStatus?: number;
  removeMidTurnMessageErrorBody?: unknown;
  removeMidTurnMessageResult?: unknown;
  /** Status for POST /session/:id/mid-turn-message (default 200). Set 404 with no
   * `enqueueMidTurnMessageErrorBody` to stand for a daemon predating the route. */
  enqueueMidTurnMessageStatus?: number;
  enqueueMidTurnMessageErrorBody?: unknown;
  /** Body for POST /session/:id/mid-turn-message. The default answers
   * `accepted: true`; set `{ accepted: false, reason: 'session_idle' }` to stand
   * for a session whose turn already ended, which is an answer and not a
   * failure. */
  enqueueMidTurnMessageResult?: unknown;
  /** Status for POST /session/:id/mid-turn-messages/send-now (default 200). */
  sendMidTurnMessagesNowStatus?: number;
  sendMidTurnMessagesNowErrorBody?: unknown;
  sendMidTurnMessagesNowResult?: unknown;
  /** Status for GET /workspaces/:workspace/sessions/live-state (default 200).
   * Set 404 with no `liveStateErrorBody` to stand for a daemon that
   * advertises the capability tag without serving the route. */
  liveStateStatus?: number;
  liveStateErrorBody?: unknown;
  liveStateResult?: unknown;
}

/** Start a minimal daemon-shaped SSE server on an ephemeral loopback port. */
export async function startStubDaemon(
  opts: StubDaemonOptions = {},
): Promise<StubDaemon> {
  const frames = opts.frames ?? [
    { id: 1, type: 'session_update', data: { text: 'one' } },
    { id: 2, type: 'session_update', data: { text: 'two' } },
  ];
  const state = {
    lastEventIdHeader: undefined as string | undefined,
    eventsAbortedByClient: false,
    lastEndedSessionId: undefined as string | undefined,
    lastCancelledSessionId: undefined as string | undefined,
    cancelCount: 0,
    createdSessionCount: 0,
    lastCreateSessionBody: undefined as unknown,
    lastResumeSessionBody: undefined as unknown,
    lastLoadSessionBody: undefined as unknown,
    lastPromptBody: undefined as unknown,
    lastRewindBody: undefined as unknown,
    lastApprovalModeBody: undefined as unknown,
    lastMetadataBody: undefined as unknown,
    lastRespondedPermission: undefined as
      | { requestId: string; response: unknown }
      | undefined,
    promptCallLog: [] as Array<{
      sessionId: string;
      startedAt: number;
      endedAt: number;
    }>,
    lastPermissionRulesBody: undefined as unknown,
    lastTrustRequestBody: undefined as unknown,
    lastSetSettingBody: undefined as unknown,
    setSettingBodies: [] as unknown[],
    lastToolToggleBody: undefined as unknown,
    lastToolToggleName: undefined as string | undefined,
    lastMcpReloadBody: undefined as unknown,
    lastListQuery: undefined as Record<string, unknown> | undefined,
    lastGlobQuery: undefined as Record<string, unknown> | undefined,
    lastMemoryQuery: undefined as Record<string, unknown> | undefined,
    lastFileQuery: undefined as Record<string, unknown> | undefined,
    lastFileBytesQuery: undefined as Record<string, unknown> | undefined,
    lastTranscriptQuery: undefined as Record<string, unknown> | undefined,
    lastTurnIndexQuery: undefined as Record<string, unknown> | undefined,
    currentTurnReads: 0,
    lastRecapSessionId: undefined as string | undefined,
    lastBtwSessionId: undefined as string | undefined,
    lastBtwQuestion: undefined as string | undefined,
    lastWorktreeReset: undefined as
      | { sessionId: string; body: unknown }
      | undefined,
    detachCalls: [] as Array<{
      sessionId: string;
      clientId: string | undefined;
    }>,
    worktreeResetCount: 0,
    lastStatsSessionId: undefined as string | undefined,
    lastResourcesSessionId: undefined as string | undefined,
    lastArtifactListSessionId: undefined as string | undefined,
    lastArtifactContent: undefined as
      | { sessionId: string; artifactId: string }
      | undefined,
    lastAttachmentUpload: undefined as
      | {
          name: unknown;
          contentType: string | undefined;
          byteLength: number;
        }
      | undefined,
    lastAttachmentListSessionId: undefined as string | undefined,
    lastAttachmentRead: undefined as
      | { sessionId: string; attachmentId: string }
      | undefined,
    lastAttachmentRemove: undefined as
      | { sessionId: string; attachmentId: string }
      | undefined,
    lastPendingPromptsSessionId: undefined as string | undefined,
    lastPendingPromptRemove: undefined as
      | { sessionId: string; promptId: string }
      | undefined,
    lastMidTurnMessagesSessionId: undefined as string | undefined,
    lastMidTurnMessageRemove: undefined as
      | { sessionId: string; messageId: string }
      | undefined,
    lastEnqueueMidTurnMessage: undefined as
      | { sessionId: string; message: string; messageId?: string }
      | undefined,
    lastSendMidTurnMessagesNowSessionId: undefined as string | undefined,
    lastLiveStateWorkspace: undefined as string | undefined,
  };
  const app = express();
  // The same arrangement the gateway uses, for the same reason: an attachment
  // upload carries the file as the request body with the file's own media
  // type, so a JSON file would be claimed and drained here before this stub's
  // raw reader could count the bytes. Reuses the gateway's rule rather than
  // restating it, so the two sides cannot drift.
  app.use(gateJsonBody(express.json()));

  // -- Workspace control (rc-workspace-permissions) -------------------------
  // Daemon-global endpoints (no session id). Default responses mirror the
  // real daemon's v:1 shapes so a real DaemonClient parses them cleanly.

  app.get('/workspace/permissions', (_req, res) => {
    const status = opts.workspacePermissionsStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.workspacePermissionsErrorBody ?? { error: 'stub error' });
      return;
    }
    const cwd = opts.workspaceCwd ?? '/proj';
    // The shape the daemon actually sends. buildPermissionSettings
    // (packages/cli/src/config/permission-settings.ts:145) builds user and
    // workspace as { path, rules } OBJECTS and merged as one
    // { allow, ask, deny } set (readPermissionRuleSet, :55). This used to be
    // three flat arrays, and that was not a cosmetic difference: the page reads
    // `permRules[permScope] || { rules: {} }` then `src.rules[rt]`
    // (public/index.html:4254), and a truthy empty array survives that `||`, so
    // src.rules was undefined and renderPermRulesSection threw. loadPermRules
    // swallows it when notify is false (:4344), so the panel sat on "loading…"
    // in every page scenario and no scenario noticed, because none asserted it.
    // It also made the gateway's version hash useless: permissionsVersion hashes
    // data.user?.rules (src/routes/workspacePermissions.ts:45), which on an array
    // is undefined, so every default payload hashed to the same constant and the
    // baseVersion conflict path could not be reached either.
    // A fixture a page cannot render is not a stub of the daemon; it is a fixture
    // that hides the panel it stands for.
    res.json(
      opts.workspacePermissionsResult ?? {
        v: 1,
        user: {
          path: '/home/tester/.qwen/settings.json',
          rules: { allow: ['Read(~/.qwen/**)'], ask: [], deny: [] },
        },
        workspace: {
          path: cwd,
          rules: {
            allow: ['Bash(git status:*)'],
            ask: ['Bash(npm publish:*)'],
            deny: ['Edit(./secrets/**)'],
          },
        },
        merged: {
          allow: ['Read(~/.qwen/**)', 'Bash(git status:*)'],
          ask: ['Bash(npm publish:*)'],
          deny: ['Edit(./secrets/**)'],
        },
        isTrusted: true,
      },
    );
  });

  app.post('/workspace/permissions', (req, res) => {
    state.lastPermissionRulesBody = req.body;
    const status = opts.setPermissionRulesStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.workspacePermissionsErrorBody ?? { error: 'stub error' });
      return;
    }
    const b = req.body as {
      scope?: unknown;
      ruleType?: unknown;
      rules?: unknown;
    };
    // A write is answered with the whole rebuilt settings object, not the list
    // it was handed, for the same reason the GET carries that shape: the page
    // assigns this body straight to permRules and re-renders
    // (public/index.html:4396), so an array here would break the panel on the way
    // back from a save. The written list lands in the slot its own scope and
    // ruleType name, which is what a scenario needs to see the write take hold.
    const cwd = opts.workspaceCwd ?? '/proj';
    const ruleType =
      typeof b.ruleType === 'string' &&
      ['allow', 'ask', 'deny'].includes(b.ruleType)
        ? b.ruleType
        : 'allow';
    const written = Array.isArray(b.rules) ? b.rules : [];
    const emptySet = () => ({ allow: [], ask: [], deny: [] });
    const userRules = emptySet();
    const workspaceRules = emptySet();
    if (b.scope === 'user') {
      userRules[ruleType] = written;
    } else {
      workspaceRules[ruleType] = written;
    }
    res.json(
      opts.setPermissionRulesResult ?? {
        v: 1,
        user: {
          path: '/home/tester/.qwen/settings.json',
          rules: userRules,
        },
        workspace: { path: cwd, rules: workspaceRules },
        merged: { ...emptySet(), [ruleType]: written },
        isTrusted: true,
      },
    );
  });

  app.get('/workspace/trust', (req, res) => {
    const status = opts.workspaceTrustStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    const v2 = req.query.statusVersion === '2';
    res.json(
      opts.workspaceTrustResult ??
        (v2
          ? {
              v: 2,
              configured: 'trusted',
              effective: { state: 'trusted', source: 'explicit' },
              reconciliation: { pending: false },
            }
          : {
              v: 1,
              workspaceCwd: opts.workspaceCwd ?? '/stub/workspace',
              folderTrustEnabled: true,
              effective: { state: 'trusted', source: 'explicit' },
              explicitTrustLevel: 'trusted',
              requiresDaemonRestartForChanges: true,
            }),
    );
  });

  app.post('/workspace/trust/request', (req, res) => {
    state.lastTrustRequestBody = req.body;
    const status = opts.trustRequestStatus ?? 202;
    if (status !== 202) {
      res
        .status(status)
        .json(opts.trustRequestErrorBody ?? { error: 'stub error' });
      return;
    }
    const b = req.body as { desiredState?: unknown; reason?: unknown };
    res.status(202).json(
      opts.trustRequestResult ?? {
        accepted: true,
        desiredState: b.desiredState ?? 'trusted',
        requiresOperatorAction: true,
      },
    );
  });

  app.get('/workspace/env', (_req, res) => {
    const status = opts.workspaceEnvStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    // Shaped off DaemonWorkspaceEnvStatus
    // (packages/sdk-typescript/src/daemon/types.ts:3071) and DaemonEnvCell
    // (:3063): every cell is a DaemonStatusCell ({ kind, status, error?,
    // errorKind?, hint? }) plus kind/name/present?/value?.
    // The env_var cell deliberately carries NO value, because the type says a
    // value is ALWAYS omitted for that kind (:3067) — a stub that sent one
    // would let a page pass by printing a secret the real daemon never puts on
    // the wire. Presence is the whole fact about an env var.
    res.json(
      opts.workspaceEnvResult ?? {
        v: 1,
        workspaceCwd: opts.workspaceCwd ?? '/proj',
        initialized: true,
        acpChannelLive: true,
        cells: [
          {
            kind: 'runtime',
            name: 'node',
            status: 'ok',
            value: 'v22.17.1',
          },
          { kind: 'platform', name: 'os', status: 'ok', value: 'linux' },
          {
            kind: 'proxy',
            name: 'HTTPS_PROXY',
            status: 'warning',
            present: false,
            hint: 'no proxy configured for this workspace',
          },
          {
            kind: 'env_var',
            name: 'ANTHROPIC_API_KEY',
            status: 'ok',
            present: true,
          },
        ],
      },
    );
  });

  app.get('/workspace/preflight', (_req, res) => {
    const status = opts.workspacePreflightStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    // Shaped off DaemonWorkspacePreflightStatus (types.ts:3100) and
    // DaemonPreflightCell (:3094): a DaemonStatusCell plus kind/locality/
    // detail?. The three states below are on purpose — a passing check, a
    // degraded one carrying the daemon's own hint, and a hard failure with an
    // errorKind from the closed taxonomy — because the panel's job is to draw
    // all three in the daemon's words, and a fixture where everything is ok
    // proves only the happy path.
    res.json(
      opts.workspacePreflightResult ?? {
        v: 1,
        workspaceCwd: opts.workspaceCwd ?? '/proj',
        initialized: true,
        acpChannelLive: true,
        cells: [
          {
            kind: 'node_version',
            status: 'ok',
            locality: 'daemon',
            detail: { version: 'v22.17.1' },
          },
          {
            kind: 'ripgrep',
            status: 'warning',
            locality: 'daemon',
            hint: 'falling back to the bundled search binary',
          },
          {
            kind: 'auth',
            status: 'error',
            locality: 'acp',
            error: 'no credentials for the configured provider',
            errorKind: 'auth_missing',
          },
        ],
        errors: [{ kind: 'egress', status: 'error', error: 'probe timed out' }],
      },
    );
  });

  app.get('/workspace/skills', (_req, res) => {
    const status = opts.workspaceSkillsStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    // Shaped off DaemonWorkspaceSkillsStatus
    // (packages/sdk-typescript/src/daemon/types.ts:2511) and
    // DaemonWorkspaceSkillStatus (:2493), which extends DaemonStatusCell and
    // adds name/description/level/modelInvocable plus optionals.
    // installedPath is deliberately present on one entry: it is a host path,
    // which is the fact that puts this read on the write side of the #107 line.
    // The second entry carries `disabledReason`, the field that says a skill is
    // there but off, which a page that filters non-ok rows would drop.
    res.json(
      opts.workspaceSkillsResult ?? {
        v: 1,
        workspaceCwd: opts.workspaceCwd ?? '/proj',
        initialized: true,
        skills: [
          {
            kind: 'skill',
            name: 'review',
            description: 'review the current diff',
            level: 'workspace',
            modelInvocable: true,
            status: 'ok',
            installedPath: '/proj/.qwen/skills/review/SKILL.md',
          },
          {
            kind: 'skill',
            name: 'pdf',
            description: 'work with pdf files',
            level: 'user',
            modelInvocable: false,
            status: 'disabled',
            disabledReason: 'default',
          },
        ],
      },
    );
  });

  app.get('/workspace/providers', (_req, res) => {
    const status = opts.workspaceProvidersStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    // Shaped off DaemonWorkspaceProvidersStatus (:2606),
    // DaemonWorkspaceProviderStatus (:2594) and DaemonWorkspaceProviderModel
    // (:2578). One model carries `baseUrl` and `envKey` on purpose: those two
    // are why this read is the most identifying of the three, and a page that
    // prints them is printing where the host's model traffic goes and which
    // variable pays for it.
    res.json(
      opts.workspaceProvidersResult ?? {
        v: 1,
        workspaceCwd: opts.workspaceCwd ?? '/proj',
        initialized: true,
        acpChannelLive: true,
        current: { authType: 'anthropic', modelId: 'claude-sonnet-4' },
        approvalMode: 'default',
        providers: [
          {
            kind: 'model_provider',
            authType: 'anthropic',
            current: true,
            status: 'ok',
            models: [
              {
                modelId: 'claude-sonnet-4',
                baseModelId: 'claude-sonnet-4',
                name: 'Claude Sonnet 4',
                isCurrent: true,
                isRuntime: false,
                baseUrl: 'https://api.anthropic.com',
                envKey: 'ANTHROPIC_API_KEY',
              },
            ],
          },
          {
            kind: 'model_provider',
            authType: 'qwen-oauth',
            current: false,
            status: 'warning',
            hint: 'token expires soon',
            models: [],
          },
        ],
      },
    );
  });

  app.get('/workspace/hooks', (_req, res) => {
    const status = opts.workspaceHooksStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    // Shaped off DaemonWorkspaceHooksStatus (:5483) and DaemonHookEntry
    // (:5471). The config mirrors what the real daemon sends: `command` is NOT
    // masked by redactHookSecrets
    // (packages/cli/src/acp-integration/acpAgent.ts:2549) because a hook's
    // shell command is configuration, while every `env` VALUE is replaced with
    // a constant and only the key names survive. So the secret here is a mask,
    // not a value, and a page that printed config.env would print key names
    // beside a string that looks like content.
    res.json(
      opts.workspaceHooksResult ?? {
        v: 1,
        workspaceCwd: opts.workspaceCwd ?? '/proj',
        initialized: true,
        disabled: false,
        hooks: [
          {
            kind: 'hook',
            eventName: 'PreToolUse',
            source: 'workspace',
            enabled: true,
            matcher: 'Bash',
            config: {
              type: 'command',
              command: 'python3 tools/guard.py',
              env: { GUARD_TOKEN: '[redacted]' },
            },
          },
          {
            kind: 'hook',
            eventName: 'Stop',
            source: 'user',
            enabled: false,
            config: { type: 'command', command: 'echo done' },
          },
        ],
        events: {
          PreToolUse: {
            description: 'before a tool runs',
            matcherKind: 'string',
          },
          Stop: { description: 'when the turn stops' },
        },
      },
    );
  });

  app.get('/workspace/memory', (req, res) => {
    // Recorded so a test can assert the flag never arrives. The gateway has
    // no path that sets it, and a caller's own query param must not become one.
    state.lastMemoryQuery = Object.fromEntries(
      Object.entries(req.query as Record<string, unknown>),
    );
    const status = opts.workspaceMemoryStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    // Shaped off DaemonWorkspaceMemoryStatus
    // (packages/sdk-typescript/src/daemon/types.ts:2646) and
    // DaemonWorkspaceMemoryFile (:2625). No `content` field on either entry,
    // because the gateway never sends includeContent: that flag is the only way
    // to read the global file, which sits outside the bound workspace and is
    // refused by the file routes. The second entry is the `global` scope, whose
    // `path` is a home-directory path and is the reason this read is WRITE.
    res.json(
      opts.workspaceMemoryResult ?? {
        v: 1,
        workspaceCwd: opts.workspaceCwd ?? '/proj',
        initialized: true,
        files: [
          {
            kind: 'memory_file',
            path: '/proj/QWEN.md',
            scope: 'workspace',
            bytes: 4210,
          },
          {
            kind: 'memory_file',
            path: '/home/dev/.qwen/QWEN.md',
            scope: 'global',
            bytes: 980,
          },
        ],
        totalBytes: 5190,
        fileCount: 2,
        ruleCount: 14,
      },
    );
  });

  app.get('/workspace/agents', (_req, res) => {
    const status = opts.workspaceAgentsStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    // Shaped off DaemonWorkspaceAgentsStatus (:2977) and
    // DaemonWorkspaceAgentSummary (:2948). Levels are the real union
    // (project|user|builtin|extension|session). The first entry carries
    // `filePath`, a host path, plus the tool and MCP names it may reach; the
    // second is a builtin with no file at all, so a page that assumed every
    // agent has a definition file would break on it.
    res.json(
      opts.workspaceAgentsResult ?? {
        v: 1,
        workspaceCwd: opts.workspaceCwd ?? '/proj',
        agents: [
          {
            kind: 'agent',
            name: 'reviewer',
            description: 'reviews the current diff',
            level: 'project',
            isBuiltin: false,
            hasTools: true,
            tools: ['read_file', 'grep_search'],
            model: 'qwen3.6-plus',
            mcpServerNames: ['memory'],
            hookEvents: ['PreToolUse'],
            filePath: '/proj/.qwen/agents/reviewer.md',
          },
          {
            kind: 'agent',
            name: 'Explore',
            description: 'fast codebase exploration',
            level: 'builtin',
            isBuiltin: true,
            hasTools: false,
          },
        ],
      },
    );
  });

  app.get('/workspace/settings', (_req, res) => {
    const status = opts.workspaceSettingsStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    res.json(
      opts.workspaceSettingsResult ?? {
        v: 1,
        warnings: [],
        settings: [],
        disabledTools: [],
      },
    );
  });

  app.post('/workspace/settings', (req, res) => {
    state.lastSetSettingBody = req.body;
    state.setSettingBodies.push(req.body);
    const status = opts.setWorkspaceSettingStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.setWorkspaceSettingBody ?? { error: 'stub error' });
      return;
    }
    const b = req.body as { scope?: unknown; key?: unknown };
    res.json(
      opts.setWorkspaceSettingResult ?? {
        key: b.key,
        scope: b.scope,
        value: undefined,
        requiresRestart: false,
      },
    );
  });

  app.get('/workspace/tools/catalog', (_req, res) => {
    const status = opts.workspaceToolsStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.workspaceToolsErrorBody ?? { error: 'stub error' });
      return;
    }
    res.json(
      opts.workspaceToolsResult ?? {
        v: 1,
        tools: [
          {
            name: 'web_fetch',
            displayName: 'Web Fetch',
            disabled: false,
            source: 'builtin',
          },
          {
            name: 'write_file',
            displayName: 'Write File',
            disabled: true,
            source: 'builtin',
          },
        ],
      },
    );
  });

  app.post('/workspace/tools/:name/enable', (req, res) => {
    state.lastToolToggleBody = req.body;
    state.lastToolToggleName = req.params.name;
    const status =
      opts.toolToggleStatusByName?.[req.params.name] ??
      opts.toolToggleStatus ??
      200;
    if (status !== 200) {
      res.status(status).json(opts.toolToggleBody ?? { error: 'stub error' });
      return;
    }
    const b = req.body as { enabled?: unknown };
    res.json(
      opts.toolToggleResult ?? {
        toolName: req.params.name,
        enabled: typeof b.enabled === 'boolean' ? b.enabled : false,
      },
    );
  });

  app.get('/workspace/mcp', (_req, res) => {
    const status = opts.workspaceMcpStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    res.json(
      opts.workspaceMcpResult ?? {
        v: 1,
        workspaceCwd: opts.workspaceCwd ?? '/stub/workspace',
        initialized: true,
        servers: [],
        clientCount: 0,
      },
    );
  });

  app.post('/workspace/mcp/reload', (req, res) => {
    state.lastMcpReloadBody = req.body;
    const status = opts.mcpReloadStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    res.json(opts.mcpReloadResult ?? { accepted: true });
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/capabilities', (_req, res) => {
    const status = opts.capabilitiesStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    res.json({
      v: 1,
      mode: 'http-bridge',
      features: opts.capabilitiesFeatures ?? [],
      modelServices: [],
      workspaceCwd: opts.workspaceCwd ?? '/stub/workspace',
    });
  });

  app.get('/workspace/:cwd/sessions', (_req, res) => {
    res.json({ sessions: opts.sessions ?? [] });
  });

  app.get('/session/:id/events', (req, res) => {
    state.lastEventIdHeader = req.headers['last-event-id'] as
      | string
      | undefined;
    if (opts.eventsStatus && opts.eventsStatus !== 200) {
      res.status(opts.eventsStatus).json({ error: 'stub error' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Extend `frames` with any scripted `permissionFrames`, assigning ids
    // sequentially so both sets replay through the same JSON-envelope
    // convention documented below.
    const allFrames = opts.permissionFrames
      ? [
          ...frames,
          ...opts.permissionFrames.map((f, i) => ({
            id: frames.length + i + 1,
            type: f.type,
            data: f.data,
          })),
        ]
      : frames;
    for (const f of allFrames) {
      // IMPORTANT: the SDK's parseSseStream reads the event id from INSIDE
      // the data JSON envelope (`parsed.id`, required to be an integer >= 1),
      // and ignores the SSE `id:` line. So the id MUST live in the JSON. We
      // also emit the `id:` line to mirror real SSE framing (harmless; the
      // DaemonClient ignores it, but downstream EventSource clients use it).
      res.write(`id: ${f.id}\n`);
      res.write(
        `data: ${JSON.stringify({
          v: 1,
          id: f.id,
          type: f.type,
          data: f.data,
          ...(f._meta !== undefined ? { _meta: f._meta } : {}),
        })}\n\n`,
      );
    }
    if (opts.holdOpenMs) {
      let ended = false;
      const timer = setTimeout(() => {
        ended = true;
        res.end();
      }, opts.holdOpenMs);
      req.on('close', () => {
        if (!ended) {
          state.eventsAbortedByClient = true;
          clearTimeout(timer);
        }
      });
      return;
    }
    res.end();
  });

  app.post('/session/:id/permission/:requestId', (req, res) => {
    state.lastRespondedPermission = {
      requestId: req.params.requestId,
      response: req.body,
    };
    const status = opts.permissionStatus ?? 200;
    res.status(status).json(status === 200 ? {} : { error: 'no pending' });
  });

  app.get('/session/:id/supported-commands', (req, res) => {
    const status = opts.supportedCommandsStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    res.json({
      v: 1,
      sessionId: req.params.id,
      availableSkills: opts.supportedSkills ?? ['review'],
      availableCommands: opts.supportedCommands ?? [],
    });
  });

  app.get('/session/:id/context', (req, res) => {
    const status = opts.contextStatusCode ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    const cwd = opts.workspaceCwd ?? '/proj';
    res.status(200).json(
      opts.contextStatus ?? {
        v: 1,
        sessionId: req.params.id,
        workspaceCwd: cwd,
        state: {
          models: {
            v: 1,
            workspaceCwd: cwd,
            initialized: true,
            current: { authType: 'openai', modelId: 'qwen3-coder:30b' },
            providers: [
              {
                kind: 'model_provider',
                authType: 'openai',
                current: true,
                models: [
                  {
                    modelId: 'qwen3-coder:30b',
                    baseModelId: 'qwen3-coder:30b',
                    name: 'Qwen3 Coder 30B',
                    contextLimit: 262144,
                    isCurrent: true,
                    isRuntime: false,
                  },
                ],
              },
            ],
          },
          modes: {
            currentModeId: 'default',
            availableModes: [
              { id: 'default', name: 'Auto mode', description: 'auto' },
              { id: 'yolo', name: 'YOLO', description: 'yolo' },
            ],
          },
          configOptions: [],
        },
      },
    );
  });

  app.get('/session/:id/context-usage', (req, res) => {
    const status = opts.contextUsageStatusCode ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    const cwd = opts.workspaceCwd ?? '/proj';
    // A real fill against a 262144-token window: 25% used. The numbers are the
    // daemon's own shape, so a test that reads one field cannot accidentally
    // be reading a different route's payload.
    res.status(200).json(
      opts.contextUsageStatus ?? {
        v: 1,
        sessionId: req.params.id,
        workspaceCwd: cwd,
        usage: {
          modelName: 'qwen3-coder:30b',
          totalTokens: 65536,
          contextWindowSize: 262144,
          breakdown: {
            systemPrompt: 4096,
            builtinTools: 8192,
            mcpTools: 0,
            memoryFiles: 1024,
            skills: 512,
            messages: 51712,
            freeSpace: 196608,
            autocompactBuffer: 0,
          },
          builtinTools: [],
          mcpTools: [],
          memoryFiles: [],
          skills: [],
          isEstimated: false,
          showDetails: req.query['detail'] === 'true',
        },
        formattedText: 'Context usage: 65536/262144',
      },
    );
  });

  app.get('/session/:id/export', (req, res) => {
    const status = opts.exportStatusCode ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    const formats = ['html', 'md', 'json', 'jsonl'];
    const mime: Record<string, string> = {
      html: 'text/html; charset=utf-8',
      md: 'text/markdown; charset=utf-8',
      json: 'application/json; charset=utf-8',
      jsonl: 'application/x-ndjson; charset=utf-8',
    };
    const requested =
      typeof req.query['format'] === 'string' ? req.query['format'] : '';
    // The daemon owns the format vocabulary and answers one it does not know
    // with 400 + allowedFormats. The stub refuses the same way, because a stub
    // that only ever said 200 could not prove the gateway relays a refusal
    // rather than laundering it.
    if (requested.length > 0 && !formats.includes(requested)) {
      res.status(400).json({
        error: 'Invalid export format',
        code: 'invalid_export_format',
        format: requested,
        allowedFormats: formats,
      });
      return;
    }
    const format = requested.length > 0 ? requested : 'html';
    // Raw file bytes plus the two headers the SDK rebuilds
    // {content, filename, mimeType} from. A JSON body here would let the
    // gateway pass a test for a response shape the real daemon never sends.
    const content =
      opts.exportContent ?? `# session ${String(req.params.id).slice(0, 8)}\n`;
    res
      .status(200)
      .set('Content-Type', mime[format] ?? 'text/plain')
      .set(
        'Content-Disposition',
        `attachment; filename="session-${String(req.params.id).slice(0, 8)}.${format}"`,
      )
      .send(content);
  });

  app.get('/session/:id/transcript', (req, res) => {
    // Records the query the caller's request carried. The gateway relays the
    // paging parameters rather than re-deriving them, so this is the only
    // place a test can see whether they survived the trip.
    state.lastTranscriptQuery = Object.fromEntries(
      Object.entries(req.query as Record<string, unknown>),
    );
    const status = opts.transcriptStatusCode ?? 200;
    if (status !== 200) {
      // The daemon answers a bad anchor combination with 400 +
      // `invalid_transcript_cursor`. The stub refuses the same way so a test
      // can prove the gateway passes that verdict through.
      res.status(status).json({
        error: 'Invalid transcript cursor and anchor combination',
        code: 'invalid_transcript_cursor',
      });
      return;
    }
    if (opts.transcriptPage !== undefined) {
      res.status(200).json(opts.transcriptPage);
      return;
    }
    res.status(200).json({
      v: 1,
      sessionId: String(req.params.id),
      events: [
        // Stored events as the daemon serves them (checked against a live
        // daemon, #202): the ACP update spread onto `data`, its clock at
        // `data._meta.timestamp` (epoch ms, the record's own time) beside the
        // record id, and nothing on the envelope. The live stream and the WAL
        // are the ones that stamp the envelope (`_meta.serverTimestamp`); a
        // fixture that did the same here hid the missing-times bug in #171.
        {
          v: 1,
          type: 'session_update',
          data: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'first record' },
            _meta: {
              timestamp: 1_767_225_600_000,
              'qwen.session.recordId': 'rec-1',
            },
          },
        },
        {
          v: 1,
          type: 'session_update',
          data: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'second record' },
            _meta: {
              timestamp: 1_767_225_601_000,
              'qwen.session.recordId': 'rec-2',
            },
          },
        },
      ],
      nextCursor: 'eyJyZWNvcmRJZCI6IjIifQ',
      hasMore: true,
      startTime: '2026-01-01T00:00:00.000Z',
    });
  });

  app.get('/session/:id/turn-index', (req, res) => {
    state.lastTurnIndexQuery = Object.fromEntries(
      Object.entries(req.query as Record<string, unknown>),
    );
    const status = opts.turnIndexStatusCode ?? 200;
    if (status !== 200) {
      // The daemon answers a `start` with no `snapshot` with 400 +
      // `invalid_transcript_cursor`. The stub refuses the same way so a test can
      // prove the gateway passes that verdict through rather than laundering it.
      res.status(status).json({
        error: 'Invalid turn index paging parameters',
        code: 'invalid_transcript_cursor',
      });
      return;
    }
    if (opts.turnIndexPage !== undefined) {
      res.status(200).json(opts.turnIndexPage);
      return;
    }
    res.status(200).json({
      v: 1,
      sessionId: String(req.params.id),
      snapshot: 'sn-1',
      totalTurns: 2,
      start: 0,
      turns: [
        // Real DaemonSessionTurnIndexEntry shapes. A made-up entry here would
        // let a caller that understands nothing still report a two-turn index.
        {
          ordinal: 0,
          turnId: 'turn-1',
          kind: 'prompt',
          promptId: 'prompt-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          label: 'first turn',
        },
        {
          ordinal: 1,
          turnId: 'turn-2',
          kind: 'prompt',
          promptId: 'prompt-2',
          timestamp: '2026-01-01T00:01:00.000Z',
          label: 'second turn',
        },
      ],
      startTime: '2026-01-01T00:00:00.000Z',
    });
  });

  // The daemon registers `current` before `/turns/:promptId` and answers with
  // its `BridgeTurnStatus` as-is (packages/cli/src/serve/routes/session.ts).
  app.get('/session/:id/turns/current', (req, res) => {
    state.currentTurnReads += 1;
    const status = opts.currentTurnStatusCode ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'Not Found' });
      return;
    }
    const body =
      typeof opts.currentTurn === 'function'
        ? (opts.currentTurn as () => unknown)()
        : opts.currentTurn;
    res.status(200).json(
      body ?? { sessionId: String(req.params.id), state: 'idle' },
    );
  });

  app.post('/session/:id/recap', (req, res) => {
    state.lastRecapSessionId = String(req.params.id);
    const status = opts.recapStatusCode ?? 200;
    if (status !== 200) {
      // A daemon from before the route existed 404s, with no code in the
      // body to tell anyone. The stub refuses the same way so a test can
      // prove the gateway reports an old daemon as old rather than as a
      // conversation that has gone missing.
      res.status(status).json({ error: 'Not Found' });
      return;
    }
    if (opts.recapResult !== undefined) {
      res.status(200).json(opts.recapResult);
      return;
    }
    res.status(200).json({
      sessionId: String(req.params.id),
      // A real DaemonSessionRecapResult: one sentence, in the daemon's own
      // voice, naming what the conversation was about.
      recap: 'Asked why paging skipped a row, then fixed the offset math.',
    });
  });

  app.post('/session/:id/btw', (req, res) => {
    state.lastBtwSessionId = String(req.params.id);
    const question = (req.body as { question?: unknown } | undefined)?.question;
    state.lastBtwQuestion = typeof question === 'string' ? question : undefined;
    const status = opts.btwStatusCode ?? 200;
    if (status !== 200) {
      // Default refusal is the shapeless 404 of a daemon that has no such
      // route, which is what the gateway must report as the daemon being old
      // rather than as a conversation that has gone missing. A test wanting
      // the other 404, the guard's session_not_found, supplies it through
      // btwResult.
      res.status(status).json(opts.btwResult ?? { error: 'Not Found' });
      return;
    }
    if (opts.btwResult !== undefined) {
      res.status(200).json(opts.btwResult);
      return;
    }
    res.status(200).json({
      sessionId: String(req.params.id),
      // A real DaemonSessionBtwResult: an answer to the question that was
      // asked, and null is a legal value the gateway has to carry.
      answer:
        'It skipped a row because the offset was computed before the filter.',
    });
  });

  app.post('/session/:id/worktree-reset', (req, res) => {
    state.lastWorktreeReset = {
      sessionId: String(req.params.id),
      body: req.body,
    };
    const status = opts.worktreeResetStatusCode ?? 200;
    if (status !== 200) {
      // Default refusal is the active-transfer 409, the one a caller can act
      // on. The gateway must tell the three 409 codes apart, so a scenario
      // wanting a specific one names its code through worktreeResetResult.
      res.status(status).json(
        opts.worktreeResetResult ?? {
          error: 'Conflict',
          code: 'worktree_reset_active',
        },
      );
      return;
    }
    if (opts.worktreeResetResult !== undefined) {
      res.status(200).json(opts.worktreeResetResult);
      return;
    }
    state.worktreeResetCount += 1;
    // A real fresh transfer: a DIFFERENT session id, and an owner-style client
    // id registered on the replacement. Both are the point of this stub - a
    // relay that echoed the request id, or that kept the client id for the
    // caller instead of releasing it, would look fine and be wrong.
    res.status(200).json({
      sessionId: `s-after-reset-${state.worktreeResetCount}`,
      clientId: `client-owner-style-${state.worktreeResetCount}`,
    });
  });

  app.post('/session/:id/detach', (req, res) => {
    state.detachCalls.push({
      sessionId: String(req.params.id),
      clientId: req.get('X-Qwen-Client-Id') ?? undefined,
    });
    res.status(opts.detachStatusCode ?? 204).end();
  });

  // What the session produced. The envelope shape is the daemon's own
  // (v, sessionId, artifacts, generatedAt, limits) and each entry carries the
  // fields the store builds, so a gateway that reshaped it would be tested
  // against a fiction.
  app.get('/session/:id/artifacts', (req, res) => {
    state.lastArtifactListSessionId = String(req.params.id);
    const status = opts.artifactListStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    if (opts.artifactListResult !== undefined) {
      res.status(200).json(opts.artifactListResult);
      return;
    }
    res.status(200).json({
      v: 1,
      sessionId: String(req.params.id),
      generatedAt: '2026-10-26T09:00:00.000Z',
      limits: { maxArtifacts: 64 },
      artifacts: [
        {
          id: 'art-web-1',
          kind: 'html',
          storage: 'snapshot',
          source: 'tool',
          status: 'available',
          title: 'Saved webpage: paging notes',
          url: 'https://example.com/paging',
          mimeType: 'text/html',
          sizeBytes: 2048,
          retention: 'session',
          clientRetained: false,
          createdAt: '2026-10-26T08:00:00.000Z',
          updatedAt: '2026-10-26T08:00:00.000Z',
        },
        {
          id: 'art-file-1',
          kind: 'file',
          storage: 'workspace',
          source: 'client',
          status: 'available',
          title: 'decisions.md',
          workspacePath: 'decisions.md',
          mimeType: 'text/markdown',
          sizeBytes: 512,
          retention: 'session',
          clientRetained: true,
          createdAt: '2026-10-26T08:30:00.000Z',
          updatedAt: '2026-10-26T08:30:00.000Z',
        },
      ],
    });
  });

  // The snapshot read answers with the body AND the headers the daemon chose
  // (session.ts:7331-7336), not just the bytes. The SDK discards those headers
  // before the gateway ever sees a value, so the route restates them; serving
  // anything else here would let that restatement be tested against itself
  // rather than against the source of truth.
  app.get('/session/:id/artifacts/:artifactId/content', (req, res) => {
    state.lastArtifactContent = {
      sessionId: String(req.params.id),
      artifactId: String(req.params.artifactId),
    };
    const status = opts.artifactContentStatus ?? 200;
    if (status !== 200) {
      res.status(status).json(
        opts.artifactContentErrorBody ?? {
          error: 'artifact_snapshot_unavailable',
          message: 'Saved webpage version is missing or has changed.',
        },
      );
      return;
    }
    res
      .status(200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="saved-webpage.html"',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      })
      .send(opts.artifactContentBody ?? '<!doctype html><p>saved snapshot</p>');
  });

  app.get('/session/:id/resources', (req, res) => {
    state.lastResourcesSessionId = String(req.params.id);
    const status = opts.resourcesStatusCode ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    if (opts.resourcesResult !== undefined) {
      res.status(200).json(opts.resourcesResult);
      return;
    }
    const cwd = opts.workspaceCwd ?? '/proj';
    // A real DaemonSessionResourcesStatus, and note what is NOT here: the
    // name-keyed hasOAuthTokens, requiresAuth, authenticationState and
    // authenticationError fields are absent on this route by design
    // (packages/sdk-typescript/src/daemon/types.ts:2526-2533), so leaving them
    // out is what the daemon actually sends. A stub that filled them in would
    // let a page that draws an auth verdict pass while the real route could
    // only ever feed it absence.
    res.status(200).json({
      v: 1,
      sessionId: String(req.params.id),
      workspaceCwd: cwd,
      skills: {
        v: 1,
        workspaceCwd: cwd,
        initialized: true,
        skills: [
          {
            kind: 'skill',
            name: 'pdf',
            description: 'Read a PDF',
            level: 'user',
            modelInvocable: true,
          },
          {
            kind: 'skill',
            name: 'quiet-skill',
            description: 'Turned off',
            level: 'bundled',
            modelInvocable: false,
            disabledReason: 'default',
          },
        ],
      },
      mcp: {
        v: 1,
        workspaceCwd: cwd,
        initialized: true,
        source: 'live',
        servers: [
          {
            kind: 'mcp_server',
            name: 'playwright',
            mcpStatus: 'connected',
            transport: 'stdio',
            disabled: false,
          },
          {
            kind: 'mcp_server',
            name: 'sleepy',
            mcpStatus: 'disconnected',
            transport: 'sse',
            disabled: true,
          },
        ],
        clientCount: 2,
        clientBudget: 4,
        budgetMode: 'enforce',
      },
    });
  });

  app.get('/session/:id/stats', (req, res) => {
    state.lastStatsSessionId = String(req.params.id);
    const status = opts.statsStatusCode ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    if (opts.statsResult !== undefined) {
      res.status(200).json(opts.statsResult);
      return;
    }
    const cwd = opts.workspaceCwd ?? '/proj';
    // A real DaemonSessionStatsStatus. Every number here is deliberately
    // unlike the context-usage stub's 65536/262144, so a test that reads a
    // token count cannot accidentally be reading the other route's payload.
    res.status(200).json({
      v: 1,
      sessionId: String(req.params.id),
      workspaceCwd: cwd,
      sessionStartTimeMs: 1_767_225_600_000,
      durationMs: 5_400_000,
      promptCount: 7,
      models: {
        'qwen3-coder:30b': {
          api: { totalRequests: 42, totalErrors: 1, totalLatencyMs: 91_000 },
          tokens: {
            prompt: 120_000,
            candidates: 8_000,
            total: 128_000,
            cached: 30_000,
            thoughts: 2_000,
          },
        },
      },
      sources: [
        {
          id: 'inv-1',
          type: 'general-purpose',
          name: 'audit the paging path',
          tokens: {
            prompt: 9_000,
            candidates: 500,
            total: 9_500,
            cached: 0,
            thoughts: 0,
          },
        },
      ],
      tools: {
        totalCalls: 12,
        totalSuccess: 10,
        totalFail: 2,
        totalDurationMs: 4_200,
        byName: {
          read_file: {
            count: 8,
            success: 7,
            fail: 1,
            durationMs: 900,
            decisions: {
              accept: 7,
              reject: 0,
              modify: 0,
              auto_accept: 1,
            },
          },
          run_shell_command: {
            count: 4,
            success: 3,
            fail: 1,
            durationMs: 3_300,
            decisions: {
              accept: 2,
              reject: 1,
              modify: 0,
              auto_accept: 1,
            },
          },
        },
      },
      files: { totalLinesAdded: 140, totalLinesRemoved: 22 },
      skills: {
        totalCalls: 1,
        totalSuccess: 1,
        totalFail: 0,
        byName: { review: { count: 1, success: 1, fail: 0 } },
      },
    });
  });

  // -- Workspace file reads (add-capability-parity #107) ----------------
  // The daemon's four reads answer JSON (the SDK calls r.json() on each), so
  // the stub does too. Each records the query it received: the gateway's job
  // is to carry the caller's path/pattern through to the daemon, and a stub
  // that never looked at what arrived could not prove it happened.

  app.get('/list', (req, res) => {
    state.lastListQuery = Object.fromEntries(
      Object.entries(req.query as Record<string, unknown>),
    );
    const status = opts.listStatus ?? 200;
    if (status !== 200) {
      res.status(status).json(opts.listErrorBody ?? { error: 'stub error' });
      return;
    }
    res.status(200).json(
      opts.listResult ?? {
        kind: 'list',
        path: String(req.query['path'] ?? '.'),
        entries: [
          { name: 'src', kind: 'directory', ignored: false },
          { name: 'README.md', kind: 'file', ignored: false },
          { name: 'node_modules', kind: 'directory', ignored: true },
        ],
        truncated: false,
        matchedIgnore: null,
      },
    );
  });

  app.get('/glob', (req, res) => {
    state.lastGlobQuery = Object.fromEntries(
      Object.entries(req.query as Record<string, unknown>),
    );
    const status = opts.globStatus ?? 200;
    if (status !== 200) {
      res.status(status).json(opts.globErrorBody ?? { error: 'stub error' });
      return;
    }
    res.status(200).json(
      opts.globResult ?? {
        kind: 'glob',
        pattern: String(req.query['pattern'] ?? ''),
        cwd: '',
        matches: ['src/index.ts'],
        count: 1,
        truncated: false,
        durationMs: 3,
      },
    );
  });

  app.get('/file/bytes', (req, res) => {
    state.lastFileBytesQuery = Object.fromEntries(
      Object.entries(req.query as Record<string, unknown>),
    );
    const status = opts.fileBytesStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.fileBytesErrorBody ?? { error: 'stub error' });
      return;
    }
    const target = String(req.query['path'] ?? 'img.png');
    res.status(200).json(
      opts.fileBytesResult ?? {
        kind: 'file_bytes',
        path: target,
        offset: 0,
        sizeBytes: 8,
        returnedBytes: 8,
        truncated: false,
        contentBase64: Buffer.from('pngbytes').toString('base64'),
      },
    );
  });

  app.get('/file', (req, res) => {
    state.lastFileQuery = Object.fromEntries(
      Object.entries(req.query as Record<string, unknown>),
    );
    const status = opts.fileStatus ?? 200;
    if (status !== 200) {
      res.status(status).json(opts.fileErrorBody ?? { error: 'stub error' });
      return;
    }
    const target = String(req.query['path'] ?? 'README.md');
    res.status(200).json(
      opts.fileResult ?? {
        kind: 'file',
        path: target,
        content: '# hello\n',
        encoding: 'utf-8',
        bom: false,
        lineEnding: 'lf',
        sizeBytes: 8,
        returnedBytes: 8,
        truncated: false,
        matchedIgnore: null,
        originalLineCount: 2,
        nextCursor: null,
        hasMore: false,
      },
    );
  });

  app.get('/session/:id/status', (req, res) => {
    const status = opts.sessionStatusCode ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    const cwd = opts.workspaceCwd ?? '/proj';
    res.status(200).json(
      opts.sessionStatus ?? {
        sessionId: req.params.id,
        workspaceCwd: cwd,
        clientCount: 0,
        hasActivePrompt: false,
        pendingInteractions: [],
      },
    );
  });

  app.delete('/session/:id', (req, res) => {
    state.lastEndedSessionId = req.params.id;
    const status = opts.endSessionStatus ?? 204;
    // The SDK's closeSession resolves on 204 (closed) or 404 (already gone)
    // and throws on anything else. Map the "success" statuses (200/204) to a
    // 204 so a real DaemonClient resolves cleanly; pass other statuses through.
    if (status === 200 || status === 204) {
      res.status(204).end();
    } else {
      res.status(status).json({ error: 'stub error' });
    }
  });

  app.post('/session/:id/cancel', (req, res) => {
    state.lastCancelledSessionId = req.params.id;
    state.cancelCount += 1;
    const status = opts.cancelSessionStatus ?? 204;
    if (status === 200 || status === 204) {
      res.status(204).end();
    } else {
      res.status(status).json({ error: 'stub error' });
    }
  });

  // #109: the attachment routes. The upload carries the file as the raw body
  // with its own media type, so this route reads it with a raw parser rather
  // than the JSON parser mounted globally (which only claims application/json
  // and would leave the bytes unconsumed). What it records is the name, the
  // media type and the byte count: the gateway's job is to carry all three
  // through, and a stub that ignored them could not prove that happened.
  app.post(
    '/session/:id/attachments',
    express.raw({ type: () => true, limit: '16mb' }),
    (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      state.lastAttachmentUpload = {
        name: req.query['name'],
        contentType: req.headers['content-type'],
        byteLength: body.length,
      };
      const status = opts.attachmentUploadStatus ?? 201;
      if (status !== 201) {
        res
          .status(status)
          .json(opts.attachmentUploadErrorBody ?? { error: 'stub error' });
        return;
      }
      const declaredMimeType = String(
        req.headers['content-type'] ?? 'application/octet-stream',
      )
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
      res.status(201).json(
        opts.attachmentUploadResult ?? {
          // The store answers with the finished reference and chooses the kind
          // itself (`:586-594`), so an answer missing `type` would let a page
          // scenario pass on a block a real daemon refuses with 400:
          // `isSessionAttachmentReference` requires it (`:175-193`).
          type: STUB_SUPPORTED_IMAGE_MIME_TYPES.has(declaredMimeType)
            ? 'image'
            : 'resource',
          // The reference has no `name` field, and the id IS the stored name:
          // the store answers `attachmentId: name` (:590) with the mime it
          // inferred from that same name (:585). A page that read `name`, or
          // that treated the id as an opaque token, would work here and show
          // blanks on a device. `mimeType` stays the declared one, which is
          // what the store's own check at :355-360 forces it to be whenever
          // the kind is image; an unusual extension can still diverge.
          attachmentId: String(req.query['name'] ?? 'attachment'),
          mimeType: declaredMimeType,
          size: body.length,
        },
      );
    },
  );

  app.get('/session/:id/attachments', (req, res) => {
    state.lastAttachmentListSessionId = req.params.id;
    const status = opts.attachmentListStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.attachmentListErrorBody ?? { error: 'stub error' });
      return;
    }
    res.status(200).json(
      opts.attachmentListResult ?? {
        // The same four fields the store builds for every entry at :840-846,
        // in the store's own order (upload order, mtime as the key). There is
        // no `name` to read: the name is the `attachmentId`.
        attachments: [
          {
            type: 'resource',
            attachmentId: 'log.txt',
            mimeType: 'text/plain',
            size: 12,
          },
        ],
      },
    );
  });

  // The read answers with the file itself, which is what the daemon does, so
  // what the gateway relays is the SDK's framing of these bytes rather than
  // something this file composed.
  app.get('/session/:id/attachments/:attachmentId', (req, res) => {
    state.lastAttachmentRead = {
      sessionId: String(req.params.id),
      attachmentId: String(req.params.attachmentId),
    };
    const status = opts.attachmentReadStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.attachmentReadErrorBody ?? { error: 'stub error' });
      return;
    }
    res
      .status(200)
      .set(
        'Content-Type',
        opts.attachmentReadContentType ?? 'application/octet-stream',
      )
      .send(Buffer.from(opts.attachmentReadBody ?? 'attachment body'));
  });

  app.delete('/session/:id/attachments/:attachmentId', (req, res) => {
    state.lastAttachmentRemove = {
      sessionId: String(req.params.id),
      attachmentId: String(req.params.attachmentId),
    };
    const status = opts.attachmentRemoveStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.attachmentRemoveErrorBody ?? { error: 'stub error' });
      return;
    }
    res.status(200).json({ removed: opts.attachmentRemoveResult ?? true });
  });

  // #110: the visible queue. Bodies match the daemon's own shapes: a pending
  // prompt carries `state` ('running' for the one in flight, 'queued' for the
  // FIFO) and the mid-turn snapshot is three fields, not one list, because a
  // caller reconciles against the settled and promoted rings as well.
  app.get('/session/:id/pending-prompts', (req, res) => {
    state.lastPendingPromptsSessionId = req.params.id;
    const status = opts.pendingPromptsStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.pendingPromptsErrorBody ?? { error: 'stub error' });
      return;
    }
    res.status(200).json(
      opts.pendingPromptsResult ?? {
        pendingPrompts: [
          {
            promptId: 'p-run',
            text: 'the one in flight',
            queuedAt: 1700000000000,
            state: 'running',
          },
          {
            promptId: 'p-queue',
            text: 'waiting its turn',
            queuedAt: 1700000000500,
            state: 'queued',
          },
        ],
      },
    );
  });

  app.delete('/session/:id/pending-prompts/:promptId', (req, res) => {
    state.lastPendingPromptRemove = {
      sessionId: req.params.id,
      promptId: req.params.promptId,
    };
    const status = opts.removePendingPromptStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.removePendingPromptErrorBody ?? { error: 'stub error' });
      return;
    }
    res.status(200).json(opts.removePendingPromptResult ?? { removed: true });
  });

  app.get('/session/:id/mid-turn-messages', (req, res) => {
    state.lastMidTurnMessagesSessionId = req.params.id;
    const status = opts.midTurnMessagesStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.midTurnMessagesErrorBody ?? { error: 'stub error' });
      return;
    }
    res.status(200).json(
      opts.midTurnMessagesResult ?? {
        messages: [{ messageId: 'm-1', text: 'typed mid-turn' }],
        settledMessageIds: ['m-old'],
        promotedMessageIds: [],
      },
    );
  });

  app.delete('/session/:id/mid-turn-messages/:messageId', (req, res) => {
    state.lastMidTurnMessageRemove = {
      sessionId: req.params.id,
      messageId: req.params.messageId,
    };
    const status = opts.removeMidTurnMessageStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.removeMidTurnMessageErrorBody ?? { error: 'stub error' });
      return;
    }
    res.status(200).json(opts.removeMidTurnMessageResult ?? { removed: true });
  });

  // #110: the write half of the mid-turn queue. The body is recorded before the
  // status check, so a test can see what the daemon was asked to hold even when
  // the stub is configured to refuse it.
  app.post('/session/:id/mid-turn-message', (req, res) => {
    const body = (req.body ?? {}) as {
      message?: unknown;
      messageId?: unknown;
    };
    state.lastEnqueueMidTurnMessage = {
      sessionId: req.params.id,
      message: typeof body.message === 'string' ? body.message : '',
      ...(typeof body.messageId === 'string'
        ? { messageId: body.messageId }
        : {}),
    };
    const status = opts.enqueueMidTurnMessageStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.enqueueMidTurnMessageErrorBody ?? { error: 'stub error' });
      return;
    }
    res.status(200).json(
      opts.enqueueMidTurnMessageResult ?? {
        accepted: true,
        messageId: 'm-2',
      },
    );
  });

  app.post('/session/:id/mid-turn-messages/send-now', (req, res) => {
    state.lastSendMidTurnMessagesNowSessionId = req.params.id;
    const status = opts.sendMidTurnMessagesNowStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.sendMidTurnMessagesNowErrorBody ?? { error: 'stub error' });
      return;
    }
    res
      .status(200)
      .json(opts.sendMidTurnMessagesNowResult ?? { requested: true });
  });

  // #111: the workspace live-state snapshot. The body carries the daemon's own
  // shape, `v` and `catalogVersion` included, because those are equality tokens
  // a caller compares against the snapshot it already holds.
  app.get('/workspaces/:workspace/sessions/live-state', (req, res) => {
    state.lastLiveStateWorkspace = req.params.workspace;
    const status = opts.liveStateStatus ?? 200;
    if (status !== 200) {
      res
        .status(status)
        .json(opts.liveStateErrorBody ?? { error: 'stub error' });
      return;
    }
    res.status(200).json(
      opts.liveStateResult ?? {
        v: 1,
        catalogVersion: { generation: 'g-1', revision: 7 },
        sessions: [
          {
            sessionId: 's-live',
            clientCount: 2,
            hasActivePrompt: true,
            activeWorkState: 'active',
            isWaitingForPermission: false,
            isWaitingForUserQuestion: false,
            updatedAt: '2026-10-24T20:00:00.000Z',
          },
        ],
      },
    );
  });

  app.get('/session/:id/rewind/snapshots', (_req, res) => {
    res.json({ snapshots: opts.rewindSnapshots ?? [] });
  });

  app.post('/session/:id/rewind', (req, res) => {
    state.lastRewindBody = req.body;
    const status = opts.rewindStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    res.status(200).json(
      opts.rewindResult ?? {
        rewound: true,
        targetTurnIndex: 0,
        filesChanged: [],
        filesFailed: [],
      },
    );
  });

  app.post('/session/:id/approval-mode', express.json(), (req, res) => {
    state.lastApprovalModeBody = req.body;
    const status = opts.approvalModeStatus ?? 200;
    if (status !== 200) {
      res.status(status).json(opts.approvalModeBody ?? { error: 'stub' });
      return;
    }
    const r = opts.approvalModeResult ?? {
      sessionId: req.params.id,
      mode: req.body?.mode ?? 'default',
      previous: 'default',
      persisted: false,
    };
    res.status(200).json({
      sessionId: r.sessionId ?? req.params.id,
      mode: r.mode,
      previous: r.previous,
      persisted: r.persisted,
    });
  });

  app.patch('/session/:id/metadata', express.json(), (req, res) => {
    state.lastMetadataBody = req.body;
    const status = opts.metadataStatus ?? 200;
    if (status !== 200) {
      res.status(status).json(opts.metadataBody ?? { error: 'stub' });
      return;
    }
    // The default answers with the name it was sent, because that is what the
    // real route does for an ordinary name. A test that has to tell the
    // gateway's own input apart from the daemon's verdict sets metadataResult
    // to something else, and the route has to report THAT one.
    res
      .status(200)
      .json(opts.metadataResult ?? { displayName: req.body?.displayName });
  });

  app.post('/session/:id/model', express.json(), (req, res) => {
    const status = opts.setModelStatus ?? 200;
    if (status !== 200) {
      res.status(status).json(opts.setModelBody ?? { error: 'stub' });
      return;
    }
    res.status(200).json(opts.setModelResult ?? { modelId: req.body?.modelId });
  });

  app.post('/session/:id/prompt', (req, res) => {
    const status = opts.promptStatus ?? 200;
    state.lastPromptBody = req.body;
    const startedAt = Date.now();
    if (opts.promptAccepts) {
      res.status(202).json({ promptId: 'stub-prompt-1', lastEventId: 0 });
      return;
    }
    const respond = () => {
      state.promptCallLog.push({
        sessionId: req.params.id,
        startedAt,
        endedAt: Date.now(),
      });
      if (status === 200) {
        res
          .status(200)
          .json({ stopReason: opts.promptStopReason ?? 'end_turn' });
      } else {
        res.status(status).json({ error: 'stub error' });
      }
    };
    if (opts.promptDelayMs) {
      // Detect real client disconnection via the socket — NOT req, which emits
      // 'close' immediately after the POST body is consumed by express.json(),
      // even though the TCP connection is still open.
      let settled = false;
      // Box the timer so socketClose (defined before the setTimeout call) can
      // reference and clear it without a let/reassignment lint error.
      const timerRef: { id?: ReturnType<typeof setTimeout> } = {};
      const socketClose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timerRef.id);
          // Socket is gone; nothing to send back.
        }
      };
      req.socket?.on('close', socketClose);
      timerRef.id = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.socket?.off('close', socketClose);
        respond();
      }, opts.promptDelayMs);
    } else {
      respond();
    }
  });

  app.post('/session', (req, res) => {
    const status = opts.createSessionStatus ?? 200;
    state.lastCreateSessionBody = req.body;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    state.createdSessionCount += 1;
    const mintSessionId =
      opts.createSessionId ?? ((n: number) => `stub-agent-${n}`);
    res.status(200).json({
      sessionId: mintSessionId(state.createdSessionCount),
      workspaceCwd: opts.workspaceCwd ?? '/stub/workspace',
      attached: false,
    });
  });

  app.post('/session/:id/resume', (req, res) => {
    state.lastResumeSessionBody = req.body;
    const status = opts.resumeSessionStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    const cwd = (req.body as { cwd?: unknown })?.cwd;
    res.status(200).json({
      sessionId: req.params.id,
      workspaceCwd:
        typeof cwd === 'string' && cwd.length > 0
          ? cwd
          : (opts.workspaceCwd ?? '/stub/workspace'),
      attached: true,
      state: {},
    });
  });

  // Mirrors /resume: DaemonPool.resumeSession restores through the load
  // action (no-history bug, #37), so pool-based tests exercise this route.
  app.post('/session/:id/load', (req, res) => {
    state.lastLoadSessionBody = req.body;
    const status = opts.loadSessionStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    const cwd = (req.body as { cwd?: unknown })?.cwd;
    res.status(200).json({
      sessionId: req.params.id,
      workspaceCwd:
        typeof cwd === 'string' && cwd.length > 0
          ? cwd
          : (opts.workspaceCwd ?? '/stub/workspace'),
      attached: true,
      state: {},
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get lastEventIdHeader() {
      return state.lastEventIdHeader;
    },
    get eventsAbortedByClient() {
      return state.eventsAbortedByClient;
    },
    get lastEndedSessionId() {
      return state.lastEndedSessionId;
    },
    get lastCancelledSessionId() {
      return state.lastCancelledSessionId;
    },
    get cancelCount() {
      return state.cancelCount;
    },
    get createdSessionCount() {
      return state.createdSessionCount;
    },
    get lastCreateSessionBody() {
      return state.lastCreateSessionBody;
    },
    get lastResumeSessionBody() {
      return state.lastResumeSessionBody;
    },
    get lastLoadSessionBody() {
      return state.lastLoadSessionBody;
    },
    get lastPromptBody() {
      return state.lastPromptBody;
    },
    get lastRewindBody() {
      return state.lastRewindBody;
    },
    get lastApprovalModeBody() {
      return state.lastApprovalModeBody;
    },
    get lastMetadataBody() {
      return state.lastMetadataBody;
    },
    get lastRespondedPermission() {
      return state.lastRespondedPermission;
    },
    get promptCallLog() {
      return state.promptCallLog;
    },
    get lastPermissionRulesBody() {
      return state.lastPermissionRulesBody;
    },
    get lastTrustRequestBody() {
      return state.lastTrustRequestBody;
    },
    get lastSetSettingBody() {
      return state.lastSetSettingBody;
    },
    get setSettingBodies() {
      return state.setSettingBodies;
    },
    get lastToolToggleBody() {
      return state.lastToolToggleBody;
    },
    get lastToolToggleName() {
      return state.lastToolToggleName;
    },
    get lastMcpReloadBody() {
      return state.lastMcpReloadBody;
    },
    get lastListQuery() {
      return state.lastListQuery;
    },
    get lastGlobQuery() {
      return state.lastGlobQuery;
    },
    get lastMemoryQuery() {
      return state.lastMemoryQuery;
    },
    get lastFileQuery() {
      return state.lastFileQuery;
    },
    get lastFileBytesQuery() {
      return state.lastFileBytesQuery;
    },
    get lastTranscriptQuery() {
      return state.lastTranscriptQuery;
    },
    get lastTurnIndexQuery() {
      return state.lastTurnIndexQuery;
    },
    get currentTurnReads() {
      return state.currentTurnReads;
    },
    get lastRecapSessionId() {
      return state.lastRecapSessionId;
    },
    get lastBtwSessionId() {
      return state.lastBtwSessionId;
    },
    get lastBtwQuestion() {
      return state.lastBtwQuestion;
    },
    get lastWorktreeReset() {
      return state.lastWorktreeReset;
    },
    get detachCalls() {
      return state.detachCalls;
    },
    get lastStatsSessionId() {
      return state.lastStatsSessionId;
    },
    get lastResourcesSessionId() {
      return state.lastResourcesSessionId;
    },
    get lastArtifactListSessionId() {
      return state.lastArtifactListSessionId;
    },
    get lastArtifactContent() {
      return state.lastArtifactContent;
    },
    get lastAttachmentUpload() {
      return state.lastAttachmentUpload;
    },
    get lastAttachmentListSessionId() {
      return state.lastAttachmentListSessionId;
    },
    get lastAttachmentRead() {
      return state.lastAttachmentRead;
    },
    get lastAttachmentRemove() {
      return state.lastAttachmentRemove;
    },
    get lastPendingPromptsSessionId() {
      return state.lastPendingPromptsSessionId;
    },
    get lastPendingPromptRemove() {
      return state.lastPendingPromptRemove;
    },
    get lastMidTurnMessagesSessionId() {
      return state.lastMidTurnMessagesSessionId;
    },
    get lastMidTurnMessageRemove() {
      return state.lastMidTurnMessageRemove;
    },
    get lastEnqueueMidTurnMessage() {
      return state.lastEnqueueMidTurnMessage;
    },
    get lastSendMidTurnMessagesNowSessionId() {
      return state.lastSendMidTurnMessagesNowSessionId;
    },
    get lastLiveStateWorkspace() {
      return state.lastLiveStateWorkspace;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Idempotent: crash() may already have closed the server, and a
        // second server.close() would reject with ERR_SERVER_NOT_RUNNING.
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    crash: () =>
      new Promise<void>((resolve, reject) => {
        // closeAllConnections() (Node 18.2+) destroys the live SSE sockets,
        // so close() completes without waiting for open connections.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
