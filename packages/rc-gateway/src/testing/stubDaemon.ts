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
  /** Query the most recent GET /file request carried. */
  lastFileQuery: Record<string, unknown> | undefined;
  /** Query the most recent GET /file/bytes request carried. */
  lastFileBytesQuery: Record<string, unknown> | undefined;
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
    createdSessionCount: 0,
    lastCreateSessionBody: undefined as unknown,
    lastResumeSessionBody: undefined as unknown,
    lastLoadSessionBody: undefined as unknown,
    lastPromptBody: undefined as unknown,
    lastRewindBody: undefined as unknown,
    lastApprovalModeBody: undefined as unknown,
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
    lastToolToggleBody: undefined as unknown,
    lastToolToggleName: undefined as string | undefined,
    lastMcpReloadBody: undefined as unknown,
    lastListQuery: undefined as Record<string, unknown> | undefined,
    lastGlobQuery: undefined as Record<string, unknown> | undefined,
    lastFileQuery: undefined as Record<string, unknown> | undefined,
    lastFileBytesQuery: undefined as Record<string, unknown> | undefined,
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
    res.json(
      opts.workspacePermissionsResult ?? {
        v: 1,
        user: [],
        workspace: [],
        merged: [],
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
    res.json(
      opts.setPermissionRulesResult ?? {
        v: 1,
        user: [],
        workspace: [],
        merged: Array.isArray(b.rules) ? b.rules : [],
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
      features: [],
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
    express.raw({ type: () => true }),
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
      res.status(201).json(
        opts.attachmentUploadResult ?? {
          attachmentId: 'att-1',
          name: String(req.query['name'] ?? ''),
          mimeType: req.headers['content-type'] ?? 'application/octet-stream',
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
        attachments: [{ attachmentId: 'att-1', name: 'log.txt', size: 12 }],
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
    get lastFileQuery() {
      return state.lastFileQuery;
    },
    get lastFileBytesQuery() {
      return state.lastFileBytesQuery;
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
