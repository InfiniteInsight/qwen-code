/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridge a daemon `permission_request` to the in-process confirmation UI.
 *
 * The TUI's `ToolConfirmationMessage` renders a fixed set of
 * {@link ToolConfirmationOutcome}s per `confirmationDetails.type` and calls
 * `onConfirm(outcome)`. A daemon gate, by contrast, exposes an opaque set of
 * `{ optionId, kind }` options and is answered over HTTP. This module maps
 * between the two:
 *
 * - {@link outcomeToOptionId} translates the user's chosen outcome to the
 *   daemon `optionId` to vote, driven by each option's ACP **`kind`** (NOT its
 *   opaque id), so it works for any tool's option set.
 * - {@link buildDaemonConfirmation} produces a `confirmationDetails` whose
 *   `onConfirm` performs that mapping and posts the vote.
 *
 * Option `kind`s are the ACP set built in
 * `packages/cli/src/acp-integration/session/permissionUtils.ts`
 * (`allow_once` / `allow_always` / `reject_once` / `reject_always`).
 */
import { basename } from 'node:path';
import * as Diff from 'diff';
import {
  ToolConfirmationOutcome,
  type ToolAskUserQuestionConfirmationDetails,
  type ToolCallConfirmationDetails,
  type ToolConfirmationPayload,
} from '@qwen-code/qwen-code-core/tools/tools.js';
import type { PendingPermission } from './projectDaemonEvent.js';

type OptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/**
 * Map an in-process {@link ToolConfirmationOutcome} to the daemon `optionId` to
 * vote. First checks for an exact `optionId === outcome` match (so scoped
 * options like `proceed_always_user`, `proceed_always_project`,
 * `restore_previous`, and `proceed_once_and_switch_to_default` preserve their
 * exact scope), then falls back to matching the desired ACP `kind` against the
 * gate's options. Returns `null` when no suitable option exists.
 */
export function outcomeToOptionId(
  outcome: ToolConfirmationOutcome,
  options: PendingPermission['options'],
): string | null {
  const exact = options.find((o) => o.optionId === outcome);
  if (exact) return exact.optionId;

  const find = (...kinds: OptionKind[]): string | null => {
    for (const k of kinds) {
      const opt = options.find((o) => o['kind'] === k);
      if (opt) return opt.optionId;
    }
    return null;
  };
  switch (outcome) {
    case ToolConfirmationOutcome.ProceedOnce:
    case ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault:
      return find('allow_once', 'allow_always');
    case ToolConfirmationOutcome.ProceedAlways:
    case ToolConfirmationOutcome.ProceedAlwaysProject:
    case ToolConfirmationOutcome.ProceedAlwaysUser:
    case ToolConfirmationOutcome.ProceedAlwaysServer:
    case ToolConfirmationOutcome.ProceedAlwaysTool:
      return find('allow_always', 'allow_once');
    case ToolConfirmationOutcome.Cancel:
    case ToolConfirmationOutcome.ModifyWithEditor:
    case ToolConfirmationOutcome.RestorePrevious:
    default:
      return find('reject_once', 'reject_always');
  }
}

function normalizeUserQuestions(
  raw: unknown,
): ToolAskUserQuestionConfirmationDetails['questions'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const q = asRecord(entry);
      const question = typeof q['question'] === 'string' ? q['question'] : '';
      const header = typeof q['header'] === 'string' ? q['header'] : '';
      const rawOptions = Array.isArray(q['options'])
        ? (q['options'] as unknown[])
        : [];
      const options = rawOptions
        .map((opt) => {
          const o = asRecord(opt);
          const label = typeof o['label'] === 'string' ? o['label'] : '';
          const description =
            typeof o['description'] === 'string' ? o['description'] : '';
          return label ? { label, description } : null;
        })
        .filter(
          (
            item,
          ): item is {
            label: string;
            description: string;
          } => item !== null,
        );
      if (!question) return null;
      return {
        question,
        header,
        options,
        ...(typeof q['multiSelect'] === 'boolean'
          ? { multiSelect: q['multiSelect'] }
          : {}),
      };
    })
    .filter(
      (
        item,
      ): item is ToolAskUserQuestionConfirmationDetails['questions'][number] =>
        item !== null,
    );
}

/**
 * Build a `confirmationDetails` for a daemon permission gate. Inspects
 * `gate.toolCall` (`kind`, `_meta.toolName`, `content`, `rawInput`, `_meta`) to
 * construct the appropriate rich confirmation type (`edit`, `exec`, `plan`,
 * `ask_user_question`, `mcp`, or `info`) so the daemon-attached TUI renders the
 * exact same confirmation prompts as standalone `qwen`.
 */
