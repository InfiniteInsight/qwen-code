/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonHandle } from './daemonSupervisor.js';

// cli.ts ends with a top level dispatch on process.argv, so pin argv away from
// every subcommand before the module is evaluated. Nothing here needs a boot to
// actually run; the pieces under test are pure.
process.argv[2] = '';
const {
  parseServeFlags,
  claimBootDaemon,
  releaseBootDaemon,
  stopBootOwnedDaemon,
  bootDaemonPoolOptions,
  resolveSessionWalDir,
  prepareSessionWalDir,
  formatSessionWalLine,
} = await import('./cli.js');

/** A handle that only records that it was stopped, plus a call counter. */
function fakeHandle(onStop?: () => Promise<void> | void): {
  handle: DaemonHandle;
  calls: () => number;
} {
  let n = 0;
  const handle = {
    attached: false,
    stop: async () => {
      n += 1;
      await onStop?.();
    },
  } as unknown as DaemonHandle;
  return { handle, calls: () => n };
}

describe('parseServeFlags', () => {
  it('reads the space and equals forms of the numeric flags', () => {
    expect(
      parseServeFlags(['--port', '8443', '--daemon-port=4180']),
    ).toMatchObject({ gatewayPort: 8443, daemonPort: 4180 });
  });

  it('leaves the ports unset when the flags are absent, so the defaults stand', () => {
    const opts = parseServeFlags(['--no-mdns']);
    expect(opts.gatewayPort).toBeUndefined();
    expect(opts.daemonPort).toBeUndefined();
    expect(opts.noMdns).toBe(true);
  });

  it('reads --host-actions in both forms, and leaves it unset so the default path stands', () => {
    expect(parseServeFlags(['--host-actions', '/x/a.json'])).toMatchObject({
      hostActionsPath: '/x/a.json',
    });
    expect(parseServeFlags(['--host-actions=/x/b.json'])).toMatchObject({
      hostActionsPath: '/x/b.json',
    });
    expect(parseServeFlags([]).hostActionsPath).toBeUndefined();
  });

  it('reads --qwen-bin in both forms and from QWEN_RC_QWEN_BIN, flag over env (daemon binary)', () => {
    expect(parseServeFlags([]).qwenBin).toBeUndefined();
    expect(parseServeFlags(['--qwen-bin', process.execPath]).qwenBin).toBe(
      process.execPath,
    );
    expect(parseServeFlags([`--qwen-bin=${process.execPath}`]).qwenBin).toBe(
      process.execPath,
    );
    const prior = process.env['QWEN_RC_QWEN_BIN'];
    try {
      process.env['QWEN_RC_QWEN_BIN'] = '/bin/sh';
      expect(parseServeFlags([]).qwenBin).toBe('/bin/sh');
      expect(parseServeFlags(['--qwen-bin', process.execPath]).qwenBin).toBe(
        process.execPath,
      );
      // An empty env value is the same as unset.
      process.env['QWEN_RC_QWEN_BIN'] = '';
      expect(parseServeFlags([]).qwenBin).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env['QWEN_RC_QWEN_BIN'];
      else process.env['QWEN_RC_QWEN_BIN'] = prior;
    }
  });

  it('keeps a bare --qwen-bin name for PATH resolution at boot', () => {
    expect(parseServeFlags(['--qwen-bin', 'qwen-dev']).qwenBin).toBe(
      'qwen-dev',
    );
  });

  it('fails fast on a --qwen-bin path that is missing or not executable', () => {
    expect(() => parseServeFlags(['--qwen-bin', '/nonexistent/qwen'])).toThrow(
      /--qwen-bin: "\/nonexistent\/qwen" does not exist/,
    );
    expect(() => parseServeFlags(['--qwen-bin', '/etc/hostname'])).toThrow(
      /--qwen-bin: .* is not executable/,
    );
    expect(() => parseServeFlags(['--qwen-bin'])).toThrow(/needs a path/);
    expect(() => parseServeFlags(['--qwen-bin', '--no-mdns'])).toThrow(
      /needs a path/,
    );
  });

  it('names the environment variable when the bad value came from it', () => {
    const prior = process.env['QWEN_RC_QWEN_BIN'];
    try {
      process.env['QWEN_RC_QWEN_BIN'] = '/nonexistent/qwen';
      expect(() => parseServeFlags([])).toThrow(
        /QWEN_RC_QWEN_BIN: "\/nonexistent\/qwen" does not exist/,
      );
    } finally {
      if (prior === undefined) delete process.env['QWEN_RC_QWEN_BIN'];
      else process.env['QWEN_RC_QWEN_BIN'] = prior;
    }
  });

  it('reads --max-attachment-bytes in both forms and from the environment (#196)', () => {
    expect(parseServeFlags(['--max-attachment-bytes', '1000'])).toMatchObject({
      maxAttachmentBytes: 1000,
    });
    expect(parseServeFlags(['--max-attachment-bytes=2000'])).toMatchObject({
      maxAttachmentBytes: 2000,
    });
    expect(parseServeFlags([]).maxAttachmentBytes).toBeUndefined();
    const prior = process.env['QWEN_RC_MAX_ATTACHMENT_BYTES'];
    try {
      process.env['QWEN_RC_MAX_ATTACHMENT_BYTES'] = '3000';
      expect(parseServeFlags([]).maxAttachmentBytes).toBe(3000);
      // The flag wins over the environment, like the other pairs.
      expect(parseServeFlags(['--max-attachment-bytes', '4000'])).toMatchObject(
        { maxAttachmentBytes: 4000 },
      );
    } finally {
      if (prior === undefined)
        delete process.env['QWEN_RC_MAX_ATTACHMENT_BYTES'];
      else process.env['QWEN_RC_MAX_ATTACHMENT_BYTES'] = prior;
    }
  });

  it('rejects a bad --max-attachment-bytes before anything is spawned (#196)', () => {
    for (const bad of ['0', '-1', 'abc', '104857601', '2.5']) {
      expect(() => parseServeFlags(['--max-attachment-bytes', bad])).toThrow(
        /--max-attachment-bytes/,
      );
    }
  });

  it('reads --wal-dir in both forms and from QWEN_RC_WAL_DIR, flag over env, and --no-wal (#174)', () => {
    expect(parseServeFlags(['--wal-dir', '/w/a'])).toMatchObject({
      walDir: '/w/a',
    });
    expect(parseServeFlags(['--wal-dir=/w/b'])).toMatchObject({
      walDir: '/w/b',
    });
    const priorDir = process.env['QWEN_RC_WAL_DIR'];
    const priorOff = process.env['QWEN_RC_NO_WAL'];
    try {
      delete process.env['QWEN_RC_WAL_DIR'];
      delete process.env['QWEN_RC_NO_WAL'];
      expect(parseServeFlags([]).walDir).toBeUndefined();
      expect(parseServeFlags([]).noWal).toBe(false);
      process.env['QWEN_RC_WAL_DIR'] = '/w/env';
      expect(parseServeFlags([]).walDir).toBe('/w/env');
      expect(parseServeFlags(['--wal-dir', '/w/flag']).walDir).toBe('/w/flag');
      expect(parseServeFlags(['--no-wal']).noWal).toBe(true);
      process.env['QWEN_RC_NO_WAL'] = '1';
      expect(parseServeFlags([]).noWal).toBe(true);
    } finally {
      if (priorDir === undefined) delete process.env['QWEN_RC_WAL_DIR'];
      else process.env['QWEN_RC_WAL_DIR'] = priorDir;
      if (priorOff === undefined) delete process.env['QWEN_RC_NO_WAL'];
      else process.env['QWEN_RC_NO_WAL'] = priorOff;
    }
    expect(() => parseServeFlags(['--wal-dir', ''])).toThrow(/--wal-dir/);
  });

  it('keeps 0 legal, because that is the pick a free port request', () => {
    expect(parseServeFlags(['--port', '0'])).toMatchObject({ gatewayPort: 0 });
  });

  // The bug: `Number('abc')` is NaN, which used to survive the whole boot and
  // only die at listen() with ERR_SOCKET_BAD_PORT, by which point the gateway had
  // already spawned a `qwen serve` it then abandoned on its port.
  it('rejects a non numeric port instead of carrying NaN into the boot', () => {
    expect(() => parseServeFlags(['--port', 'abc'])).toThrow(/--port/);
    expect(() => parseServeFlags(['--port', 'abc'])).toThrow(/got "abc"/);
    expect(() => parseServeFlags(['--daemon-port', '1e99'])).toThrow(
      /--daemon-port/,
    );
    expect(() => parseServeFlags(['--port', '70000'])).toThrow(/--port/);
  });
});

