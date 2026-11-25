import { randomUUID } from '../../utils/random-uuid.js';
import { useWorkspaceFileChanges } from './useWorkspaceFileChanges';
import { useDaemonAvailabilityController } from '../../daemon/availability-context.js';
import { isDaemonUnavailableError } from '../../daemon/availability.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DaemonSessionProvider,
  useActions,
  useConnection,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type { ACPToolCall, Message } from '../../adapters/types';
import { WEB_SHELL_MAX_TRANSCRIPT_BLOCKS } from '../../constants/sessions';
import { useAnimationFrameTranscriptSnapshot } from '../../hooks/useAnimationFrameTranscriptBlocks';
import { useMessagesFromBlocks } from '../../hooks/useMessages';
import { useSessionArtifacts } from '../../hooks/useSessionArtifacts';
import { ReportedArtifactRegistration } from '../ReportedArtifactRegistration';
import { useI18n } from '../../i18n';
import {
  SubagentDetailsProvider,
  type OpenSubagentDetails,
} from '../../subagentDetailsContext';
import { MessageList } from '../MessageList';
import { getAgentDescription } from '../messages/toolFormatting';
import { Badge } from '../ui/badge';
import type { TurnOutputOpenRequest } from './TurnOutputs';
import {
  getArtifactsByTurn,
  getFileChangesByTurn,
} from './turnOutputSelectors';
import { fileChangeOwnerSessionId } from './workspace-file-changes';
import styles from './SubagentDetail.module.css';

