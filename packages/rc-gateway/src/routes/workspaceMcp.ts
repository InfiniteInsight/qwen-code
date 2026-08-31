/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type {
  DaemonWorkspaceMcpStatus,
  DaemonWorkspaceMcpServerStatus,
} from '@qwen-code/sdk/daemon';
import type { SessionDaemon } from '../daemonPool.js';
import { WorkspacePoolFullError } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

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
 * Stable ETag for an MCP GET: hashes ONLY the mutable, persisted server
 * state (`name`, `configOrigin`, `disabled`, `disabledReason`, `config`)
 * while EXCLUDING all transient connection/runtime state (`mcpStatus`,
 * `transport`, `hasOAuthTokens`, `requiresAuth`, `approvalState`,
 * `authenticationState`, `authenticationError`, `resourceCount`) so a
 * transport reconnect or client-count tick can't provoke a spurious 409.
 * A POST whose `baseVersion` no longer matches the current hash is
 * rejected with 409 `stale_base`.
 */
function mcpVersion(data: DaemonWorkspaceMcpStatus): string {
  const servers: DaemonWorkspaceMcpServerStatus[] = Array.isArray(data.servers)
    ? data.servers
    : [];
  const stable = servers.map((s) => ({
    name: s.name,
    configOrigin: s.configOrigin,
    disabled: s.disabled,
    disabledReason: s.disabledReason,
    config: s.config,
  }));
  return createHash('sha1')
    .update(JSON.stringify(stable), 'utf8')
    .digest('base64url');
}

/** The daemon surface this route file needs. */
export type WorkspaceMcpDaemon = Pick<
  SessionDaemon,
  'workspaceMcp' | 'reloadWorkspaceMcp' | 'setWorkspaceSetting'
>;

export interface WorkspaceMcpRouteDeps {
  audit?: AuditRecorder;
}

/**
 * Map a daemon rejection to a gateway response (mirrors
 * routes/approvalMode.ts's mapping, widened to every 4xx the daemon may
 * raise on this surface):
 * - 400/403/409: the daemon's own code + human message, unchanged;
 * - 404: the daemon predates this surface → 502 `mcp_unsupported`;
 * - anything else (network, 5xx, timeout): 502 `daemon_unavailable`.
 * Always sends a response; the caller must return after it.
 */
function daemonError(err: unknown, res: Parameters<RequestHandler>[1]): void {
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
    res.status(502).json({
      error: 'Daemon does not support workspace MCP control',
      code: 'mcp_unsupported',
    });
    return;
  }
  res
    .status(502)
    .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
}

/**
 * GET /rc/workspace/mcp — read the workspace MCP status (server list with
 * connection state). Mounted at the WRITE floor (server.ts). The daemon
 * redacts credential-bearing config values before this response is built.
 *
 * POST /rc/workspace/mcp/reload — (re)run workspace MCP discovery. Mounted
 * OWNER-only. Audits `workspace_mcp_reloaded` on success (no extra fields;
 * the resolved `workspace` cwd for a non-default target).
 *
 * POST /rc/workspace/mcp/servers — persist one MCP server into the
 * workspace's `mcpServers` setting: `{operation: 'set' | 'remove', name,
 * config?}`. Mounted OWNER-only. `set` requires a non-null object
 * `config`; `remove` ignores any `config` the caller sends (the daemon's
 * read-modify-write only needs a non-null `value`, so `{}` is passed).
 * The daemon performs the read-modify-write under its own mutation lock
 * and restores redacted secrets from the existing config.
 *
 * All three accept an optional `workspace` target (rc-workspace-scoping,
 * #28): `?workspace=<cwd>` on the GET, a `workspace` field on the POST
 * bodies. Absent/empty → the default/boot workspace; the baseVersion
 * re-fetch and the mutation both resolve the SAME target.
 *
 * SECURITY: MCP config values are credential material (env, headers,
 * command args). They are NEVER logged, audited, or echoed beyond the
 * daemon's own redaction: the audit rows (`workspace_mcp_server_set` /
 * `workspace_mcp_server_removed`) carry the server NAME ONLY (plus the
 * non-default `workspace` cwd), and this file deliberately never logs the
 * request body.
 */
