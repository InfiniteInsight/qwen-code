/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonSessionCatalogRequest,
  DaemonSessionCatalogResult,
  DaemonSessionGroup,
  DaemonSessionGroupCatalog,
  DaemonSessionSummary,
} from '@qwen-code/sdk';
import { asDaemonHttpError, daemonErrorBody } from '../daemonHttpError.js';
import { archiveChatsDirOf, resolveChatsDir } from './chatsPath.js';
import {
  listSessionsAcross,
  readFirstUserMessage,
  type SessionListItem,
} from './sessionList.js';

/**
 * The session catalog across every workspace the gateway lists (#132).
 *
 * The daemon's own `POST /sessions/catalog` answers for the workspaces in
 * ITS registry, and the gateway runs one daemon per workspace, so one
 * daemon's catalog is one workspace's page. This module is the union: it
 * asks every member, merges their pages into one order, and hands back one
 * opaque cursor that continues every member at once.
 *
 * WHERE EACH MEMBER IS READ FROM
 *
 * A member with a daemon the pool already holds is read through that
 * daemon's catalog (`listSessionsCatalog`, which never spawns). A member with
 * none is read from the same disk scan `GET /rc/sessions` does. Every row and
 * every member says which (`source`), because a disk row has no groups, pins
 * or live fields and a reader should be able to tell why.
 *
 * THE ORDER
 *
 * The daemon's own key, so the merge agrees with every member's pages:
 * pinned first (only in the organized view, the only one whose rows carry
 * pins), then activity descending (`Date.parse(updatedAt ?? createdAt)`,
 * as the daemon's `getSummaryActivityTime` reads it), then session id
 * ascending by `localeCompare`, as the daemon breaks ties.
 *
 * THE CURSOR
 *
 * Each member keeps its own boundary, the key of the last row emitted while
 * it took part, and the daemon cursor of the first of its fetched pages that
 * still holds a row not yet emitted. A member's cursor only moves past rows
 * that were emitted, so a partly used page is read again and its emitted rows
 * fall to the boundary filter: nothing is listed twice and nothing is
 * skipped. A row is never emitted past the frontier, the earliest
 * last-fetched key among members that have more, because one of those
 * members may hold a row that sorts before it.
 *
 * A member that fails keeps its state, so the next page retries it from
 * where it stopped. Its rows newer than rows already shown then arrive late,
 * which is why a client places rows by key rather than appending them. A
 * refusal that will not change on retry (a 4xx) marks it failed for the rest
 * of the pass, and its error is repeated on every later page, so no workspace
 * ever drops out of the answer without saying so.
 */

/** Members per request: the daemon's own batch cap. */
export const CATALOG_MAX_MEMBERS = 20;
/** Merged page size bounds: the daemon's own page size bounds. */
export const CATALOG_MAX_SIZE = 100;
export const CATALOG_DEFAULT_SIZE = 20;
/** Follow-up reads one request may make when the frontier stops it short. */
export const CATALOG_MAX_EXTRA_READS = 3;
/** Pages read to find a member's boundary again after its cursor expired. */
export const CATALOG_MAX_RESEEK_PAGES = 5;
/** A cursor longer than this is refused before it is decoded. */
export const CATALOG_MAX_CURSOR_CHARS = 512 * 1024;

/**
 * Member answers that mean "no daemon answers for this workspace", so the
 * member is read from disk instead: the pool holds no daemon for it, a bare
 * client's daemon does not have it registered, or the daemon predates the
 * catalog route.
 */
const DISK_FALLBACK_CODES = new Set([
  'workspace_not_pooled',
  'workspace_not_found',
  'session_catalog_unsupported',
]);

export interface CatalogError {
  code: string;
  message: string;
  status: number;
}

export interface CatalogOptions {
  size: number;
  archiveState?: 'active' | 'archived';
  view?: 'organized';
  group?: string;
}

/** [pinned, activity ms, session id]. */
export type CatalogKey = [0 | 1, number, string];

export type CatalogSource = 'daemon' | 'disk';

