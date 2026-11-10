/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import {
  outcomeToOptionId,
  buildDaemonConfirmation,
} from './daemonConfirmation.js';
import type { PendingPermission } from './projectDaemonEvent.js';

// Ground truth: the exact `options` a live 0.17.x daemon sent for a write_file
// (edit) gate — captured via scripts/capture-daemon-frames.mts. Note there is
// NO `reject_always` in an edit's option set.
const EDIT_OPTIONS: PendingPermission['options'] = [
  { kind: 'allow_always', name: 'Allow All Edits', optionId: 'proceed_always' },
  { kind: 'allow_once', name: 'Allow', optionId: 'proceed_once' },
  { kind: 'reject_once', name: 'Reject', optionId: 'cancel' },
];

describe('outcomeToOptionId', () => {
  it('maps ProceedOnce → the allow_once option', () => {
    expect(
      outcomeToOptionId(ToolConfirmationOutcome.ProceedOnce, EDIT_OPTIONS),
    ).toBe('proceed_once');
  });

  it('maps every ProceedAlways* variant → the single allow_always option', () => {
    for (const o of [
      ToolConfirmationOutcome.ProceedAlways,
      ToolConfirmationOutcome.ProceedAlwaysProject,
      ToolConfirmationOutcome.ProceedAlwaysUser,
      ToolConfirmationOutcome.ProceedAlwaysServer,
      ToolConfirmationOutcome.ProceedAlwaysTool,
    ]) {
      expect(outcomeToOptionId(o, EDIT_OPTIONS)).toBe('proceed_always');
    }
  });

  it('maps Cancel (and Modify/Restore) → the reject_once option', () => {
    for (const o of [
      ToolConfirmationOutcome.Cancel,
      ToolConfirmationOutcome.ModifyWithEditor,
      ToolConfirmationOutcome.RestorePrevious,
    ]) {
      expect(outcomeToOptionId(o, EDIT_OPTIONS)).toBe('cancel');
    }
  });

  it('falls back to reject_always when reject_once is absent', () => {
    const opts: PendingPermission['options'] = [
      { kind: 'allow_once', optionId: 'a' },
      { kind: 'reject_always', optionId: 'r_all' },
    ];
    expect(outcomeToOptionId(ToolConfirmationOutcome.Cancel, opts)).toBe(
      'r_all',
    );
  });

  it('returns null when no reject option exists (caller declines explicitly)', () => {
    const opts: PendingPermission['options'] = [
      { kind: 'allow_once', optionId: 'a' },
    ];
    expect(outcomeToOptionId(ToolConfirmationOutcome.Cancel, opts)).toBeNull();
  });

  it('falls back allow_always → allow_once when no allow_always exists', () => {
    const opts: PendingPermission['options'] = [
      { kind: 'allow_once', optionId: 'once' },
      { kind: 'reject_once', optionId: 'no' },
    ];
    expect(outcomeToOptionId(ToolConfirmationOutcome.ProceedAlways, opts)).toBe(
      'once',
    );
  });
});

