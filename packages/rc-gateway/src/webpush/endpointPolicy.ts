/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lookup as dnsLookup } from 'node:dns';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

/**
 * Where a Web Push subscription may point (#165).
 *
 * A subscription endpoint is a URL the browser's push service hands the page,
 * and the gateway later POSTs a VAPID-signed request to it, with retries. The
 * route used to check only that it was a non-empty string, so any token that
 * could subscribe could make the gateway POST to `https://10.0.0.5:8443/x`:
 * a blind SSRF into whatever network the gateway sits on.
 *
 * The policy has three layers, and each one is there because the others can
 * be bypassed on their own:
 *
 *  1. Shape: `https:` only, no userinfo, the default port, bounded length.
 *  2. Host: by default only the known Web Push services (FCM for Chrome, Edge
 *     and Android, Mozilla autopush, Apple, Windows WNS). An operator can widen
 *     or narrow this with `QWEN_RC_PUSH_HOSTS`; `*` means "any public host".
 *  3. Address: a literal IP must be public, and a hostname must resolve only to
 *     public addresses. This is checked at registration, and again on every
 *     send by the guarded lookup the sender's https agent uses, so a hostname
 *     that resolved publicly at registration and is later re-pointed at a
 *     private address (DNS rebinding) is still refused at connect time.
 */

/**
 * Host suffixes of the push services browsers actually use. A host matches a
 * suffix when it equals it or ends with `.` + it.
 */
export const DEFAULT_PUSH_HOST_SUFFIXES: readonly string[] = Object.freeze([
  // Chrome, Edge (Chromium), Opera, Samsung Internet, Android WebView.
  'fcm.googleapis.com',
  // Legacy GCM endpoints still handed out by some older Chromium builds.
  'android.googleapis.com',
  // Firefox (Mozilla autopush).
  'push.services.mozilla.com',
  // Safari 16+ on macOS and iOS (web.push.apple.com).
  'push.apple.com',
  // Legacy Edge and Windows (WNS: *.notify.windows.com).
  'notify.windows.com',
]);

/** Longest endpoint accepted. Real services hand out a few hundred bytes. */
export const MAX_ENDPOINT_LENGTH = 2048;

export type PushEndpointRefusal =
  | 'bad_url'
  | 'too_long'
  | 'not_https'
  | 'credentials'
  | 'port'
  | 'host_not_allowed'
  | 'non_public_address'
  | 'unresolvable';

export type PushEndpointVerdict =
  | { ok: true; hostname: string }
  | { ok: false; reason: PushEndpointRefusal };

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolve a hostname to every address it has (test seam for DNS). */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface PushEndpointPolicyOptions {
  /**
   * Host suffixes a push endpoint may use. `null` means any host whose
   * addresses are public. Omitted means {@link DEFAULT_PUSH_HOST_SUFFIXES}.
   */
  allowedHostSuffixes?: readonly string[] | null;
  /** DNS seam. Defaults to `dns.promises.lookup(host, { all: true })`. */
  resolve?: HostResolver;
  /** Bound on a registration-time lookup. Default 3000 ms. */
  resolveTimeoutMs?: number;
}

const defaultResolve: HostResolver = async (hostname) =>
  dnsLookupAsync(hostname, { all: true, verbatim: true });

/**
 * Parse `QWEN_RC_PUSH_HOSTS`: a comma-separated list of host suffixes, or `*`
 * for "any public host". Returns undefined when the variable is unset or
 * blank, so the caller falls back to the default list.
 */
export function parsePushHostsEnv(
  raw: string | undefined,
): readonly string[] | null | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, ''))
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  if (parts.includes('*')) return null;
  return parts;
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function parseIPv4(s: string): number | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** [network, prefix] pairs of IPv4 space that is not publicly routable. */
const V4_NON_PUBLIC: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT (also Tailscale's 100.x space)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast
];

