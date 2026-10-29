/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Orchestrates a domain's ACME cert lifecycle: load from the {@link CertBundleStore},
 * obtain via the {@link AcmeClient} (DNS-01) when absent or due, persist, and keep
 * a renewal loop running. Exposes the current bundle for the https server and an
 * `onChange` hook so a live cert swap (Slice 4 SNICallback) takes effect with no
 * restart.
 *
 * **Renewal scheduling — the load-bearing detail.** Node's `setTimeout` delay is a
 * 32-bit int (~24.8 days max); a larger delay silently clamps to ~1ms and fires
 * almost immediately. A fresh 90-day cert renews in ~60 days ≈ 5.2e9 ms — 2.4× the
 * cap — so arming one long timer would RE-ISSUE on every boot and trip Let's
 * Encrypt's duplicate-cert limit (a week-long lockout). Instead we **cap each sleep
 * at `maxTimerMs` (default 6h) and re-check on wake** — a poll loop, never one
 * multi-week timer.
 *
 * **Fail-safe.** A renewal failure with a still-valid current cert is non-fatal:
 * keep serving it, log, retry with capped backoff (LE has a failed-validation
 * limit too). Only a boot with NO usable cert (absent + obtain fails) is fatal.
 */
import { X509Certificate } from 'node:crypto';
import {
  shouldRenew,
  msUntilRenewal,
  renewBeforeDaysFor,
  DEFAULT_RENEW_BEFORE_DAYS,
} from './renewalSchedule.js';
import type { CertBundle } from './certStore.js';
import type { DnsProvider } from './dnsProvider.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A bundle's validity window (#165): from `meta.json`, or, for whichever end
 * the metadata lacks or cannot be parsed, from the leaf PEM itself. Either end
 * can still come back invalid (no metadata and no parseable cert); callers
 * treat an unreadable expiry as due.
 */
function validityOf(bundle: CertBundle): { notBefore: Date; notAfter: Date } {
  let notAfter = new Date(bundle.meta?.notAfter as string);
  let notBefore = new Date(bundle.meta?.issuedAt as string);
  if (Number.isNaN(notAfter.getTime()) || Number.isNaN(notBefore.getTime())) {
    try {
      const x509 = new X509Certificate(bundle.cert);
      if (Number.isNaN(notAfter.getTime())) notAfter = new Date(x509.validTo);
      if (Number.isNaN(notBefore.getTime())) {
        notBefore = new Date(x509.validFrom);
      }
    } catch {
      // Not a parseable certificate: leave the unreadable end invalid.
    }
  }
  return { notBefore, notAfter };
}

export interface AcmeIssuedCert {
  /** Leaf certificate, PEM. */
  cert: string;
  /** Issuer chain, PEM. */
  chain: string;
  /** Private key for the leaf, PEM. */
  privateKey: string;
  /** Parsed expiry (drives renewal). */
  notAfter: Date;
}

/** The ACME issuance surface the manager drives (real impl wraps `acme-client`). */
export interface AcmeClient {
  obtainCertificate(
    req: {
      domains: string[];
      email: string;
      directoryUrl: string;
      accountKeyPem: string;
    },
    provider: DnsProvider,
  ): Promise<AcmeIssuedCert>;
}

/** Minimal persistence surface (the concrete `CertStore` satisfies it). */
export interface CertBundleStore {
  load(primaryDomain: string): Promise<CertBundle | null>;
  save(primaryDomain: string, bundle: CertBundle): Promise<void>;
}

export interface AcmeManagerOptions {
  domains: string[];
  email: string;
  directoryUrl: string;
  provider: DnsProvider;
  client: AcmeClient;
  store: CertBundleStore;
  /** Load-or-create the ACME account key (PEM). Called once, then cached. */
  accountKey: () => Promise<string>;
  /**
   * Fixed renewal lead in days. Omitted (the normal case), the lead is
   * derived from each cert's own lifetime: a third of it, 1 to 30 days
   * (#165). A fixed value is still capped at half the cert's lifetime, so a
   * short-lived cert is never due the moment it is issued.
   */
  renewBeforeDays?: number;
  /** Per-sleep cap (default 6h). MUST stay under setTimeout's 2^31-1 ms limit. */
  maxTimerMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string) => void;
  onChange?: (bundle: CertBundle) => void;
}

const DEFAULT_MAX_TIMER_MS = 6 * 60 * 60 * 1000; // 6h ≪ 2_147_483_647
const DEFAULT_BASE_BACKOFF_MS = 5 * 60 * 1000; // 5m
const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000; // 1h

export class AcmeManager {
  private current: CertBundle | null = null;
  private accountKeyPem: string | null = null;
  private timer: unknown = null;
  private stopped = false;
  private backoffMs: number;

  constructor(private readonly opts: AcmeManagerOptions) {
    this.backoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  }

  /** The current cert bundle (null before {@link start}). */
  getCurrent(): CertBundle | null {
    return this.current;
  }