/** One member's place in a pagination pass, as the cursor carries it. */
export interface CatalogMemberState {
  workspace: string;
  source: CatalogSource;
  /** The daemon cursor to read from; absent means its first page. */
  cursor?: string;
  /** Rows at or before this key were emitted; absent means none yet. */
  boundary?: CatalogKey;
  done?: true;
  /** A refusal that ends this member's pass, repeated on every page. */
  failed?: CatalogError;
}

export interface CatalogCursorState {
  options: CatalogOptions;
  members: CatalogMemberState[];
}

/** A row as the catalog answers it: the daemon's summary, or a disk row
 * mapped onto the same names, plus where it came from. */
export type CatalogRow = Partial<DaemonSessionSummary> & {
  sessionId: string;
  /** The member it was read for, exactly as the caller named it. */
  workspace: string;
  source: CatalogSource;
  /** First user message, joined from the transcript (#132). */
  preview?: string;
};

export interface CatalogMemberStatus {
  workspace: string;
  workspaceId?: string;
  cwd?: string;
  source: CatalogSource;
  /** Rows this page took from the member. */
  count: number;
  /** True when the member has nothing more for this pass. */
  done: boolean;
  truncated?: true;
  liveMergeFailed?: true;
  error?: CatalogError;
}

export interface CatalogPage {
  v: 1;
  sessions: CatalogRow[];
  workspaces: CatalogMemberStatus[];
  groups?: DaemonSessionGroupCatalog;
  nextCursor?: string;
}

export interface CatalogDeps {
  /** The pool, or a bare client: one page or one error per selection. */
  listSessionsCatalog(
    request: DaemonSessionCatalogRequest,
  ): Promise<DaemonSessionCatalogResult>;
  /** One workspace's disk listing. Defaults to the `/rc/sessions` scan. */
  scanDisk?(
    workspace: string,
    archived: boolean,
  ): Promise<{ sessions: SessionListItem[]; truncated: boolean }>;
  /** One transcript's first user message. Defaults to the scan's reader. */
  readPreview?(
    workspace: string,
    sessionId: string,
    archived: boolean,
  ): Promise<string | null>;
}

export class CatalogCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogCursorError';
  }
}

// ---- the key -------------------------------------------------------------

function activityOf(updatedAt?: string, createdAt?: string): number {
  const t = Date.parse((updatedAt ?? createdAt) as string);
  return Number.isFinite(t) ? t : 0;
}

export function keyOf(row: CatalogRow, organized: boolean): CatalogKey {
  return [
    organized && row.isPinned === true ? 1 : 0,
    activityOf(row.updatedAt, row.createdAt),
    row.sessionId,
  ];
}

