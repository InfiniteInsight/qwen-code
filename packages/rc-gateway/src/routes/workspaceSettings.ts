/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import { WorkspacePoolFullError } from '../daemonPool.js';

/** The daemon surface this route file needs. */
export type WorkspaceSettingsDaemon = Pick<SessionDaemon, 'workspaceSettings'>;

/**
 * rc-workspace-scoping (#28): resolve the optional `workspace` target out
 * of a GET query / POST body value. Absent or empty string → the
 * default/boot workspace (`undefined`); a non-empty string is trimmed and
 * used as the target cwd; any other shape is a 400 `invalid_workspace`
 * (the handler sends it and returns).
 */
function parseWorkspaceTarget(
  raw: unknown,
): { ok: true; cwd: string | undefined } | { ok: false } {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, cwd: undefined };
  }
  if (typeof raw === 'string') return { ok: true, cwd: raw.trim() };
  return { ok: false };
}

/**
 * GET /rc/workspace/settings — read the workspace's effective settings
 * (including the normalized `disabledTools` list, when the daemon
 * provides it). Mounted at the WRITE floor (server.ts). The daemon body is
 * passed through unchanged — `mcpServers` values are already redacted by
 * the daemon.
 *
 * Accepts an optional `workspace` target (rc-workspace-scoping, #28):
 * `?workspace=<cwd>`; absent/empty → the default/boot workspace.
 *
 * Read-only by design: the only remote write paths to workspace settings
 * are the dedicated tool-toggle and MCP-server routes, and
 * `tools.approvalMode` remains daemon-side security-sensitive.
 */
export function createWorkspaceSettingsRoute(
  daemon: WorkspaceSettingsDaemon,
): RequestHandler {
  return async (req, res) => {
    const target = parseWorkspaceTarget(req.query.workspace);
    if (!target.ok) {
      res.status(400).json({
        error: 'Invalid workspace target',
        code: 'invalid_workspace',
      });
      return;
    }
    try {
      const result = await daemon.workspaceSettings(undefined, target.cwd);
      res.status(200).json(result);
    } catch (err) {
      // rc-workspace-scoping (#28): targeting a non-default workspace
      // spawns on demand; at the pool cap with no idle victim this is a
      // 503, not a daemon failure.
      if (err instanceof WorkspacePoolFullError) {
        res.status(503).json({
          error: `Workspace daemon pool is full (max ${err.maxDaemons})`,
          code: 'workspace_pool_full',
        });
        return;
      }
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