interface SubagentResolution {
  sessionId: string;
  status: string;
  durationMs?: number;
  toolCalls?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

interface SubagentMetrics {
  status: string;
  durationMs?: number;
  toolCalls?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

function preferLargerMetric(
  first: number | undefined,
  second: number | undefined,
): number | undefined {
  if (first !== undefined && second !== undefined) {
    return Math.max(first, second);
  }
  return first ?? second;
}

function getSubagentMetrics(
  rootTool: ACPToolCall,
  resolution: SubagentResolution,
): SubagentMetrics {
  const raw =
    typeof rootTool.rawOutput === 'object' && rootTool.rawOutput !== null
      ? (rootTool.rawOutput as Record<string, unknown>)
      : undefined;
  const summary =
    typeof raw?.['executionSummary'] === 'object' &&
    raw['executionSummary'] !== null
      ? (raw['executionSummary'] as Record<string, unknown>)
      : undefined;
  const summaryDuration =
    typeof summary?.['totalDurationMs'] === 'number'
      ? summary['totalDurationMs']
      : rootTool.endTime && rootTool.startTime
        ? Math.max(0, rootTool.endTime - rootTool.startTime)
        : undefined;
  const toolCalls =
    typeof summary?.['totalToolCalls'] === 'number'
      ? summary['totalToolCalls']
      : undefined;
  const totalTokens =
    typeof summary?.['totalTokens'] === 'number'
      ? summary['totalTokens']
      : typeof raw?.['tokenCount'] === 'number'
        ? raw['tokenCount']
        : undefined;
  const inputTokens =
    typeof summary?.['inputTokens'] === 'number'
      ? summary['inputTokens']
      : undefined;
  const outputTokens =
    typeof summary?.['outputTokens'] === 'number'
      ? summary['outputTokens']
      : undefined;
  const cachedTokens =
    typeof summary?.['cachedTokens'] === 'number'
      ? summary['cachedTokens']
      : undefined;
  const resolvedToolCalls = preferLargerMetric(toolCalls, resolution.toolCalls);
  const resolvedTotalTokens = preferLargerMetric(
    totalTokens,
    resolution.totalTokens,
  );

  return {
    status: resolution.status,
    durationMs: preferLargerMetric(summaryDuration, resolution.durationMs),
    ...(resolvedToolCalls !== undefined
      ? { toolCalls: resolvedToolCalls }
      : {}),
    ...(resolvedTotalTokens !== undefined
      ? { totalTokens: resolvedTotalTokens }
      : {}),
    inputTokens: preferLargerMetric(inputTokens, resolution.inputTokens),
    outputTokens: preferLargerMetric(outputTokens, resolution.outputTokens),
    cachedTokens: preferLargerMetric(cachedTokens, resolution.cachedTokens),
  };
}

function createDetailClientId(): string {
  return `subagent-detail:${randomUUID()}`;
}

export function findSubagentRootTool(
  messages: readonly Message[],
  rootToolCallId: string,
): ACPToolCall | undefined {
  for (const message of messages) {
    if (message.role !== 'tool_group') continue;
    const tool = message.tools.find(
      (candidate) => candidate.callId === rootToolCallId,
    );
    if (tool) return tool;
  }
  return undefined;
}

function statusLabel(status: string, t: ReturnType<typeof useI18n>['t']) {
  switch (status) {
    case 'completed':
    case 'success':
      return t('subagent.completed');
    case 'failed':
    case 'error':
      return t('subagent.failed');
    case 'cancelled':
    case 'canceled':
      return t('subagent.cancelled');
    case 'paused':
      return t('subagent.paused');
    default:
      return t('subagent.running');
  }
}

function SubagentDetailContent({
  rootTool,
  resolution,
  onStop,
  onSendMessage,
  onRightPanelOpen,
  onArtifactsChange,
  onOpenSubagent,
  onError,
}: {
  rootTool: ACPToolCall;
  resolution: SubagentResolution;
  onStop?: () => Promise<{ cancelled: boolean }>;
  onSendMessage?: (message: string) => Promise<{
    delivered: boolean;
    action?: 'queued' | 'resumed' | 'continued' | 'revived';
    status?: string;
    reason?: string;
  }>;
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  onArtifactsChange?: (
    sessionId: string,
    artifacts: readonly DaemonSessionArtifact[],
  ) => void;
  onOpenSubagent?: OpenSubagentDetails;
  onError?: (error: unknown, fallback: string) => void;
}) {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useActions();
  const { blocks, blockChangeSummary } = useAnimationFrameTranscriptSnapshot();
  const messages = useMessagesFromBlocks(t, blocks, blockChangeSummary);
  const { artifacts, hydrated, refresh } = useSessionArtifacts();
  const artifactsByTurn = useMemo(
    () =>
      getArtifactsByTurn(messages, artifacts, connection.workspaceCwd || ''),
    [artifacts, connection.workspaceCwd, messages],
  );
  const fileChangesByTurn = useWorkspaceFileChanges(
    messages,
    artifactsByTurn,
    connection.workspaceCwd ||
      connection.standaloneSession?.projectlessOutputDirectory ||
      '',
    connection.sessionId
      ? fileChangeOwnerSessionId(connection.sessionId)
      : undefined,
    connection.workspaceCwd ? undefined : null,
  );
  const description = getAgentDescription(rootTool);
  const metrics = useMemo(
    () => getSubagentMetrics(rootTool, resolution),
    [resolution, rootTool],
  );
  const isRunning =
    metrics.status === 'running' || metrics.status === 'in_progress';
  const canMessage =
    Boolean(onSendMessage) &&
    (isRunning ||
      metrics.status === 'paused' ||
      metrics.status === 'completed' ||
      metrics.status === 'success');
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendFeedback, setSendFeedback] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);

  useEffect(() => {
    const sessionId = connection.sessionId;
    if (!sessionId) return;
    onArtifactsChange?.(sessionId, artifacts);
    return () => {
      onArtifactsChange?.(sessionId, []);
    };
  }, [artifacts, connection.sessionId, onArtifactsChange]);

  const reviewSourceRef = useRef({ messages, artifactsByTurn });
  reviewSourceRef.current = { messages, artifactsByTurn };
  const handleRightPanelOpen = useCallback(
    (request: TurnOutputOpenRequest) => {
      const source = reviewSourceRef.current;
      onRightPanelOpen?.({
        ...request,
        ...(request.kind === 'review'
          ? {
              unfilteredChanges:
                getFileChangesByTurn(
                  source.messages,
                  source.artifactsByTurn,
                  connection.workspaceCwd ||
                    connection.standaloneSession?.projectlessOutputDirectory ||
                    '',
                ).get(request.turnId) ?? request.changes,
            }
          : {}),
        sourceSessionId: connection.sessionId,
      });
    },
    [
      connection.sessionId,
      connection.workspaceCwd,
      connection.standaloneSession?.projectlessOutputDirectory,
      onRightPanelOpen,
    ],
  );