/** Negative when `a` sorts first. */
export function compareKeys(a: CatalogKey, b: CatalogKey): number {
  if (a[0] !== b[0]) return b[0] - a[0];
  if (a[1] !== b[1]) return b[1] - a[1];
  const byLocale = a[2].localeCompare(b[2]);
  if (byLocale !== 0) return byLocale;
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

function after(key: CatalogKey, boundary: CatalogKey | undefined): boolean {
  return boundary === undefined || compareKeys(key, boundary) > 0;
}

// ---- errors ----------------------------------------------------------------

/**
 * A failed daemon call, as one member's error. A bare 404 is a daemon with no
 * catalog route; an envelope relays as itself; anything else is the daemon
 * being unreachable.
 */
export function catalogCallFailure(err: unknown): CatalogError {
  const http = asDaemonHttpError(err);
  if (http) {
    const body = daemonErrorBody(err);
    const code =
      typeof body?.['code'] === 'string'
        ? (body['code'] as string)
        : typeof body?.['errorKind'] === 'string'
          ? (body['errorKind'] as string)
          : undefined;
    const message =
      typeof body?.['error'] === 'string'
        ? (body['error'] as string)
        : 'The daemon refused the catalog read.';
    if (http.status === 404 && code === undefined) {
      return {
        code: 'session_catalog_unsupported',
        message: 'The daemon has no session catalog route.',
        status: 404,
      };
    }
    return { code: code ?? 'daemon_rejected', message, status: http.status };
  }
  return {
    code: 'daemon_unavailable',
    message: 'The daemon could not be reached.',
    status: 502,
  };
}

/** A refusal a retry will not change: any 4xx but a timeout or a rate limit.
 * An expired cursor is not one; it is sought again. */
function isPermanent(e: CatalogError): boolean {
  return (
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 408 &&
    e.status !== 429 &&
    e.code !== 'invalid_cursor' &&
    e.code !== 'cursor_expired'
  );
}

// ---- the cursor ------------------------------------------------------------

export function encodeCatalogCursor(state: CatalogCursorState): string {
  return Buffer.from(
    JSON.stringify({ v: 1, options: state.options, members: state.members }),
    'utf8',
  ).toString('base64url');
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(o).every((k) => keys.includes(k));
}

/** Checks a caller's (or a cursor's) options; returns a reason or the
 * options. Shared with the route so the two cannot disagree. */
export function parseCatalogOptions(
  raw: unknown,
): CatalogOptions | { error: string } {
  if (raw === undefined) return { size: CATALOG_DEFAULT_SIZE };
  if (
    !isObj(raw) ||
    !onlyKeys(raw, ['size', 'archiveState', 'view', 'group'])
  ) {
    return {
      error: 'options may hold only size, archiveState, view and group',
    };
  }
  const out: CatalogOptions = { size: CATALOG_DEFAULT_SIZE };
  if (raw['size'] !== undefined) {
    const s = raw['size'];
    if (
      typeof s !== 'number' ||
      !Number.isInteger(s) ||
      s < 1 ||
      s > CATALOG_MAX_SIZE
    ) {
      return { error: `size must be an integer from 1 to ${CATALOG_MAX_SIZE}` };
    }
    out.size = s;
  }
  if (raw['archiveState'] !== undefined) {
    if (
      raw['archiveState'] !== 'active' &&
      raw['archiveState'] !== 'archived'
    ) {
      return { error: "archiveState must be 'active' or 'archived'" };
    }
    out.archiveState = raw['archiveState'];
  }
  if (raw['view'] !== undefined) {
    if (raw['view'] !== 'organized')
      return { error: "view must be 'organized'" };
    out.view = 'organized';
  }
  if (raw['group'] !== undefined) {
    const g = raw['group'];
    if (typeof g !== 'string' || g.length === 0 || g.length > 256) {
      return { error: 'group must be a non-empty string' };
    }
    // The daemon's own rule (session-catalog.ts): a group filter needs the
    // organized view, the only one whose rows carry a group.
    if (out.view !== 'organized') {
      return { error: "a group filter requires view 'organized'" };
    }
    out.group = g;
  }
  return out;
}

function parseKey(v: unknown): CatalogKey | undefined {
  if (
    Array.isArray(v) &&
    v.length === 3 &&
    (v[0] === 0 || v[0] === 1) &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[1]) &&
    typeof v[2] === 'string' &&
    v[2].length > 0 &&
    v[2].length <= 256
  ) {
    return [v[0], v[1], v[2]];
  }
  return undefined;
}

function parseError(v: unknown): CatalogError | undefined {
  if (
    isObj(v) &&
    typeof v['code'] === 'string' &&
    typeof v['message'] === 'string' &&
    typeof v['status'] === 'number' &&
    Number.isInteger(v['status'])
  ) {
    return { code: v['code'], message: v['message'], status: v['status'] };
  }
  return undefined;
}

