/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import {
  DEFAULT_PUSH_HOST_SUFFIXES,
  PushEndpointPolicy,
  createGuardedLookup,
  isPublicAddress,
  parsePushHostsEnv,
  type ResolvedAddress,
} from './endpointPolicy.js';

const PUBLIC = [{ address: '142.250.80.10', family: 4 }];
const resolveTo =
  (addrs: ResolvedAddress[]) => async (): Promise<ResolvedAddress[]> =>
    addrs;

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.100',
    '169.254.169.254',
    '100.64.0.1',
    '100.101.102.103',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2001:db8::1',
    'ff02::1',
    'not-an-ip',
  ])('%s is not public', (a) => {
    expect(isPublicAddress(a)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '142.250.80.10',
    '172.32.0.1',
    '2607:f8b0:4004:800::200a',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('%s is public', (a) => {
    expect(isPublicAddress(a)).toBe(true);
  });
});

describe('PushEndpointPolicy.checkStatic', () => {
  const p = new PushEndpointPolicy({ resolve: resolveTo(PUBLIC) });

  it('accepts a real FCM, Mozilla, Apple and WNS endpoint', () => {
    for (const ep of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://web.push.apple.com/QGx',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      expect(p.checkStatic(ep)).toMatchObject({ ok: true });
    }
  });

  it.each([
    ['http://fcm.googleapis.com/fcm/send/x', 'not_https'],
    ['https://user:pw@fcm.googleapis.com/x', 'credentials'],
    ['https://fcm.googleapis.com:8443/x', 'port'],
    ['https://internal-host:8443/x', 'port'],
    ['https://internal-host/x', 'host_not_allowed'],
    ['https://evilfcm.googleapis.com.attacker.net/x', 'host_not_allowed'],
    ['https://notfcm.googleapis.com/x', 'host_not_allowed'],
    ['https://10.0.0.5/x', 'non_public_address'],
    ['https://[::1]/x', 'non_public_address'],
    ['https://0x7f.1/x', 'non_public_address'],
    ['https://8.8.8.8/x', 'host_not_allowed'],
    ['not a url', 'bad_url'],
    ['', 'bad_url'],
  ])('%s is refused as %s', (ep, reason) => {
    expect(p.checkStatic(ep)).toEqual({ ok: false, reason });
  });

  it('refuses an endpoint over the length bound', () => {
    const ep = 'https://fcm.googleapis.com/' + 'a'.repeat(4096);
    expect(p.checkStatic(ep)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('with the allowlist off still refuses private literals but takes public ones', () => {
    const open = new PushEndpointPolicy({ allowedHostSuffixes: null });
    expect(open.checkStatic('https://192.168.1.1/x')).toEqual({
      ok: false,
      reason: 'non_public_address',
    });
    expect(open.checkStatic('https://8.8.8.8/x')).toMatchObject({ ok: true });
    expect(open.checkStatic('https://push.example.net/x')).toMatchObject({
      ok: true,
    });
  });

  it('defaults to the known Web Push services', () => {
    expect(p.allowedHostSuffixes).toEqual(DEFAULT_PUSH_HOST_SUFFIXES);
  });
});

describe('PushEndpointPolicy.check (registration, with DNS)', () => {
  it('refuses an allowed name that resolves to a private address', async () => {
    const p = new PushEndpointPolicy({
      allowedHostSuffixes: null,
      resolve: resolveTo([{ address: '10.0.0.5', family: 4 }]),
    });
    expect(await p.check('https://rebind.example.net/x')).toEqual({
      ok: false,
      reason: 'non_public_address',
    });
  });

  it('refuses when ANY resolved address is private', async () => {
    const p = new PushEndpointPolicy({
      resolve: resolveTo([
        { address: '142.250.80.10', family: 4 },
        { address: '::1', family: 6 },
      ]),
    });
    expect(await p.check('https://fcm.googleapis.com/fcm/send/x')).toEqual({
      ok: false,
      reason: 'non_public_address',
    });
  });

  it('refuses an unresolvable or slow host', async () => {
    const fails = new PushEndpointPolicy({
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(await fails.check('https://fcm.googleapis.com/x')).toEqual({
      ok: false,
      reason: 'unresolvable',
    });
    const slow = new PushEndpointPolicy({
      resolve: () => new Promise(() => {}),
      resolveTimeoutMs: 10,
    });
    expect(await slow.check('https://fcm.googleapis.com/x')).toEqual({
      ok: false,
      reason: 'unresolvable',
    });
  });

  it('accepts an allowed host that resolves publicly', async () => {
    const p = new PushEndpointPolicy({ resolve: resolveTo(PUBLIC) });
    expect(await p.check('https://fcm.googleapis.com/fcm/send/x')).toEqual({
      ok: true,
      hostname: 'fcm.googleapis.com',
    });
  });
});

describe('createGuardedLookup (send-time, connect-time guard)', () => {
  function run(
    addrs: ResolvedAddress[],
    options: { all?: boolean; family?: number } = {},
  ): Promise<{ err: unknown; args: unknown[] }> {
    const lookup = createGuardedLookup((_h, cb) => cb(null, addrs));
    return new Promise((resolve) => {
      (lookup as unknown as (...a: unknown[]) => void)(
        'fcm.googleapis.com',
        options,
        (err: unknown, ...args: unknown[]) => resolve({ err, args }),
      );
    });
  }

  it('fails the connection when the name now resolves privately (rebinding)', async () => {
    const { err } = await run([{ address: '127.0.0.1', family: 4 }]);
    expect((err as { code?: string }).code).toBe('EPUSHNONPUBLIC');
  });

  it('a real https request through an agent with the guarded lookup never connects to loopback', async () => {
    const agent = new HttpsAgent({
      lookup: createGuardedLookup((_h, cb) =>
        cb(null, [{ address: '127.0.0.1', family: 4 }]),
      ),
    });
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const req = httpsRequest(
        'https://rebound.push.example/',
        { agent, method: 'POST' },
        () => resolve(new Error('connected') as NodeJS.ErrnoException),
      );
      req.on('error', (e) => resolve(e as NodeJS.ErrnoException));
      req.end();
    });
    agent.destroy();
    expect(err.code).toBe('EPUSHNONPUBLIC');
  });

  it('passes a public address through in both lookup shapes', async () => {
    const one = await run(PUBLIC);
    expect(one.err).toBeNull();
    expect(one.args).toEqual(['142.250.80.10', 4]);
    const all = await run(PUBLIC, { all: true });
    expect(all.err).toBeNull();
    expect(all.args).toEqual([PUBLIC]);
  });
});

describe('parsePushHostsEnv', () => {
  it('reads a list, a wildcard, and treats blank as unset', () => {
    expect(parsePushHostsEnv(undefined)).toBeUndefined();
    expect(parsePushHostsEnv('  ')).toBeUndefined();
    expect(parsePushHostsEnv('*')).toBeNull();
    expect(
      parsePushHostsEnv(' .Push.Example.com., fcm.googleapis.com'),
    ).toEqual(['push.example.com', 'fcm.googleapis.com']);
  });
});