const V4_RANGES: ReadonlyArray<readonly [number, number]> = V4_NON_PUBLIC.map(
  ([net, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return [(parseIPv4(net)! & mask) >>> 0, mask] as const;
  },
);

function isPublicV4(n: number): boolean {
  for (const [net, mask] of V4_RANGES) {
    if ((n & mask) >>> 0 === net) return false;
  }
  return true;
}

/** Expand an IPv6 literal (no brackets, no zone) to eight 16-bit groups. */
function parseIPv6(s: string): number[] | null {
  let text = s;
  // An embedded dotted IPv4 tail (`::ffff:10.0.0.1`) is rewritten as the two
  // hex groups it stands for, so the rest of the parse sees only hex.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    text =
      text.slice(0, lastColon + 1) +
      ((v4 >>> 16) & 0xffff).toString(16) +
      ':' +
      (v4 & 0xffff).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (h: string): number[] | null => {
    if (h === '') return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (head === null || rest === null) return null;
  const fixed = head.length + rest.length;
  if (halves.length === 1) return fixed === 8 ? head : null;
  if (fixed > 7) return null;
  return [...head, ...new Array<number>(8 - fixed).fill(0), ...rest];
}

function isPublicV6(g: number[]): boolean {
  const embeddedV4 = (): number => ((g[6]! << 16) >>> 0) + g[7]!;
  // ::/80 prefix: unspecified, loopback, IPv4-compatible, IPv4-mapped.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
    if (g[5] === 0xffff) return isPublicV4(embeddedV4()); // ::ffff:a.b.c.d
    return false;
  }
  // 64:ff9b::/96 NAT64: judge by the IPv4 address it carries.
  if (
    g[0] === 0x64 &&
    g[1] === 0xff9b &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0
  ) {
    return isPublicV4(embeddedV4());
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false; // local NAT64
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard
  if (g[0] === 0x2001 && g[1]! < 0x200) return false; // 2001::/23 special purpose
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4 (carries an IPv4 address)
  if ((g[0]! & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((g[0]! & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local
  if ((g[0]! & 0xff00) === 0xff00) return false; // multicast
  return true;
}

/**
 * True when `address` is an IP literal in publicly routable space. Anything
 * that is not an IP literal, or that falls in loopback, link-local, RFC 1918,
 * CGNAT, ULA, multicast, documentation or reserved space, is not public.
 */
export function isPublicAddress(address: string): boolean {
  let a = address.trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) return false; // a zone id only makes sense for link-local
  const kind = isIP(a);
  if (kind === 4) {
    const n = parseIPv4(a);
    return n !== null && isPublicV4(n);
  }
  if (kind === 6) {
    const g = parseIPv6(a);
    return g !== null && isPublicV6(g);
  }
  return false;
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

function hostMatches(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((s) => host === s || host.endsWith('.' + s));
}

export class PushEndpointPolicy {
  private readonly suffixes: readonly string[] | null;
  private readonly resolve: HostResolver;
  private readonly resolveTimeoutMs: number;

  constructor(opts: PushEndpointPolicyOptions = {}) {
    this.suffixes =
      opts.allowedHostSuffixes === undefined
        ? DEFAULT_PUSH_HOST_SUFFIXES
        : opts.allowedHostSuffixes === null
          ? null
          : opts.allowedHostSuffixes.map((s) => s.toLowerCase());
    this.resolve = opts.resolve ?? defaultResolve;
    this.resolveTimeoutMs = opts.resolveTimeoutMs ?? 3000;
  }

  /** The allowlist in force (`null` = any public host). */
  get allowedHostSuffixes(): readonly string[] | null {
    return this.suffixes;
  }

  /**
   * Every check that needs no network: shape, host allowlist, and the address
   * class of a literal IP. The sender runs this before each delivery, so a
   * record stored before this policy existed is refused too.
   */
  checkStatic(endpoint: unknown): PushEndpointVerdict {
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return { ok: false, reason: 'bad_url' };
    }
    if (endpoint.length > MAX_ENDPOINT_LENGTH) {
      return { ok: false, reason: 'too_long' };
    }
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return { ok: false, reason: 'bad_url' };
    }
    if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
    if (url.username !== '' || url.password !== '') {
      return { ok: false, reason: 'credentials' };
    }
    // WHATWG URL drops an explicit :443 for https, so anything left is a
    // non-default port. No push service hands one out.
    if (url.port !== '') return { ok: false, reason: 'port' };
    let host = url.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    host = host.replace(/\.+$/, '');
    if (host.length === 0) return { ok: false, reason: 'bad_url' };
    if (isIP(host) !== 0) {
      // A literal address never matches a push-service suffix, and when the
      // operator allows any host it must still be public.
      if (!isPublicAddress(host)) {
        return { ok: false, reason: 'non_public_address' };
      }
      if (this.suffixes !== null) {
        return { ok: false, reason: 'host_not_allowed' };
      }
      return { ok: true, hostname: host };
    }
    if (this.suffixes !== null && !hostMatches(host, this.suffixes)) {
      return { ok: false, reason: 'host_not_allowed' };
    }
    return { ok: true, hostname: host };
  }

  /**
   * The registration-time check: {@link checkStatic} plus a DNS lookup that
   * must succeed and return only public addresses.
   */
  async check(endpoint: unknown): Promise<PushEndpointVerdict> {
    const verdict = this.checkStatic(endpoint);
    if (!verdict.ok) return verdict;
    if (isIP(verdict.hostname) !== 0) return verdict;
    let addrs: ResolvedAddress[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addrs = await Promise.race([
        this.resolve(verdict.hostname),
        new Promise<never>((_r, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout')),
            this.resolveTimeoutMs,
          );
        }),
      ]);
    } catch {
      return { ok: false, reason: 'unresolvable' };
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(addrs) || addrs.length === 0) {
      return { ok: false, reason: 'unresolvable' };
    }
    if (addrs.some((a) => !isPublicAddress(a.address))) {
      return { ok: false, reason: 'non_public_address' };
    }
    return verdict;
  }
}

/**
 * A `net` lookup that refuses to hand a socket any non-public address. Given
 * to the sender's https agent, so the address the request actually connects
 * to is checked at connect time, not only the one seen at registration.
 * A literal-IP host never reaches a lookup (net skips it), which is why the
 * sender also runs {@link PushEndpointPolicy.checkStatic} first.
 */
export function createGuardedLookup(
  resolve?: (
    hostname: string,
    cb: (err: Error | null, addrs: ResolvedAddress[]) => void,
  ) => void,
): LookupFunction {
  const base =
    resolve ??
    ((
      hostname: string,
      cb: (err: Error | null, addrs: ResolvedAddress[]) => void,
    ) => {
      dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) =>
        cb(err, addrs ?? []),
      );
    });
  return ((
    hostname: string,
    options: { family?: number | string; all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    base(hostname, (err, addrs) => {
      if (err) {
        callback(err);
        return;
      }
      const fam =
        options?.family === 4 || options?.family === 'IPv4'
          ? 4
          : options?.family === 6 || options?.family === 'IPv6'
            ? 6
            : 0;
      const usable = fam === 0 ? addrs : addrs.filter((a) => a.family === fam);
      if (usable.length === 0) {
        callback(
          Object.assign(
            new Error(`push endpoint ${hostname} did not resolve`),
            {
              code: 'ENOTFOUND',
            },
          ),
        );
        return;
      }
      if (usable.some((a) => !isPublicAddress(a.address))) {
        callback(
          Object.assign(
            new Error(
              `push endpoint ${hostname} resolves to a non-public address`,
            ),
            { code: 'EPUSHNONPUBLIC' },
          ),
        );
        return;
      }
      if (options?.all) {
        callback(null, usable);
      } else {
        callback(null, usable[0]!.address, usable[0]!.family);
      }
    });
  }) as unknown as LookupFunction;
}