/** Decodes and checks a merged cursor; throws {@link CatalogCursorError}. */
export function decodeCatalogCursor(token: string): CatalogCursorState {
  const bad = (why: string): never => {
    throw new CatalogCursorError(`Invalid catalog cursor: ${why}`);
  };
  if (token.length === 0 || token.length > CATALOG_MAX_CURSOR_CHARS) {
    bad('wrong length');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    bad('not a cursor this gateway issued');
  }
  if (!isObj(parsed) || parsed['v'] !== 1) bad('unknown version');
  const p = parsed as Record<string, unknown>;
  const options = parseCatalogOptions(p['options']);
  if ('error' in options) bad(options.error);
  const rawMembers = p['members'];
  if (
    !Array.isArray(rawMembers) ||
    rawMembers.length < 1 ||
    rawMembers.length > CATALOG_MAX_MEMBERS
  ) {
    bad('wrong member count');
  }
  const members: CatalogMemberState[] = [];
  for (const m of rawMembers as unknown[]) {
    if (
      !isObj(m) ||
      !onlyKeys(m, [
        'workspace',
        'source',
        'cursor',
        'boundary',
        'done',
        'failed',
      ]) ||
      typeof m['workspace'] !== 'string' ||
      m['workspace'].length === 0 ||
      m['workspace'].length > 4096 ||
      (m['source'] !== 'daemon' && m['source'] !== 'disk')
    ) {
      bad('malformed member');
    }
    const mm = m as Record<string, unknown>;
    const state: CatalogMemberState = {
      workspace: mm['workspace'] as string,
      source: mm['source'] as CatalogSource,
    };
    if (mm['cursor'] !== undefined) {
      if (typeof mm['cursor'] !== 'string' || mm['cursor'].length > 16384) {
        bad('malformed member cursor');
      }
      state.cursor = mm['cursor'] as string;
    }
    if (mm['boundary'] !== undefined) {
      const k = parseKey(mm['boundary']);
      if (!k) bad('malformed member boundary');
      state.boundary = k;
    }
    if (mm['done'] !== undefined) {
      if (mm['done'] !== true) bad('malformed member');
      state.done = true;
    }
    if (mm['failed'] !== undefined) {
      const e = parseError(mm['failed']);
      if (!e) bad('malformed member error');
      state.failed = e;
    }
    members.push(state);
  }
  return { options: options as CatalogOptions, members };
}

// ---- the read ----------------------------------------------------------------

interface Fetched {
  cursorUsed?: string;
  rows: CatalogRow[];
  keys: CatalogKey[];
  nextCursor?: string;
}

interface Work {
  index: number;
  state: CatalogMemberState;
  source: CatalogSource;
  pages: Fetched[];
  /** False once a read failed: the member then stops limiting the frontier. */
  canExtend: boolean;
  error?: CatalogError;
  workspaceId?: string;
  cwd?: string;
  truncated?: boolean;
  liveMergeFailed?: boolean;
  groups?: DaemonSessionGroupCatalog;
  /** The furthest page an expired-cursor seek reached, kept for the next. */
  seekCursor?: string;
}

function isPage(
  m: DaemonSessionCatalogResult['workspaces'][number] | undefined,
): m is Extract<
  DaemonSessionCatalogResult['workspaces'][number],
  { sessions: unknown }
> {
  return !!m && Array.isArray((m as { sessions?: unknown }).sessions);
}

function defaultScanDisk(
  workspace: string,
  archived: boolean,
): Promise<{ sessions: SessionListItem[]; truncated: boolean }> {
  const chats = resolveChatsDir(workspace);
  const dir = archived ? archiveChatsDirOf(chats) : chats;
  return listSessionsAcross([dir], archived ? { archivedDirs: [dir] } : {});
}

async function defaultReadPreview(
  workspace: string,
  sessionId: string,
  archived: boolean,
): Promise<string | null> {
  const chats = resolveChatsDir(workspace);
  return readFirstUserMessage(
    archived ? archiveChatsDirOf(chats) : chats,
    sessionId,
  );
}

function diskRow(item: SessionListItem, workspace: string): CatalogRow {
  return {
    sessionId: item.sessionId,
    workspaceCwd: workspace,
    updatedAt: item.updatedAt,
    ...(item.title ? { displayName: item.title } : {}),
    ...(item.title && item.titleSource
      ? { titleSource: item.titleSource }
      : {}),
    ...(item.preview ? { preview: item.preview } : {}),
    ...(item.archived ? { isArchived: true } : {}),
    workspace,
    source: 'disk',
  };
}

/** Group catalogs merged by id; on a clash the later `updatedAt` wins. */
export function mergeGroupCatalogs(
  catalogs: DaemonSessionGroupCatalog[],
): DaemonSessionGroupCatalog {
  const byId = new Map<string, DaemonSessionGroup>();
  const colors: DaemonSessionGroupCatalog['colorOptions'] = [];
  for (const c of catalogs) {
    for (const g of Array.isArray(c.groups) ? c.groups : []) {
      if (!g || typeof g.id !== 'string') continue;
      const held = byId.get(g.id);
      if (!held || String(g.updatedAt) > String(held.updatedAt))
        byId.set(g.id, g);
    }
    for (const col of Array.isArray(c.colorOptions) ? c.colorOptions : []) {
      if (!colors.includes(col)) colors.push(col);
    }
  }
  return { groups: [...byId.values()], colorOptions: colors };
}