  useEffect(() => {
    actions?.setDaemonActivePrompt?.(isRunning, {
      workspaceCwd: connection.workspaceCwd,
      sessionId: resolution.sessionId,
    });
  }, [actions, connection.workspaceCwd, isRunning, resolution.sessionId]);

  useEffect(() => {
    if (isRunning) return;
    setStopping(false);
    setStopError('');
  }, [isRunning]);

  const handleStop = async () => {
    if (stopping || !onStop) return;
    setStopping(true);
    setStopError('');
    try {
      const result = await onStop();
      if (!result.cancelled) {
        setStopping(false);
      }
    } catch {
      setStopping(false);
      setStopError(t('tasks.cancelFailed'));
    } finally {
      setStopping(false);
    }
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending || !onSendMessage) return;
    setSending(true);
    setSendFeedback(null);
    try {
      const res = await onSendMessage(text);
      if (res.delivered) {
        setDraft('');
        setSendFeedback(null);
      } else {
        setSendFeedback({
          text: res.reason || 'Could not deliver message to subagent.',
          error: true,
        });
      }
    } catch (err) {
      setSendFeedback({
        text:
          err instanceof Error
            ? err.message
            : 'Could not deliver message to subagent.',
        error: true,
      });
    } finally {
      setSending(false);
    }
  };

  const transcript = (
    <MessageList
      messages={messages}
      pendingApproval={null}
      loadingTranscript={connection.loadingTranscript}
      catchingUp={connection.catchingUp}
      isResponding={isRunning}
      activeTurnStartedAt={isRunning ? rootTool.startTime : undefined}
      workspaceCwd={connection.workspaceCwd || ''}
      hideSessionTimeline
      firstTurnMetrics={metrics}
      includeSubagentToolUsageInMetrics={false}
      turnFileChanges={fileChangesByTurn}
      sourceSessionId={connection.sessionId}
      turnArtifacts={artifactsByTurn}
      onTurnOutputOpen={handleRightPanelOpen}
      onError={onError}
    />
  );

  return (
    <div className={styles.detail}>
      {/* The detail view runs under its own DaemonSessionProvider for the
          subagent session; App's registration mount only covers the main
          session, so register this session's reported artifacts here. */}
      <ReportedArtifactRegistration
        registered={artifacts}
        hydrated={hydrated}
        refresh={refresh}
      />
      <div className={styles.overview}>
        <div className={styles.descriptionRow}>
          {description && (
            <div className={styles.description}>{description}</div>
          )}
          <div className={styles.statusActions}>
            <Badge
              variant="outline"
              className={styles.statusTag}
              data-status={metrics.status}
            >
              {statusLabel(metrics.status, t)}
            </Badge>
            {isRunning && onStop && (
              <button
                type="button"
                className={styles.stopButton}
                disabled={stopping}
                onClick={() => void handleStop()}
              >
                {stopping ? t('common.loading') : t('tasks.action.stop')}
              </button>
            )}
          </div>
        </div>
        {stopError && <div className={styles.stopError}>{stopError}</div>}
      </div>
      <div className={styles.transcript}>
        {onOpenSubagent ? (
          <SubagentDetailsProvider onOpen={onOpenSubagent}>
            {transcript}
          </SubagentDetailsProvider>
        ) : (
          transcript
        )}
      </div>
      {canMessage && (
        <form
          className={styles.composer}
          data-testid="subagent-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend();
          }}
        >
          <div className={styles.composerRow}>
            <textarea
              className={styles.composerInput}
              rows={1}
              value={draft}
              disabled={sending}
              placeholder={
                isRunning
                  ? 'Message running subagent (Enter to send)...'
                  : metrics.status === 'paused'
                    ? 'Resume subagent with a message...'
                    : 'Continue subagent with a follow-up message...'
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <button
              type="submit"
              className={styles.sendButton}
              disabled={sending || !draft.trim()}
            >
              {sending ? t('common.loading') : 'Send'}
            </button>
          </div>
          {sendFeedback && (
            <div
              className={
                sendFeedback.error ? styles.stopError : styles.sendFeedback
              }
            >
              {sendFeedback.text}
            </div>
          )}
        </form>
      )}
    </div>
  );
}

