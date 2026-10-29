/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { DnsChallengeHandle, DnsProvider } from './dnsProvider.js';

/**
 * A stand-in for the optional `acme-client` (not installed here) whose
 * `auto()` does what the real one does for `example.com` + `*.example.com`:
 * two dns-01 authorizations that share one identifier, presented together
 * and removed afterwards, each with its own key authorization.
 */
vi.mock('acme-client', async () => {
  const { GW_TEST_LEAF_CERT } = await import(
    '../../testing/tlsChainFixture.js'
  );
  type Fn = (
    a: { identifier: { value: string }; wildcard?: boolean },
    c: { type: string },
    k: string,
  ) => Promise<void>;
  return {
    Client: class {
      async auto(opts: { challengeCreateFn: Fn; challengeRemoveFn: Fn }) {
        const apex = { identifier: { value: 'qwen.example.com' } };
        const wild = {
          identifier: { value: 'qwen.example.com' },
          wildcard: true,
        };
        const ch = { type: 'dns-01' };
        await Promise.all([
          opts.challengeCreateFn(apex, ch, 'ka-apex'),
          opts.challengeCreateFn(wild, ch, 'ka-wildcard'),
        ]);
        await opts.challengeRemoveFn(apex, ch, 'ka-apex');
        await opts.challengeRemoveFn(wild, ch, 'ka-wildcard');
        return GW_TEST_LEAF_CERT;
      }
    },
    crypto: {
      createPrivateKey: async () => Buffer.from('account'),
      createCsr: async () => [Buffer.from('cert-key'), Buffer.from('csr')],
    },
  };
});

describe('#165 apex and wildcard challenges keep separate bookkeeping', () => {
  it('each presented record is cleaned up exactly once', async () => {
    const { createAcmeClient } = await import('./acmeClient.js');
    const presented: string[] = [];
    const cleaned: string[] = [];
    const provider: DnsProvider = {
      name: 'fake',
      async present(r) {
        presented.push(r.value);
        return { ...r } as DnsChallengeHandle;
      },
      async cleanup(h) {
        cleaned.push(h.value);
      },
    };
    const client = await createAcmeClient();
    await client.obtainCertificate(
      {
        domains: ['qwen.example.com', '*.qwen.example.com'],
        email: 'me@example.com',
        directoryUrl: 'https://acme.example/dir',
        accountKeyPem: 'pem',
      },
      provider,
    );
    expect(presented.sort()).toEqual(['ka-apex', 'ka-wildcard']);
    expect(cleaned.sort()).toEqual(['ka-apex', 'ka-wildcard']);
  });
});
