/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import { OWNER } from '../scopes.js';
import { parseTimeOfDay } from '../policy/conditions.js';
import type { AuditRecorder } from '../auditLog.js';
import type { VapidStore } from '../webpush/vapid.js';
import type { PushStore } from '../pushStore.js';
import type { PushNotifier } from '../webpush/notifier.js';
import type { PushPayload } from '../webpush/payload.js';
import { PushEndpointPolicy } from '../webpush/endpointPolicy.js';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Subscriptions one token may hold before its oldest is evicted (#165). */
export const DEFAULT_MAX_SUBSCRIPTIONS_PER_TOKEN = 8;

/**
 * Bound on each subscription key. A P-256 public key is 87 base64url chars and
 * the auth secret 22; the slack is for padding and whitespace variants.
 */
const MAX_KEY_LENGTH = 256;

export interface PushRouterOptions {
  /**
   * Where an endpoint may point. Defaults to the known Web Push services with
   * a real DNS check, so a caller that forgets to pass one is still safe.
   */
  endpointPolicy?: PushEndpointPolicy;
  /** Per-token subscription cap. Default {@link DEFAULT_MAX_SUBSCRIPTIONS_PER_TOKEN}. */
  maxSubscriptionsPerToken?: number;
}

/**
 * Push subscription + VAPID routes, mounted under /rc/push (so paths are
 * /vapid, /subscribe, /subscriptions, /subscriptions/:id). The mount site
 * applies requireScope(SESSION_READ); owner-only operations (?all=true,
 * cross-token delete) are checked here against req.rcClient.scopes.
 *
 * WHY PUSH STAYS AT SESSION_READ, AND WHY A SHARE STILL CANNOT SUBSCRIBE
 * (#165)
 *
 * The audit found a share guest could register an endpoint on an internal
 * host and have the gateway POST to it (blind SSRF). The SSRF is closed by
 * the endpoint policy for every scope, so the scope question is only "who
 * should get notifications at all". A paired read-only device is the main
 * reason to pair one: a phone that watches and is told when a turn finishes
 * or a permission is waiting. Moving push to WRITE would take that away from
 * exactly the device it is for. A share is different: it is a link handed to
 * someone else, the guest page never subscribes, and nothing a guest needs
 * depends on a gateway that sends to an address the guest chose. So a
 * session-locked token is refused here, and the notifier's session-lock
 * filter stays as the second line for any record that predates this.
 *
 * Secrecy: the VAPID private key is never returned. Audit entries carry only
 * { subscriptionId } (plus a reason on eviction), never the endpoint or keys.
 */
export function createPushRouter(
  vapid: VapidStore,
  store: PushStore,
  notifier: PushNotifier,
  audit?: AuditRecorder,
  opts: PushRouterOptions = {},
): Router {
  const router = Router();
  const policy = opts.endpointPolicy ?? new PushEndpointPolicy();
  const maxPerToken =
    opts.maxSubscriptionsPerToken ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_TOKEN;

  router.get('/vapid', (_req, res) => {
    res.json({ applicationServerKey: vapid.getApplicationServerKey() });
  });

  router.post('/subscribe', async (req, res) => {
    if (req.rcClient!.sessionLockId !== undefined) {
      res.status(403).json({
        error: 'A share link cannot register push notifications',
        code: 'insufficient_scope',
      });
      return;
    }
    const body = (req.body ?? {}) as {
      subscription?: {
        endpoint?: unknown;
        keys?: { p256dh?: unknown; auth?: unknown };
      };
    };
    const sub = body.subscription;
    if (
      !sub ||
      !isNonEmptyString(sub.endpoint) ||
      !sub.keys ||
      !isNonEmptyString(sub.keys.p256dh) ||
      !isNonEmptyString(sub.keys.auth) ||
      sub.keys.p256dh.length > MAX_KEY_LENGTH ||
      sub.keys.auth.length > MAX_KEY_LENGTH
    ) {
      res
        .status(400)
        .json({ error: 'Invalid subscription', code: 'invalid_subscription' });
      return;
    }
    const endpoint = sub.endpoint;
    const keys = { p256dh: sub.keys.p256dh, auth: sub.keys.auth };

    try {
      const verdict = await policy.check(endpoint);
      if (!verdict.ok) {
        res.status(400).json({
          error: 'Push endpoint refused',
          code: 'invalid_push_endpoint',
          reason: verdict.reason,
        });
        return;
      }

      const { record: rec, evicted } = await store.addCapped(
        req.rcClient!.id,
        { endpoint, keys },
        maxPerToken,
      );
      for (const old of evicted) {
        notifier.forgetRateLimit(old.id);
        void audit?.record({
          action: 'push_unsubscribed',
          actorTokenId: req.rcClient!.id,
          detail: { subscriptionId: old.id, reason: 'cap_evicted' },
        });
      }
      void audit?.record({
        action: 'push_subscribed',
        actorTokenId: req.rcClient!.id,
        shareId: req.rcClient?.shareId,
        shareLabel: req.rcClient?.shareLabel,
        detail: { subscriptionId: rec.id },
      });
      res.status(201).json({ id: rec.id });
    } catch {
      // persist() can reject (EACCES/ENOSPC); answer rather than hang.
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error', code: 'internal' });
      }
    }
  });

  router.get('/subscriptions', (req, res) => {
    if (req.query.all === 'true') {
      if (!req.rcClient!.scopes.includes(OWNER)) {
        res
          .status(403)
          .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
        return;
      }
      res.json({
        subscriptions: store.listAll().map((r) => ({
          id: r.id,
          endpoint: r.endpoint,
          createdAt: r.createdAt,
          tokenId: r.tokenId,
          prefs: r.prefs,
          quietHours: r.quietHours,
          maxPerHour: r.maxPerHour,
        })),
      });
      return;
    }
    res.json({
      subscriptions: store.listFor(req.rcClient!.id).map((r) => ({
        id: r.id,
        endpoint: r.endpoint,
        createdAt: r.createdAt,
        prefs: r.prefs,
        quietHours: r.quietHours,
        maxPerHour: r.maxPerHour,
      })),
    });
  });

  router.delete('/subscriptions/:id', async (req, res) => {
    const rec = store.get(req.params.id);
    const isOwnerScope = req.rcClient!.scopes.includes(OWNER);
    // Hide existence of another token's subscription from non-owners (404).
    if (!rec || (rec.tokenId !== req.rcClient!.id && !isOwnerScope)) {
      res.status(404).json({ error: 'Not found', code: 'not_found' });
      return;
    }
    await store.remove(rec.id);
    // Free the subscription's in-memory rate-limit window so stale counters
    // don't accumulate as subscriptions churn (no-op without a limiter).
    notifier.forgetRateLimit(rec.id);
    void audit?.record({
      action: 'push_unsubscribed',
      actorTokenId: req.rcClient!.id,
      shareId: req.rcClient?.shareId,
      shareLabel: req.rcClient?.shareLabel,
      detail: { subscriptionId: rec.id },
    });
    res.status(204).end();
  });

  // Set per-subscription delivery preferences: `prefs` (kind allowlist) and/or
  // `quietHours` (a `{from, to, timezone}` window). Authorization mirrors
  // DELETE: existence + ownership are checked first (hide existence of another
  // token's subscription from non-owners with a 404, NOT a 403/400), and only
  // then is the body validated. Fields update INDEPENDENTLY — each is applied
  // only when its key is present in the body: a `null` value clears it, a
  // value sets it, an absent key leaves it unchanged (so a PATCH that sets
  // only `quietHours` does not wipe `prefs`). `prefs`: array of strings (empty
  // = "receive nothing") or null (clear → receive all), else 400 invalid_prefs.
  // `quietHours`: a parseable `{from, to, timezone}` (validated by the shared
  // policy `parseTimeOfDay`) or null (clear), else 400 invalid_quiet_hours.
  router.patch('/subscriptions/:id', async (req, res) => {
    const rec = store.get(req.params.id);
    const isOwnerScope = req.rcClient!.scopes.includes(OWNER);
    if (!rec || (rec.tokenId !== req.rcClient!.id && !isOwnerScope)) {
      res.status(404).json({ error: 'Not found', code: 'not_found' });
      return;
    }
    // persist() (writeFile) can reject on EACCES/ENOSPC; server.ts has no
    // global error middleware, so an uncaught rejection would hang the request
    // (the recurring async-route-error bug class). Catch → 500.
    try {
      const body = (req.body ?? {}) as {
        prefs?: unknown;
        quietHours?: unknown;
        maxPerHour?: unknown;
      };

      // Validate BOTH fields up front, then apply — the request is
      // all-or-nothing. A mixed PATCH whose second field is malformed must NOT
      // have already persisted the first field (a partial commit could
      // silently narrow prefs while returning 400 → a missed-prompt-class
      // false suppression the user never knowingly committed).
      let applyPrefs = false;
      let nextPrefs: string[] | undefined;
      if ('prefs' in body) {
        const { prefs } = body;
        const isValid =
          prefs === null ||
          (Array.isArray(prefs) && prefs.every((p) => typeof p === 'string'));
        if (!isValid) {
          res
            .status(400)
            .json({ error: 'Invalid prefs', code: 'invalid_prefs' });
          return;
        }
        nextPrefs = Array.isArray(prefs) ? (prefs as string[]) : undefined;
        applyPrefs = true;
      }

      let applyQuiet = false;
      let nextQuiet: { from: string; to: string; timezone: string } | undefined;
      if ('quietHours' in body) {
        const { quietHours } = body;
        if (quietHours !== null) {
          const parsed = parseTimeOfDay(quietHours);
          if (!parsed) {
            res.status(400).json({
              error: 'Invalid quiet hours',
              code: 'invalid_quiet_hours',
            });
            return;
          }
          const qh = quietHours as {
            from: string;
            to: string;
            timezone: string;
          };
          nextQuiet = { from: qh.from, to: qh.to, timezone: qh.timezone };
        }
        applyQuiet = true;
      }

      // maxPerHour: an integer in [1, 240] (cycle 46) or null (clear → the
      // notifier's default cap). Validated up front with the others so a bad
      // value can't partially apply a sibling field.
      let applyMax = false;
      let nextMax: number | undefined;
      if ('maxPerHour' in body) {
        const { maxPerHour } = body;
        if (maxPerHour !== null) {
          if (
            typeof maxPerHour !== 'number' ||
            !Number.isInteger(maxPerHour) ||
            maxPerHour < 1 ||
            maxPerHour > 240
          ) {
            res.status(400).json({
              error: 'Invalid maxPerHour',
              code: 'invalid_max_per_hour',
            });
            return;
          }
          nextMax = maxPerHour;
        }
        applyMax = true;
      }

      if (applyPrefs) await store.setPrefs(rec.id, nextPrefs);
      if (applyQuiet) await store.setQuietHours(rec.id, nextQuiet);
      if (applyMax) await store.setMaxPerHour(rec.id, nextMax);

      if (applyPrefs || applyQuiet || applyMax) {
        void audit?.record({
          action: 'push_prefs_updated',
          actorTokenId: req.rcClient!.id,
          shareId: req.rcClient?.shareId,
          shareLabel: req.rcClient?.shareLabel,
          detail: { subscriptionId: rec.id },
        });
      }
      // Reflect the current record state (post-update).
      const fresh = store.get(rec.id)!;
      res.status(200).json({
        id: rec.id,
        prefs: fresh.prefs,
        quietHours: fresh.quietHours,
        maxPerHour: fresh.maxPerHour,
      });
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error', code: 'internal' });
      }
    }
  });

  // Owner-gated self-test: fan a synthetic task.completed out to the caller's
  // own subscriptions. The router is mounted under session:read; owner is
  // required in-handler. `sent` is the number of subscriptions attempted
  // (delivery is async/best-effort, so success is not reflected here).
  router.post('/test', async (req, res) => {
    if (!req.rcClient!.scopes.includes(OWNER)) {
      res
        .status(403)
        .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }
    const body = (req.body ?? {}) as { sessionId?: unknown };
    const sessionId = isNonEmptyString(body.sessionId)
      ? body.sessionId
      : 'test';
    const payload: PushPayload = {
      v: 1,
      kind: 'task.completed',
      sessionId,
      summary: 'Task finished',
      url: '/ui/?session=' + encodeURIComponent(sessionId),
    };
    // Fire-and-forget: delivery is async/best-effort (send() never throws, so
    // this floating promise can never reject). Blocking the response on the
    // retry/backoff sequence would stall it for tens of seconds on a dead sub.
    void notifier.notifyToken(req.rcClient!.id, payload);
    res.status(200).json({ sent: store.listFor(req.rcClient!.id).length });
  });

  // GET /digest — owner-only summary of pushes suppressed during quiet hours
  // ("what you missed while away", the read half of design D4). The router is
  // mounted under session:read; owner is required in-handler (mirrors the
  // ?all=true subscriptions path). Counts/ids/kind only — no secret material.
  router.get('/digest', (req, res) => {
    if (!req.rcClient!.scopes.includes(OWNER)) {
      res
        .status(403)
        .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }
    res.status(200).json({ digests: notifier.digestSummary() });
  });

  return router;
}
