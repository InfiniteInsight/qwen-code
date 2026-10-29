/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import type {
  DaemonClient,
  CreateSessionRequest,
  DaemonSession,
  SubscribeOptions,
  DaemonEvent,
  PromptRequest,
  PromptResult,
  DaemonSessionContextStatus,
  PermissionResponse,
  DaemonSessionSupportedCommandsStatus,
  DaemonApprovalMode,
  DaemonApprovalModeResult,
  SetModelResult,
  RestoreSessionRequest,
  DaemonRestoredSession,
  DaemonCapabilities,
  DaemonSessionSummary,
  DaemonToolCatalog,
  DaemonToolToggleResult,
  DaemonWorkspaceMcpInitializeResult,
  DaemonWorkspaceMcpStatus,
  DaemonWorkspaceTrustChangeRequest,
  DaemonWorkspaceTrustChangeResult,
  DaemonWorkspaceTrustStatus,
  DaemonWorkspaceTrustStatusResponse,
  DaemonWorkspaceTrustStatusV2,
  DaemonSubagentSessionResolution,
  DaemonSessionTasksStatus,
  DaemonSessionTaskWithWorkflowStatus,
  SessionMetadataResult,
  DaemonWorkspaceEnvStatus,
  DaemonWorkspacePreflightStatus,
  DaemonWorkspaceSkillsStatus,
  DaemonWorkspaceProvidersStatus,
  DaemonWorkspaceHooksStatus,
  DaemonSessionAgentsStatus,
  DaemonAgentTrace,
  DaemonSessionSavedWorkflowStatus,
} from '@qwen-code/sdk';
import {
  DaemonTransportClosedError,
  type DaemonArchiveSessionsResult,
  type DaemonRewindResult,
  type DaemonRewindSnapshotInfo,
  type DaemonSessionContextUsageStatus,
  type DaemonSessionExportFormat,
  type DaemonSessionExportResult,
  type DaemonSessionTranscriptPage,
  type DaemonSessionTranscriptPageOptions,
  type DaemonSessionTurnIndexPage,
  type DaemonSessionTurnIndexPageOptions,
  type DaemonSessionTurnStatus,
  type DaemonSessionRecapResult,
  type DaemonSessionBtwResult,
  type WorktreeResetSessionRequest,
  type DaemonSessionStatsStatus,
  type DaemonSessionResourcesStatus,
  type DaemonPermissionRuleType,
  type DaemonPermissionScope,
  type DaemonSettingUpdateResult,
  type DaemonUnarchiveSessionsResult,
  type DaemonWorkspaceFile,
  type DaemonWorkspaceFileBytes,
  type DaemonWorkspaceMcpReloadOptions,
  type DaemonWorkspacePermissionsStatus,
  type DaemonWorkspaceSettingsStatus,
  type DaemonWorkspaceMemoryStatus,
  type DaemonWorkspaceAgentsStatus,
} from '@qwen-code/sdk/daemon';
import {
  requireWorkspaceCwd,
  type DaemonWorkspaceFileWriteRequest,
  type DaemonWorkspaceFileWriteResult,
  type DaemonWorkspaceFileEditRequest,
  type DaemonWorkspaceFileEditResult,
  type DaemonWorkspaceFileUploadRequest,
  type DaemonWorkspaceFileUploadResult,
} from '@qwen-code/sdk/daemon';
import type { AuditRecorder } from './auditLog.js';
import { asDaemonHttpError, isSessionLevelGone } from './daemonHttpError.js';

/** What {@link deleteWorkspaceFileOnPrimary} needs from a client. */
export type PrimaryWorkspaceDeleteClient = Pick<
  DaemonClient,
  'capabilities' | 'workspaceById' | 'workspaceByCwd'
>;

/**
 * Delete one file in the daemon's own primary workspace (#123).
 *
 * The daemon mounts deletion only as `POST /workspaces/:workspace/file/delete`
 * and the SDK carries `deleteWorkspaceFile` only on `WorkspaceDaemonClient`,
 * so the call needs a workspace selector even for a daemon bound to one
 * workspace. The daemon's own capabilities say which: the primary entry of
 * `workspaces` by id when it lists them (newer daemons do, "so
 * workspace-qualified features can address it by ID"), else `workspaceCwd`.
 * Asking costs one round trip per delete, which is the price of never
 * guessing at a path the daemon canonicalised differently. A daemon that
 * names neither throws `DaemonCapabilityMissingError`.
 *
 * One implementation for the pool and for a route handed a bare client.
 */
export async function deleteWorkspaceFileOnPrimary(
  client: PrimaryWorkspaceDeleteClient,
  filePath: string,
  clientId?: string,
): Promise<void> {
  const caps = await client.capabilities();
  const primary = Array.isArray(caps.workspaces)
    ? caps.workspaces.find(
        (w) => w && w.primary === true && typeof w.id === 'string' && w.id,
      )
    : undefined;
  const target = primary
    ? client.workspaceById(primary.id)
    : client.workspaceByCwd(requireWorkspaceCwd(caps));
  await target.deleteWorkspaceFile(filePath, clientId);
}

/**
 * Per-id outcome of `POST /sessions/delete`. Named here because the SDK
 * declares this shape inline on `DaemonClient.deleteSessionsData` and never
 * exports a name for it, so the pool cannot spell it any other way.
 */
export interface DaemonDeleteSessionsResult {
  removed: string[];
  notFound: string[];
  errors: Array<{ sessionId: string; error: string }>;
}

/** Where a daemon can be reached and how to authenticate to it. */
export interface DaemonEndpoint {
  /** Loopback base URL, e.g. `http://127.0.0.1:46135`. */
  url: string;
  /** The daemon's `QWEN_SERVER_TOKEN`; undefined when it has none. */
  token: string | undefined;
  /** The workspace this daemon is bound to — the directory a host terminal
   * opens in, so the terminal and the conversation share one cwd. */
  workspaceCwd: string;
}

/** Result of spawning a new daemon bound to a workspace. */
export interface PooledDaemonSpawn {
  client: DaemonClient;
  stop: () => Promise<void>;
  workspaceCwd: string;
  /** Endpoint material, captured at spawn so a host terminal can attach to
   * this daemon later (issue #49). Absent → the workspace's endpoint is
   * unknown and terminal requests for it are refused. */
  endpoint?: DaemonEndpoint;
  /** Fired exactly once when the daemon child process exits (any reason).
   * The pool fills this at spawn time (add-mid-turn-recovery: death
   * detection); the spawner wires the child's exit into it. */
  onExit?: (info: DaemonExitInfo) => void;
}

/** Exit info for a daemon death, as reported by the child's exit event. */
export interface DaemonExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * The session-routing surface of `DaemonClient` that the gateway's routes
 * actually call through `deps.daemon` — signatures copied verbatim from
 * `DaemonClient` (packages/sdk-typescript/src/daemon/DaemonClient.ts) so a
 * real `DaemonClient` structurally satisfies this interface with zero
 * changes. `DaemonPool` is the other implementation: a drop-in that routes
 * each call to the pooled daemon owning the session (or workspace) instead
 * of a single daemon connection. Both are accepted wherever the gateway
 * holds `GatewayDeps.daemon`.
 */
