/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient, type DaemonSessionSummary } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { DaemonPool, type SessionDaemon } from '../daemonPool.js';
import { resolveChatsDir } from '../sessions/chatsPath.js';
import { createSessionCatalogRoute } from './sessionCatalog.js';

const stubs: StubDaemon[] = [];
let gateway: Server | undefined;
let root: string;
let savedRuntime: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rc-catalog-'));
  savedRuntime = process.env['QWEN_RUNTIME_DIR'];
  process.env['QWEN_RUNTIME_DIR'] = root;
});

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  gateway = undefined;
  for (const s of stubs.splice(0)) await s.close();
  if (savedRuntime === undefined) delete process.env['QWEN_RUNTIME_DIR'];
  else process.env['QWEN_RUNTIME_DIR'] = savedRuntime;
  rmSync(root, { recursive: true, force: true });
});

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
const row = (
  id: string,
  minute: number,
  extra: Partial<DaemonSessionSummary> = {},
) =>
  ({
    sessionId: id,
    workspaceCwd: '',
    updatedAt: at(minute),
    ...extra,
  }) as DaemonSessionSummary;

/** A transcript on disk for `cwd`, with a first user message and an mtime. */
function plant(cwd: string, id: string, minute: number, text: string) {
  const dir = resolveChatsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(
    file,
    JSON.stringify({ type: 'user', message: { parts: [{ text }] } }) + '\n',
  );
  const when = new Date(at(minute));
  utimesSync(file, when, when);
}

/** A pool whose default daemon serves /w/home and which spawns a stub per
 * workspace, each serving `catalogs[cwd]` for its own workspace. */
async function poolOver(
  catalogs: Record<
    string,
    NonNullable<Parameters<typeof startStubDaemon>[0]>['catalog']
  >,
) {
  const boot = await startStubDaemon({
    workspaceCwd: '/w/home',
    catalog: catalogs['/w/home'],
  });
  stubs.push(boot);
  const byCwd: Record<string, StubDaemon> = { '/w/home': boot };
  const pool = new DaemonPool({
    defaultDaemon: new DaemonClient({ baseUrl: boot.baseUrl }),
    defaultWorkspaceCwd: '/w/home',
    spawn: async (cwd) => {
      const own = await startStubDaemon({
        workspaceCwd: cwd,
        catalog: catalogs[cwd],
      });
      stubs.push(own);
      byCwd[cwd] = own;
      return {
        client: new DaemonClient({ baseUrl: own.baseUrl }),
        stop: async () => {},
        workspaceCwd: cwd,
      };
    },
  });
  return { pool, byCwd };
}

async function mount(
  daemon: Pick<SessionDaemon, 'listSessionsCatalog'>,
  /** `null` stands for a default workspace that cannot be resolved. */
  defaults: string[] | null = ['/w/home'],
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post(
    '/rc/sessions/catalog',
    createSessionCatalogRoute({
      daemon,
      defaultWorkspaces: async () => defaults ?? undefined,
    }),
  );
  gateway = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return `http://127.0.0.1:${(gateway!.address() as AddressInfo).port}`;
}