describe('boot daemon ownership', () => {
  it('stops the claimed daemon and clears the claim', async () => {
    const { handle, calls } = fakeHandle();
    claimBootDaemon(handle);
    expect(await stopBootOwnedDaemon(1000)).toBe(true);
    expect(calls()).toBe(1);
    // A second unwind must not stop it twice.
    expect(await stopBootOwnedDaemon(1000)).toBe(false);
    expect(calls()).toBe(1);
  });

  it('stops nothing once the signal handlers have taken the claim back', async () => {
    const { handle, calls } = fakeHandle();
    claimBootDaemon(handle);
    releaseBootDaemon();
    expect(await stopBootOwnedDaemon(1000)).toBe(false);
    expect(calls()).toBe(0);
  });

  it('survives a stop that throws, because this runs while the process is failing', async () => {
    const { handle, calls } = fakeHandle(() => {
      throw new Error('EIO on the deferred writeback');
    });
    claimBootDaemon(handle);
    expect(await stopBootOwnedDaemon(1000)).toBe(true);
    expect(calls()).toBe(1);
  });

  // A wedged daemon stop must not hold the exit hostage: without the bound this
  // await never settles and the gateway hangs instead of exiting 1.
  it('gives up on a wedged stop at the timeout', async () => {
    const { handle, calls } = fakeHandle(() => new Promise<void>(() => {}));
    claimBootDaemon(handle);
    const started = Date.now();
    expect(await stopBootOwnedDaemon(50)).toBe(true);
    expect(calls()).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('boot daemon pool options (#203)', () => {
  it('attach mode turns off the respawn of the default workspace daemon', () => {
    const { handle } = fakeHandle();
    const attached = { ...handle, attached: true } as DaemonHandle;
    expect(bootDaemonPoolOptions(attached)).toEqual({
      respawnDefaultDaemon: false,
    });
  });

  it('a daemon this gateway spawned is respawned after it dies, and the pool may stop it once replaced', () => {
    const { handle } = fakeHandle();
    expect(bootDaemonPoolOptions(handle)).toEqual({
      respawnDefaultDaemon: true,
      stopDefaultDaemon: handle.stop,
    });
  });
});

describe('session WAL directory (#174)', () => {
  it('defaults to ~/.qwen/rc/wal, takes --wal-dir (tilde too), and --no-wal turns it off', () => {
    expect(resolveSessionWalDir({}, '/h')).toBe(
      join('/h', '.qwen', 'rc', 'wal'),
    );
    expect(resolveSessionWalDir({ walDir: '/x/w' }, '/h')).toBe('/x/w');
    expect(resolveSessionWalDir({ walDir: '~/w' }, '/h')).toBe(join('/h', 'w'));
    expect(
      resolveSessionWalDir({ walDir: '/x/w', noWal: true }, '/h'),
    ).toBeUndefined();
  });

  it('creates the directory owner-only (0700), and accepts one that exists', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'rc-wal-dir-')), 'a', 'wal');
    prepareSessionWalDir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(() => prepareSessionWalDir(dir)).not.toThrow();
  });

  it('refuses a path that is not a directory before anything is spawned', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rc-wal-dir-')), 'f');
    writeFileSync(file, 'x');
    expect(() => prepareSessionWalDir(file)).toThrow(/--wal-dir/);
  });

  it('says at boot where the WAL lives, or that it is off', () => {
    expect(formatSessionWalLine('/h/.qwen/rc/wal')).toContain(
      '/h/.qwen/rc/wal',
    );
    expect(formatSessionWalLine(undefined)).toMatch(/off/);
  });
});
