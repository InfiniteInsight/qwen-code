/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type {
  DaemonWorkspaceTrustDesiredState,
  DaemonWorkspaceTrustChangeResult,
} from '@qwen-code/sdk';
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

/** The daemon surface this route file needs. */
export type WorkspaceTrustDaemon = Pick<
  SessionDaemon,
  'workspaceTrust' | 'requestWorkspaceTrustChange'
>;

export interface WorkspaceTrustRouteDeps {
  audit?: AuditRecorder;
}

const TRUST_DESIRED_STATES = new Set<string>(['trusted', 'untrusted']);

/**
 * Map a daemon rejection to a gateway response (mirrors
 * routes/approvalMode.ts's mapping, widened to every 4xx the daemon may
 * raise on this surface):
 * - 400/403/409: the daemon's own code + human message, unchanged, so the
 *   remote client learns the real reason (e.g. `folder_trust_disabled`,
 *   `managed_scratch_trust_fixed`);
 * - 404: the daemon predates this surface → 502 `trust_unsupported`;
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
      error: 'Daemon does not support workspace trust control',
      code: 'trust_unsupported',
    });
    return;
  }
  res
    .status(502)
    .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
}

/**
 * GET /rc/workspace/trust — read the workspace trust status. The optional
 * `?statusVersion=2` query is passed through to the daemon (v2 adds the
 * reconciliation state); any other value is a 400. Mounted at the WRITE
 * floor (server.ts).
 *
 * POST /rc/workspace/trust/request — request a trust state change
 * (`{desiredState, reason?}`). Mounted OWNER-only (server.ts). The daemon
 * answers 202 (the change is applied by a LOCAL operator confirming on the
 * daemon host — the gateway never observes the state flip itself), so the
 * 202 and its body are passed through unchanged and the
 * `workspace_trust_requested` audit row is written on the 202, carrying
 * only `{desiredState, reason?}` — never session or prompt content.
 *
 * Both accept an optional `workspace` target (rc-workspace-scoping, #28):
 * `?workspace=<cwd>` on the GET, a `workspace` field on the POST body.
 * Absent/empty → the default/boot workspace; a non-default target names the
 * workspace whose trust status is read / change is requested, and the
 * audit row then carries the resolved `workspace` cwd as well.
 */
export function createWorkspaceTrustRoutes(
  daemon: WorkspaceTrustDaemon,
  deps: WorkspaceTrustRouteDeps = {},
): { get: RequestHandler; request: RequestHandler } {
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
      const raw = req.query.statusVersion;
      if (raw === undefined || raw === '2') {
        try {
          const result = await daemon.workspaceTrust(
            raw === '2' ? { statusVersion: 2 } : {},
            target.cwd,
          );
          res.status(200).json(result);
        } catch (err) {
          daemonError(err, res);
        }
        return;
      }
      res.status(400).json({
        error: 'Invalid status version',
        code: 'invalid_status_version',
        allowed: [1, 2],
      });
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Workspace trust read failed',
          code: 'workspace_trust_failed',
        });
      }
    }
  };

  const request: RequestHandler = async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        desiredState?: unknown;
        reason?: unknown;
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
      if (
        typeof body.desiredState !== 'string' ||
        !TRUST_DESIRED_STATES.has(body.desiredState)
      ) {
        res.status(400).json({
          error: 'Invalid desired trust state',
          code: 'invalid_desired_state',
          allowed: ['trusted', 'untrusted'],
        });
        return;
      }
      // Length/whitespace limits are the daemon's to enforce (its 400
      // `invalid_reason` passes through); here only the type is checked.
      if (body.reason !== undefined && typeof body.reason !== 'string') {
        res.status(400).json({
          error: 'Invalid reason',
          code: 'invalid_reason',
        });
        return;
      }
      const desiredState =
        body.desiredState as DaemonWorkspaceTrustDesiredState;
      const reason = body.reason as string | undefined;

      let result: DaemonWorkspaceTrustChangeResult;
      try {
        result = await daemon.requestWorkspaceTrustChange(
          {
            desiredState,
            ...(reason !== undefined ? { reason } : {}),
          },
          undefined,
          target.cwd,
        );
      } catch (err) {
        daemonError(err, res);
        return;
      }

      void deps.audit?.record({
        action: 'workspace_trust_requested',
        actorTokenId: req.rcClient?.id,
        subActor: req.rcClient?.subActor,
        detail: {
          desiredState,
          ...(reason !== undefined ? { reason } : {}),
          // Only recorded for a non-default target (undefined for the
          // default workspace keeps the row shape unchanged for existing
          // readers).
          ...(target.cwd !== undefined ? { workspace: target.cwd } : {}),
        },
      });

      // 202 passthrough: accepted, pending local operator confirmation.
      res.status(202).json(result);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Workspace trust request failed',
          code: 'workspace_trust_failed',
        });
      }
    }
  };

  return { get, request };
}
