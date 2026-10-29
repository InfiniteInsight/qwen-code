/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  sanitizeCwd,
  runtimeBaseDir,
  resolveChatsDir,
  resolveSearchIndexDir,
  canonicalWorkspaceRoot,
  isValidSessionId,
  SESSION_FILE_RE,
  findSessionChatsDir,
  archiveChatsDirOf,
  isSessionArchived,
} from './chatsPath.js';

describe('sanitizeCwd', () => {
  it('replaces every non-alphanumeric char (/, ., _, space) with a dash', () => {
    // These are exactly the cases where cycle-19's `replace(/[/.]/g,'-')`
    // approximation diverges from core's sanitizeCwd.
    expect(sanitizeCwd('/home/my_user/projects/qwen code.v2')).toBe(
      '-home-my-user-projects-qwen-code-v2',
    );
  });

  it('leaves alphanumerics untouched', () => {
    expect(sanitizeCwd('abc123')).toBe('abc123');
  });
});

describe('runtimeBaseDir', () => {
  it('honors QWEN_RUNTIME_DIR first (resolved to absolute)', () => {
    expect(runtimeBaseDir({ QWEN_RUNTIME_DIR: '/rt/dir' })).toBe('/rt/dir');
  });

  it('falls back to QWEN_HOME when QWEN_RUNTIME_DIR is unset', () => {
    expect(runtimeBaseDir({ QWEN_HOME: '/home-dir/.qwen' })).toBe(
      '/home-dir/.qwen',
    );
  });

  it('prefers QWEN_RUNTIME_DIR over QWEN_HOME', () => {
    expect(runtimeBaseDir({ QWEN_RUNTIME_DIR: '/rt', QWEN_HOME: '/qh' })).toBe(
      '/rt',
    );
  });

  it('falls back to ~/.qwen when neither env var is set', () => {
    expect(runtimeBaseDir({})).toBe(join(homedir(), '.qwen'));
  });
});

describe('resolveChatsDir', () => {
  it('builds <base>/projects/<sanitizeCwd>/chats honoring QWEN_RUNTIME_DIR', () => {
    expect(resolveChatsDir('/work/proj', { QWEN_RUNTIME_DIR: '/rt' })).toBe(
      join('/rt', 'projects', '-work-proj', 'chats'),
    );
  });

  it('honors QWEN_HOME when QWEN_RUNTIME_DIR is unset', () => {
    expect(resolveChatsDir('/work/proj', { QWEN_HOME: '/qh/.qwen' })).toBe(
      join('/qh/.qwen', 'projects', '-work-proj', 'chats'),
    );
  });

  it('falls back to ~/.qwen base', () => {
    expect(resolveChatsDir('/work/proj', {})).toBe(
      join(homedir(), '.qwen', 'projects', '-work-proj', 'chats'),
    );
  });

  it('dashes every non-alphanumeric char — the cycle-19 divergence (regression)', () => {
    // This is the case the cycle-23 unification exists to fix. Cycle-19's
    // search resolver used `replace(/[/.]/g,'-')`, which KEPT the underscore →
    // `-home-u-my_proj` → a dir the daemon never wrote → search silently
    // returned []. The exact resolver dashes the `_` like core's sanitizeCwd,
    // matching the daemon's actual write path.
    expect(resolveChatsDir('/home/u/my_proj', {})).toBe(
      join(homedir(), '.qwen', 'projects', '-home-u-my-proj', 'chats'),
    );
  });
});

describe('resolveChatsDir canonicalises the cwd like core (#170)', () => {
  let root: string;
  let real: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'rc-canon-')));
    real = join(root, 'real_ws');
    await mkdir(real);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const env = { QWEN_RUNTIME_DIR: '/rt' };
  const expected = () => join('/rt', 'projects', sanitizeCwd(real), 'chats');

  it('a trailing slash maps to the same project segment', () => {
    expect(resolveChatsDir(`${real}/`, env)).toBe(expected());
  });

  it('a ./ and .. spelling maps to the same project segment', () => {
    expect(resolveChatsDir(join(real, '.', 'x', '..'), env)).toBe(expected());
  });

  it('a symlink maps to the real directory segment', async () => {
    const link = join(root, 'link-ws');
    await symlink(real, link);
    expect(resolveChatsDir(link, env)).toBe(expected());
    expect(resolveSearchIndexDir(link, env)).toBe(
      join('/rt', 'projects', sanitizeCwd(real), 'search-index'),
    );
  });

  it('"." resolves against the process cwd', () => {
    const here = process.cwd();
    expect(resolveChatsDir('.', env)).toBe(
      join(
        '/rt',
        'projects',
        sanitizeCwd(canonicalWorkspaceRoot(here)),
        'chats',
      ),
    );
    expect(canonicalWorkspaceRoot('.')).toBe(canonicalWorkspaceRoot(here));
  });

  it('a path that does not exist falls back to its resolved form', () => {
    expect(canonicalWorkspaceRoot('/no/such/ws/')).toBe('/no/such/ws');
  });
});

