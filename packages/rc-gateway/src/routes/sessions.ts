/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import { archiveChatsDirOf, resolveChatsDir } from '../sessions/chatsPath.js';
import { listSessionsAcross } from '../sessions/sessionList.js';

/**
 * GET /rc/sessions — a flat, workspace-wide list of sessions with fork lineage:
 * each item carries its `parentSessionId` (when a fork) and a derived `forks[]`
 * reverse index, so a client can render the fork tree. `truncated` flags a
 * partial scan (the file-count cap was hit).
 *
 * OWNER-scoped at the mount (same posture as `/session/:id/lineage`): a flat
 * topology enumerates sibling/ancestor ids a session-locked share token must
 * never see. Read-only and daemon-light — `resolveWorkspaceCwd` is
 * request-aware (callers may honor a `?cwd`/`:cwd` override, `path.resolve`d,
 * falling back to the trusted boot `workspaceCwd`), then the listing scans
 * the on-disk chats dir (the same first-record `forkedFrom` source lineage
 * reads). Any request-supplied cwd only ever becomes a `sanitizeCwd` project-id
 * segment (every non-alphanumeric char becomes a dash) before touching disk, so it
 * can never escape the chats root. The on-disk scan (NOT the daemon's
 * active-only `listWorkspaceSessions`) is deliberate: dormant parents must
 * appear.
 *
 * `extraWorkspaces` widens the scan to the other workspaces this gateway has
 * worked in, which is what makes a conversation started in one workspace
 * selectable from another. It is called with the request and returns `[]` when
 * the caller named a workspace explicitly, because `?cwd`/`:cwd` means "that
 * workspace only" to the per-workspace views. Omitting it keeps the single
 * workspace scan, which is the contract of the bare-namespace
 * `/workspace/:cwd/sessions` proxy. Widening is not a privilege change: an
 * OWNER token can already reach any one of these dirs by naming it in `?cwd`,
 * so a union of dirs it can already enumerate one at a time grants nothing new.
 */
export function createSessionListRoute(
  resolveWorkspaceCwd: (req: Request) => Promise<string | undefined>,
  audit?: AuditRecorder,
  extraWorkspaces?: (req: Request) => Promise<string[]>,
): RequestHandler {
  return async (req, res) => {
    try {
      const cwd = await resolveWorkspaceCwd(req);
      if (!cwd) {
        res
          .status(502)
          .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
        return;
      }

      const dirs = [resolveChatsDir(cwd)];
      for (const extra of (await extraWorkspaces?.(req)) ?? []) {
        const dir = resolveChatsDir(extra);
        if (!dirs.includes(dir)) dirs.push(dir);
      }

      // `?archiveState=archived` reads the archive dir instead of the chats dir. The
      // default stays exactly what it always was — the chats dir alone — so an
      // existing caller sees no change. Archive is a SEPARATE listing rather
      // than rows added to the main one because an archived conversation
      // cannot be opened: the daemon answers a transcript read on it with
      // `SessionArchivedError` (cli/src/serve/routes/session.ts:6535), so
      // mixing those rows into the live list would offer rows that are certain
      // to fail when pressed.
      // Named `archiveState` to match the daemon's own parameter for this axis
      // (DaemonClient.ts:3100 sets `archiveState` on the workspace list), so one
      // concept does not end up with two names across the two surfaces.
      const archiveState = req.query['archiveState'];
      if (
        archiveState !== undefined &&
        archiveState !== 'active' &&
        archiveState !== 'archived'
      ) {
        res.status(400).json({
          error: "archiveState must be 'active' or 'archived'",
          code: 'invalid_archive_state',
        });
        return;
      }
      const archived = archiveState === 'archived';
      const scanDirs = archived ? dirs.map(archiveChatsDirOf) : dirs;

      // Every dir in the archived scan is an archive dir, so all its rows are
      // marked. Passing the set rather than assuming it inside the scanner
      // keeps the marker tied to where the transcript was actually read from.
      const result = await listSessionsAcross(
        scanDirs,
        archived ? { archivedDirs: scanDirs } : {},
      );

      // Privacy: count + truncated flag only — never the session ids.
      void audit?.record({
        action: 'session_list_read',
        actorTokenId: req.rcClient?.id,
        detail: { count: result.sessions.length, truncated: result.truncated },
      });

      res.status(200).json(result);
    } catch {
      // No global Express error middleware; an uncaught async rejection would
      // hang the request. Map any unexpected failure (e.g. EACCES on readdir)
      // to a clean 500. Guard against a double-send.
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: 'Listing failed', code: 'session_list_failed' });
      }
    }
  };
}
