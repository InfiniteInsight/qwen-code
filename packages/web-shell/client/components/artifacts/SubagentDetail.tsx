import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DaemonSessionProvider,
  useConnection,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type { ACPToolCall, Message } from '../../adapters/types';
import { WEB_SHELL_MAX_TRANSCRIPT_BLOCKS } from '../../constants/sessions';
import { useAnimationFrameTranscriptSnapshot } from '../../hooks/useAnimationFrameTranscriptBlocks';
import { useMessagesFromBlocks } from '../../hooks/useMessages';
import { useSessionArtifacts } from '../../hooks/useSessionArtifacts';
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
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `subagent-detail:${suffix}`;
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
  const { blocks, blockChangeSummary } = useAnimationFrameTranscriptSnapshot();
  const messages = useMessagesFromBlocks(t, blocks, blockChangeSummary);
  const { artifacts } = useSessionArtifacts();
  const artifactsByTurn = useMemo(
    () =>
      getArtifactsByTurn(messages, artifacts, connection.workspaceCwd || ''),
    [artifacts, connection.workspaceCwd, messages],
  );
  const fileChangesByTurn = useMemo(
    () =>
      getFileChangesByTurn(
        messages,
        artifactsByTurn,
        connection.workspaceCwd || '',
      ),
    [artifactsByTurn, connection.workspaceCwd, messages],
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

  const handleRightPanelOpen = useCallback(
    (request: TurnOutputOpenRequest) => {
      onRightPanelOpen?.({
        ...request,
        sourceSessionId: connection.sessionId,
      });
    },
    [connection.sessionId, onRightPanelOpen],
  );

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
      try {
        const resolved = await workspace.client.resolveSubagentSession(
          sessionId,
          rootToolCallId,
        );
        if (cancelled) return;
        hasResolved = true;
        retryCount = 0;
        lastResolvedRunning = resolved.status === 'running';
        setResolution(resolved);
        if (resolved.status === 'running') {
          scheduleRefresh(3_000);
        }
      } catch {
        if (cancelled) return;
        if (retryCount < 3) {
          retryCount += 1;
          scheduleRefresh(3_000);
        } else if (!hasResolved) {
          setLoadError(true);
        } else if (lastResolvedRunning) {
          scheduleRefresh(30_000);
        }
      }
    };
    refreshRef.current = refresh;
    ensurePollingRef.current = () => {
      if (cancelled) return;
      lastResolvedRunning = true;
      retryCount = 0;
      if (refreshTimer === undefined) {
        scheduleRefresh(3_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearRefreshTimer();
      if (refreshRef.current === refresh) {
        refreshRef.current = undefined;
      }
      if (ensurePollingRef.current !== undefined) {
        ensurePollingRef.current = undefined;
      }
    };
  }, [instance.key, rootToolCallId, sessionId, workspace.client]);

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
          initialRootTool.rawOutput &&
          typeof initialRootTool.rawOutput === 'object' &&
          'workflowRunId' in initialRootTool.rawOutput
            ? undefined
            : async () => {
                const res = await workspace.client.cancelSubagentSession(
                  sessionId,
                  rootToolCallId,
                );
                await refreshRef.current?.();
                return res;
              }
        }
        onSendMessage={
          initialRootTool.rawOutput &&
          typeof initialRootTool.rawOutput === 'object' &&
          'workflowRunId' in initialRootTool.rawOutput
            ? undefined
            : typeof workspace.client.messageSubagentSession === 'function'
              ? async (message: string) => {
                  const res = await workspace.client.messageSubagentSession(
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
