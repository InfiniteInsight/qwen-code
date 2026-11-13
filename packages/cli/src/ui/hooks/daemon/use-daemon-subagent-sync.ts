/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Synchronizes subagent tasks from a daemon-hosted session into the local TUI's
 * `BackgroundTaskRegistry` so `--attach-daemon` tabs (e.g. `qwen-rc attach` WSL
 * tabs) populate `LiveAgentPanel`, `BackgroundTasksPill`, and
 * `BackgroundTasksDialog` with live subagent tool calls, speech (`Saying:`),
 * thoughts (`Thinking:`), and interactive controls (cancel, message, resume,
 * abandon). Each mirrored entry carries a `remoteControl` so resume and
 * abandon act on the daemon's agent, never on this process's resume service,
 * which has no sidecar for a mirrored entry (#259).
 */

import { useCallback, useEffect, useRef } from 'react';
import { MAX_RETAINED_TERMINAL_AGENTS } from '@qwen-code/qwen-code-core/agents/background-tasks.js';
import {
  type AgentTask,
  type AgentTaskRemoteActionResult,
  type AgentTaskRemoteControl,
  type BackgroundAgentMessage,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { DaemonFrame } from './projectDaemonEvent.js';

export interface DaemonSubagentTaskSnapshot {
  kind?: 'agent';
  id: string;
  label?: string;
  description: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  startTime: number;
  endTime?: number;
  runtimeMs?: number;
  outputFile?: string;
  subagentType?: string;
  model?: string;
  isBackgrounded: boolean;
  error?: string;
  resumeBlockedReason?: string;
  stats?: { totalTokens: number; toolUses: number; durationMs: number };
  recentActivities?: Array<{ name: string; description: string; at: number }>;
  prompt?: string;
  toolUseId?: string;
  parentAgentId?: string | null;
  parentName?: string;
  depth?: number;
  activityPhase?: 'thinking' | 'tool' | 'responding' | 'waiting_approval';
  latestText?: string;
  latestThought?: string;
  activeTool?: { name: string; description?: string; startedAt: number };
  messages?: BackgroundAgentMessage[];
}

export interface DaemonShellTaskSnapshot {
  kind: 'shell';
  id: string;
  label?: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: number;
  endTime?: number;
  runtimeMs?: number;
  outputFile?: string;
  command: string;
  cwd: string;
  pid?: number;
  exitCode?: number;
  error?: string;
}

export interface DaemonMonitorTaskSnapshot {
  kind: 'monitor';
  id: string;
  label?: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: number;
  endTime?: number;
  runtimeMs?: number;
  command: string;
  pid?: number;
  eventCount: number;
  lastEventTime: number;
  droppedLines: number;
  exitCode?: number;
  error?: string;
  ownerAgentId?: string;
  toolUseId?: string;
}

export type DaemonAnyTaskSnapshot =
  | DaemonSubagentTaskSnapshot
  | DaemonShellTaskSnapshot
  | DaemonMonitorTaskSnapshot;

/** The part of a daemon resume / abandon answer the mirror reads. */
export interface DaemonSubagentControlAnswer {
  outcome: string;
  code?: string;
  reason?: string;
}

export interface DaemonSubagentSyncDriver {
  readonly session?: { readonly sessionId?: string };
  readonly client?: {
    cancelSubagentSession?: (
      parentSessionId: string,
      agentId: string,
    ) => Promise<unknown>;
    messageSubagentSession?: (
      parentSessionId: string,
      agentId: string,
      message: string,
    ) => Promise<unknown>;
    resumeSubagentSession?: (
      parentSessionId: string,
      agentId: string,
      message?: string,
    ) => Promise<DaemonSubagentControlAnswer>;
    abandonSubagentSession?: (
      parentSessionId: string,
      agentId: string,
    ) => Promise<DaemonSubagentControlAnswer>;
  };
  agents?: (
    signal?: AbortSignal,
  ) => Promise<{ tasks?: DaemonSubagentTaskSnapshot[] }>;
  tasks?: () => Promise<{ tasks?: DaemonAnyTaskSnapshot[] }>;
  cancelTask?: (
    taskId: string,
    kind: 'agent' | 'shell' | 'monitor',
  ) => Promise<{ cancelled: boolean }>;
}

const PROVISIONAL_PREFIX = 'daemon-fg-';
const POLL_INTERVAL_MS = 1500;

interface RawSessionUpdate {
  sessionUpdate?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  _meta?: Record<string, unknown>;
}

function extractChunkText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const block = content as { type?: unknown; text?: unknown };
  return block.type === 'text' && typeof block.text === 'string'
    ? block.text
    : '';
}

function isSubagentToolUpdate(update: RawSessionUpdate): boolean {
  const metaName =
    typeof update._meta?.['toolName'] === 'string'
      ? update._meta['toolName'].trim().toLowerCase()
      : '';
  if (metaName === 'agent' || metaName === 'task') {
    return true;
  }
  const titleLower = (update.title ?? '').trim().toLowerCase();
  if (titleLower === 'agent' || titleLower === 'task') {
    return true;
  }
  if (update.rawInput && typeof update.rawInput === 'object') {
    const raw = update.rawInput as Record<string, unknown>;
    if (typeof raw['subagent_type'] === 'string') {
      return true;
    }
  }
  if (update.rawOutput && typeof update.rawOutput === 'object') {
    const out = update.rawOutput as Record<string, unknown>;
    if (out['type'] === 'task_execution') {
      return true;
    }
  }
  return false;
}

function describeToolUpdate(update: RawSessionUpdate): {
  name: string;
  description: string;
} {
  const metaName =
    typeof update._meta?.['toolName'] === 'string'
      ? update._meta['toolName'].trim()
      : '';
  const raw =
    update.rawInput && typeof update.rawInput === 'object'
      ? (update.rawInput as Record<string, unknown>)
      : undefined;
  const title = (update.title ?? '').trim();
  const name =
    metaName ||
    title.split(/\s+/u)[0] ||
    (typeof update.kind === 'string' ? update.kind : '') ||
    'Tool';
  const descCandidate =
    (typeof raw?.['description'] === 'string' ? raw['description'] : '') ||
    (typeof raw?.['command'] === 'string' ? raw['command'] : '') ||
    (typeof raw?.['file_path'] === 'string' ? raw['file_path'] : '') ||
    (typeof raw?.['path'] === 'string' ? raw['path'] : '') ||
    (typeof raw?.['pattern'] === 'string' ? raw['pattern'] : '') ||
    (title && title !== name ? title : '');
  return { name, description: descCandidate };
}

function describeControlFailure(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

/** The daemon's refusal as the mirror reports it, naming its cause. */
function refusalFrom(
  answer: DaemonSubagentControlAnswer | undefined,
  fallback: string,
): AgentTaskRemoteActionResult {
  return {
    ok: false,
    ...(answer?.code ? { code: answer.code } : {}),
    reason: answer?.reason || fallback,
  };
}

function flushStreamingBuffersToMessages(entry: AgentTask, now: number): void {
  const thought = entry.liveThought?.trim();
  if (thought) {
    entry.messages = [
      ...(entry.messages ?? []),
      {
        role: 'assistant',
        content: thought,
        timestamp: now,
        thought: true,
      },
    ];
    entry.latestThought = thought;
    entry.liveThought = undefined;
  }
  const text = entry.liveText?.trim();
  if (text) {
    entry.messages = [
      ...(entry.messages ?? []),
      {
        role: 'assistant',
        content: text,
        timestamp: now,
      },
    ];
    entry.latestText = text;
    entry.liveText = undefined;
  }
}

export function useDaemonSubagentSync(
  config: Config | undefined,
  driver: DaemonSubagentSyncDriver,
): (frame: DaemonFrame) => void {
  const syncingAbortIdsRef = useRef(new Set<string>());
  const residentLoopsRef = useRef(new Set<string>());
  // Abort controllers already forwarding cancel to the daemon: a resumed
  // agent flips back to running on the same entry, and a second listener
  // would cancel it twice.
  const cancelWiredRef = useRef(new WeakSet<AbortController>());
  // Agents abandoned from this tab. A roster fetched before the daemon
  // applied the abandon must not bring one back.
  const abandonedIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);
  // `refreshAgents` is declared below and depends on `reconcileTasks`, which
  // builds the remote controls; the controls reach it through this ref.
  const refreshAgentsRef = useRef<() => void>(() => {});

  const remoteControlFor = useCallback(
    (agentId: string): AgentTaskRemoteControl => ({
      resume: async (message) => {
        const sessionId = driver.session?.sessionId;
        const client = driver.client;
        if (!sessionId || !client?.resumeSubagentSession) {
          return {
            ok: false,
            reason: 'This daemon connection cannot resume subagents.',
          };
        }
        let answer: DaemonSubagentControlAnswer;
        try {
          answer = await client.resumeSubagentSession(
            sessionId,
            agentId,
            message,
          );
        } catch (error) {
          return { ok: false, reason: describeControlFailure(error) };
        }
        if (answer?.outcome !== 'resumed') {
          return refusalFrom(answer, 'The daemon did not resume the agent.');
        }
        refreshAgentsRef.current();
        return { ok: true };
      },
      abandon: async () => {
        const sessionId = driver.session?.sessionId;
        const client = driver.client;
        if (!sessionId || !client?.abandonSubagentSession) {
          return {
            ok: false,
            reason: 'This daemon connection cannot abandon subagents.',
          };
        }
        let answer: DaemonSubagentControlAnswer;
        try {
          answer = await client.abandonSubagentSession(sessionId, agentId);
        } catch (error) {
          return { ok: false, reason: describeControlFailure(error) };
        }
        if (answer?.outcome !== 'abandoned') {
          return refusalFrom(answer, 'The daemon did not abandon the agent.');
        }
        // The daemon's roster no longer lists it; drop the mirror now.
        abandonedIdsRef.current.add(agentId);
        config?.getBackgroundTaskRegistry?.().removeEntry(agentId);
        return { ok: true };
      },
    }),
    [config, driver],
  );

  const wireCancelAndMessaging = useCallback(
    (
      agentId: string,
      abortController: AbortController,
      isProvisional: boolean,
    ) => {
      if (isProvisional) return;
      const registry = config?.getBackgroundTaskRegistry?.();
      if (!registry) return;

      // A controller already forwarding cancel keeps its one listener; only
      // the resident loop below may need a restart.
      if (!cancelWiredRef.current.has(abortController)) {
        cancelWiredRef.current.add(abortController);
        abortController.signal.addEventListener(
          'abort',
          () => {
            if (syncingAbortIdsRef.current.has(agentId)) return;
            const sessionId = driver.session?.sessionId;
            if (driver.cancelTask) {
              void driver.cancelTask(agentId, 'agent').catch(() => {
                if (sessionId && driver.client?.cancelSubagentSession) {
                  void driver.client
                    .cancelSubagentSession(sessionId, agentId)
                    .catch(() => {});
                }
              });
            } else if (sessionId && driver.client?.cancelSubagentSession) {
              void driver.client
                .cancelSubagentSession(sessionId, agentId)
                .catch(() => {});
            }
          },
          { once: true },
        );
      }

      if (!residentLoopsRef.current.has(agentId)) {
        residentLoopsRef.current.add(agentId);
        registry.registerResidentAgent(agentId, {
          continue: (input) => {
            registry.queueExternalInput(agentId, input);
            return 'continued';
          },
          dispose: () => {},
        });
        void (async () => {
          try {
            while (mountedRef.current && !abortController.signal.aborted) {
              const current = registry.get(agentId);
              if (
                !current ||
                (current.status !== 'running' &&
                  !(current.status === 'completed' && current.isBackgrounded))
              ) {
                break;
              }
              const msgs = await registry.waitForMessages(
                agentId,
                abortController.signal,
              );
              if (!msgs || msgs.length === 0) break;
              const sessionId = driver.session?.sessionId;
              if (!sessionId || !driver.client?.messageSubagentSession) {
                continue;
              }
              for (const msg of msgs) {
                const rawText =
                  typeof msg === 'string'
                    ? msg
                    : msg &&
                        typeof msg === 'object' &&
                        'text' in msg &&
                        typeof (msg as { text?: unknown }).text === 'string'
                      ? (msg as { text: string }).text
                      : '';
                const text = rawText.trim();
                if (!text) continue;
                try {
                  await driver.client.messageSubagentSession(
                    sessionId,
                    agentId,
                    text,
                  );
                } catch {
                  // Ignore transient message delivery failures; daemon state will reconcile.
                }
              }
            }
          } finally {
            residentLoopsRef.current.delete(agentId);
            registry.unregisterResidentAgent(agentId);
          }
        })();
      }
    },
    [config, driver],
  );

  const reconcileTasks = useCallback(
    (
      tasks: DaemonSubagentTaskSnapshot[],
      options: { fullRoster?: boolean } = {},
    ) => {
      const registry = config?.getBackgroundTaskRegistry?.();
      if (!registry) return;

      for (const task of tasks) {
        if (!task || typeof task.id !== 'string' || !task.id) continue;
        if (abandonedIdsRef.current.has(task.id)) continue;

        // If a provisional foreground entry was created for this toolUseId before
        // `driver.agents()` resolved the daemon's real agent id, remove the
        // provisional duplicate and transfer any live streaming buffers.
        let transferredLiveText: string | undefined;
        let transferredLiveThought: string | undefined;
        if (task.toolUseId) {
          const provisionalId = `${PROVISIONAL_PREFIX}${task.toolUseId}`;
          if (provisionalId !== task.id) {
            const prov = registry.get(provisionalId);
            if (prov) {
              transferredLiveText = prov.liveText;
              transferredLiveThought = prov.liveThought;
              registry.removeEntry(provisionalId);
            }
          }
        }

        let entry = registry.get(task.id);
        if (!entry) {
          const abortController = new AbortController();
          entry = registry.register(
            {
              agentId: task.id,
              description: task.description || task.label || task.id,
              subagentType: task.subagentType,
              model: task.model,
              status: task.status === 'running' ? 'running' : 'running',
              startTime:
                typeof task.startTime === 'number' && task.startTime > 0
                  ? task.startTime
                  : Date.now(),
              outputFile: task.outputFile ?? '',
              abortController,
              isBackgrounded: Boolean(task.isBackgrounded),
              prompt: task.prompt,
              toolUseId: task.toolUseId,
              parentAgentId: task.parentAgentId ?? null,
              parentName: task.parentName,
              depth: task.depth,
            },
            {
              bypassConcurrencyCheck: true,
              suppressRegisterCallback: true,
              preserveNotificationState: true,
            },
          );
          if (task.status === 'running') {
            wireCancelAndMessaging(task.id, abortController, false);
          }
        }
        if (!entry.remoteControl) {
          entry.remoteControl = remoteControlFor(task.id);
        }

        entry.description = task.description || entry.description;
        if (task.subagentType !== undefined) {
          entry.subagentType = task.subagentType;
        }
        if (task.model !== undefined) {
          entry.model = task.model;
        }
        if (task.outputFile !== undefined) {
          entry.outputFile = task.outputFile;
        }
        entry.isBackgrounded = Boolean(task.isBackgrounded);
        if (typeof task.startTime === 'number' && task.startTime > 0) {
          entry.startTime = task.startTime;
        }
        if (task.toolUseId !== undefined) {
          entry.toolUseId = task.toolUseId;
        }
        if (task.prompt !== undefined) {
          entry.prompt = task.prompt;
        }
        if (task.parentAgentId !== undefined) {
          entry.parentAgentId = task.parentAgentId ?? null;
        }
        if (task.parentName !== undefined) {
          entry.parentName = task.parentName;
        }
        if (task.depth !== undefined) {
          entry.depth = task.depth;
        }
        if (task.stats) {
          entry.stats = {
            outputTokens: 0,
            ...task.stats,
          };
        }
        if (task.recentActivities && task.recentActivities.length > 0) {
          entry.recentActivities = task.recentActivities.map((a) => ({
            name: a.name,
            description: a.description,
            at: a.at,
          }));
        }
        if (task.activityPhase !== undefined) {
          entry.activityPhase = task.activityPhase;
        }
        if (task.activeTool !== undefined) {
          entry.activeTool = task.activeTool
            ? {
                name: task.activeTool.name,
                description: task.activeTool.description ?? '',
              }
            : undefined;
        }
        if (task.latestText !== undefined) {
          entry.latestText = task.latestText;
        }
        if (task.latestThought !== undefined) {
          entry.latestThought = task.latestThought;
        }
        if (transferredLiveText && !entry.liveText) {
          entry.liveText = transferredLiveText;
        }
        if (transferredLiveThought && !entry.liveThought) {
          entry.liveThought = transferredLiveThought;
        }
        if (task.messages && task.messages.length > 0) {
          entry.messages = task.messages.map((m) => ({ ...m }));
        }

        if (task.status !== entry.status) {
          if (!task.messages?.length) {
            flushStreamingBuffersToMessages(entry, Date.now());
          }
          if (task.status === 'completed') {
            registry.complete(task.id, task.latestText ?? '');
          } else if (task.status === 'failed') {
            registry.fail(task.id, task.error ?? 'Subagent failed');
          } else if (task.status === 'cancelled') {
            syncingAbortIdsRef.current.add(task.id);
            try {
              registry.cancel(task.id);
            } finally {
              syncingAbortIdsRef.current.delete(task.id);
            }
          } else if (task.status === 'paused') {
            entry.status = 'paused';
            entry.error = task.error;
            entry.resumeBlockedReason = task.resumeBlockedReason;
            registry.notifyActivityChange(task.id);
          } else if (task.status === 'running') {
            entry.status = 'running';
            entry.endTime = undefined;
            wireCancelAndMessaging(task.id, entry.abortController, false);
          }
          if (task.endTime !== undefined) {
            entry.endTime = task.endTime;
          }
          if (task.messages && task.messages.length > 0) {
            entry.messages = task.messages.map((m) => ({ ...m }));
          }
        } else {
          if (task.endTime !== undefined) {
            entry.endTime = task.endTime;
          }
          registry.notifyActivityChange(task.id);
        }
      }

      // A paused agent the daemon's full roster no longer lists was abandoned
      // there (from the phone, or by the model's task_stop): drop the mirror
      // so it does not stay listed here. The roster keeps only the newest
      // MAX_RETAINED_TERMINAL_AGENTS paused agents, so a full paused list
      // proves nothing about one it left out; prune only below the cap.
      const listedPaused = tasks.filter(
        (task) => task?.status === 'paused',
      ).length;
      if (options.fullRoster && listedPaused < MAX_RETAINED_TERMINAL_AGENTS) {
        const listed = new Set(tasks.map((task) => task?.id));
        for (const entry of registry.getAll()) {
          if (
            entry.remoteControl &&
            entry.status === 'paused' &&
            !listed.has(entry.id)
          ) {
            registry.removeEntry(entry.id);
          }
        }
      }
    },
    [config, wireCancelAndMessaging, remoteControlFor],
  );

  const reconcileProcessTasks = useCallback(
    (tasks: DaemonAnyTaskSnapshot[]) => {
      const shellRegistry = config?.getBackgroundShellRegistry?.();
      const monitorRegistry = config?.getMonitorRegistry?.();
      for (const task of tasks) {
        if (!task || typeof task.id !== 'string' || !task.id) continue;
        if (task.kind === 'shell' && shellRegistry) {
          let entry = shellRegistry.get(task.id);
          if (!entry) {
            const abortController = new AbortController();
            abortController.signal.addEventListener(
              'abort',
              () => {
                if (syncingAbortIdsRef.current.has(task.id)) return;
                if (driver.cancelTask) {
                  void driver.cancelTask(task.id, 'shell').catch(() => {});
                }
              },
              { once: true },
            );
            entry = shellRegistry.register({
              shellId: task.id,
              command: task.command || task.description || task.id,
              cwd: task.cwd || '',
              pid: task.pid,
              status: 'running',
              startTime:
                typeof task.startTime === 'number' && task.startTime > 0
                  ? task.startTime
                  : Date.now(),
              outputPath: task.outputFile ?? '',
              abortController,
            });
          }
          if (task.pid !== undefined) {
            entry.pid = task.pid;
          }
          if (task.outputFile !== undefined) {
            entry.outputFile = task.outputFile;
            entry.outputPath = task.outputFile;
          }
          if (task.status !== entry.status) {
            const endTime = task.endTime ?? Date.now();
            if (task.status === 'completed') {
              shellRegistry.complete(task.id, task.exitCode ?? 0, endTime);
            } else if (task.status === 'failed') {
              shellRegistry.fail(
                task.id,
                task.error ?? 'Shell task failed',
                endTime,
              );
            } else if (task.status === 'cancelled') {
              syncingAbortIdsRef.current.add(task.id);
              try {
                shellRegistry.cancel(task.id, endTime);
              } finally {
                syncingAbortIdsRef.current.delete(task.id);
              }
            }
          }
        } else if (task.kind === 'monitor' && monitorRegistry) {
          let entry = monitorRegistry.get(task.id);
          if (!entry) {
            const abortController = new AbortController();
            abortController.signal.addEventListener(
              'abort',
              () => {
                if (syncingAbortIdsRef.current.has(task.id)) return;
                if (driver.cancelTask) {
                  void driver.cancelTask(task.id, 'monitor').catch(() => {});
                }
              },
              { once: true },
            );
            try {
              entry = monitorRegistry.register({
                monitorId: task.id,
                command: task.command || task.description || task.id,
                description: task.description || task.command || task.id,
                status: 'running',
                pid: task.pid,
                toolUseId: task.toolUseId,
                ownerAgentId: task.ownerAgentId,
                eventCount: task.eventCount ?? 0,
                lastEventTime: task.lastEventTime ?? Date.now(),
                maxEvents: 1000,
                idleTimeoutMs: 0,
                droppedLines: task.droppedLines ?? 0,
                startTime:
                  typeof task.startTime === 'number' && task.startTime > 0
                    ? task.startTime
                    : Date.now(),
                outputFile: '',
                abortController,
              });
            } catch {
              continue;
            }
          }
          if (task.pid !== undefined) entry.pid = task.pid;
          if (typeof task.eventCount === 'number') {
            entry.eventCount = task.eventCount;
          }
          if (typeof task.lastEventTime === 'number') {
            entry.lastEventTime = task.lastEventTime;
          }
          if (typeof task.droppedLines === 'number') {
            entry.droppedLines = task.droppedLines;
          }
          if (task.status !== entry.status) {
            if (task.status === 'completed') {
              monitorRegistry.complete(task.id, task.exitCode ?? null);
            } else if (task.status === 'failed') {
              monitorRegistry.fail(task.id, task.error ?? 'Monitor failed');
            } else if (task.status === 'cancelled') {
              syncingAbortIdsRef.current.add(task.id);
              try {
                monitorRegistry.cancel(task.id, { notify: false });
              } finally {
                syncingAbortIdsRef.current.delete(task.id);
              }
            }
            if (task.endTime !== undefined) {
              entry.endTime = task.endTime;
            }
          }
        }
      }
    },
    [config, driver],
  );

  const refreshAgents = useCallback(() => {
    const canSyncAgents =
      typeof config?.getBackgroundTaskRegistry === 'function' &&
      typeof driver.agents === 'function';
    const canSyncTasks =
      (typeof config?.getBackgroundShellRegistry === 'function' ||
        typeof config?.getMonitorRegistry === 'function') &&
      typeof driver.tasks === 'function';
    if (!canSyncAgents && !canSyncTasks) {
      return;
    }
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    const run = async () => {
      try {
        const [agentsRes, tasksRes] = await Promise.all([
          canSyncAgents
            ? driver.agents?.().catch(() => undefined)
            : Promise.resolve(undefined),
          canSyncTasks
            ? driver.tasks?.().catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
        if (!mountedRef.current) return;
        if (agentsRes && Array.isArray(agentsRes.tasks)) {
          reconcileTasks(agentsRes.tasks, { fullRoster: true });
        }
        if (tasksRes && Array.isArray(tasksRes.tasks)) {
          reconcileProcessTasks(tasksRes.tasks);
          if (
            !canSyncAgents &&
            typeof config?.getBackgroundTaskRegistry === 'function'
          ) {
            const agentSnapshots = tasksRes.tasks.filter(
              (t): t is DaemonSubagentTaskSnapshot =>
                !t.kind || t.kind === 'agent',
            );
            if (agentSnapshots.length > 0) {
              reconcileTasks(agentSnapshots);
            }
          }
        }
      } catch {
        // Best-effort sync; ignore unsupported or transient errors.
      } finally {
        refreshInFlightRef.current = null;
        if (refreshQueuedRef.current && mountedRef.current) {
          refreshQueuedRef.current = false;
          refreshAgents();
        }
      }
    };
    refreshInFlightRef.current = run();
  }, [config, driver, reconcileTasks, reconcileProcessTasks]);
  useEffect(() => {
    refreshAgentsRef.current = refreshAgents;
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    refreshAgents();
    if (
      typeof config?.getBackgroundTaskRegistry !== 'function' ||
      (typeof driver.agents !== 'function' &&
        typeof driver.tasks !== 'function')
    ) {
      return () => {
        mountedRef.current = false;
      };
    }
    const registry = config.getBackgroundTaskRegistry();
    const shellRegistry = config.getBackgroundShellRegistry?.();
    const monitorRegistry = config.getMonitorRegistry?.();
    const timer = setInterval(() => {
      const hasRunning =
        registry.getAll().some((a) => a.status === 'running') ||
        (shellRegistry?.getAll().some((s) => s.status === 'running') ??
          false) ||
        (monitorRegistry?.getAll().some((m) => m.status === 'running') ??
          false);
      if (hasRunning) {
        refreshAgents();
      }
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [config, driver, refreshAgents]);

  const onDaemonFrame = useCallback(
    (frame: DaemonFrame) => {
      const registry = config?.getBackgroundTaskRegistry?.();
      if (!registry) return;

      if (frame.type === 'task_changed') {
        refreshAgents();
        return;
      }

      if (frame.type !== 'session_update') return;
      const update = (frame.data as { update?: RawSessionUpdate })?.update;
      if (!update || typeof update.sessionUpdate !== 'string') return;

      const parentToolCallId =
        typeof update._meta?.['parentToolCallId'] === 'string'
          ? update._meta['parentToolCallId']
          : undefined;

      if (parentToolCallId) {
        let entry = registry
          .getAll()
          .find(
            (a) =>
              a.toolUseId === parentToolCallId ||
              a.id === parentToolCallId ||
              a.id === `${PROVISIONAL_PREFIX}${parentToolCallId}`,
          );
        if (!entry) {
          const provisionalId = `${PROVISIONAL_PREFIX}${parentToolCallId}`;
          entry = registry.register(
            {
              agentId: provisionalId,
              description: 'Running subagent...',
              status: 'running',
              startTime: Date.now(),
              outputFile: '',
              abortController: new AbortController(),
              isBackgrounded: false,
              toolUseId: parentToolCallId,
            },
            {
              bypassConcurrencyCheck: true,
              suppressRegisterCallback: true,
              preserveNotificationState: true,
            },
          );
          refreshAgents();
        }

        const kind = update.sessionUpdate;
        if (kind === 'agent_thought_chunk') {
          const delta = extractChunkText(update.content);
          if (delta) {
            if (entry.liveText?.trim()) {
              flushStreamingBuffersToMessages(entry, Date.now());
            }
            entry.liveThought = (entry.liveThought ?? '') + delta;
            entry.latestThought =
              entry.liveThought.trim() || entry.latestThought;
            entry.activityPhase = 'thinking';
            registry.notifyActivityChange(entry.id);
          }
          return;
        }
        if (kind === 'agent_message_chunk') {
          const delta = extractChunkText(update.content);
          if (delta) {
            const thought = entry.liveThought?.trim();
            if (thought) {
              entry.messages = [
                ...(entry.messages ?? []),
                {
                  role: 'assistant',
                  content: thought,
                  timestamp: Date.now(),
                  thought: true,
                },
              ];
              entry.latestThought = thought;
              entry.liveThought = undefined;
            }
            entry.liveText = (entry.liveText ?? '') + delta;
            entry.latestText = entry.liveText.trim() || entry.latestText;
            entry.activityPhase = 'responding';
            registry.notifyActivityChange(entry.id);
          }
          return;
        }
        if (kind === 'tool_call') {
          const now = Date.now();
          flushStreamingBuffersToMessages(entry, now);
          const { name, description } = describeToolUpdate(update);
          entry.activityPhase = 'tool';
          entry.activeTool = { name, description };
          registry.appendActivity(entry.id, {
            name,
            description,
            at: now,
          });
          return;
        }
        if (kind === 'tool_call_update') {
          if (
            update.status === 'completed' ||
            update.status === 'failed' ||
            update.status === 'cancelled'
          ) {
            entry.activeTool = undefined;
            registry.notifyActivityChange(entry.id);
          }
          return;
        }
        return;
      }

      // Top-level tool_call / tool_call_update in the parent session: detect
      // subagent launches (`agent` / `task`) so the panel and pill react
      // immediately even before `driver.agents()` resolves.
      if (
        update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update'
      ) {
        const callId = update.toolCallId;
        if (!callId) return;
        const existing = registry
          .getAll()
          .find(
            (a) =>
              a.toolUseId === callId ||
              a.id === `${PROVISIONAL_PREFIX}${callId}`,
          );
        if (!existing && !isSubagentToolUpdate(update)) {
          return;
        }

        const raw =
          update.rawInput && typeof update.rawInput === 'object'
            ? (update.rawInput as Record<string, unknown>)
            : undefined;
        const subagentType =
          typeof raw?.['subagent_type'] === 'string'
            ? raw['subagent_type']
            : undefined;
        const description =
          (typeof raw?.['description'] === 'string'
            ? raw['description']
            : '') ||
          existing?.description ||
          subagentType ||
          'Running subagent...';
        const prompt =
          typeof raw?.['prompt'] === 'string' ? raw['prompt'] : undefined;
        const runInBackground = raw?.['run_in_background'] === true;

        let target = existing;
        if (
          !target &&
          update.status !== 'completed' &&
          update.status !== 'failed' &&
          update.status !== 'cancelled'
        ) {
          target = registry.register(
            {
              agentId: `${PROVISIONAL_PREFIX}${callId}`,
              description,
              subagentType,
              status: 'running',
              startTime: Date.now(),
              outputFile: '',
              abortController: new AbortController(),
              isBackgrounded: runInBackground,
              prompt,
              toolUseId: callId,
            },
            {
              bypassConcurrencyCheck: true,
              suppressRegisterCallback: true,
              preserveNotificationState: true,
            },
          );
        } else if (target) {
          if (subagentType && !target.subagentType) {
            target.subagentType = subagentType;
          }
          if (
            description &&
            (target.description === 'Running subagent...' ||
              !target.description)
          ) {
            target.description = description;
          }
          if (prompt && !target.prompt) {
            target.prompt = prompt;
          }
          registry.notifyActivityChange(target.id);
        }

        if (
          update.status === 'completed' ||
          update.status === 'failed' ||
          update.status === 'cancelled'
        ) {
          if (target) {
            flushStreamingBuffersToMessages(target, Date.now());
          }
          if (
            target &&
            target.id.startsWith(PROVISIONAL_PREFIX) &&
            !target.isBackgrounded
          ) {
            if (update.status === 'completed') {
              registry.complete(target.id, target.latestText ?? '');
            } else if (update.status === 'failed') {
              registry.fail(target.id, 'Subagent failed');
            } else {
              registry.cancel(target.id);
            }
          }
        }

        refreshAgents();
      }
    },
    [config, refreshAgents],
  );

  return onDaemonFrame;
}