describe('buildDaemonConfirmation', () => {
  const gate: PendingPermission = {
    requestId: 'req_1',
    toolCallId: 'call_1',
    title: 'Writing to /tmp/capture_probe.txt',
    options: EDIT_OPTIONS,
  };

  it('builds an `info` confirmation carrying the tool title', () => {
    const details = buildDaemonConfirmation(gate, vi.fn());
    expect(details.type).toBe('info');
    expect(details.title).toBe('Writing to /tmp/capture_probe.txt');
    expect((details as { prompt: string }).prompt).toBe(
      'Writing to /tmp/capture_probe.txt',
    );
  });

  it('onConfirm maps the outcome and posts the resolved optionId', async () => {
    const respond = vi.fn(async () => {});
    const details = buildDaemonConfirmation(gate, respond);
    await details.onConfirm(ToolConfirmationOutcome.ProceedAlways);
    expect(respond).toHaveBeenCalledWith('proceed_always');
    await details.onConfirm(ToolConfirmationOutcome.Cancel);
    expect(respond).toHaveBeenLastCalledWith('cancel');
  });

  it('falls back to a generic title when the gate has none', () => {
    const details = buildDaemonConfirmation(
      { ...gate, title: undefined },
      vi.fn(),
    );
    expect(details.title).toBe('Tool approval requested');
  });

  it('prefers exact optionId matches for scoped outcomes (user vs project vs restore_previous) (#526)', () => {
    const scopedOptions: PendingPermission['options'] = [
      {
        kind: 'allow_once',
        name: 'Allow',
        optionId: ToolConfirmationOutcome.ProceedOnce,
      },
      {
        kind: 'allow_always',
        name: 'Always Allow in project: git status',
        optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
      },
      {
        kind: 'allow_always',
        name: 'Always Allow for user: git status',
        optionId: ToolConfirmationOutcome.ProceedAlwaysUser,
      },
      {
        kind: 'allow_once',
        name: 'Yes, restore previous mode (auto-edit)',
        optionId: ToolConfirmationOutcome.RestorePrevious,
      },
      {
        kind: 'reject_once',
        name: 'Reject',
        optionId: ToolConfirmationOutcome.Cancel,
      },
    ];
    expect(
      outcomeToOptionId(
        ToolConfirmationOutcome.ProceedAlwaysProject,
        scopedOptions,
      ),
    ).toBe(ToolConfirmationOutcome.ProceedAlwaysProject);
    expect(
      outcomeToOptionId(
        ToolConfirmationOutcome.ProceedAlwaysUser,
        scopedOptions,
      ),
    ).toBe(ToolConfirmationOutcome.ProceedAlwaysUser);
    expect(
      outcomeToOptionId(ToolConfirmationOutcome.RestorePrevious, scopedOptions),
    ).toBe(ToolConfirmationOutcome.RestorePrevious);
  });

  it('builds rich edit, exec, plan, ask_user_question, and mcp confirmations from gate.toolCall (#526)', async () => {
    // 1. Edit confirmation with inline diff
    const editDetails = buildDaemonConfirmation(
      {
        requestId: 'req_edit',
        toolCallId: 'call_edit',
        title: 'Edit /repo/src/index.ts',
        toolCall: {
          kind: 'edit',
          content: [
            {
              type: 'diff',
              path: '/repo/src/index.ts',
              oldText: 'export const x = 1;\n',
              newText: 'export const x = 2;\n',
            },
          ],
          _meta: { toolName: 'edit' },
        },
        options: EDIT_OPTIONS,
      },
      vi.fn(),
    );
    expect(editDetails).toMatchObject({
      type: 'edit',
      fileName: 'index.ts',
      filePath: '/repo/src/index.ts',
      originalContent: 'export const x = 1;\n',
      newContent: 'export const x = 2;\n',
      hideModify: true,
      skipIdeDiff: true,
      fileDiff: expect.stringContaining('-export const x = 1;'),
    });

    // 2. Exec confirmation with command and extracted permissionRules
    const execDetails = buildDaemonConfirmation(
      {
        requestId: 'req_exec',
        toolCallId: 'call_exec',
        title: 'npm test',
        toolCall: {
          kind: 'execute',
          rawInput: { command: 'npm test -- --run' },
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'Contains command substitution',
              },
            },
          ],
          _meta: { toolName: 'run_shell_command' },
        },
        options: [
          {
            kind: 'allow_always',
            name: 'Always Allow in project: npm test *',
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
          },
          {
            kind: 'allow_once',
            name: 'Allow',
            optionId: ToolConfirmationOutcome.ProceedOnce,
          },
          {
            kind: 'reject_once',
            name: 'Reject',
            optionId: ToolConfirmationOutcome.Cancel,
          },
        ],
      },
      vi.fn(),
    );
    expect(execDetails).toMatchObject({
      type: 'exec',
      command: 'npm test -- --run',
      rootCommand: 'npm test *',
      permissionRules: ['Bash(npm test *)'],
      warnings: ['Contains command substitution'],
    });

    // 3. Plan confirmation with extracted plan markdown and prePlanMode
    const planDetails = buildDaemonConfirmation(
      {
        requestId: 'req_plan',
        toolCallId: 'call_plan',
        title: 'Ready to code?',
        toolCall: {
          kind: 'switch_mode',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: '1. Update reducer\n2. Run tests',
              },
            },
          ],
          _meta: { toolName: 'exit_plan_mode' },
        },
        options: [
          {
            kind: 'allow_always',
            name: 'Yes, and auto-accept edits',
            optionId: ToolConfirmationOutcome.ProceedAlways,
          },
          {
            kind: 'allow_once',
            name: 'Yes, and manually approve edits',
            optionId: ToolConfirmationOutcome.ProceedOnce,
          },
          {
            kind: 'allow_once',
            name: 'Yes, restore previous mode (auto-edit)',
            optionId: ToolConfirmationOutcome.RestorePrevious,
          },
          {
            kind: 'reject_once',
            name: 'No, keep planning (esc)',
            optionId: ToolConfirmationOutcome.Cancel,
          },
        ],
      },
      vi.fn(),
    );
    expect(planDetails).toMatchObject({
      type: 'plan',
      plan: '1. Update reducer\n2. Run tests',
      prePlanMode: 'auto-edit',
    });

    // 4. ask_user_question confirmation forwarding payload.answers
    const respondQuestion = vi.fn(async () => {});
    const questionDetails = buildDaemonConfirmation(
      {
        requestId: 'req_q',
        toolCallId: 'call_q',
        title: 'Clarify target environment',
        toolCall: {
          kind: 'other',
          _meta: {
            toolName: 'ask_user_question',
            qwenInteractionKind: 'user_question',
            qwenQuestions: [
              {
                header: 'Env',
                question: 'Which environment?',
                options: [
                  { label: 'Staging', description: 'Deploy to staging' },
                  { label: 'Prod', description: 'Deploy to prod' },
                ],
              },
            ],
          },
        },
        options: [
          {
            kind: 'allow_once',
            name: 'Allow',
            optionId: ToolConfirmationOutcome.ProceedOnce,
          },
          {
            kind: 'reject_once',
            name: 'Reject',
            optionId: ToolConfirmationOutcome.Cancel,
          },
        ],
      },
      respondQuestion,
    );
    expect(questionDetails).toMatchObject({
      type: 'ask_user_question',
      questions: [
        {
          header: 'Env',
          question: 'Which environment?',
          options: [
            { label: 'Staging', description: 'Deploy to staging' },
            { label: 'Prod', description: 'Deploy to prod' },
          ],
        },
      ],
    });
    await questionDetails.onConfirm(ToolConfirmationOutcome.ProceedOnce, {
      answers: { '0': 'Staging' },
    });
    expect(respondQuestion).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      { answers: { '0': 'Staging' } },
    );

    // 5. MCP tool confirmation
    const mcpDetails = buildDaemonConfirmation(
      {
        requestId: 'req_mcp',
        toolCallId: 'call_mcp',
        title: 'github - create_issue',
        toolCall: {
          kind: 'other',
          _meta: { toolName: 'mcp__github__create_issue' },
        },
        options: EDIT_OPTIONS,
      },
      vi.fn(),
    );
    expect(mcpDetails).toMatchObject({
      type: 'mcp',
      serverName: 'github',
      toolName: 'create_issue',
      toolDisplayName: 'github - create_issue',
      permissionRules: ['mcp__github__create_issue'],
    });
  });
});
