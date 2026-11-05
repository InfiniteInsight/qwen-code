/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Adapts `useDaemonStream` to the exact `useLlmStream` signature + return
 * type, so `AppContainer` can render a daemon-hosted session by swapping its
 * `useStream` prop (B-prime). It ignores the gemini-specific inputs, reads the
 * attached driver from {@link DaemonStreamContext}, and maps the daemon hook's
 * output onto the in-process contract.
 *
 * First-milestone scope: text turns. `pendingToolCalls` is returned empty (the
 * live in-progress tool display rides the scheduler's `TrackedToolCall[]`, which
 * this path doesn't produce); daemon tool RESULTS still appear because the
 * reducer commits a `tool_group` history item on `turn_complete`. Live tool
 * display + the permission prompt binding are a following slice.
 */
import { useContext } from 'react';
import { StreamingState } from '../../types.js';
import { isSlashCommand } from '../../utils/commandUtils.js';
import { useDaemonStream } from './useDaemonStream.js';
import {
  DaemonLossContext,
  DaemonStreamContext,
  type DaemonAwareStreamHook,
} from './DaemonStreamContext.js';

/**
 * Slash commands that execute locally in an attached daemon TUI tab (either
 * because they drive `context.services.daemon` directly, such as `/model` and
 * `/approval-mode`, or because they are interactive-only UI dialogs/actions).
 * Daemon-session commands (such as `/compress`, `/goal`, `/btw`, `/context`,
 * `/diff`, skills, etc.) are forwarded to `driver.prompt()` so they execute
 * against the daemon's live session.
 */
const LOCAL_DAEMON_TUI_SLASH_COMMANDS = new Set([
  '?',
  'model',
  'approval-mode',
  'quit',
  'exit',
  'help',
  'theme',
  'vim',
  'copy',
  'about',
  'status',
  'settings',
  'terminal-setup',
  'editor',
  'statusline',
  'permissions',
  'trust',
  'voice',
  'bug',
  'ide',
  'clear',
  'reset',
  'new',
  'rewind',
  'restore',
  'resume',
  'rename',
  'fork',
  'branch',
  'delete',
  'peers',
  'arena',
  'hooks',
  'mcp',
  'agents',
  'memory',
  'plan',
  'setup-github',
  'commit',
  'language',
  'auth',
  'connect',
  'login',
  'cd',
  'history',
  'reload-plugins',
  'recap',
  'tools',
  'rollback',
  'continue',
  'tag',
]);

/** Flatten a `submitQuery` argument (string | Part | Part[]) to plain text. */
function toText(query: unknown): string {
  if (typeof query === 'string') return query;
  if (Array.isArray(query)) {
    return query
      .map((p) =>
        typeof p === 'string'
          ? p
          : p && typeof p === 'object' && 'text' in p
            ? String((p as { text?: unknown }).text ?? '')
            : '',
      )
      .join('');
  }
  if (query && typeof query === 'object' && 'text' in query) {
    return String((query as { text?: unknown }).text ?? '');
  }
  return '';
}

export const useDaemonStreamAdapter: DaemonAwareStreamHook = (
  _geminiClient,
  _history,
  addItem,
  _config,
  _isConfigInitialized,
  _settings,
  _onDebugMessage,
  handleSlashCommand,
) => {
  const driver = useContext(DaemonStreamContext);
  if (!driver) {
    throw new Error(
      'useDaemonStreamAdapter requires a DaemonStreamContext driver (attach the session before rendering).',
    );
  }
  const loss = useContext(DaemonLossContext);
  const ds = useDaemonStream(driver, addItem, loss ?? undefined);

  return {
    streamingState: ds.streamingState,
    submitQuery: async (query, _submitType, promptId, metadata) => {
      if (ds.streamingState !== StreamingState.Idle) {
        metadata?.onAdmissionFailed?.();
        metadata?.onDeliveryFailed?.();
        return;
      }
      const text = toText(query);
      const trimmed = text.trim();
      try {
        if (
          handleSlashCommand &&
          (isSlashCommand(trimmed) || trimmed === '?')
        ) {
          const body = trimmed.replace(/^[/?]/, '').trim();
          const firstToken = (
            body ? body.split(/\s+/u)[0] : trimmed[0]
          )?.toLowerCase();
          if (firstToken && LOCAL_DAEMON_TUI_SLASH_COMMANDS.has(firstToken)) {
            const slashResult = await handleSlashCommand(
              trimmed,
              undefined,
              undefined,
              undefined,
              promptId,
            );
            if (
              (!slashResult || slashResult.type === 'handled') &&
              (firstToken === 'clear' ||
                firstToken === 'reset' ||
                firstToken === 'new')
            ) {
              await driver.prompt({
                prompt: [{ type: 'text', text: '/clear' }],
              });
              return;
            }
            if (!slashResult || slashResult.type !== 'submit_prompt') {
              return;
            }
            await ds.submitQuery(toText(slashResult.content));
            return;
          }
        }
        await ds.submitQuery(text);
      } catch (err) {
        metadata?.onDeliveryFailed?.();
        addItem(
          {
            type: 'error',
            text: err instanceof Error ? err.message : String(err),
          },
          Date.now(),
        );
      }
    },
    initError: ds.initError,
    pendingHistoryItems: ds.pendingHistoryItems,
    // No local pending state to clear: the in-flight turn lives in the daemon.
    clearPendingState: () => {},
    thought: ds.thought,
    cancelOngoingRequest: ds.cancelOngoingRequest,
    // Goal-turn preemption is an in-process admission concern; the daemon
    // session's goal turns are not admitted through this adapter.
    preemptGoalTurn: () => {},
    retryLastPrompt: ds.retryLastPrompt,
    // Live tool display deferred (see file header); results land via history.
    pendingToolCalls: [],
    // Approval-mode switching is a daemon-side concern not wired this slice.
    handleApprovalModeChange: async () => {},
    activePtyId: ds.activePtyId,
    loopDetectionConfirmationRequest: ds.loopDetectionConfirmationRequest,
    streamingResponseLengthRef: ds.streamingResponseLengthRef,
    isReceivingContent: ds.isReceivingContent,
    daemonModelId: ds.daemonModelId,
    daemonApprovalMode: ds.daemonApprovalMode,
  };
};
