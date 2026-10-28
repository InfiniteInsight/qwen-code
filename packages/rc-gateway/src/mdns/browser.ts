/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * mDNS browse helper for `qwen-rc daemons discover` (add-mdns-discovery). Like
 * the advertiser, the bonjour instance is INJECTED so collection/normalize/
 * dedupe/sort is unit-tested against a fake; the live multicast browse is a
 * verification ceiling (real LAN socket, frequently broken under WSL2).
 */

import {
  normalizeBrowseService,
  dedupeAndSortDaemons,
  type RawBrowseService,
  type DaemonRecord,
} from './advert.js';
import {
  QWEN_RC_SERVICE_TYPE,
  guardMdnsErrors,
  type HasMdnsSocket,
} from './advertiser.js';

/** A browser handle from `find` — we only need to stop it. */
export interface BrowserHandleLike {
  on(event: 'up', listener: (service: RawBrowseService) => void): void;
  stop?(): void;
}

/** The minimal `bonjour-service` surface the browse path depends on. */
export interface BonjourBrowserLike extends HasMdnsSocket {
  find(
    opts: { type: string },
    onUp?: (service: RawBrowseService) => void,
  ): BrowserHandleLike;
  destroy(): void;
}

/** Build a fresh instance; `onError` is for the constructor's error callback. */
export type BrowserFactory = (
  onError?: (err: Error) => void,
) => BonjourBrowserLike;

export interface BrowseOptions {
  factory: BrowserFactory;
  timeoutMs: number;
  /** Injectable delay (defaults to real setTimeout) so tests control the window. */
  wait?: (ms: number) => Promise<void>;
}

const realWait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  });

/**
 * Browse `_qwen-rc._tcp.local.` for `timeoutMs`, then return the discovered
 * daemons normalized, deduped by service name, and sorted by host then port.
 * Always tears down the socket. Never throws on an empty LAN (returns []).
 * A socket error (a UDP 5353 bind failure, say) rejects the browse with that
 * error rather than escaping as an uncaught exception (#155): an empty list
 * would wrongly claim that nothing advertises.
 */
export async function browseDaemons(
  opts: BrowseOptions,
): Promise<DaemonRecord[]> {
  const wait = opts.wait ?? realWait;
  let rejectBrowse: (err: Error) => void = () => {};
  const socketFailure = new Promise<never>((_resolve, reject) => {
    rejectBrowse = reject;
  });
  // An error after the browse settled has nobody racing it; keep it handled.
  socketFailure.catch(() => {});
  const onError = (err: Error) => rejectBrowse(err);
  const bonjour = opts.factory(onError);
  guardMdnsErrors(bonjour, onError);
  const raw: RawBrowseService[] = [];
  try {
    const browser = bonjour.find({ type: QWEN_RC_SERVICE_TYPE }, (service) => {
      raw.push(service);
    });
    try {
      await Promise.race([wait(opts.timeoutMs), socketFailure]);
    } finally {
      browser.stop?.();
    }
  } finally {
    bonjour.destroy();
  }
  const normalized = raw
    .map((s) => normalizeBrowseService(s))
    .filter((r): r is DaemonRecord => r !== null);
  return dedupeAndSortDaemons(normalized);
}
