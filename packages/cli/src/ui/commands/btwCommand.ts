/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { BTW_MAX_INPUT_LENGTH } from '@qwen-code/qwen-code-core/utils/btwUtils.js';
import {
  BtwSession,
  getBtwSession,
  type BtwOutcome,
} from '@qwen-code/qwen-code-core/agents/btw-session.js';
import { formatBtwToolCallNotice, showBtwRequest } from '../utils/btw-view.js';
import { recordBtwUse } from '../../services/tips/index.js';
import type { DaemonSessionControl } from '../hooks/daemon/daemon-session-state.js';

const daemonBtwSessions = new WeakMap<
  DaemonSessionControl,
  { sessionId: string; session: BtwSession }
>();

function resolveCommandBtwSession(
  config: Config,
  daemon?: DaemonSessionControl | null,
): BtwSession {
  if (!daemon?.btw) {
    return getBtwSession(config);
  }
  const sessionId = config.getSessionId();
  const existing = daemonBtwSessions.get(daemon);
  if (existing?.sessionId === sessionId) {
    return existing.session;
  }
  existing?.session.dispose();
  const session = new BtwSession(config, async (params) => {
    const res = await daemon.btw!(params.question, { signal: params.signal });
    return { text: res.answer };
  });
  daemonBtwSessions.set(daemon, { sessionId, session });
  return session;
}

function formatBtwError(error: string): string {
  return t('Failed to answer btw question: {{error}}', { error });
}

function outcomeToMessage(outcome: BtwOutcome): SlashCommandActionReturn {
  switch (outcome.kind) {
    case 'answered':
      return {
        type: 'message',
        messageType: 'info',
        content: outcome.response,
      };
    case 'tool-call':
      return {
        type: 'message',
        messageType: 'info',
        content: formatBtwToolCallNotice(outcome.toolName),
      };
    case 'empty':
      return {
        type: 'message',
        messageType: 'info',
        content: t('No response received.'),
      };
    case 'unavailable':
      return {
        type: 'message',
        messageType: 'error',
        content: formatBtwError(
          t('No conversation context available for /btw'),
        ),
      };
    case 'failed':
      return {
        type: 'message',
        messageType: 'error',
        content: formatBtwError(outcome.error),
      };
    case 'cancelled':
    default:
      return {
        type: 'message',
        messageType: 'error',
        content: formatBtwError(t('Cancelled')),
      };
  }
}

export const btwCommand: SlashCommand = {
  name: 'btw',
  get description() {
    return t(
      'Ask a quick side question without affecting the main conversation',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<void | SlashCommandActionReturn> => {
    const question = args.trim();
    const { config, daemon } = context.services;
    const interactive =
      (context.executionMode ?? 'interactive') === 'interactive';

    if (!question) {
      const session =
        config && interactive ? resolveCommandBtwSession(config, daemon) : null;
      const reopenId = session?.getReopenTargetId();
      if (session && reopenId) {
        showBtwRequest(context.ui, session, reopenId);
        return;
      }
      return {
        type: 'message',
        messageType: 'error',
        content: t('Please provide a question. Usage: /btw <your question>'),
      };
    }

    if (question.length > BTW_MAX_INPUT_LENGTH) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Question too long (max {{max}} chars)', {
          max: String(BTW_MAX_INPUT_LENGTH),
        }),
      };
    }

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    if (!config.getModel() && !daemon?.btw) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('No model configured.'),
      };
    }

    const session = resolveCommandBtwSession(config, daemon);
    if (!interactive) {
      const { done } = session.ask(question, { signal: context.abortSignal });
      return outcomeToMessage(await done);
    }

    // The request runs in the session store, so the main conversation is not
    // blocked and a newer /btw does not cancel this one.
    recordBtwUse();
    const { id } = session.ask(question);
    showBtwRequest(context.ui, session, id);
  },
};
