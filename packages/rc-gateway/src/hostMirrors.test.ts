/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSessionMirrored, readProcArgv } from './hostMirrors.js';

const SESSION = 'a9a5ddef-edc9-472e-8c52-ea6da2609e80';

function attach(id: string): string[] {
  return [
    'node',
    '/opt/qwen/cli/dist/index.js',
    '--attach-daemon',
    'http://127.0.0.1:46135',
    '--daemon-token',
    'tok',
    '--attach-session',
    id,
  ];
}

describe('isSessionMirrored', () => {
  it('is true when a process attaches to exactly this session', async () => {
    const lister = async () => [['bash'], attach(SESSION)];
    expect(await isSessionMirrored(SESSION, lister)).toBe(true);
  });

  it('also reads the --attach-session=<id> spelling', async () => {
    const lister = async () => [
      ['node', 'index.js', `--attach-session=${SESSION}`],
    ];
    expect(await isSessionMirrored(SESSION, lister)).toBe(true);
  });

  it('is false when nothing attaches to it', async () => {
    const lister = async () => [
      ['bash'],
      attach('11111111-2222-3333-4444-555555555555'),
    ];
    expect(await isSessionMirrored(SESSION, lister)).toBe(false);
  });

  it('is false for an empty process list', async () => {
    expect(await isSessionMirrored(SESSION, async () => [])).toBe(false);
  });

  it('does not match when the id is only a prefix of a longer attached id', async () => {
    const lister = async () => [
      attach(SESSION + '-extra'),
      attach(SESSION.slice(0, 20)),
    ];
    expect(await isSessionMirrored(SESSION, lister)).toBe(false);
  });

  it('does not match the id when it is not the value of --attach-session', async () => {
    const lister = async () => [
      ['grep', SESSION],
      ['node', 'index.js', '--resume', SESSION, '--attach-session', 'other'],
    ];
    expect(await isSessionMirrored(SESSION, lister)).toBe(false);
  });

  it('is false for an empty session id', async () => {
    const lister = async () => [['node', '--attach-session', '']];
    expect(await isSessionMirrored('', lister)).toBe(false);
  });

  it('answers false rather than throwing when the lister fails', async () => {
    const lister = async () => {
      throw new Error('EACCES');
    };
    expect(await isSessionMirrored(SESSION, lister)).toBe(false);
  });
});

describe('readProcArgv', () => {
  it('splits cmdline on NUL, skips non-pid entries, empty and unreadable ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rc-proc-'));
    try {
      await mkdir(join(root, '101'));
      await writeFile(
        join(root, '101', 'cmdline'),
        ['node', 'index.js', '--attach-session', SESSION].join('\0') + '\0',
      );
      // A kernel thread: present, empty.
      await mkdir(join(root, '102'));
      await writeFile(join(root, '102', 'cmdline'), '');
      // A process that exited between readdir and read: no cmdline file.
      await mkdir(join(root, '103'));
      // A directory where the file should be: read fails with EISDIR.
      await mkdir(join(root, '104', 'cmdline'), { recursive: true });
      // Not a pid.
      await mkdir(join(root, 'self'));
      await writeFile(join(root, 'self', 'cmdline'), 'nope\0');

      const argvs = await readProcArgv(root);
      expect(argvs).toEqual([
        ['node', 'index.js', '--attach-session', SESSION],
      ]);
      expect(await isSessionMirrored(SESSION, () => readProcArgv(root))).toBe(
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns an empty list when the directory cannot be read', async () => {
    expect(await readProcArgv('/nonexistent-proc-dir')).toEqual([]);
  });
});
