/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ForkRecord } from './forkTranscript.js';
import { isValidSessionId } from './chatsPath.js';
import { parentOf } from './lineage.js';

/** One node in a flat workspace session listing. */
export interface SessionListItem {
  sessionId: string;
  /** The fork parent, when this session is a fork. Omitted for a root. */
  parentSessionId?: string;
  /** Human title (core `custom_title`), when set. Omitted otherwise. */
  title?: string;
  /** How the title was set: 'manual' | 'auto'. Omitted when there is no title. */
  titleSource?: 'manual' | 'auto';
  /** Child session ids PRESENT in this listing that forked from this one. */
  forks: string[];
  /** Last modified time (mtime) of the transcript file, ISO-8601. */
  updatedAt: string;
  /** First user message preview (truncated to ~120 chars). Omitted when unreadable. */
  preview?: string;
  /**
   * True when this transcript sits in the archive dir. Omitted for an active
   * conversation, so the common payload is unchanged. An archived row is NOT
   * openable: the daemon refuses a transcript read on an archived session with
   * `SessionArchivedError` (cli/src/serve/routes/session.ts:6535), so the only
   * honest action on such a row is restore.
   */
  archived?: true;
}

/** A whole `/rc/sessions` listing plus a partial-scan flag. */
export interface SessionListResult {
  sessions: SessionListItem[];
  /** True when the on-disk session count exceeded {@link MAX_LIST_SESSIONS}. */
  truncated: boolean;
}

/**
 * Hard cap on how many transcripts a single listing scan opens. Bounds an
 * OWNER endpoint a UI may poll: a workspace can accumulate arbitrarily many
 * dormant transcripts, and we open + first-line-read each one. The cap keeps
 * the MOST RECENTLY MODIFIED transcripts (ties broken by id), so it is stable
 * across calls and the newest session is never the one dropped.
 */
export const MAX_LIST_SESSIONS = 500;

/** Default cap on bytes read while looking for a transcript's first newline. */
const DEFAULT_MAX_FIRST_LINE_BYTES = 1024 * 1024;

/**
 * Reads ONLY the first JSONL record of `<chatsDir>/<id>.jsonl` — the
 * `forkedFrom` source a listing needs — without pulling the whole (possibly
 * multi-MB) transcript into memory.
 *
 * Accumulates raw BYTES up to the first `\n` (or EOF, or `maxBytes`), then
 * decodes the range ONCE via `Buffer.concat` -> `toString('utf8')`, so a
 * multibyte char split across two `read()`s is never corrupted. Returns `null`
 * when the file is missing (ENOENT), empty, or the first line does not parse to
 * a JSON object (including a first line longer than `maxBytes`, which yields a
 * truncated prefix that fails `JSON.parse` -> `null` rather than a partial
 * record). Any non-ENOENT open/read error propagates to the caller.
 */