async function post(base: string, body: unknown) {
  const res = await fetch(base + '/rc/sessions/catalog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

describe('POST /rc/sessions/catalog', () => {
  it('merges live daemons and a cold workspace from disk into one order, and pages to the end without repeats', async () => {
    const { pool } = await poolOver({
      '/w/home': {
        '/w/home': { sessions: [row('h1', 50), row('h2', 20), row('h3', 5)] },
      },
      '/w/live': {
        '/w/live': { sessions: [row('l1', 40), row('l2', 30), row('l3', 10)] },
      },
    });
    await pool.getOrSpawn('/w/live');
    plant('/w/cold', 'c0000000-0000-0000-0000-000000000001', 45, 'cold one');
    plant('/w/cold', 'c0000000-0000-0000-0000-000000000002', 15, 'cold two');
    // A preview for a daemon row comes from its transcript.
    plant('/w/home', 'h1', 50, 'home first prompt');
    const base = await mount(pool);

    const first = await post(base, {
      workspaces: ['/w/home', '/w/live', '/w/cold/'],
      options: { size: 3 },
    });
    expect(first.status).toBe(200);
    expect(
      first.body['sessions'].map((r: { sessionId: string }) => r.sessionId),
    ).toEqual(['h1', 'c0000000-0000-0000-0000-000000000001', 'l1']);
    expect(first.body['sessions'][0]).toMatchObject({
      workspace: '/w/home',
      source: 'daemon',
      preview: 'home first prompt',
    });
    expect(first.body['sessions'][1]).toMatchObject({
      workspace: '/w/cold',
      source: 'disk',
      preview: 'cold one',
    });
    expect(
      first.body['workspaces'].map(
        (w: { workspace: string; source: string }) => [w.workspace, w.source],
      ),
    ).toEqual([
      ['/w/home', 'daemon'],
      ['/w/live', 'daemon'],
      ['/w/cold', 'disk'],
    ]);
    // The pool started nothing for the cold folder.
    expect(pool.workspaces()).toEqual(['/w/live']);

    const seen = [...first.body['sessions']];
    let cursor = first.body['nextCursor'];
    while (cursor) {
      const next = await post(base, { cursor });
      expect(next.status).toBe(200);
      seen.push(...next.body['sessions']);
      cursor = next.body['nextCursor'];
    }
    expect(seen.map((r) => r.sessionId)).toEqual([
      'h1',
      'c0000000-0000-0000-0000-000000000001',
      'l1',
      'l2',
      'h2',
      'c0000000-0000-0000-0000-000000000002',
      'l3',
      'h3',
    ]);
  });

  it("carries a member's error in selection order and lists the others", async () => {
    const { pool } = await poolOver({
      '/w/home': { '/w/home': { sessions: [row('h1', 50)] } },
      '/w/locked': {
        '/w/locked': {
          error: {
            code: 'untrusted_workspace',
            message: 'Workspace is not trusted.',
            status: 403,
          },
        },
      },
    });
    await pool.getOrSpawn('/w/locked');
    const base = await mount(pool);
    const r = await post(base, { workspaces: ['/w/locked', '/w/home'] });
    expect(r.status).toBe(200);
    expect(r.body['workspaces'][0]).toMatchObject({
      workspace: '/w/locked',
      done: true,
      error: {
        code: 'untrusted_workspace',
        message: 'Workspace is not trusted.',
        status: 403,
      },
    });
    expect(
      r.body['sessions'].map((s: { sessionId: string }) => s.sessionId),
    ).toEqual(['h1']);
  });

  it('passes groups through in the organized view and merges them', async () => {
    const { pool } = await poolOver({
      '/w/home': {
        '/w/home': {
          sessions: [row('h1', 50, { groupId: 'g-home', isPinned: false })],
          groups: [
            {
              id: 'g-home',
              name: 'Release',
              color: 'green',
              order: 0,
              createdAt: at(1),
              updatedAt: at(1),
            },
          ],
        },
      },
    });
    const base = await mount(pool);
    const r = await post(base, {
      options: { view: 'organized', size: 10 },
      includeGroups: true,
    });
    expect(r.status).toBe(200);
    expect(r.body['groups']).toMatchObject({
      groups: [{ id: 'g-home', name: 'Release' }],
    });
    expect(r.body['sessions'][0]).toMatchObject({
      sessionId: 'h1',
      groupId: 'g-home',
    });
  });

  it('reads every workspace from disk on a daemon without the route', async () => {
    const boot = await startStubDaemon({ workspaceCwd: '/w/home' });
    stubs.push(boot);
    plant('/w/home', 'd0000000-0000-0000-0000-000000000001', 9, 'from disk');
    const base = await mount(new DaemonClient({ baseUrl: boot.baseUrl }));
    const r = await post(base, {});
    expect(r.status).toBe(200);
    expect(r.body['sessions']).toEqual([
      expect.objectContaining({
        sessionId: 'd0000000-0000-0000-0000-000000000001',
        source: 'disk',
      }),
    ]);
    expect(r.body['workspaces'][0]).toMatchObject({
      source: 'disk',
      done: true,
    });
    expect(r.body['workspaces'][0].error).toBeUndefined();
  });

  it('refuses a malformed body, a forged cursor, and options beside a cursor', async () => {
    const base = await mount({
      listSessionsCatalog: async () => ({ workspaces: [] }),
    });
    const cases: Array<[unknown, string]> = [
      [{ workspaces: [] }, 'invalid_catalog_request'],
      [
        { workspaces: Array.from({ length: 21 }, (_, i) => `/w/${i}`) },
        'invalid_catalog_request',
      ],
      [{ options: { size: 101 } }, 'invalid_catalog_request'],
      [{ options: { group: 'g1' } }, 'invalid_catalog_request'],
      [{ surprise: 1 }, 'invalid_catalog_request'],
      [{ cursor: 'garbage' }, 'invalid_cursor'],
      [{ cursor: 'x', options: { size: 2 } }, 'invalid_catalog_request'],
    ];
    for (const [body, code] of cases) {
      const r = await post(base, body);
      expect([r.status, r.body['code']], JSON.stringify(body)).toEqual([
        400,
        code,
      ]);
    }
  });

  it('answers 502 when there is no default workspace to list', async () => {
    const base = await mount(
      { listSessionsCatalog: async () => ({ workspaces: [] }) },
      null,
    );
    const r = await post(base, {});
    expect([r.status, r.body['code']]).toEqual([502, 'daemon_unavailable']);
  });
});
