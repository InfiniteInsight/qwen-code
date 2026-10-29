/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonClient,
  DaemonSessionCatalogRequest,
  DaemonSessionCatalogResult,
} from '@qwen-code/sdk';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { resolve } from 'node:path';
import { DaemonPool } from './daemonPool.js';

/** A daemon that answers the catalog for its own workspace only, as a real
 * per-cwd daemon does (session-catalog.ts resolves against its registry). */
function catalogClient(
  cwd: string,
  seen: DaemonSessionCatalogRequest[],
  fail?: () => Error,
) {
  return {
    async listSessionsCatalog(
      req: DaemonSessionCatalogRequest,
    ): Promise<DaemonSessionCatalogResult> {
      seen.push(req);
      if (fail) throw fail();
      const sel =
        req.workspaces === 'all' ? [{ workspace: cwd }] : req.workspaces;
      return {
        workspaces: sel.map((s) =>
          // The daemon canonicalizes a selector before matching it.
          resolve(s.workspace) === cwd
            ? {
                workspace: s.workspace,
                workspaceId: 'id' + cwd,
                cwd,
                sessions: [{ sessionId: 'on' + cwd, workspaceCwd: cwd }],
              }
            : {
                workspace: s.workspace,
                error: {
                  code: 'workspace_not_found',
                  message: 'Workspace is not registered with this daemon.',
                  status: 404,
                },
              },
        ),
      };
    },
    async capabilities() {
      return { workspaceCwd: cwd };
    },
    async health() {
      return { status: 'ok' };
    },
  } as unknown as DaemonClient;
}

function makePool(
  spawned: string[],
  seen: Record<string, DaemonSessionCatalogRequest[]>,
  failFor?: Record<string, () => Error>,
) {
  seen['/home/evan'] = [];
  return new DaemonPool({
    defaultDaemon: catalogClient('/home/evan', seen['/home/evan']),
    defaultWorkspaceCwd: '/home/evan',
    spawn: async (cwd) => {
      spawned.push(cwd);
      seen[cwd] = [];
      return {
        client: catalogClient(cwd, seen[cwd], failFor?.[cwd]),
        stop: async () => {},
        workspaceCwd: cwd,
      };
    },
  });
}

describe('DaemonPool.listSessionsCatalog (#132)', () => {
  it('sends each selection to the daemon it holds for that workspace, in selection order, and starts none', async () => {
    const spawned: string[] = [];
    const seen: Record<string, DaemonSessionCatalogRequest[]> = {};
    const pool = makePool(spawned, seen);
    await pool.getOrSpawn('/proj/a');
    const r = await pool.listSessionsCatalog({
      workspaces: [
        { workspace: '/proj/a', cursor: 'ca' },
        { workspace: '/proj/cold' },
        { workspace: '/home/evan/' },
      ],
      options: { pageSize: 5 },
      includeGroups: true,
    });
    expect(r.workspaces.map((w) => w.workspace)).toEqual([
      '/proj/a',
      '/proj/cold',
      '/home/evan/',
    ]);
    expect(r.workspaces[0]).toMatchObject({
      sessions: [{ sessionId: 'on/proj/a' }],
    });
    expect(r.workspaces[1]).toMatchObject({
      error: { code: 'workspace_not_pooled', status: 404 },
    });
    expect(r.workspaces[2]).toMatchObject({ cwd: '/home/evan' });
    // Never spawned for the cold folder; each daemon saw only its own
    // selection, with the cursor and options it was given.
    expect(spawned).toEqual(['/proj/a']);
    expect(seen['/proj/a']).toEqual([
      {
        workspaces: [{ workspace: '/proj/a', cursor: 'ca' }],
        options: { pageSize: 5 },
        includeGroups: true,
      },
    ]);
    expect(seen['/home/evan'][0].workspaces).toEqual([
      { workspace: '/home/evan/' },
    ]);
  });

  it("answers a failing daemon's selections as errors rather than failing the batch", async () => {
    const spawned: string[] = [];
    const seen: Record<string, DaemonSessionCatalogRequest[]> = {};
    const pool = makePool(spawned, seen, {
      // An older daemon: no catalog route, a bare 404 with no envelope.
      '/proj/old': () => new DaemonHttpError(404, undefined, 'Not Found'),
      '/proj/odd': () =>
        new DaemonHttpError(
          403,
          {
            code: 'untrusted_workspace',
            error: 'Workspace is not trusted.',
          },
          'Forbidden',
        ),
    });
    await pool.getOrSpawn('/proj/old');
    await pool.getOrSpawn('/proj/odd');
    const r = await pool.listSessionsCatalog({
      workspaces: [{ workspace: '/proj/old' }, { workspace: '/proj/odd' }],
    });
    expect(r.workspaces).toEqual([
      {
        workspace: '/proj/old',
        error: expect.objectContaining({
          code: 'session_catalog_unsupported',
          status: 404,
        }),
      },
      {
        workspace: '/proj/odd',
        error: {
          code: 'untrusted_workspace',
          message: 'Workspace is not trusted.',
          status: 403,
        },
      },
    ]);
  });

  it("joins every live daemon's own registry for 'all'", async () => {
    const spawned: string[] = [];
    const seen: Record<string, DaemonSessionCatalogRequest[]> = {};
    const pool = makePool(spawned, seen);
    await pool.getOrSpawn('/proj/a');
    const r = await pool.listSessionsCatalog({ workspaces: 'all' });
    expect(r.workspaces.map((w) => w.workspace).sort()).toEqual([
      '/home/evan',
      '/proj/a',
    ]);
  });
});
