/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * APNs delivery (add-native-mobile-shells "APNs delivery pipeline"). The HTTP/2
 * call to Apple is INJECTED ({@link ApnsTransport}) so all the routing logic —
 * success audit, 410 / 400 BadDeviceToken subscription removal, audited
 * rejection of every other 4xx, 429/5xx backoff-retry, dead-token
 * orphan safety — is unit-tested against a fake. The live transport
 * ({@link createHttp2ApnsTransport}) is the runtime ceiling (needs real Apple
 * credentials + a device + HTTP/2 reachability to Apple) and is NOT exercised in
 * CI — same posture as the matrix-E2EE adapter.
 */

import { connect, constants as H2 } from 'node:http2';
import type { AuditRecorder } from '../auditLog.js';
import type { ApnsStore, ApnsSubscriptionRecord } from './apnsStore.js';
import { buildApnsPayload } from './apnsPayload.js';
import type { PushPayload } from '../webpush/payload.js';

export interface ApnsPostRequest {
  host: string;
  deviceToken: string;
  topic: string;
  jwt: string;
  body: string;
}

export interface ApnsTransport {
  /**
   * `reason` is the response body as received: Apple sends `{"reason":"..."}`
   * with every non-200. The sender extracts the reason itself.
   */
  post(req: ApnsPostRequest): Promise<{ status: number; reason?: string }>;
}

/**
 * The 400 reasons that condemn the DEVICE TOKEN itself (#169). Apple's other
 * 400 reasons (BadTopic, TopicDisallowed, PayloadEmpty, BadPriority,
 * MissingTopic, IdleTimeout, ...) describe the request or the gateway's own
 * configuration, so the same reply would come back for every device and a
 * removal would wipe them all. `DeviceTokenNotForTopic` is left out for that
 * reason: a mistyped bundle id produces it for every registered device.
 * Every 410 (Unregistered, ExpiredToken) is permanent and removes.
 */
const APNS_PERMANENT_400_REASONS: ReadonlySet<string> = new Set([
  'BadDeviceToken',
]);

/**
 * Apple's reason from a response body: the `reason` of a `{"reason":"..."}`
 * body, or a bare reason token. Anything else (no body, HTML from a proxy, an
 * oversized value) is `unknown`, so audit detail never carries raw body text.
 */
function apnsReason(body: string | undefined): string {
  const REASON = /^[A-Za-z]{1,64}$/;
  if (typeof body !== 'string') return 'unknown';
  const text = body.trim();
  if (REASON.test(text)) return text;
  try {
    const parsed = JSON.parse(text) as { reason?: unknown };
    if (typeof parsed?.reason === 'string' && REASON.test(parsed.reason)) {
      return parsed.reason;
    }
  } catch {
    // not JSON
  }
  return 'unknown';
}

export type ApnsSendResult =
  | { ok: true }
  | { ok: false; removed: true }
  | { ok: false; retriesExhausted: true }
  | { ok: false; rejected: true };

export interface ApnsSenderOptions {
  signer: { token(): string };
  transport: ApnsTransport;
  store: ApnsStore;
  bundleId: string;
  host: string;
  audit?: AuditRecorder;
  maxAttempts?: number;
  wait?: (ms: number) => Promise<void>;
  backoffMs?: (attempt: number) => number;
  /**
   * Orphan safety (advisor's Cycle C flag): a revoked token's device must never
   * still receive a push. When provided and it returns false, the subscription is
   * removed and NO send is attempted.
   */
  isTokenLive?: (tokenId: string) => boolean;
}

const defaultWait = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  });

export class ApnsSender {
  private readonly maxAttempts: number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly backoffMs: (attempt: number) => number;

