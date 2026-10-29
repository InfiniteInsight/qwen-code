/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';
import type { DaemonModelOption } from '../hooks/daemon/daemon-session-state.js';

interface DaemonModelDialogProps {
  /** The models the daemon offers for this session (its `availableModels`). */
  models: readonly DaemonModelOption[];
  /** The model the session currently runs on, to pre-select it. */
  currentModelId?: string;
  /** Called with the chosen `modelId`, or `undefined` when cancelled. */
  onSelect: (modelId: string | undefined) => void;
}

/**
 * The `/model` picker for a tab attached to a daemon session. The normal
 * `ModelDialog` lists and switches the tab's own Config, which is not what the
 * session runs on; this one lists the daemon's models and returns the pick for
 * the caller to send to the daemon.
 */
export function DaemonModelDialog({
  models,
  currentModelId,
  onSelect,
}: DaemonModelDialogProps): React.JSX.Element {
  const items = models.map((model) => ({
    label:
      (model.name !== model.modelId
        ? `${model.name} (${model.modelId})`
        : model.modelId) + (model.modelId === currentModelId ? ' *' : ''),
    value: model.modelId,
    key: model.modelId,
  }));
  const initialIndex = Math.max(
    0,
    models.findIndex((m) => m.modelId === currentModelId),
  );

  const handleSelect = useCallback(
    (modelId: string) => onSelect(modelId),
    [onSelect],
  );

  useKeypress(
    (key) => {
      if (key.name === 'escape') onSelect(undefined);
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>
        {'> '}
        {t('Select Model')}{' '}
        <Text color={theme.text.secondary}>
          {t('(switches the daemon session)')}
        </Text>
      </Text>
      <Box height={1} />
      {items.length === 0 ? (
        <Text color={theme.status.warning}>
          {t('The daemon did not list any models for this session.')}
        </Text>
      ) : (
        <RadioButtonSelect
          items={items}
          initialIndex={initialIndex}
          onSelect={handleSelect}
          isFocused
          showNumbers
        />
      )}
      <Box marginTop={1}>
        <Text color={theme.text.secondary} wrap="truncate">
          {t('(Use Enter to select, Esc to cancel)')}
        </Text>
      </Box>
    </Box>
  );
}
