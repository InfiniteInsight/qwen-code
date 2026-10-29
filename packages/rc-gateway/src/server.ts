/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import type { SessionDaemon } from './daemonPool.js';
import type { TokenStore } from './tokenStore.js';
import type { PairingService } from './pairing.js';
import type { VapidStore } from './webpush/vapid.js';
import type { PushStore } from './pushStore.js';
import {
  bearerResolve,
  requireScope,
  enforceSessionLock,
  resolveSubActor,
  enforceSubActorScope,
  enforceSubActorRateLimit,
  enforceSubActorBan,
} from './auth.js';
import {
  SubActorRateLimiter,
  DEFAULT_SUB_ACTOR_CAP,
} from './bridges/subActorRateLimiter.js';
import { SubActorBanStore } from './bridges/subActorBans.js';
import {
  OWNER,
  SESSION_READ,
  APPROVE,
  WRITE,
  SHARE,
  BRIDGE,
} from './scopes.js';
import { ConnectionRegistry } from './connectionRegistry.js';
import {
  AuditLog,
  parseAuditEnvNumber,
  type AuditRecorder,
} from './auditLog.js';
import { PeerAuditThrottle } from './auditThrottle.js';
import { createPairRedeemRoute } from './routes/pair.js';
import {
  createListCorsOriginsRoute,
  createAddCorsOriginRoute,
  createRemoveCorsOriginRoute,
} from './routes/cors.js';
import type { CorsAllowlist } from './cors.js';
import {
  allowlistFromRecords,
  evaluatePreflight,
  corsHeadersForActualRequest,
} from './cors.js';
import { createFsBrowseRoute } from './routes/fsBrowse.js';
import { createPermissionVoteRoute } from './routes/permission.js';
import { createPromptRoute, type PromptAcceptedHook } from './routes/prompt.js';
import { PromptEventBroadcaster } from './routes/promptEventBroadcaster.js';
import { PromptQueue } from './routes/promptQueue.js';
import type { AgentRegistry } from './agents/agentRegistry.js';
import { AgentLifecycle } from './agents/agentLifecycle.js';
import {
  createSpawnAgentRoute,
  createListAgentsRoute,
  createGetAgentRoute,
  createAgentMessageRoute,
  createAgentCancelRoute,
} from './routes/agents.js';
import type { ReviewRegistry, ReviewRecord } from './reviews/reviewRegistry.js';
import { ReviewLifecycle } from './reviews/reviewLifecycle.js';
import { ReviewPermissionBridge } from './reviews/reviewPermissionBridge.js';
import {
  createTriggerReviewRoute,
  createListReviewsRoute,
  createGetReviewRoute,
  createCancelReviewRoute,
} from './routes/review.js';
import { createUsageRoute, type UsageReader } from './routes/usage.js';
import { createCapabilityRoute } from './routes/capabilities.js';
import { createClientsManifestRoute } from './routes/clientsManifest.js';
import {
  createNativePushRouter,
  createAssetLinksRoute,
} from './routes/nativePush.js';
import type { ApnsStore } from './nativePush/apnsStore.js';
import {
  ApnsSender,
  createHttp2ApnsTransport,
  type ApnsTransport,
} from './nativePush/apnsSender.js';
import type { NativeShellsCapability } from './nativePush/nativeShells.js';
import type { AggregateQuery } from './cost/usageStore.js';
import type { UsageTickBroadcaster } from './cost/usageTickBroadcaster.js';
import { createForkRoute } from './routes/fork.js';
import { createRewindRoute } from './routes/rewind.js';
import { createApprovalModeRoute } from './routes/approvalMode.js';
import { createModelSwitchRoute } from './routes/modelSwitch.js';
import { createWorkspacePermissionsRoutes } from './routes/workspacePermissions.js';
import { createWorkspaceTrustRoutes } from './routes/workspaceTrust.js';
import { createWorkspaceSettingsRoute } from './routes/workspaceSettings.js';
import {
  createWorkspaceEnvRoute,
  createWorkspacePreflightRoute,
} from './routes/workspaceDiagnostics.js';
import {
  createWorkspaceHooksRoute,
  createWorkspaceProvidersRoute,
  createWorkspaceSkillsRoute,
} from './routes/workspaceInventory.js';
import {
  createWorkspaceAgentsRoute,
  createWorkspaceMemoryRoute,
} from './routes/workspaceContext.js';
import {
  createWorkspaceToolToggleRoute,
  createWorkspaceToolsCatalogRoute,
} from './routes/workspaceTools.js';
import { createWorkspaceMcpRoutes } from './routes/workspaceMcp.js';
import {
  createWorkspaceFileBytesRoute,
  createWorkspaceFileRoute,
  createWorkspaceGlobRoute,
  createWorkspaceListRoute,
} from './routes/workspaceFiles.js';
import {
  createWorkspaceFileBody,
  createWorkspaceFileDeleteRoute,
  createWorkspaceFileEditRoute,
  createWorkspaceFileUploadRoute,
  createWorkspaceFileWriteRoute,
  createWorkspaceStatRoute,
} from './routes/workspaceFileWrites.js';
import { createPolicyExplainRoute } from './routes/policyExplain.js';
import type { PolicyExplainAccess } from './routes/policyExplain.js';
import { createPermissionOverlayRoutes } from './routes/permissionOverlays.js';
import type { PermissionOverlayStore } from './policy/overlays.js';
import { createPeersRoute } from './routes/peers.js';
import type { BrowsePeers } from './routes/peers.js';
import { createGpuRoute } from './routes/gpu.js';
import { createLlamaSwapRoute } from './routes/llamaSwap.js';
import {
  createIdleToggleRoute,
  createIdleStatusRoute,
  type IdleStatusResolver,
} from './routes/idleToggle.js';
import { IdleSessionToggles } from './idle/sessionToggles.js';
import {
  createRegisterBridgeRoute,
  createListBridgesRoute,
  createDeregisterBridgeRoute,
  createBanSubActorRoute,
  createLiftBanRoute,
  createListBansRoute,
  createMintInviteRoute,
  createRedeemInviteRoute,
  createHeartbeatRoute,
} from './routes/bridges.js';
import { BridgeRegistry } from './bridges/registry.js';
import { InviteStore } from './bridges/inviteStore.js';
import { createLineageRoute } from './routes/lineage.js';
import { createSessionListRoute } from './routes/sessions.js';
import { createSessionRestRoute } from './routes/sessionRest.js';
import {
  createSessionEventsRoute,
  withGatewayResumeCursor,
} from './routes/sessionEvents.js';
import { createSessionContextRoute } from './routes/sessionContext.js';
import { createSessionContextUsageRoute } from './routes/sessionContextUsage.js';
import { createSessionExportRoute } from './routes/sessionExport.js';
import { createSessionTranscriptRoute } from './routes/sessionTranscript.js';
import { createSessionTurnIndexRoute } from './routes/sessionTurnIndex.js';
import { createSessionRecapRoute } from './routes/sessionRecap.js';
import { createSessionBtwRoute } from './routes/sessionBtw.js';
import {
  createSupportedCommandsRoute,
  createSessionCommandInvokeRoute,
} from './routes/supportedCommands.js';
import { createSessionStatusRoute } from './routes/sessionStatus.js';
import { createSessionEndRoute } from './routes/sessionEnd.js';
import { createSessionCancelRoute } from './routes/sessionCancel.js';
import { createSubagentCancelRoute } from './routes/subagentCancel.js';
import { createSessionTaskCancelRoute } from './routes/sessionTaskCancel.js';
import { createSessionRenameRoute } from './routes/sessionRename.js';
import { createSubagentInspectRoute } from './routes/subagentInspect.js';
import { createSessionTasksRoute } from './routes/sessionTasks.js';
import { createSessionStatsRoute } from './routes/sessionStats.js';
import { createSessionResourcesRoute } from './routes/sessionResources.js';
/** #127: session artifacts (the read pair; the mutation pair needs a client id). */
import {
  createSessionArtifactContentRoute,
  createSessionArtifactListRoute,
} from './routes/sessionArtifacts.js';
/** #109: session attachments (uploads + the list that confirms them). */
import {
  createAttachmentListRoute,
  createAttachmentReadRoute,
  createAttachmentRemoveRoute,
  createAttachmentUploadRoute,
  createResumableAttachmentUploads,
  gateJsonBody,
  createRawAttachmentBody,
  createAttachmentLimitResolver,
} from './routes/sessionAttachments.js';
import {
  installAsyncErrorCapture,
  jsonErrorBackstop,
} from './middleware/errorBackstop.js';
import { bearerMatches } from './localCredential.js';
/** #110: the visible queue (pending prompts and mid-turn messages). */
import {
  createMidTurnMessageEnqueueRoute,
  createMidTurnMessageRemoveRoute,
  createMidTurnMessagesRoute,
  createMidTurnMessagesSendNowRoute,
  createPendingPromptRemoveRoute,
  createPendingPromptsRoute,
} from './routes/sessionQueue.js';
/** #111: which sessions in a workspace are actually open right now. */
import { createSessionLiveStateRoute } from './routes/sessionLiveState.js';
import { createSessionCreateRoute } from './routes/sessionCreate.js';
import { createTerminalOpenRoute } from './routes/terminals.js';
import type { TerminalRequestLog } from './terminals.js';
import { RECENT_WORKSPACES_CAP, mergeRecentWorkspaces } from './terminals.js';
import type { HostAttachedWorkspaces } from './hostAttachedWorkspaces.js';
import { createSessionResumeRoute } from './routes/sessionResume.js';
import { createSessionWorktreeResetRoute } from './routes/sessionWorktreeReset.js';
import {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
  createRevokeAllTokensRoute,
  type RevokeCascadeCounts,
} from './routes/tokens.js';
import { createShareRouter, createShareWhoamiHandler } from './routes/share.js';
import { createAuditQueryRoute } from './routes/audit.js';
import { createOwnerEventsRoute } from './routes/ownerEvents.js';
import { createHookIngestRoute } from './routes/hookIngest.js';
import { createHostAttachRoutes } from './routes/hostAttach.js';
import { WorkflowRunRegistry } from './workflows/workflowRegistry.js';
import {
  createStartWorkflowRoute,
  createListWorkflowsRoute,
  createGetWorkflowRoute,
  createCancelWorkflowRoute,
} from './routes/workflows.js';
import { OwnerEventBus } from './ownerEvents.js';
import { createPushRouter } from './routes/push.js';
import { createUiPrefsRouter } from './routes/uiPrefs.js';
import type { UiPrefsStore } from './uiPrefsStore.js';
import { createHostActionRoutes } from './routes/hostActions.js';
import type { HostActions } from './hostActions.js';
import { createRoutingRouter } from './routes/routing.js';
import { createSearchRoute, type RankedSearch } from './routes/search.js';
import { versionCheckMiddleware } from './middleware/versionCheck.js';
import {
  resolveChatsDir,
  resolveSearchIndexDir,
} from './sessions/chatsPath.js';
import { CommandLoader } from './commands/loader.js';
import {
  createListCommandsRoute,
  createInvokeCommandRoute,
} from './routes/commands.js';
import { PushSender } from './webpush/sender.js';
import {
  PushEndpointPolicy,
  parsePushHostsEnv,
} from './webpush/endpointPolicy.js';
import { PushNotifier } from './webpush/notifier.js';
import { PushRateLimiter } from './webpush/rateLimiter.js';
import { PushCoalescer } from './webpush/coalescer.js';
import { PushDigest } from './webpush/digest.js';
import { WatchPresence } from './webpush/watchPresence.js';
import type { SnoozeStore } from './routing/snooze.js';
import type { RoutingMatcher } from './routing/rules.js';
import {
  WorkingDeviceTracker,
  recordActivity,
} from './routing/workingDevice.js';

