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
 * thoughts (`Thinking:`), and interactive controls (cancel + message).
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  type AgentTask,
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
  };
  agents?: (
    signal?: AbortSignal,
  ) => Promise<{ tasks?: DaemonSubagentTaskSnapshot[] }>;
  cancelTask?: (
    taskId: string,
    kind: 'agent',
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
  const mountedRef = useRef(true);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);

  const wireCancelAndMessaging = useCallback(
    (
      agentId: string,
      abortController: AbortController,
      isProvisional: boolean,
    ) => {
      if (isProvisional) return;
      const registry = config?.getBackgroundTaskRegistry?.();
      if (!registry) return;

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
    (tasks: DaemonSubagentTaskSnapshot[]) => {
      const registry = config?.getBackgroundTaskRegistry?.();
      if (!registry) return;

      for (const task of tasks) {
        if (!task || typeof task.id !== 'string' || !task.id) continue;

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
    },
    [config, wireCancelAndMessaging],
  );

  const refreshAgents = useCallback(() => {
    if (
      typeof config?.getBackgroundTaskRegistry !== 'function' ||
      typeof driver.agents !== 'function'
    ) {
      return;
    }
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    const run = async () => {
      try {
        const res = await driver.agents?.();
        if (!mountedRef.current) return;
        if (res && Array.isArray(res.tasks)) {
          reconcileTasks(res.tasks);
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
  }, [config, driver, reconcileTasks]);

  useEffect(() => {
    mountedRef.current = true;
    refreshAgents();
    if (
      typeof config?.getBackgroundTaskRegistry !== 'function' ||
      typeof driver.agents !== 'function'
    ) {
      return () => {
        mountedRef.current = false;
      };
    }
    const registry = config.getBackgroundTaskRegistry();
    const timer = setInterval(() => {
      const hasRunning = registry.getAll().some((a) => a.status === 'running');
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
