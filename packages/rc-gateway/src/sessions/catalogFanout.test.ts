/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonSessionCatalogRequest,
  DaemonSessionCatalogResult,
  DaemonSessionSummary,
} from '@qwen-code/sdk';
import {
  CATALOG_MAX_RESEEK_PAGES,
  CatalogCursorError,
  catalogCallFailure,
  compareKeys,
  decodeCatalogCursor,
  encodeCatalogCursor,
  keyOf,
  mergeGroupCatalogs,
  readCatalogPage,
  type CatalogDeps,
  type CatalogMemberState,
  type CatalogOptions,
  type CatalogPage,
  type CatalogRow,
} from './catalogFanout.js';
import type { SessionListItem } from './sessionList.js';

/**
 * A daemon per workspace, paging the way the real metadata/organized paths
 * do (session-list.ts): the rows sorted by the daemon's key, a keyset cursor
 * holding the last key, and `invalid_cursor` for a cursor it did not issue
 * (here: one minted before `restart()`).
 */
class FakeDaemon {
  generation = 1;
  calls = 0;
  failNext: { code: string; message: string; status: number } | undefined;
  failAlways: { code: string; message: string; status: number } | undefined;
  constructor(
    readonly workspace: string,
    public rows: DaemonSessionSummary[],
    readonly groups?: { id: string; name: string; updatedAt: string }[],
  ) {}
  restart() {
    this.generation++;
  }
  read(
    cursor: string | undefined,
    size: number,
    organized: boolean,
    includeGroups: boolean,
  ): DaemonSessionCatalogResult['workspaces'][number] {
    this.calls++;
    const fail = this.failNext ?? this.failAlways;
    this.failNext = undefined;
    if (fail) return { workspace: this.workspace, error: fail };
    const keyed = this.rows
      .map((s) => ({
        s,
        k: keyOf(
          { ...s, workspace: this.workspace, source: 'daemon' },
          organized,
        ),
      }))
      .sort((a, b) => compareKeys(a.k, b.k));
    let start = 0;
    if (cursor !== undefined) {
      const parsed = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );
      if (parsed.gen !== this.generation) {
        return {
          workspace: this.workspace,
          error: {
            code: 'invalid_cursor',
            message: 'Invalid cursor',
            status: 400,
          },
        };
      }
      start = keyed.findIndex((x) => compareKeys(x.k, parsed.last) > 0);
      if (start === -1) start = keyed.length;
    }
    const page = keyed.slice(start, start + size);
    const more = start + size < keyed.length;
    return {
      workspace: this.workspace,
      workspaceId: 'id-' + this.workspace,
      cwd: this.workspace,
      sessions: page.map((x) => x.s),
      ...(more
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                gen: this.generation,
                last: page[page.length - 1].k,
              }),
            ).toString('base64url'),
          }
        : {}),
      ...(includeGroups && this.groups
        ? {
            groups: {
              groups: this.groups.map((g) => ({
                ...g,
                color: 'blue' as const,
                order: 0,
                createdAt: g.updatedAt,
              })),
              colorOptions: ['blue' as const],
            },
          }
        : {}),
    };
  }
}

/** The pool's answer: a page from a live member, `workspace_not_pooled` for
 * a workspace no daemon serves. */