export interface SessionDaemon {
  prompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    clientId?: string,
  ): Promise<PromptResult>;
  capabilities(): Promise<DaemonCapabilities>;
  closeSession(sessionId: string, clientId?: string): Promise<void>;
  cancel(sessionId: string, clientId?: string): Promise<void>;

  // Attachments (add-capability-parity #109, first slice). Signatures mirror
  // `DaemonClient`'s exactly, including its trailing `opts` object rather
  // than the bare `clientId` used by `cancel` above, so a plain `DaemonClient`
  // still satisfies this interface. The chunked `chunks` then `complete`
  // sequence is deliberately NOT modelled here: `DaemonClient` probes the
  // daemon once (`supportsAttachmentChunks` at its :4517) and picks the
  // single-POST fallback itself, so a gateway-side re-implementation would
  // fork a decision the SDK already owns. Return stays `unknown` because the
  // daemon owns the reference shape.
  uploadSessionAttachment(
    sessionId: string,
    data: Blob,
    name: string,
    mimeType: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<unknown>;
  listSessionAttachments(
    sessionId: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<unknown>;

  /**
   * One stored attachment, as `{ data, mimeType }` with the bytes base64
   * encoded by the SDK. Kept `unknown` because that pair is the daemon's
   * answer about its own storage.
   */
  readSessionAttachment(
    sessionId: string,
    attachmentId: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<unknown>;
  /**
   * Drop one stored attachment. The boolean is the daemon saying whether an id
   * it was given actually matched something, so it travels rather than being
   * turned into a status by this layer.
   */
  removeSessionAttachment(
    sessionId: string,
    attachmentId: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<unknown>;

  // Session artifacts (add-capability-parity #127, the read pair). The two
  // signatures differ and both mirror `DaemonClient` exactly: the list takes a
  // bare `clientId` (its :7108) while the content read takes a trailing `opts`
  // object (its :4816), so they are NOT the attachment block's uniform shape.
  // The `add`/`remove` pair is deliberately NOT modelled: the daemon's POST and
  // DELETE routes both call `requireSessionArtifactClientId`
  // (packages/cli/src/serve/routes/session.ts:466) and answer 403
  // `client_id_required` without a session-bound client id, which no gateway
  // route forwards today.
  listSessionArtifacts(sessionId: string, clientId?: string): Promise<unknown>;
  /**
   * One artifact's saved snapshot, as the SDK hands it over: a decoded string.
   *
   * The headers the daemon chose for that body are NOT reachable through this
   * method. `DaemonClient.readSessionArtifactContent`
   * (packages/sdk-typescript/src/daemon/DaemonClient.ts:4816) reads the
   * response with `res.text()` and returns the string, so `Content-Type`,
   * `Content-Disposition`, `X-Content-Type-Options` and `Cache-Control` are
   * gone by the time the gateway sees the value. The route that uses this
   * therefore re-states them rather than forwarding them; see
   * routes/sessionArtifacts.ts for why that restatement is load-bearing.
   */
  readSessionArtifactContent(
    sessionId: string,
    artifactId: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<unknown>;

  // The visible queue (add-capability-parity #110, second slice). Signatures
  // mirror `DaemonClient`'s exactly, including its trailing `opts` object, so
  // a plain `DaemonClient` still satisfies this interface. Returns stay
  // `unknown`: the daemon owns the queue shape, and the whole point of the
  // route is to show the caller what the daemon actually holds rather than a
  // gateway-side summary of it.
  getPendingPrompts(
    sessionId: string,
    opts?: { clientId?: string },
  ): Promise<unknown>;
  removePendingPrompt(
    sessionId: string,
    promptId: string,
    opts?: { clientId?: string },
  ): Promise<unknown>;
  getMidTurnMessages(
    sessionId: string,
    opts?: { clientId?: string; signal?: AbortSignal },
  ): Promise<unknown>;
  removeMidTurnMessage(
    sessionId: string,
    messageId: string,
    opts?: { clientId?: string },
  ): Promise<unknown>;
  /**
   * Named after `DaemonClient.enqueueMidTurnMessage`, on purpose. `SessionDaemon`
   * is implemented by BOTH this pool and a bare `DaemonClient` (the route tests
   * inject one), so a gateway-invented name here is `undefined` at runtime on the
   * client side and `tsc --noEmit` cannot see it (D61). Same for
   * `sendMidTurnMessagesNow` below.
   */
  enqueueMidTurnMessage(
    sessionId: string,
    message: string,
    opts?: { clientId?: string; messageId?: string },
  ): Promise<unknown>;
  sendMidTurnMessagesNow(
    sessionId: string,
    opts?: { clientId?: string },
  ): Promise<unknown>;
  subscribeEvents(
    sessionId: string,
    opts?: SubscribeOptions,
  ): AsyncGenerator<DaemonEvent>;
  respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
    clientId?: string,
  ): Promise<boolean>;
  health(): Promise<{ status: string }>;
  createOrAttachSession(
    req: CreateSessionRequest,
    clientId?: string,
  ): Promise<DaemonSession>;
  /**
   * Optional host-terminal support (issue #49): where to point a terminal that
   * wants to attach to this session. Optional so a plain `DaemonClient` still
   * structurally satisfies `SessionDaemon` with no changes; only `DaemonPool`
   * implements it. Callers treat absence as "this gateway cannot open host
   * terminals" rather than failing the request that asked.
   */
  daemonEndpointForSession?(sessionId: string): DaemonEndpoint | undefined;
  sessionSupportedCommands(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionSupportedCommandsStatus>;
  rewindSession(
    sessionId: string,
    promptId: string,
    opts?: { clientId?: string; rewindFiles?: boolean },
  ): Promise<DaemonRewindResult>;
  getRewindSnapshots(
    sessionId: string,
  ): Promise<{ snapshots: DaemonRewindSnapshotInfo[] }>;
  listWorkspaceSessions(workspaceCwd: string): Promise<DaemonSessionSummary[]>;

  /**
   * The workspace's memory-only live-state snapshot: which sessions are
   * attached right now, with how many clients, and whether each is waiting on
   * a permission or a question. Keyed by workspace, not session, and answered
   * only by the daemon that OWNS that workspace, so this resolves through the
   * pool like the other workspace-scoped calls rather than the default daemon
   * (which cannot see another workspace's attachments).
   *
   * Typed `Promise<unknown>`: the payload is the daemon's own
   * `DaemonWorkspaceSessionLiveState`, whose `v` token and `catalogVersion`
   * are equality tokens the caller compares, not fields to reinterpret.
   */
  getSessionLiveState(workspaceCwd?: string): Promise<unknown>;
  /**
   * The same snapshot, but only from a daemon that is already running for
   * the workspace: `undefined` when the pool holds none, and never a spawn
   * (#190). The list reads every recent folder's live state on each refresh,
   * and the spawning read above would start a daemon per folder to answer.
   * Optional, like `workspaces()`: a plain `DaemonClient` has no pool to
   * look in, and the route answers that it cannot read without spawning.
   */
  peekSessionLiveState?(workspaceCwd?: string): Promise<unknown | undefined>;
  setSessionApprovalMode(
    sessionId: string,
    mode: DaemonApprovalMode,
    opts?: { persist?: boolean; clientId?: string },
  ): Promise<DaemonApprovalModeResult>;
  setSessionModel(
    sessionId: string,
    modelId: string,
    clientId?: string,
  ): Promise<SetModelResult>;
  sessionContext(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionContextStatus>;
  sessionContextUsage(
    sessionId: string,
    opts?: { detail?: boolean },
    clientId?: string,
  ): Promise<DaemonSessionContextUsageStatus>;
  exportSession(
    sessionId: string,
    opts?: { format?: DaemonSessionExportFormat; clientId?: string },
  ): Promise<DaemonSessionExportResult>;
  getSessionTranscriptPage(
    sessionId: string,
    opts?: DaemonSessionTranscriptPageOptions,
  ): Promise<DaemonSessionTranscriptPage>;
  getSessionTurnIndexPage(
    sessionId: string,
    opts?: DaemonSessionTurnIndexPageOptions,
  ): Promise<DaemonSessionTurnIndexPage>;
  // The SDK's own name (#131), because a bare `DaemonClient` also implements
  // this interface and a gateway-invented name would be undefined on it.
  getCurrentSessionTurn(
    sessionId: string,
    opts?: { clientId?: string },
  ): Promise<DaemonSessionTurnStatus>;
  recapSession(
    sessionId: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<DaemonSessionRecapResult>;
  /**
   * A side question about one conversation, answered without touching the turn
   * in flight. Named `btwSession` exactly as `DaemonClient.btwSession` is
   * (packages/sdk-typescript/src/daemon/DaemonClient.ts:4437), for the reason
   * recorded in D61: `SessionDaemon` is implemented by a bare `DaemonClient` as
   * well as by this pool, so a gateway-invented name is `undefined` at runtime
   * on the client side and `tsc --noEmit` cannot see it.
   *
   * Unlike the recap read, `signal` is honoured end to end: the daemon aborts
   * the generation when its own caller hangs up, so a caller that stops waiting
   * should get what it asked for. See the module note in routes/sessionBtw.ts.
   */
  btwSession(
    sessionId: string,
    question: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<DaemonSessionBtwResult>;
  /**
   * Move a worktree session's checkout ownership to a fresh replacement
   * session. Named `resetWorktreeSession` exactly as
   * `DaemonClient.resetWorktreeSession` is
   * (packages/sdk-typescript/src/daemon/DaemonClient.ts:3719), for the reason
   * recorded in D61.
   *
   * The response is the REPLACEMENT's create-shape body, so it carries a
   * different `sessionId` from the one passed in, and the pool has to learn
   * that new id or nothing downstream can address it: `ownerEntry`
   * raises `UnknownSessionError` for any id it has never recorded, which would
   * make the very call that releases the minted client id fail before it
   * reached the daemon. The implementation therefore rebinds the replacement to
   * the same workspace key the original was owned by.
   */
  resetWorktreeSession(
    sessionId: string,
    req?: WorktreeResetSessionRequest,
  ): Promise<DaemonSession>;
  /**
   * Release one client registration on a session. Named `detachSession` exactly
   * as `DaemonClient.detachSession` is
   * (packages/sdk-typescript/src/daemon/DaemonClient.ts:6686), and it forwards
   * the id unchanged rather than substituting the pool's own, because the whole
   * point is to release a SPECIFIC registration. The SDK's method no-ops on an
   * absent id and treats both 204 and 404 as success, so it is safe to call for
   * an id that turned out not to exist.
   */
  detachSession(sessionId: string, clientId?: string): Promise<void>;
  sessionStatus(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionSummary>;
  sessionTasks(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionTasksStatus>;
  /**
   * The daemon's per-conversation roll-up: how long it ran, how many prompts
   * it took, what each model spent, and which tools were called. Read
   * verbatim, with one exception worth naming - `sources` excludes the main
   * conversation's own calls by design (the SDK documents them as the
   * aggregate remainder), so summing that list is not a session total.
   */
  sessionStats(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionStatsStatus>;
  /**
   * What one live conversation has loaded: its skills and its MCP servers.
   * Built by the daemon from that session's own Config, so the MCP half
   * reports the session's manager rather than the workspace-owned pool, and
   * the name-keyed authentication fields are always absent on this route. A
   * caller that reads that absence as "not authenticated" would be inventing a
   * verdict the daemon never gave, so relay it and let the reader draw nothing.
   */
  sessionResources(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionResourcesStatus>;
  loadSession(
    sessionId: string,
    req?: RestoreSessionRequest,
    clientId?: string,
  ): Promise<DaemonRestoredSession>;
  resumeSession(
    sessionId: string,
    req: { workspaceCwd: string },
  ): Promise<DaemonRestoredSession>;
  cancelSubagentSession(
    sessionId: string,
    subagentRef: string,
    clientId?: string,
  ): Promise<{ cancelled: boolean }>;
  cancelSessionTask(
    sessionId: string,
    taskId: string,
    kind: DaemonSessionTaskWithWorkflowStatus['kind'],
    clientId?: string,
  ): Promise<{ cancelled: boolean; reason?: string }>;
  /**
   * Renames ONE loaded session. Returns the daemon's EFFECTIVE metadata: the
   * name the daemon says is now stored, not the name that was sent. A caller
   * that echoes back its own input would report a title the daemon never
   * agreed to.
   */
  updateSessionMetadata(
    sessionId: string,
    metadata: { displayName?: string },
    clientId?: string,
  ): Promise<SessionMetadataResult>;
  resolveSubagentSession(
    sessionId: string,
    subagentRef: string,
    clientId?: string,
  ): Promise<DaemonSubagentSessionResolution>;
  /**
   * #110: the session's agent roster, running and recently finished, as the
   * daemon's registry and its on-disk sidecars report it. Named for the SDK's
   * `DaemonClient.sessionAgents`, because a bare client stands in for the pool.
   */
  sessionAgents(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionAgentsStatus>;
  /**
   * #110: who spawned whom. The daemon's trace is the agents' lineage read off
   * their sidecars, optionally narrowed to one root's tree; it carries no
   * steps, tool calls or messages.
   */
  sessionAgentTrace(
    sessionId: string,
    opts?: { rootAgentId?: string; clientId?: string },
  ): Promise<DaemonAgentTrace>;
  /** #110: one saved workflow definition by name, or `workflow: null`. */
  sessionSavedWorkflow(
    sessionId: string,
    name: string,
    clientId?: string,
  ): Promise<DaemonSessionSavedWorkflowStatus>;

  // -- Workspace control (rc-workspace-permissions) --------------------
  // Daemon-global methods: no session id, but workspace-scoped — each takes
  // an optional trailing `workspaceCwd` (rc-workspace-scoping, #28) naming
  // the workspace to act on; omitted/empty/the default workspace's cwd
  // targets the default/boot daemon. A `DaemonClient`'s own workspace
  // methods ignore the extra argument (they have no trailing parameter,
  // which is structurally fine), so a real `DaemonClient` still satisfies
  // this interface. Signatures otherwise copied verbatim from `DaemonClient`.

  workspacePermissions(
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspacePermissionsStatus>;
  setWorkspacePermissionRules(
    scope: DaemonPermissionScope,
    ruleType: DaemonPermissionRuleType,
    rules: readonly string[],
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspacePermissionsStatus>;
  workspaceTrust(
    opts?: {
      clientId?: string;
      statusVersion?: 1;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatus>;
  workspaceTrust(
    opts: {
      clientId?: string;
      statusVersion: 2;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatus | DaemonWorkspaceTrustStatusV2>;
  workspaceTrust(
    opts?: {
      clientId?: string;
      statusVersion?: 1 | 2;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatusResponse>;
  requestWorkspaceTrustChange(
    request: DaemonWorkspaceTrustChangeRequest,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustChangeResult>;
  workspaceSettings(
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceSettingsStatus>;
  // Workspace diagnostics (rc-workspace-diagnostics, #123). The daemon's own
  // wrappers take no target argument, so the trailing `workspaceCwd` is
  // resolved here: it picks which pooled client answers, and that client's
  // base URL is the target workspace. Same shape as workspaceSettings above.
  workspaceEnv(workspaceCwd?: string): Promise<DaemonWorkspaceEnvStatus>;
  workspacePreflight(
    workspaceCwd?: string,
  ): Promise<DaemonWorkspacePreflightStatus>;
  // Workspace inventory (rc-workspace-inventory, #123). Same no-argument
  // wrappers as the diagnostics pair: the trailing cwd picks the pooled
  // client, and that client's base URL is the target workspace.
  workspaceSkills(workspaceCwd?: string): Promise<DaemonWorkspaceSkillsStatus>;
  workspaceProviders(
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceProvidersStatus>;
  workspaceHooks(workspaceCwd?: string): Promise<DaemonWorkspaceHooksStatus>;
  // Workspace context (rc-workspace-context, #123). Same no-argument wrappers
  // as the two batches above; the memory wrapper deliberately takes no
  // options, because the SDK's includeContent flag is the only way to read the
  // global context file, which the file routes refuse. See routes/workspaceContext.
  workspaceMemory(workspaceCwd?: string): Promise<DaemonWorkspaceMemoryStatus>;
  listWorkspaceAgents(
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceAgentsStatus>;
  setWorkspaceSetting(
    scope: 'workspace' | 'user',
    key: string,
    value: unknown,
    opts?: {
      clientId?: string;
      mcpServerMutation?: { operation: 'set' | 'remove'; name: string };
    },
    workspaceCwd?: string,
  ): Promise<DaemonSettingUpdateResult>;
  workspaceToolsCatalog(workspaceCwd?: string): Promise<DaemonToolCatalog>;
  setWorkspaceToolEnabled(
    toolName: string,
    enabled: boolean,
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonToolToggleResult>;
  workspaceMcp(workspaceCwd?: string): Promise<DaemonWorkspaceMcpStatus>;
  reloadWorkspaceMcp(
    options?: DaemonWorkspaceMcpReloadOptions,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceMcpInitializeResult>;

  // -- Workspace files (add-capability-parity #107) ---------------------
  // The daemon's read-only file surface. Signatures mirror `DaemonClient`'s
  // SHIPPED parameters with `workspaceCwd` appended, so a plain
  // `DaemonClient` still satisfies this interface. `workspaceCwd` picks which
  // pooled daemon answers and is never forwarded; for the two reads that
  // already carry a `clientId` it stays BEHIND it, because a cwd in that slot
  // would be read as an identity rather than a target (same reason as
  // `requestWorkspaceTrustChange` above). Return types stay `unknown` where
  // the SDK leaves them `unknown`: the daemon owns those shapes and the
  // gateway relays them instead of re-describing a shape it does not own.

  dirList(dirPath: string, workspaceCwd?: string): Promise<unknown>;
  glob(pattern: string, workspaceCwd?: string): Promise<unknown>;
  readWorkspaceFile(
    filePath: string,
    opts?: {
      maxBytes?: number;
      line?: number;
      limit?: number;
      cursor?: string;
    },
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceFile>;
  readWorkspaceFileBytes(
    filePath: string,
    opts?: { offset?: number; maxBytes?: number },
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceFileBytes>;

  // -- Workspace file writes (#123) -------------------------------------
  // Same convention as the reads above: the SDK's own names and shipped
  // parameters, `workspaceCwd` appended and never forwarded. `fileStat` is
  // the stat read the delete confirmation names a size from.
  fileStat(filePath: string, workspaceCwd?: string): Promise<unknown>;
  writeWorkspaceFile(
    req: DaemonWorkspaceFileWriteRequest,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceFileWriteResult>;
  editWorkspaceFile(
    req: DaemonWorkspaceFileEditRequest,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceFileEditResult>;
  uploadWorkspaceFile(
    req: DaemonWorkspaceFileUploadRequest,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceFileUploadResult>;
  /**
   * OPTIONAL, unlike its siblings: the SDK name is `WorkspaceDaemonClient`'s,
   * and a bare `DaemonClient` has no method of that name (the daemon serves
   * deletion only under `/workspaces/:workspace`). Declaring it required
   * would be the D61 trap, a member the bare client lacks at runtime while
   * tsc stays clean. The delete route falls back to
   * {@link deleteWorkspaceFileOnPrimary} when it is absent.
   */
  deleteWorkspaceFile?(
    filePath: string,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<void>;

  // -- Sessions at rest (add-capability-parity #111) --------------------
  // Batch actions over stored transcripts, workspace-scoped like the block
  // above. Signatures mirror `DaemonClient`'s SHIPPED two parameters with
  // `workspaceCwd` appended, so a plain `DaemonClient` still satisfies this
  // interface (it takes fewer parameters, which is structurally fine).
  // `workspaceCwd` is a pool-routing argument only: it picks which pooled
  // daemon to call and is never forwarded to the client.

  archiveSessionsData(
    sessionIds: string[],
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonArchiveSessionsResult>;
  unarchiveSessionsData(
    sessionIds: string[],
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonUnarchiveSessionsResult>;
  deleteSessionsData(
    sessionIds: string[],
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonDeleteSessionsResult>;

  /** The session's recovery state (add-mid-turn-recovery §3). Optional — a
   * plain `DaemonClient` has no recovery behind it, so the events route
   * treats a missing implementation as `'idle'`. */
  recoveryState?(sessionId: string): RecoveryState;
  /** Live pooled workspace cwds, excl. the default (rc-workspace-scoping,
   * #28). Optional — a plain `DaemonClient` has no pool behind it, so the
   * workspace listing route treats a missing implementation as `[]`. */
  workspaces?(): string[];
}

export interface DaemonPoolOptions {
  /** The boot daemon, already running, used when a create omits cwd. The
   * pool never stops it. Once it dies, the default workspace is served by a
   * replacement from `spawn(defaultWorkspaceCwd)` instead (#163), unless
   * `respawnDefaultDaemon` is false. */
  defaultDaemon: DaemonClient;
  /**
   * Whether a dead default daemon is replaced by one the pool spawns
   * (`spawn(defaultWorkspaceCwd)`). Default true.
   *
   * False is for attach mode (#203), where the default daemon is a terminal's
   * `qwen serve` the gateway only shares. A gateway-owned replacement there
   * would carry the phone's conversations away from the terminal they were
   * shared with, onto a second daemon writing the same workspace. So with this
   * off, losing that daemon is reported instead: the `daemon_died` row names
   * the reason, the recovery saga finds nothing to resume on, and every call
   * for the default workspace fails with {@link DefaultDaemonUnavailableError}
   * until the external daemon answers `/health` again, at which point the
   * pool serves the default workspace from it once more.
   */
  respawnDefaultDaemon?: boolean;
  /**
   * Stops the boot daemon, which the pool otherwise never does (#203). Called
   * once, and only when a transport error marked the boot daemon dead and a
   * replacement now serves the default workspace: a boot daemon that was
   * marked dead wrongly must not keep running beside its replacement. An exit
   * needs no stop. Absent (attach mode, where the daemon is not the
   * gateway's) → the pool never stops it.
   */
  stopDefaultDaemon?: () => Promise<void>;
  defaultWorkspaceCwd: string;
  /** Endpoint of the boot daemon, used for terminal requests against the
   * default workspace (issue #49). Absent → those requests are refused. */
  defaultEndpoint?: DaemonEndpoint;
  /** Spawn a NEW daemon bound to `cwd`; returns once it is reachable. Also
   * used to replace the boot daemon after it dies, with the default cwd. */
  spawn: (cwd: string) => Promise<PooledDaemonSpawn>;
  maxDaemons?: number; // default 3
  idleReapMs?: number; // default 15*60_000
  now?: () => number; // injectable clock (default Date.now)
  /**
   * How long the pool waits on a question it asks a daemon for its own
   * bookkeeping before it stops waiting: the `/health` check after an event
   * stream drops (#153), and the session checks a create makes before it
   * refuses a new workspace at the cap (#154). An unanswered question is
   * never read as an answer: the stream loss stays a stream loss, the session
   * ids stay counted. Default 5000.
   */
  probeTimeoutMs?: number;
  /**
   * How long a call that failed with a transport error waits before the one
   * `/health` probe that decides whether its daemon died (#203). A reset or a
   * dropped socket is also what a live daemon produces when it closes an idle
   * keep-alive socket as a request goes out, or evicts a slow stream. The
   * wait lets a dying process finish dying and lets the client drop sockets
   * the daemon already closed, so the probe does not trip over the same
   * stale socket. A refused connection is not probed: nothing is listening.
   * Default 250.
   */
  deathProbeDelayMs?: number;
  /** Invoked with the affected session ids when a daemon dies
   * (add-mid-turn-recovery). Absent → the sessions are simply dropped
   * (404s, as today); the `daemon_died` audit row is still written. The
   * recovery orchestrator plugs in here. */
  onDaemonDeath?: (
    workspaceKey: string,
    sessions: string[],
    exit: DaemonExitInfo & { atMs: number },
  ) => void;
}

interface Entry {
  client: DaemonClient;
  stop: () => Promise<void>;
  sessions: Set<string>;
  lastUsed: number;
  /** Copied from `PooledDaemonSpawn` (issue #49). */
  endpoint?: DaemonEndpoint;
  /** Set by `markDead`; a second trigger (exit event + transport error
   * racing) is a no-op. */
  dead: boolean;
  /** Captured by `markDead` for the death audit/hook. */
  exit?: DaemonExitInfo & { atMs: number };
  /** Bumped (see `touch`) by everything that uses the entry or registers a
   * session on it. `reconcileEntry` compares it across its round trip: an
   * answer the daemon gave before a use or a registration that landed in
   * the meantime may already be stale, so it is not applied. */
  touches: number;
  /** The in-flight `reconcileEntry` run, so the reaper timer and a create
   * at the cap share one round of questions instead of stacking them. */
  reconciling?: Promise<void>;
  /** The in-flight confirmation of a transport error (see
   * `transportDeathConfirmed`), shared by every call that failed on this
   * daemon meanwhile so they cost one probe (#203). */
  confirming?: Promise<boolean>;
}

const DEFAULT_MAX_DAEMONS = 3;
const DEFAULT_IDLE_REAP_MS = 15 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_DEATH_PROBE_DELAY_MS = 250;

/** Thrown when a session id isn't owned by any known daemon (unrecorded, or
 * its owning daemon was already reaped). Routes map this to a `404
 * session_not_found`. */
export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unknown session: ${sessionId}`);
    this.name = 'UnknownSessionError';
  }
}

/**
 * True when a subscription failure means "this daemon will not stream this
 * session" rather than "try again shortly". Two shapes reach a caller: the
 * pool's own `UnknownSessionError` (it holds no record of the id) and the
 * daemon's HTTP 404, which the SDK surfaces with `status`.
 *
 * Anything that retries blindly on this generates one refused request per
 * backoff, forever, because the daemon keeps LISTING the session it refuses to
 * stream. One owner for the test so the retry sites cannot drift apart.
 */
export function isGoneSessionError(err: unknown): boolean {
  return (
    err instanceof UnknownSessionError ||
    (err as { status?: unknown } | undefined)?.status === 404
  );
}

/** The `reason` a lost attached daemon is reported under (#203). */
export const ATTACHED_DAEMON_UNREACHABLE = 'attached_daemon_unreachable';

/**
 * Thrown for a call that needs the default workspace's daemon while the daemon
 * the gateway attached to is gone and does not answer, when the pool was told
 * not to replace it (`respawnDefaultDaemon: false`, attach mode, #203). Routes
 * map it like any other daemon failure (502 `daemon_unavailable`), and the
 * capability route reports the daemon `available: false`. The recovery saga
 * gets it from its respawn attempt and records `reason` on every session it
 * could not bring back.
 */
export class DefaultDaemonUnavailableError extends Error {
  readonly reason = ATTACHED_DAEMON_UNREACHABLE;
  constructor() {
    super(
      'The attached daemon serving the default workspace is unreachable, ' +
        'and this gateway does not start one of its own in attach mode',
    );
    this.name = 'DefaultDaemonUnavailableError';
  }
}

/** Thrown when `getOrSpawn` needs to spawn a daemon for a new workspace but
 * the pool is at `maxDaemons` and every entry is busy (no idle victim to
 * evict). Routes map this to a `503 workspace_pool_full`. */
export class WorkspacePoolFullError extends Error {
  constructor(readonly maxDaemons: number) {
    super(`Workspace daemon pool is full (max ${maxDaemons})`);
    this.name = 'WorkspacePoolFullError';
  }
}

/** Per-session recovery state after its owning daemon died (add-mid-turn-
 * recovery §2/§3). `'recovering'` — a recovery saga is in flight for this
 * session (the events route holds the connection); `'recovered'` /
 * `'unrecoverable'` — the saga finished and the outcome cache keeps the
 * branch sticky for late reconnects; `'idle'` — no recovery involved (the
 * default when no orchestrator is wired). */
export type RecoveryState =
  | 'recovering'
  | 'recovered'
  | 'unrecoverable'
  | 'idle';

/** Backing for {@link DaemonPool.recoveryState} — implemented by the
 * recovery orchestrator, which owns the lock map + outcome cache (the pool
 * cannot keep the session→state map itself: `markDead` scrubs the affected
 * ids from `ownerOf`). Absent (never wired) → every session reports
 * `'idle'`. */
export interface RecoveryStateProvider {
  recoveryState(sessionId: string): RecoveryState;
  /** The pool reports the session live again (created/resumed), clearing
   * any stale outcome so the events route attaches normally. */
  sessionLive?(sessionId: string): void;
}

/**
 * Pool of `qwen serve` daemons, one per project workspace, plus the
 * always-on default daemon. Spawns/reuses a daemon per workspace cwd,
 * routes session-id-keyed calls to the daemon that owns the session, reaps
 * idle workspace daemons, and enforces a cap on concurrently running
 * workspace daemons (evicting the LRU idle one, or refusing when all are
 * busy).
 *
 * This is a drop-in for the session-routing surface of `DaemonClient` —
 * routes can hold a `DaemonPool` wherever they previously held a single
 * `DaemonClient`.
 */
export class DaemonPool implements SessionDaemon {
  private readonly byWorkspace = new Map<string, Entry>();
  private readonly spawning = new Map<string, Promise<Entry>>();
  /** sessionId -> owning workspace key (`defaultWorkspaceCwd` for sessions
   * created on the default daemon). */
  private readonly ownerOf = new Map<string, string>();
  /**
   * Count of in-flight calls holding each workspace key (see `hold`;
   * never touched for the default workspace): `createOrAttachSession`,
   * `resumeSession`, and every workspace-scoped call (#163). Marked
   * SYNCHRONOUSLY at the very start of the call, before any `await`,
   * including before `getOrSpawn`, whose own first `await` already yields a
   * microtask even when its body resolves synchronously (an existing entry's
   * fast path). An entry can look idle (`sessions.size === 0`) for the
   * entire duration of a call's network round-trip; without marking the key
   * up front, a concurrent `getOrSpawn`'s cap eviction could reclaim the
   * entry mid-request, stopping the daemon while this call still returns
   * what looks like a successful answer whose backend is already dead (or,
   * for a batch delete, a torn one).
   */
  private readonly pendingUses = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxDaemons: number;
  private readonly idleReapMs: number;
  private readonly probeTimeoutMs: number;
  private readonly reapTimer: ReturnType<typeof setInterval>;
  /** The normalized (see `normalizeCwd`) default workspace cwd — computed
   * once so every `isDefault`/key comparison compares like-for-like. */
  private readonly defaultWorkspaceCwd: string;
  /** Set at the top of `stopAll`; a spawn that resolves after shutdown must
   * not register itself into the (already-cleared) pool. */
  private stopped = false;
  /** Audit sink for `daemon_died` rows (add-mid-turn-recovery), injected
   * post-construction by cli.ts once the gateway app has built it. */
  private audit: AuditRecorder | undefined;
  /** Recovery-state backing (add-mid-turn-recovery), injected post-
   * construction — the orchestrator depends on this pool, so it cannot be
   * passed in the options. Absent → `recoveryState` reports `'idle'`. */
  private recoveryProvider: RecoveryStateProvider | undefined;
  /**
   * The daemon serving the default workspace (#163). It starts as the boot
   * daemon the pool was handed, whose lifecycle belongs to whoever
   * constructed the pool, so the pool never stops it. Once that daemon dies,
   * the next call for the default workspace spawns a replacement through
   * `opts.spawn`, the same way a pooled workspace respawns after a death, and
   * that replacement the pool owns and stops.
   *
   * Never in `byWorkspace`: the default takes no cap slot, is never reaped
   * or evicted, and is not listed by `workspaces()`. Every daemon that serves
   * it gets its own record, so `dead` is the idempotency guard for THAT
   * daemon's death and a replacement starts clean. A single pool-wide flag
   * used to latch on the first death and swallow every later one.
   *
   * With `respawnDefaultDaemon` off (attach mode, #203) nothing replaces the
   * boot daemon: it is re-attached under a fresh record once it answers
   * again (see `reattachDefaultEntry`).
   */
  private defaultEntry: Entry;
  /** The boot daemon's own record, kept so its exit (`handleDaemonExit`)
   * can only ever mark the boot daemon dead, never a replacement. Replaced
   * by a fresh record when the boot daemon is re-attached (#203), because
   * that record serves the same process. */
  private bootEntry: Entry;
  /** The in-flight respawn (or, in attach mode, re-attach) of the default
   * workspace's daemon, shared by every caller that finds the current one
   * dead. */
  private defaultSpawning: Promise<Entry> | undefined;
  /** `opts.respawnDefaultDaemon`, defaulted (#203). */
  private readonly respawnDefault: boolean;
  private readonly deathProbeDelayMs: number;
  /**
   * Daemons a transport error took, by key, still to be stopped once a
   * replacement serves that key (#203; see `stopSuperseded`). The error was
   * confirmed by a probe, but a daemon that was wrongly marked dead would
   * otherwise keep running beside its successor, and a pooled one would
   * outlive the gateway: it is out of `byWorkspace`, so `stopAll` never saw
   * it. A daemon whose exit was seen is not listed: there is nothing left to
   * stop.
   */
  private readonly superseded = new Map<string, Entry>();

  /** Wire the audit recorder in (add-mid-turn-recovery: `daemon_died`
   * rows). Called by cli.ts after the gateway app is constructed. */
  setAudit(recorder: AuditRecorder): void {
    this.audit = recorder;
  }

  /** Wire the recovery-state backing (add-mid-turn-recovery). Called by the
   * host after the orchestrator exists (it depends on this pool). Absent →
   * `recoveryState` reports `'idle'` for every session. */
  setRecoveryProvider(provider: RecoveryStateProvider | undefined): void {
    this.recoveryProvider = provider;
  }

  /** Wire the recovery orchestrator's death hook (add-mid-turn-recovery).
   * Called by cli.ts after the orchestrator exists (it depends on this
   * pool). Absent → dead sessions are simply dropped (404s, as today);
   * the `daemon_died` audit row is still written. */
  setOnDaemonDeath(hook: DaemonPoolOptions['onDaemonDeath']): void {
    this.opts.onDaemonDeath = hook;
  }

  constructor(private readonly opts: DaemonPoolOptions) {
    this.now = opts.now ?? Date.now;
    this.maxDaemons = opts.maxDaemons ?? DEFAULT_MAX_DAEMONS;
    this.idleReapMs = opts.idleReapMs ?? DEFAULT_IDLE_REAP_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.respawnDefault = opts.respawnDefaultDaemon ?? true;
    this.deathProbeDelayMs =
      opts.deathProbeDelayMs ?? DEFAULT_DEATH_PROBE_DELAY_MS;
    this.defaultWorkspaceCwd = this.normalizeCwd(opts.defaultWorkspaceCwd);
    this.bootEntry = this.newEntry({
      client: opts.defaultDaemon,
      // Not the pool's to stop (see `defaultEntry`), except a boot daemon a
      // transport error took once its replacement is up (#203).
      stop: opts.stopDefaultDaemon ?? (async () => {}),
      endpoint: opts.defaultEndpoint,
    });
    this.defaultEntry = this.bootEntry;
    this.reapTimer = setInterval(() => {
      // The timer does not wait on the daemon's answers; the next tick, or a
      // create at the cap, picks up whatever this round settled.
      this.reapIdle().catch(() => {});
    }, this.idleReapMs / 3);
    this.reapTimer.unref?.();
  }

  /** Canonicalize a workspace cwd into the pool's KEY form: `path.resolve`
   * collapses `.`, `//`, and trailing slashes while keeping it absolute, so
   * `/proj/a` and `/proj/a/` (or `/home/evan` and `/home/evan/`) always map
   * to the exact same `byWorkspace` entry / `isDefault` comparand instead of
   * spawning a duplicate daemon (or a stray non-default daemon bound to what
   * is actually the boot workspace). */
  private normalizeCwd(cwd: string): string {
    return resolve(cwd);
  }

  private isDefault(cwd?: string) {
    return !cwd || this.normalizeCwd(cwd) === this.defaultWorkspaceCwd;
  }

  /** Mark `entry` used now. Every `lastUsed` bump goes through here so the
   * `touches` counter `reconcileEntry` relies on cannot miss one. */
  private touch(entry: Entry): void {
    entry.lastUsed = this.now();
    entry.touches++;
  }

  /** The pool's key for `cwd`: the default workspace's own key when `cwd` is
   * omitted, empty, or names the default workspace. */
  private keyFor(cwd?: string): string {
    return this.isDefault(cwd)
      ? this.defaultWorkspaceCwd
      : this.normalizeCwd(cwd!);
  }

  private newEntry(s: {
    client: DaemonClient;
    stop: () => Promise<void>;
    endpoint?: DaemonEndpoint;
  }): Entry {
    return {
      client: s.client,
      stop: s.stop,
      sessions: new Set(),
      lastUsed: this.now(),
      endpoint: s.endpoint,
      dead: false,
      touches: 0,
    };
  }

  /** The live entry or the in-flight spawn for `key`, if either. */
  private lookup(key: string): Entry | Promise<Entry> | undefined {
    const existing = this.byWorkspace.get(key);
    if (existing) {
      this.touch(existing);
      return existing;
    }
    return this.spawning.get(key);
  }

  /** Reachable daemon for `cwd` (spawn if new). Empty/undefined → the
   * default workspace's daemon, respawned first if the one serving it died. */
  async getOrSpawn(cwd?: string): Promise<DaemonClient> {
    return (await this.resolveEntry(cwd)).client;
  }

  /** The default workspace's daemon, or the respawn that replaces it when
   * the current one is dead (#163). Concurrent callers share one respawn.
   * In attach mode (#203) the "respawn" is a re-attach to the same external
   * daemon, which fails while that daemon does not answer. */
  private liveDefaultEntry(): Entry | Promise<Entry> {
    if (!this.defaultEntry.dead) return this.defaultEntry;
    if (this.defaultSpawning) return this.defaultSpawning;
    const p = this.respawnDefault
      ? this.respawnDefaultEntry()
      : this.reattachDefaultEntry();
    this.defaultSpawning = p;
    // Cleared as a reaction rather than in a `finally` inside the closure, so
    // it can never run before the assignment above, and a failed respawn is
    // retried by the next caller instead of poisoning the default.
    const clear = () => {
      if (this.defaultSpawning === p) this.defaultSpawning = undefined;
    };
    p.then(clear, clear);
    return p;
  }

  /** Spawn a gateway-owned replacement for the dead default daemon (#163). */
  private async respawnDefaultEntry(): Promise<Entry> {
    const key = this.defaultWorkspaceCwd;
    const s = await this.opts.spawn(key);
    const entry = this.newEntry(s);
    if (this.stopped) {
      // Same reason as the pooled spawn below: nothing would stop it later.
      await s.stop().catch(() => {});
      return entry;
    }
    // Identity-guarded like a pooled entry: a late exit of this daemon
    // after it, too, was replaced cannot kill its successor.
    s.onExit = (info) => this.markDead(key, info, entry);
    this.defaultEntry = entry;
    this.stopSuperseded(key);
    return entry;
  }

  /**
   * Attach mode (#203): serve the default workspace from the external daemon
   * again, never from one of the pool's own. One `/health` question, bounded
   * by `probeTimeoutMs`: an answer re-attaches it under a fresh record (so a
   * later loss is reported like the first), and anything else is
   * {@link DefaultDaemonUnavailableError}. A daemon that comes back on the
   * same URL and token is therefore picked up by the next call, and a death
   * that turns out to have been a false alarm resumes its sessions in place
   * when the recovery saga asks.
   */
  private async reattachDefaultEntry(): Promise<Entry> {
    const client = this.opts.defaultDaemon;
    const answers = await settleWithin(
      (async () => {
        await client.health();
        return true;
      })(),
      this.probeTimeoutMs,
      false,
    );
    if (!answers) throw new DefaultDaemonUnavailableError();
    const entry = this.newEntry({
      client,
      stop: this.bootEntry.stop,
      endpoint: this.opts.defaultEndpoint,
    });
    if (this.stopped) return entry;
    this.bootEntry = entry;
    this.defaultEntry = entry;
    // The daemon that answered IS the one marked dead, so this is no
    // replacement and there is nothing to stop.
    this.superseded.delete(this.defaultWorkspaceCwd);
    return entry;
  }

  /** `getOrSpawn`, answering with the entry itself so a caller can mark
   * exactly the daemon it talked to dead (see `callOn`). */
  private async resolveEntry(cwd?: string): Promise<Entry> {
    if (this.isDefault(cwd)) return this.liveDefaultEntry();
    const key = this.normalizeCwd(cwd!);
    const known = this.lookup(key);
    if (known) return known;

    // Count LIVE entries and IN-FLIGHT spawns together: a new entry only
    // lands in `byWorkspace` once `spawn()` resolves, so counting
    // `byWorkspace.size` alone lets N concurrent creates for N distinct new
    // cwds all pass the check and all spawn, blowing past `maxDaemons`. At
    // this point `key` is guaranteed absent from both maps (the `lookup`
    // above already returned), so this count never needs to exclude it.
    const pooledCount = () => this.byWorkspace.size + this.spawning.size;
    if (pooledCount() >= this.maxDaemons) {
      const checking = this.reapAndReconcile();
      if (
        checking !== undefined &&
        pooledCount() >= this.maxDaemons &&
        !this.hasIdleEntry()
      ) {
        // Every entry still counts a session, and some of those may be ids
        // the daemon's own reaper closed without anyone hearing (#154). Ask
        // before refusing, but only for as long as `probeTimeoutMs`: a daemon
        // that does not answer keeps its ids and the refusal stands.
        await settleWithin(checking, this.probeTimeoutMs, undefined);
        // The await let other callers run: one may have spawned this very
        // key, or filled the slot a reconcile freed. Check both again.
        const raced = this.lookup(key);
        if (raced) return raced;
      }
      if (pooledCount() >= this.maxDaemons) {
        this.evictLruIdle();
      }
    }

    const p = (async () => {
      try {
        // Through `promiseFrom` (#203): a spawner that throws before it
        // returns a promise would otherwise run the `finally` below right
        // now, before `spawning.set` further down stores `p`, and the
        // rejected `p` stored after it would answer every later call for
        // this cwd. Awaiting a rejection always yields first.
        const s = await promiseFrom(() => this.opts.spawn(key));
        const entry = this.newEntry(s);
        if (this.stopped) {
          // `stopAll()` ran while this spawn was in flight — the pool's
          // maps are already cleared and the gateway is shutting down.
          // Registering this entry now would leak a daemon (children are
          // spawned `detached`) that nothing will ever stop again.
          await s.stop().catch(() => {});
          return entry;
        }
        // Identity-guarded exit wiring (see `markDead`'s `expectedEntry`):
        // the callback captures THIS entry so a stale exit of a superseded
        // entry (same key re-spawned after a death) can't kill the new one.
        // Setting it synchronously before `byWorkspace.set` is race-free —
        // the spawner's `whenExited` settles on a later 'exit' event, never
        // in this microtask.
        s.onExit = (info) => this.markDead(key, info, entry);
        this.byWorkspace.set(key, entry);
        this.stopSuperseded(key);
        return entry;
      } finally {
        // Runs on both success AND rejection — a failed spawn must not
        // leave a stuck entry in `spawning` that poisons this cwd forever;
        // the next getOrSpawn(cwd) needs to be able to retry.
        this.spawning.delete(key);
      }
    })();
    this.spawning.set(key, p);
    return p;
  }

  /** An entry is idle only when it has no live sessions AND no in-flight
   * call holding `key` (see `hold`): both `reapIdle` and `evictLruIdle` must
   * agree on this so an entry is never reclaimed out from under a caller
   * that is still talking to it. */
  private isIdle(key: string, entry: Entry): boolean {
    return entry.sessions.size === 0 && !this.pendingUses.has(key);
  }

  /**
   * Hold `key` against cap eviction and idle reaping until the returned
   * release runs (see `pendingUses`). Call it synchronously, before the
   * first `await` of the call it protects, and release in a `finally`. The
   * release is idempotent. A no-op for the default workspace, which is never
   * reaped or evicted.
   */
  private hold(key: string): () => void {
    if (key === this.defaultWorkspaceCwd) return () => {};
    this.pendingUses.set(key, (this.pendingUses.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.pendingUses.get(key) ?? 1) - 1;
      if (n <= 0) this.pendingUses.delete(key);
      else this.pendingUses.set(key, n);
    };
  }

  /** Stop the daemon a transport error took `key` from, now that a
   * replacement serves `key` (#203; see `superseded`). Not awaited: the
   * replacement is already serving, and a stop that escalates to SIGKILL
   * takes seconds. Its exit, when it lands, is a stale trigger the identity
   * guard in `markDead` ignores. */
  private stopSuperseded(key: string): void {
    const old = this.superseded.get(key);
    if (old === undefined) return;
    this.superseded.delete(key);
    old.stop().catch(() => {});
  }

  /** Stop the daemon, drop its entry, and scrub any of its session ids out
   * of `ownerOf` (defensive — under the current invariants an idle entry's
   * `sessions` set is already empty, but this keeps `ownerOf` from ever
   * accumulating a stale mapping if that invariant is ever violated). */
  private discardEntry(key: string, entry: Entry): void {
    for (const id of entry.sessions) {
      this.ownerOf.delete(id);
    }
    entry.stop().catch(() => {});
    this.byWorkspace.delete(key);
  }

  /** Evict the least-recently-used IDLE workspace entry to make room under
   * the cap. Throws `WorkspacePoolFullError` if every entry currently has
   * live sessions or an in-flight registration. */
  private evictLruIdle(): void {
    let lruKey: string | undefined;
    let lruEntry: Entry | undefined;
    for (const [key, entry] of this.byWorkspace) {
      if (this.isIdle(key, entry)) {
        if (!lruEntry || entry.lastUsed < lruEntry.lastUsed) {
          lruKey = key;
          lruEntry = entry;
        }
      }
    }
    if (!lruKey || !lruEntry) {
      throw new WorkspacePoolFullError(this.maxDaemons);
    }
    this.discardEntry(lruKey, lruEntry);
  }

  private hasIdleEntry(): boolean {
    for (const [key, entry] of this.byWorkspace) {
      if (this.isIdle(key, entry)) return true;
    }
    return false;
  }

  /**
   * Reap every non-default entry that is idle (see `isIdle`) and has been
   * idle longer than `idleReapMs`; that part is synchronous, so a caller that
   * ignores the returned promise sees it done. An entry past the same cutoff
   * that still counts sessions is then checked against its daemon (see
   * `reconcileEntry`), and the returned promise settles once those answers
   * have been applied. It never rejects. Safe to call directly (tests inject
   * a clock via `now`); also driven from a background timer.
   */
  reapIdle(): Promise<void> {
    return this.reapAndReconcile() ?? Promise.resolve();
  }

  /** `reapIdle`'s body. Returns undefined when nothing needed asking, so the
   * cap path in `getOrSpawn` only yields when there is something to wait
   * for. */
  private reapAndReconcile(): Promise<void> | undefined {
    const cutoff = this.now();
    const checks: Array<Promise<void>> = [];
    for (const [key, entry] of this.byWorkspace) {
      if (cutoff - entry.lastUsed <= this.idleReapMs) continue;
      if (this.isIdle(key, entry)) {
        this.discardEntry(key, entry);
      } else if (entry.sessions.size > 0 && !this.pendingUses.has(key)) {
        checks.push(this.reconcileEntry(key, entry));
      }
    }
    return checks.length > 0
      ? Promise.all(checks).then(
          () => undefined,
          () => undefined,
        )
      : undefined;
  }

  /**
   * Ask the daemon behind `entry` about every session id the pool still
   * counts for it, and forget the ones it says it does not hold (#154).
   *
   * The pool otherwise learns a session ended only from its own
   * `closeSession` or a relayed `session_closed`/`session_died` frame. The
   * daemon's reaper closes any session with no SSE subscriber after its idle
   * TTL (acp-bridge session-control-plane.ts, `startSessionReaper`), and with
   * no subscriber there is nobody to relay the frame, so without this the
   * entry counts those ids forever: it is never idle, never reaped, and once
   * `maxDaemons` entries are in that state every new workspace is refused.
   *
   * The question is `GET /session/:id/status` per id, because its 404
   * `session_not_found` comes from the same in-memory map the reaper deletes
   * from, and it answers for an untrusted workspace too. The workspace
   * live-state list was the other candidate and is not used: it refuses an
   * untrusted workspace outright and leaves agent-host sessions out, so an id
   * missing from it is not proof the daemon dropped it. Reading the status
   * does not bump the daemon's idle clock (only prompts, turns and explicit
   * heartbeats do), so asking cannot keep a reaped-to-be session alive.
   *
   * Only that 404 drops an id. Any other outcome (200, another status, a
   * transport error, no answer) keeps it: a daemon that cannot say is not
   * saying the session is gone. The answers are thrown away when anything
   * touched the entry while they were out (see `Entry.touches`), when a
   * create or resume is registering on it, or when the entry was replaced.
   */
  private reconcileEntry(key: string, entry: Entry): Promise<void> {
    if (entry.reconciling) return entry.reconciling;
    const run = (async () => {
      try {
        const asked = entry.touches;
        const ids = [...entry.sessions];
        const dropped = await Promise.all(
          ids.map((id) => this.daemonDropped(entry.client, id)),
        );
        if (
          this.stopped ||
          entry.dead ||
          this.byWorkspace.get(key) !== entry ||
          entry.touches !== asked ||
          this.pendingUses.has(key)
        ) {
          return;
        }
        ids.forEach((id, i) => {
          if (dropped[i]) this.forgetSession(key, entry, id);
        });
        if (
          this.isIdle(key, entry) &&
          this.now() - entry.lastUsed > this.idleReapMs
        ) {
          this.discardEntry(key, entry);
        }
      } finally {
        entry.reconciling = undefined;
      }
    })();
    entry.reconciling = run;
    return run;
  }

  /** True only when the daemon answered that it does not hold `sessionId`. */
  private async daemonDropped(
    client: DaemonClient,
    sessionId: string,
  ): Promise<boolean> {
    try {
      await client.sessionStatus(sessionId);
      return false;
    } catch (err) {
      return isSessionLevelGone(err);
    }
  }

  /** Forget an id the daemon says it no longer holds. Unlike
   * `removeSession` this leaves `lastUsed` alone: the daemon closed the
   * session at some earlier moment nobody observed, and the entry has
   * already gone unused for longer than `idleReapMs`. */
  private forgetSession(key: string, entry: Entry, id: string): void {
    entry.sessions.delete(id);
    if (this.ownerOf.get(id) === key) this.ownerOf.delete(id);
  }

  // -- Death detection (add-mid-turn-recovery) -------------------------

  /**
   * Report the exit of the boot (default) daemon by workspace cwd. The pool
   * did not spawn the boot daemon, so its death arrives here rather than
   * through a pooled entry's `onExit`. Normalizes `workspaceCwd` so the
   * caller can pass the raw configured value.
   *
   * For the default workspace this marks the BOOT daemon dead and nothing
   * else: when a transport error already reported that death and a
   * replacement now serves the workspace, the boot child's own exit arriving
   * afterwards must not kill the replacement (#163). A replacement reports
   * its own exit through the `onExit` the pool wired at its spawn.
   */
  handleDaemonExit(workspaceCwd: string, info: DaemonExitInfo): void {
    const key = this.normalizeCwd(workspaceCwd);
    this.markDead(
      key,
      info,
      key === this.defaultWorkspaceCwd ? this.bootEntry : undefined,
    );
  }

  /**
   * Mark the daemon for `key` dead — idempotent (a second trigger, e.g. the
   * exit event and a transport error racing, is a no-op):
   *
   * - removes the pooled entry IMMEDIATELY (frees the `maxDaemons` slot
   *   for the recovery respawn; the zombie can no longer wedge the cap),
   * - collects the affected session ids — `entry.sessions` ∪ the
   *   `ownerOf` entries mapping to `key` (the union guards against an id
   *   recorded in one structure but not the other),
   * - scrubs them from `ownerOf` (they 404 until recovery re-registers
   *   them via `resumeSession`),
   * - writes ONE `daemon_died` audit row — detail
   *   `{ exitCode, signal, sessionCount }`, no workspace path (the
   *   session-create/resume audit rule), plus `reason` when the dead daemon
   *   is an attached one nothing will replace (#203),
   * - hands the affected list to `opts.onDaemonDeath` (the recovery
   *   orchestrator; absent → the sessions are simply dropped, 404s as
   *   today — the audit row is still written).
   *
   * `expectedEntry` (set by the pool's own exit wiring at spawn, by
   * `handleDaemonExit` for the boot daemon, and by `callOn` for the daemon a
   * call actually reached) guards against a STALE trigger: if the same key
   * was re-spawned after a death, the old daemon's exit event or a late
   * transport error from a call made to it must not kill the new one.
   *
   * The default workspace's daemon is marked dead in place rather than
   * removed (it never sits in `byWorkspace`); the next call for that
   * workspace respawns it (see `liveDefaultEntry`). The idempotency guard is
   * the per-daemon `dead` flag, so the replacement's own death is reported
   * like the first one was (#163).
   *
   * `trigger` is how the death was learned. A process whose exit was seen is
   * gone; one a transport error took may still be running, so it is kept in
   * `superseded` and stopped once its replacement is up (#203).
   */
  private markDead(
    key: string,
    info: DaemonExitInfo,
    expectedEntry?: Entry,
    trigger: 'exit' | 'transport' = 'exit',
  ): void {
    if (this.stopped) return; // shutdown: no audit, no hook
    const isDefaultKey = key === this.defaultWorkspaceCwd;
    const entry = isDefaultKey ? this.defaultEntry : this.byWorkspace.get(key);
    // A NON-default key with no entry is a late exit of an entry already
    // reaped/evicted/stopped: no audit, no hook.
    if (entry === undefined || entry.dead) return;
    if (expectedEntry !== undefined && entry !== expectedEntry) return;
    entry.dead = true;
    const exit = { code: info.code, signal: info.signal, atMs: this.now() };
    entry.exit = exit;
    if (!isDefaultKey) this.byWorkspace.delete(key);
    if (trigger === 'transport') this.superseded.set(key, entry);
    const affected = new Set<string>(entry.sessions);
    for (const [sid, k] of this.ownerOf) {
      if (k === key) affected.add(sid);
    }
    for (const sid of affected) this.ownerOf.delete(sid);
    this.audit
      ?.record({
        action: 'daemon_died',
        detail: {
          exitCode: exit.code,
          signal: exit.signal,
          sessionCount: affected.size,
          // Attach mode (#203): nothing will replace this daemon, so the row
          // says why its sessions are not coming back.
          ...(isDefaultKey && !this.respawnDefault
            ? { reason: ATTACHED_DAEMON_UNREACHABLE }
            : {}),
        },
      })
      .catch(() => {});
    this.opts.onDaemonDeath?.(key, [...affected], exit);
  }

  /** Transport trigger: if `err` is a transport-level error and the daemon
   * behind `entry` is confirmed dead (see `transportDeathConfirmed`), mark it
   * dead (covers races where the exit handler has not fired yet). Transport
   * errors carry no exit info; if the exit trigger fires later it is a no-op
   * on this same death. Only `entry` itself can be marked: a replacement that
   * took `key` while the call was out is left alone. Never rejects. */
  private async noteTransportDeath(
    key: string,
    entry: Entry,
    err: unknown,
  ): Promise<void> {
    if (await this.transportDeathConfirmed(entry, err)) {
      this.markDead(key, { code: null, signal: null }, entry, 'transport');
    }
  }

  /**
   * Whether `err`, from a call to `entry`'s daemon, means that daemon is dead
   * (#203). Not a transport error: no. A refused connection: yes, at once,
   * because nothing is listening. Any other transport error (a reset, a
   * dropped socket, the SDK's closed stream) is what a live daemon also
   * produces, from the keep-alive race on an idle socket or a stream
   * eviction, so it is decided by one `/health` probe after
   * `deathProbeDelayMs` (see `probeConfirmsDeath`). Calls that fail on the
   * same daemon while that probe is out share it.
   */
  private transportDeathConfirmed(
    entry: Entry,
    err: unknown,
  ): Promise<boolean> {
    const code = transportDeathCode(err);
    if (code === undefined || entry.dead) return Promise.resolve(false);
    if (code === 'ECONNREFUSED') return Promise.resolve(true);
    if (entry.confirming) return entry.confirming;
    const run = (async () => {
      if (this.deathProbeDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.deathProbeDelayMs),
        );
      }
      return this.probeConfirmsDeath(entry.client);
    })();
    entry.confirming = run;
    const clear = () => {
      if (entry.confirming === run) entry.confirming = undefined;
    };
    run.then(clear, clear);
    return run;
  }

  /** Run `call` against `entry`'s daemon, marking that daemon dead on a
   * confirmed transport-level error (then rethrow; routes keep their 502
   * mapping). The rethrow waits for the confirmation, so a caller that
   * retries finds the pool already knowing whether to respawn. */
  private async callOn<T>(
    key: string,
    entry: Entry,
    call: (client: DaemonClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(entry.client);
    } catch (err) {
      await this.noteTransportDeath(key, entry, err);
      throw err;
    }
  }

  /** Run a session-keyed pool call against the session's owning daemon (see
   * `callOn`). The owner resolves BEFORE the call so an
   * `UnknownSessionError` (the 404 mapping) never touches the death
   * trigger. */
  private async withSessionDeathTrigger<T>(
    sessionId: string,
    call: (client: DaemonClient) => Promise<T>,
  ): Promise<T> {
    const { key, entry } = this.ownerEntry(sessionId);
    return this.callOn(key, entry, call);
  }

  /** Run a call against the default workspace's daemon, respawning it first
   * if the one serving it died (#163). */
  private withDefaultDeathTrigger<T>(
    call: (client: DaemonClient) => Promise<T>,
  ): Promise<T> {
    return this.withWorkspaceDeathTrigger(undefined, call);
  }

  /** Run a workspace-scoped pool call (rc-workspace-scoping, #28) against
   * the target workspace's daemon: the default workspace's daemon when
   * `workspaceCwd` is omitted/empty/normalizes to the default workspace,
   * otherwise the pooled daemon for that cwd (spawned on demand via
   * `getOrSpawn`, exactly like session creation — a controllable workspace
   * does not need a live session). Marks that daemon dead on a
   * transport-level error (then rethrow; routes keep their 502 mapping). A
   * `WorkspacePoolFullError` or a failed spawn from `getOrSpawn` is not a
   * transport death: it propagates untouched for the route's mapping.
   *
   * Holds the workspace for the whole call, like a create does (#163): a
   * workspace reached only through these calls has no sessions, so it looks
   * idle throughout and a create for another workspace at the cap could
   * otherwise evict and stop it mid-request. */
  private async withWorkspaceDeathTrigger<T>(
    workspaceCwd: string | undefined,
    call: (client: DaemonClient) => Promise<T>,
  ): Promise<T> {
    const key = this.keyFor(workspaceCwd);
    const release = this.hold(key);
    try {
      const entry = await this.resolveEntry(workspaceCwd);
      return await this.callOn(key, entry, call);
    } finally {
      release();
    }
  }

  // -- Session routing ------------------------------------------------

  /** The session's recovery state (add-mid-turn-recovery §3): delegated to
   * the wired orchestrator, `'idle'` when none is wired. */
  recoveryState(sessionId: string): RecoveryState {
    return this.recoveryProvider?.recoveryState(sessionId) ?? 'idle';
  }

  /** Resolve the owning daemon for a session id. Bumps a pooled entry's
   * `lastUsed` (a live-referenced session never looks idle). Throws
   * `UnknownSessionError` for an unrecorded id, or one whose owning
   * daemon has since been reaped or has died. */
  private ownerEntry(id: string): { key: string; entry: Entry } {
    const key = this.ownerOf.get(id);
    if (key === undefined) throw new UnknownSessionError(id);
    if (key === this.defaultWorkspaceCwd) {
      // A death scrubs the dead daemon's ids, so this is normally live; the
      // check covers a registration that raced the death.
      if (this.defaultEntry.dead) throw new UnknownSessionError(id);
      return { key, entry: this.defaultEntry };
    }
    const e = this.byWorkspace.get(key);
    if (!e) throw new UnknownSessionError(id); // daemon was reaped
    this.touch(e);
    return { key, entry: e };
  }

  /**
   * Endpoint + token of the daemon owning `sessionId` (issue #49), so a host
   * terminal can attach to the SAME session and mirror it both ways. Returns
   * undefined when the owning daemon was registered without endpoint material
   * (a stub spawner in tests, or a boot daemon the gateway cannot authenticate
   * to) — callers refuse the request rather than hand a terminal a URL it
   * cannot use. Throws `UnknownSessionError` like `ownerEntry`. A session on
   * a respawned default daemon gets that daemon's endpoint, not the dead boot
   * daemon's.
   */
  daemonEndpointForSession(sessionId: string): DaemonEndpoint | undefined {
    const { key, entry } = this.ownerEntry(sessionId);
    // The pool's key is the canonicalized cwd, so it wins over whatever the
    // spawner recorded — a terminal must `cd` to the same path the daemon binds.
    return entry.endpoint
      ? { ...entry.endpoint, workspaceCwd: key }
      : undefined;
  }

  private removeSession(id: string): void {
    const key = this.ownerOf.get(id);
    if (key === undefined) return;
    this.ownerOf.delete(id);
    if (key === this.defaultWorkspaceCwd) return; // never reaped
    const entry = this.byWorkspace.get(key);
    if (!entry) return;
    entry.sessions.delete(id);
    if (entry.sessions.size === 0) {
      this.touch(entry);
    }
  }

  /** Record that the daemon for `key` owns session `id`. Touches the entry,
   * so a `reconcileEntry` round that asked about `id` before this
   * registration landed cannot drop it on a stale answer. */
  private trackSession(key: string, id: string): void {
    this.ownerOf.set(id, key);
    const entry = this.byWorkspace.get(key);
    if (entry) {
      entry.sessions.add(id);
      this.touch(entry);
    }
  }

  /** Resolve (spawn if needed) the daemon for `req.workspaceCwd`, create or
   * attach the session there, and record which daemon owns the returned
   * session id so later session-keyed calls route correctly.
   *
   * `key` is held (see `hold`) SYNCHRONOUSLY, before the
   * `getOrSpawn` await — not after it resolves. Even when `getOrSpawn`
   * resolves an already-spawned entry (no internal await needed), `await
   * this.getOrSpawn(...)` still defers the rest of this function to a
   * later microtask; marking pending only after that await would leave a
   * window where a concurrent `getOrSpawn`'s cap eviction can see this
   * entry as idle (`sessions.size === 0`) and reclaim it mid-registration
   * — stopping the daemon while this call still returns what looks like a
   * successful `DaemonSession`. */
  async createOrAttachSession(
    req: CreateSessionRequest,
    clientId?: string,
  ): Promise<DaemonSession> {
    const key = this.keyFor(req.workspaceCwd);
    const release = this.hold(key);
    try {
      const entry = await this.resolveEntry(req.workspaceCwd);
      const session = await this.callOn(key, entry, (client) =>
        client.createOrAttachSession(req, clientId),
      );
      this.trackSession(key, session.sessionId);
      // The session is live again (add-mid-turn-recovery): clear any stale
      // recovery outcome so the events route attaches normally.
      this.recoveryProvider?.sessionLive?.(session.sessionId);
      return session;
    } finally {
      release();
    }
  }

  /** Resolve (spawn if needed) the daemon for `req.workspaceCwd`, restore the
   * session there, and record which daemon owns `sessionId` so later
   * session-keyed calls route correctly. Unlike `createOrAttachSession`, the
   * daemon does not mint a new id on restore -- it reuses `sessionId` as
   * passed in, so that's what gets recorded in `ownerOf`, not anything read
   * off the response.
   *
   * Restores via the SDK's `loadSession`, not `resumeSession`: ACP's
   * `session/resume` reactivates a session WITHOUT replaying its transcript,
   * so a cold-restored session has no history anywhere except the daemon's
   * `load` action's response (no-history bug, #37). Since upstream
   * `e23c8e845` that action returns the transcript in-band
   * (`compactedReplay` + `liveJournal`, `lastEventId` watermark) and CLEARS
   * the event bus ring after seeding it -- a cursor-0 SSE watch replays
   * nothing. Callers therefore render the in-band frames and start their
   * watch at `lastEventId` (the resume route forwards all of it; #39).
   * Warm/live sessions are unaffected -- both actions merely attach.
   *
   * Workspace-keyed (like `createOrAttachSession`): a resumed session's
   * owning workspace was never in memory here (this pool didn't create it),
   * so the caller must supply it. Mirrors `createOrAttachSession`'s
   * hold exactly -- marked SYNCHRONOUSLY, before the
   * `getOrSpawn` await -- for the same reason: without it, a concurrent
   * `getOrSpawn`'s cap eviction could reclaim this entry mid-registration. */
  async resumeSession(
    sessionId: string,
    req: { workspaceCwd: string },
  ): Promise<DaemonRestoredSession> {
    const key = this.keyFor(req.workspaceCwd);
    const release = this.hold(key);
    try {
      const entry = await this.resolveEntry(req.workspaceCwd);
      // `load`, not `resume`: see the doc above -- the history travels in the
      // load response (in-band frames + lastEventId), not the bus ring.
      const restored = await this.callOn(key, entry, (client) =>
        client.loadSession(sessionId, { workspaceCwd: key }),
      );
      this.trackSession(key, sessionId);
      // The session is live again (add-mid-turn-recovery): clear any stale
      // recovery outcome so the events route attaches normally.
      this.recoveryProvider?.sessionLive?.(sessionId);
      return restored;
    } finally {
      release();
    }
  }

  /**
   * `session_died` and `session_closed` are the SDK's own definition of a
   * session-lifecycle terminal — see `isSessionLifecycleTerminal` in
   * `@qwen-code/sdk`'s `daemon/events.ts` (`type === 'session_died' ||
   * type === 'session_closed'`) — so both reliably mean the daemon session
   * itself ended; pruning on them lets the entry become reapable.
   *
   * `client_evicted` is deliberately NOT included here, despite also being
   * a stream-terminal frame. `daemon/events.ts`'s own doc on
   * `DaemonSessionViewState.alive` says plainly: "For client_evicted and
   * stream_error this only describes the current stream, not the remote
   * daemon session's lifetime." Pruning on it would be actively wrong: a
   * slow SSE consumer can get evicted from ITS OWN stream while the
   * session is still alive on the daemon (and possibly still attached to
   * OTHER clients); treating that as session-terminal would drop the id
   * from tracking and let `reapIdle`/`evictLruIdle` reclaim (and `stop()`)
   * a daemon that is still serving a live session out from under those
   * other clients — worse than the wedge this pruning exists to prevent.
   *
   * A dropped stream is not, by itself, a dead daemon (#153). The daemon
   * evicts a slow subscriber by writing `client_evicted` and destroying the
   * socket (cli/src/serve/routes/sse-events.ts), and undici reports that
   * teardown as `TypeError: terminated` with an `UND_ERR_SOCKET` cause, the
   * same shape a crashed daemon produces. Reading it as a death drops the
   * entry without stopping it and lets recovery `loadSession` the same
   * sessions into a SECOND daemon on the same workspace while the first still
   * holds them. So a transport-shaped stream failure marks the daemon dead
   * only when nothing says it is alive: no `client_evicted` frame arrived
   * first, and a `/health` probe fails at the transport level too (see
   * `transportDeathConfirmed`, which every call shares since #203; a
   * refused connection needs no probe). Either way the error is rethrown
   * unchanged, which is what makes each consumer re-subscribe from its own
   * cursor with its own backoff (the events relay, the push pump, the review
   * bridge; the bridge stops on a clean end, so a loss must not be turned
   * into one).
   *
   * A `client_evicted` frame that arrives is relayed like any other. Today
   * the daemon's own write-then-destroy loses it before it reaches the socket
   * (Node corks the write until the next tick and the destroy lands first),
   * so the `/health` probe is what decides in practice.
   */
  async *subscribeEvents(
    sessionId: string,
    opts: SubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent> {
    const { key, entry } = this.ownerEntry(sessionId);
    const client = entry.client;
    let evicted = false;
    try {
      for await (const event of client.subscribeEvents(sessionId, opts)) {
        if (event.type === 'session_died' || event.type === 'session_closed') {
          this.removeSession(sessionId);
        }
        if (event.type === 'client_evicted') evicted = true;
        yield event;
      }
    } catch (err) {
      // The same confirmation as every other call (#203): a refused
      // connection is a death, any other transport error waits for a
      // `/health` probe.
      if (!evicted && !opts.signal?.aborted) {
        await this.noteTransportDeath(key, entry, err);
      }
      throw err;
    }
  }

  /**
   * After a transport error (a dropped event stream, a reset call), ask the
   * daemon whether it is still there. Only a probe that itself fails at the
   * transport level confirms a death. Any HTTP answer, even an error status,
   * means a live process answered; a probe that does not settle within
   * `probeTimeoutMs` proves nothing either way. For a daemon that really is
   * gone, its exit event (`onExit`, or `handleDaemonExit` for the boot
   * daemon) still reports it, and a wrong "dead" here costs a second daemon
   * on a live workspace.
   */
  private probeConfirmsDeath(client: DaemonClient): Promise<boolean> {
    const probe = (async () => {
      await client.health();
      return false;
    })().catch((err: unknown) => isTransportDeathError(err));
    return settleWithin(probe, this.probeTimeoutMs, false);
  }

  async prompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    clientId?: string,
  ): Promise<PromptResult> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.prompt(sessionId, req, signal, clientId),
    );
  }

  async sessionContext(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionContextStatus> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionContext(sessionId, clientId),
    );
  }

  async sessionContextUsage(
    sessionId: string,
    opts?: { detail?: boolean },
    clientId?: string,
  ): Promise<DaemonSessionContextUsageStatus> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionContextUsage(sessionId, opts, clientId),
    );
  }

  async exportSession(
    sessionId: string,
    opts?: { format?: DaemonSessionExportFormat; clientId?: string },
  ): Promise<DaemonSessionExportResult> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.exportSession(sessionId, opts),
    );
  }

  async getSessionTranscriptPage(
    sessionId: string,
    opts?: DaemonSessionTranscriptPageOptions,
  ): Promise<DaemonSessionTranscriptPage> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.getSessionTranscriptPage(sessionId, opts),
    );
  }

  async getSessionTurnIndexPage(
    sessionId: string,
    opts?: DaemonSessionTurnIndexPageOptions,
  ): Promise<DaemonSessionTurnIndexPage> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.getSessionTurnIndexPage(sessionId, opts),
    );
  }

  async getCurrentSessionTurn(
    sessionId: string,
    opts?: { clientId?: string },
  ): Promise<DaemonSessionTurnStatus> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.getCurrentSessionTurn(sessionId, opts),
    );
  }

  async recapSession(
    sessionId: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<DaemonSessionRecapResult> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.recapSession(sessionId, opts),
    );
  }
  async btwSession(
    sessionId: string,
    question: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<DaemonSessionBtwResult> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.btwSession(sessionId, question, opts),
    );
  }

  async resetWorktreeSession(
    sessionId: string,
    req: WorktreeResetSessionRequest = {},
  ): Promise<DaemonSession> {
    // Read the owner BEFORE the call: the original id is what this pool knows,
    // and the replacement id it hands back is not in `ownerOf` yet.
    const ownerKey = this.ownerOf.get(sessionId);
    const result = await this.withSessionDeathTrigger(sessionId, (client) =>
      client.resetWorktreeSession(sessionId, req),
    );
    // The transfer moved the checkout to a session with a new id on the SAME
    // daemon, so the replacement inherits the original's workspace key. Without
    // this the replacement is unaddressable through the pool: `ownerEntry`
    // throws `UnknownSessionError` for an id it never recorded, and the release
    // that keeps the replacement from leaking would fail before reaching the
    // daemon. Recorded after the call, because a failed transfer produced no
    // replacement to record.
    const replacementId = (result as { sessionId?: unknown } | null)?.sessionId;
    if (
      ownerKey !== undefined &&
      typeof replacementId === 'string' &&
      replacementId.length > 0 &&
      replacementId !== sessionId
    ) {
      this.trackSession(ownerKey, replacementId);
    }
    return result;
  }

  async detachSession(sessionId: string, clientId?: string): Promise<void> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.detachSession(sessionId, clientId),
    );
  }

  async sessionStatus(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionSummary> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionStatus(sessionId, clientId),
    );
  }

  /**
   * Reads the session's task list: the runs this issue's title is about. Passed
   * through verbatim, including each shell task's `cwd` and `outputFile`. That
   * is not a new disclosure - `GET /session/:id/context` already relays the
   * workspace cwd to the same read scope (routes/sessionContext.ts), so a
   * reader able to reach this route can already reach the path. Stripping it
   * here would only make the two reads disagree about the same workspace.
   *
   * No `includeWorkflows`: the SDK wrapper takes no options, so the gateway can
   * only ask the daemon's default shape. That default is the redacted one - the
   * daemon expands workflows only when the workspace is trusted AND the query
   * opts in (cli/src/serve/routes/session.ts:7043), so the narrower view is what
   * arrives here regardless.
   */
  async sessionTasks(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionTasksStatus> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionTasks(sessionId, clientId),
    );
  }

  /**
   * `GET /session/:id/stats` relay. Passed through untouched for the same
   * reason `sessionTasks` is: the numbers are the daemon's accounting of a
   * conversation this reader can already read in full through
   * `GET /session/:id/transcript`, so nothing new is disclosed by handing the
   * roll-up over.
   *
   * No gateway-side cache. The roll-up moves while a turn is running, and a
   * stale number would read as a fact about a turn that has since finished.
   */
  async sessionStats(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionStatsStatus> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionStats(sessionId, clientId),
    );
  }

  /**
   * `GET /session/:id/resources` relay, passed through untouched. What it
   * discloses is which skills and MCP servers a conversation loaded, and a
   * reader who can read the transcript can already see both of those being
   * used, so nothing new is handed over by naming them.
   *
   * No gateway-side cache, for the reason `sessionStats` gives: a session
   * installs a skill or an MCP server finishes discovering mid-conversation,
   * and a stale list would read as the set the turn ran with.
   */
  async sessionResources(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionResourcesStatus> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionResources(sessionId, clientId),
    );
  }

  async respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
    clientId?: string,
  ): Promise<boolean> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.respondToSessionPermission(
        sessionId,
        requestId,
        response,
        clientId,
      ),
    );
  }

  async closeSession(sessionId: string, clientId?: string): Promise<void> {
    try {
      await this.withSessionDeathTrigger(sessionId, (client) =>
        client.closeSession(sessionId, clientId),
      );
    } catch (err) {
      // The daemon saying it does not hold the session is the end state a
      // close asks for, so release the id rather than leave it pinning its
      // daemon against idle reaping (#154). The SDK's own closeSession
      // already resolves on that 404; this keeps the pool's answer the same
      // for a client that surfaces it.
      if (!isSessionLevelGone(err)) throw err;
    }
    this.removeSession(sessionId);
  }

  /**
   * Abort the session's in-flight turn. Unlike {@link closeSession} the session
   * SURVIVES — only the running prompt is cancelled — so the pool entry is
   * deliberately left in place and `removeSession` is NOT called.
   */
  async cancel(sessionId: string, clientId?: string): Promise<void> {
    await this.withSessionDeathTrigger(sessionId, (client) =>
      client.cancel(sessionId, clientId),
    );
  }

  async uploadSessionAttachment(
    sessionId: string,
    data: Blob,
    name: string,
    mimeType: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.uploadSessionAttachment(sessionId, data, name, mimeType, opts),
    );
  }

  async listSessionAttachments(
    sessionId: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.listSessionAttachments(sessionId, opts),
    );
  }

  async readSessionAttachment(
    sessionId: string,
    attachmentId: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.readSessionAttachment(sessionId, attachmentId, opts),
    );
  }

  async removeSessionAttachment(
    sessionId: string,
    attachmentId: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.removeSessionAttachment(sessionId, attachmentId, opts),
    );
  }

  async listSessionArtifacts(
    sessionId: string,
    clientId?: string,
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.listSessionArtifacts(sessionId, clientId),
    );
  }

  async readSessionArtifactContent(
    sessionId: string,
    artifactId: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.readSessionArtifactContent(sessionId, artifactId, opts),
    );
  }

  async getPendingPrompts(
    sessionId: string,
    opts?: { clientId?: string },
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.getPendingPrompts(sessionId, opts),
    );
  }

  async removePendingPrompt(
    sessionId: string,
    promptId: string,
    opts?: { clientId?: string },
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.removePendingPrompt(sessionId, promptId, opts),
    );
  }

  async getMidTurnMessages(
    sessionId: string,
    opts?: { clientId?: string; signal?: AbortSignal },
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.getMidTurnMessages(sessionId, opts),
    );
  }

  async removeMidTurnMessage(
    sessionId: string,
    messageId: string,
    opts?: { clientId?: string },
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.removeMidTurnMessage(sessionId, messageId, opts),
    );
  }

  async enqueueMidTurnMessage(
    sessionId: string,
    message: string,
    opts?: { clientId?: string; messageId?: string },
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.enqueueMidTurnMessage(sessionId, message, opts),
    );
  }

  async sendMidTurnMessagesNow(
    sessionId: string,
    opts?: { clientId?: string },
  ): Promise<unknown> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sendMidTurnMessagesNow(sessionId, opts),
    );
  }

  async rewindSession(
    sessionId: string,
    promptId: string,
    opts?: { clientId?: string; rewindFiles?: boolean },
  ): Promise<DaemonRewindResult> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.rewindSession(sessionId, promptId, opts),
    );
  }

  async getRewindSnapshots(
    sessionId: string,
  ): Promise<{ snapshots: DaemonRewindSnapshotInfo[] }> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.getRewindSnapshots(sessionId),
    );
  }

  async sessionSupportedCommands(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionSupportedCommandsStatus> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionSupportedCommands(sessionId, clientId),
    );
  }

  async setSessionApprovalMode(
    sessionId: string,
    mode: DaemonApprovalMode,
    opts?: { persist?: boolean; clientId?: string },
  ): Promise<DaemonApprovalModeResult> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.setSessionApprovalMode(sessionId, mode, opts),
    );
  }

  async setSessionModel(
    sessionId: string,
    modelId: string,
    clientId?: string,
  ): Promise<SetModelResult> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.setSessionModel(sessionId, modelId, clientId),
    );
  }

  async loadSession(
    sessionId: string,
    req: RestoreSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonRestoredSession> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.loadSession(sessionId, req, clientId),
    );
  }

  /**
   * Cancels one running subagent, leaving the parent turn alive. Distinct from
   * `cancel`, which aborts the whole turn — that difference is the reason this
   * route exists. `subagentRef` is the PARENT transcript's tool-call id (the
   * daemon matches it against `task.toolUseId`), the same value the viewer
   * already holds as `_meta.parentToolCallId`, so no new identifier needs
   * plumbing.
   */
  async cancelSubagentSession(
    sessionId: string,
    subagentRef: string,
    clientId?: string,
  ): Promise<{ cancelled: boolean }> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.cancelSubagentSession(sessionId, subagentRef, clientId),
    );
  }

  /**
   * Stops ONE run (an agent, shell, monitor or workflow task) while leaving the
   * session and any other run alive. Distinct from `cancel`, which aborts the
   * whole turn, and from `cancelSubagentSession`, which reaches a child through
   * the PARENT's tool-call id: this one is keyed by the task id the run log
   * itself prints, so the row a reader sees is the row they can stop.
   *
   * The daemon's verdict is returned rather than collapsed. A workflow kind on
   * an untrusted workspace answers `{cancelled: false, reason: 'disabled'}`,
   * which is an answer about policy, not a failure to reach the daemon — the
   * caller has to be able to tell those apart.
   */
  async cancelSessionTask(
    sessionId: string,
    taskId: string,
    kind: DaemonSessionTaskWithWorkflowStatus['kind'],
    clientId?: string,
  ): Promise<{ cancelled: boolean; reason?: string }> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionTaskCancel(sessionId, taskId, kind, clientId),
    );
  }

  /**
   * Sets ONE session's human title. Two properties of the daemon's route are
   * worth carrying here, because both decide what a caller may conclude.
   *
   * This reaches a LOADED session only. The route's disk fallback, the branch
   * that renames an inactive or archived transcript, lives on the
   * workspace-qualified spelling and behind `runtime.trusted`
   * (cli/src/serve/routes/session.ts:1565, :8887). Through this door a session
   * the daemon has not loaded is a 404, never a rename.
   *
   * The returned name is the daemon's effective one. The route slices the name
   * to 256 and the bridge caps at 256, while the child's own persist refuses
   * above 200 and is not awaited, so a name can be accepted, published as a
   * live change, and never written to disk. The verdict to trust is the name
   * that comes back, not the name that was sent.
   */
  async updateSessionMetadata(
    sessionId: string,
    metadata: { displayName?: string },
    clientId?: string,
  ): Promise<SessionMetadataResult> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.updateSessionMetadata(sessionId, metadata, clientId),
    );
  }

  /**
   * Reads ONE running subagent's own state, keyed by the PARENT transcript's
   * tool-call id. The pair this completes is `cancelSubagentSession`: without
   * the read, a viewer can stop a child but cannot show what that child is
   * doing, which is why the nested subagent block in the transcript is display
   * only. Returns the daemon's resolution verbatim - it carries task id, title,
   * status and token counts, and no workspace path, so there is nothing here to
   * strip.
   */
  async resolveSubagentSession(
    sessionId: string,
    subagentRef: string,
    clientId?: string,
  ): Promise<DaemonSubagentSessionResolution> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.resolveSubagentSession(sessionId, subagentRef, clientId),
    );
  }

  /**
   * #110: the agent roster, relayed verbatim. Each row's `outputFile` is a
   * path under the workspace's project dir, which is the same disclosure
   * `sessionTasks` makes to the same read scope, for the reason recorded on it.
   * No gateway-side cache: a running agent's stats move between reads.
   */
  async sessionAgents(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionAgentsStatus> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionAgents(sessionId, clientId),
    );
  }

  /**
   * #110: the agents' lineage, relayed verbatim. `rootAgentId` narrows it to
   * one top-level agent's tree on the daemon, so a caller asking about one
   * agent need not page through every sidecar the session has.
   */
  async sessionAgentTrace(
    sessionId: string,
    opts: { rootAgentId?: string; clientId?: string } = {},
  ): Promise<DaemonAgentTrace> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionAgentTrace(sessionId, {
        rootAgentId: opts.rootAgentId,
        clientId: opts.clientId,
      }),
    );
  }

  /**
   * #110: one saved workflow definition. The daemon answers `workflow: null`
   * for an unknown name and for an untrusted workspace alike, so nothing here
   * can tell those apart and nothing should try.
   */
  async sessionSavedWorkflow(
    sessionId: string,
    name: string,
    clientId?: string,
  ): Promise<DaemonSessionSavedWorkflowStatus> {
    return this.withSessionDeathTrigger(sessionId, (client) =>
      client.sessionSavedWorkflow(sessionId, name, clientId),
    );
  }

  // -- Daemon-global (default daemon) ----------------------------------

  // These answer from whichever daemon serves the default workspace now: the
  // boot daemon, or its replacement once it has died (#163).

  health(): Promise<{ status: string }> {
    return this.withDefaultDeathTrigger((client) => client.health());
  }

  capabilities(): Promise<DaemonCapabilities> {
    return this.withDefaultDeathTrigger((client) => client.capabilities());
  }

  listWorkspaceSessions(workspaceCwd: string): Promise<DaemonSessionSummary[]> {
    return this.withDefaultDeathTrigger((client) =>
      client.listWorkspaceSessions(workspaceCwd),
    );
  }

  getSessionLiveState(workspaceCwd?: string): Promise<unknown> {
    // The selector is the daemon's OWN cwd, so an omitted or default-looking
    // target has to be resolved here rather than passed through: the route
    // cannot name a workspace it does not know the canonical path of, and
    // asking `capabilities()` for it would add a round trip to every poll.
    const key = this.keyFor(workspaceCwd);
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.getWorkspaceSessionLiveState(key),
    );
  }

  async peekSessionLiveState(workspaceCwd?: string): Promise<unknown> {
    const key = this.keyFor(workspaceCwd);
    // The default workspace always has a daemon unless the one serving it
    // just died; in that gap this read answers like any folder without one,
    // because it never spawns (the next spawning call, or the recovery saga,
    // brings the default back). A spawn still in flight is not an entry yet:
    // answering would mean waiting on it, and this read must cost a folder
    // with no daemon nothing.
    const entry = this.isDefault(workspaceCwd)
      ? this.defaultEntry
      : this.byWorkspace.get(key);
    if (!entry || entry.dead) return undefined;
    // No `touch`: the list asks this of every recent folder on every refresh,
    // and bumping `lastUsed` would keep each folder's idle daemon from ever
    // being reaped, which is the cost this read exists to avoid. No `hold`
    // either, unlike the spawning calls: with the list polling every folder,
    // a hold would turn a create at the cap into a 503 whenever a refresh
    // happened to be reading the one idle daemon it could evict. Losing that
    // race costs this background read a 502 and the next refresh asks again.
    return this.callOn(key, entry, (client) =>
      client.getWorkspaceSessionLiveState(key),
    );
  }

  // -- Workspace control (rc-workspace-permissions, scoped per #28) -----
  // Each takes an optional trailing `workspaceCwd` and resolves the target
  // through the pool (default/boot daemon when omitted or the default
  // workspace; spawn-on-demand otherwise) with the same transport-death
  // fallback as session-keyed calls.

  workspacePermissions(
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspacePermissionsStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspacePermissions(opts),
    );
  }

  setWorkspacePermissionRules(
    scope: DaemonPermissionScope,
    ruleType: DaemonPermissionRuleType,
    rules: readonly string[],
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspacePermissionsStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.setWorkspacePermissionRules(scope, ruleType, rules, opts),
    );
  }

  workspaceTrust(
    opts?: {
      clientId?: string;
      statusVersion?: 1;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatus>;
  workspaceTrust(
    opts: {
      clientId?: string;
      statusVersion: 2;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatus | DaemonWorkspaceTrustStatusV2>;
  workspaceTrust(
    opts?: {
      clientId?: string;
      statusVersion?: 1 | 2;
    },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustStatusResponse> {
    // Dispatch by statusVersion so the inner call matches one of the
    // DaemonClient overloads (the union-typed opts matches neither). The
    // consts keep the narrowing intact across the closure boundary.
    const statusVersion = opts?.statusVersion ?? 1;
    const clientId = opts?.clientId;
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      statusVersion === 2
        ? client.workspaceTrust({
            ...(clientId !== undefined ? { clientId } : {}),
            statusVersion: 2,
          })
        : client.workspaceTrust(
            clientId !== undefined ? { clientId } : undefined,
          ),
    );
  }

  requestWorkspaceTrustChange(
    request: DaemonWorkspaceTrustChangeRequest,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceTrustChangeResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.requestWorkspaceTrustChange(request, clientId),
    );
  }

  workspaceSettings(
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceSettingsStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspaceSettings(opts),
    );
  }

  workspaceEnv(workspaceCwd?: string): Promise<DaemonWorkspaceEnvStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspaceEnv(),
    );
  }

  workspacePreflight(
    workspaceCwd?: string,
  ): Promise<DaemonWorkspacePreflightStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspacePreflight(),
    );
  }

  workspaceSkills(workspaceCwd?: string): Promise<DaemonWorkspaceSkillsStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspaceSkills(),
    );
  }

  workspaceProviders(
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceProvidersStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspaceProviders(),
    );
  }

  workspaceHooks(workspaceCwd?: string): Promise<DaemonWorkspaceHooksStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspaceHooks(),
    );
  }

  workspaceMemory(workspaceCwd?: string): Promise<DaemonWorkspaceMemoryStatus> {
    // No options argument, on purpose: see routes/workspaceContext.ts.
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspaceMemory(),
    );
  }

  listWorkspaceAgents(
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceAgentsStatus> {
    // Named after the SDK method, not after its siblings. SessionDaemon is
    // implemented by BOTH this pool and a bare DaemonClient (the tests inject
    // one as deps.daemon), so a gateway-invented name here is undefined at
    // runtime on the client side. workspaceSkills above follows that rule.
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.listWorkspaceAgents(),
    );
  }

  setWorkspaceSetting(
    scope: 'workspace' | 'user',
    key: string,
    value: unknown,
    opts?: {
      clientId?: string;
      mcpServerMutation?: { operation: 'set' | 'remove'; name: string };
    },
    workspaceCwd?: string,
  ): Promise<DaemonSettingUpdateResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.setWorkspaceSetting(scope, key, value, opts),
    );
  }

  workspaceToolsCatalog(workspaceCwd?: string): Promise<DaemonToolCatalog> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspaceToolsCatalog(),
    );
  }

  setWorkspaceToolEnabled(
    toolName: string,
    enabled: boolean,
    opts?: { clientId?: string },
    workspaceCwd?: string,
  ): Promise<DaemonToolToggleResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.setWorkspaceToolEnabled(toolName, enabled, opts),
    );
  }

  workspaceMcp(workspaceCwd?: string): Promise<DaemonWorkspaceMcpStatus> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.workspaceMcp(),
    );
  }

  reloadWorkspaceMcp(
    options?: DaemonWorkspaceMcpReloadOptions,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceMcpInitializeResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.reloadWorkspaceMcp(options),
    );
  }

  dirList(dirPath: string, workspaceCwd?: string): Promise<unknown> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.dirList(dirPath),
    );
  }

  glob(pattern: string, workspaceCwd?: string): Promise<unknown> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.glob(pattern),
    );
  }

  readWorkspaceFile(
    filePath: string,
    opts?: {
      maxBytes?: number;
      line?: number;
      limit?: number;
      cursor?: string;
    },
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceFile> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.readWorkspaceFile(filePath, opts, clientId),
    );
  }

  readWorkspaceFileBytes(
    filePath: string,
    opts?: { offset?: number; maxBytes?: number },
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceFileBytes> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.readWorkspaceFileBytes(filePath, opts, clientId),
    );
  }

  // -- Workspace file writes (#123) -------------------------------------
  // Each routes to the target workspace's daemon like the reads above. The
  // daemon answers a stale replace with 409 `hash_mismatch` itself; the pool
  // only carries the call.

  fileStat(filePath: string, workspaceCwd?: string): Promise<unknown> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.fileStat(filePath),
    );
  }

  writeWorkspaceFile(
    req: DaemonWorkspaceFileWriteRequest,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceFileWriteResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.writeWorkspaceFile(req, clientId),
    );
  }

  editWorkspaceFile(
    req: DaemonWorkspaceFileEditRequest,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceFileEditResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.editWorkspaceFile(req, clientId),
    );
  }

  uploadWorkspaceFile(
    req: DaemonWorkspaceFileUploadRequest,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonWorkspaceFileUploadResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.uploadWorkspaceFile(req, clientId),
    );
  }

  /** Every pooled daemon is bound to its own workspace, so "its primary" is
   * the target workspace whichever daemon answers. */
  deleteWorkspaceFile(
    filePath: string,
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<void> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      deleteWorkspaceFileOnPrimary(client, filePath, clientId),
    );
  }

  // -- Sessions at rest (add-capability-parity #111) --------------------
  // The daemon's batch transcript actions. `workspaceCwd` resolves the target
  // daemon the same way the workspace-control block above does and is never
  // forwarded — the client's own second parameter is a daemon clientId, so
  // passing the cwd there would be read as an identity, not a target. The
  // daemon's per-id outcome is returned untouched so a partial failure stays
  // visible.

  archiveSessionsData(
    sessionIds: string[],
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonArchiveSessionsResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.archiveSessionsData(sessionIds, clientId),
    );
  }

  unarchiveSessionsData(
    sessionIds: string[],
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonUnarchiveSessionsResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.unarchiveSessionsData(sessionIds, clientId),
    );
  }

  deleteSessionsData(
    sessionIds: string[],
    clientId?: string,
    workspaceCwd?: string,
  ): Promise<DaemonDeleteSessionsResult> {
    return this.withWorkspaceDeathTrigger(workspaceCwd, (client) =>
      client.deleteSessionsData(sessionIds, clientId),
    );
  }

  /** Live pooled daemons (excl. default). */
  size() {
    return this.byWorkspace.size;
  }

  workspaces() {
    return [...this.byWorkspace.keys()];
  }

  /**
   * Stop the pool: cancel the background reaper and stop EVERY pooled
   * workspace daemon so none is orphaned when the gateway process exits.
   * The boot daemon is NOT touched here: its lifecycle belongs to
   * whoever constructed the pool (cli.ts stops it separately via its own
   * `handle.stop()`, alongside this call). A replacement the pool spawned
   * for the default workspace after the boot daemon died is the pool's own
   * and is stopped like a pooled one (#163), and so is a pooled or
   * replacement daemon a transport error took that nothing replaced yet
   * (#203). Tolerates an individual entry's
   * `stop()` rejecting (`Promise.allSettled`) — one stuck daemon must not
   * block the others from being asked to stop. Intended for shutdown; not
   * safe to call mid-lifetime (any in-flight session routing is dropped).
   *
   * Sets `stopped` FIRST, synchronously, before anything else: a spawn that
   * was in flight when shutdown began resolves after this returns, and its
   * `getOrSpawn` closure checks this flag to avoid registering a fresh
   * entry into the (already-cleared) pool — which would otherwise leak a
   * detached daemon process that nothing will ever stop.
   */
  async stopAll(): Promise<void> {
    this.stopped = true;
    clearInterval(this.reapTimer);
    const entries = new Set(this.byWorkspace.values());
    if (this.defaultEntry !== this.bootEntry) entries.add(this.defaultEntry);
    // A daemon a transport error took that nothing replaced may still be
    // running, and it is no longer in `byWorkspace` (#203).
    for (const old of this.superseded.values()) {
      if (old !== this.bootEntry) entries.add(old);
    }
    this.superseded.clear();
    await Promise.allSettled([...entries].map((e) => e.stop()));
    // Drain the spawns that were in flight when shutdown began. Each one stops
    // the daemon it just created once it sees `stopped`, but that cleanup only
    // runs if the process is still alive to run it, and the gateway calls this
    // immediately before `process.exit(0)`. Without the wait the exit wins the
    // race and the detached daemon keeps its port and its token. Bounded by the
    // probe knob: a wedged spawn must not hang shutdown.
    const inFlight = [...this.spawning.values()];
    if (this.defaultSpawning) inFlight.push(this.defaultSpawning);
    if (inFlight.length > 0) {
      await Promise.allSettled(
        inFlight.map((p) => settleWithin(p, this.probeTimeoutMs, undefined)),
      );
    }
    this.byWorkspace.clear();
    this.ownerOf.clear();
    this.pendingUses.clear();
  }
}

