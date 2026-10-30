/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workspace directory create and delete (#123, the directory slice).
 *
 *   POST /rc/workspace/directory/create {path}  -> the daemon's
 *                         POST /workspaces/:workspace/directory/create
 *   POST /rc/workspace/directory/delete {path}  -> the daemon's
 *                         POST /workspaces/:workspace/directory/delete
 *
 * Both at WRITE, refused by requireScope before the body is read, like the
 * file writes beside them (routes/workspaceFileWrites.ts). Paths pass through
 * unchanged and the daemon's refusals are relayed with their status and
 * errorKind through the same mapper, so a name that is taken stays 409
 * `file_already_exists` and a workspace root stays the daemon's refusal.
 * The gateway refuses only input that cannot be a request: a path that is not
 * a non-empty string, or a workspace target that is not a string.
 *
 * WHY THE DELETE ROUTE IS RECURSIVE, AND THE PAGE ASKS FIRST
 *
 * The daemon's directory delete removes the folder and everything in it
 * (`rm -r`), and nothing at the route says how much that is: `stat` gives no
 * tree size and the answer carries no count. The gateway therefore does not
 * pretend to a count; the page builds its confirmation from the listing and
 * says when it stopped counting. The route is a plain relay.
 *
 * WHY EACH HAS ITS OWN WAY TO THE DAEMON
 *
 * Both daemon routes exist only under the workspace-qualified prefix, and the
 * SDK carries `createWorkspaceDirectory` and `deleteWorkspaceDirectory` on
 * `WorkspaceDaemonClient` alone. A bare `DaemonClient` has neither name (the
 * D61 trap), so the interface marks them optional and these routes fall back
 * to the same primary-workspace helpers the pool uses. The SDK returns nothing
 * from either call, so both answer 204 and invent no body.
 *
 * WHAT IS AUDITED
 *
 * Each success leaves a row naming the action and actor, never the path.
 */

import type { Request, RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import {
  createWorkspaceDirectoryOnPrimary,
  deleteWorkspaceDirectoryOnPrimary,
  type PrimaryWorkspaceDeleteClient,
} from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import {
  badRequest,
  jsonBody,
  parseWorkspaceTarget,
  requireString,
  sendWorkspaceFileWriteError,
} from './workspaceFileWrites.js';

function auditDirectory(
  audit: AuditRecorder | undefined,
  req: Request,
  action: 'workspace_directory_created' | 'workspace_directory_deleted',
  cwd: string | undefined,
): void {
  void audit?.record({
    action,
    actorTokenId: req.rcClient?.id,
    subActor: req.rcClient?.subActor,
    // Never the path (#107).
    detail: cwd !== undefined ? { workspace: cwd } : {},
  });
}

/** POST /rc/workspace/directory/create {path} - one new, empty directory. */
export function createWorkspaceDirectoryCreateRoute(
  daemon: Pick<SessionDaemon, 'createWorkspaceDirectory'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const body = jsonBody(req);
    const target = parseWorkspaceTarget(body['workspace']);
    if (!target.ok) {
      badRequest(res, 'Invalid workspace target', 'invalid_workspace');
      return;
    }
    const path = requireString(res, body['path'], 'path', 'invalid_body');
    if (path === null) return;
    try {
      if (typeof daemon.createWorkspaceDirectory === 'function') {
        await daemon.createWorkspaceDirectory(path, undefined, target.cwd);
      } else {
        // A bare DaemonClient: one daemon, so the target cannot pick another.
        await createWorkspaceDirectoryOnPrimary(
          daemon as unknown as PrimaryWorkspaceDeleteClient,
          path,
        );
      }
      auditDirectory(audit, req, 'workspace_directory_created', target.cwd);
      res.status(204).end();
    } catch (err) {
      sendWorkspaceFileWriteError(res, err);
    }
  };
}

/**
 * POST /rc/workspace/directory/delete {path} - the directory and everything
 * in it. The daemon refuses a workspace root, a file and a symlink itself.
 */
export function createWorkspaceDirectoryDeleteRoute(
  daemon: Pick<SessionDaemon, 'deleteWorkspaceDirectory'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const body = jsonBody(req);
    const target = parseWorkspaceTarget(body['workspace']);
    if (!target.ok) {
      badRequest(res, 'Invalid workspace target', 'invalid_workspace');
      return;
    }
    const path = requireString(res, body['path'], 'path', 'invalid_body');
    if (path === null) return;
    try {
      if (typeof daemon.deleteWorkspaceDirectory === 'function') {
        await daemon.deleteWorkspaceDirectory(path, undefined, target.cwd);
      } else {
        await deleteWorkspaceDirectoryOnPrimary(
          daemon as unknown as PrimaryWorkspaceDeleteClient,
          path,
        );
      }
      auditDirectory(audit, req, 'workspace_directory_deleted', target.cwd);
      res.status(204).end();
    } catch (err) {
      sendWorkspaceFileWriteError(res, err);
    }
  };
}
