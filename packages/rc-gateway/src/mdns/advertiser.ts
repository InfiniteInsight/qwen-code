/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thin wrapper around the optional `bonjour-service` library (add-mdns-discovery
 * D1). The bonjour instance is INJECTED via a factory so the publish/Goodbye
 * lifecycle is unit-tested against a fake — the live multicast publish is a
 * verification ceiling (needs a real LAN socket, frequently broken under WSL2).
 *
 * Goodbye (design D4): on shutdown we call `unpublishAll` (which sends Goodbye
 * packets) and wait up to `timeoutMs` for it before destroying the socket, so a
 * stale record does not haunt the LAN for the 75-minute mDNS TTL.
 */

import type { TxtRecord } from './advert.js';

/** The DNS-SD service type (library forms `_qwen-rc._tcp.local.` from this). */
export const QWEN_RC_SERVICE_TYPE = 'qwen-rc';

/**
 * Log keyword emitted (as a `console.warn` prefix) when the optional
 * `bonjour-service` package is not installed and mDNS advertisement is
 * silently skipped. Pinned to this exact string so monitors / grep-verify
 * tests can detect the condition without coupling to the full prose message.
 */
export const MDNS_UNAVAILABLE_KEYWORD = 'mdns_unavailable';

/** A published service handle (we only ever destroy via the parent instance). */
export interface BonjourServiceLike {
  stop?(cb?: () => void): void;
}

/** The `multicast-dns` emitter that `bonjour-service` keeps at `server.mdns`. */
export interface MdnsSocketLike {
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** Where `bonjour-service` keeps its socket (absent on test fakes). */
export interface HasMdnsSocket {
  server?: { mdns?: MdnsSocketLike };
}

/** The minimal `bonjour-service` surface we depend on. */
export interface BonjourLike extends HasMdnsSocket {
  publish(opts: {
    name: string;
    type: string;
    port: number;
    txt: Record<string, string>;
  }): BonjourServiceLike;
  unpublishAll(cb?: () => void): void;
  destroy(): void;
}

/**
 * Build a fresh instance. `onError` is for the constructor's error callback:
 * `bonjour-service` defaults it to `throw err`, which would be uncaught.
 */
export type BonjourFactory = (onError?: (err: Error) => void) => BonjourLike;

/**
 * Attach `onError` to the instance's multicast-dns emitter (#155).
 * `bonjour-service` attaches no `'error'` listener of its own, so a UDP 5353
 * bind failure (EADDRINUSE, EACCES) emitted there became an uncaught exception
 * that exited the process after `start()` had returned normally. Returns
 * whether a listener was attached (false for an instance without the socket).
 */
export function guardMdnsErrors(
  instance: HasMdnsSocket,
  onError: (err: Error) => void,
): boolean {
  const mdns = instance.server?.mdns;
  if (!mdns || typeof mdns.on !== 'function') return false;
  mdns.on('error', onError);
  return true;
}

export interface AdvertiserOptions {
  instanceName: string;
  port: number;
  txt: TxtRecord;
  factory: BonjourFactory;
  /** Where a socket failure is reported (default console.warn). */
  log?: (msg: string) => void;
}

export class MdnsAdvertiser {
  private bonjour: BonjourLike | undefined;
  private published = false;

  constructor(private readonly opts: AdvertiserOptions) {}

  get instanceName(): string {
    return this.opts.instanceName;
  }

  get advertising(): boolean {
    return this.published;
  }

  /** Register the service. Safe to call once. */
  start(): void {
    if (this.bonjour) return;
    // Bound to THIS instance, so a late error from a socket already torn down
    // cannot disable a later start(). Socket errors arrive asynchronously, after
    // `bonjour` is initialised.
    const onError = (err: Error) => this.fail(bonjour, err);
    const bonjour = this.opts.factory(onError);
    this.bonjour = bonjour;
    guardMdnsErrors(bonjour, onError);
    bonjour.publish({
      name: this.opts.instanceName,
      type: QWEN_RC_SERVICE_TYPE,
      port: this.opts.port,
      txt: { ...this.opts.txt },
    });
    this.published = true;
  }

  /**
   * A socket failure turns advertising off and frees the socket; it never stops
   * the gateway. Later errors from the same socket are absorbed (the listener
   * stays attached so they cannot become uncaught).
   */
  private fail(instance: BonjourLike, err: Error): void {
    if (this.bonjour !== instance) return;
    this.bonjour = undefined;
    this.published = false;
    // eslint-disable-next-line no-console
    const log = this.opts.log ?? ((m: string) => console.warn(m));
    // Node's socket errors name the syscall and code: "bind EADDRINUSE 0.0.0.0:5353".
    log(
      `mDNS: advertising disabled after a socket error: ${err?.message ?? String(err)}`,
    );
    try {
      instance.destroy();
    } catch {
      // best-effort teardown of a socket that already failed
    }
  }

  /**
   * Withdraw the advertisement (Goodbye), then destroy the socket. Resolves when
   * `unpublishAll` calls back OR after `timeoutMs`, whichever is first. Idempotent
   * and a no-op when never started.
   */
  async stop(timeoutMs = 500): Promise<void> {
    const bonjour = this.bonjour;
    if (!bonjour) return;
    this.bonjour = undefined;
    this.published = false;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          bonjour.destroy();
        } catch {
          // best-effort teardown
        }
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      try {
        bonjour.unpublishAll(() => {
          clearTimeout(timer);
          finish();
        });
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
  }
}