export interface GatewayDeps {
  daemon: SessionDaemon;
  store: TokenStore;
  pairing: PairingService;
  /**
   * Host-terminal request log (issue #49). The `POST /rc/terminals` route
   * mounts only when this is set AND `daemon` can resolve a session's endpoint,
   * so a gateway without one (or a plain single-daemon wiring) simply lacks the
   * route instead of accepting requests nothing will service.
   */
  terminalRequests?: TerminalRequestLog;
  /**
   * The qwen command a host terminal should run (issue #49). Must name a build
   * that supports `--attach-daemon`; defaults to `qwen` on PATH.
   */
  terminalQwenArgv?: string[];
  /**
   * This gateway's own entry point as argv, which a phone-opened terminal runs
   * as `qwen-rc attach --session <id> <cwd>` so it re-attaches after a
   * gateway restart. Defaults to `qwen-rc` on PATH.
   */
  terminalRcArgv?: string[];
  /** Audit log path; defaults to ~/.qwen/rc/audit.log. */
  auditPath?: string;
  /**
   * Days of audit files kept (#165). Falls back to the
   * `QWEN_RC_AUDIT_RETENTION_DAYS` env, then 30. 0 keeps everything.
   */
  auditRetentionDays?: number;
  /**
   * Ceiling on all audit files together, in bytes (#165). Falls back to the
   * `QWEN_RC_AUDIT_MAX_BYTES` env, then 1 GiB. 0 = no ceiling.
   */
  auditMaxTotalBytes?: number;
  /** Static web-client root; defaults to the package's public/ dir. */
  webRoot?: string;
  /** Gateway-owned VAPID keypair. Push routes mount only when both this and pushStore are set. */
  vapid?: VapidStore;
  /** Token-bound push subscription store. Push routes mount only when both this and vapid are set. */
  pushStore?: PushStore;
  /**
   * Per-token display preferences (#80). The route mounts only when this is set.
   * Keyed by token because a display zone describes the device reading, not the
   * record being read.
   */
  uiPrefs?: UiPrefsStore;
  /**
   * Owner-configured host actions (#192): programs on this host the page can
   * probe and start, such as the Windows tray launcher. The routes mount only
   * when this is set; the store carries its own runner, so a test or the page
   * harness hands in one built over a fake.
   */
  hostActions?: HostActions;
  /**
   * `--max-attachment-bytes` (#196): the configured upload limit. The limit
   * actually enforced and reported is {@link effectiveAttachmentLimit} of it.
   */
  maxAttachmentBytes?: number;
  /**
   * The resolved path of the `qwen` the gateway spawns its daemons as
   * (`--qwen-bin`), reported as `daemonQwenBin` on `/rc/capabilities`.
   */
  daemonQwenBin?: string;
  /**
   * Whether that binary's boot import probe passed (#191): false means the
   * build is inconsistent and daemons and terminals started from it die on
   * load. Omitted when the probe could not tell.
   */
  daemonQwenBinHealthy?: boolean;
  /** Persisted snooze store. Routing routes + notifier snooze-gating wire only when set. */
  snooze?: SnoozeStore;
  /** Compiled routing matcher; notifier drop-gating wires only when set. */
  routing?: RoutingMatcher;
  /** Pre-built command loader (test injection). Built from deps when omitted. */
  commandLoader?: CommandLoader;
  /** User-level slash-command root; defaults to ~/.qwen/commands. */
  commandsUserDir?: string;
  /**
   * Same-kind push coalescing window in ms (design D6). Default 0 = DISABLED
   * (the prompt-safety default: coalescing is the one fail-CLOSED gate, so it is
   * opt-in). Falls back to the `QWEN_RC_COALESCE_MS` env when unset.
   */
  coalesceWindowMs?: number;
  /**
   * Where a push subscription endpoint may point (#165). Defaults to the known
   * Web Push services, or to the `QWEN_RC_PUSH_HOSTS` env when set (a
   * comma-separated list of host suffixes, or `*` for any public host).
   */
  pushEndpointPolicy?: PushEndpointPolicy;
  /**
   * Per-session idle override store (the `/suggest on|off` toggle). The boot
   * wiring (cli.ts) creates it so the idle handler's `getSessionEnabled` and the
   * toggle route share one instance. Defaults to a fresh store when omitted.
   */
  idleToggles?: IdleSessionToggles;
  /**
   * Live idle runtime snapshot for the `/suggest status` route (cli.ts owns the
   * config + rate-limiter). Omitted → status reports `available:false`.
   */
  idleStatus?: IdleStatusResolver;
  /**
   * Root directory for per-session WAL files (#174; segments live under
   * `<walDir>/wal/`). When set, the events route relays each session through
   * one shared, WAL-backed subscription (durable replay, id renumbering), the
   * fork and rewind routes seed durable markers (`session_forked`/
   * `child_forked`/`session_rewound`), and the resume route hands back its
   * watermark in the gateway's numbering. cli.ts wires `--wal-dir` (default
   * `~/.qwen/rc`, so the WAL is `~/.qwen/rc/wal/`); `--no-wal` leaves it unset,
   * and every one of those
   * paths then behaves as it did before the WAL was wired.
   */
  walDir?: string;
  /** Live policy access for POST /policy/explain (P4). Absent → route not mounted. */
  policyExplain?: PolicyExplainAccess;
  /**
   * Session-scoped permission overlay store (issue #33): TTL-bound,
   * dashboard-set overrides that preempt the file policy. When set, the
   * OWNER-scoped `/rc/permission-overlays` routes (GET/POST/DELETE) mount.
   * Absent → routes not mounted at all (404, not a 503).
   */
  permissionOverlays?: PermissionOverlayStore;
  /** LAN daemon discovery for GET /rc/peers. Absent → route not mounted. */
  browsePeers?: BrowsePeers;
  /** GPU status probe for GET /rc/gpu. Absent → route not mounted. */
  gpuProbe?: () => Promise<import('./gpu/gpuStatus.js').GpuStatusResponse>;
  /** llama-swap status probe for GET /rc/llama-swap. Absent → route not mounted. */
  llamaSwapProbe?: () => Promise<
    import('./llama-swap/llamaSwapStatus.js').LlamaSwapStatusResponse
  >;
  /**
   * Per-sub-actor write cap within the limiter's rolling window (bridge
   * fan-in protection). Defaults to {@link DEFAULT_SUB_ACTOR_CAP}. Falls back to
   * `QWEN_RC_SUBACTOR_CAP` when unset.
   */
  subActorCap?: number;
  /**
   * Cost tracking (`add-cost-tracking`). When `usageReader` is set, `GET /rc/usage`
   * mounts; `onPromptAccepted` (when set) captures per-session attribution on each
   * accepted prompt. Both omitted → cost tracking disabled (native sqlite absent
   * or operator opt-out). `usageLabelFor` maps an aggregate key to a display label.
   */
  usageReader?: UsageReader;
  usageLabelFor?: (groupBy: AggregateQuery['groupBy'], key: string) => string;
  onPromptAccepted?: PromptAcceptedHook;
  /** Per-session usage_tick fan-out; the events relay registers per subscriber. */
  usageBroadcaster?: UsageTickBroadcaster;
  /** Live currency label for the cost-tracking capability block. */
  costCurrencyLabel?: () => string;
  /**
   * mDNS advertising state for the capability surface (`add-mdns-discovery`).
   * When set, `/rc/capabilities` reports `remoteControl.mdns`. Omitted → the
   * mdns block is absent (e.g. discovery feature not wired).
   */
  mdnsStatus?: () => { advertising: boolean; instanceName?: string };
  /**
   * Read `~/.qwen/rc/clients.toml` for the owner-only multi-workspace registry
   * (`add-multi-workspace-client`). Resolve `null` on ENOENT, reject on other
   * errors. When set, `GET /ui/clients-manifest.json` mounts.
   */
  clientsManifestReadToml?: () => Promise<string | null>;
  /**
   * APNs device-token subscriptions for the iOS native shell
   * (`add-native-mobile-shells`). When set, `/rc/native-push/apns/*` mounts and
   * token revocation cascade-deletes the token's subscriptions.
   */
  apnsStore?: ApnsStore;
  /**
   * APNs delivery materials (`add-native-mobile-shells` delivery pipeline). When
   * set alongside `apnsStore` and the notifier, push notifications also fan out
   * to APNs devices. The signer/bundle/host are built by the host (cli) from the
   * config + P-8 key; the gateway builds the `ApnsSender` here so it can wire its
   * own audit log and the live-token orphan guard (`isTokenLive`). `transport` is
   * injectable for tests (defaults to the real HTTP/2 transport to Apple).
   */
  apns?: {
    signer: { token(): string };
    bundleId: string;
    host: string;
    transport?: ApnsTransport;
  };
  /**
   * `remoteControl.nativeShells` capability block (`add-native-mobile-shells`).
   * When set, `/rc/capabilities` reports it (`apnsEnabled` reflects a loadable
   * P-8 key + complete config, resolved live by the caller).
   */
  nativeShellsCapability?: () => NativeShellsCapability;
  /**
   * Android TWA Digital Asset Links statement, or `null` when no TWA is
   * configured. When set, the PUBLIC `GET /.well-known/assetlinks.json` mounts;
   * `null` → 404 (the shell falls back to a Custom Tab).
   */
  assetLinks?: () => Array<Record<string, unknown>> | null;
  /**
   * Owner-configured CORS origins (read-only; sourced from config file, not
   * the store).  These are merged at load into the allowlist as `source:
   * 'config'` entries and cannot be deleted via the API (409).
   */
  /**
   * Per-session prompt queue configuration (spec "Per-session FIFO preserved").
   * `queueWaitMs`: max ms a prompt POST may wait for the slot before returning
   * 503 `queue_timeout` (default 120_000).
   * `promptTimeoutMs`: max ms the daemon turn may run before it is cancelled
   * and a synthetic `stream_error { code: "prompt_timeout" }` is broadcast to
   * SSE subscribers (default 600_000).
   */
  queueWaitMs?: number;
  promptTimeoutMs?: number;
  corsConfigOrigins?: readonly string[];
  /**
   * The gateway's own UI origin, used as the unconditional CORS admission
   * bypass at redemption.  Format: `scheme://host[:port]` (RFC 6454 serialized
   * origin).  When omitted, the admisssion gate still runs but the
   * "own-UI-origin bypass" never fires.
   */
  ownUiOrigin?: string;
  /** Agent observability (add-agent-observability). Routes mount only when set. */
  agents?: {
    registry: AgentRegistry;
    /** Read-time cost rollup keyed by sessionId (UsageStore.sessionTotals). */
    costFor?: (sessionId: string) => number | undefined;
    /** Spawn accept window override (tests). */
    promptAcceptWindowMs?: number;
  };
  /**
   * Hook event mirror (add-agent-observability). When set, `POST
   * /rc/hooks/ingest` mounts — loopback-only, authenticated by the dedicated
   * persistent `ingestToken` (NOT a TokenStore token), mirroring local hook
   * firings as read-only `hook_event` frames on the OWNER events stream. The
   * route mounts BEFORE `bearerResolve` (same early-mount reason as
   * `/rc/pair/redeem`). Omitted → the route does not mount.
   */
  hookIngest?: {
    ingestToken: string;
    bucketCapacity?: number;
    bucketRefillPerSec?: number;
  };
  /**
   * Host attach (#194 slice D, `qwen-rc attach`). When set, `POST
   * /rc/host/attach` and `POST /rc/host/attach/:sessionId` mount:
   * loopback-only, authenticated by the persistent host-attach `token` (NOT a
   * TokenStore token), and mounted BEFORE `bearerResolve` like the hook
   * ingest route. The routes need `daemon.daemonEndpointForSession` (a
   * `DaemonPool`) and answer 501 without it. Omitted: the routes do not mount
   * and `/rc/capabilities` reports `hostAttach: false`.
   */
  hostAttach?: {
    token: string;
  };
  /**
   * The workspaces `qwen-rc attach` has used (#194 slice D). The host attach
   * routes note each one here, and `GET /rc/sessions` merges them with the
   * request log's workspaces, so a conversation started from a terminal in a
   * folder the phone never used is listed. Omitted: the listing reads the
   * request log alone, as before.
   */
  hostAttachedWorkspaces?: HostAttachedWorkspaces;
  /** Workflow orchestration (add-workflow-orchestration). Routes mount only when set. */
  workflows?: {
    runsDir?: string;
    resolveNamed?: (name: string) => Promise<string | undefined>;
  };
  /**
   * Remote review control plane (add-remote-review). Routes mount only when
   * set. The lifecycle is constructed here (it needs the app-internal
   * `ownerEvents` bus); the permission bridge is default-constructed from the
   * daemon unless an explicit `bridge` is injected (tests inject a spy).
   */
  review?: {
    registry: ReviewRegistry;
    /** Injected permission bridge; default-constructed from the daemon when omitted. */
    bridge?: ReviewPermissionBridge;
    /** Read-time cost rollup keyed by sessionId (UsageStore.sessionTotals). */
    costFor?: (sessionId: string) => number | undefined;
    /** Resolves the saved report + PR summary for a completed review. */
    resolveReport?: (rec: ReviewRecord) => Promise<{
      reportPath: string | null;
      summary: ReviewRecord['summary'];
    }>;
    /** Trigger accept window override (tests). */
    promptAcceptWindowMs?: number;
  };
}