export async function readFirstRecord(
  chatsDir: string,
  id: string,
  opts: { maxBytes?: number; chunkSize?: number } = {},
): Promise<ForkRecord | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FIRST_LINE_BYTES;
  // Per-read buffer size. Injectable ONLY so a test can force a tiny window
  // and exercise the cross-read decode path (a multibyte char straddling two
  // reads); production always uses the 64 KiB default.
  const chunkSize = opts.chunkSize ?? 64 * 1024;
  let handle;
  try {
    handle = await open(join(chatsDir, `${id}.jsonl`), 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.allocUnsafe(chunkSize);
    while (total < maxBytes) {
      const { bytesRead } = await handle.read(
        buf,
        0,
        Math.min(buf.length, maxBytes - total),
        null,
      );
      if (bytesRead === 0) break; // EOF before any newline
      const slice = buf.subarray(0, bytesRead);
      const nl = slice.indexOf(0x0a);
      if (nl !== -1) {
        // Copy the pre-newline bytes (the shared `buf` is reused next read).
        chunks.push(Buffer.from(slice.subarray(0, nl)));
        break;
      }
      chunks.push(Buffer.from(slice));
      total += bytesRead;
    }
    const line = Buffer.concat(chunks).toString('utf8').trim();
    if (!line) return null;
    try {
      const obj = JSON.parse(line) as unknown;
      return obj && typeof obj === 'object' ? (obj as ForkRecord) : null;
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Reads a session's human title (core's `custom_title` system record) by a
 * BOUNDED TAIL scan — the mirror of {@link readFirstRecord} from EOF. `stat`s
 * the size, reads the last `min(size, maxBytes)` bytes at an explicit offset,
 * decodes once, drops a possibly-partial leading line when the window did not
 * start at byte 0, then scans BACKWARDS for the most recent line whose parsed
 * record has `subtype === 'custom_title'`, returning its non-empty
 * `systemPayload.customTitle` or `null`.
 *
 * 64 KiB matches core's anchor strategy (the title is re-appended near EOF every
 * ~32 KiB and on finalize), so the tail catches it for any non-trivial session;
 * a short session (`size <= maxBytes`) is read in full from offset 0. The only
 * miss is a > maxBytes session whose title was written ONLY at the very start and
 * never re-anchored → `null` (graceful, never a wrong title).
 *
 * Title reading is ENRICHMENT, so this NEVER throws: ENOENT / any open / read /
 * parse error yields `null`, and the handle is always closed.
 */
export async function readSessionTitle(
  chatsDir: string,
  id: string,
  opts: { maxBytes?: number } = {},
): Promise<string | null> {
  return (await readSessionTitleInfo(chatsDir, id, opts))?.title ?? null;
}

/** A session's human title plus how it was set: 'manual' (a /rename or /branch)
 * or 'auto' (auto-generated). Mirrors core's `systemPayload.titleSource`. */
export interface SessionTitleInfo {
  title: string;
  titleSource: 'manual' | 'auto';
}

/**
 * The richer companion to {@link readSessionTitle}: returns the most-recent
 * `custom_title` record's title AND its `titleSource` ('manual'|'auto';
 * defaulting to 'manual' when the field is absent/unrecognized, matching a
 * hand-written rename). Same bounded EOF tail-scan, same never-throws contract.
 */
export async function readSessionTitleInfo(
  chatsDir: string,
  id: string,
  opts: { maxBytes?: number } = {},
): Promise<SessionTitleInfo | null> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  let handle;
  try {
    handle = await open(join(chatsDir, `${id}.jsonl`), 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    const readBytes = Math.min(size, maxBytes);
    const start = size - readBytes;
    const buf = Buffer.allocUnsafe(readBytes);
    let off = 0;
    while (off < readBytes) {
      const { bytesRead } = await handle.read(
        buf,
        off,
        readBytes - off,
        start + off,
      );
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    const lines = buf.subarray(0, off).toString('utf8').split('\n');
    // When the window did not start at byte 0, its first line may be a partial
    // record — drop it so JSON.parse only ever sees complete lines.
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      // Cheap pre-filter avoids parsing every unrelated record.
      if (!line || line.indexOf('custom_title') === -1) continue;
      try {
        const rec = JSON.parse(line) as {
          subtype?: unknown;
          systemPayload?: { customTitle?: unknown; titleSource?: unknown };
        };
        const title = rec.systemPayload?.customTitle;
        if (
          rec.subtype === 'custom_title' &&
          typeof title === 'string' &&
          title.length > 0
        ) {
          const titleSource =
            rec.systemPayload?.titleSource === 'auto' ? 'auto' : 'manual';
          return { title, titleSource };
        }
      } catch {
        // Non-JSON / partial line → keep scanning earlier lines.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

const PREVIEW_MAX_CHARS = 120;
/** Lines inspected for the first user message (the user turn can sit behind
 * several system/context records). */
const PREVIEW_MAX_LINES = 200;
/** Bytes inspected before giving up; bounds the cost of a listing row. */
const PREVIEW_MAX_BYTES = 1024 * 1024;

/** The preview text of one parsed line, or null when it is not a user message. */
function previewOfLine(line: string): string | null {
  if (!line || line.indexOf('"user"') === -1) return null;
  try {
    const rec = JSON.parse(line) as {
      type?: unknown;
      message?: { parts?: Array<{ text?: unknown }> };
    };
    if (rec.type !== 'user') return null;
    const parts = rec.message?.parts;
    if (!Array.isArray(parts)) return null;
    for (const p of parts) {
      if (typeof p.text === 'string' && p.text.trim().length > 0) {
        const cleaned = p.text.trim().replace(/\s+/g, ' ');
        return cleaned.length > PREVIEW_MAX_CHARS
          ? cleaned.slice(0, PREVIEW_MAX_CHARS) + '…'
          : cleaned;
      }
    }
  } catch {
    // not a complete JSON line: not a candidate
  }
  return null;
}

/**
 * Reads the first user message from a transcript for a list preview.
 * Streams the file in chunks, line by line, looking for a `type === 'user'`
 * record with `message.parts[].text`, and stops at the first one found, at
 * {@link PREVIEW_MAX_LINES} lines or at {@link PREVIEW_MAX_BYTES} bytes. Lines
 * are assembled from raw bytes and decoded once, so a multibyte char split
 * across two reads is never corrupted and a record larger than one chunk is
 * still seen whole. Returns the first ~{@link PREVIEW_MAX_CHARS} chars or
 * `null`. Never throws.
 */
export async function readFirstUserMessage(
  chatsDir: string,
  id: string,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(join(chatsDir, `${id}.jsonl`), 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let pending: Buffer[] = [];
    let total = 0;
    let lineNo = 0;
    let eof = false;
    while (!eof && total < PREVIEW_MAX_BYTES && lineNo < PREVIEW_MAX_LINES) {
      const { bytesRead } = await handle.read(
        buf,
        0,
        Math.min(buf.length, PREVIEW_MAX_BYTES - total),
        null,
      );
      if (bytesRead === 0) {
        eof = true;
      } else {
        total += bytesRead;
      }
      let start = 0;
      const slice = buf.subarray(0, bytesRead);
      while (start <= slice.length && lineNo < PREVIEW_MAX_LINES) {
        const nl = slice.indexOf(0x0a, start);
        if (nl === -1) {
          if (start < slice.length)
            pending.push(Buffer.from(slice.subarray(start)));
          break;
        }
        pending.push(Buffer.from(slice.subarray(start, nl)));
        const line = Buffer.concat(pending).toString('utf8').trim();
        pending = [];
        lineNo++;
        const hit = previewOfLine(line);
        if (hit !== null) return hit;
        start = nl + 1;
      }
    }
    if (eof && pending.length > 0 && lineNo < PREVIEW_MAX_LINES) {
      // Final line without a trailing newline.
      return previewOfLine(Buffer.concat(pending).toString('utf8').trim());
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** A session id paired with its resolved fork parent (null = root). */
export interface SessionEntry {
  sessionId: string;
  parentSessionId: string | null;
  /** Human title (core `custom_title`), when set. */
  title?: string;
  /** How the title was set: 'manual' | 'auto'. */
  titleSource?: 'manual' | 'auto';
  /** Last modified time (mtime) of the transcript file, ISO-8601. */
  updatedAt: string;
  /** First user message preview. */
  preview?: string;
  /** True when read out of the archive dir. See SessionListItem.archived. */
  archived?: boolean;
}

/**
 * Pure: turn flat `{sessionId, parentSessionId}` entries into the listing —
 * nodes + the reverse `forks[]` index + a deterministic order. No disk.
 *
 * A child whose parent is NOT among the entries (orphan / deleted / beyond the
 * scan cap) still lists with its `parentSessionId`, but the missing parent is
 * never fabricated as a node and the child appears in no `forks[]`
 * (truncate-don't-fabricate, mirroring lineage). A self-referential
 * `forkedFrom` (`parentSessionId === sessionId`, only possible via a
 * hand-edited transcript) is treated as a root and never indexed.
 */
export function assembleListing(entries: SessionEntry[]): SessionListItem[] {
  const items = new Map<string, SessionListItem>();
  for (const e of entries) {
    if (items.has(e.sessionId)) continue;
    const isRoot =
      e.parentSessionId === null || e.parentSessionId === e.sessionId;
    items.set(e.sessionId, {
      sessionId: e.sessionId,
      ...(isRoot ? {} : { parentSessionId: e.parentSessionId as string }),
      ...(e.title ? { title: e.title } : {}),
      ...(e.title && e.titleSource ? { titleSource: e.titleSource } : {}),
      forks: [],
      updatedAt: e.updatedAt,
      ...(e.preview ? { preview: e.preview } : {}),
      ...(e.archived ? { archived: true } : {}),
    });
  }
  for (const e of entries) {
    if (e.parentSessionId === null || e.parentSessionId === e.sessionId) {
      continue;
    }
    const parent = items.get(e.parentSessionId);
    if (parent) parent.forks.push(e.sessionId);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const item of items.values()) item.forks.sort(cmp);
  return [...items.values()].sort((a, b) => cmp(a.sessionId, b.sessionId));
}

/**
 * Scan a workspace chats dir into a fork-lineage listing. Mirrors the lineage
 * route's source of truth (each transcript's first-record
 * `forkedFrom.sessionId`), so `/rc/sessions` and `/session/:id/lineage`
 * agree. A missing chats dir (ENOENT) is an empty listing, not an error.
 *
 * Filenames are filtered to syntactically valid `<id>.jsonl` (the same
 * path-traversal guard lineage uses), sorted lexically, then capped at
 * `opts.max` (`truncated` reports the overflow). An unreadable first line lists
 * the session as a root rather than dropping it.
 */
async function scanValidIds(chatsDir: string): Promise<string[] | null> {
  let files: string[];
  try {
    files = await readdir(chatsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return files
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .filter((id) => isValidSessionId(id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Reads one transcript's listing entry. The caller has already stat'd the file
 * (the mtime drives both the cap and the most-recent-first sort, so a
 * fabricated timestamp would corrupt them: a file that cannot be stat'd is
 * omitted before this point). An unreadable first line still lists the session
 * as a root rather than drop it.
 */
async function readEntry(
  chatsDir: string,
  id: string,
  updatedAt: string,
): Promise<SessionEntry> {
  let parent: string | null;
  try {
    const first = await readFirstRecord(chatsDir, id);
    parent = parentOf(first ? [first] : null);
  } catch {
    // Unreadable first line (e.g. EACCES) -> list it as a root, don't drop.
    parent = null;
  }
  const info = await readSessionTitleInfo(chatsDir, id);
  const preview = await readFirstUserMessage(chatsDir, id);
  return {
    sessionId: id,
    parentSessionId: parent,
    ...(info ? { title: info.title, titleSource: info.titleSource } : {}),
    updatedAt,
    ...(preview ? { preview } : {}),
  };
}

/** Assembles and orders a finished listing (most recently active first). */
function finishListing(entries: SessionEntry[]): SessionListItem[] {
  const sessions = assembleListing(entries);
  sessions.sort((a, b) => {
    const aTime = new Date(a.updatedAt).getTime();
    const bTime = new Date(b.updatedAt).getTime();
    return bTime - aTime; // descending
  });
  return sessions;
}

/**
 * Scans SEVERAL chats dirs as one listing.
 *
 * A transcript is stored under the workspace it was RUN in, so listing only one
 * workspace hides every conversation started anywhere else. The caller supplies
 * the set and it MUST stay bounded: the projects root on a real host is largely
 * test-run litter, so scanning all of it is slow and floods the picker with
 * throwaway workspaces.
 *
 * Session ids are globally unique, so an id present in two dirs lists once
 * (first dir wins, dirs being ordered before the scan). `opts.max` caps the
 * UNION rather than each dir, so the open-and-read bound is exactly the single
 * scan's.
 */
export async function listSessionsAcross(
  chatsDirs: string[],
  opts: { max?: number; archivedDirs?: readonly string[] } = {},
): Promise<SessionListResult> {
  const max = opts.max ?? MAX_LIST_SESSIONS;
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const archivedSet = new Set(opts.archivedDirs ?? []);

  // Archive dirs are scanned LAST, so an id sitting in BOTH states (core calls
  // that 'conflict', sessionService.ts:1317) resolves to its live copy, which
  // is the one the daemon will actually open.
  //
  // Within ONE workspace the lexical dir sort happens to do this already:
  // `<chatsDir>` is a string prefix of `<chatsDir>/archive`, so it always sorts
  // first. The ordering here is what carries it for a MULTI-workspace scan
  // (the `extraWorkspaces` widening), where one workspace's archive dir sorts
  // BEFORE another's chats dir -- `/w/aaa/chats/archive` < `/w/zzz/chats` --
  // and a plain sort would then prefer an archived copy over a live one.
  const unique = [...new Set(chatsDirs)];
  const ordered = [
    ...unique.filter((d) => !archivedSet.has(d)).sort(cmp),
    ...unique.filter((d) => archivedSet.has(d)).sort(cmp),
  ];

  const homeOf = new Map<string, string>();
  for (const dir of ordered) {
    const ids = await scanValidIds(dir);
    if (ids === null) continue; // no such workspace: contributes nothing
    for (const id of ids) if (!homeOf.has(id)) homeOf.set(id, dir);
  }

  // Cap by RECENCY, not by id. Ids are random UUIDs, so a lexical prefix is an
  // arbitrary subset and could leave the newest session out of every listing.
  // The mtime is read here for every candidate (a stat is cheap next to the
  // three file opens a row costs); the newest `max` win, ties broken by id so
  // the cap stays deterministic. A file that cannot be stat'd is omitted.
  const stamped: Array<{ id: string; dir: string; mtimeMs: number }> = [];
  for (const id of [...homeOf.keys()].sort(cmp)) {
    const dir = homeOf.get(id) as string;
    try {
      const stats = await stat(join(dir, `${id}.jsonl`));
      stamped.push({ id, dir, mtimeMs: stats.mtimeMs });
    } catch {
      // vanished or unreadable: omitted, never given a made-up mtime
    }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs || cmp(a.id, b.id));
  const truncated = stamped.length > max;
  const capped = truncated ? stamped.slice(0, max) : stamped;

  const entries: SessionEntry[] = [];
  for (const { id, dir, mtimeMs } of capped) {
    const entry = await readEntry(dir, id, new Date(mtimeMs).toISOString());
    if (archivedSet.has(dir)) entry.archived = true;
    entries.push(entry);
  }

  return { sessions: finishListing(entries), truncated };
}

/**
 * Scan a workspace chats dir into a fork-lineage listing. Mirrors the lineage
 * route's source of truth (each transcript's first-record
 * `forkedFrom.sessionId`), so `/rc/sessions` and `/session/:id/lineage`
 * agree. A missing chats dir (ENOENT) is an empty listing, not an error.
 *
 * Filenames are filtered to syntactically valid `<id>.jsonl` (the same
 * path-traversal guard lineage uses), then the newest `opts.max` by mtime are
 * kept (`truncated` reports the overflow). An unreadable first line lists
 * the session as a root rather than dropping it.
 *
 * Defined as the single-dir case of {@link listSessionsAcross} so the two paths
 * cannot drift apart.
 */
export async function listSessions(
  chatsDir: string,
  opts: { max?: number } = {},
): Promise<SessionListResult> {
  return listSessionsAcross([chatsDir], opts);
}