  /** Acquire-or-load the cert, then arm the renewal loop. Returns the live bundle. */
  async start(): Promise<CertBundle> {
    const stored = await this.opts.store.load(this.opts.domains[0]);
    if (stored && !this.isDue(stored)) {
      this.current = stored;
    } else {
      if (stored && !this.covers(stored)) {
        // #165: a domain was added to the configuration. The stored cert
        // does not name it, so a new order is due whatever its expiry says.
        this.log(
          `acme: configured domains (${this.opts.domains.join(', ')}) are not ` +
            `all covered by the stored cert ` +
            `(${(stored.meta?.domains ?? []).join(', ')}); ordering a new one`,
        );
      }
      try {
        await this.obtain();
      } catch (err) {
        const msg = errMsg(err);
        if (stored) {
          this.log(
            `acme: initial renewal failed; serving the stored cert ` +
              `(notAfter=${stored.meta.notAfter}) — ${msg}`,
          );
          this.current = stored;
        } else {
          throw new Error(
            `acme: could not obtain an initial certificate for ` +
              `${this.opts.domains[0]}: ${msg}`,
          );
        }
      }
    }
    this.scheduleNext();
    return this.current as CertBundle;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) {
      (this.opts.clearTimer ?? clearTimeout)(this.timer as never);
      this.timer = null;
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
  private maxTimer(): number {
    return this.opts.maxTimerMs ?? DEFAULT_MAX_TIMER_MS;
  }
  /** The renewal lead for this bundle, in days (#165: from its lifetime). */
  private renewDays(bundle: CertBundle): number {
    const { notBefore, notAfter } = validityOf(bundle);
    const lifetimeDays = (notAfter.getTime() - notBefore.getTime()) / DAY_MS;
    const known = Number.isFinite(lifetimeDays) && lifetimeDays > 0;
    if (this.opts.renewBeforeDays !== undefined) {
      return known
        ? Math.min(this.opts.renewBeforeDays, lifetimeDays / 2)
        : this.opts.renewBeforeDays;
    }
    return renewBeforeDaysFor(notBefore, notAfter) ?? DEFAULT_RENEW_BEFORE_DAYS;
  }
  private log(m: string): void {
    this.opts.log?.(m);
  }
  /** True when the bundle names every configured domain (case-insensitive). */
  private covers(bundle: CertBundle): boolean {
    const have = new Set(
      (bundle.meta?.domains ?? []).map((d) => String(d).toLowerCase()),
    );
    return this.opts.domains.every((d) => have.has(d.toLowerCase()));
  }
  /**
   * Due for a new order: inside its renewal window, expiry unreadable, or
   * missing a configured domain (#165).
   */
  private isDue(bundle: CertBundle): boolean {
    if (!this.covers(bundle)) return true;
    return shouldRenew(
      validityOf(bundle).notAfter,
      new Date(this.now()),
      this.renewDays(bundle),
    );
  }
  /** The current backoff delay, doubling the next one up to the cap. */
  private nextBackoff(): number {
    const retry = this.backoffMs;
    this.backoffMs = Math.min(
      this.backoffMs * 2,
      this.opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    );
    return retry;
  }

  private async resolveAccountKey(): Promise<string> {
    if (this.accountKeyPem == null) {
      this.accountKeyPem = await this.opts.accountKey();
    }
    return this.accountKeyPem;
  }

  private async obtain(): Promise<void> {
    const accountKeyPem = await this.resolveAccountKey();
    const issued = await this.opts.client.obtainCertificate(
      {
        domains: this.opts.domains,
        email: this.opts.email,
        directoryUrl: this.opts.directoryUrl,
        accountKeyPem,
      },
      this.opts.provider,
    );
    const bundle: CertBundle = {
      cert: issued.cert,
      chain: issued.chain,
      privateKey: issued.privateKey,
      meta: {
        domains: this.opts.domains,
        notAfter: issued.notAfter.toISOString(),
        issuedAt: new Date(this.now()).toISOString(),
      },
    };
    await this.opts.store.save(this.opts.domains[0], bundle);
    this.current = bundle;
    this.opts.onChange?.(bundle);
  }

  /**
   * Arm the next wake, capped at `maxTimerMs` so a multi-week delay never
   * clamps.
   *
   * Never a 0ms wake (#165). Every caller has just tried to obtain, or has
   * just found the cert fresh, so a cert that is still due here is one a
   * renewal did not fix: the order failed, or the CA handed back a cert
   * already inside its window. Re-arming at 0 re-ordered in a tight loop
   * (the probe saw 6 certs in 5 wakes), so that case waits the backoff, as a
   * failed renewal does.
   */
  private scheduleNext(retryAfterMs?: number): void {
    if (this.stopped || !this.current) return;
    let wait = retryAfterMs;
    if (wait === undefined) {
      const due = this.isDue(this.current)
        ? 0
        : msUntilRenewal(
            validityOf(this.current).notAfter,
            new Date(this.now()),
            this.renewDays(this.current),
          );
      if (due > 0) {
        wait = due;
      } else {
        wait = this.nextBackoff();
        this.log(
          `acme: certificate still due after a renewal attempt ` +
            `(notAfter=${this.current.meta?.notAfter}); next attempt in ${wait}ms`,
        );
      }
    }
    const delay = Math.max(0, Math.min(wait, this.maxTimer()));
    this.timer = (this.opts.setTimer ?? setTimeout)(() => this.onWake(), delay);
  }

  private async onWake(): Promise<void> {
    if (this.stopped || !this.current) return;
    if (!this.isDue(this.current)) {
      this.scheduleNext();
      return;
    }
    try {
      await this.obtain();
      this.backoffMs = this.opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
      this.scheduleNext();
    } catch (err) {
      this.log(
        `acme: renewal failed, keeping current cert ` +
          `(notAfter=${this.current.meta.notAfter}); retrying — ${errMsg(err)}`,
      );
      this.scheduleNext(this.nextBackoff());
    }
  }
}

function errMsg(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}
