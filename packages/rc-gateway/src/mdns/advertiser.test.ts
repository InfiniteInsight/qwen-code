/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSocket } from 'node:dgram';
import {
  MdnsAdvertiser,
  MDNS_UNAVAILABLE_KEYWORD,
  type BonjourLike,
} from './advertiser.js';
import { buildTxtRecord } from './advert.js';

function fakeBonjour() {
  const calls = {
    publish: [] as unknown[],
    unpublishAll: 0,
    destroy: 0,
  };
  let unpublishCb: (() => void) | undefined;
  const bonjour: BonjourLike = {
    publish: (opts) => {
      calls.publish.push(opts);
      return { stop: () => {} };
    },
    unpublishAll: (cb) => {
      calls.unpublishAll++;
      unpublishCb = cb;
    },
    destroy: () => {
      calls.destroy++;
    },
  };
  return { bonjour, calls, fireUnpublish: () => unpublishCb?.() };
}

const TXT = buildTxtRecord({
  name: 'kitchen-app',
  workspace: 'app',
  tlsRequired: true,
});

describe('MdnsAdvertiser', () => {
  it('publishes once with the DNS-SD service type and a txt copy', () => {
    const fb = fakeBonjour();
    const a = new MdnsAdvertiser({
      instanceName: 'kitchen-app',
      port: 7070,
      txt: TXT,
      factory: () => fb.bonjour,
    });
    a.start();
    expect(a.advertising).toBe(true);
    expect(a.instanceName).toBe('kitchen-app');
    expect(fb.calls.publish).toHaveLength(1);
    expect(fb.calls.publish[0]).toMatchObject({
      name: 'kitchen-app',
      type: 'qwen-rc',
      port: 7070,
      txt: { version: '1', tlsRequired: 'true' },
    });
  });

  it('Goodbye: stop() unpublishes then destroys, resolving when the callback fires', async () => {
    const fb = fakeBonjour();
    const a = new MdnsAdvertiser({
      instanceName: 'n',
      port: 1,
      txt: TXT,
      factory: () => fb.bonjour,
    });
    a.start();
    const p = a.stop(500);
    fb.fireUnpublish(); // bonjour signals Goodbye packets sent
    await p;
    expect(fb.calls.unpublishAll).toBe(1);
    expect(fb.calls.destroy).toBe(1);
    expect(a.advertising).toBe(false);
  });

  it('stop() resolves on the timeout even if unpublish never calls back', async () => {
    vi.useFakeTimers();
    try {
      const fb = fakeBonjour();
      const a = new MdnsAdvertiser({
        instanceName: 'n',
        port: 1,
        txt: TXT,
        factory: () => fb.bonjour,
      });
      a.start();
      const p = a.stop(500);
      await vi.advanceTimersByTimeAsync(500);
      await p;
      expect(fb.calls.destroy).toBe(1); // destroyed after the bounded wait
    } finally {
      vi.useRealTimers();
    }
  });

  it('MDNS_UNAVAILABLE_KEYWORD is exactly "mdns_unavailable"', () => {
    expect(MDNS_UNAVAILABLE_KEYWORD).toBe('mdns_unavailable');
  });

  it('stop() is a no-op when never started, and idempotent', async () => {
    const fb = fakeBonjour();
    const a = new MdnsAdvertiser({
      instanceName: 'n',
      port: 1,
      txt: TXT,
      factory: () => fb.bonjour,
    });
    await a.stop(); // never started
    expect(fb.calls.destroy).toBe(0);
    a.start();
    await a.stop(0);
    await a.stop(0); // second stop does nothing
    expect(fb.calls.destroy).toBe(1);
  });
});

// #155: bonjour-service attaches no 'error' listener to its multicast-dns
// emitter, so a UDP 5353 bind failure was an uncaught exception that exited
// the gateway after start() had already returned normally.
describe('MdnsAdvertiser socket errors', () => {
  function fakeWithSocket() {
    const fb = fakeBonjour();
    const mdns = new EventEmitter();
    let onError: ((err: Error) => void) | undefined;
    const factory = (cb?: (err: Error) => void) => {
      onError = cb;
      return { ...fb.bonjour, server: { mdns } };
    };
    return { fb, mdns, factory, onError: () => onError };
  }

  it('a socket error disables advertising and logs instead of throwing', () => {
    const f = fakeWithSocket();
    const lines: string[] = [];
    const a = new MdnsAdvertiser({
      instanceName: 'n',
      port: 1,
      txt: TXT,
      factory: f.factory,
      log: (m) => lines.push(m),
    });
    a.start();
    const bindFailure = Object.assign(new Error('bind EACCES 0.0.0.0:5353'), {
      code: 'EACCES',
    });
    expect(() => f.mdns.emit('error', bindFailure)).not.toThrow();
    expect(a.advertising).toBe(false);
    expect(f.fb.calls.destroy).toBe(1);
    expect(lines.join('\n')).toContain('EACCES');
    // A second error from the same socket is absorbed, not re-handled.
    expect(() => f.mdns.emit('error', bindFailure)).not.toThrow();
    expect(f.fb.calls.destroy).toBe(1);
  });

  it('hands the factory an error callback that disables advertising too', () => {
    const f = fakeWithSocket();
    const a = new MdnsAdvertiser({
      instanceName: 'n',
      port: 1,
      txt: TXT,
      factory: f.factory,
      log: () => {},
    });
    a.start();
    expect(f.onError()).toBeTypeOf('function');
    f.onError()!(new Error('send EPERM'));
    expect(a.advertising).toBe(false);
  });
});

const RealBonjour = await import('bonjour-service').then(
  (m) => m.Bonjour,
  () => undefined,
);

/** A UDP port held exclusively, so a second bind on it fails EADDRINUSE. */
async function occupiedUdpPort() {
  const s = createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise<void>((r) => s.bind(0, '0.0.0.0', () => r()));
  return {
    port: s.address().port,
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
}

describe.skipIf(!RealBonjour)('MdnsAdvertiser with bonjour-service', () => {
  it('a real bind failure disables advertising and logs, never exits', async () => {
    const blocker = await occupiedUdpPort();
    const lines: string[] = [];
    const a = new MdnsAdvertiser({
      instanceName: 'crash-guard',
      port: 7070,
      txt: TXT,
      factory: (onError) =>
        new RealBonjour!(
          { port: blocker.port, reuseAddr: false } as never,
          onError,
        ) as unknown as BonjourLike,
      log: (m) => lines.push(m),
    });
    try {
      a.start();
      await vi.waitFor(() => expect(a.advertising).toBe(false), {
        timeout: 3000,
      });
      expect(lines.join('\n')).toContain('EADDRINUSE');
    } finally {
      await a.stop(0);
      await blocker.close();
    }
  });
});
