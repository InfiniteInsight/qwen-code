/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

/**
 * Replicates core's `paths.ts#sanitizeCwd` EXACTLY: every non-alphanumeric
 * character becomes a dash. On win32 the cwd is lowercased first (matching
 * `os.platform() === 'win32'` in core). This is the project-id segment of the
 * on-disk chats path; cycle-19's `search/transcripts.ts` used a looser
 * `replace(/[/.]/g,'-')` approximation that diverges for `_`/space/etc. — this
 * is the corrected resolver (the search one is a documented follow-up).
 */
export function sanitizeCwd(cwd: string): string {
  const normalized = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Expands a leading `~`/`~/` and resolves relative paths to absolute, mirroring
 * core `Storage#resolvePath` so env-provided base dirs resolve identically.
 */
function resolvePath(dir: string): string {
  let resolved = dir;
  if (
    resolved === '~' ||
    resolved.startsWith('~/') ||
    resolved.startsWith('~\\')
  ) {
    const segments =
      resolved === '~'
        ? []
        : resolved
            .slice(2)
            .split(/[/\\]+/)
            .filter(Boolean);
    resolved = join(homedir(), ...segments);
  }
  if (!isAbsolute(resolved)) {
    resolved = resolve(resolved);
  }
  return resolved;
}

/**
 * Replicates core's `Storage.getRuntimeBaseDir()` precedence as visible from
 * OUTSIDE the daemon process: `QWEN_RUNTIME_DIR` env → else `QWEN_HOME` env
 * (= `getGlobalQwenDir`) → else `~/.qwen`.
 *
 * The middle tier in core — a settings-based `setRuntimeBaseDir()`/contextual
 * override — is INVISIBLE to the gateway, which is exactly why the fork route
 * guards on the parent file existing at the derived path (a mismatch becomes a
 * clean 404, never silent corruption).
 */
export function runtimeBaseDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const runtime = env['QWEN_RUNTIME_DIR'];
  if (runtime) {
    return resolvePath(runtime);
  }
  const home = env['QWEN_HOME'];
  if (home) {
    return resolvePath(home);
  }
  return join(homedir(), '.qwen');
}

/**
 * The chats dir for a workspace: `<runtimeBaseDir>/projects/<sanitizeCwd>/chats`
 * — byte-identical to core's `Storage#getProjectDir()` + `'chats'`.
 *
 * `cwd` may come from request input (e.g. `GET /rc/sessions?cwd=`, or
 * `/workspace/:cwd/sessions`), not only the trusted
 * `daemon.capabilities().workspaceCwd`. That is safe only because `sanitizeCwd`
 * flattens every non-alphanumeric character (including `/`, `.`, `\`) to `-`,
 * so no path separator or traversal sequence ever survives into the
 * filesystem path built below. Any future caller of this function MUST keep
 * routing untrusted `cwd` values through `sanitizeCwd` — do not bypass it.
 */
export function resolveChatsDir(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(runtimeBaseDir(env), 'projects', sanitizeCwd(cwd), 'chats');
}

/**
 * The dir a workspace's ARCHIVED transcripts live in. Mirrors core's
 * `getArchiveChatsDir()` (sessionService.ts:954), which is `<chatsDir>/archive`
 * — archiving MOVES the transcript rather than flagging it, so a caller that
 * only reads the chats dir cannot see an archived conversation at all.
 *
 * Derived from an already-resolved chats dir rather than from a cwd, so the
 * archive layout is stated once and cannot drift from wherever the caller's
 * chats dir came from.
 */
export function archiveChatsDirOf(chatsDir: string): string {
  return join(chatsDir, 'archive');
}

/**
 * The directory holding this workspace's BM25 search index — a sibling of the
 * `chats` dir under the same project segment, so it is keyed to the same
 * `sanitizeCwd(cwd)` and two workspaces can never read each other's index. The
 * index db (and any transient SQLite journal sibling) lives here; the index
 * store creates this dir `0700` and the db file `0600` because the index is a
 * new at-rest copy of raw transcript content (prompts, tool output).
 */
export function resolveSearchIndexDir(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(
    runtimeBaseDir(env),
    'projects',
    sanitizeCwd(cwd),
    'search-index',
  );
}

