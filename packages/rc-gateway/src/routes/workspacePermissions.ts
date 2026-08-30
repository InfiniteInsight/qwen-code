/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type {
  DaemonPermissionRuleType,
  DaemonPermissionScope,
} from '@qwen-code/sdk/daemon';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

/** The daemon surface this route file needs. */
export type WorkspacePermissionsDaemon = Pick<
  SessionDaemon,
  'workspacePermissions' | 'setWorkspacePermissionRules'
>;

export interface WorkspacePermissionsRouteDeps {
  audit?: AuditRecorder;
}

const PERMISSION_SCOPES = new Set<string>(['user', 'workspace']);
const PERMISSION_RULE_TYPES = new Set<string>(['allow', 'ask', 'deny']);

function isPermissionScope(v: unknown): v is DaemonPermissionScope {
  return typeof v === 'string' && PERMISSION_SCOPES.has(v);
}

function isPermissionRuleType(v: unknown): v is DaemonPermissionRuleType {
  return typeof v === 'string' && PERMISSION_RULE_TYPES.has(v);
}

/**
 * Map a daemon rejection to a gateway response (mirrors
 * routes/approvalMode.ts's mapping, widened to every 4xx the daemon may
 * raise on this surface):
 * - 400/403/409: the daemon's own code + human message, unchanged, so the
 *   remote client learns the real reason (e.g. `permission_session_required`
 *   needs a live ACP session);
 * - 404: the daemon predates this surface → 502 `permissions_unsupported`;
 * - anything else (network, 5xx, timeout): 502 `daemon_unavailable`.
 * Always sends a response; the caller must return after it.
 */
function daemonError(err: unknown, res: Parameters<RequestHandler>[1]): void {
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
      error: 'Daemon does not support workspace permission control',
      code: 'permissions_unsupported',
    });
    return;
  }
  res
    .status(502)
    .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
}

function wrap(failed: {
  error: string;
  code: string;
}): (h: RequestHandler) => RequestHandler {
  return (h) => async (req, res) => {
    try {
      // No-op `next`: Express 4 would swallow an async rejection here, but
      // these handlers never forward to middleware.
      await h(req, res, () => undefined);
    } catch {
      // No global Express error middleware is mounted and Express 4 does
      // not catch async-handler rejections (mirrors
      // routes/approvalMode.ts's top-level guard); map any unexpected
      // failure to a clean 500. Guard against a double-send if a response
      // was already written.
      if (!res.headersSent) {
        res.status(500).json(failed);
      }
    }
  };
}

/**
 * GET /rc/workspace/permissions — read the workspace's permission rule
 * lists (user/workspace/merged). Mounted at the WRITE floor (server.ts);
 * no in-handler scope check.
 *
 * POST /rc/workspace/permissions — replace ONE rule list (`{scope,
 * ruleType, rules}` full replacement). Mounted OWNER-only (server.ts); the
 * mount's `requireScope` writes the `scope_denied` audit row on denial, so
 * the daemon is never touched by an under-scoped caller.
 *
 * On a successful POST, audits `workspace_permission_rules_set` with ONLY
 * `{scope, ruleType, rules}` — never session or prompt content — and the
 * actor is always the AUTHENTICATED `req.rcClient`.
 */
export function createWorkspacePermissionsRoutes(
  daemon: WorkspacePermissionsDaemon,
  deps: WorkspacePermissionsRouteDeps = {},
): { get: RequestHandler; post: RequestHandler } {
  const failed = {
    error: 'Workspace permission control failed',
    code: 'workspace_permissions_failed',
  };

  const get = wrap(failed)(async (req, res) => {
    try {
      const result = await daemon.workspacePermissions();
      res.status(200).json(result);
    } catch (err) {
      daemonError(err, res);
    }
  });

  const post = wrap(failed)(async (req, res) => {
    const body = (req.body ?? {}) as {
      scope?: unknown;
      ruleType?: unknown;
      rules?: unknown;
    };

    // Fail closed on a malformed replacement: an unknown scope or rule
    // type is a 400, never silently coerced.
    if (!isPermissionScope(body.scope)) {
      res.status(400).json({
        error: 'Invalid permission scope',
        code: 'invalid_scope',
        allowed: ['user', 'workspace'],
      });
      return;
    }
    if (!isPermissionRuleType(body.ruleType)) {
      res.status(400).json({
        error: 'Invalid permission rule type',
        code: 'invalid_rule_type',
        allowed: ['allow', 'ask', 'deny'],
      });
      return;
    }
    if (
      !Array.isArray(body.rules) ||
      body.rules.some((r) => typeof r !== 'string' || r.trim().length === 0)
    ) {
      res
        .status(400)
        .json({ error: 'Invalid rules list', code: 'invalid_rules' });
      return;
    }
    const scope = body.scope;
    const ruleType = body.ruleType;
    const rules = body.rules as string[];

    let result;
    try {
      result = await daemon.setWorkspacePermissionRules(scope, ruleType, rules);
    } catch (err) {
      daemonError(err, res);
      return;
    }

    void deps.audit?.record({
      action: 'workspace_permission_rules_set',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      detail: { scope, ruleType, rules },
    });

    res.status(200).json(result);
  });

  return { get, post };
}
