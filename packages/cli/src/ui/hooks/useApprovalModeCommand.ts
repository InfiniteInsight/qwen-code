/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { LoadedSettings, SettingScope } from '../../config/settings.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import type { DaemonSessionControl } from './daemon/daemon-session-state.js';

interface UseApprovalModeCommandReturn {
  isApprovalModeDialogOpen: boolean;
  openApprovalModeDialog: () => void;
  handleApprovalModeSelect: (
    mode: ApprovalMode | undefined,
    scope: SettingScope,
  ) => void;
}

export const useApprovalModeCommand = (
  loadedSettings: LoadedSettings,
  config: Config,
  addItem?: (item: HistoryItemWithoutId, baseTimestamp: number) => void,
  /**
   * Set when this tab is attached to a daemon session. The daemon owns the
   * session's mode, so a pick goes to it; the tab's own config and the user's
   * settings files are not touched.
   */
  daemon?: Pick<DaemonSessionControl, 'setApprovalMode'> | null,
): UseApprovalModeCommandReturn => {
  const [isApprovalModeDialogOpen, setIsApprovalModeDialogOpen] =
    useState(false);

  const openApprovalModeDialog = useCallback(() => {
    setIsApprovalModeDialogOpen(true);
  }, []);

  const handleApprovalModeSelect = useCallback(
    (mode: ApprovalMode | undefined, scope: SettingScope) => {
      try {
        if (!mode) {
          // User cancelled the dialog
          setIsApprovalModeDialogOpen(false);
          return;
        }

        if (daemon) {
          const report = (message: string) =>
            addItem?.({ type: MessageType.ERROR, text: message }, Date.now());
          if (!daemon.setApprovalMode) {
            report(
              'This daemon does not support changing the approval mode from a terminal.',
            );
            return;
          }
          // The footer follows the daemon's `approval_mode_changed` frame.
          daemon.setApprovalMode(mode).catch((e: unknown) => {
            report((e as Error)?.message ?? String(e));
          });
          return;
        }

        try {
          // Do not persist a privileged mode that this workspace cannot use;
          // User scope would make it active in other trusted workspaces.
          if (
            !config.isTrustedFolder() &&
            mode !== ApprovalMode.DEFAULT &&
            mode !== ApprovalMode.PLAN
          ) {
            throw new Error(
              'Cannot enable privileged approval modes in an untrusted folder.',
            );
          }
          loadedSettings.setValue(scope, 'tools.approvalMode', mode);
          // A higher-precedence scope can shadow the value just written (the
          // dialog warns about this); keep the session on the effective mode.
          const effectiveMode =
            loadedSettings.merged.tools?.approvalMode ?? mode;
          config.setApprovalMode(effectiveMode);
        } catch (e) {
          // Say so instead of closing silently: the refusal is otherwise
          // invisible, because the dialog is dismissed either way.
          addItem?.(
            { type: MessageType.ERROR, text: (e as Error).message },
            Date.now(),
          );
        }
      } finally {
        setIsApprovalModeDialogOpen(false);
      }
    },
    [config, loadedSettings, addItem, daemon],
  );

  return {
    isApprovalModeDialogOpen,
    openApprovalModeDialog,
    handleApprovalModeSelect,
  };
};