/**
 * Matches core's `SESSION_FILE_PATTERN` (minus the `.jsonl` suffix): 32–36
 * chars of hex + dashes. Used to reject path-traversal / malformed parent ids
 * before any path join.
 */
export const SESSION_FILE_RE = /^[0-9a-fA-F-]{32,36}$/;

/** True when `id` is a syntactically valid session id (safe to path-join). */
export function isValidSessionId(id: string): boolean {
  return SESSION_FILE_RE.test(id);
}

/**
 * Locates the chats dir that holds `<sessionId>.jsonl` by scanning every
 * `<runtimeBaseDir>/projects/<segment>/chats/` dir when no workspace cwd
 * names it.
 *
 * Sessions live in the chats dir of the workspace they were RUN in, which
 * need not be the gateway's boot workspace (e.g. a conversation started in a
 * project dir). `sanitizeCwd` is lossy — the project segment cannot be
 * reversed to the original cwd — so when the trusted/request cwd candidates
 * miss, the only way to find the transcript is a bounded scan of the project
 * segments. The scan names the FILE, not the workspace: callers must treat a
 * scan hit as "workspace unknown" (they cannot derive a `workspaceCwd` for
 * daemon routing from it).
 *
 * Returns `null` when the file exists in no project dir (or the projects dir
 * itself is missing/unreadable). The id is validated first — this function
 * never path-joins an unvalidated id.
 */
export async function findSessionChatsDir(
  sessionId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  if (!isValidSessionId(sessionId)) return null;
  const projectsDir = join(runtimeBaseDir(env), 'projects');
  let segments: string[];
  try {
    segments = await readdir(projectsDir);
  } catch {
    return null; // no projects dir → nothing to scan
  }
  for (const segment of segments) {
    const chatsDir = join(projectsDir, segment, 'chats');
    try {
      await stat(join(chatsDir, `${sessionId}.jsonl`));
      return chatsDir;
    } catch {
      // not in this segment — keep scanning
    }
  }
  return null;
}

/**
 * True when the transcript for `sessionId` exists under a project's
 * `chats/archive/` dir, i.e. the conversation is filed away rather than absent.
 *
 * This exists so the routes that answer 404 "transcript not found" can tell the
 * truth instead: an archived conversation is not a missing one, and the daemon
 * already has a word for the difference (409 `session_archived`, raised by
 * `assertSessionLoadable`, cli/src/serve/server/error-response.ts:780).
 *
 * Deliberately returns a boolean and never a directory. The sibling
 * `findSessionChatsDir` hands back a path, and `routes/fork.ts:291` writes a NEW
 * transcript into whichever dir it resolved (`writeFork(chatsDir, ...)`). If the
 * scan learned to return an archive dir, forking an archived conversation would
 * file the brand-new child into the archive alongside its parent. A yes/no
 * answer cannot make that mistake, which is why this is a separate function
 * rather than a flag on the existing one.
 *
 * `preferredChatsDir` is the active chats dir the caller already looked in: its
 * `archive` sibling is the cheapest stat to try, covering the single-workspace
 * case in one call. The bounded project scan is the fallback for a transcript
 * run in another workspace, mirroring `findSessionChatsDir`.
 *
 * The id is validated first and never path-joined unvalidated.
 */
export async function isSessionArchived(
  sessionId: string,
  preferredChatsDir?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  const file = `${sessionId}.jsonl`;
  if (preferredChatsDir) {
    try {
      await stat(join(archiveChatsDirOf(preferredChatsDir), file));
      return true;
    } catch {
      // not filed in this workspace — the scan below may still find it
    }
  }
  const projectsDir = join(runtimeBaseDir(env), 'projects');
  let segments: string[];
  try {
    segments = await readdir(projectsDir);
  } catch {
    return false; // no projects dir -> nothing to scan
  }
  for (const segment of segments) {
    const archiveDir = archiveChatsDirOf(join(projectsDir, segment, 'chats'));
    try {
      await stat(join(archiveDir, file));
      return true;
    } catch {
      // not filed here — keep scanning
    }
  }
  return false;
}
