/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isLiveTerminalTarget,
  isSessionMirrored,
  readProcArgv,
  readProcEntries,
  readStdinTarget,
  type ProcessEntry,
  type StdinTargetReader,
} from './hostMirrors.js';

const SESSION = 'a9a5ddef-edc9-472e-8c52-ea6da2609e80';

/** Every fake process has a live pty on fd 0 unless a test says otherwise. */
const livePty: StdinTargetReader = async () => '/dev/pts/3';

/** Wrap bare argvs as processes with ascending pids. */
function procs(...argvs: string[][]): ProcessEntry[] {
  return argvs.map((argv, i) => ({ pid: 1000 + i, argv }));
}

/** isSessionMirrored with a lister over `argvs` and a live pty on every fd 0. */
function mirrored(
  id: string,
  lister: () => Promise<string[][]>,
  readStdin: StdinTargetReader = livePty,
): Promise<boolean> {
  return isSessionMirrored(
    id,
    async () => procs(...(await lister())),
    readStdin,
  );
}

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
    expect(await mirrored(SESSION, lister)).toBe(true);
  });

  it('also reads the --attach-session=<id> spelling', async () => {
    const lister = async () => [
      ['node', 'index.js', `--attach-session=${SESSION}`],
    ];
    expect(await mirrored(SESSION, lister)).toBe(true);
  });

  it('matches the qwen-rc attach wrapper, which outlives each TUI it runs', async () => {
    const wrapper = (...rest: string[]) => [
      'node',
      '/opt/rc/dist/cli.js',
      'attach',
      ...rest,
    ];
    expect(
      await mirrored(SESSION, async () => [
        wrapper('--session', SESSION, '/srv/work'),
      ]),
    ).toBe(true);
    expect(
      await mirrored(SESSION, async () => [
        wrapper('/srv/work', `--session=${SESSION}`),
      ]),
    ).toBe(true);
  });

  it('does not match a wrapper on another session or a longer id', async () => {
    const lister = async () => [
      ['node', 'cli.js', 'attach', '--session', 'other', '/srv/work'],
      ['node', 'cli.js', 'attach', '--session', SESSION + '-x', '/srv/work'],
    ];
    expect(await mirrored(SESSION, lister)).toBe(false);
  });

  it('does not match a --session flag on a command that is not an attach', async () => {
    const lister = async () => [
      ['some-tool', '--session', SESSION],
      ['some-tool', `--session=${SESSION}`, 'attach'],
    ];
    expect(await mirrored(SESSION, lister)).toBe(false);
  });

  it('is false when nothing attaches to it', async () => {
    const lister = async () => [
      ['bash'],
      attach('11111111-2222-3333-4444-555555555555'),
    ];
    expect(await mirrored(SESSION, lister)).toBe(false);
  });

  it('is false for an empty process list', async () => {
    expect(await mirrored(SESSION, async () => [])).toBe(false);
  });

  it('does not match when the id is only a prefix of a longer attached id', async () => {
    const lister = async () => [
      attach(SESSION + '-extra'),
      attach(SESSION.slice(0, 20)),
    ];
    expect(await mirrored(SESSION, lister)).toBe(false);
  });

  it('does not match the id when it is not the value of --attach-session', async () => {
    const lister = async () => [
      ['grep', SESSION],
      ['node', 'index.js', '--resume', SESSION, '--attach-session', 'other'],
    ];
    expect(await mirrored(SESSION, lister)).toBe(false);
  });

  it('is false for an empty session id', async () => {
    const lister = async () => [['node', '--attach-session', '']];
    expect(await mirrored('', lister)).toBe(false);
  });

  it('answers false rather than throwing when the lister fails', async () => {
    const lister = async (): Promise<ProcessEntry[]> => {
      throw new Error('EACCES');
    };
    expect(await isSessionMirrored(SESSION, lister, livePty)).toBe(false);
  });

  describe('a match counts only while its fd 0 is a live terminal (issue #207)', () => {
    const one = async () => procs(attach(SESSION));
    const stdin =
      (target: string | undefined): StdinTargetReader =>
      async () =>
        target;

    it('counts a live pty', async () => {
      expect(await isSessionMirrored(SESSION, one, stdin('/dev/pts/7'))).toBe(
        true,
      );
    });

    it('counts a virtual console tty', async () => {
      expect(await isSessionMirrored(SESSION, one, stdin('/dev/tty1'))).toBe(
        true,
      );
    });

    it('ignores a pty that was deleted when its tab closed', async () => {
      expect(
        await isSessionMirrored(SESSION, one, stdin('/dev/pts/7 (deleted)')),
      ).toBe(false);
    });

    it('ignores a process whose stdin is /dev/null', async () => {
      expect(await isSessionMirrored(SESSION, one, stdin('/dev/null'))).toBe(
        false,
      );
    });

    it('ignores a pipe or a file on stdin', async () => {
      expect(
        await isSessionMirrored(SESSION, one, stdin('pipe:[123456]')),
      ).toBe(false);
      expect(
        await isSessionMirrored(SESSION, one, stdin('/home/evan/in.txt')),
      ).toBe(false);
    });

    it('ignores a process whose fd 0 cannot be read (gone mid-scan)', async () => {
      expect(await isSessionMirrored(SESSION, one, stdin(undefined))).toBe(
        false,
      );
      const throws: StdinTargetReader = async () => {
        throw new Error('ESRCH');
      };
      expect(await isSessionMirrored(SESSION, one, throws)).toBe(false);
    });

    it('keeps looking past a dead match to a live one', async () => {
      const targets = new Map<number, string>([
        [1000, '/dev/pts/7 (deleted)'],
        [1001, '/dev/pts/9'],
      ]);
      const two = async () => procs(attach(SESSION), attach(SESSION));
      expect(
        await isSessionMirrored(SESSION, two, async (pid) => targets.get(pid)),
      ).toBe(true);
    });

    it('does not read fd 0 of a process that does not match', async () => {
      let reads = 0;
      const counting: StdinTargetReader = async () => {
        reads++;
        return '/dev/pts/1';
      };
      await isSessionMirrored(
        SESSION,
        async () => procs(['bash'], attach('other')),
        counting,
      );
      expect(reads).toBe(0);
    });
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
      expect(await readProcEntries(root)).toEqual([
        {
          pid: 101,
          argv: ['node', 'index.js', '--attach-session', SESSION],
        },
      ]);
      expect(
        await isSessionMirrored(SESSION, () => readProcEntries(root), livePty),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns an empty list when the directory cannot be read', async () => {
    expect(await readProcArgv('/nonexistent-proc-dir')).toEqual([]);
  });
});

describe('readStdinTarget', () => {
  it('reads the link fd 0 points at, and undefined when it cannot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rc-proc-'));
    try {
      await mkdir(join(root, '201', 'fd'), { recursive: true });
      await symlink('/dev/pts/4 (deleted)', join(root, '201', 'fd', '0'));
      const read = readStdinTarget(root);
      expect(await read(201)).toBe('/dev/pts/4 (deleted)');
      expect(await read(202)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('isLiveTerminalTarget', () => {
  it.each([
    ['/dev/pts/0', true],
    ['/dev/pts/123', true],
    ['/dev/tty', true],
    ['/dev/tty1', true],
    ['/dev/ttyS0', true],
    ['/dev/pts/0 (deleted)', false],
    ['/dev/null', false],
    ['/dev/ptmx', false],
    ['/dev/pts/', false],
    ['pipe:[1]', false],
    ['socket:[2]', false],
    ['', false],
    [undefined, false],
  ])('%s -> %s', (target, expected) => {
    expect(isLiveTerminalTarget(target)).toBe(expected);
  });
});
