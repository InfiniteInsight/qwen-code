/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useDaemonStream` — the opt-in daemon-client counterpart to `useGeminiStream`.
 *
 * It renders a *daemon-hosted* session in the existing TUI: it subscribes to the
 * daemon's SSE event stream, folds each frame through the pure
 * {@link projectDaemonEvent} reducer, and exposes the SAME shape
 * `useGeminiStream` returns so `AppContainer` can swap backends at the component
 * boundary. Tools execute IN THE DAEMON; this hook only renders their display and
 * votes on approvals. See `packages/rc-gateway/docs/phase2-daemon-tui.md`.
 *
 * Decoupling: the daemon client is taken as a structural {@link DaemonSessionDriver}
 * (an attached `DaemonSessionClient` satisfies it) so this package gains no
 * `@qwen-code/sdk` dependency and the hook is unit-testable with a fake driver.
 *
 * Approval wiring (verified end-to-end on a real 0.17.x daemon): the reducer marks
 * a gated tool `Confirming`; this hook attaches a `confirmationDetails` (built by
 * {@link buildDaemonConfirmation}) to that tool in `pendingHistoryItems`, so
 * `ToolGroupMessage`/`ToolConfirmationMessage` render an answerable prompt whose
 * `onConfirm` maps the chosen `ToolConfirmationOutcome` to the daemon `optionId`
 * and posts the vote. Approving executes the tool in the daemon and the turn
 * completes; Esc declines (that component's keypress handler only mounts once
 * `confirmationDetails` is present), and `permission_resolved` folds state back to
 * `Responding`.
 *
 * Known gaps for a later pass (NOT done here):
 * - Several contract fields are documented stubs (see the return).
 */
import { appendFileSync } from 'node:fs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EVENT_API_RESPONSE } from '@qwen-code/qwen-code-core/telemetry/constants.js';
import { ApiResponseEvent } from '@qwen-code/qwen-code-core/telemetry/types.js';
import {
  uiTelemetryService,
  type UiEvent,
} from '@qwen-code/qwen-code-core/telemetry/uiTelemetry.js';
import type { ToolConfirmationPayload } from '@qwen-code/qwen-code-core/tools/tools.js';
import {
  StreamingState,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
  type ThoughtSummary,
} from '../../types.js';

/**
 * Diagnostic frame log (opt-in via `QWEN_DAEMON_STREAM_DEBUG=<file>`). The TUI
 * owns stdout, so console logging would corrupt the Ink render — this appends to
 * a file instead. Off unless the env var is set.
 */
const dbg = (msg: string): void => {
  const path = process.env['QWEN_DAEMON_STREAM_DEBUG'];
  if (!path) return;
  try {
    appendFileSync(path, `${Date.now()} ${msg}\n`);
  } catch {
    /* best-effort diagnostics only */
  }
};
import {
  activePermissionOf,
  initialDaemonProjectionState,
  pendingHistoryItemsOf,
  pendingToolCallsOf,
  projectDaemonEvent,
  projectReplaySnapshot,
  thoughtOf,
  type DaemonFrame,
  type DaemonProjectionState,
  type DaemonReplaySnapshotFrames,
  type DaemonTurnUsage,
  type PendingPermission,
} from './projectDaemonEvent.js';
import { buildDaemonConfirmation } from './daemonConfirmation.js';
import {
  DAEMON_GONE_MESSAGE,
  classifyDaemonFailure,
  confirmDaemonGone,
  isTransportError,
} from './daemon-loss.js';
import {
  readDaemonModels,
  readDaemonModes,
  type DaemonSessionControl,
  type DaemonSessionStateLike,
} from './daemon-session-state.js';
import type { DaemonSubagentSyncDriver } from './use-daemon-subagent-sync.js';

/**
 * A vote on a daemon permission request. The `outcome` is itself an object
 * (matches the SDK's `PermissionResponse`): `{ outcome: { outcome: 'cancelled' } }`
 * or `{ outcome: { outcome: 'selected', optionId } }`.
 */
export interface DaemonPermissionResponse {
  outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string };
  [key: string]: unknown;
}

export type DaemonPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * The minimal slice of `DaemonSessionClient` this hook drives. An attached
 * `DaemonSessionClient` satisfies it structurally (no import needed).
 */
export interface DaemonSessionDriver
  extends DaemonSessionControl,
    DaemonSubagentSyncDriver {
  /** This client's daemon clientId; required so the daemon's self-echo is dropped. */
  readonly clientId?: string;
  /**
   * The transcript `DaemonSessionClient.load` retained from the load response.
   * The live stream resumes AFTER it (its first frame is `replay_complete`
   * with `replayedCount: 0`), so it is the only source of what was said before
   * this client attached. Drained into history once, before subscribing.
   */
  readonly replaySnapshot?: DaemonReplaySnapshotFrames;
  /** Release the retained snapshot once it has been committed to history. */
  consumeReplaySnapshot?: () => unknown;
  /** Older persisted records precede the snapshot. */
  readonly historyHasMore?: boolean;
  /** The persisted replay was only partly reconstructed. */
  readonly replayPartial?: boolean;
  /** The daemon's compaction failed at least once; the snapshot may lag. */
  readonly replayDegraded?: boolean;
  /** The load attached to a session with a prompt in flight. */
  readonly hasActivePrompt?: boolean;
  /** The cursor the first live subscription resumes after. */
  readonly lastEventId?: number;
  events(opts?: {
    signal?: AbortSignal;
  }): AsyncGenerator<DaemonFrame, void, unknown>;
  prompt(req: { prompt: DaemonPromptBlock[] }): Promise<unknown>;
  cancel(): Promise<void>;
  respondToSessionPermission(
    requestId: string,
    response: DaemonPermissionResponse,
  ): Promise<boolean>;
  enqueueMidTurnMessage?(message: string): Promise<unknown>;
  sendMidTurnMessagesNow?(): Promise<unknown>;
}

/**
 * What the hook needs to end an attached TUI whose daemon is gone (slice E of
 * InfiniteInsight/Qwen-Code-Remote#194). Absent in tests that do not exercise
 * loss; then every failure keeps its pre-slice-E handling.
 */
export interface DaemonLossHandling {
  /** One cheap request to the daemon (`GET /health`); rejects when it fails. */
  probeHealth(): Promise<unknown>;
  /**
   * End the process with exit code 75, through the normal exit cleanup. Called
   * at most once, after the one-line notice has been added and given time to
   * render. Injected so tests never call `process.exit`.
   */
  exitDaemonGone(): void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Wait before the health re-check (default 1 s). */
  recheckDelayMs?: number;
  /** Time for Ink to paint the notice before exiting (default 250 ms). */
  flushMs?: number;
}

/** Healthy-daemon transport failures in a row before the error is shown. */
const MAX_TRANSPORT_RETRIES = 5;
const DEFAULT_FLUSH_MS = 250;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type AddHistoryItem = (
  item: HistoryItemWithoutId,
  timestamp: number,
) => number;

export interface UseDaemonStreamResult {
  streamingState: StreamingState;
  /** Synchronous getter for current streaming state (unaffected by stale closures). */
  getStreamingState?: () => StreamingState;
  /** Submit a user turn: echo locally (responsive) + send to the daemon. */
  submitQuery: (
    query: string | DaemonPromptBlock[],
    options?: { echoText?: string },
  ) => Promise<void>;
  /** Execute a direct `!` shell command in the daemon session. */
  runShellCommand?: (command: string) => Promise<void>;
  /** Reset local pending turn state to Idle (used by local slash commands). */
  clearPendingState: () => void;
  /** Forward `/clear` to the daemon while suppressing echo/output and resetting state. */
  clearRemoteSession: () => Promise<void>;
  initError: string | null;
  pendingHistoryItems: HistoryItemWithoutId[];
  thought: ThoughtSummary | null;
  cancelOngoingRequest: () => void;
  pendingToolCalls: IndividualToolCallDisplay[];
  isReceivingContent: boolean;
  streamingResponseLengthRef: React.MutableRefObject<number>;
  /** Daemon-mode permission gate + vote (the interactive wiring binds these). */
  activePermission: PendingPermission | undefined;
  respondToPermission: (
    optionId: string | null,
    payload?: ToolConfirmationPayload,
  ) => Promise<void>;
  /** The model the daemon runs this session on; undefined until it says. */
  daemonModelId: string | undefined;
  /** The session's approval mode as the daemon reports it. */
  daemonApprovalMode: string | undefined;
  /** The session's display title as the daemon reports it. */
  daemonSessionTitle: string | undefined;
  retryLastPrompt: () => Promise<void>;
  handleApprovalModeChange: (newApprovalMode?: string) => Promise<void>;
  activePtyId: number | undefined;
  loopDetectionConfirmationRequest: null;
}

const now = () => Date.now();

function recordDaemonUsage(
  usage: DaemonTurnUsage | undefined,
  modelId: string | undefined,
): void {
  if (!usage) return;
  if (typeof usage.inputTokens === 'number' && usage.inputTokens >= 0) {
    uiTelemetryService.setLastPromptTokenCount(usage.inputTokens);
  }
  if (
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.durationMs !== undefined
  ) {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const total = usage.totalTokens ?? input + output;
    const event = new ApiResponseEvent(
      'daemon',
      modelId ?? 'default',
      usage.durationMs ?? 0,
      'daemon',
      undefined,
      {
        promptTokenCount: input,
        candidatesTokenCount: output,
        cachedContentTokenCount: usage.cachedReadTokens ?? 0,
        thoughtsTokenCount: usage.thoughtTokens ?? 0,
        totalTokenCount: total,
      },
    );
    uiTelemetryService.addEvent({
      ...event,
      'event.name': EVENT_API_RESPONSE,
    } as UiEvent);
  }
}

/**
 * Overlay the load response's model and mode onto a projection. The load state
 * is newer than any replayed frame (the transcript is a record of what already
 * happened; the state is what is true now), so it wins; when the state names
 * nothing, whatever the replayed frames set is kept.
 */
function withLoadState(
  base: DaemonProjectionState,
  loadState: DaemonSessionStateLike | undefined,
): DaemonProjectionState {
  const modelId = readDaemonModels(loadState).currentModelId ?? base.modelId;
  const approvalMode =
    readDaemonModes(loadState).currentModeId ?? base.approvalMode;
  if (modelId === base.modelId && approvalMode === base.approvalMode) {
    return base;
  }
  return { ...base, modelId, approvalMode };
}

function hasRenderableStateChange(
  prev: DaemonProjectionState,
  next: DaemonProjectionState,
): boolean {
  return (
    prev.streamingState !== next.streamingState ||
    prev.pendingText !== next.pendingText ||
    prev.pendingThought !== next.pendingThought ||
    prev.tools !== next.tools ||
    prev.pendingPermission !== next.pendingPermission ||
    prev.modelId !== next.modelId ||
    prev.approvalMode !== next.approvalMode ||
    prev.sessionTitle !== next.sessionTitle
  );
}

export function useDaemonStream(
  driver: DaemonSessionDriver,
  addItem: AddHistoryItem,
  loss?: DaemonLossHandling,
  onFrame?: (frame: DaemonFrame) => void,
): UseDaemonStreamResult {
  // PRECONDITION: the driver must be ATTACHED (clientId set) before mount.
  // Without a clientId the reducer can't distinguish our own echo from a remote
  // turn and falls back to projecting it — double-rendering our input (local
  // echo + daemon echo). `DaemonSessionClient.createOrAttach` always resolves a
  // clientId, so the wiring must await attach before rendering this hook.
  const stateRef = useRef(
    withLoadState(initialDaemonProjectionState(driver.clientId), driver.state),
  );
  const [snapshot, setSnapshot] = useState(stateRef.current);
  const [initError, setInitError] = useState<string | null>(null);
  const streamingResponseLengthRef = useRef(0);
  const addItemRef = useRef(addItem);
  addItemRef.current = addItem;
  const lossRef = useRef(loss);
  lossRef.current = loss;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const goneRef = useRef(false);
  const pendingClearTokensRef = useRef(new Set<symbol>());
  const lastPromptRef = useRef<string | DaemonPromptBlock[] | null>(null);
  // The driver whose replay snapshot has been committed. A ref (not state) so
  // StrictMode's effect re-run on the same instance sees it and never seeds a
  // second copy of the transcript.
  const seededDriverRef = useRef<DaemonSessionDriver | null>(null);

  const clearPendingState = useCallback(() => {
    const cleared = {
      ...stateRef.current,
      streamingState: StreamingState.Idle,
      pendingText: '',
      pendingThought: '',
      tools: [],
      pendingPermission: undefined,
    };
    stateRef.current = cleared;
    streamingResponseLengthRef.current = 0;
    setSnapshot((prev) =>
      hasRenderableStateChange(prev, cleared) ? cleared : prev,
    );
  }, []);

  // Fold one frame into the projection and reflect it in the UI. Shared by the
  // event loop and the prompt()-resolution finalizer.
  const applyFrame = useCallback(
    (frame: DaemonFrame) => {
      if (pendingClearTokensRef.current.size > 0) {
        const update = (
          frame.data as {
            update?: {
              sessionUpdate?: string;
            };
          }
        )?.update;
        const suKind = update?.sessionUpdate;
        if (
          frame.type === 'session_update' &&
          (suKind === 'user_message_chunk' || suKind === 'agent_message_chunk')
        ) {
          if (typeof frame.id === 'number') {
            stateRef.current = {
              ...stateRef.current,
              lastEventId: Math.max(
                stateRef.current.lastEventId ?? 0,
                frame.id,
              ),
            };
          }
          return;
        }
        if (frame.type === 'turn_complete' || frame.type === 'turn_error') {
          const oldestToken = pendingClearTokensRef.current
            .values()
            .next().value;
          if (oldestToken !== undefined) {
            pendingClearTokensRef.current.delete(oldestToken);
          }
          if (typeof frame.id === 'number') {
            stateRef.current = {
              ...stateRef.current,
              lastEventId: Math.max(
                stateRef.current.lastEventId ?? 0,
                frame.id,
              ),
            };
          }
          clearPendingState();
          return;
        }
      }
      const prevUsage = stateRef.current.lastUsage;
      const { state, committed } = projectDaemonEvent(stateRef.current, frame);
      if (state.lastUsage && state.lastUsage !== prevUsage) {
        recordDaemonUsage(state.lastUsage, state.modelId);
      }
      const su = (frame.data as { update?: { sessionUpdate?: string } })?.update
        ?.sessionUpdate;
      dbg(
        `frame type=${frame.type}${su ? `/${su}` : ''} oc=${frame.originatorClientId ?? '∅'} -> state=${state.streamingState} tools=${state.tools.length} pending=${pendingHistoryItemsOf(state).length} committed=${committed.length}`,
      );
      if (frame.type === 'permission_request') {
        const tc = (frame.data as { toolCall?: Record<string, unknown> })
          ?.toolCall;
        const opts =
          (frame.data as { options?: Array<Record<string, unknown>> })
            ?.options ?? [];
        dbg(
          `  perm toolCall keys=[${Object.keys(tc ?? {}).join(',')}] toolCallId=${String(tc?.['toolCallId'])} options=${opts.map((o) => `${o['kind']}:${o['optionId']}`).join('|')}`,
        );
      }
      stateRef.current = state;
      for (const item of committed) addItemRef.current(item, now());
      streamingResponseLengthRef.current =
        state.pendingThought.length + state.pendingText.length;
      setSnapshot((prev) =>
        hasRenderableStateChange(prev, state) ? state : prev,
      );
      onFrameRef.current?.(frame);
    },
    [clearPendingState],
  );

  const clearRemoteSession = useCallback(async () => {
    const clearToken = Symbol('clear');
    pendingClearTokensRef.current.add(clearToken);
    try {
      await driver.prompt({
        prompt: [{ type: 'text', text: '/clear' }],
      });
      // Allow queued SSE frames from the /clear turn to drain through the
      // async generator before cleaning up the token for 0.17.x daemons that
      // omit `turn_complete` SSE frames.
      for (
        let i = 0;
        i < 4 && pendingClearTokensRef.current.has(clearToken);
        i++
      ) {
        await Promise.resolve();
      }
    } finally {
      pendingClearTokensRef.current.delete(clearToken);
      clearPendingState();
    }
  }, [driver, clearPendingState]);

  // Finalize the in-flight turn (commit pending text, return to Idle).
  //
  // IMPORTANT: this codebase's daemon (0.17.x) signals turn completion via the
  // prompt() HTTP RESPONSE (`stopReason`), NOT a `turn_complete` SSE frame — so
  // we synthesize one when prompt() resolves (and when the SSE closes mid-turn).
  // Newer daemons (0.18+) also emit the frame; the duplicate is a harmless no-op
  // (pending already cleared → Idle).
  const finalizeTurn = useCallback(
    (stopReason?: unknown) => {
      if (stateRef.current.streamingState === StreamingState.Idle) return;
      applyFrame({ type: 'turn_complete', data: { stopReason } });
    },
    [applyFrame],
  );

  // The daemon is gone: say so on one plain line, give Ink a moment to paint it,
  // then end the process (exit 75) so `qwen-rc attach` can find a new daemon.
  // Once only: the stream loop and a failed prompt can both get here.
  const declareDaemonGone = useCallback(async () => {
    const handling = lossRef.current;
    if (!handling || goneRef.current) return;
    goneRef.current = true;
    dbg('daemon gone: exiting 75');
    addItemRef.current({ type: 'info', text: DAEMON_GONE_MESSAGE }, now());
    await (handling.sleep ?? realSleep)(handling.flushMs ?? DEFAULT_FLUSH_MS);
    await handling.exitDaemonGone();
  }, []);

  // A failure that classifies as `daemon_gone`. A 404 or `session_died` is the
  // daemon's own word; a transport failure is only a suspicion until a re-check
  // of the daemon (after a short delay) fails too, so a blip that the daemon
  // recovers from never ends the tab. Resolves true once the tab is leaving.
  const confirmAndDeclareGone = useCallback(
    async (err: unknown): Promise<boolean> => {
      const handling = lossRef.current;
      if (!handling) return false;
      if (isTransportError(err)) {
        const gone = await confirmDaemonGone({
          probe: () => handling.probeHealth(),
          sleep: handling.sleep ?? realSleep,
          delayMs: handling.recheckDelayMs,
        });
        if (!gone) return false;
      }
      await declareDaemonGone();
      return true;
    },
    [declareDaemonGone],
  );

  useEffect(() => {
    // Seed the conversation so far, ONCE per driver, synchronously, before the
    // live loop below subscribes, so no live frame can land ahead of it. Items
    // are appended through `addItem` like any live commit: history grows from
    // empty while MainContent's progressive <Static> replay catches up, and
    // nothing bumps the Static remount key (the #3899 path is never taken).
    if (seededDriverRef.current !== driver) {
      seededDriverRef.current = driver;
      const replay = driver.replaySnapshot;
      if (replay) {
        const { state, committed } = projectReplaySnapshot(replay, {
          ownClientId: driver.clientId,
          lastEventId: driver.lastEventId,
          hasActivePrompt: driver.hasActivePrompt,
          historyHasMore: driver.historyHasMore,
          replayPartial: driver.replayPartial,
          replayDegraded: driver.replayDegraded,
        });
        dbg(
          `replay seed compacted=${replay.compactedReplay.length} live=${replay.liveJournal.length} committed=${committed.length} -> state=${state.streamingState} lastEventId=${state.lastEventId ?? '∅'}`,
        );
        const seeded = withLoadState(state, driver.state);
        stateRef.current = seeded;
        if (seeded.lastUsage) {
          recordDaemonUsage(seeded.lastUsage, seeded.modelId);
        }
        for (const item of committed) addItemRef.current(item, now());
        streamingResponseLengthRef.current =
          seeded.pendingThought.length + seeded.pendingText.length;
        setSnapshot(seeded);
        // The raw wire events are in history now; let the client drop them.
        driver.consumeReplaySnapshot?.();
      }
    }

    const ac = new AbortController();
    let disposed = false;

    void (async () => {
      let transportFailures = 0;
      for (let attempt = 0; !disposed && !ac.signal.aborted; attempt++) {
        try {
          dbg(`subscribe attempt=${attempt} clientId=${driver.clientId}`);
          let sawTerminalSessionEvent = false;
          for await (const frame of driver.events({ signal: ac.signal })) {
            if (disposed) break;
            transportFailures = 0;
            attempt = 0;
            if (
              frame.type === 'session_closed' ||
              frame.type === 'session_died'
            ) {
              sawTerminalSessionEvent = true;
            }
            applyFrame(frame);
            if (
              lossRef.current &&
              classifyDaemonFailure({ kind: 'frame', frame }) === 'daemon_gone'
            ) {
              await declareDaemonGone();
              return;
            }
          }
          dbg('stream ended');
          if (disposed || ac.signal.aborted) break;
          // Only finalize the turn when the stream closed due to a terminal
          // session lifecycle event. A transient SSE EOF mid-turn will
          // reconnect with Last-Event-ID and resume the turn without
          // duplicating partial items or prematurely flipping to Idle.
          if (sawTerminalSessionEvent && !stateRef.current.pendingPermission) {
            finalizeTurn();
          }
          await new Promise((r) => setTimeout(r, 500));
          continue;
        } catch (err) {
          if (disposed || ac.signal.aborted) {
            dbg(`stream aborted (disposed=${disposed})`);
            break;
          }
          const msg = String((err as Error)?.message ?? err);
          dbg(`stream error: ${msg}`);
          // The daemon allows ONE live subscription per session; React
          // StrictMode's mount→unmount→remount can race the previous
          // subscription's teardown. Back off and retry rather than surfacing a
          // transient error to the user.
          const verdict = classifyDaemonFailure({ kind: 'error', error: err });
          if (verdict === 'retry' && attempt < 20) {
            await new Promise((r) => setTimeout(r, 25));
            continue;
          }
          if (verdict === 'daemon_gone' && lossRef.current) {
            if (await confirmAndDeclareGone(err)) break;
            // The daemon answered the re-check: a blip. Subscribe again, but
            // not forever if the stream keeps failing against a live daemon.
            if (!disposed && ++transportFailures < MAX_TRANSPORT_RETRIES) {
              continue;
            }
          }
          setInitError(msg);
          break;
        }
      }
    })();

    return () => {
      disposed = true;
      ac.abort();
    };
  }, [
    driver,
    applyFrame,
    finalizeTurn,
    declareDaemonGone,
    confirmAndDeclareGone,
  ]);

  const submitQuery = useCallback(
    async (
      query: string | DaemonPromptBlock[],
      options?: { echoText?: string },
    ) => {
      const blocks: DaemonPromptBlock[] = Array.isArray(query)
        ? query
        : [{ type: 'text', text: query }];
      const echoText =
        options?.echoText ??
        (typeof query === 'string'
          ? query
          : blocks
              .map((b) => (b.type === 'text' ? b.text : ''))
              .filter(Boolean)
              .join(''));
      lastPromptRef.current = query;
      pendingClearTokensRef.current.clear();
      const hadActiveTurnAtSubmit =
        stateRef.current.streamingState !== StreamingState.Idle;
      if (
        !hadActiveTurnAtSubmit &&
        (stateRef.current.pendingText.length > 0 ||
          stateRef.current.tools.length > 0)
      ) {
        finalizeTurn();
      }
      // Echo locally for responsiveness; the reducer drops the daemon's
      // self-echo (matched by originatorClientId === our clientId).
      addItemRef.current({ type: 'user', text: echoText }, now());
      if (stateRef.current.streamingState === StreamingState.Idle) {
        const respondingState = {
          ...stateRef.current,
          streamingState: StreamingState.Responding,
        };
        stateRef.current = respondingState;
        setSnapshot((prev) =>
          hasRenderableStateChange(prev, respondingState)
            ? respondingState
            : prev,
        );
      }
      dbg(`submitQuery len=${echoText.length}`);
      let result: unknown;
      try {
        result = await driver.prompt({
          prompt: blocks,
        });
      } catch (err) {
        // The turn failed in the daemon (it published `turn_error`, which the
        // SDK turns into this rejection before it yields the frame). The turn
        // is over: end it here, and leave the error line to the frame so it
        // is shown once, the same way for this tab's turns and the phone's.
        // Structural twin of the SDK's `isDaemonTurnError` (no SDK import).
        if (
          (err as { _daemonTurnError?: unknown })?._daemonTurnError === true
        ) {
          dbg(`prompt() failed with a turn error: ${String(err)}`);
          finalizeTurn();
          return;
        }
        // The daemon dying mid-prompt ends the tab (exit 75). An error the
        // daemon recovers from (it answers the re-check) is rethrown as before.
        if (
          classifyDaemonFailure({ kind: 'error', error: err }) ===
            'daemon_gone' &&
          (await confirmAndDeclareGone(err))
        ) {
          return;
        }
        const errStatus =
          (
            err as {
              status?: unknown;
              statusCode?: unknown;
              code?: unknown;
            } | null
          )?.status ?? (err as { statusCode?: unknown } | null)?.statusCode;
        const errCode = (err as { code?: unknown } | null)?.code;
        const errMsg = String((err as Error)?.message ?? err);
        const isSessionBusyError =
          errStatus === 409 ||
          errCode === 409 ||
          errCode === 'session_busy' ||
          /busy|409|already running|in flight/i.test(errMsg);
        const hasInFlightRemoteTurn =
          hadActiveTurnAtSubmit ||
          stateRef.current.pendingText.length > 0 ||
          stateRef.current.pendingThought.length > 0 ||
          stateRef.current.tools.length > 0 ||
          stateRef.current.pendingPermission !== undefined;
        if (!isSessionBusyError && !hasInFlightRemoteTurn) {
          finalizeTurn();
        }
        throw err;
      }
      dbg('prompt() resolved');
      // 0.17.x completion signal: prompt() resolves with the turn's stopReason.
      finalizeTurn((result as { stopReason?: unknown } | null)?.stopReason);
    },
    [driver, finalizeTurn, confirmAndDeclareGone],
  );

  const runShellCommand = useCallback(
    async (command: string) => {
      const trimmed = command.trim();
      if (!trimmed || typeof driver.shellCommand !== 'function') return;
      addItemRef.current({ type: 'user_shell', text: trimmed }, now());
      const res = await driver.shellCommand(trimmed);
      if (stateRef.current.pendingShellCommand === undefined) {
        // When the driver resolves synchronously without having emitted SSE
        // shell frames yet, commit the result directly so the UI always shows
        // the shell output.
        const out = typeof res?.output === 'string' ? res.output : '';
        applyFrame({
          type: 'user_shell_command',
          data: { command: trimmed },
          originatorClientId: driver.clientId,
        });
        if (out) {
          applyFrame({
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'shell_output',
                output: out,
              },
            },
            originatorClientId: driver.clientId,
          });
        }
        applyFrame({
          type: 'user_shell_result',
          data: {
            exitCode: res?.exitCode ?? 0,
            aborted: res?.aborted ?? false,
          },
          originatorClientId: driver.clientId,
        });
      }
    },
    [driver, applyFrame],
  );

  const cancelOngoingRequest = useCallback(() => {
    void driver.cancel();
  }, [driver]);

  const retryLastPrompt = useCallback(async () => {
    if (stateRef.current.streamingState !== StreamingState.Idle) return;
    const last = lastPromptRef.current;
    if (!last) return;
    await submitQuery(last);
  }, [submitQuery]);

  const handleApprovalModeChange = useCallback(
    async (newApprovalMode?: string) => {
      if (!newApprovalMode || typeof driver.setApprovalMode !== 'function') {
        return;
      }
      try {
        await driver.setApprovalMode(newApprovalMode);
      } catch {
        /* surfaced via daemon stream or ignored */
      }
    },
    [driver],
  );

  const respondToPermission = useCallback(
    async (optionId: string | null, payload?: ToolConfirmationPayload) => {
      const gate = stateRef.current.pendingPermission;
      if (!gate) return;
      const extra: Record<string, unknown> = {};
      if (payload?.answers) {
        extra['answers'] = payload.answers;
      }
      await driver.respondToSessionPermission(
        gate.requestId,
        optionId === null
          ? { outcome: { outcome: 'cancelled' }, ...extra }
          : { outcome: { outcome: 'selected', optionId }, ...extra },
      );
    },
    [driver],
  );

  const activePendingThought =
    snapshot.tools.length === 0 && snapshot.pendingText.trim().length === 0
      ? snapshot.pendingThought
      : '';
  const pendingHistoryItems = useMemo(() => {
    const items = pendingHistoryItemsOf({
      tools: snapshot.tools,
      pendingText: snapshot.pendingText,
      pendingThought: activePendingThought,
    });
    // Bind the approval prompt: attach a `confirmationDetails` (with an
    // outcome→optionId-mapping `onConfirm`) to the gated tool so
    // `ToolConfirmationMessage` renders an answerable Yes/Always/No. The reducer
    // can't build this — `onConfirm` closes over the impure `respondToPermission`.
    const gate = snapshot.pendingPermission;
    if (!gate?.toolCallId) return items;
    const details = buildDaemonConfirmation(gate, respondToPermission);
    return items.map((item) =>
      item.type === 'tool_group'
        ? {
            ...item,
            tools: item.tools.map((tool) =>
              tool.callId === gate.toolCallId
                ? { ...tool, confirmationDetails: details }
                : tool,
            ),
          }
        : item,
    );
  }, [
    snapshot.tools,
    snapshot.pendingText,
    activePendingThought,
    snapshot.pendingPermission,
    respondToPermission,
  ]);
  const thought = useMemo(
    () => thoughtOf({ pendingThought: snapshot.pendingThought }),
    [snapshot.pendingThought],
  );
  const pendingToolCalls = useMemo(
    () => pendingToolCallsOf({ tools: snapshot.tools }),
    [snapshot.tools],
  );
  const activePermission = useMemo(
    () => activePermissionOf({ pendingPermission: snapshot.pendingPermission }),
    [snapshot.pendingPermission],
  );

  const getStreamingState = useCallback(
    () => stateRef.current.streamingState,
    [],
  );

  return {
    streamingState: snapshot.streamingState,
    getStreamingState,
    submitQuery,
    runShellCommand,
    clearPendingState,
    clearRemoteSession,
    initError,
    pendingHistoryItems,
    thought,
    cancelOngoingRequest,
    pendingToolCalls,
    isReceivingContent: snapshot.streamingState === StreamingState.Responding,
    streamingResponseLengthRef,
    activePermission,
    respondToPermission,
    daemonModelId: snapshot.modelId,
    daemonApprovalMode: snapshot.approvalMode,
    daemonSessionTitle: snapshot.sessionTitle,
    retryLastPrompt,
    handleApprovalModeChange,
    activePtyId: undefined,
    loopDetectionConfirmationRequest: null,
  };
}
