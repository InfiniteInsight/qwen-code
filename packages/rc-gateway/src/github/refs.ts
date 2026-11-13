/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Repo references and clone destinations for clone-to-conversation
 * (InfiniteInsight/Qwen-Code-Remote#257).
 *
 * `parseRepoRef` is the guard in front of `git clone`: the clone argv is built
 * from `repoUrl(parseRepoRef(input))`, so anything that is not a plain
 * github.com owner/name is refused here, before git runs. The owner and name
 * patterns admit no space, no leading dash on the owner, no `%`, `?`, `#`,
 * `:` or `@`, so a pasted value can neither add a git option
 * (`--upload-pack=...`) nor point the clone at another host or path.
 */

import { lstat, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface RepoRef {
  owner: string;
  name: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

const HTTPS_PREFIX = 'https://github.com/';
const SSH_PREFIX = 'git@github.com:';

function validRef(owner: string, name: string): boolean {
  return OWNER.test(owner) && NAME.test(name) && name !== '.' && name !== '..';
}

/**
 * Reads `owner/name`, `https://github.com/owner/name` (with or without `.git`
 * and a trailing slash) or `git@github.com:owner/name.git`. Surrounding
 * whitespace from a paste is ignored. Anything else, including any other host,
 * scheme, credentials, query, fragment or extra path segment, is `null`.
 */
export function parseRepoRef(input: string): RepoRef | null {
  if (typeof input !== 'string') return null;
  let path = input.trim();
  if (path.startsWith(HTTPS_PREFIX)) path = path.slice(HTTPS_PREFIX.length);
  else if (path.startsWith(SSH_PREFIX)) path = path.slice(SSH_PREFIX.length);
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (path.endsWith('.git')) path = path.slice(0, -'.git'.length);
  const parts = path.split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  return validRef(owner, name) ? { owner, name } : null;
}

/**
 * The plain https clone URL. Throws on a ref that would not pass
 * `parseRepoRef`, so a hand-built ref cannot smuggle an option or a path into
 * the clone argv.
 */
export function repoUrl(ref: RepoRef): string {
  if (!validRef(ref.owner, ref.name)) {
    throw new Error('not a GitHub owner/name');
  }
  return `${HTTPS_PREFIX}${ref.owner}/${ref.name}.git`;
}

export type DestCode =
  | 'dest_not_absolute'
  | 'dest_parent_missing'
  | 'dest_not_empty'
  | 'dest_not_directory';

export type DestCheck =
  | { ok: true; path: string }
  | { ok: false; code: DestCode; error: string };

function errCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

/**
 * Checks a clone destination before git runs. It must be absolute; it is
 * normalised; its parent must exist and be a directory; the destination itself
 * must be absent or an empty directory. A symlink at the destination is refused
 * even when it points at an empty directory, so the clone lands where the path
 * says. Never throws: every refusal names its cause.
 */
export async function checkDest(dest: string): Promise<DestCheck> {
  if (typeof dest !== 'string' || !isAbsolute(dest)) {
    return {
      ok: false,
      code: 'dest_not_absolute',
      error: `The destination must be an absolute path: ${JSON.stringify(dest)}`,
    };
  }
  if (dest.includes('\0')) {
    return {
      ok: false,
      code: 'dest_not_absolute',
      error: 'The destination path contains a NUL byte.',
    };
  }
  const path = resolve(dest);
  const parent = dirname(path);

  try {
    const st = await stat(parent);
    if (!st.isDirectory()) {
      return {
        ok: false,
        code: 'dest_parent_missing',
        error: `The parent ${parent} is not a folder.`,
      };
    }
  } catch (e) {
    const code = errCode(e);
    return {
      ok: false,
      code: 'dest_parent_missing',
      error:
        code === 'ENOENT'
          ? `The parent folder ${parent} does not exist.`
          : code === 'ENOTDIR'
            ? `The parent ${parent} is not a folder.`
            : `The parent folder ${parent} cannot be read (${code}).`,
    };
  }

  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT') return { ok: true, path };
    return {
      ok: false,
      code: 'dest_parent_missing',
      error: `Cannot look inside ${parent} (${code}).`,
    };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      code: 'dest_not_directory',
      error: `${path} is a symbolic link, not a folder.`,
    };
  }
  if (!st.isDirectory()) {
    return {
      ok: false,
      code: 'dest_not_directory',
      error: `${path} exists and is not a folder.`,
    };
  }
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (e) {
    return {
      ok: false,
      code: 'dest_not_empty',
      error: `${path} cannot be listed (${errCode(e)}), so it is not known to be empty.`,
    };
  }
  if (entries.length > 0) {
    return {
      ok: false,
      code: 'dest_not_empty',
      error: `${path} is not empty.`,
    };
  }
  return { ok: true, path };
}