export function createWorkspaceMcpRoutes(
  daemon: WorkspaceMcpDaemon,
  deps: WorkspaceMcpRouteDeps = {},
): { get: RequestHandler; reload: RequestHandler; servers: RequestHandler } {
  const get: RequestHandler = async (req, res) => {
    try {
      const target = parseWorkspaceTarget(req.query.workspace);
      if (!target.ok) {
        res.status(400).json({
          error: 'Invalid workspace target',
          code: 'invalid_workspace',
        });
        return;
      }
      try {
        const result = await daemon.workspaceMcp(target.cwd);
        res.status(200).json({ ...result, version: mcpVersion(result) });
      } catch (err) {
        daemonError(err, res);
      }
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Workspace MCP read failed',
          code: 'workspace_mcp_failed',
        });
      }
    }
  };

  const reload: RequestHandler = async (req, res) => {
    try {
      const target = parseWorkspaceTarget(
        ((req.body ?? {}) as { workspace?: unknown }).workspace,
      );
      if (!target.ok) {
        res.status(400).json({
          error: 'Invalid workspace target',
          code: 'invalid_workspace',
        });
        return;
      }
      let result;
      try {
        result = await daemon.reloadWorkspaceMcp(undefined, target.cwd);
      } catch (err) {
        daemonError(err, res);
        return;
      }

      void deps.audit?.record({
        action: 'workspace_mcp_reloaded',
        actorTokenId: req.rcClient?.id,
        subActor: req.rcClient?.subActor,
        // Only for a non-default target — keeps the row shape unchanged
        // for existing readers; name-only rule still holds (no config
        // values).
        ...(target.cwd !== undefined
          ? { detail: { workspace: target.cwd } }
          : {}),
      });

      res.status(200).json(result);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Workspace MCP reload failed',
          code: 'workspace_mcp_failed',
        });
      }
    }
  };

  const servers: RequestHandler = async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        operation?: unknown;
        name?: unknown;
        config?: unknown;
        baseVersion?: unknown;
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
      const operation = body.operation;
      if (operation !== 'set' && operation !== 'remove') {
        res.status(400).json({
          error: 'Invalid operation',
          code: 'invalid_operation',
          allowed: ['set', 'remove'],
        });
        return;
      }
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        res.status(400).json({
          error: 'Invalid server name',
          code: 'invalid_server_name',
        });
        return;
      }
      if (
        body.baseVersion !== undefined &&
        typeof body.baseVersion !== 'string'
      ) {
        res.status(400).json({
          error: 'Invalid base version',
          code: 'invalid_base_version',
        });
        return;
      }
      const name = body.name;
      const baseVersion = body.baseVersion as string | undefined;
      if (
        operation === 'set' &&
        (typeof body.config !== 'object' ||
          body.config === null ||
          Array.isArray(body.config))
      ) {
        res.status(400).json({
          error: 'Invalid server config',
          code: 'invalid_config',
        });
        return;
      }

      // Optimistic concurrency: when a `baseVersion` is supplied (from the
      // prior GET's `version`), re-fetch the current MCP status and confirm
      // the server list the caller saw is still current. A mismatch means
      // another writer added/removed/renamed a server in the window —
      // reject with the current version so the caller can reload and retry
      // instead of silently clobbering.
      if (baseVersion !== undefined) {
        let current: DaemonWorkspaceMcpStatus;
        try {
          // Same target as the mutation below — a baseVersion from one
          // workspace must not be checked against another's servers.
          current = await daemon.workspaceMcp(target.cwd);
        } catch (err) {
          daemonError(err, res);
          return;
        }
        const currentVersion = mcpVersion(current);
        if (currentVersion !== baseVersion) {
          res.status(409).json({
            error: 'Stale MCP server list — reload and try again',
            code: 'stale_base',
            currentVersion,
          });
          return;
        }
      }

      let result;
      try {
        result = await daemon.setWorkspaceSetting(
          'workspace',
          'mcpServers',
          operation === 'set' ? body.config : {},
          { mcpServerMutation: { operation, name } },
          target.cwd,
        );
      } catch (err) {
        daemonError(err, res);
        return;
      }

      // Name only — NEVER the config (credential material). The
      // non-default `workspace` cwd is metadata, not config.
      void deps.audit?.record({
        action:
          operation === 'set'
            ? 'workspace_mcp_server_set'
            : 'workspace_mcp_server_removed',
        actorTokenId: req.rcClient?.id,
        subActor: req.rcClient?.subActor,
        detail: {
          name,
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
          error: 'Workspace MCP server update failed',
          code: 'workspace_mcp_failed',
        });
      }
    }
  };

  return { get, reload, servers };
}
