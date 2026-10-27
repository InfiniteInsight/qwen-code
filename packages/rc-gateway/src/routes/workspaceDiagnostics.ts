/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import { WorkspacePoolFullError } from '../daemonPool.js';

/** The daemon surface these two routes need. */
export type WorkspaceDiagnosticsDaemon = Pick<
  SessionDaemon,
  'workspaceEnv' | 'workspacePreflight'
>;

/**
 * rc-workspace-scoping (#28): resolve the optional `workspace` target out of
 * a GET query value. Absent or empty string → the default/boot workspace
 * (`undefined`); a non-empty string is trimmed and used as the target cwd;
 * any other shape is a 400 `invalid_workspace` (the handler sends it and
 * returns). Copied from the settings sibling so both parse the same shape.
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
 * The shared body of both diagnostics reads. Kept as one function because the
 * two payloads carry the same envelope (`v`, `workspaceCwd`, `initialized`,
 * `acpChannelLive`, `cells`, optional `errors`) and must therefore fail the
 * same way; two copies would drift, and the drift would show up as one panel
 * reporting a daemon problem differently from the other.
 *
 * `unsupportedCode` is per-route on purpose. A daemon 404 here is mapped to a
 * 502 with a named verdict, which is what the two shipped workspace siblings
 * already do (`settings_unsupported`, `permissions_unsupported`). That is
 * deliberately NOT the rule the session resources relay kept, where a daemon
 * 404 stays a 404: on `/session/:id/resources` the 404 has a referent the
 * caller cares about, the conversation, and reporting it as an old daemon
 * would send someone to upgrade a daemon that is fine. These two paths carry
 * no such identity in the URL, so there is nothing for a 404 to mean except
 * "this daemon will not answer this", which is a gateway-level verdict.
 */
function diagnosticsRead(
  daemon: WorkspaceDiagnosticsDaemon,
  which: 'env' | 'preflight',
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
      const result =
        which === 'env'
          ? await daemon.workspaceEnv(target.cwd)
          : await daemon.workspacePreflight(target.cwd);
      // The payload is the daemon's own diagnostic cells, relayed untouched.
      // Every one of them is the daemon's word for its own state, so nothing
      // here is relabelled, reordered, or filtered, and no cell is dropped for
      // being an error: a failing check is the most useful row on the page.
      res.status(200).json(result);
    } catch (err) {
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
      if (status === 404) {
        res.status(502).json({
          error:
            which === 'env'
              ? 'Daemon does not support workspace environment read'
              : 'Daemon does not support workspace preflight read',
          code: which === 'env' ? 'env_unsupported' : 'preflight_unsupported',
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

/**
 * GET /rc/workspace/env — the workspace's environment cells. Mounted at the
 * WRITE floor (server.ts), like the other workspace reads.
 *
 * WRITE rather than a read floor because of what these cells are. The daemon
 * says so itself at packages/cli/src/serve/routes/workspace-status.ts:381:
 * "Read-only diagnostic surfaces are reconnaissance vectors (env: secret-var
 * presence; preflight: workspace path + CLI entry + Node version)". A cell
 * that says `HTTPS_PROXY present: true` is a fact about the host, not a name,
 * so #107's rule puts it with the host-content half.
 *
 * One thing the relay must not do, because the daemon already guarantees it:
 * `DaemonEnvCell.value` is documented as ALWAYS omitted for `kind='env_var'`
 * (packages/sdk-typescript/src/daemon/types.ts:3067), so a secret's value is
 * never on the wire and presence is the only thing reported about it. The
 * gateway relays verbatim and does not synthesize a value for an absent one,
 * which keeps that guarantee in the daemon where it belongs instead of
 * leaving it to a page that might one day print `cell.value` unguarded.
 */
export function createWorkspaceEnvRoute(
  daemon: WorkspaceDiagnosticsDaemon,
): RequestHandler {
  return diagnosticsRead(daemon, 'env');
}

/**
 * GET /rc/workspace/preflight — the workspace's startup checks. Same floor and
 * same reasoning as the environment read above.
 *
 * `DaemonPreflightCell.kind` is a closed union in the SDK (12 members) and
 * `status` a closed union of 6, but both are the daemon's vocabulary and the
 * daemon can add members without the gateway's type file moving. So the page
 * draws whatever word arrives rather than a switch over the members it knows,
 * which is the same rule the resources relay kept for an open union.
 */
export function createWorkspacePreflightRoute(
  daemon: WorkspaceDiagnosticsDaemon,
): RequestHandler {
  return diagnosticsRead(daemon, 'preflight');
}
