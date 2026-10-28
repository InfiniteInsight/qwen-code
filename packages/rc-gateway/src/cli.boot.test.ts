/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
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
