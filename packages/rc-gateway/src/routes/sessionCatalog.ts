/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import type { Request, RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import type { SessionDaemon } from '../daemonPool.js';
import {
  CATALOG_MAX_MEMBERS,
  CatalogCursorError,
  decodeCatalogCursor,
  parseCatalogOptions,
  readCatalogPage,
  type CatalogDeps,
  type CatalogMemberState,
  type CatalogOptions,
} from '../sessions/catalogFanout.js';

/**
 * POST /rc/sessions/catalog: the session catalog across the workspaces this
 * gateway lists (#132), one merged order and one cursor. The merge, the
 * cursor and where each member is read from are in sessions/catalogFanout.ts.
 *
 * Body, first page:
 *   { workspaces?: string[], options?: { size, archiveState, view, group },
 *     includeGroups?: boolean }
 * `workspaces` (1 to 20 cwds, `path.resolve`d like `/rc/sessions`'s `?cwd`)
 * defaults to the set `GET /rc/sessions` unions: the default workspace and the
 * workspaces this gateway has worked in.
 *
 * Body, later pages: { cursor, includeGroups? }. The cursor fixes the members
 * and the options, so sending either beside it is a 400 rather than a value
 * silently ignored.
 *
 * OWNER-scoped at the mount, like `/rc/sessions` and `/rc/sessions/live-state`:
 * the answer names every session in every workspace, and a session-locked
 * share token or a read token must not enumerate siblings. A POST because
 * the cursor can be long, not because it changes anything: nothing here
 * writes, spawns a daemon or keeps one from idling out.
 *
 * The cursor is not signed. An OWNER can already name any workspace, so a
 * cursor naming one grants nothing; it is decoded strictly and a malformed
 * one is a 400 `invalid_cursor`.
 */
export function createSessionCatalogRoute(deps: {
  daemon: Pick<SessionDaemon, 'listSessionsCatalog'>;
  /** The members when the caller names none; undefined when the default
   * workspace cannot be resolved (the daemon is down). */
  defaultWorkspaces: (req: Request) => Promise<string[] | undefined>;
  audit?: AuditRecorder;
  /** Test seams for the disk reads. */
  scanDisk?: CatalogDeps['scanDisk'];
  readPreview?: CatalogDeps['readPreview'];
}): RequestHandler {
  return async (req, res) => {
    const bad = (error: string, code = 'invalid_catalog_request') =>
      res.status(400).json({ error, code });
    try {
      const body: unknown = req.body ?? {};
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        bad('the body must be a JSON object');
        return;
      }
      const b = body as Record<string, unknown>;
      const unknownKey = Object.keys(b).find(
        (k) =>
          !['workspaces', 'cursor', 'options', 'includeGroups'].includes(k),
      );
      if (unknownKey !== undefined) {
        bad(`unknown field ${JSON.stringify(unknownKey)}`);
        return;
      }
      if (
        b['includeGroups'] !== undefined &&
        typeof b['includeGroups'] !== 'boolean'
      ) {
        bad('includeGroups must be a boolean');
        return;
      }
      const includeGroups = b['includeGroups'] === true;

      let members: CatalogMemberState[];
      let options: CatalogOptions;
      if (b['cursor'] !== undefined) {
        if (typeof b['cursor'] !== 'string') {
          bad('cursor must be a string', 'invalid_cursor');
          return;
        }
        if (b['workspaces'] !== undefined || b['options'] !== undefined) {
          bad('a cursor already fixes the workspaces and the options');
          return;
        }
        try {
          ({ members, options } = decodeCatalogCursor(b['cursor']));
        } catch (err) {
          if (err instanceof CatalogCursorError) {
            bad(err.message, 'invalid_cursor');
            return;
          }
          throw err;
        }
      } else {
        const parsed = parseCatalogOptions(b['options']);
        if ('error' in parsed) {
          bad(parsed.error);
          return;
        }
        options = parsed;
        let named: string[];
        if (b['workspaces'] !== undefined) {
          const w = b['workspaces'];
          if (
            !Array.isArray(w) ||
            w.length < 1 ||
            w.length > CATALOG_MAX_MEMBERS ||
            w.some(
              (x) => typeof x !== 'string' || x.length === 0 || x.length > 4096,
            )
          ) {
            bad(
              `workspaces must be 1 to ${CATALOG_MAX_MEMBERS} non-empty paths`,
            );
            return;
          }
          named = w as string[];
        } else {
          const fallback = await deps.defaultWorkspaces(req);
          if (!fallback) {
            res.status(502).json({
              error: 'Daemon unavailable',
              code: 'daemon_unavailable',
            });
            return;
          }
          named = fallback;
        }
        const unique: string[] = [];
        for (const raw of named) {
          const cwd = resolve(raw);
          if (!unique.includes(cwd)) unique.push(cwd);
        }
        members = unique
          .slice(0, CATALOG_MAX_MEMBERS)
          .map((workspace) => ({ workspace, source: 'daemon' as const }));
      }

      const page = await readCatalogPage(
        {
          listSessionsCatalog: (request) =>
            deps.daemon.listSessionsCatalog(request),
          ...(deps.scanDisk ? { scanDisk: deps.scanDisk } : {}),
          ...(deps.readPreview ? { readPreview: deps.readPreview } : {}),
        },
        { members, options, includeGroups },
      );

      // Privacy, as `/rc/sessions`: counts only, never the ids.
      void deps.audit?.record({
        action: 'session_list_read',
        actorTokenId: req.rcClient?.id,
        detail: {
          catalog: true,
          count: page.sessions.length,
          members: page.workspaces.length,
          failedMembers: page.workspaces.filter((w) => w.error).length,
        },
      });
      res.status(200).json(page);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Catalog read failed',
          code: 'session_catalog_failed',
        });
      }
    }
  };
}