/**
 * Reads one merged page for `members`, from the state a cursor carried (or a
 * fresh state for the first page).
 */
export async function readCatalogPage(
  deps: CatalogDeps,
  input: {
    members: CatalogMemberState[];
    options: CatalogOptions;
    includeGroups: boolean;
  },
): Promise<CatalogPage> {
  const { options, includeGroups } = input;
  const organized = options.view === 'organized';
  const archived = options.archiveState === 'archived';
  const scanDisk = deps.scanDisk ?? defaultScanDisk;
  const readPreview = deps.readPreview ?? defaultReadPreview;
  const daemonOptions = {
    pageSize: options.size,
    ...(options.archiveState ? { archiveState: options.archiveState } : {}),
    ...(options.view ? { view: options.view } : {}),
    ...(options.group ? { group: options.group } : {}),
  };

  const works: Work[] = input.members.map((state, index) => ({
    index,
    state,
    source: state.source,
    pages: [],
    canExtend: true,
  }));
  const active = works.filter((w) => !w.state.done && !w.state.failed);

  /** One daemon read for several members; a whole-call failure becomes
   * each member's error. */
  const ask = async (
    selections: Array<{ workspace: string; cursor?: string }>,
  ): Promise<DaemonSessionCatalogResult['workspaces']> => {
    try {
      const r = await deps.listSessionsCatalog({
        workspaces: selections.map((s) =>
          s.cursor !== undefined
            ? { workspace: s.workspace, cursor: s.cursor }
            : { workspace: s.workspace },
        ),
        options: daemonOptions,
        ...(includeGroups ? { includeGroups: true } : {}),
      });
      return selections.map(
        (s, i) =>
          r.workspaces?.[i] ?? {
            workspace: s.workspace,
            error: {
              code: 'session_catalog_failed',
              message: 'The daemon answered without this workspace.',
              status: 502,
            },
          },
      );
    } catch (err) {
      const e = catalogCallFailure(err);
      return selections.map((s) => ({ workspace: s.workspace, error: e }));
    }
  };

  const takePage = (
    w: Work,
    page: Extract<
      DaemonSessionCatalogResult['workspaces'][number],
      { sessions: unknown }
    >,
    cursorUsed: string | undefined,
  ) => {
    const rows = page.sessions
      .filter((s) => s && typeof s.sessionId === 'string')
      .map(
        (s): CatalogRow => ({
          ...s,
          workspace: w.state.workspace,
          source: 'daemon',
        }),
      );
    w.pages.push({
      cursorUsed,
      rows,
      keys: rows.map((r) => keyOf(r, organized)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
    if (page.workspaceId) w.workspaceId = page.workspaceId;
    if (page.cwd) w.cwd = page.cwd;
    if (page.truncated) w.truncated = true;
    if (page.liveMergeFailed) w.liveMergeFailed = true;
    if (page.groups) w.groups = page.groups;
  };

  // 1. Every daemon member, in one batch.
  const daemonWorks = active.filter((w) => w.source === 'daemon');
  const reseek: Work[] = [];
  if (daemonWorks.length > 0) {
    const answers = await ask(
      daemonWorks.map((w) => ({
        workspace: w.state.workspace,
        cursor: w.state.cursor,
      })),
    );
    daemonWorks.forEach((w, i) => {
      const a = answers[i];
      if (isPage(a)) return takePage(w, a, w.state.cursor);
      const e = (a as { error: CatalogError }).error;
      if (DISK_FALLBACK_CODES.has(e.code)) {
        w.source = 'disk';
      } else if (e.code === 'invalid_cursor' && w.state.cursor !== undefined) {
        reseek.push(w);
      } else {
        w.error = e;
        w.canExtend = false;
      }
    });
  }

  // 2. Expired cursors: from the first page again, skipping what was shown.
  await Promise.all(
    reseek.map(async (w) => {
      let cursor: string | undefined = undefined;
      for (let i = 0; i < CATALOG_MAX_RESEEK_PAGES; i++) {
        const [a] = await ask([{ workspace: w.state.workspace, cursor }]);
        if (!isPage(a)) {
          w.error = (a as { error: CatalogError }).error;
          w.canExtend = false;
          return;
        }
        const before = w.pages.length;
        takePage(w, a, cursor);
        const got = w.pages[before];
        const fresh = got.keys.some((k) => after(k, w.state.boundary));
        if (fresh || !got.nextCursor) {
          // Keep only this page: the ones before it hold nothing unshown.
          w.pages = [got];
          return;
        }
        cursor = got.nextCursor;
      }
      w.pages = [];
      w.seekCursor = cursor;
      w.error = {
        code: 'cursor_expired',
        message: `This workspace's place in the list expired and was not found again within ${CATALOG_MAX_RESEEK_PAGES} pages; load more to keep looking.`,
        status: 410,
      };
      w.canExtend = false;
    }),
  );

  // 3. Disk members, and daemon members that turned out to have no daemon.
  await Promise.all(
    active
      .filter((w) => w.source === 'disk' && !w.error)
      .map(async (w) => {
        if (options.group !== undefined && options.group !== 'all') {
          w.error = {
            code: 'group_filter_unavailable',
            message:
              'No daemon is running for this workspace, so its groups cannot be read.',
            status: 409,
          };
          w.canExtend = false;
          return;
        }
        try {
          const scan = await scanDisk(w.state.workspace, archived);
          const rows = scan.sessions.map((s) => diskRow(s, w.state.workspace));
          const keyed = rows
            .map((r) => ({ r, k: keyOf(r, organized) }))
            .sort((a, b) => compareKeys(a.k, b.k));
          w.pages.push({
            rows: keyed.map((x) => x.r),
            keys: keyed.map((x) => x.k),
          });
          if (scan.truncated) w.truncated = true;
        } catch {
          w.error = {
            code: 'disk_scan_failed',
            message:
              "This workspace's conversations could not be read from disk.",
            status: 500,
          };
          w.canExtend = false;
        }
      }),
  );

  // 4. Merge, reading further behind the frontier when it stops us short.
  const hasMore = (w: Work) =>
    w.canExtend &&
    w.pages.length > 0 &&
    !!w.pages[w.pages.length - 1].nextCursor;
  const lastKey = (w: Work): CatalogKey | undefined => {
    for (let p = w.pages.length - 1; p >= 0; p--) {
      const keys = w.pages[p].keys;
      if (keys.length > 0) return keys[keys.length - 1];
    }
    return undefined;
  };
  let emitted: Array<{ row: CatalogRow; key: CatalogKey; w: Work }> = [];
  for (let extra = 0; ; extra++) {
    const candidates: Array<{ row: CatalogRow; key: CatalogKey; w: Work }> = [];
    for (const w of works) {
      for (const page of w.pages) {
        page.rows.forEach((row, i) => {
          if (after(page.keys[i], w.state.boundary)) {
            candidates.push({ row, key: page.keys[i], w });
          }
        });
      }
    }
    candidates.sort(
      (a, b) => compareKeys(a.key, b.key) || a.w.index - b.w.index,
    );
    // The frontier: the earliest window end among members with more. A
    // member with more and no rows read yet blocks everything until read,
    // since its next page could hold anything.
    let frontier: CatalogKey | undefined;
    let limiter = works.find((w) => hasMore(w) && lastKey(w) === undefined);
    const blocked = limiter !== undefined;
    if (!blocked) {
      for (const w of works) {
        const k = hasMore(w) ? lastKey(w) : undefined;
        if (k && (!frontier || compareKeys(k, frontier) < 0)) {
          frontier = k;
          limiter = w;
        }
      }
    }
    emitted = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      if (emitted.length >= options.size || blocked) break;
      if (frontier && compareKeys(c.key, frontier) > 0) break;
      if (seen.has(c.row.sessionId)) continue; // one id, two members: once
      seen.add(c.row.sessionId);
      emitted.push(c);
    }
    if (emitted.length >= options.size || !limiter) break;
    if (extra >= CATALOG_MAX_EXTRA_READS) break;
    const last = limiter.pages[limiter.pages.length - 1];
    const [a] = await ask([
      { workspace: limiter.state.workspace, cursor: last.nextCursor },
    ]);
    if (isPage(a)) {
      takePage(limiter, a, last.nextCursor);
    } else {
      limiter.error = (a as { error: CatalogError }).error;
      limiter.canExtend = false;
    }
  }

  // 5. Each member's next state.
  const lastEmitted =
    emitted.length > 0 ? emitted[emitted.length - 1].key : undefined;
  const nextMembers: CatalogMemberState[] = works.map((w) => {
    const base = { workspace: w.state.workspace, source: w.source };
    if (w.state.failed) return w.state;
    if (w.state.done) return { ...w.state, source: w.source };
    if (w.error && isPermanent(w.error)) {
      return {
        ...base,
        ...(w.state.boundary ? { boundary: w.state.boundary } : {}),
        failed: w.error,
      };
    }
    if (w.pages.length === 0) {
      // Nothing read: the member stays where it was, or, after a seek that
      // ran out of pages, where the seek got to.
      const cursor = w.seekCursor ?? w.state.cursor;
      return {
        ...base,
        ...(cursor !== undefined && w.source === 'daemon' ? { cursor } : {}),
        ...(w.state.boundary ? { boundary: w.state.boundary } : {}),
      };
    }
    // The new boundary is the last emitted key, but never past the end of
    // what this member read: rows beyond it were never candidates.
    let boundary = w.state.boundary;
    if (lastEmitted) {
      const end = lastKey(w);
      const windowOpen = w.pages[w.pages.length - 1].nextCursor !== undefined;
      boundary =
        windowOpen && end && compareKeys(end, lastEmitted) < 0
          ? end
          : lastEmitted;
      if (w.state.boundary && compareKeys(boundary, w.state.boundary) < 0) {
        boundary = w.state.boundary;
      }
    }
    const firstOpen = w.pages.find((p) =>
      p.keys.some((k) => after(k, boundary)),
    );
    if (firstOpen) {
      return {
        ...base,
        ...(firstOpen.cursorUsed !== undefined
          ? { cursor: firstOpen.cursorUsed }
          : {}),
        ...(boundary ? { boundary } : {}),
      };
    }
    const tail = w.pages[w.pages.length - 1].nextCursor;
    if (tail !== undefined) {
      return { ...base, cursor: tail, ...(boundary ? { boundary } : {}) };
    }
    return { ...base, ...(boundary ? { boundary } : {}), done: true };
  });

  // 6. Previews for the daemon rows on the page.
  const sessions = await Promise.all(
    emitted.map(async ({ row }) => {
      if (row.source !== 'daemon' || row.preview) return row;
      const preview = await readPreview(
        row.workspace,
        row.sessionId,
        archived,
      ).catch(() => null);
      return preview ? { ...row, preview } : row;
    }),
  );

  const counts = new Map<number, number>();
  for (const e of emitted)
    counts.set(e.w.index, (counts.get(e.w.index) ?? 0) + 1);
  const workspaces: CatalogMemberStatus[] = works.map((w, i) => {
    const next = nextMembers[i];
    const error = w.error ?? w.state.failed;
    return {
      workspace: w.state.workspace,
      ...(w.workspaceId ? { workspaceId: w.workspaceId } : {}),
      ...(w.cwd ? { cwd: w.cwd } : {}),
      source: w.source,
      count: counts.get(w.index) ?? 0,
      done: next.done === true || next.failed !== undefined,
      ...(w.truncated ? { truncated: true as const } : {}),
      ...(w.liveMergeFailed ? { liveMergeFailed: true as const } : {}),
      ...(error ? { error } : {}),
    };
  });

  const unfinished = nextMembers.some((m) => !m.done && !m.failed);
  const groupCatalogs = works
    .map((w) => w.groups)
    .filter((g): g is DaemonSessionGroupCatalog => !!g);
  return {
    v: 1,
    sessions,
    workspaces,
    ...(includeGroups ? { groups: mergeGroupCatalogs(groupCatalogs) } : {}),
    ...(unfinished
      ? { nextCursor: encodeCatalogCursor({ options, members: nextMembers }) }
      : {}),
  };
}