export function buildDaemonConfirmation(
  gate: PendingPermission,
  respond: (
    optionId: string | null,
    payload?: ToolConfirmationPayload,
  ) => Promise<void>,
): ToolCallConfirmationDetails {
  const title = gate.title ?? 'Tool approval requested';
  const onConfirm = async (
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
  ) => {
    const optionId = outcomeToOptionId(outcome, gate.options);
    if (payload !== undefined) {
      await respond(optionId, payload);
    } else {
      await respond(optionId);
    }
  };

  if (!gate.toolCall) {
    return {
      type: 'info',
      title,
      prompt: title,
      onConfirm,
    };
  }

  const toolCall = gate.toolCall;
  const rawInput = asRecord(toolCall['rawInput']);
  const meta = asRecord(toolCall['_meta']);
  const toolName = typeof meta['toolName'] === 'string' ? meta['toolName'] : '';
  const kind = typeof toolCall['kind'] === 'string' ? toolCall['kind'] : '';
  const contentBlocks = Array.isArray(toolCall['content'])
    ? (toolCall['content'] as unknown[]).map(asRecord)
    : [];
  const textBlocks = contentBlocks
    .map((b) => {
      if (b['type'] !== 'content') return '';
      const inner = asRecord(b['content']);
      return inner['type'] === 'text' && typeof inner['text'] === 'string'
        ? inner['text']
        : '';
    })
    .filter((t) => t.length > 0);
  const diffBlock = contentBlocks.find(
    (b) => b['type'] === 'diff' && typeof b['newText'] === 'string',
  );
  const hasAllowAlways = gate.options.some((o) => o['kind'] === 'allow_always');
  const hideAlwaysAllow = !hasAllowAlways;

  // 1. ask_user_question interactive questionnaire
  const rawQuestions = meta['qwenQuestions'] ?? rawInput['questions'];
  if (
    meta['qwenInteractionKind'] === 'user_question' ||
    toolName === 'ask_user_question' ||
    Array.isArray(rawQuestions)
  ) {
    const questions = normalizeUserQuestions(rawQuestions);
    if (questions.length > 0) {
      return {
        type: 'ask_user_question',
        title,
        questions,
        onConfirm,
      };
    }
  }

  // 2. exit_plan_mode / plan confirmation
  const restoreOpt = gate.options.find(
    (o) => o.optionId === ToolConfirmationOutcome.RestorePrevious,
  );
  if (
    kind === 'switch_mode' ||
    toolName === 'exit_plan_mode' ||
    restoreOpt !== undefined
  ) {
    const plan =
      textBlocks[0] ??
      (typeof rawInput['plan'] === 'string' ? rawInput['plan'] : title);
    const restoreName =
      typeof restoreOpt?.['name'] === 'string' ? restoreOpt['name'] : '';
    const modeMatch = restoreName.match(/\(([^)]+)\)\s*$/u);
    const prePlanMode = modeMatch?.[1]?.trim();
    return {
      type: 'plan',
      title,
      plan,
      ...(prePlanMode ? { prePlanMode } : {}),
      hideAlwaysAllow,
      onConfirm,
    };
  }

  // 3. edit / write_file confirmation with inline diff
  if (
    diffBlock !== undefined ||
    kind === 'edit' ||
    toolName === 'edit' ||
    toolName === 'write_file'
  ) {
    const filePath =
      (typeof diffBlock?.['path'] === 'string' && diffBlock['path']) ||
      (typeof rawInput['file_path'] === 'string' && rawInput['file_path']) ||
      title;
    const fileName = basename(filePath) || filePath;
    const originalContent =
      typeof diffBlock?.['oldText'] === 'string'
        ? diffBlock['oldText']
        : typeof rawInput['old_string'] === 'string'
          ? rawInput['old_string']
          : '';
    const newContent =
      typeof diffBlock?.['newText'] === 'string'
        ? diffBlock['newText']
        : typeof rawInput['new_string'] === 'string'
          ? rawInput['new_string']
          : typeof rawInput['content'] === 'string'
            ? rawInput['content']
            : '';
    const fileDiff = Diff.createPatch(
      fileName,
      originalContent,
      newContent,
      'Current',
      'Proposed',
      { context: 3 },
    );
    return {
      type: 'edit',
      title,
      fileName,
      filePath,
      fileDiff,
      originalContent,
      newContent,
      hideModify: true,
      skipIdeDiff: true,
      hideAlwaysAllow,
      ...(textBlocks.length > 0 ? { warnings: textBlocks } : {}),
      onConfirm,
    };
  }

  // 4. exec / shell command confirmation
  if (
    kind === 'execute' ||
    toolName === 'run_shell_command' ||
    toolName === 'bash'
  ) {
    const command =
      (typeof rawInput['command'] === 'string' && rawInput['command']) || title;
    const alwaysAllowOpt = gate.options.find(
      (o) => o['kind'] === 'allow_always' && typeof o['name'] === 'string',
    );
    const optName =
      typeof alwaysAllowOpt?.['name'] === 'string'
        ? alwaysAllowOpt['name']
        : '';
    const scopeMatch = optName.match(
      /^Always Allow (?:in project|for user):\s*(.+)$/iu,
    );
    const scopeLabel = scopeMatch?.[1]?.trim();
    const rootCommand =
      scopeLabel || command.trim().split(/\s+/u)[0] || command;
    const permissionRules = scopeLabel
      ? scopeLabel
          .split(/\s*,\s*/u)
          .filter(Boolean)
          .map((r) => (r.startsWith('Bash(') ? r : `Bash(${r})`))
      : undefined;
    return {
      type: 'exec',
      title,
      command,
      rootCommand,
      ...(permissionRules?.length ? { permissionRules } : {}),
      ...(textBlocks.length > 0 ? { warnings: textBlocks } : {}),
      hideAlwaysAllow,
      onConfirm,
    };
  }

  // 5. MCP tool confirmation
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.slice('mcp__'.length).split('__');
    const serverName = parts[0] || 'mcp';
    const mcpToolName = parts.slice(1).join('__') || toolName;
    return {
      type: 'mcp',
      title,
      serverName,
      toolName: mcpToolName,
      toolDisplayName: title,
      permissionRules: [toolName],
      hideAlwaysAllow,
      onConfirm,
    };
  }

  // 6. Generic info confirmation fallback
  return {
    type: 'info',
    title,
    prompt: textBlocks.join('\n') || title,
    ...(hideAlwaysAllow ? { hideAlwaysAllow: true } : {}),
    onConfirm,
  };
}
