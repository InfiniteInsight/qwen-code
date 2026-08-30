/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, RequestHandler, Response } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

/** The daemon surface this route file needs. */
export type WorkspaceToolsDaemon = Pick<
  SessionDaemon,
  'setWorkspaceToolEnabled' | 'workspaceToolsCatalog'
>;

export interface WorkspaceToolsRouteDeps {
  audit?: AuditRecorder;
}

/**
 * Map a daemon failure to the route's response, mirroring
 * routes/approvalMode.ts: 400/403/409 pass through unchanged (human error +
 * daemon code), 404 maps to 502 `tools_unsupported` (daemon predates the
 * tools surface), anything else to 502 `daemon_unavailable`.
 */
function sendMappedToolsError(
  res: Response,
  err: unknown,
  unsupportedMessage: string,
): void {
  const status = (err as { status?: unknown }).status;
  const eBody = (err as { body?: unknown }).body as
    | { code?: unknown; error?: unknown; message?: unknown }
    | undefined;
  if (status === 400 || status === 403 || status === 409) {
    const humanError =
      (typeof eBody?.error === 'string' && eBody.error.length > 0
        ? eBody.error
        : undefined) ??
      (typeof eBody?.message === 'string' && eBody.message.length > 0
        ? eBody.message
        : undefined) ??
      'Daemon rejected the request';
    res.status(status as number).json({
      error: humanError,
      code: typeof eBody?.code === 'string' ? eBody.code : 'daemon_rejected',
    });
    return;
  }
  if (status === 404) {
    res
      .status(502)
      .json({ error: unsupportedMessage, code: 'tools_unsupported' });
    return;
  }
  res
    .status(502)
    .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
}

/**
 * POST /rc/workspace/tools/:name/enable — enable/disable ONE built-in tool
 * in the workspace's `tools.disabled` list (`{enabled: boolean}`). Mounted
 * OWNER-only (server.ts); the mount's `requireScope` writes the
 * `scope_denied` audit row on denial, so the daemon is never touched by an
 * under-scoped caller.
 *
 * Daemon errors are mapped as in routes/approvalMode.ts: 400/403/409 pass
 * through unchanged (e.g. the daemon's own `invalid_enabled_flag`), 404
 * maps to 502 `tools_unsupported`, anything else to 502
 * `daemon_unavailable`.
 *
 * On success audits `workspace_tool_enabled` with ONLY
 * `{toolName, enabled}` — never session or prompt content — and the actor
 * is always the AUTHENTICATED `req.rcClient`.
 */
export function createWorkspaceToolToggleRoute(
  daemon: WorkspaceToolsDaemon,
  deps: WorkspaceToolsRouteDeps = {},
): RequestHandler {
  return async (req, res) => {
    try {
      const body = (req.body ?? {}) as { enabled?: unknown };
      if (typeof body.enabled !== 'boolean') {
        res.status(400).json({
          error: 'Invalid enabled flag',
          code: 'invalid_enabled_flag',
        });
        return;
      }
      const toolName = req.params.name as string;
      const enabled = body.enabled;

      let result;
      try {
        result = await daemon.setWorkspaceToolEnabled(toolName, enabled);
      } catch (err) {
        sendMappedToolsError(
          res,
          err,
          'Daemon does not support workspace tool toggling',
        );
        return;
      }

      void deps.audit?.record({
        action: 'workspace_tool_enabled',
        actorTokenId: req.rcClient?.id,
        subActor: req.rcClient?.subActor,
        detail: { toolName, enabled },
      });

      res.status(200).json(result);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Workspace tool toggle failed',
          code: 'workspace_tools_failed',
        });
      }
    }
  };
}

/**
 * GET /rc/workspace/tools — read the workspace's tools catalog (every
 * built-in tool with per-tool disabled state, plus disabled MCP-style or
 * unknown names). Mounted write-scope (server.ts); the response is the
 * daemon's, unchanged. Read-only: no audit row.
 *
 * Daemon errors map as in the toggle route: 404 → 502 `tools_unsupported`,
 * anything else to 502 `daemon_unavailable` (400/403/409 passthrough for
 * completeness).
 */
export function createWorkspaceToolsCatalogRoute(
  daemon: Pick<SessionDaemon, 'workspaceToolsCatalog'>,
): RequestHandler {
  return async (_req: Request, res: Response) => {
    try {
      const result = await daemon.workspaceToolsCatalog();
      res.status(200).json(result);
    } catch (err) {
      if (!res.headersSent) {
        sendMappedToolsError(
          res,
          err,
          'Daemon does not support the workspace tools catalog',
        );
      }
    }
  };
}
