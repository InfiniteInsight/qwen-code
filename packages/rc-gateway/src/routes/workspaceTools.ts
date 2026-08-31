/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, RequestHandler, Response } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import { WorkspacePoolFullError } from '../daemonPool.js';
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
  // rc-workspace-scoping (#28): targeting a non-default workspace spawns
  // on demand; at the pool cap with no idle victim this is a 503, not a
  // daemon failure.
  if (err instanceof WorkspacePoolFullError) {
    res.status(503).json({
      error: `Workspace daemon pool is full (max ${err.maxDaemons})`,
      code: 'workspace_pool_full',
    });
    return;
  }
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
 * Accepts an optional `workspace` target (rc-workspace-scoping, #28): a
 * `workspace` field on the POST body; absent/empty → the default/boot
 * workspace, and a non-default target makes the audit row carry the
 * resolved `workspace` cwd as well.
 *
 * On success audits `workspace_tool_enabled` with ONLY
 * `{toolName, enabled}` plus the `workspace` cwd for a non-default target
 * — never session or prompt content — and the actor is always the
 * AUTHENTICATED `req.rcClient`.
 */
export function createWorkspaceToolToggleRoute(
  daemon: WorkspaceToolsDaemon,
  deps: WorkspaceToolsRouteDeps = {},
): RequestHandler {
  return async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        enabled?: unknown;
        workspace?: unknown;
      };
      const target = parseWorkspaceTarget(body.workspace);
      if (!target.ok) {
        res.status(400).json({
          error: 'Invalid workspace target',
          code: 'invalid_workspace',
        });
        return;
      }
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
        result = await daemon.setWorkspaceToolEnabled(
          toolName,
          enabled,
          undefined,
          target.cwd,
        );
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
        detail: {
          toolName,
          enabled,
          // Only recorded for a non-default target (undefined for the
          // default workspace keeps the row shape unchanged for existing
          // readers).
          ...(target.cwd !== undefined ? { workspace: target.cwd } : {}),
        },
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
 * Accepts an optional `workspace` target (rc-workspace-scoping, #28):
 * `?workspace=<cwd>`; absent/empty → the default/boot workspace.
 *
 * Daemon errors map as in the toggle route: 404 → 502 `tools_unsupported`,
 * anything else to 502 `daemon_unavailable` (400/403/409 passthrough for
 * completeness).
 */
export function createWorkspaceToolsCatalogRoute(
  daemon: Pick<SessionDaemon, 'workspaceToolsCatalog'>,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const target = parseWorkspaceTarget(req.query.workspace);
    if (!target.ok) {
      res.status(400).json({
        error: 'Invalid workspace target',
        code: 'invalid_workspace',
      });
      return;
    }
    try {
      const result = await daemon.workspaceToolsCatalog(target.cwd);
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
