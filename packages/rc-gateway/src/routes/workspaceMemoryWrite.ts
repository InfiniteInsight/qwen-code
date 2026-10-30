/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workspace memory write and workspace reload (#123, the memory slice of the
 * #107 family).
 *
 *   POST /rc/workspace/memory  {scope, content, mode, workspace?}
 *                                         -> the daemon's POST /workspace/memory
 *   POST /rc/workspace/reload  {workspace?}
 *                                         -> the daemon's POST /workspace/reload
 *
 * Both at WRITE, refused by requireScope before any body is read, like the
 * file writes beside them (routes/workspaceFileWrites.ts). Each takes the
 * family's optional `workspace` target (#28) in its JSON body; it is pool
 * routing only and never reaches the daemon.
 *
 * WHAT MEMORY IS, AND WHY ONLY THE WORKSPACE FILE
 *
 * The daemon's memory is the explicit context file (`QWEN.md`, or `AGENTS.md`)
 * at the bound workspace root plus the same-named file in the user's global
 * `~/.qwen/` directory. The write takes `{scope, content, mode}`: `scope` is
 * `workspace` or `global`, `mode` is `append` or `replace`, and `content` is
 * the text. There is no path (the daemon decides which file), no hash and no
 * version, so a `replace` is an unconditional write.
 *
 * The gateway refuses `scope: "global"`. That file sits outside the workspace
 * every other file route is confined to, and it is loaded into the prompt of
 * every project on the host, so writing it from a phone would be a way out of
 * the sandbox the file browser keeps. GET /rc/workspace/memory never reads its
 * content for the same reason (routes/workspaceContext.ts), and a write the
 * caller could not even read first is blind. The refusal is a 400 here, before
 * any daemon is asked, in its own code so a page can say why.
 *
 * `mode` is required and explicit. The daemon defaults a missing mode to
 * `append`, and the SDK says clients should not lean on that default.
 *
 * WHY THE DAEMON'S REFUSALS ARE RELAYED WITH THEIR OWN CODE
 *
 * The memory handler's error envelope is `{error, code, ...}` (not the fs
 * envelope's `errorKind`): 400 `invalid_scope`, `invalid_mode`,
 * `invalid_content`, `content_too_large` (over 1 MiB), 403
 * `untrusted_workspace`, 413 `memory_file_too_large` (with `bytes` and
 * `limit`), 500 `memory_write_timeout` and `file_error`. The status and code
 * pass through, and the daemon's words with them, because they are what a
 * person can act on. A 404 with no envelope is a daemon without the route.
 *
 * WHY THE BODY IS SIZE GATED HERE (#196)
 *
 * The app-wide JSON parser keeps Express's 100 KB default, which would refuse
 * an ordinary context file as `entity.too.large` before this route ran. So
 * this route reads its own body after the scope check, under the same limit
 * the file writes use, and answers a body over it with 413 `file_too_large`
 * and `maxBytes`, the shape the file routes already give.
 *
 * WHAT RELOAD IS
 *
 * The daemon's reload re-reads the settings environment and pushes it to the
 * live agent child and its open sessions. It answers `{env: {updatedKeys,
 * removedKeys}, changedKeys, childReloaded, sessionsRefreshed?,
 * sessionsSkipped?, childError?, runtimeEnvironmentApplied?}` and publishes a
 * `settings_reloaded` event. It is not a restart: a failed child reload is a
 * 200 with `childError` set, which the relay does not turn into an error,
 * because the daemon decided it was an answer.
 *
 * WHAT IS AUDITED
 *
 * A write that changed the file and a reload each leave a row naming the
 * action, the actor, the mode (for a write) and the target workspace when it
 * is not the default. Never the content and never a path (#107).
 */

import type { Request, RequestHandler, Response } from 'express';
import type {
  DaemonContextFileScope,
  DaemonWriteMemoryRequest,
} from '@qwen-code/sdk/daemon';
import type { SessionDaemon } from '../daemonPool.js';
import { WorkspacePoolFullError } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { relayDaemonAuthFailure } from './daemonAuth.js';
import {
  badRequest,
  jsonBody,
  parseWorkspaceTarget,
} from './workspaceFileWrites.js';

/** The daemon surface the memory write needs. */
export type WorkspaceMemoryWriteDaemon = Pick<
  SessionDaemon,
  'writeWorkspaceMemory'
>;

/** The daemon surface the reload needs. */
export type WorkspaceReloadDaemon = Pick<SessionDaemon, 'reload'>;

interface MemoryErrorBody {
  error?: unknown;
  code?: unknown;
  errorKind?: unknown;
  scope?: unknown;
  mode?: unknown;
  bytes?: unknown;
  limit?: unknown;
  timeoutMs?: unknown;
}

/**
 * Map a daemon failure to this pair's response. A daemon 4xx keeps its status
 * and its own `code` and words (see the header). A daemon 5xx that carries an
 * envelope of its own (`memory_write_timeout`, `file_error`) is told as a 502
 * with the daemon's code and words, because the gateway itself did not fail;
 * one with none is `daemon_unavailable`. A 404 with no envelope is a daemon
 * without the route, so a capability gap: 502 `<what>_unsupported`.
 */
export function sendWorkspaceMemoryError(
  res: Response,
  err: unknown,
  what: 'memory_write' | 'workspace_reload',
): void {
  if (res.headersSent) return;
  if (err instanceof WorkspacePoolFullError) {
    res.status(503).json({
      error: `Workspace daemon pool is full (max ${err.maxDaemons})`,
      code: 'workspace_pool_full',
    });
    return;
  }
  if (relayDaemonAuthFailure(res, err, `workspace_${what}`)) return;
  const status = (err as { status?: unknown } | null)?.status;
  const body = (err as { body?: unknown } | null)?.body as
    | MemoryErrorBody
    | null
    | undefined;
  const code =
    typeof body?.code === 'string'
      ? body.code
      : typeof body?.errorKind === 'string'
        ? body.errorKind
        : undefined;
  const message = typeof body?.error === 'string' ? body.error : undefined;
  const extras = {
    ...(typeof body?.scope === 'string' ? { scope: body.scope } : {}),
    ...(typeof body?.mode === 'string' ? { mode: body.mode } : {}),
    ...(typeof body?.bytes === 'number' ? { bytes: body.bytes } : {}),
    ...(typeof body?.limit === 'number' ? { limit: body.limit } : {}),
    ...(typeof body?.timeoutMs === 'number'
      ? { timeoutMs: body.timeoutMs }
      : {}),
  };
  if (typeof status === 'number' && status >= 400 && status < 500) {
    if (status === 404 && code === undefined) {
      res.status(502).json({
        error:
          what === 'memory_write'
            ? 'Daemon does not support the workspace memory write'
            : 'Daemon does not support the workspace reload',
        code: `${what === 'memory_write' ? 'memory_write' : 'workspace_reload'}_unsupported`,
      });
      return;
    }
    res.status(status).json({
      error: message ?? 'Daemon rejected the request',
      code: code ?? 'daemon_rejected',
      ...extras,
    });
    return;
  }
  if (typeof status === 'number' && status >= 500 && code !== undefined) {
    res.status(502).json({
      error: message ?? 'Daemon failed the request',
      code,
      ...extras,
    });
    return;
  }
  res.status(502).json({
    error: 'Daemon unavailable',
    code: 'daemon_unavailable',
  });
}

function auditMemory(
  audit: AuditRecorder | undefined,
  req: Request,
  action: 'workspace_memory_written' | 'workspace_reloaded',
  cwd: string | undefined,
  extra: Record<string, unknown> = {},
): void {
  void audit?.record({
    action,
    actorTokenId: req.rcClient?.id,
    subActor: req.rcClient?.subActor,
    detail: { ...extra, ...(cwd !== undefined ? { workspace: cwd } : {}) },
  });
}

/**
 * POST /rc/workspace/memory {scope: "workspace", content, mode} - append to
 * or replace the workspace's context file. Answers the daemon's
 * `{ok, filePath, bytesWritten, mode, changed}` untouched; `changed: false`
 * is a whitespace-only append the daemon skipped, still a 200.
 */
export function createWorkspaceMemoryWriteRoute(
  daemon: WorkspaceMemoryWriteDaemon,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const body = jsonBody(req);
    const target = parseWorkspaceTarget(body['workspace']);
    if (!target.ok) {
      badRequest(res, 'Invalid workspace target', 'invalid_workspace');
      return;
    }
    const scope = body['scope'];
    if (scope === 'global') {
      badRequest(
        res,
        'Only the workspace memory file can be written from here',
        'global_scope_not_supported',
      );
      return;
    }
    if (scope !== 'workspace') {
      badRequest(res, '`scope` must be "workspace"', 'invalid_body');
      return;
    }
    const content = body['content'];
    if (typeof content !== 'string') {
      badRequest(res, '`content` must be a string', 'invalid_body');
      return;
    }
    const mode = body['mode'];
    if (mode !== 'append' && mode !== 'replace') {
      badRequest(res, '`mode` must be "append" or "replace"', 'invalid_body');
      return;
    }
    const request: DaemonWriteMemoryRequest = {
      scope: scope as DaemonContextFileScope,
      content,
      mode,
    };
    try {
      const result = await daemon.writeWorkspaceMemory(
        request,
        undefined,
        target.cwd,
      );
      if (result.changed !== false) {
        auditMemory(audit, req, 'workspace_memory_written', target.cwd, {
          mode,
        });
      }
      res.status(200).json(result);
    } catch (err) {
      sendWorkspaceMemoryError(res, err, 'memory_write');
    }
  };
}

/**
 * POST /rc/workspace/reload - the daemon's settings reload, answered as the
 * daemon answered it. The body, when sent, is only the workspace target.
 */
export function createWorkspaceReloadRoute(
  daemon: WorkspaceReloadDaemon,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const body = jsonBody(req);
    const target = parseWorkspaceTarget(body['workspace']);
    if (!target.ok) {
      badRequest(res, 'Invalid workspace target', 'invalid_workspace');
      return;
    }
    try {
      const result = await daemon.reload(undefined, target.cwd);
      auditMemory(audit, req, 'workspace_reloaded', target.cwd);
      res.status(200).json(result);
    } catch (err) {
      sendWorkspaceMemoryError(res, err, 'workspace_reload');
    }
  };
}