export function SubagentDetail({
  sessionId,
  rootToolCallId,
  initialRootTool,
  workspaceCwd,
  onRightPanelOpen,
  onArtifactsChange,
  onOpenSubagent,
  onError,
}: {
  sessionId: string;
  rootToolCallId: string;
  initialRootTool: ACPToolCall;
  workspaceCwd?: string;
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  onArtifactsChange?: (
    sessionId: string,
    artifacts: readonly DaemonSessionArtifact[],
  ) => void;
  onOpenSubagent?: (
    tool: ACPToolCall,
    sessionId: string,
    workspaceCwd?: string,
  ) => void;
  onError?: (error: unknown, fallback: string) => void;
}) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const subagentClient = useMemo(() => {
    if (!workspace?.client) return null;
    if (workspaceCwd && typeof workspace.client.workspaceByCwd === 'function') {
      return workspace.client.workspaceByCwd(workspaceCwd) ?? workspace.client;
    }
    return workspace.client;
  }, [workspace?.client, workspaceCwd]);
  const parentConnection = useConnection();
  const { blocks: parentBlocks, blockChangeSummary: parentBlockChangeSummary } =
    useAnimationFrameTranscriptSnapshot();
  const parentMessages = useMessagesFromBlocks(
    t,
    parentBlocks,
    parentBlockChangeSummary,
  );
  const rootTool =
    (parentConnection.sessionId === sessionId
      ? findSubagentRootTool(parentMessages, rootToolCallId)
      : undefined) ?? initialRootTool;
  const [instance, setInstance] = useState(() => ({
    key: 0,
    clientId: createDetailClientId(),
  }));
  const availability = useDaemonAvailabilityController();
  const [resolution, setResolution] = useState<SubagentResolution>();
  const [loadError, setLoadError] = useState(false);
  const [pollTrigger, setPollTrigger] = useState(0);
  const refreshRef = useRef<() => Promise<void>>(undefined);
  const ensurePollingRef = useRef<() => void>(undefined);

  useEffect(() => {
    let cancelled = false;
    let hasResolved = false;
    let retryCount = 0;
    let lastResolvedRunning = false;
    let inFlight = false;
    let refreshOnRecovery = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setResolution(undefined);
    setLoadError(false);
    const clearRefreshTimer = () => {
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
    };
    const scheduleRefresh = (delayMs: number) => {
      clearRefreshTimer();
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, delayMs);
    };
    const refresh = async () => {
      clearRefreshTimer();
      if (
        !subagentClient ||
        inFlight ||
        (availability && availability.getSnapshot() !== 'available')
      ) {
        return;
      }
      inFlight = true;
      try {
        const resolveClient =
          typeof subagentClient.resolveSubagentSession === 'function'
            ? subagentClient
            : workspace?.client;
        if (!resolveClient) return;
        const resolved = await resolveClient.resolveSubagentSession(
          sessionId,
          rootToolCallId,
        );
        if (cancelled) return;
        hasResolved = true;
        retryCount = 0;
        lastResolvedRunning = resolved.status === 'running';
        setResolution(resolved);
        setLoadError(false);
        if (
          resolved.status === 'running' &&
          (!availability || availability.getSnapshot() === 'available')
        ) {
          scheduleRefresh(3_000);
        }
      } catch (error) {
        if (
          cancelled ||
          isDaemonUnavailableError(error) ||
          (availability && availability.getSnapshot() !== 'available')
        )
          return;
        if (retryCount < 3) {
          retryCount += 1;
          scheduleRefresh(3_000);
        } else if (!hasResolved) {
          setLoadError(true);
        } else if (lastResolvedRunning) {
          scheduleRefresh(30_000);
        }
      } finally {
        inFlight = false;
        if (
          refreshOnRecovery &&
          !cancelled &&
          (!availability || availability.getSnapshot() === 'available')
        ) {
          refreshOnRecovery = false;
          clearRefreshTimer();
          void refresh();
        }
      }
    };
    refreshRef.current = refresh;
    ensurePollingRef.current = () => {
      if (cancelled) return;
      lastResolvedRunning = true;
      retryCount = 0;
      if (
        refreshTimer === undefined &&
        (!availability || availability.getSnapshot() === 'available')
      ) {
        scheduleRefresh(3_000);
      }
    };
    let wasAvailable = availability?.getSnapshot() === 'available';
    const unsubscribeAvailability = availability?.subscribe(() => {
      const available = availability.getSnapshot() === 'available';
      if (available === wasAvailable) return;
      wasAvailable = available;
      clearRefreshTimer();
      if (available && (!hasResolved || lastResolvedRunning)) {
        if (inFlight) refreshOnRecovery = true;
        else void refresh();
      }
    });
    void refresh();
    return () => {
      cancelled = true;
      unsubscribeAvailability?.();
      clearRefreshTimer();
      if (refreshRef.current === refresh) {
        refreshRef.current = undefined;
      }
      if (ensurePollingRef.current !== undefined) {
        ensurePollingRef.current = undefined;
      }
    };
  }, [availability, instance.key, rootToolCallId, sessionId, subagentClient]);

  useEffect(() => {
    if (resolution?.status === 'running') {
      ensurePollingRef.current?.();
    }
  }, [pollTrigger, resolution?.status]);

  if (loadError) {
    return (
      <div className={styles.state}>
        <div>{t('subagent.detailsLoadFailed')}</div>
        <button
          type="button"
          className={styles.retry}
          onClick={() =>
            setInstance((current) => ({
              key: current.key + 1,
              clientId: createDetailClientId(),
            }))
          }
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (!resolution) {
    return <div className={styles.state}>{t('subagent.detailsLoading')}</div>;
  }

  return (
    <DaemonSessionProvider
      key={`${instance.key}:${resolution.sessionId}`}
      sessionId={resolution.sessionId}
      workspaceCwd={workspaceCwd}
      clientId={instance.clientId}
      maxQueued={256}
      maxBlocks={WEB_SHELL_MAX_TRANSCRIPT_BLOCKS}
      subagentTranscriptMode="full"
      suppressOwnUserEcho
    >
      <SubagentDetailContent
        rootTool={rootTool}
        resolution={resolution}
        onRightPanelOpen={onRightPanelOpen}
        onArtifactsChange={onArtifactsChange}
        onOpenSubagent={
          onOpenSubagent
            ? (tool, parentSessionId) =>
                onOpenSubagent(
                  tool,
                  parentSessionId ?? resolution?.sessionId ?? sessionId,
                  workspaceCwd,
                )
            : undefined
        }
        onError={onError}
        onStop={
          !subagentClient ||
          (initialRootTool.rawOutput &&
            typeof initialRootTool.rawOutput === 'object' &&
            'workflowRunId' in initialRootTool.rawOutput)
            ? undefined
            : async () => {
                const res = await subagentClient.cancelSubagentSession(
                  sessionId,
                  rootToolCallId,
                );
                await refreshRef.current?.();
                return res;
              }
        }
        onSendMessage={
          !subagentClient ||
          (initialRootTool.rawOutput &&
            typeof initialRootTool.rawOutput === 'object' &&
            'workflowRunId' in initialRootTool.rawOutput)
            ? undefined
            : typeof subagentClient.messageSubagentSession === 'function'
              ? async (message: string) => {
                  const res = await subagentClient.messageSubagentSession(
                    sessionId,
                    rootToolCallId,
                    message,
                  );
                  if (res.delivered) {
                    setResolution((prev) =>
                      prev
                        ? { ...prev, status: res.status || 'running' }
                        : prev,
                    );
                    setPollTrigger((current) => current + 1);
                    await refreshRef.current?.();
                    ensurePollingRef.current?.();
                  }
                  return res;
                }
              : undefined
        }
      />
    </DaemonSessionProvider>
  );
}