export interface GatewayApp {
  app: Express;
  /** Present only when both `vapid` and `pushStore` deps are supplied. */
  notifier?: PushNotifier;
  /** The gateway's audit log — shared with the policy enforcer at boot. */
  audit: AuditRecorder;
  /**
   * The owner-event bus backing GET /rc/events. Exposed so the boot wiring
   * (cli.ts) can publish gateway-originated frames — e.g. the idle-suggestions
   * handler emitting `idle_suggestions` when a session's active prompt finishes.
   */
  ownerEvents: OwnerEventBus;
  /**
   * Per-session idle-suggestion overrides backing POST
   * /session/:id/idle-suggest-toggle. Exposed so the boot wiring (cli.ts) can
   * feed the idle handler's `getSessionEnabled` from the same store the route
   * writes to.
   */
  idleToggles: IdleSessionToggles;
  /**
   * The live-bridge registry. Exposed so the boot wiring (cli.ts) can run the
   * staleness reaper on an interval (auto-deregister bridges that stopped
   * heartbeating) — kept out of createGatewayApp so no background timer leaks in
   * tests that construct the app directly.
   */
  bridgeRegistry: BridgeRegistry;
  /** Per-session gateway-event fan-out (exposed for the agent lifecycle). */
  promptEvents: PromptEventBroadcaster;
  /** Per-session prompt queue (add-mid-turn-recovery: the recovery
   * orchestrator reads `isInFlight` for the hadInFlightTurn check). */
  promptQueue: PromptQueue;
  /** Present only when deps.agents is supplied. */
  agentLifecycle?: AgentLifecycle;
  /** Present only when deps.review is supplied. */
  reviewLifecycle?: ReviewLifecycle;
  /** Present only when both deps.workflows AND deps.agents are supplied. */
  workflowRuns?: WorkflowRunRegistry;
}

/**
 * The JSON parser for a route mounted ahead of `bearerResolve` that has its
 * own host-local secret (#163): the body is parsed only when the request
 * carries `token` as its bearer. Anyone else's body is left unread, and the
 * route's own check (which still runs, in its own order) answers them, so a
 * caller without the secret cannot make the gateway parse a body, and cannot
 * tell a malformed body (which would be a 400) from a refused one.
 */
function jsonForBearer(token: string): express.RequestHandler {
  const json = express.json();
  return (req, res, next) =>
    bearerMatches(req.headers.authorization, token)
      ? json(req, res, next)
      : next();
}

