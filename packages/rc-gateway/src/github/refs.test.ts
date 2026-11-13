/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDest, parseRepoRef, repoUrl } from './refs.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rc-github-refs-'));
}

describe('parseRepoRef', () => {
  it.each([
    'owner/name',
    'https://github.com/owner/name',
    'https://github.com/owner/name.git',
    'https://github.com/owner/name/',
    'git@github.com:owner/name.git',
    'git@github.com:owner/name',
    'owner/name.git',
    '  owner/name\n',
  ])('parseRepoRef accepts %j', (input) => {
    expect(parseRepoRef(input)).toEqual({ owner: 'owner', name: 'name' });
  });

  it('keeps dots, dashes and underscores in a name and the case of both parts', () => {
    expect(parseRepoRef('My-Org/qwen_code.remote-2')).toEqual({
      owner: 'My-Org',
      name: 'qwen_code.remote-2',
    });
  });

  it.each([
    'owner/name --upload-pack=x',
    '../x',
    '-x/y',
    'owner/..',
    'owner/.',
    'owner/.git',
    'https://gitlab.com/a/b',
    'owner/name/extra',
    '',
    '   ',
    'owner',
    '/owner/name',
    'owner//name',
    'owner/name?tab=readme',
    'owner/name#readme',
    'https://github.com/owner/name/tree/main',
    'https://github.com.evil.example/owner/name',
    'https://user:pw@github.com/owner/name',
    'http://github.com/owner/name',
    'ssh://git@github.com/owner/name.git',
    'git@gitlab.com:owner/name.git',
    'file:///srv/owner/name',
    'owner/na me',
    'owner/name;rm',
    'owner/%2e%2e',
    `o${'a'.repeat(39)}/name`,
    `owner/${'n'.repeat(101)}`,
    'own_er/name',
    'owner/name\u0000',
  ])('parseRepoRef refuses %j', (input) => {
    expect(parseRepoRef(input)).toBeNull();
  });

  it('accepts the longest owner and name GitHub allows', () => {
    const owner = `o${'a'.repeat(38)}`;
    const name = 'n'.repeat(100);
    expect(parseRepoRef(`${owner}/${name}`)).toEqual({ owner, name });
  });
});

describe('repoUrl', () => {
  it('is the plain https clone URL', () => {
    expect(repoUrl({ owner: 'owner', name: 'name' })).toBe(
      'https://github.com/owner/name.git',
    );
  });

  it('throws on a ref that did not come from parseRepoRef', () => {
    expect(() => repoUrl({ owner: '-x', name: 'y' })).toThrow();
    expect(() => repoUrl({ owner: 'owner', name: '..' })).toThrow();
    expect(() =>
      repoUrl({ owner: 'owner', name: 'name --upload-pack=x' }),
    ).toThrow();
  });
});

describe('checkDest', () => {
  it('refuses a relative path', async () => {
    const r = await checkDest('projects/name');
    expect(r).toMatchObject({ ok: false, code: 'dest_not_absolute' });
    if (!r.ok) expect(r.error).toContain('projects/name');
  });

  it('refuses a tilde path and an empty path as not absolute', async () => {
    expect(await checkDest('~/projects/name')).toMatchObject({
      ok: false,
      code: 'dest_not_absolute',
    });
    expect(await checkDest('')).toMatchObject({
      ok: false,
      code: 'dest_not_absolute',
    });
  });

  it('refuses a path with a NUL byte without throwing', async () => {
    expect(await checkDest('/tmp/a\u0000b')).toMatchObject({
      ok: false,
      code: 'dest_not_absolute',
    });
  });

  it('refuses a missing parent', async () => {
    const d = tempDir();
    const r = await checkDest(join(d, 'missing', 'leaf'));
    expect(r).toMatchObject({ ok: false, code: 'dest_parent_missing' });
    if (!r.ok) expect(r.error).toContain(join(d, 'missing'));
  });

  it('refuses a parent that is a file', async () => {
    const d = tempDir();
    writeFileSync(join(d, 'file'), 'x');
    expect(await checkDest(join(d, 'file', 'leaf'))).toMatchObject({
      ok: false,
      code: 'dest_parent_missing',
    });
  });

  it('refuses a non-empty directory', async () => {
    const d = tempDir();
    mkdirSync(join(d, 'full'));
    writeFileSync(join(d, 'full', '.hidden'), 'x');
    const r = await checkDest(join(d, 'full'));
    expect(r).toMatchObject({ ok: false, code: 'dest_not_empty' });
    if (!r.ok) expect(r.error).toContain(join(d, 'full'));
  });

  it('refuses a file', async () => {
    const d = tempDir();
    writeFileSync(join(d, 'file'), 'x');
    expect(await checkDest(join(d, 'file'))).toMatchObject({
      ok: false,
      code: 'dest_not_directory',
    });
  });

  it('refuses a symlink, even one to an empty directory', async () => {
    const d = tempDir();
    mkdirSync(join(d, 'empty'));
    symlinkSync(join(d, 'empty'), join(d, 'link'));
    const r = await checkDest(join(d, 'link'));
    expect(r).toMatchObject({ ok: false, code: 'dest_not_directory' });
    if (!r.ok) expect(r.error).toMatch(/symbolic link/);
  });

  it('is ok for a missing leaf under an existing parent', async () => {
    const d = tempDir();
    expect(await checkDest(join(d, 'new'))).toEqual({
      ok: true,
      path: join(d, 'new'),
    });
  });

  it('is ok for an empty directory', async () => {
    const d = tempDir();
    mkdirSync(join(d, 'empty'));
    expect(await checkDest(join(d, 'empty'))).toEqual({
      ok: true,
      path: join(d, 'empty'),
    });
  });

  it('answers the normalised path', async () => {
    const d = tempDir();
    mkdirSync(join(d, 'a'));
    expect(await checkDest(`${d}/a/../new/`)).toEqual({
      ok: true,
      path: join(d, 'new'),
    });
  });
});
