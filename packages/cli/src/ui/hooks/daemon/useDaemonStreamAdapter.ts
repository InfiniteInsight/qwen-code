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
import { useContext, useEffect, useRef } from 'react';
import { StreamingState } from '../../types.js';
import { isSlashCommand } from '../../utils/commandUtils.js';
import { useDaemonStream, type DaemonPromptBlock } from './useDaemonStream.js';
import { useDaemonSubagentSync } from './use-daemon-subagent-sync.js';
import {
  DaemonLossContext,
  DaemonStreamContext,
  type DaemonAwareStreamHook,
} from './DaemonStreamContext.js';

/**
 * Slash commands that execute locally in an attached daemon TUI tab (either
 * because they drive `context.services.daemon` directly, such as `/model` and
 * `/approval-mode`, or because they are interactive-only UI dialogs/actions).
 * Daemon-session commands (such as `/compress`, `/goal`, `/context`,
 * `/diff`, skills, etc.) are forwarded to `driver.prompt()` so they execute
 * against the daemon's live session.
 */
const LOCAL_DAEMON_TUI_SLASH_COMMANDS = new Set([
  '?',
  'model',
  'approval-mode',
  'effort',
  'btw',
  'stats',
  'usage',
  'tasks',
  'workflows',
  'output-style',
  'advisor',
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

/**
 * Convert a `PartListUnion` into `DaemonPromptBlock[]`, preserving inline
 * image attachments (`inlineData`) while coalescing adjacent text segments.
 */
function toPromptBlocks(query: unknown): DaemonPromptBlock[] {
  if (typeof query === 'string') {
    return [{ type: 'text', text: query }];
  }
  const parts = Array.isArray(query) ? query : [query];
  const blocks: DaemonPromptBlock[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      const last = blocks.at(-1);
      if (last && last.type === 'text') {
        last.text += part;
      } else {
        blocks.push({ type: 'text', text: part });
      }
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (
      'text' in part &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      const text = (part as { text: string }).text;
      const last = blocks.at(-1);
      if (last && last.type === 'text') {
        last.text += text;
      } else {
        blocks.push({ type: 'text', text });
      }
      continue;
    }
    if (
      'inlineData' in part &&
      part.inlineData &&
      typeof part.inlineData === 'object'
    ) {
      const inline = part.inlineData as {
        data?: unknown;
        mimeType?: unknown;
      };
      if (
        typeof inline.data === 'string' &&
        typeof inline.mimeType === 'string'
      ) {
        blocks.push({
          type: 'image',
          data: inline.data,
          mimeType: inline.mimeType,
        });
      }
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

export const useDaemonStreamAdapter: DaemonAwareStreamHook = (
  _geminiClient,
  _history,
  addItem,
  config,
  _isConfigInitialized,
  _settings,
  _onDebugMessage,
  handleSlashCommand,
  shellModeActive,
  _getPreferredEditor,
  _onAuthError,
  _performMemoryRefresh,
  _modelSwitchedFromQuotaError,
  _setModelSwitchedFromQuotaError,
  _onEditorClose,
  _onCancelSubmit,
  _setShellInputFocused,
  _terminalWidth,
  _terminalHeight,
  midTurnDrainRef,
  _logger,
  _availableTerminalHeightRef,
  _terminalWidthRef,
  midTurnRestoreRef,
) => {
  const driver = useContext(DaemonStreamContext);
  if (!driver) {
    throw new Error(
      'useDaemonStreamAdapter requires a DaemonStreamContext driver (attach the session before rendering).',
    );
  }
  const loss = useContext(DaemonLossContext);
  const onSubagentFrame = useDaemonSubagentSync(config, driver);
  const ds = useDaemonStream(
    driver,
    addItem,
    loss ?? undefined,
    onSubagentFrame,
  );
  const streamingStateRef = useRef(ds.streamingState);
  streamingStateRef.current = ds.streamingState;
  const getCurrentStreamingState = () =>
    ds.getStreamingState?.() ?? streamingStateRef.current;

  useEffect(() => {
    if (
      getCurrentStreamingState() !== StreamingState.Responding ||
      typeof driver.enqueueMidTurnMessage !== 'function' ||
      !midTurnDrainRef?.current
    ) {
      return;
    }
    const drained = midTurnDrainRef.current(false);
    if (drained.length === 0) {
      return;
    }
    void (async () => {
      const unaccepted: string[] = [];
      let anyAccepted = false;
      for (let i = 0; i < drained.length; i++) {
        const msg = drained[i]!;
        try {
          const res = await driver.enqueueMidTurnMessage!(msg);
          const accepted =
            res && typeof res === 'object' && 'accepted' in res
              ? (res as { accepted?: unknown }).accepted !== false
              : true;
          if (accepted) {
            anyAccepted = true;
          } else {
            unaccepted.push(msg);
          }
        } catch {
          unaccepted.push(...drained.slice(i));
          break;
        }
      }
      if (anyAccepted && typeof driver.sendMidTurnMessagesNow === 'function') {
        try {
          await driver.sendMidTurnMessagesNow();
        } catch {
          /* daemon injects at next model boundary if immediate nudge fails */
        }
      }
      if (unaccepted.length > 0) {
        midTurnRestoreRef?.current?.(unaccepted);
      }
    })();
  });

  return {
    streamingState: ds.streamingState,
    submitQuery: async (query, _submitType, promptId, metadata) => {
      const text = toText(query);
      const trimmed = text.trim();
      const isBtw =
        /^\/btw(?:\s|$)/i.test(trimmed) && typeof driver.btw === 'function';
      if (!isBtw && getCurrentStreamingState() !== StreamingState.Idle) {
        metadata?.onAdmissionFailed?.();
        metadata?.onDeliveryFailed?.();
        return;
      }
      try {
        if (metadata?.shellMode ?? shellModeActive) {
          if (typeof driver.shellCommand === 'function' && ds.runShellCommand) {
            await ds.runShellCommand(trimmed);
            return;
          }
        }
        if (
          trimmed.toLowerCase() === '/continue' &&
          typeof driver.continueSession === 'function'
        ) {
          await driver.continueSession();
          return;
        }
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
              await ds.clearRemoteSession();
              return;
            }
            if (!slashResult || slashResult.type !== 'submit_prompt') {
              return;
            }
            const promptBlocks = toPromptBlocks(slashResult.content);
            const promptText = toText(slashResult.content);
            const hasImages = promptBlocks.some((b) => b.type !== 'text');
            if (getCurrentStreamingState() !== StreamingState.Idle) {
              if (midTurnRestoreRef?.current) {
                midTurnRestoreRef.current([promptText]);
              } else {
                metadata?.onAdmissionFailed?.();
                metadata?.onDeliveryFailed?.();
              }
              return;
            }
            await ds.submitQuery(hasImages ? promptBlocks : promptText, {
              echoText: promptText,
            });
            return;
          }
        }
        const blocks = toPromptBlocks(query);
        const hasImages = blocks.some((b) => b.type !== 'text');
        await ds.submitQuery(hasImages ? blocks : text, { echoText: text });
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
    clearPendingState: ds.clearPendingState,
    thought: ds.thought,
    cancelOngoingRequest: ds.cancelOngoingRequest,
    // Goal-turn preemption is an in-process admission concern; the daemon
    // session's goal turns are not admitted through this adapter.
    preemptGoalTurn: () => {},
    retryLastPrompt: ds.retryLastPrompt,
    // Live tool display rides pendingHistoryItems tool_group items.
    pendingToolCalls: [],
    handleApprovalModeChange: async (newApprovalMode) => {
      await ds.handleApprovalModeChange(String(newApprovalMode));
    },
    activePtyId: ds.activePtyId,
    loopDetectionConfirmationRequest: ds.loopDetectionConfirmationRequest,
    streamingResponseLengthRef: ds.streamingResponseLengthRef,
    isReceivingContent: ds.isReceivingContent,
    daemonModelId: ds.daemonModelId,
    daemonApprovalMode: ds.daemonApprovalMode,
    daemonSessionTitle: ds.daemonSessionTitle,
  };
};