export function createGatewayApp(deps: GatewayDeps): GatewayApp {
  // #155: Express 4 drops the promise an async handler returns, so a rejection
  // escaped to the process (and Node 22 exits on it). Forward it to next(err)
  // instead; jsonErrorBackstop at the end of this function answers it.
  installAsyncErrorCapture();
  const app = express();
  // Never render Express's development error page (HTML with a stack trace),
  // whatever NODE_ENV says. The backstop answers JSON first; this covers the
  // default handler it hands an already-started response to.
  app.set('env', 'production');
  // No JSON parser here (#163). The app-wide one is mounted right after
  // `bearerResolve` below, so an unauthenticated body is never parsed: it is
  // a 401 whether it is malformed, oversized or fine. The few routes that sit
  // ahead of `bearerResolve` and need a body parse it themselves (see
  // `jsonForBearer`), and a malformed body that does get parsed reaches
  // `jsonErrorBackstop` at the end of this function as a 400 `invalid_json`.
  // #196: one number for the upload parser, its 413 text and the capability
  // the page reads to size an image before sending it.
  // It follows the per-file cap the daemon advertises (read lazily, cached),
  // so raising the daemon's cap raises this without a gateway change.
  const attachmentLimit = createAttachmentLimitResolver(
    deps.maxAttachmentBytes,
    () => deps.daemon.capabilities(),
  );

  const registry = new ConnectionRegistry();

  // Per-session prompt queue broadcaster — wired to both the prompt route
  // (emit) and the events relay (register/write). Created here so both routes
  // share the same instance without requiring the caller to instantiate it.
  const promptEventBroadcaster = new PromptEventBroadcaster();
  // Live-watch presence for push suppression (#40): each attached session
  // stream joins/leaves, and the notifier drops turn-end pushes while a
  // session is watched live. Shared by the events route and the notifier.
  const watchPresence = new WatchPresence();
  // Shared per-session FIFO serialiser: both the prompt route and the agent
  // routes' spawn/steer prompts must queue behind each other for the same
  // session, so a single PromptQueue instance is injected into both.
  const promptQueue = new PromptQueue();

  // Owner-level event bus (cycle 49): every durably-appended audit record is
  // fanned out to OWNER subscribers of GET /rc/events. Internal to the app — the
  // enforcer/reloader broadcast for free because they share this `audit`
  // instance, so policy_decision/policy_reloaded/policy_reload_failed all stream.
  const ownerEvents = new OwnerEventBus();
  const audit = new AuditLog(
    deps.auditPath ?? join(homedir(), '.qwen', 'rc', 'audit.log'),
    undefined,
    {
      onRecord: (record) => ownerEvents.publish({ type: 'audit', record }),
      // #165: bounded on disk. Unset or unparseable falls back to the
      // defaults (30 days, 1 GiB); 0 turns that bound off.
      retentionDays:
        deps.auditRetentionDays ??
        parseAuditEnvNumber(process.env.QWEN_RC_AUDIT_RETENTION_DAYS),
      maxTotalBytes:
        deps.auditMaxTotalBytes ??
        parseAuditEnvNumber(process.env.QWEN_RC_AUDIT_MAX_BYTES),
    },
  );
  // Routes that relay daemon errors reach the audit log through the app, so
  // a daemon 401 can leave a row without every factory taking `audit`.
  app.locals.audit = audit;
  // #165: rows that unauthenticated traffic can cause (401s, refused CORS
  // preflights) are written once per peer per minute with a count, through
  // this one shared throttle, instead of once per request.
  const unauthAudit = new PeerAuditThrottle(audit);

  // ---------------------------------------------------------------------------
  // CORS allowlist — built from persisted db origins + config overrides.
  // The `corsAllowlist` instance is mutated live as origins are admitted/removed.
  // ---------------------------------------------------------------------------
  const corsInitialRecords = deps.store.listOrigins(
    deps.corsConfigOrigins ?? [],
  );
  const corsAllowlist: CorsAllowlist = allowlistFromRecords(corsInitialRecords);

  // Owner-configured origins are in-memory overrides (config-sourced).
  for (const o of deps.corsConfigOrigins ?? []) corsAllowlist.add(o);

  // CORS preflight handler — runs BEFORE auth middleware so browsers can
  // complete the preflight without sending credentials.
  app.options('*', (req, res) => {
    const decision = evaluatePreflight(
      {
        method: req.method,
        origin: req.headers['origin'] as string | undefined,
        requestMethod: req.headers['access-control-request-method'] as
          | string
          | undefined,
        requestHeaders: req.headers['access-control-request-headers'] as
          | string
          | undefined,
      },
      corsAllowlist,
    );
    for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);
    if (decision.allowed) {
      res.status(204).end();
    } else {
      unauthAudit.record(req.socket?.remoteAddress, {
        action: 'cors_denied',
        detail: {
          origin: decision.origin,
          phase: 'preflight',
        },
      });
      res.status(403).end();
    }
  });

  // Actual-request CORS header middleware — runs before auth so browsers
  // receive the CORS headers even on 401/403 responses.
  const applyActualRequestCors = (
    req: express.Request,
    res: express.Response,
  ): void => {
    if (req.method === 'OPTIONS') return;
    const cors = corsHeadersForActualRequest(
      req.headers['origin'] as string | undefined,
      corsAllowlist,
    );
    for (const [k, v] of Object.entries(cors.headers)) res.setHeader(k, v);
  };
  app.use((req, res, next) => {
    applyActualRequestCors(req, res);
    next();
  });
  // Process-local activity tracker: feeds the notifier's working-device
  // suppression and is touched by recordActivity on the human-action POSTs.
  const workingDevice = new WorkingDeviceTracker();
  // Per-session idle-suggestion overrides (the `/suggest on|off` toggle store).
  // Injected by the boot wiring so the idle handler + toggle route share one
  // instance; a fresh store otherwise (tests, idle-less deployments).
  const idleToggles = deps.idleToggles ?? new IdleSessionToggles();
  // In-memory registry of live bridges (add-bridge-protocol). Advisory presence/
  // capability metadata; a gateway restart drops it and bridges re-register.
  const bridgeRegistry = new BridgeRegistry();
  // Per-sub-actor write limiter: caps prompts/votes per asserted chat user so
  // one rude bridge user can't saturate the per-session FIFO. Only bites when a
  // sub-actor is asserted (bridge-mediated); normal clients pass through.
  const subActorLimiter = new SubActorRateLimiter();
  const rawCap = deps.subActorCap ?? Number(process.env.QWEN_RC_SUBACTOR_CAP);
  const subActorCap =
    typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap > 0
      ? rawCap
      : DEFAULT_SUB_ACTOR_CAP;
  const subActorRateLimit = enforceSubActorRateLimit(
    subActorLimiter,
    subActorCap,
    audit,
  );
  // #165: the routes that each cost one model call (recap, btw) are limited
  // per TOKEN as well when no sub-actor is asserted, with the same window and
  // cap, so a view-only guest cannot loop them. Bridged requests keep their
  // per-sub-actor window, shared with every other write route as before.
  const modelCallRateLimit = enforceSubActorRateLimit(
    subActorLimiter,
    subActorCap,
    audit,
    Date.now,
    { perToken: true },
  );
  // Owner-managed per-sub-actor bans (block one chat user without revoking the
  // bridge token). In-memory; ban/lift are audited so they survive in the log.
  const subActorBans = new SubActorBanStore();
  const subActorBan = enforceSubActorBan(subActorBans);
  // One-time bridge invite tokens (operator mints; a bridge redeems to learn the
  // session to bind). In-memory + single-use + TTL, like pairing codes; a restart
  // drops unredeemed invites and the operator re-mints.
  const bridgeInvites = new InviteStore();

  // Single loader instance: holds the per-process collision-warned set so a
  // workspace>user name collision is audited at most once for the lifetime.
  // Workspace root is the raw capabilities().workspaceCwd (NOT resolveChatsDir).
  const commandLoader =
    deps.commandLoader ??
    new CommandLoader(
      async () => {
        try {
          return (await deps.daemon.capabilities()).workspaceCwd;
        } catch {
          return undefined;
        }
      },
      deps.commandsUserDir ?? join(homedir(), '.qwen', 'commands'),
      audit,
    );

  app.get('/rc/health', (_req, res) => res.json({ status: 'ok' }));

  // PUBLIC Android TWA asset-link verification (add-native-mobile-shells).
  // Unauthenticated by design — Android fetches it before the TWA launches.
  // Registered before the bearer middleware; 404 when no TWA is configured.
  if (deps.assetLinks) {
    app.get(
      '/.well-known/assetlinks.json',
      createAssetLinksRoute(deps.assetLinks),
    );
  }

  // The pairing code is the credential and it travels in the body, so this
  // route has to parse before anything can be authenticated.
  app.post(
    '/rc/pair/redeem',
    express.json(),
    createPairRedeemRoute(
      deps.pairing,
      deps.store,
      audit,
      deps.ownUiOrigin
        ? { ownUiOrigin: deps.ownUiOrigin, allowlist: corsAllowlist }
        : undefined,
    ),
  );

  // Loopback hook-event mirror (add-agent-observability). Mounted BEFORE
  // bearerResolve: the ingest token is a dedicated persistent secret, not a
  // TokenStore token (same early-mount reason as /rc/pair/redeem above). Uses
  // the app-local ownerEvents bus + audit so mirrored frames reach GET
  // /rc/events and rejections land in the same audit chain.
  if (deps.hookIngest) {
    app.post(
      '/rc/hooks/ingest',
      jsonForBearer(deps.hookIngest.ingestToken),
      createHookIngestRoute({
        ownerEvents,
        ingestToken: deps.hookIngest.ingestToken,
        audit,
        bucketCapacity: deps.hookIngest.bucketCapacity,
        bucketRefillPerSec: deps.hookIngest.bucketRefillPerSec,
      }),
    );
  }

  // Host attach (#194 slice D): a terminal on this machine starts or
  // re-attaches a conversation the phone can then pick up. Mounted BEFORE
  // bearerResolve for the same reason as the hook ingest route: the
  // host-attach token is a dedicated host-local secret, so a phone's
  // TokenStore token never opens these routes and this token never reaches
  // a phone route. Same `QWEN_RC_TERMINAL_QWEN` argv as /rc/terminals, so
  // both hand out one command shape.
  if (deps.hostAttach) {
    const hostAttach = createHostAttachRoutes({
      daemon: deps.daemon,
      token: deps.hostAttach.token,
      audit,
      planOpts: { qwenArgv: deps.terminalQwenArgv },
      attachedWorkspaces: deps.hostAttachedWorkspaces,
    });
    const hostAttachJson = jsonForBearer(deps.hostAttach.token);
    app.post('/rc/host/attach', hostAttachJson, hostAttach.create);
    app.post('/rc/host/attach/:sessionId', hostAttachJson, hostAttach.attach);
  }

  const webRoot =
    deps.webRoot ?? fileURLToPath(new URL('../public', import.meta.url));

  // Guest share landing page. Served for BOTH /ui/share/<token> (first visit)
  // and /ui/share (after the page scrubs the token from the URL, so a reload
  // still resolves the page; the page then reads the token from sessionStorage).
  // Registered BEFORE the fallthrough:false static mount (which would otherwise
  // 404 these paths). It is a DUMB sendFile: the `:token` is never read/logged/
  // validated server-side — GET /rc/share/whoami is the sole auth gate. The
  // error callback is required (no global error middleware → a sendFile error
  // must not hang/throw the request).
  const sharePage = join(webRoot, 'share.html');
  const serveSharePage: express.RequestHandler = (_req, res) => {
    res.sendFile(sharePage, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  };
  app.get('/ui/share', serveSharePage);
  app.get('/ui/share/:token', serveSharePage);

  // Multi-workspace daemon registry (add-multi-workspace-client). Lives in the
  // unauthenticated /ui/ namespace but is OWNER-only, so it carries route-level
  // bearerResolve + requireScope(OWNER) and is registered BEFORE the static /ui
  // mount (the global bearer middleware runs after that mount). The handler reads
  // ~/.qwen/rc/clients.toml; the body (urls/tokenStorageKeys) is never logged.
  if (deps.clientsManifestReadToml) {
    app.get(
      '/ui/clients-manifest.json',
      bearerResolve(deps.store, audit, unauthAudit),
      requireScope(OWNER, audit),
      createClientsManifestRoute({
        readToml: deps.clientsManifestReadToml,
        now: () => Date.now(),
      }),
    );
  }

  app.use('/ui', express.static(webRoot, { fallthrough: false }));

  app.use(bearerResolve(deps.store, audit, unauthAudit));
  // The JSON parser, only now that the caller is authenticated (#163). It is
  // wrapped rather than mounted bare: an attachment upload carries the file
  // itself as the request body with the file's own media type, and a parser
  // that claimed that body would drain the stream before the route's raw
  // parser could read it. See routes/sessionAttachments.ts.
  app.use(gateJsonBody(express.json()));
  // Reject a non-bridge authenticated token that sends X-RC-SubActor (would
  // otherwise silently pollute attribution). Must follow bearerResolve.
  app.use(enforceSubActorScope());
  // Resolve an asserted sub-actor (bridge "acting for @human") onto rcClient —
  // only honored for bridge-scope tokens. Must follow bearerResolve.
  app.use(resolveSubActor());
  // Protocol version gate: if the client sends X-RC-Version and it does not
  // match RC_PROTOCOL_VERSION, respond 426 before any route handler runs.
  // Absent header → pass through (backward-compatible clients that don't
  // negotiate the version header).
  app.use(versionCheckMiddleware);
  // APNs registration for the iOS native shell (add-native-mobile-shells).
  // Gated at SESSION_READ to mirror the webpush router's floor (a notification
  // channel carries session-read-class payload data, so a zero-scope or guest
  // SHARE token must not mint one); delete is own-or-owner within that.
  // Mounted only when an APNs store is wired.
  if (deps.apnsStore) {
    app.use(
      '/rc/native-push/apns',
      requireScope(SESSION_READ, audit),
      createNativePushRouter(deps.apnsStore, audit),
    );
  }
  // Transparent-proxy topology: the gateway claims the BARE /session/:id/*
  // namespace so a remote client's URL is the same whether it talks to the
  // daemon directly or goes through the gateway.
  app.get(
    '/session/:id/events',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionEventsRoute(
      deps.daemon,
      registry,
      audit,
      deps.usageBroadcaster,
      // deps.walDir selects the shape: unset, one daemon subscription per
      // connection with raw passthrough (the `--no-wal` escape hatch); set,
      // one shared WAL-backed subscription per session (#174).
      deps.walDir,
      promptEventBroadcaster,
      watchPresence,
    ),
  );
  // GET /session/:id/context — read-scope; relays the daemon's per-session
  // context status (current model + context-window limit, approval mode, cwd)
  // for the web UI's status footer. Bare namespace, 1:1 with the daemon route.
  app.get(
    '/session/:id/context',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionContextRoute(deps.daemon),
  );
  // GET /session/:id/context-usage — read-scope; relays the daemon's
  // per-session context USAGE (how full the window is), which is a different
  // fact from the configured state /context reports and shares no fields with
  // it. Bare namespace, 1:1 with the daemon route.
  app.get(
    '/session/:id/context-usage',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionContextUsageRoute(deps.daemon),
  );
  // GET /session/:id/export — read-scope; hands the caller a copy of the whole
  // conversation, which the remote otherwise has no way to do (the daemon token
  // rides in a header, so no browser can follow a link to the daemon's own file
  // route). JSON rather than bytes for the same reason. Bare namespace, 1:1
  // with the daemon route.
  app.get(
    '/session/:id/export',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionExportRoute(deps.daemon, audit),
  );
  // GET /session/:id/transcript — read-scope, sitting beside /export. The
  // viewer's transcript is whatever the live stream has handed it since the
  // page opened; this is the daemon's STORED page, paged and readable from the
  // first record. Query parameters are relayed untouched because the daemon
  // owns which anchor combinations are legal. Bare namespace, 1:1 with the
  // daemon route.
  app.get(
    '/session/:id/transcript',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionTranscriptRoute(deps.daemon, audit),
  );
  // GET /session/:id/turn-index — read-scope, sitting beside /transcript. The
  // transcript page hands back records; this hands back the list those records
  // are indexed by, which is what a jump somewhere in a long conversation needs.
  // Query parameters are relayed untouched because the daemon owns which paging
  // combinations are legal (`start` is an offset into a snapshot). Bare
  // namespace, 1:1 with the daemon route.
  app.get(
    '/session/:id/turn-index',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionTurnIndexRoute(deps.daemon, audit),
  );
  // POST /session/:id/recap — asks the daemon for its one-sentence
  // 'where did I leave off' summary of one conversation. It is a POST
  // because it costs a model call, and it sits at SESSION_READ because it
  // reveals nothing the transcript route above does not. The per-actor cap
  // stays: being a read is about what it reveals, the cap is about what it
  // spends. `enforceSessionLock` guards it like every other session route,
  // so a share token cannot ask for a conversation it is not confined to.
  // No gateway timeout: the SDK wrapper skips `fetchTimeoutMs` for this
  // call and the bridge waits on a longer backstop, so a shorter cut here
  // would only turn a slow recap into a failed one. Bare namespace, 1:1
  // with the daemon route.
  app.post(
    '/session/:id/recap',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    modelCallRateLimit, // a recap costs a model call: per sub-actor, else per token
    createSessionRecapRoute(deps.daemon, audit),
  );
  // POST /session/:id/btw - ask one conversation a side question without
  // putting the question or the answer into it. WRITE, unlike the recap above
  // it sits beside: a recap only reduces what the transcript read already
  // reveals, while a side answer is content no read of this conversation
  // returns, so under the #107 rule it is the same kind of act as a prompt.
  // The cap stays because the daemon bounds the question's length and nothing
  // bounds how many may be asked. The route propagates this client's
  // disconnect to the daemon, which is the one place the gateway deliberately
  // does the opposite of the prompt route; see routes/sessionBtw.ts. Bare
  // namespace, 1:1 with the daemon route.
  app.post(
    '/session/:id/btw',
    requireScope(WRITE, audit),
    enforceSessionLock(audit),
    subActorBan, // banned chat user, refused before any budget is spent
    modelCallRateLimit, // a side question costs a model call: per sub-actor, else per token
    createSessionBtwRoute(deps.daemon, audit),
  );
  // GET /session/:id/supported-commands — read-scope; relays the daemon's
  // per-session slash command list so the Commands panel can list what the
  // watched session supports alongside the gateway's own file commands.
  // Bare namespace, 1:1 with the daemon route.
  app.get(
    '/session/:id/supported-commands',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSupportedCommandsRoute(deps.daemon),
  );
  // GET /session/:id/status — read-scope; relays the daemon's per-session
  // status summary (including pendingInteractions) so the web UI can
  // reconstruct question/permission cards a dropped event stream lost.
  // Bare namespace, 1:1 with the daemon route.
  app.get(
    '/session/:id/status',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionStatusRoute(deps.daemon),
  );
  // GET /session/:id/tasks — read-scope; the run log (agent, shell, monitor and
  // workflow tasks). 1:1 with the daemon's own route, and not audited, because a
  // task read is a poll like the status and context reads beside it.
  app.get(
    '/session/:id/tasks',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionTasksRoute(deps.daemon),
  );
  // GET /session/:id/stats — read-scope; the daemon's roll-up of one
  // conversation (duration, prompt count, per-model tokens, tool calls, lines
  // written). 1:1 with the daemon's own route. Not audited: the payload is
  // counts, and the un-audited /tasks read beside it relays shell paths, which
  // is strictly more disclosing. This is NOT /rc/usage, which reads the
  // gateway's own cost store and is absent entirely when no store is wired.
  app.get(
    '/session/:id/stats',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionStatsRoute(deps.daemon),
  );
  // GET /session/:id/resources — read-scope; what one live conversation has
  // loaded, its skills and its MCP servers, as the daemon sanitises them for a
  // reader. 1:1 with the daemon's own route. Not audited: it carries
  // configuration names, which is what the un-audited /supported-commands and
  // /stats reads beside it already relay. This is the SESSION's own set rather
  // than the workspace pool, and the page says so, because the daemon builds it
  // from that session's Config and the name-keyed authentication fields are
  // absent on this route by design, so a reader must draw no auth verdict from
  // their absence.
  app.get(
    '/session/:id/resources',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionResourcesRoute(deps.daemon),
  );
  // POST /session/:id/end — write-scope; tells the daemon to terminate the
  // session. On success the daemon emits `session_died` on the event stream.
  app.post(
    '/session/:id/end',
    requireScope(WRITE, audit),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (a stop request is never rate-limited)
    createSessionEndRoute(deps.daemon, audit),
  );
  // POST /session/:id/cancel — write-scope; aborts the session's in-flight
  // turn without ending the session. Same guard set as /end (including the
  // no-rate-limit rationale: a stop request is never rate-limited) because a
  // cancel is strictly less destructive than an end.
  app.post(
    '/session/:id/cancel',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (a stop request is never rate-limited)
    createSessionCancelRoute(deps.daemon, audit),
  );
  // GET /session/:id/subagents/:subagentRef — read-scope; one subagent's own
  // run state. The read half of the pair whose write half is /cancel below, and
  // the reason the viewer's nested subagent block can stop being display only.
  // Same guard set as the other session reads.
  app.get(
    '/session/:id/subagents/:subagentRef',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSubagentInspectRoute(deps.daemon),
  );
  // POST /session/:id/subagents/:subagentRef/cancel — write-scope; stops ONE
  // running subagent while the parent turn survives. Same guard set as
  // /session/:id/cancel (and the same no-rate-limit rationale: a stop request
  // is never rate-limited), because cancelling one child is strictly less
  // destructive than cancelling the turn that spawned it.
  app.post(
    '/session/:id/subagents/:subagentRef/cancel',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (a stop request is never rate-limited)
    createSubagentCancelRoute(deps.daemon, audit),
  );
  // POST /session/:id/tasks/:taskId/cancel — write-scope; stops ONE run (an
  // agent, shell, monitor or workflow task) and leaves the session and every
  // other run alive. Same guard set and the same no-rate-limit rationale as the
  // two cancels above it, because stopping one run is strictly less destructive
  // than stopping the turn that spawned it. This is the act half of the run log:
  // D22 put the task list on the wire, D24 drew it, and the row a reader sees is
  // now the row they can stop.
  app.post(
    '/session/:id/tasks/:taskId/cancel',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (a stop request is never rate-limited)
    createSessionTaskCancelRoute(deps.daemon, audit),
  );
  // PATCH /session/:id/metadata: write-scope, gives ONE loaded session a human
  // title. Same guard set as the run cancel above it: naming a session is a
  // mutation, and a token scoped to another session has no business titling it.
  // No sub-actor rate limiter, because a title is typed by a person once, not
  // repeated by a loop, and the route's own 200-character ceiling bounds what
  // one call can carry.
  app.patch(
    '/session/:id/metadata',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403
    createSessionRenameRoute(deps.daemon, audit),
  );
  app.post(
    '/session/:id/permission/:requestId',
    requireScope(APPROVE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap votes per chat user
    createPermissionVoteRoute(deps.daemon, audit),
  );
  app.post(
    '/session/:id/prompt',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap prompts per chat user
    createPromptRoute(deps.daemon, audit, deps.onPromptAccepted, {
      queueWaitMs: deps.queueWaitMs,
      promptTimeoutMs: deps.promptTimeoutMs,
      promptEventBroadcaster,
      queue: promptQueue,
      // Turn-end push (#40): fire the notifier after the turn's terminal
      // outcome (success / timeout / daemon error). `notifier` is a `let`
      // initialised in the push block below — safe here because the closure
      // runs at request time, never at mount time.
      onTurnEnd: (sessionId, outcome) => {
        void notifier?.notify(
          {
            type: outcome.ok ? 'prompt_completed' : 'prompt_failed',
            data: outcome.ok ? {} : { reason: outcome.reason },
          },
          { sessionId },
        );
      },
    }),
  );
  // POST /session/:id/attachments?name=<file name> — write-scope; pushes one
  // file into the session as the raw request body. Same guard set as /prompt
  // (an upload is a user-initiated write into a conversation, and a phone is
  // the natural place to send a photo or a log), including the rate limiter:
  // unlike a stop request, an upload costs disk and bandwidth, so bridge
  // fan-in needs a per-chat-user cap. `createRawAttachmentBody` reads the file and
  // refuses an oversize body with 413 before it is buffered.
  app.post(
    '/session/:id/attachments',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user -> 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap uploads per chat user
    createRawAttachmentBody(attachmentLimit),
    createAttachmentUploadRoute(deps.daemon, audit),
  );
  // #130: the resumable form of the upload above, for a phone whose connection
  // drops mid-file. Every verb is WRITE like the single POST, with the same
  // guard set; the rate limiter sits on the begin only, because a photo is
  // many chunk requests and a per-chat-user cap on those would throttle one
  // upload against itself. The size limit is the one the single POST enforces,
  // applied when the upload begins.
  const resumableUploads = createResumableAttachmentUploads({
    daemon: deps.daemon,
    limit: attachmentLimit,
    audit,
  });
  app.post(
    '/session/:id/attachment-uploads',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan,
    subActorRateLimit,
    resumableUploads.begin,
  );
  app.put(
    '/session/:id/attachment-uploads/:uploadId/chunks/:index',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan,
    resumableUploads.chunkBody,
    resumableUploads.chunk,
  );
  app.get(
    '/session/:id/attachment-uploads/:uploadId',
    requireScope(WRITE, audit),
    enforceSessionLock(audit),
    resumableUploads.status,
  );
  app.post(
    '/session/:id/attachment-uploads/:uploadId/complete',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan,
    resumableUploads.complete,
  );
  app.delete(
    '/session/:id/attachment-uploads/:uploadId',
    requireScope(WRITE, audit),
    enforceSessionLock(audit),
    resumableUploads.cancel,
  );
  // GET /session/:id/attachments — session-read-scope, mirroring /export: the
  // names and metadata the daemon returns are part of the conversation, and
  // the route reveals nothing the transcript does not already hold.
  app.get(
    '/session/:id/attachments',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createAttachmentListRoute(deps.daemon),
  );
  // GET /session/:id/attachments/:attachmentId — write-scope. The list above
  // sits at session-read because it names files the transcript already
  // implies; this one returns their contents, and #107 settled that host file
  // contents sit at WRITE. No rate limiter, unlike the upload: a read costs
  // the daemon nothing, and the cap above exists because an upload costs disk.
  app.get(
    '/session/:id/attachments/:attachmentId',
    requireScope(WRITE, audit),
    enforceSessionLock(audit),
    createAttachmentReadRoute(deps.daemon),
  );
  // DELETE /session/:id/attachments/:attachmentId — write-scope, carrying the
  // upload's guard set. The rate limiter that a stop request is exempt from
  // applies here: removing a file is never the emergency action, so throttling
  // it cannot harm the person it is applied to.
  app.delete(
    '/session/:id/attachments/:attachmentId',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user -> 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap deletions per chat user
    createAttachmentRemoveRoute(deps.daemon, audit),
  );
  // GET /session/:id/artifacts - what the session PRODUCED, which is a
  // different fact from the uploads above (what someone sent in). Session-read
  // like the attachment list: the names are ones the transcript already
  // implies. Not audited, matching that sibling. The mutation pair the issue
  // counts is NOT mounted here - see routes/sessionArtifacts.ts for the 403
  // client_id_required that makes it a different slice.
  app.get(
    '/session/:id/artifacts',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createSessionArtifactListRoute(deps.daemon),
  );
  // GET /session/:id/artifacts/:artifactId/content - one saved snapshot back
  // out. WRITE, not session-read, for the same reason the attachment content
  // read above is: this returns the file's contents, and #107 settled that
  // host file contents sit at WRITE. The response carries the daemon's four
  // headers restated, because they are what stop a saved webpage rendering as
  // a document on an origin that holds the operator's token.
  app.get(
    '/session/:id/artifacts/:artifactId/content',
    requireScope(WRITE, audit),
    enforceSessionLock(audit),
    createSessionArtifactContentRoute(deps.daemon),
  );
  // GET /session/:id/pending-prompts — session-read-scope, mirroring /export.
  // The queue is part of the conversation's own state, and seeing it is the
  // point: issue #84 accepts a prompt mid-turn with 202 and then discards it,
  // so a queue nobody can look at cannot be told apart from a lost message.
  app.get(
    '/session/:id/pending-prompts',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createPendingPromptsRoute(deps.daemon),
  );
  // DELETE /session/:id/pending-prompts/:promptId — write-scope. Same guard set
  // as /session/:id/cancel and for the same reason: dropping a queued prompt is
  // a stop request, and a stop request is never rate-limited.
  app.delete(
    '/session/:id/pending-prompts/:promptId',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user -> 403 (a stop request is never rate-limited)
    createPendingPromptRemoveRoute(deps.daemon, audit),
  );
  // GET /session/:id/mid-turn-messages — session-read-scope. The daemon's
  // reconciliation snapshot, so a client can see what is still waiting instead
  // of re-sending it at the idle boundary.
  app.get(
    '/session/:id/mid-turn-messages',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createMidTurnMessagesRoute(deps.daemon),
  );
  // DELETE /session/:id/mid-turn-messages/:messageId — write-scope; withdraws a
  // typed message before the daemon delivers it. Same guard set as the pending
  // prompt removal above.
  app.delete(
    '/session/:id/mid-turn-messages/:messageId',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user -> 403 (a stop request is never rate-limited)
    createMidTurnMessageRemoveRoute(deps.daemon, audit),
  );
  // POST /session/:id/mid-turn-message — write-scope, and the same guard set as
  // `POST /session/:id/prompt` above, because this is the same kind of act: chat
  // content with a body, arriving from a device. It carries `subActorRateLimit`
  // for the same reason the prompt route does (bridge fan-in). #110: this is the
  // write half of a queue that has been readable since the four routes above, and
  // without it the panel's own promise that a held message can only be withdrawn
  // is a description of a gateway limitation, not of the daemon.
  app.post(
    '/session/:id/mid-turn-message',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user -> 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap mid-turn pushes per chat user
    createMidTurnMessageEnqueueRoute(deps.daemon, audit),
  );
  // POST /session/:id/mid-turn-messages/send-now — write-scope, deliberately NOT
  // rate-limited: it adds no content and cannot grow the queue, so throttling it
  // would punish the operator for reacting to a problem they are closing. Same
  // posture as the withdraw and cancel routes.
  app.post(
    '/session/:id/mid-turn-messages/send-now',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user -> 403 (a control act is never rate-limited)
    createMidTurnMessagesSendNowRoute(deps.daemon, audit),
  );
  // POST /session — create (or attach to) a session so a freshly-paired client
  // (the web UI's "New conversation" button) has one to watch and prompt.
  // Write-scoped; bare namespace, mirroring the daemon's own POST /session.
  app.post(
    '/session',
    requireScope(WRITE, audit),
    subActorBan, // banned chat user → 403 (before touching the daemon)
    createSessionCreateRoute(deps.daemon, audit),
  );
  // POST /rc/terminals — open a terminal on the gateway's own host showing one
  // conversation (issue #49). Write-scoped like /session. Mounted whenever a
  // request log is wired; when the attached `daemon` cannot resolve a session
  // endpoint the route answers 501 rather than the gateway silently lacking it.
  if (deps.terminalRequests) {
    app.post(
      '/rc/terminals',
      requireScope(WRITE, audit),
      subActorBan,
      createTerminalOpenRoute(deps.daemon, deps.terminalRequests, audit, {
        qwenArgv: deps.terminalQwenArgv,
        rcArgv: deps.terminalRcArgv,
      }),
    );
  }
  // POST /session/:id/resume — reactivate a past (ended) conversation on its
  // workspace's daemon so a phone can pick it back up (add-resume-conversations).
  // Write-scoped; bare namespace. enforceSessionLock binds a session-locked
  // caller's token to its one session id (parity with every other
  // /session/:id/* route); a no-op for the unlocked tokens that normally reach
  // this route.
  app.post(
    '/session/:id/resume',
    requireScope(WRITE, audit),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before touching the daemon)
    // With a WAL wired the page's next watch is read in the gateway's
    // numbering, so the response's watermark is mapped into it (#174).
    createSessionResumeRoute(
      deps.walDir !== undefined
        ? withGatewayResumeCursor(deps.daemon, deps.walDir)
        : deps.daemon,
      audit,
    ),
  );
  // POST /session/:id/worktree-reset - hand a conversation that was working in
  // a temporary checkout over to the replacement checkout it now belongs on
  // (add-worktree-handover). WRITE: the daemon may run cleanup commands, and
  // the conversation comes back under a different id. Bare namespace, 1:1 with
  // the daemon route. Unlike the resume above, no cwd is accepted from the
  // caller - the replacement inherits the workspace its owning daemon started
  // with, and a caller-named one could aim a transfer at a daemon that does not
  // own the checkout. See routes/sessionWorktreeReset.ts.
  // Two things here are load-bearing and neither is visible in the response:
  // the route RELEASES the owner-style registration the daemon mints for the
  // replacement instead of adopting it (the channels SessionRouter adopts
  // because it is a long-lived owner; this gateway's next contact is the page's
  // own watch registering its own id, so adopting would leave a second
  // registration that nothing ever releases), and the pool rebinds the
  // replacement id to the original's workspace key - without that the
  // successor is unaddressable through the pool and the release call fails
  // before it ever reaches the daemon, which is the leak this exists to close.
  app.post(
    '/session/:id/worktree-reset',
    requireScope(WRITE, audit),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before touching the daemon)
    createSessionWorktreeResetRoute(deps.daemon, audit),
  );
  // GET /rc/fs — folder browser so the phone can pick which directory a new
  // conversation (POST /session above) runs in. Write-scoped, owner/control-
  // plane route; lists subdirectories only.
  app.get('/rc/fs', requireScope(WRITE, audit), createFsBrowseRoute());
  // GET /rc/usage (add-cost-tracking) — any authenticated token; the route applies
  // owner-sees-all / lesser-sees-own scope filtering internally. Mounted only when
  // a usage store is wired (native sqlite present + cost tracking enabled).
  if (deps.usageReader) {
    app.get(
      '/rc/usage',
      createUsageRoute({
        store: deps.usageReader,
        now: () => Date.now(),
        labelFor: deps.usageLabelFor,
      }),
    );
  }
  // GET /rc/capabilities — always mounted (mDNS reports here even when cost
  // tracking is off). costTracking sub-block is present only when a usage store
  // is wired, so it never claims enabled:true while disabled.
  // GET /capabilities — bare-namespace alias for the transparent-proxy topology
  // so a remote client can discover the gateway's remoteControl capabilities at
  // the same path regardless of whether it speaks directly to the daemon or to
  // the gateway (which merges the daemon's own capabilities with remoteControl).
  {
    const capabilityRoute = createCapabilityRoute({
      costTracking: deps.usageReader
        ? { currencyLabel: deps.costCurrencyLabel ?? (() => 'USD') }
        : undefined,
      mdnsStatus: deps.mdnsStatus,
      nativeShells: deps.nativeShellsCapability,
      hostAttach: deps.hostAttach !== undefined,
      maxAttachmentBytes: attachmentLimit,
      daemonQwenBin: deps.daemonQwenBin,
      daemonQwenBinHealthy: deps.daemonQwenBinHealthy,
      // #96: the daemon's own flag list, read per request. The gateway block
      // above stays whatever the gateway itself promises; this is the daemon's
      // answer, so the UI can finally tell the two apart.
      daemonStatus: () => deps.daemon.capabilities(),
    });
    app.get('/rc/capabilities', capabilityRoute);
    app.get('/capabilities', capabilityRoute);
  }
  app.post(
    '/session/:id/fork',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap forks per chat user
    createForkRoute(
      deps.daemon,
      async () => {
        try {
          return (await deps.daemon.capabilities()).workspaceCwd;
        } catch {
          return undefined;
        }
      },
      // The WAL markers only; the fork route's owner-bus publish stays unwired
      // here as before.
      { audit, walDir: deps.walDir },
    ),
  );
  // Per-session idle-suggestion toggle (`add-idle-suggestions` spec). WRITE scope
  // + session-lock so a confined share token can only toggle its own session.
  // No recordActivity: setting a preference is not "working on" the session, and
  // marking the device working here would wrongly suppress a real permission push.
  const idleStatusResolver = deps.idleStatus ?? (() => undefined);
  app.post(
    '/session/:id/idle-suggest-toggle',
    requireScope(WRITE, audit),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (a preference toggle, not rate-limited)
    createIdleToggleRoute(idleToggles, idleStatusResolver, audit),
  );
  // GET the same path reports EFFECTIVE idle state (`/suggest status`). SESSION_READ
  // (a read) + session-lock so a confined share token sees only its own session.
  app.get(
    '/session/:id/idle-suggest-toggle',
    requireScope(SESSION_READ, audit),
    enforceSessionLock(audit),
    createIdleStatusRoute(idleToggles, idleStatusResolver),
  );
  // Bridge registry (add-bridge-protocol). Register/heartbeat is BRIDGE-scope;
  // listing is owner-only; deregister is owner-or-self (authz inside the handler,
  // so the mount only needs an authenticated token).
  app.post(
    '/rc/bridges',
    requireScope(BRIDGE, audit),
    createRegisterBridgeRoute(bridgeRegistry, audit),
  );
  app.get(
    '/rc/bridges',
    requireScope(OWNER, audit),
    createListBridgesRoute(bridgeRegistry),
  );
  app.delete(
    '/rc/bridges/:id',
    requireScope(SESSION_READ, audit),
    createDeregisterBridgeRoute(bridgeRegistry, audit),
  );
  // Bridge liveness heartbeat (owner-or-self authz inside the handler).
  app.post(
    '/rc/bridges/:id/heartbeat',
    requireScope(SESSION_READ, audit),
    createHeartbeatRoute(bridgeRegistry, audit),
  );
  // Bridge invites: the operator mints a one-time invite (OWNER) so a bridge can
  // redeem it (BRIDGE) to learn which session to bind — a chat user never names a
  // session id directly. `/rc/bridges/invites` is a distinct 3-segment path (no
  // collision with the `:id` routes above), and redeem's `:id` is audit context.
  app.post(
    '/rc/bridges/invites',
    requireScope(OWNER, audit),
    createMintInviteRoute(bridgeInvites, audit),
  );
  app.post(
    '/rc/bridges/:id/invite/redeem',
    requireScope(BRIDGE, audit),
    createRedeemInviteRoute(bridgeInvites, audit),
  );
  // Sub-actor bans (owner-only): ban/lift one chat user; list current bans.
  app.get(
    '/rc/bridges/bans',
    requireScope(OWNER, audit),
    createListBansRoute(subActorBans),
  );
  app.post(
    '/rc/bridges/:id/ban',
    requireScope(OWNER, audit),
    createBanSubActorRoute(subActorBans, audit),
  );
  app.delete(
    '/rc/bridges/:id/ban/:subActor',
    requireScope(OWNER, audit),
    createLiftBanRoute(subActorBans, audit),
  );
  // Read-only fork lineage chain. OWNER-scoped (NOT session-locked): the chain
  // enumerates ancestor session ids, which a confined share token must not see.
  app.get(
    '/session/:id/lineage',
    requireScope(OWNER, audit),
    createLineageRoute(async () => {
      try {
        return (await deps.daemon.capabilities()).workspaceCwd;
      } catch {
        return undefined;
      }
    }, audit),
  );
  // Flat workspace-wide session list with fork lineage (parentSessionId +
  // derived forks[]). OWNER-scoped like lineage. Scans the on-disk chats dir
  // (NOT the daemon's active-only listWorkspaceSessions) so dormant parents
  // appear in the tree. Honors `?cwd` so a phone can list ANY workspace's
  // history (not just the boot workspace); absent falls back to the trusted
  // boot `workspaceCwd`. `?cwd` is `path.resolve`d (so `/proj` and `/proj/`
  // hit the same chats dir) but is otherwise untrusted — safe because
  // `resolveChatsDir` only ever uses it as a `sanitizeCwd` project-id segment,
  // never joins it as a literal path.
  app.get(
    '/rc/sessions',
    requireScope(OWNER, audit),
    createSessionListRoute(
      async (req) => {
        const q = req.query.cwd;
        if (typeof q === 'string' && q.length > 0) {
          return resolve(q);
        }
        try {
          return (await deps.daemon.capabilities()).workspaceCwd;
        } catch {
          return undefined;
        }
      },
      audit,
      // rc-remote-discoverability (#82): a transcript is stored under the
      // workspace it was RUN in, so listing the boot workspace alone hides every
      // conversation started anywhere else, which is exactly what breaks
      // picking up a phone conversation on the laptop. Union the workspaces this
      // gateway has actually handed a terminal to: bounded, and durable across
      // the pool's idle reaping, which reading the live pool would not be. An
      // explicit `?cwd` stays confined to that one workspace, since that is what
      // the per-workspace views ask for.
      // #194 slice D: the host-attach record joins the request log here, so a
      // conversation started by `qwen-rc attach` in a folder no phone has
      // opened is listed too. Merged newest first under one cap; the request
      // log itself is never written for this, since the launcher would open a
      // tab for the line.
      async (req) => {
        const q = req.query.cwd;
        if (typeof q === 'string' && q.length > 0) return [];
        const [fromTerminals, fromAttach] = await Promise.all([
          deps.terminalRequests?.recentWorkspaceEntries(
            RECENT_WORKSPACES_CAP,
          ) ?? [],
          deps.hostAttachedWorkspaces?.read() ?? [],
        ]);
        return mergeRecentWorkspaces(
          [fromTerminals, fromAttach],
          RECENT_WORKSPACES_CAP,
        );
      },
    ),
  );
  // GET /rc/sessions/live-state — the workspace's live attachment snapshot
  // (add-capability-parity #111). OWNER-scoped like the listing it decorates:
  // the payload names every live session in a workspace, which is the same
  // class of information as the transcript listing above, so it cannot sit at a
  // looser scope than that listing without granting something new. No
  // `recordActivity`: the rail polls this, and marking the device working on
  // every poll would keep a phone that is only watching looking active. No
  // audit row either, matching the sibling reads in #107 and #109. #190:
  // `spawn=0` reads only a daemon the pool already holds, for the list's
  // other folders; it is the same route under the same scope, because it
  // names the same sessions.
  app.get(
    '/rc/sessions/live-state',
    requireScope(OWNER, audit),
    createSessionLiveStateRoute(deps.daemon),
  );

  // GET /workspace/:cwd/sessions — bare-namespace proxy for the transparent-proxy
  // topology. The daemon exposes this path; the gateway re-exposes it (OWNER-gated)
  // so remote clients can enumerate sessions at the same URL shape they would use
  // against the daemon directly. `:cwd` is honored the same way as `/rc/sessions`'s
  // `?cwd` (`path.resolve`d), falling back to the boot workspace. Express
  // already URL-decodes route params, so no manual `decodeURIComponent` here
  // (doing so would throw `URIError` on a literal `%` in the path segment).
  app.get(
    '/workspace/:cwd/sessions',
    requireScope(OWNER, audit),
    createSessionListRoute(async (req) => {
      const p = req.params.cwd;
      if (typeof p === 'string' && p.length > 0) {
        return resolve(p);
      }
      try {
        return (await deps.daemon.capabilities()).workspaceCwd;
      } catch {
        return undefined;
      }
    }, audit),
  );
  // The "sessions at rest" actions (add-capability-parity #111): batch archive /
  // unarchive / delete over stored transcripts. OWNER-scoped like the listing
  // they act on — these reach every transcript in a workspace, not one session,
  // so they carry the same posture as `/rc/sessions` rather than a session's
  // WRITE. Delete is irreversible and the route refuses it without
  // `confirm: true`; that guard lives server-side, so it holds for clients that
  // never draw a dialog.
  app.post(
    '/rc/sessions/archive',
    requireScope(OWNER, audit),
    recordActivity(workingDevice),
    createSessionRestRoute(deps.daemon, 'archive', audit),
  );
  app.post(
    '/rc/sessions/unarchive',
    requireScope(OWNER, audit),
    recordActivity(workingDevice),
    createSessionRestRoute(deps.daemon, 'unarchive', audit),
  );
  app.post(
    '/rc/sessions/delete',
    requireScope(OWNER, audit),
    recordActivity(workingDevice),
    createSessionRestRoute(deps.daemon, 'delete', audit),
  );
  app.post(
    '/session/:id/command/:name',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap command invocations per chat user
    createInvokeCommandRoute(
      deps.daemon,
      commandLoader,
      audit,
      deps.promptTimeoutMs,
    ),
  );
  // POST /session/:id/supported-commands/:name — write-scope; runs one of the
  // watched session's own slash commands by posting `/name args` as that
  // session's prompt text. The name is checked against the daemon's advertised
  // list first, so an unlisted name is refused instead of reaching the model.
  // Own audit action (`session_command_invoked`) and own error shape, which is
  // what a panel invoke needs to be distinguishable from a typed message.
  app.post(
    '/session/:id/supported-commands/:name',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap command invocations per chat user
    createSessionCommandInvokeRoute(deps.daemon, audit, deps.promptTimeoutMs),
  );
  app.get(
    '/rc/commands',
    requireScope(SESSION_READ, audit),
    createListCommandsRoute(commandLoader),
  );
  // CORS allowlist CRUD (owner-only; wire-protocol: "Browser CORS allowlist
  // derived from pairing"). GET lists db+config origins; POST manually admits;
  // DELETE removes db-admitted origins (409 for config-sourced).
  app.get(
    '/rc/cors',
    requireScope(OWNER, audit),
    createListCorsOriginsRoute({
      store: deps.store,
      allowlist: corsAllowlist,
      audit,
      configOrigins: deps.corsConfigOrigins,
    }),
  );
  app.post(
    '/rc/cors',
    requireScope(OWNER, audit),
    createAddCorsOriginRoute({
      store: deps.store,
      allowlist: corsAllowlist,
      audit,
      configOrigins: deps.corsConfigOrigins,
    }),
  );
  app.delete(
    '/rc/cors/:origin',
    requireScope(OWNER, audit),
    createRemoveCorsOriginRoute({
      store: deps.store,
      allowlist: corsAllowlist,
      audit,
      configOrigins: deps.corsConfigOrigins,
    }),
  );
  app.get(
    '/rc/tokens',
    requireScope(OWNER, audit),
    createListTokensRoute(deps.store),
  );
  app.post(
    '/rc/tokens',
    requireScope(OWNER, audit),
    createMintTokenRoute(deps.store, audit),
  );
  // #205: THE revoke cascade. Both revoke routes call this once, after the
  // revoke and the stream eviction, with every newly revoked token id. A new
  // token-bound store joins here and nowhere else. It never throws (the token
  // is already dead; a store error must not turn the revoke into a 500), and a
  // failing store is reflected only as a zero count for it plus a console line.
  // `notifier` is assigned further down; it is read at call time, not here.
  const onTokenRevoked = async (
    tokenIds: string[],
  ): Promise<Map<string, RevokeCascadeCounts>> => {
    const counts = new Map<string, RevokeCascadeCounts>(
      tokenIds.map((id) => [id, { subscriptions: 0, devices: 0 }] as const),
    );
    // Web push subscriptions, plus the in-memory state keyed by them (rate
    // window, coalescer, and the quiet-hours digest entries).
    if (deps.pushStore) {
      try {
        for (const rec of await deps.pushStore.removeByTokens(tokenIds)) {
          notifier?.forgetRateLimit(rec.id);
          const c = counts.get(rec.tokenId);
          if (c) c.subscriptions += 1;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('revoke cascade: web push removal failed', err);
      }
    }
    // APNs devices (add-native-mobile-shells "On token revocation the APNs
    // subscription SHALL be removed").
    if (deps.apnsStore) {
      try {
        for (const rec of await deps.apnsStore.removeByTokens(tokenIds)) {
          const c = counts.get(rec.tokenId);
          if (c) c.devices += 1;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('revoke cascade: APNs removal failed', err);
      }
    }
    return counts;
  };
  app.delete(
    '/rc/tokens/:id',
    requireScope(OWNER, audit),
    createRevokeTokenRoute(deps.store, registry, audit, onTokenRevoked),
  );
  app.post(
    '/rc/tokens/revoke-all',
    requireScope(OWNER, audit),
    createRevokeAllTokensRoute(deps.store, registry, audit, onTokenRevoked),
  );
  app.get(
    '/rc/audit',
    requireScope(OWNER, audit),
    createAuditQueryRoute(audit),
  );
  // Live owner-only stream of audit records (incl. policy_decision / reload
  // frames). OWNER-scoped — it surfaces token/scope/session ids across the
  // whole gateway, never for a session-locked guest.
  app.get(
    '/rc/events',
    requireScope(OWNER, audit),
    createOwnerEventsRoute(ownerEvents),
  );
  // Guest redemption endpoint — SHARE-scoped, mounted BEFORE the owner-gated
  // share router so a share token reaches it (the owner router would 403 it).
  app.get(
    '/rc/share/whoami',
    requireScope(SHARE, audit),
    createShareWhoamiHandler(deps.store, audit),
  );
  app.use(
    '/rc/share',
    requireScope(OWNER, audit),
    createShareRouter(deps.store, registry, audit, onTokenRevoked),
  );
  // BM25 ranked search provider (search slice 2) — opt-in `?rank=bm25`. The
  // native better-sqlite3 is loaded LAZILY via a dynamic import the FIRST time a
  // ranked query arrives (memoized), so the gateway's static graph never pulls
  // it in and a fresh install / failed native build still boots and serves the
  // scanner. Returns null (→ route falls back to the live scan) when the dep is
  // absent, there is no workspace, the index is empty/never-built, or any error
  // occurs — ranked search is strictly best-effort enrichment over the scan.
  let searchIndexMod:
    | typeof import('./search/searchIndex.js')
    | null
    | undefined;
  const rankedSearch: RankedSearch = async (q, qopts) => {
    let workspaceCwd: string | undefined;
    try {
      workspaceCwd = (await deps.daemon.capabilities()).workspaceCwd;
    } catch {
      return null;
    }
    if (!workspaceCwd) return null;
    if (searchIndexMod === undefined) {
      try {
        searchIndexMod = await import('./search/searchIndex.js');
      } catch {
        // Native dep absent / load failed → permanently fall back to the scan.
        searchIndexMod = null;
      }
    }
    if (!searchIndexMod) return null;
    const dbPath = join(resolveSearchIndexDir(workspaceCwd), 'index.db');
    let idx: ReturnType<typeof searchIndexMod.SearchIndex.open> | undefined;
    try {
      idx = searchIndexMod.SearchIndex.open(dbPath);
      // A never-built (empty) index must not silently return zero hits when the
      // scan would find matches — fall back instead.
      if (idx.count() === 0) return null;
      return idx.query(q, qopts);
    } catch {
      return null;
    } finally {
      try {
        idx?.close();
      } catch {
        /* best-effort */
      }
    }
  };

  app.get(
    '/rc/search',
    // SESSION_READ at the mount admits both owners and session-locked share
    // tokens; createSearchRoute does the per-caller authorization in-handler
    // (cycle 76): a share is confined to its locked session, everyone else
    // needs OWNER.
    requireScope(SESSION_READ, audit),
    createSearchRoute(
      async () => {
        try {
          const caps = await deps.daemon.capabilities();
          return caps.workspaceCwd
            ? resolveChatsDir(caps.workspaceCwd)
            : undefined;
        } catch {
          return undefined;
        }
      },
      audit,
      { ranked: rankedSearch },
    ),
  );

  let notifier: PushNotifier | undefined;
  if (deps.vapid && deps.pushStore) {
    // #165: one policy for registration (route) and delivery (sender), so an
    // endpoint the route accepts is one the sender will actually send to.
    const pushEndpointPolicy =
      deps.pushEndpointPolicy ??
      new PushEndpointPolicy({
        allowedHostSuffixes: parsePushHostsEnv(process.env.QWEN_RC_PUSH_HOSTS),
      });
    const sender = new PushSender(deps.vapid, deps.pushStore, audit, {
      endpointPolicy: pushEndpointPolicy,
    });
    // Per-subscription rolling-hour push rate limiter (cycle 46). In-memory:
    // a restart resets the counters (fail-open — never suppress a notification).
    const rateLimiter = new PushRateLimiter();
    // Same-kind coalescing (cycle 63, design D6). DISABLED by default (window 0
    // -> tryPass always true -> no behavior change); an operator opts in via
    // deps.coalesceWindowMs or the QWEN_RC_COALESCE_MS env. Opt-in because it is
    // the one fail-CLOSED gate (it can drop a real second prompt).
    const coalesceWindowMs =
      deps.coalesceWindowMs ?? (Number(process.env.QWEN_RC_COALESCE_MS) || 0);
    const coalescer = new PushCoalescer(coalesceWindowMs);
    // Always-on digest tracker (cycle 71): records what quiet hours suppressed
    // ("while you were away"); record-only, never affects delivery.
    const digest = new PushDigest();
    // APNs second transport (add-native-mobile-shells): built here so it shares
    // the gateway's audit (push_routed{transport:apns}) and the live-token orphan
    // guard. Only when the host supplied delivery materials AND a store exists.
    const apns =
      deps.apns && deps.apnsStore
        ? {
            store: deps.apnsStore,
            sender: new ApnsSender({
              signer: deps.apns.signer,
              transport: deps.apns.transport ?? createHttp2ApnsTransport(),
              store: deps.apnsStore,
              bundleId: deps.apns.bundleId,
              host: deps.apns.host,
              audit,
              isTokenLive: (tokenId) =>
                deps.store.scopesFor(tokenId) !== undefined,
            }),
          }
        : undefined;
    notifier = new PushNotifier(
      deps.store,
      deps.pushStore,
      sender,
      deps.snooze,
      audit,
      workingDevice,
      deps.routing,
      rateLimiter,
      coalescer,
      digest,
      apns,
      // ownerBus intentionally unwired (pre-existing gap, not part of #40):
      // routing_decision SSE emission stays off in production, as before.
      undefined,
      (id) => watchPresence.isWatched(id),
    );
    app.use(
      '/rc/push',
      requireScope(SESSION_READ, audit),
      createPushRouter(deps.vapid, deps.pushStore, notifier, audit, {
        endpointPolicy: pushEndpointPolicy,
      }),
    );
  }

  // GET/PUT /rc/ui-prefs (#80): the caller's OWN display preferences.
  // SESSION_READ rather than WRITE, unlike the WRITE-forked idle toggle: the
  // record is keyed by the caller's own token and cannot change what any other
  // client sees, so a read-only share token is allowed to pick the zone it
  // reads its timestamps in.
  if (deps.uiPrefs) {
    app.use(
      '/rc/ui-prefs',
      requireScope(SESSION_READ, audit),
      createUiPrefsRouter(deps.uiPrefs, audit),
    );
  }

  // POST /session/:id/rewind (add-remote-rewind). OWNER-scoped — a strictly
  // stronger gate than the WRITE-scoped fork route, because a rewind
  // destructively truncates the daemon transcript. Mounted HERE (not beside the
  // fork route) because it injects `notifier`, a `let` initialised in the push
  // block just above; referencing it at the fork mount would hit its temporal
  // dead zone. The shared `promptQueue` (the SAME instance passed to
  // createPromptRoute) makes the route's `queue.acquire(id, 0)` guard reject a
  // rewind while a prompt holds the session's FIFO slot (409 rewind_in_progress).
  app.post(
    '/session/:id/rewind',
    requireScope(OWNER, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    createRewindRoute(
      deps.daemon,
      async () => {
        try {
          return (await deps.daemon.capabilities()).workspaceCwd;
        } catch {
          return undefined;
        }
      },
      {
        audit,
        bus: ownerEvents,
        notifier,
        walDir: deps.walDir,
        queue: promptQueue,
      },
    ),
  );

  // POST /policy/explain (P4) — gateway-global (no :id), OWNER-scoped,
  // read-only dry-run against the live policy. No session lock (not
  // session-scoped) and no daemon call. In production, cli.ts always
  // supplies a static policyExplain bundle, so this route IS mounted; an
  // unloaded/absent policy surfaces at request time as the route's own
  // 503 policy_unavailable. This guard exists for other/test
  // createGatewayApp call sites that omit the dep entirely.
  if (deps.policyExplain) {
    app.post(
      '/policy/explain',
      requireScope(OWNER, audit),
      createPolicyExplainRoute(deps.policyExplain, { audit }),
    );
  }

  // /rc/permission-overlays (issue #33) — gateway-global (no :id),
  // OWNER-scoped, TTL-bound session-scoped permission overrides. Gateway-
  // local in-memory store: no session lock, no daemon call, nothing
  // durable (a restart drops all overlays — the file policy stays the
  // only source of truth). Mirrors the /policy/explain mount just above:
  // absent dep → routes not mounted at all (404, not a 503 at request
  // time).
  if (deps.permissionOverlays) {
    const overlayRoutes = createPermissionOverlayRoutes(
      deps.permissionOverlays,
      { audit },
    );
    app.get(
      '/rc/permission-overlays',
      requireScope(OWNER, audit),
      overlayRoutes.get,
    );
    app.post(
      '/rc/permission-overlays',
      requireScope(OWNER, audit),
      overlayRoutes.post,
    );
    app.delete(
      '/rc/permission-overlays/:id',
      requireScope(OWNER, audit),
      overlayRoutes.remove,
    );
  }

  // GET /rc/peers — gateway-global (no :id), OWNER-scoped, read-only LAN
  // daemon discovery over the optional mDNS browse. No session lock (not
  // session-scoped) and no daemon call — mirrors the /policy/explain mount
  // just above. Absent dep (bonjour-service optional, or no browse wired) →
  // route not mounted at all (404, not a 503 at request time).
  if (deps.browsePeers) {
    app.get(
      '/rc/peers',
      requireScope(OWNER, audit),
      createPeersRoute(deps.browsePeers),
    );
  }

  // GET /rc/gpu — gateway-global (no :id), OWNER-scoped, read-only GPU
  // status via the optional nvidia-smi probe. Mirrors the /rc/peers mount
  // just above: no session lock, no daemon call. Absent dep (no GPU probe
  // wired) → route not mounted at all (404, not a 503 at request time).
  if (deps.gpuProbe) {
    app.get(
      '/rc/gpu',
      requireScope(OWNER, audit),
      createGpuRoute(deps.gpuProbe),
    );
  }

  // GET /rc/llama-swap — gateway-global (no :id), OWNER-scoped, read-only
  // llama-swap status via the optional llama-swap probe. Mirrors the
  // /rc/gpu mount just above: no session lock, no daemon call. Absent dep
  // (no --llama-swap-url wired) → route not mounted at all (404, not a 503
  // at request time).
  if (deps.llamaSwapProbe) {
    app.get(
      '/rc/llama-swap',
      requireScope(OWNER, audit),
      createLlamaSwapRoute(deps.llamaSwapProbe),
    );
  }

  // GET /rc/host/actions and POST /rc/host/actions/:name/start (#192):
  // gateway-global, OWNER-scoped, no session lock and no daemon call, like
  // the /rc/gpu and /rc/llama-swap mounts above. Absent store (no
  // host-actions.json, or one that did not load) -> not mounted at all, so
  // the page reads a 404 and draws no row.
  if (deps.hostActions) {
    const hostActionRoutes = createHostActionRoutes(deps.hostActions, {
      audit,
    });
    app.get(
      '/rc/host/actions',
      requireScope(OWNER, audit),
      hostActionRoutes.list,
    );
    app.post(
      '/rc/host/actions/:name/start',
      requireScope(OWNER, audit),
      hostActionRoutes.start,
    );
  }

  // POST /session/:id/approval-mode — WRITE is the floor (plan/default);
  // the in-handler OWNER gate escalates for power modes (auto-edit/auto/
  // yolo) and a durable `persist: true`. Mirrors the fork/rewind mounts'
  // middleware chain exactly (`recordActivity` then `enforceSessionLock`)
  // so a session-locked share token is confined to its own session — the
  // same integrity guarantee every other session-mutation route provides.
  // A later task (add-remote-approval-mode's approval-mode pump) still
  // owns wiring the `bus`/`notifier` fan-out for the daemon's own
  // `approval_mode_changed` event; that is deliberately NOT this route's
  // job (see routes/approvalMode.ts).
  app.post(
    '/session/:id/approval-mode',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap approval-mode changes per chat user
    createApprovalModeRoute(deps.daemon, { audit }),
  );

  // POST /session/:id/model — WRITE is the mount floor, identical to
  // approval-mode's middleware chain immediately above (same integrity
  // guarantee: a session-locked share token is confined to its own
  // session). No in-handler scope escalation — unlike approval-mode,
  // switching models has no power-tier concept.
  app.post(
    '/session/:id/model',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    enforceSessionLock(audit),
    subActorBan, // banned chat user → 403 (before consuming rate budget)
    subActorRateLimit, // bridge fan-in: cap model switches per chat user
    createModelSwitchRoute(deps.daemon),
  );

  // /rc/workspace/* — workspace-control routes (rc-workspace-permissions).
  // Workspace-scoped (daemon-global, no session id): same middleware chain as
  // the session-mutation routes above MINUS `enforceSessionLock` (there is no
  // session to lock). Scope tiering is at the mount: READS (GET) are the
  // WRITE floor; MUTATIONS are OWNER — `requireScope` already writes the
  // `scope_denied` audit row with the required scope, so the handlers stay
  // scope-agnostic.
  // GET /rc/workspaces — live workspace listing for the UI's target
  // selector (rc-workspace-scoping, #28): the default/boot workspace's cwd
  // (from the daemon's capabilities) plus the non-default cwds the pool
  // currently holds (a pool without a `workspaces()` implementation reads
  // as []). Read-only, no audit row; WRITE floor like the other workspace
  // reads. The default daemon being down is the same failure as any other
  // workspace read → 502 `daemon_unavailable`.
  app.get(
    '/rc/workspaces',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    async (_req, res) => {
      try {
        const defaultCwd = (await deps.daemon.capabilities()).workspaceCwd;
        res.status(200).json({
          default: defaultCwd,
          workspaces: deps.daemon.workspaces?.() ?? [],
        });
      } catch {
        if (!res.headersSent) {
          res
            .status(502)
            .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
        }
      }
    },
  );
  const workspacePermissions = createWorkspacePermissionsRoutes(deps.daemon, {
    audit,
  });
  app.get(
    '/rc/workspace/permissions',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    workspacePermissions.get,
  );
  app.post(
    '/rc/workspace/permissions',
    requireScope(OWNER, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    workspacePermissions.post,
  );
  const workspaceTrust = createWorkspaceTrustRoutes(deps.daemon, { audit });
  app.get(
    '/rc/workspace/trust',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    workspaceTrust.get,
  );
  app.post(
    '/rc/workspace/trust/request',
    requireScope(OWNER, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    workspaceTrust.request,
  );
  app.get(
    '/rc/workspace/settings',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceSettingsRoute(deps.daemon),
  );
  // GET /rc/workspace/env and /rc/workspace/preflight — the two diagnostics
  // reads (rc-workspace-diagnostics, #123). WRITE floor, like every other
  // workspace read here, and for the same reason the daemon gives: these cells
  // are host facts, not names. Its own route comment says so
  // (packages/cli/src/serve/routes/workspace-status.ts:381), naming env's
  // secret-var presence and preflight's workspace path, CLI entry and Node
  // version as reconnaissance. #107 puts host facts on the write side of the
  // line, so a chat-scoped share token that can read a conversation cannot
  // enumerate this machine.
  app.get(
    '/rc/workspace/env',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceEnvRoute(deps.daemon),
  );
  app.get(
    '/rc/workspace/preflight',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspacePreflightRoute(deps.daemon),
  );
  // #123. The three inventory reads: what is installed and configured on this
  // machine. Same WRITE floor as the diagnostics pair, for the same reason and
  // by the same rule (#107: names at the read side, host facts at the write
  // side). Each of these payloads carries host facts rather than names: a skill
  // record carries `installedPath`, a provider model carries `baseUrl` and
  // `envKey` (so this read enumerates the host's model endpoints and which
  // variable feeds each), and a hook entry carries its real shell command,
  // which the daemon masks only for `config.env`/`config.headers` VALUES
  // (packages/cli/src/acp-integration/acpAgent.ts:2549). A device that can read
  // a conversation should not be able to enumerate any of it.
  app.get(
    '/rc/workspace/skills',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceSkillsRoute(deps.daemon),
  );
  app.get(
    '/rc/workspace/providers',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceProvidersRoute(deps.daemon),
  );
  app.get(
    '/rc/workspace/hooks',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceHooksRoute(deps.daemon),
  );
  // Workspace context reads (rc-workspace-context, #123). WRITE floor, same
  // #107 line as the batches above: a memory entry is a host `path` plus a
  // `scope` that can be `global`, and an agent summary carries `filePath`
  // beside the tools and MCP servers each agent may reach. Neither is a name.
  // The memory route also never asks the daemon for file content, because the
  // SDK's includeContent flag is the designed way to read the global context
  // file that the file routes refuse; see routes/workspaceContext.ts.
  app.get(
    '/rc/workspace/memory',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceMemoryRoute(deps.daemon),
  );
  app.get(
    '/rc/workspace/agents',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceAgentsRoute(deps.daemon),
  );
  app.get(
    '/rc/workspace/tools',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceToolsCatalogRoute(deps.daemon),
  );
  app.post(
    '/rc/workspace/tools/:name/enable',
    requireScope(OWNER, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceToolToggleRoute(deps.daemon, { audit }),
  );
  const workspaceMcp = createWorkspaceMcpRoutes(deps.daemon, { audit });
  app.get(
    '/rc/workspace/mcp',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    workspaceMcp.get,
  );
  app.post(
    '/rc/workspace/mcp/reload',
    requireScope(OWNER, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    workspaceMcp.reload,
  );
  app.post(
    '/rc/workspace/mcp/servers',
    requireScope(OWNER, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    workspaceMcp.servers,
  );

  // Workspace file browser (add-capability-parity #107, read-only first
  // slice). WRITE-scoped like GET /rc/fs and the workspace settings/tools
  // reads above: these return file CONTENTS from the host, which is strictly
  // more sensitive than the tools catalog that already sits at WRITE, so they
  // cannot be chat-scope. No audit row, matching those sibling reads: a file
  // read's only identifying field is its path, and paths are deliberately kept
  // out of every audit record, so a row could name neither file nor content.
  app.get(
    '/rc/workspace/list',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceListRoute(deps.daemon),
  );
  app.get(
    '/rc/workspace/glob',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceGlobRoute(deps.daemon),
  );
  app.get(
    '/rc/workspace/file',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceFileRoute(deps.daemon),
  );
  app.get(
    '/rc/workspace/file/bytes',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceFileBytesRoute(deps.daemon),
  );
  // Workspace file writes (#123). WRITE, the floor the reads above already
  // sit on: a token that may read host file contents and prompt an agent that
  // writes files may write them itself, and every share token (session:read
  // plus at most approve) is refused here by requireScope before any body is
  // read. The stat read is WRITE too, not session:read: it answers whether a
  // path exists and how big it is, the same host fact `list` gives, and the
  // browser that uses it is unreachable below WRITE anyway. The three body
  // routes read their own body after the scope check, under the #196 limit
  // (`createWorkspaceFileBody`); the global parser stands aside for them
  // (gateJsonBody). Each write leaves an audit row without its path.
  app.get(
    '/rc/workspace/stat',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceStatRoute(deps.daemon),
  );
  app.post(
    '/rc/workspace/file/write',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    ...createWorkspaceFileBody('json', attachmentLimit),
    createWorkspaceFileWriteRoute(deps.daemon, audit),
  );
  app.post(
    '/rc/workspace/file/edit',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    ...createWorkspaceFileBody('json', attachmentLimit),
    createWorkspaceFileEditRoute(deps.daemon, audit),
  );
  app.post(
    '/rc/workspace/file/upload',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    ...createWorkspaceFileBody('raw', attachmentLimit),
    createWorkspaceFileUploadRoute(deps.daemon, audit),
  );
  app.post(
    '/rc/workspace/file/delete',
    requireScope(WRITE, audit),
    recordActivity(workingDevice),
    subActorBan,
    subActorRateLimit,
    createWorkspaceFileDeleteRoute(deps.daemon, audit),
  );

  if (deps.snooze) {
    app.use(
      '/rc/routing',
      requireScope(OWNER, audit),
      createRoutingRouter(deps.snooze, audit),
    );
  }

  // Agent observability control plane (add-agent-observability).
  let agentLifecycle: AgentLifecycle | undefined;
  if (deps.agents) {
    agentLifecycle = new AgentLifecycle(
      deps.agents.registry,
      ownerEvents,
      promptEventBroadcaster,
      notifier,
      deps.agents.costFor,
    );
    const agentDeps = {
      daemon: deps.daemon,
      registry: deps.agents.registry,
      lifecycle: agentLifecycle,
      audit,
      costFor: deps.agents.costFor,
      promptAcceptWindowMs: deps.agents.promptAcceptWindowMs,
      promptQueue,
    };
    app.post(
      '/rc/agents',
      requireScope(WRITE, audit),
      recordActivity(workingDevice),
      subActorBan, // banned chat user → 403 (before consuming rate budget)
      subActorRateLimit, // bridge fan-in: cap agent spawns per chat user
      createSpawnAgentRoute(agentDeps),
    );
    app.get(
      '/rc/agents',
      requireScope(SESSION_READ, audit),
      createListAgentsRoute(agentDeps),
    );
    app.get(
      '/rc/agents/:id',
      requireScope(SESSION_READ, audit),
      createGetAgentRoute(agentDeps),
    );
    app.post(
      '/rc/agents/:id/message',
      requireScope(WRITE, audit),
      recordActivity(workingDevice),
      subActorBan, // banned chat user → 403 (before consuming rate budget)
      subActorRateLimit, // bridge fan-in: cap agent messages per chat user
      createAgentMessageRoute(agentDeps),
    );
    app.post(
      '/rc/agents/:id/cancel',
      requireScope(WRITE, audit),
      recordActivity(workingDevice),
      subActorBan, // banned chat user → 403 (a stop request is never rate-limited)
      createAgentCancelRoute(agentDeps),
    );
  }

  // Remote review control plane (add-remote-review). The trigger saga
  // (POST /rc/reviews) enforces the owner-scope gate + pre-flight skill guard
  // and wires the per-review permission bridge. WRITE at the mount; the
  // in-handler OWNER gate escalates for privileged flags (comment/autofix/
  // autoApprove). List/detail (SESSION_READ) and cancel (WRITE) mirror the
  // agent observability routes above.
  let reviewLifecycle: ReviewLifecycle | undefined;
  if (deps.review) {
    // Local `const` (not the outer `let reviewLifecycle`): the onEscalate
    // closure below captures this binding, and TS cannot narrow a `let`
    // through a deferred closure — referencing the outer variable there would
    // make `.setBlocked` possibly-undefined.
    const lifecycle = new ReviewLifecycle(
      deps.review.registry,
      ownerEvents,
      deps.review.costFor,
      deps.review.resolveReport,
      notifier,
    );
    reviewLifecycle = lifecycle;
    const reviewBridge =
      deps.review.bridge ??
      new ReviewPermissionBridge({
        daemon: deps.daemon,
        onEscalate: (sessionId, data) => {
          void lifecycle.setBlocked(sessionId);
          void notifier
            ?.notify({ type: 'permission_request', data }, { sessionId })
            .catch(() => {});
        },
        onResume: (sessionId) => {
          void lifecycle.setRunning(sessionId);
        },
      });
    const reviewDeps = {
      daemon: deps.daemon,
      registry: deps.review.registry,
      lifecycle: reviewLifecycle,
      bridge: reviewBridge,
      audit,
      costFor: deps.review.costFor,
      promptAcceptWindowMs: deps.review.promptAcceptWindowMs,
      promptQueue,
    };
    app.post(
      '/rc/reviews',
      requireScope(WRITE, audit),
      recordActivity(workingDevice),
      subActorBan, // banned chat user → 403 (before consuming rate budget)
      subActorRateLimit, // bridge fan-in: cap review triggers per chat user
      createTriggerReviewRoute(reviewDeps),
    );
    app.get(
      '/rc/reviews',
      requireScope(SESSION_READ, audit),
      createListReviewsRoute(reviewDeps),
    );
    app.get(
      '/rc/reviews/:id',
      requireScope(SESSION_READ, audit),
      createGetReviewRoute(reviewDeps),
    );
    app.post(
      '/rc/reviews/:id/cancel',
      requireScope(WRITE, audit),
      recordActivity(workingDevice),
      subActorBan, // banned chat user → 403 (a stop request is never rate-limited)
      createCancelReviewRoute(reviewDeps),
    );
  }

  // Workflow orchestration control plane (add-workflow-orchestration). Requires
  // the agent registry (each workflow agent is a real session).
  let workflowRuns: WorkflowRunRegistry | undefined;
  if (deps.workflows && deps.agents) {
    workflowRuns = new WorkflowRunRegistry();
    const workflowDeps = {
      daemon: deps.daemon,
      agentRegistry: deps.agents.registry,
      runRegistry: workflowRuns,
      ownerEvents,
      audit,
      notifier,
      runsDir: deps.workflows.runsDir,
      resolveNamed: deps.workflows.resolveNamed,
    };
    app.post(
      '/rc/workflows',
      requireScope(WRITE, audit),
      recordActivity(workingDevice),
      subActorBan, // banned chat user → 403 (before consuming rate budget)
      subActorRateLimit, // bridge fan-in: cap workflow starts per chat user
      createStartWorkflowRoute(workflowDeps),
    );
    app.get(
      '/rc/workflows',
      requireScope(SESSION_READ, audit),
      createListWorkflowsRoute(workflowDeps),
    );
    app.get(
      '/rc/workflows/:runId',
      requireScope(SESSION_READ, audit),
      createGetWorkflowRoute(workflowDeps),
    );
    app.post(
      '/rc/workflows/:runId/cancel',
      requireScope(WRITE, audit),
      recordActivity(workingDevice),
      subActorBan, // banned chat user → 403 (a stop request is never rate-limited)
      createCancelWorkflowRoute(workflowDeps),
    );
  }

  // #155 backstop: LAST, after every route and the CORS middleware. Whatever a
  // route did not map itself (a rejected await, a body-parser error, a
  // middleware 4xx) is answered here as JSON with no stack.
  app.use(jsonErrorBackstop({ applyCors: applyActualRequestCors }));

  return {
    app,
    notifier,
    audit,
    ownerEvents,
    idleToggles,
    bridgeRegistry,
    promptEvents: promptEventBroadcaster,
    promptQueue,
    agentLifecycle,
    reviewLifecycle,
    workflowRuns,
  };
}
