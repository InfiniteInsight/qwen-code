/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';

/** The daemon surface this route file needs. */
export type WorkspaceSettingsDaemon = Pick<SessionDaemon, 'workspaceSettings'>;

/**
 * GET /rc/workspace/settings — read the workspace's effective settings
 * (including the normalized `disabledTools` list, when the daemon
 * provides it). Mounted at the WRITE floor (server.ts). The daemon body is
 * passed through unchanged — `mcpServers` values are already redacted by
 * the daemon.
 *
 * Read-only by design: the only remote write paths to workspace settings
 * are the dedicated tool-toggle and MCP-server routes, and
 * `tools.approvalMode` remains daemon-side security-sensitive.
 */
export function createWorkspaceSettingsRoute(
  daemon: WorkspaceSettingsDaemon,
): RequestHandler {
  return async (req, res) => {
    try {
      const result = await daemon.workspaceSettings();
      res.status(200).json(result);
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (status === 404) {
        res.status(502).json({
          error: 'Daemon does not support workspace settings read',
          code: 'settings_unsupported',
        });
        return;
      }
      if (!res.headersSent) {
        res
          .status(502)
          .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      }
    }
  };
}