/** `fn()`, with a synchronous throw handed back as a rejected promise
 * instead of thrown at the call site (#203). */
function promiseFrom<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (err) {
    return Promise.reject(err);
  }
}

/** Resolve with `p`'s value, or with `fallback` if `p` rejects or has not
 * settled within `ms`. Never rejects. The timer is unref'd so a pending
 * probe cannot hold the process open. */
function settleWithin<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

// -- Transport-death classification (add-mid-turn-recovery) ------------

/** Socket codes (found on an error or its `cause` chain) that mean the daemon
 * transport is gone: the process is dead or the socket was torn down. Node's
 * "socket hang up" carries `ECONNRESET` and undici's "other side closed"
 * carries `UND_ERR_SOCKET`, so the codes cover both without reading text.
 * Only `ECONNREFUSED` is taken as a death outright; the others are also what
 * a live daemon's keep-alive race produces on an ordinary call, so the pool
 * confirms them with a probe first (#203, `transportDeathConfirmed`). */
const TRANSPORT_DEATH_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

/** True when `err` is a transport-level "the daemon is gone" error: the
 * SDK's own stream-terminal error, or a socket code on the error or its
 * `cause` chain (`fetch` wraps the socket error under a `TypeError: fetch
 * failed`). Walks at most 8 `cause` hops.
 *
 * Classified on each link's own type and `code`, never on message text
 * (#163): a daemon that answers a 500 whose body echoes an upstream "socket
 * hang up" is a live process, and a regex over the chain read it as dead. For
 * the same reason a `DaemonHttpError` (a numeric `status`: the daemon
 * answered) ends the walk as "not a death", whatever its message or cause. */
function isTransportDeathError(err: unknown): boolean {
  return transportDeathCode(err) !== undefined;
}

/** The classification behind {@link isTransportDeathError}, naming what it
 * found: the socket code, or `DaemonTransportClosedError`. Undefined when
 * `err` is not a transport death. The pool tells a refused connection
 * (nothing listening) from the rest by it (#203). */
function transportDeathCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (
    let depth = 0;
    cur !== null && typeof cur === 'object' && depth < 8;
    depth++
  ) {
    // The name check covers an SDK loaded from a second copy of the package,
    // where `instanceof` would fail.
    if (
      cur instanceof DaemonTransportClosedError ||
      (cur as { name?: unknown }).name === 'DaemonTransportClosedError'
    ) {
      return 'DaemonTransportClosedError';
    }
    if (asDaemonHttpError(cur) !== undefined) return undefined;
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSPORT_DEATH_CODES.has(code)) {
      return code;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
