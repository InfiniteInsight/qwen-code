/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Route53DnsProvider,
  type Route53Client,
  type Route53ChangeInput,
} from './route53.js';

function fakeClient(statuses: Array<'PENDING' | 'INSYNC'> = ['INSYNC']) {
  const changes: Route53ChangeInput[] = [];
  let i = 0;
  const client: Route53Client & { changes: Route53ChangeInput[] } = {
    changes,
    async changeTxtRecord(input) {
      changes.push(input);
      return { changeId: '/change/C123' };
    },
    async getChangeStatus() {
      return statuses[Math.min(i++, statuses.length - 1)];
    },
  };
  return client;
}

const record = {
  fqdn: '_acme-challenge.qwen.example.com',
  value: 'tok-value',
};

describe('Route53DnsProvider', () => {
  it('UPSERTs the TXT record, waits for INSYNC, returns a cleanup handle', async () => {
    const client = fakeClient(['PENDING', 'INSYNC']);
    const sleep = vi.fn(async () => {});
    const provider = new Route53DnsProvider({
      client,
      hostedZoneId: 'Z1',
      sleep,
    });

    const handle = await provider.present(record);

    expect(client.changes[0]).toEqual({
      hostedZoneId: 'Z1',
      action: 'UPSERT',
      name: record.fqdn,
      values: [record.value],
      ttl: 60,
    });
    expect(handle).toMatchObject({
      fqdn: record.fqdn,
      value: record.value,
      hostedZoneId: 'Z1',
      changeId: '/change/C123',
    });
    expect(sleep).toHaveBeenCalledTimes(1); // polled once on PENDING, then INSYNC
  });

  it('DELETEs the record on cleanup', async () => {
    const client = fakeClient();
    const provider = new Route53DnsProvider({
      client,
      hostedZoneId: 'Z1',
      sleep: async () => {},
    });
    const handle = await provider.present(record);
    await provider.cleanup(handle);
    expect(client.changes[1]).toEqual({
      hostedZoneId: 'Z1',
      action: 'DELETE',
      name: record.fqdn,
      values: [record.value],
      ttl: 60,
    });
  });

  it('cleanup is best-effort: never throws even if the API errors', async () => {
    const client: Route53Client = {
      async changeTxtRecord() {
        throw new Error('boom');
      },
      async getChangeStatus() {
        return 'INSYNC';
      },
    };
    const provider = new Route53DnsProvider({ client, hostedZoneId: 'Z1' });
    await expect(
      provider.cleanup({
        fqdn: 'x',
        value: 'y',
        hostedZoneId: 'Z1',
        changeId: 'c',
      }),
    ).resolves.toBeUndefined();
  });

  it('throws if the change never reaches INSYNC before the deadline', async () => {
    const client = fakeClient(['PENDING']);
    let t = 0;
    const provider = new Route53DnsProvider({
      client,
      hostedZoneId: 'Z1',
      sleep: async () => {},
      now: () => (t += 1000),
      maxWaitMs: 2500,
      pollIntervalMs: 1000,
    });
    await expect(provider.present(record)).rejects.toThrow(/INSYNC/);
  });
});

describe('#165 apex plus wildcard share one challenge name', () => {
  /**
   * Route53's own semantics for one TXT name: an UPSERT replaces the whole
   * record set, and a DELETE must name the current set exactly or it fails.
   * Reads either the old single `value` or a `values` list, so the same test
   * runs against both shapes of the client input.
   */
  function rrsetClient(latencyMs: (n: number) => number = () => 0) {
    const sets = new Map<string, string[]>();
    let n = 0;
    const client: Route53Client & { sets: Map<string, string[]> } = {
      sets,
      async changeTxtRecord(input) {
        const raw = input as Route53ChangeInput & {
          value?: string;
          values?: string[];
        };
        const vals = raw.values ?? (raw.value !== undefined ? [raw.value] : []);
        await new Promise((r) => setTimeout(r, latencyMs(n++)));
        if (input.action === 'UPSERT') {
          sets.set(input.name, [...vals]);
        } else {
          const cur = sets.get(input.name) ?? [];
          const same =
            cur.length === vals.length && cur.every((v) => vals.includes(v));
          if (!same) throw new Error('InvalidChangeBatch: values do not match');
          sets.delete(input.name);
        }
        return { changeId: `/change/${n}` };
      },
      async getChangeStatus() {
        return 'INSYNC';
      },
    };
    return client;
  }
  const fqdn = '_acme-challenge.qwen.example.com';

  it('both values are live at once while the CA validates', async () => {
    // The apex's write lands after the wildcard's, as concurrent API calls can.
    const client = rrsetClient((i) => (i === 0 ? 20 : 0));
    const provider = new Route53DnsProvider({
      client,
      hostedZoneId: 'Z1',
      sleep: async () => {},
    });
    await Promise.all([
      provider.present({ fqdn, value: 'apex-token' }),
      provider.present({ fqdn, value: 'wildcard-token' }),
    ]);
    expect([...(client.sets.get(fqdn) ?? [])].sort()).toEqual([
      'apex-token',
      'wildcard-token',
    ]);
  });

  it('cleaning one up keeps the other, and the last one removes the record', async () => {
    const client = rrsetClient();
    const provider = new Route53DnsProvider({
      client,
      hostedZoneId: 'Z1',
      sleep: async () => {},
    });
    const a = await provider.present({ fqdn, value: 'apex-token' });
    const w = await provider.present({ fqdn, value: 'wildcard-token' });
    await provider.cleanup(a);
    expect(client.sets.get(fqdn)).toEqual(['wildcard-token']);
    await provider.cleanup(w);
    expect(client.sets.has(fqdn)).toBe(false);
  });
});
