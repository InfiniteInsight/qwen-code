/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AWS Route53 DNS-01 solver. `present` UPSERTs the `_acme-challenge` TXT record
 * into the hosted zone and waits until Route53 reports the change `INSYNC` — its
 * authoritative "fully propagated" signal, so the CA can validate immediately
 * with no extra DNS polling. `cleanup` DELETEs it (best-effort).
 *
 * The Route53 API is taken as an injectable {@link Route53Client} so the solver's
 * logic is unit-tested with no AWS. The real client ({@link createRoute53Client})
 * wraps the OPTIONAL, lazily-loaded `@aws-sdk/client-route-53`.
 */
import type {
  DnsProvider,
  DnsChallengeRecord,
  DnsChallengeHandle,
} from '../dnsProvider.js';

/** A single TXT change the provider asks the Route53 API to apply. */
export interface Route53ChangeInput {
  hostedZoneId: string;
  action: 'UPSERT' | 'DELETE';
  /** Record name (FQDN), e.g. `_acme-challenge.qwen.example.com`. */
  name: string;
  /**
   * Every raw TXT value of the record set: what an UPSERT sets it to, or
   * what a DELETE removes (Route53 requires a DELETE to name the current set
   * exactly). The client quotes each as Route53 requires.
   */
  values: string[];
  ttl: number;
}

/** The minimal Route53 surface the solver needs (the real impl wraps the SDK). */
export interface Route53Client {
  changeTxtRecord(input: Route53ChangeInput): Promise<{ changeId: string }>;
  getChangeStatus(changeId: string): Promise<'PENDING' | 'INSYNC'>;
}

export interface Route53ProviderOptions {
  client: Route53Client;
  /** The hosted zone id that owns the challenge domain (env-supplied). */
  hostedZoneId: string;
  /** TTL for the challenge record (default 60s — it's short-lived). */
  ttl?: number;
  /** INSYNC poll interval (default 2s). */
  pollIntervalMs?: number;
  /** Max time to wait for INSYNC before failing (default 120s). */
  maxWaitMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULTS = { ttl: 60, pollIntervalMs: 2000, maxWaitMs: 120_000 };

export class Route53DnsProvider implements DnsProvider {
  readonly name = 'route53';

  /**
   * Challenge values this provider currently has live, per record name
   * (#165). `example.com` and `*.example.com` are validated through the
   * SAME name, `_acme-challenge.example.com`, with different values, and an
   * UPSERT replaces the whole record set: writing one value at a time made
   * the wildcard's write erase the apex's while the CA was still checking it.
   */
  private readonly live = new Map<string, string[]>();
  /** Per-name queue, so each change is built from the set the last one left. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly opts: Route53ProviderOptions) {}

  async present(record: DnsChallengeRecord): Promise<DnsChallengeHandle> {
    const zone = this.opts.hostedZoneId;
    const changeId = await this.serialized(record.fqdn, async () => {
      const values = [
        ...(this.live.get(record.fqdn) ?? []).filter((v) => v !== record.value),
        record.value,
      ];
      const res = await this.opts.client.changeTxtRecord({
        hostedZoneId: zone,
        action: 'UPSERT',
        name: record.fqdn,
        values,
        ttl: this.opts.ttl ?? DEFAULTS.ttl,
      });
      this.live.set(record.fqdn, values);
      return res.changeId;
    });
    // Outside the queue: Route53 applies changes in submission order, and a
    // later change only adds to this value, so waiting here need not hold
    // up the other challenge's write.
    await this.waitInSync(changeId);
    return {
      ...record,
      hostedZoneId: zone,
      changeId,
    };
  }

  async cleanup(handle: DnsChallengeHandle): Promise<void> {
    await this.serialized(handle.fqdn, async () => {
      const current = this.live.get(handle.fqdn) ?? [handle.value];
      const rest = current.filter((v) => v !== handle.value);
      try {
        await this.opts.client.changeTxtRecord({
          hostedZoneId: String(
            handle['hostedZoneId'] ?? this.opts.hostedZoneId,
          ),
          // Another challenge still uses the name: keep its value.
          action: rest.length > 0 ? 'UPSERT' : 'DELETE',
          name: handle.fqdn,
          values: rest.length > 0 ? rest : [handle.value],
          ttl: this.opts.ttl ?? DEFAULTS.ttl,
        });
      } catch {
        // Best-effort: a missing record (already gone) must not surface. Cleanup
        // runs after an order completes OR fails, and must never mask the cause.
      } finally {
        if (rest.length > 0) this.live.set(handle.fqdn, rest);
        else this.live.delete(handle.fqdn);
      }
    });
  }

  /** Run `fn` after every earlier change to `name` has been submitted. */
  private async serialized<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(name) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => mine);
    this.queues.set(name, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.queues.get(name) === tail) this.queues.delete(name);
    }
  }

  private async waitInSync(changeId: string): Promise<void> {
    const sleep =
      this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = this.opts.now ?? (() => Date.now());
    const deadline = now() + (this.opts.maxWaitMs ?? DEFAULTS.maxWaitMs);
    const interval = this.opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    for (;;) {
      const status = await this.opts.client.getChangeStatus(changeId);
      if (status === 'INSYNC') return;
      if (now() >= deadline) {
        throw new Error(
          `route53: change ${changeId} did not reach INSYNC before timeout`,
        );
      }
      await sleep(interval);
    }
  }
}