  constructor(private readonly opts: ApnsSenderOptions) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.wait = opts.wait ?? defaultWait;
    this.backoffMs = opts.backoffMs ?? ((n) => Math.min(30_000, 500 * 2 ** n));
  }

  async send(
    sub: ApnsSubscriptionRecord,
    payload: PushPayload,
  ): Promise<ApnsSendResult> {
    // Orphan guard: never deliver to a device bound to a revoked token.
    if (this.opts.isTokenLive && !this.opts.isTokenLive(sub.tokenId)) {
      await this.opts.store.remove(sub.id);
      await this.opts.audit?.record({
        action: 'apns_subscription_removed',
        target: sub.tokenId,
        detail: { subscriptionId: sub.id, reason: 'token_not_live' },
      });
      return { ok: false, removed: true };
    }

    const body = JSON.stringify(buildApnsPayload(payload));
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const { status, reason: replyBody } = await this.opts.transport.post({
        host: this.opts.host,
        deviceToken: sub.deviceToken,
        topic: this.opts.bundleId,
        jwt: this.opts.signer.token(),
        body,
      });

      if (status === 200) {
        await this.opts.audit?.record({
          action: 'push_routed',
          detail: { transport: 'apns', subscriptionId: sub.id },
        });
        return { ok: true };
      }

      // Remove the device ONLY on a reply Apple documents as condemning the
      // token itself (#169). Any 400 used to remove it, so one request or
      // configuration problem (a bad topic, an empty payload) wiped every
      // registered device.
      const reason = apnsReason(replyBody);
      if (
        status === 410 ||
        (status === 400 && APNS_PERMANENT_400_REASONS.has(reason))
      ) {
        await this.opts.store.remove(sub.id);
        await this.opts.audit?.record({
          action: 'apns_subscription_removed',
          target: sub.tokenId,
          detail: {
            subscriptionId: sub.id,
            reason: status === 410 ? 'unregistered' : 'bad_device_token',
            apnsReason: reason,
          },
        });
        return { ok: false, removed: true };
      }

      if (status === 429 || status >= 500) {
        if (attempt < this.maxAttempts) {
          await this.wait(this.backoffMs(attempt));
          continue;
        }
        return { ok: false, retriesExhausted: true };
      }

      // Any other 4xx (a 400 that does not condemn the token, a 403 JWT
      // problem, a 413): neither retryable nor proof the device is gone. Keep
      // the subscription, do not retry, and audit Apple's reason so the
      // problem is visible instead of silently dropped.
      await this.opts.audit?.record({
        action: 'push_send_failed',
        target: payload.sessionId,
        detail: {
          transport: 'apns',
          subscriptionId: sub.id,
          kind: payload.kind,
          statusCode: status,
          reason: 'rejected',
          apnsReason: reason,
        },
      });
      return { ok: false, rejected: true };
    }
    return { ok: false, retriesExhausted: true };
  }
}

/**
 * The live HTTP/2 transport to Apple. POSTs to `/3/device/<deviceToken>` with the
 * documented headers; opens a fresh connection per send (a production deployment
 * would pool).
 *
 * `connectOptions` is an ESCAPE HATCH FOR TESTS ONLY: it defaults to `undefined`,
 * so production gets node's strict TLS verification against the public Apple CA
 * chain. The integration test passes its self-signed CA (or `rejectUnauthorized:
 * false`) here to point the REAL transport at an in-process HTTP/2 server — there
 * is no code path by which production silently skips cert verification.
 *
 * Every request has a hard deadline (`opts.timeoutMs`, default
 * {@link APNS_REQUEST_TIMEOUT_MS}, #169): connect, TLS, headers and body all
 * count against it. On expiry the session is destroyed and the promise rejects,
 * which the notifier audits as `push_send_failed` like any connection error.
 * Without it a request Apple (or a black-holed route) never answered held the
 * notifier, and with it the session's event pump, indefinitely.
 */
export function createHttp2ApnsTransport(
  connectOptions?: import('node:http2').SecureClientSessionOptions,
  opts: { timeoutMs?: number } = {},
): ApnsTransport {
  const timeoutMs = opts.timeoutMs ?? APNS_REQUEST_TIMEOUT_MS;
  return {
    post: (req) =>
      new Promise((resolve, reject) => {
        const client = connect(`https://${req.host}`, connectOptions);
        let settled = false;
        // Hoisted, so the timer callback below can call it; it only ever runs
        // after `timer` is assigned.
        function settle(finish: () => void): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          finish();
        }
        const timer = setTimeout(
          () =>
            settle(() => {
              client.destroy();
              reject(new Error(`APNs request timed out after ${timeoutMs}ms`));
            }),
          timeoutMs,
        );
        if (typeof timer === 'object' && timer && 'unref' in timer) {
          (timer as { unref: () => void }).unref();
        }
        client.on('error', (err) =>
          settle(() => {
            client.destroy();
            reject(err);
          }),
        );
        const stream = client.request({
          [H2.HTTP2_HEADER_METHOD]: 'POST',
          [H2.HTTP2_HEADER_PATH]: `/3/device/${req.deviceToken}`,
          'apns-topic': req.topic,
          'apns-push-type': 'alert',
          authorization: `bearer ${req.jwt}`,
          'content-type': 'application/json',
        });
        let status = 0;
        stream.on('response', (headers) => {
          status = Number(headers[H2.HTTP2_HEADER_STATUS]) || 0;
        });
        let bodyText = '';
        stream.setEncoding('utf8');
        stream.on('data', (c) => (bodyText += c));
        stream.on('end', () =>
          settle(() => {
            client.close();
            resolve({ status, reason: bodyText || undefined });
          }),
        );
        stream.on('error', (err) =>
          settle(() => {
            client.close();
            reject(err);
          }),
        );
        stream.write(req.body);
        stream.end();
      }),
  };
}

/** Default hard deadline for one APNs request (#169). */
export const APNS_REQUEST_TIMEOUT_MS = 15_000;

/** APNs host for the configured environment. */
export function apnsHost(environment: 'sandbox' | 'production'): string {
  return environment === 'production'
    ? 'api.push.apple.com'
    : 'api.sandbox.push.apple.com';
}