describe('isValidSessionId / SESSION_FILE_RE', () => {
  it('accepts a UUID', () => {
    expect(isValidSessionId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });

  it('rejects a path-traversal id', () => {
    expect(isValidSessionId('../x')).toBe(false);
  });

  it('rejects a too-short id', () => {
    expect(isValidSessionId('abc')).toBe(false);
  });

  it('rejects ids with a path separator', () => {
    expect(isValidSessionId('a/b')).toBe(false);
  });

  it('SESSION_FILE_RE matches a 32-char hex id', () => {
    expect(SESSION_FILE_RE.test('0123456789abcdef0123456789abcdef')).toBe(true);
  });
});

describe('findSessionChatsDir', () => {
  let runtimeBase: string;
  const env = () => ({ QWEN_RUNTIME_DIR: runtimeBase });
  const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(async () => {
    runtimeBase = await mkdtemp(join(tmpdir(), 'rc-chats-path-'));
  });

  afterEach(async () => {
    await rm(runtimeBase, { recursive: true, force: true });
  });

  it('returns null when the projects dir is missing', async () => {
    await expect(findSessionChatsDir(SESSION_ID, env())).resolves.toBeNull();
  });

  it('returns null for an invalid id without touching the filesystem', async () => {
    await expect(findSessionChatsDir('../x', env())).resolves.toBeNull();
  });

  it('returns the matching chats dir when the file exists in one segment', async () => {
    const segA = join(runtimeBase, 'projects', '-home-evan');
    const segB = join(
      runtimeBase,
      'projects',
      '-home-evan-projects-qwen-code-remote',
    );
    await mkdir(join(segA, 'chats'), { recursive: true });
    await mkdir(join(segB, 'chats'), { recursive: true });
    await writeFile(join(segB, 'chats', `${SESSION_ID}.jsonl`), '');
    await expect(findSessionChatsDir(SESSION_ID, env())).resolves.toEqual(
      join(segB, 'chats'),
    );
  });

  it('returns null when no segment holds the file', async () => {
    const segA = join(runtimeBase, 'projects', '-home-evan');
    await mkdir(join(segA, 'chats'), { recursive: true });
    await writeFile(
      join(segA, 'chats', 'ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl'),
      '',
    );
    await expect(findSessionChatsDir(SESSION_ID, env())).resolves.toBeNull();
  });

  it('keeps scanning past a segment without a chats subdir', async () => {
    const segNoChats = join(runtimeBase, 'projects', '-seg-no-chats');
    const segHit = join(runtimeBase, 'projects', '-seg-hit');
    await mkdir(segNoChats, { recursive: true });
    await mkdir(join(segHit, 'chats'), { recursive: true });
    await writeFile(join(segHit, 'chats', `${SESSION_ID}.jsonl`), '');
    await expect(findSessionChatsDir(SESSION_ID, env())).resolves.toEqual(
      join(segHit, 'chats'),
    );
  });
});

describe('isSessionArchived', () => {
  let runtimeBase: string;
  const env = () => ({ QWEN_RUNTIME_DIR: runtimeBase });
  const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000';
  // Every path below is built from `env()`, never from `process.env`: calling
  // `resolveChatsDir(cwd)` without it resolves against the REAL `~/.qwen`, and
  // these tests would create files in the developer's home dir.
  const preferred = () => resolveChatsDir('/home/evan/this-ws', env());

  beforeEach(async () => {
    runtimeBase = await mkdtemp(join(tmpdir(), 'rc-archived-'));
  });

  afterEach(async () => {
    await rm(runtimeBase, { recursive: true, force: true });
  });

  it('is true when the transcript sits in a segment archive', async () => {
    const archive = archiveChatsDirOf(
      join(runtimeBase, 'projects', '-home-evan', 'chats'),
    );
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, `${SESSION_ID}.jsonl`), '');
    await expect(isSessionArchived(SESSION_ID, undefined, env())).resolves.toBe(
      true,
    );
  });

  it('is false for a transcript that is simply absent', async () => {
    // The discriminating half. Without it, "archived" could be satisfied by a
    // stub that always answers yes, and every missing session would be told it
    // was filed away.
    await mkdir(join(runtimeBase, 'projects', '-home-evan', 'chats'), {
      recursive: true,
    });
    await expect(isSessionArchived(SESSION_ID, undefined, env())).resolves.toBe(
      false,
    );
  });

  it('is false when the transcript is active, not filed', async () => {
    // The other discriminating half: a live transcript must never be reported
    // as archived.
    const chats = join(runtimeBase, 'projects', '-home-evan', 'chats');
    await mkdir(chats, { recursive: true });
    await writeFile(join(chats, `${SESSION_ID}.jsonl`), '');
    await expect(isSessionArchived(SESSION_ID, undefined, env())).resolves.toBe(
      false,
    );
  });

  it('is false for an invalid id without touching the filesystem', async () => {
    await expect(isSessionArchived('../x', undefined, env())).resolves.toBe(
      false,
    );
  });

  it('is false when the projects dir is missing', async () => {
    await expect(isSessionArchived(SESSION_ID, undefined, env())).resolves.toBe(
      false,
    );
  });

  it('answers from the preferred chats dir without needing a scan', async () => {
    // The single-workspace fast path. No `projects` dir exists under
    // `runtimeBase`, so a scan could not have produced this answer.
    const archive = archiveChatsDirOf(preferred());
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, `${SESSION_ID}.jsonl`), '');
    await expect(
      isSessionArchived(SESSION_ID, preferred(), env()),
    ).resolves.toBe(true);
  });

  it('never reports an active preferred transcript as archived', async () => {
    // Guards the direction of the preferred-dir stat: it must look in the
    // archive sibling, never in the active dir it was handed.
    await mkdir(preferred(), { recursive: true });
    await writeFile(join(preferred(), `${SESSION_ID}.jsonl`), '');
    await expect(
      isSessionArchived(SESSION_ID, preferred(), env()),
    ).resolves.toBe(false);
  });

  it('finds an archived transcript in another workspace via the scan', async () => {
    const archive = archiveChatsDirOf(
      join(runtimeBase, 'projects', '-other-ws', 'chats'),
    );
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, `${SESSION_ID}.jsonl`), '');
    await mkdir(preferred(), { recursive: true });
    await expect(
      isSessionArchived(SESSION_ID, preferred(), env()),
    ).resolves.toBe(true);
  });
});