/** Minimal structural view of the AWS SDK pieces we use (optional dep). */
interface AwsRoute53Sdk {
  Route53Client: new (cfg: { region?: string }) => {
    send(command: unknown): Promise<unknown>;
  };
  ChangeResourceRecordSetsCommand: new (input: unknown) => unknown;
  GetChangeCommand: new (input: unknown) => unknown;
}

/**
 * Build a {@link Route53Client} backed by the OPTIONAL `@aws-sdk/client-route-53`,
 * loaded lazily so it's only required when `--acme-dns-provider route53` is used.
 * A non-literal specifier keeps the optional dep out of the type graph (the base
 * install needs no AWS SDK). Credentials/region resolve via the standard AWS chain
 * (`AWS_*` env or instance role).
 */
export async function createRoute53Client(
  opts: { region?: string } = {},
): Promise<Route53Client> {
  const specifier = '@aws-sdk/client-route-53';
  let sdk: AwsRoute53Sdk;
  try {
    sdk = (await import(specifier)) as unknown as AwsRoute53Sdk;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'MODULE_NOT_FOUND' ||
      /client-route-53/.test(String((err as Error).message))
    ) {
      throw new Error(
        'route53 DNS provider needs the optional @aws-sdk/client-route-53 ' +
          'dependency — run: npm install @aws-sdk/client-route-53',
      );
    }
    throw err;
  }
  const client = new sdk.Route53Client(
    opts.region ? { region: opts.region } : {},
  );
  return {
    async changeTxtRecord({ hostedZoneId, action, name, values, ttl }) {
      const res = (await client.send(
        new sdk.ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            Changes: [
              {
                Action: action,
                ResourceRecordSet: {
                  Name: name,
                  Type: 'TXT',
                  TTL: ttl,
                  // Route53 requires TXT values double-quoted.
                  ResourceRecords: values.map((v) => ({ Value: `"${v}"` })),
                },
              },
            ],
          },
        }),
      )) as { ChangeInfo?: { Id?: string } };
      return { changeId: res.ChangeInfo?.Id ?? '' };
    },
    async getChangeStatus(changeId) {
      const res = (await client.send(
        new sdk.GetChangeCommand({ Id: changeId }),
      )) as { ChangeInfo?: { Status?: string } };
      return res.ChangeInfo?.Status === 'INSYNC' ? 'INSYNC' : 'PENDING';
    },
  };
}
