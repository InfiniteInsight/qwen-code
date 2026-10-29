/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSocket } from 'node:dgram';
import { browseDaemons, type BonjourBrowserLike } from './browser.js';
import type { RawBrowseService } from './advert.js';

function fakeBonjour(services: RawBrowseService[]) {
  const calls = { find: 0, stop: 0, destroy: 0 };
  const bonjour: BonjourBrowserLike = {
    find: (opts, onUp) => {
      calls.find++;
      expect(opts.type).toBe('qwen-rc');
      // Emit all known services synchronously via the callback.
      for (const s of services) onUp?.(s);
      return {
        on: () => {},
        stop: () => {
          calls.stop++;
        },
      };
    },
    destroy: () => {
      calls.destroy++;
    },
  };
  return { bonjour, calls };
}

const svc = (over: Partial<RawBrowseService> = {}): RawBrowseService => {
  const name = over.name ?? 'kitchen-app';
  return {
    name,
    host: 'kitchen.local',
    port: 7070,
    txt: { version: '1', name, workspace: 'app', tlsRequired: 'true' },
    ...over,
  };
};

describe('browseDaemons', () => {
  it('collects, normalizes, dedupes and sorts within the timeout', async () => {
    const fb = fakeBonjour([
      svc({ name: 'z', host: 'z.local', port: 2 }),
      svc({ name: 'a', host: 'a.local', port: 9 }),
      svc({
        name: 'z',
        host: 'z.local',
        port: 2,
        txt: { version: '2', name: 'z', workspace: 'app', tlsRequired: 'true' },
      }), // same daemon seen again → latest wins
    ]);
    const records = await browseDaemons({
      factory: () => fb.bonjour,
      timeoutMs: 10,
      wait: () => Promise.resolve(),
    });
    expect(records.map((r) => r.name)).toEqual(['a', 'z']);
    expect(records.find((r) => r.name === 'z')?.version).toBe('2');
    expect(fb.calls.find).toBe(1);
    expect(fb.calls.destroy).toBe(1); // socket torn down after the window
  });

  it('returns [] and still tears down when nothing advertises', async () => {
    const fb = fakeBonjour([]);
    const records = await browseDaemons({
      factory: () => fb.bonjour,
      timeoutMs: 5,
      wait: () => Promise.resolve(),
    });
    expect(records).toEqual([]);
    expect(fb.calls.destroy).toBe(1);
  });

  it('drops services with no usable host', async () => {
    const fb = fakeBonjour([
      svc({ name: 'ok' }),
      svc({ name: 'bad', host: undefined, addresses: [] }),
    ]);
    const records = await browseDaemons({
      factory: () => fb.bonjour,
      timeoutMs: 5,
      wait: () => Promise.resolve(),
    });
    expect(records.map((r) => r.name)).toEqual(['ok']);
  });
});

// #155: a socket error during a browse (GET /rc/peers, `daemons discover`)
// was an uncaught exception from bonjour-service's multicast-dns emitter.
describe('browseDaemons socket errors', () => {
  it('rejects with the socket error instead of throwing it uncaught, and tears down', async () => {
    const fb = fakeBonjour([]);
    const mdns = new EventEmitter();
    let release: () => void = () => {};
    const wait = () => new Promise<void>((r) => (release = r));
    const browse = browseDaemons({
      factory: () => ({ ...fb.bonjour, server: { mdns } }),
      timeoutMs: 5000,
      wait,
    });
    const bindFailure = Object.assign(new Error('bind EACCES 0.0.0.0:5353'), {
      code: 'EACCES',
    });
    expect(() => mdns.emit('error', bindFailure)).not.toThrow();
    await expect(browse).rejects.toThrow('EACCES');
    expect(fb.calls.destroy).toBe(1);
    expect(fb.calls.stop).toBe(1);
    // An error after the browse settled is absorbed too.
    expect(() => mdns.emit('error', bindFailure)).not.toThrow();
    release();
  });

  it('rejects when the constructor error callback fires', async () => {
    const fb = fakeBonjour([]);
    let onError: ((err: Error) => void) | undefined;
    const browse = browseDaemons({
      factory: (cb) => {
        onError = cb;
        return fb.bonjour;
      },
      timeoutMs: 5000,
      wait: () => new Promise<void>(() => {}),
    });
    expect(onError).toBeTypeOf('function');
    onError!(new Error('send EPERM'));
    await expect(browse).rejects.toThrow('EPERM');
  });
});

const RealBonjour = await import('bonjour-service').then(
  (m) => m.Bonjour,
  () => undefined,
);

describe.skipIf(!RealBonjour)('browseDaemons with bonjour-service', () => {
  it('a real bind failure rejects the browse, never exits', async () => {
    const blocker = createSocket({ type: 'udp4', reuseAddr: false });
    await new Promise<void>((r) => blocker.bind(0, '0.0.0.0', () => r()));
    try {
      await expect(
        browseDaemons({
          factory: (onError) =>
            new RealBonjour!(
              { port: blocker.address().port, reuseAddr: false } as never,
              onError,
            ) as unknown as BonjourBrowserLike,
          timeoutMs: 5000,
        }),
      ).rejects.toThrow('EADDRINUSE');
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