function poolOf(
  daemons: FakeDaemon[],
  requests: DaemonSessionCatalogRequest[] = [],
) {
  const byWs = new Map(daemons.map((d) => [d.workspace, d]));
  return {
    requests,
    listSessionsCatalog: async (
      req: DaemonSessionCatalogRequest,
    ): Promise<DaemonSessionCatalogResult> => {
      requests.push(req);
      const sel = req.workspaces === 'all' ? [] : req.workspaces;
      return {
        workspaces: sel.map((s) => {
          const d = byWs.get(s.workspace);
          if (!d) {
            return {
              workspace: s.workspace,
              error: {
                code: 'workspace_not_pooled',
                message: 'none',
                status: 404,
              },
            };
          }
          return d.read(
            s.cursor,
            req.options?.pageSize ?? 20,
            req.options?.view === 'organized',
            req.includeGroups === true,
          );
        }),
      };
    },
  };
}

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
const sess = (
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

const noPreview: Pick<CatalogDeps, 'readPreview' | 'scanDisk'> = {
  readPreview: async () => null,
  scanDisk: async () => ({ sessions: [], truncated: false }),
};

const fresh = (...workspaces: string[]): CatalogMemberState[] =>
  workspaces.map((workspace) => ({ workspace, source: 'daemon' }));

/** Reads every page from a first state, returning the pages. */
async function readAll(
  deps: CatalogDeps,
  members: CatalogMemberState[],
  options: CatalogOptions,
  between?: (pageNo: number) => void,
  includeGroups = false,
): Promise<CatalogPage[]> {
  const pages: CatalogPage[] = [];
  let state = { members, options };
  for (let i = 0; i < 100; i++) {
    const page = await readCatalogPage(deps, { ...state, includeGroups });
    pages.push(page);
    if (!page.nextCursor) return pages;
    // Round trip the cursor every time, as a client would.
    state = decodeCatalogCursor(page.nextCursor);
    between?.(i + 1);
  }
  throw new Error('did not finish');
}

const ids = (rows: CatalogRow[]) => rows.map((r) => r.sessionId);

describe('readCatalogPage', () => {
  it('merges two workspaces into one order, newest first, ties by id', async () => {
    const a = new FakeDaemon('/a', [
      sess('a1', 50),
      sess('a2', 30),
      sess('a3', 10),
    ]);
    const b = new FakeDaemon('/b', [
      sess('b1', 40),
      sess('b2', 30),
      sess('b3', 20),
    ]);
    const page = await readCatalogPage(
      { ...poolOf([a, b]), ...noPreview },
      {
        members: fresh('/a', '/b'),
        options: { size: 4 },
        includeGroups: false,
      },
    );
    expect(ids(page.sessions)).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(page.sessions.map((r) => r.workspace)).toEqual([
      '/a',
      '/b',
      '/a',
      '/b',
    ]);
    expect(page.sessions.every((r) => r.source === 'daemon')).toBe(true);
    expect(page.workspaces.map((w) => [w.workspace, w.count, w.done])).toEqual([
      ['/a', 2, false],
      ['/b', 2, false],
    ]);
    expect(page.nextCursor).toBeDefined();
  });

  it('pages through the whole union with no duplicates and no gaps, across daemon and disk members', async () => {
    const a = new FakeDaemon(
      '/a',
      Array.from({ length: 13 }, (_, i) =>
        sess(`a${String(i).padStart(2, '0')}`, 100 - i * 7),
      ),
    );
    const b = new FakeDaemon(
      '/b',
      // Dense recent activity: b's rows crowd the first pages.
      Array.from({ length: 9 }, (_, i) => sess(`b${i}`, 99 - i)),
    );
    const disk: SessionListItem[] = Array.from({ length: 6 }, (_, i) => ({
      sessionId: `c${i}`,
      forks: [],
      updatedAt: at(95 - i * 13),
      preview: `disk ${i}`,
    }));
    const deps: CatalogDeps = {
      ...poolOf([a, b]),
      readPreview: async () => null,
      scanDisk: async (ws) => ({
        sessions: ws === '/c' ? disk : [],
        truncated: false,
      }),
    };
    const pages = await readAll(deps, fresh('/a', '/b', '/c'), { size: 4 });
    const all = pages.flatMap((p) => p.sessions);
    const expected = [...a.rows, ...b.rows]
      .map((s) => ({ id: s.sessionId, t: Date.parse(s.updatedAt!) }))
      .concat(
        disk.map((d) => ({ id: d.sessionId, t: Date.parse(d.updatedAt) })),
      )
      .sort((x, y) => y.t - x.t || x.id.localeCompare(y.id))
      .map((x) => x.id);
    expect(ids(all)).toEqual(expected);
    expect(new Set(ids(all)).size).toBe(all.length);
    // Every page but the last is full: the frontier reads ahead rather than
    // returning a short page.
    for (const p of pages.slice(0, -1)) expect(p.sessions).toHaveLength(4);
    expect(pages[pages.length - 1].nextCursor).toBeUndefined();
    expect(pages[0].workspaces[2]).toMatchObject({
      workspace: '/c',
      source: 'disk',
    });
    expect(all.find((r) => r.sessionId === 'c0')).toMatchObject({
      source: 'disk',
      preview: 'disk 0',
    });
  });

  it('round trips the cursor exactly', () => {
    const state = {
      options: {
        size: 7,
        view: 'organized' as const,
        archiveState: 'active' as const,
      },
      members: [
        {
          workspace: '/a',
          source: 'daemon' as const,
          cursor: 'abc',
          boundary: [1, 5, 'x'] as [1, number, string],
        },
        { workspace: '/b', source: 'disk' as const, done: true as const },
        {
          workspace: '/c',
          source: 'daemon' as const,
          failed: { code: 'untrusted_workspace', message: 'no', status: 403 },
        },
      ],
    };
    expect(decodeCatalogCursor(encodeCatalogCursor(state))).toEqual(state);
  });

  it('refuses a cursor it did not issue', () => {
    for (const bad of [
      '',
      'not-base64-json',
      Buffer.from(JSON.stringify({ v: 2, options: {}, members: [] })).toString(
        'base64url',
      ),
      Buffer.from(
        JSON.stringify({
          v: 1,
          options: { size: 500 },
          members: [{ workspace: '/a', source: 'daemon' }],
        }),
      ).toString('base64url'),
      Buffer.from(
        JSON.stringify({
          v: 1,
          members: [
            { workspace: '/a', source: 'daemon', boundary: [2, 1, 'x'] },
          ],
        }),
      ).toString('base64url'),
      Buffer.from(
        JSON.stringify({
          v: 1,
          members: [{ workspace: '/a', source: 'elsewhere' }],
        }),
      ).toString('base64url'),
    ]) {
      expect(() => decodeCatalogCursor(bad)).toThrow(CatalogCursorError);
    }
  });

  it('carries a member error in selection order, keeps listing the others, and recovers the failed member without a gap', async () => {
    const a = new FakeDaemon(
      '/a',
      Array.from({ length: 8 }, (_, i) => sess(`a${i}`, 100 - i * 2)),
    );
    const b = new FakeDaemon(
      '/b',
      Array.from({ length: 8 }, (_, i) => sess(`b${i}`, 99 - i * 2)),
    );
    const deps = { ...poolOf([a, b]), ...noPreview };
    const first = await readCatalogPage(deps, {
      members: fresh('/a', '/b'),
      options: { size: 4 },
      includeGroups: false,
    });
    expect(ids(first.sessions)).toEqual(['a0', 'b0', 'a1', 'b1']);
    // b is down for one page.
    b.failNext = {
      code: 'workspace_runtime_unavailable',
      message: 'Workspace runtime is not active.',
      status: 503,
    };
    const second = await readCatalogPage(deps, {
      ...decodeCatalogCursor(first.nextCursor!),
      includeGroups: false,
    });
    expect(second.workspaces[1]).toMatchObject({
      workspace: '/b',
      count: 0,
      done: false,
      error: { code: 'workspace_runtime_unavailable', status: 503 },
    });
    expect(ids(second.sessions)).toEqual(['a2', 'a3', 'a4', 'a5']);
    expect(second.nextCursor).toBeDefined();
    // b answers again: its rows the reader has not seen arrive, late, and
    // nothing is listed twice.
    const rest = await readAll(
      deps,
      decodeCatalogCursor(second.nextCursor!).members,
      { size: 4 },
    );
    const seen = [
      ...first.sessions,
      ...second.sessions,
      ...rest.flatMap((p) => p.sessions),
    ];
    expect(new Set(ids(seen)).size).toBe(seen.length);
    expect(ids(seen).sort()).toEqual(
      [...a.rows, ...b.rows].map((s) => s.sessionId).sort(),
    );
    expect(rest[0].sessions[0].sessionId).toBe('b2');
  });

  it('marks a member that refuses for good as failed, never asks it again, and repeats its error on every page', async () => {
    const a = new FakeDaemon(
      '/a',
      Array.from({ length: 6 }, (_, i) => sess(`a${i}`, 100 - i)),
    );
    const b = new FakeDaemon('/b', [sess('b0', 50)]);
    b.failAlways = {
      code: 'untrusted_workspace',
      message: 'Workspace is not trusted.',
      status: 403,
    };
    const pages = await readAll(
      { ...poolOf([a, b]), ...noPreview },
      fresh('/a', '/b'),
      { size: 2 },
    );
    expect(pages).toHaveLength(3);
    for (const p of pages) {
      expect(p.workspaces[1]).toMatchObject({
        workspace: '/b',
        done: true,
        error: { code: 'untrusted_workspace' },
      });
    }
    expect(b.calls).toBe(1);
    expect(ids(pages.flatMap((p) => p.sessions))).toEqual(
      a.rows.map((s) => s.sessionId),
    );
  });

  it('finds its place again when a member cursor expires, without repeating or skipping a row', async () => {
    const a = new FakeDaemon(
      '/a',
      Array.from({ length: 12 }, (_, i) =>
        sess(`a${String(i).padStart(2, '0')}`, 100 - i),
      ),
    );
    const deps = { ...poolOf([a]), ...noPreview };
    const pages = await readAll(deps, fresh('/a'), { size: 3 }, (n) => {
      if (n === 2) a.restart(); // the daemon came back; its cursors are void
    });
    const all = pages.flatMap((p) => p.sessions);
    expect(ids(all)).toEqual(a.rows.map((s) => s.sessionId));
    expect(pages.every((p) => !p.workspaces[0].error)).toBe(true);
  });

  it('says cursor_expired when the seek runs out of pages, and keeps seeking on the next request', async () => {
    const n = 3 * (CATALOG_MAX_RESEEK_PAGES + 3);
    const a = new FakeDaemon(
      '/a',
      Array.from({ length: n }, (_, i) =>
        sess(`a${String(i).padStart(3, '0')}`, 1000 - i),
      ),
    );
    const deps = { ...poolOf([a]), ...noPreview };
    let state = {
      members: fresh('/a'),
      options: { size: 3 } as CatalogOptions,
    };
    const seen: CatalogRow[] = [];
    // Read far enough that the boundary sits beyond the seek's reach.
    for (let i = 0; i < CATALOG_MAX_RESEEK_PAGES + 1; i++) {
      const p = await readCatalogPage(deps, { ...state, includeGroups: false });
      seen.push(...p.sessions);
      state = decodeCatalogCursor(p.nextCursor!);
    }
    a.restart();
    const expired = await readCatalogPage(deps, {
      ...state,
      includeGroups: false,
    });
    expect(expired.sessions).toEqual([]);
    expect(expired.workspaces[0].error).toMatchObject({
      code: 'cursor_expired',
      status: 410,
    });
    expect(expired.nextCursor).toBeDefined();
    const rest = await readAll(
      deps,
      decodeCatalogCursor(expired.nextCursor!).members,
      { size: 3 },
    );
    seen.push(...rest.flatMap((p) => p.sessions));
    expect(ids(seen)).toEqual(a.rows.map((s) => s.sessionId));
  });

  it('answers an empty page with no cursor when every member is empty', async () => {
    const a = new FakeDaemon('/a', []);
    const page = await readCatalogPage(
      { ...poolOf([a]), ...noPreview },
      {
        members: fresh('/a', '/cold'),
        options: { size: 5 },
        includeGroups: false,
      },
    );
    expect(page.sessions).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.workspaces).toEqual([
      expect.objectContaining({
        workspace: '/a',
        source: 'daemon',
        done: true,
        count: 0,
      }),
      expect.objectContaining({
        workspace: '/cold',
        source: 'disk',
        done: true,
        count: 0,
      }),
    ]);
    const none = await readCatalogPage(
      { ...poolOf([]), ...noPreview },
      { members: [], options: { size: 5 }, includeGroups: true },
    );
    expect(none).toEqual({
      v: 1,
      sessions: [],
      workspaces: [],
      groups: { groups: [], colorOptions: [] },
    });
  });

  it('reads a workspace with no daemon from disk, and a disk member refuses a group filter rather than ignoring it', async () => {
    const disk: SessionListItem[] = [
      {
        sessionId: 'd1',
        forks: [],
        updatedAt: at(5),
        title: 'named',
        titleSource: 'manual',
      },
    ];
    const deps: CatalogDeps = {
      ...poolOf([]),
      readPreview: async () => null,
      scanDisk: async () => ({ sessions: disk, truncated: true }),
    };
    const page = await readCatalogPage(deps, {
      members: fresh('/cold'),
      options: { size: 5 },
      includeGroups: false,
    });
    expect(page.sessions).toEqual([
      expect.objectContaining({
        sessionId: 'd1',
        source: 'disk',
        displayName: 'named',
        titleSource: 'manual',
      }),
    ]);
    expect(page.workspaces[0]).toMatchObject({
      source: 'disk',
      truncated: true,
      done: true,
    });
    const grouped = await readCatalogPage(deps, {
      members: fresh('/cold'),
      options: { size: 5, view: 'organized', group: 'g1' },
      includeGroups: false,
    });
    expect(grouped.sessions).toEqual([]);
    expect(grouped.workspaces[0].error).toMatchObject({
      code: 'group_filter_unavailable',
    });
  });

  it('passes includeGroups through and merges group records by id', async () => {
    const a = new FakeDaemon(
      '/a',
      [sess('a1', 5, { groupId: 'g1' })],
      [
        { id: 'g1', name: 'old name', updatedAt: at(1) },
        { id: 'g2', name: 'two', updatedAt: at(1) },
      ],
    );
    const b = new FakeDaemon(
      '/b',
      [sess('b1', 4, { groupId: 'g1' })],
      [{ id: 'g1', name: 'new name', updatedAt: at(2) }],
    );
    const requests: DaemonSessionCatalogRequest[] = [];
    const page = await readCatalogPage(
      { ...poolOf([a, b], requests), ...noPreview },
      {
        members: fresh('/a', '/b'),
        options: { size: 5, view: 'organized' },
        includeGroups: true,
      },
    );
    expect(requests[0].includeGroups).toBe(true);
    expect(requests[0].options).toMatchObject({
      pageSize: 5,
      view: 'organized',
    });
    expect(page.groups?.groups.map((g) => [g.id, g.name]).sort()).toEqual([
      ['g1', 'new name'],
      ['g2', 'two'],
    ]);
    expect(page.sessions.map((r) => r.groupId)).toEqual(['g1', 'g1']);
    expect(
      mergeGroupCatalogs([
        { groups: [], colorOptions: ['red'] },
        { groups: [], colorOptions: ['red', 'blue'] },
      ]).colorOptions,
    ).toEqual(['red', 'blue']);
  });

  it('sorts pinned rows first across workspaces in the organized view', async () => {
    const a = new FakeDaemon('/a', [
      sess('a1', 50),
      sess('a2', 10, { isPinned: true }),
    ]);
    const b = new FakeDaemon('/b', [
      sess('b1', 40, { isPinned: true }),
      sess('b2', 30),
    ]);
    const page = await readCatalogPage(
      { ...poolOf([a, b]), ...noPreview },
      {
        members: fresh('/a', '/b'),
        options: { size: 10, view: 'organized' },
        includeGroups: false,
      },
    );
    expect(ids(page.sessions)).toEqual(['b1', 'a2', 'a1', 'b2']);
  });

  it('joins a preview onto each daemon row on the page, by session id', async () => {
    const a = new FakeDaemon('/a', [sess('a1', 5), sess('a2', 4)]);
    const asked: string[] = [];
    const page = await readCatalogPage(
      {
        ...poolOf([a]),
        scanDisk: async () => ({ sessions: [], truncated: false }),
        readPreview: async (ws, id) => {
          asked.push(`${ws}:${id}`);
          return id === 'a1' ? 'first prompt' : null;
        },
      },
      { members: fresh('/a'), options: { size: 1 }, includeGroups: false },
    );
    expect(page.sessions).toEqual([
      expect.objectContaining({ sessionId: 'a1', preview: 'first prompt' }),
    ]);
    expect(asked).toEqual(['/a:a1']); // only the rows on the page
  });

  it('turns a whole-call failure into every member error, and an old daemon into a disk read', async () => {
    const down: CatalogDeps = {
      listSessionsCatalog: async () => {
        throw new Error('ECONNREFUSED');
      },
      ...noPreview,
    };
    const page = await readCatalogPage(down, {
      members: fresh('/a', '/b'),
      options: { size: 5 },
      includeGroups: false,
    });
    expect(page.workspaces.map((w) => w.error?.code)).toEqual([
      'daemon_unavailable',
      'daemon_unavailable',
    ]);
    expect(page.nextCursor).toBeDefined();
    const old = Object.assign(new Error('404'), {
      name: 'DaemonHttpError',
      status: 404,
      body: undefined,
    });
    expect(catalogCallFailure(old)).toMatchObject({
      code: 'session_catalog_unsupported',
    });
    const unsupported = await readCatalogPage(
      {
        listSessionsCatalog: async () => {
          throw old;
        },
        ...noPreview,
      },
      { members: fresh('/a'), options: { size: 5 }, includeGroups: false },
    );
    expect(unsupported.workspaces[0]).toMatchObject({
      source: 'disk',
      done: true,
    });
    expect(unsupported.workspaces[0].error).toBeUndefined();
  });
});
