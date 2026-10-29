/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CertStore, safeDirName, type CertBundle } from './certStore.js';
import { BIG, observeDuringWrite } from '../../testing/tornRead.js';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'acme-store-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const bundle: CertBundle = {
  cert: '-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----\n',
  privateKey: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
  chain: '-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----\n',
  meta: {
    domains: ['qwen.example.com'],
    notAfter: '2026-04-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
  },
};

describe('CertStore', () => {
  it('returns null when no bundle is stored', async () => {
    expect(await new CertStore(base).load('qwen.example.com')).toBeNull();
  });

  it('round-trips a saved bundle', async () => {
    const store = new CertStore(base);
    await store.save('qwen.example.com', bundle);
    expect(await store.load('qwen.example.com')).toEqual(bundle);
  });

  it('#165 a reader never sees a torn cert or key while a renewal is saved', async () => {
    const store = new CertStore(base);
    const old: CertBundle = { ...bundle, cert: 'a'.repeat(BIG.length) };
    const next: CertBundle = {
      ...bundle,
      cert: 'b'.repeat(BIG.length),
      meta: { ...bundle.meta, notAfter: '2026-07-01T00:00:00.000Z' },
    };
    await store.save('qwen.example.com', old);
    const certPath = join(base, 'qwen.example.com', 'cert.pem');
    const { reads, torn } = await observeDuringWrite(
      certPath,
      () => store.save('qwen.example.com', next),
      (text) => text === old.cert || text === next.cert,
    );
    expect(reads).toBeGreaterThan(0);
    expect(torn).toBe(0);
    expect(await store.load('qwen.example.com')).toEqual(next);
    expect((await readdir(join(base, 'qwen.example.com'))).sort()).toEqual([
      'cert.pem',
      'chain.pem',
      'meta.json',
      'privkey.pem',
    ]);
  });

  it('writes private material 0600 under a 0700 directory', async () => {
    const store = new CertStore(base);
    await store.save('qwen.example.com', bundle);
    const dir = join(base, 'qwen.example.com');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'privkey.pem'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'cert.pem'))).mode & 0o777).toBe(0o600);
  });

  it('slugs a wildcard domain into a safe dir name and still round-trips', async () => {
    const store = new CertStore(base);
    await store.save('*.example.com', bundle);
    expect(await store.load('*.example.com')).toEqual(bundle);
    // No raw '*' or traversal in the on-disk name.
    expect(safeDirName('*.example.com')).toBe('_.example.com');
    expect(safeDirName('../../etc')).not.toContain('..');
  });
});
