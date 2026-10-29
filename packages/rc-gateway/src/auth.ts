/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { TokenStore } from './tokenStore.js';
import { BRIDGE, hasScope, type RcScope } from './scopes.js';
import type { AuditRecorder } from './auditLog.js';
import { PeerAuditThrottle } from './auditThrottle.js';
import type { SubActorRateLimiter } from './bridges/subActorRateLimiter.js';
import type { SubActorBanStore } from './bridges/subActorBans.js';
import './types.js';

/** Max length of an asserted sub-actor id (bounds audit-row size). */
const SUB_ACTOR_MAX = 128;
/**
 * A sub-actor id must start alphanumeric and use only a safe id charset
 * (`<svc>:<user-id>` shapes like `telegram:alice`, `discord:12345`,
 * `matrix:@user=foo:home.example.com`). The charset deliberately EXCLUDES
 * whitespace and control characters so an asserted value can never inject a
 * newline into a JSONL audit line or smuggle markup into a client that renders
 * it. It DOES include `/ = +` because Matrix MXID localparts legally use them
 * (the extended grammar) — rejecting those would silently drop federated/legacy
 * users' prompts and votes. None of `/ = +` is a control/whitespace char, so the
 * audit-injection guard is unaffected.
 */
const SUB_ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9:._@/=+-]*$/;

/**
 * Parse + validate an `X-RC-SubActor` header value. Returns the trimmed id, or
 * `null` when absent/empty/too-long/ill-formed. PURE.
 */
export function parseSubActor(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > SUB_ACTOR_MAX) return null;
  return SUB_ACTOR_RE.test(v) ? v : null;
}

/**
 * Resolve an asserted sub-actor (the underlying human behind a bridge) onto
 * `req.rcClient.subActor`. SECURITY: a sub-actor is attached ONLY when the
 * resolved token holds the `bridge` scope AND the header value is valid — a
 * regular client sending `X-RC-SubActor` is silently ignored, so no client can
 * forge "acting for someone else" in the audit log. Mount AFTER `bearerResolve`.
 * Never rejects (a bad/absent header just yields no attribution); total.
 */
export function resolveSubActor(): RequestHandler {
  return (req, _res, next) => {
    const client = req.rcClient;
    if (client && client.scopes.includes(BRIDGE)) {
      // Header `X-RC-SubActor` lowercases on the wire to `x-rc-subactor`.
      const sub = parseSubActor(req.header('x-rc-subactor'));
      if (sub) client.subActor = sub;
    }
    next();
  };
}

/**
 * Reject a non-bridge authenticated token that sends `X-RC-SubActor`. Bridges
 * use this header to name the chat user acting through them; any other token
 * sending it is either confused or attempting to spoof attribution. Unauthenticated
 * requests (no `rcClient`) pass through — they'll fail auth downstream anyway.
 * Mount BEFORE `resolveSubActor`.
 */
export function enforceSubActorScope(): RequestHandler {
  return (req, res, next) => {
    const headerVal = req.header('x-rc-subactor');
    const hasHeader = headerVal !== undefined && headerVal !== '';
    if (hasHeader && req.rcClient && !req.rcClient.scopes.includes(BRIDGE)) {
      res.status(400).json({
        error: 'X-RC-SubActor requires the bridge scope',
        code: 'sub_actor_forbidden_scope',
      });
      return;
    }
    next();
  };
}

/**
 * Resolve the bearer token to `req.rcClient`, or 401 (+ audit auth_failed).
 *
 * The 401 rows go through a per-peer throttle (#165): anyone who can reach
 * the port can send a bad token, so one row per request let unauthenticated
 * traffic grow the disk without bound. The first failure from a peer is
 * still written at once; the rest of its minute is counted into the next
 * row's `detail.count`. Pass the gateway's shared throttle so every mount
 * counts into the same windows; without one, this middleware keeps its own.
 */
export function bearerResolve(
  store: TokenStore,
  audit?: AuditRecorder,
  unauthAudit: PeerAuditThrottle = new PeerAuditThrottle(audit),
): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const cred = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const result = cred
      ? store.verifyTokenDetailed(cred)
      : { ok: false as const, reason: 'not_found' as const };

    if (!result.ok) {
      const peer = req.socket?.remoteAddress;
      if (result.reason === 'token_expired_max_age') {
        unauthAudit.record(peer, {
          action: 'token_expired_max_age',
          detail: { path: req.path },
        });
        res.status(401).json({
          error: 'Token exceeded maximum age',
          code: 'token_expired_max_age',
        });
      } else {
        unauthAudit.record(peer, {
          action: 'auth_failed',
          detail: { path: req.path },
        });
        res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      }
      return;
    }

    req.rcClient = {
      id: result.id,
      scopes: result.scopes,
      sessionLockId: result.sessionLockId,
      shareLabel: result.shareLabel,
    };
    // A share token (the only kind with a session lock) gets its id + label
    // surfaced so guest-action routes can stamp audit rows with the share's
    // identity at action time. Normal tokens never get these fields.
    if (result.sessionLockId !== undefined) {
      req.rcClient.shareId = result.id;
      req.rcClient.shareLabel = result.shareLabel;
    }
    next();
  };
}

/**
 * Confine a session-locked token (a share) to its one session. When
 * `req.rcClient.sessionLockId` is set and does not match `req.params.id`, 403
 * `session_locked` (audited via the existing `scope_denied` action). A token
 * with no lock (normal owner/paired tokens) passes through unaffected. Mount
 * AFTER `requireScope(...)` on the session routes.
 */
export function enforceSessionLock(audit?: AuditRecorder): RequestHandler {
  return (req, res, next) => {
    const lock = req.rcClient?.sessionLockId;
    if (lock !== undefined && lock !== req.params.id) {
      void audit?.record({
        action: 'scope_denied',
        actorTokenId: req.rcClient?.id,
        shareId: req.rcClient?.shareId,
        shareLabel: req.rcClient?.shareLabel,
        detail: { reason: 'session_locked', path: req.path },
      });
      res.status(403).json({ error: 'Session locked', code: 'session_locked' });
      return;
    }
    next();
  };
}

/**
 * Reject a banned sub-actor's writes (`add-bridge-protocol`). Applies ONLY when a
 * sub-actor was asserted (bridge-mediated); a request with no sub-actor passes
 * through. A banned sub-actor → 403 `sub_actor_banned`. Mount on write routes
 * AFTER `resolveSubActor` and BEFORE the rate limiter (a banned user shouldn't
 * even consume rate budget). The rejection is NOT audited per-hit (a banned bot
 * could hammer) — the ban/lift actions are audited at creation instead. Never
 * throws.
 */
export function enforceSubActorBan(bans: SubActorBanStore): RequestHandler {
  return (req, res, next) => {
    const sub = req.rcClient?.subActor;
    if (sub && bans.isBanned(sub)) {
      res
        .status(403)
        .json({ error: 'Sub-actor is banned', code: 'sub_actor_banned' });
      return;
    }
    next();
  };
}

/**
 * Prefix for a per-token limiter key. A sub-actor id must start alphanumeric
 * (SUB_ACTOR_RE), so no asserted sub-actor can ever equal one of these.
 */
const TOKEN_KEY_PREFIX = '#token:';

export interface SubActorRateLimitOptions {
  /**
   * #165: when no sub-actor is asserted, count the request against the
   * TOKEN instead of passing it through, with the same window and cap. For
   * the routes that each cost a model call (recap, btw), where "only a bridge
   * is limited" meant a view-only guest could loop one model call per
   * request. Over the cap → 429 `rate_limited` (the code the page already
   * shows as "too many questions just now"), audited once per burst as
   * `token_rate_limited`.
   */
  perToken?: boolean;
}

/**
 * Per-sub-actor write rate limit (`add-bridge-protocol`). Applies ONLY when a
 * sub-actor was asserted (a bridge-mediated request), unless `perToken` is
 * set: then a request with no sub-actor is limited per token instead. Over
 * the cap → 429 `sub_actor_rate_limited`, audited once per burst
 * (firstDrop). Mount on write routes AFTER `resolveSubActor`. Never throws.
 * Without `perToken`, a request with no subActor (the common case) is a pure
 * pass-through.
 */
export function enforceSubActorRateLimit(
  limiter: SubActorRateLimiter,
  cap: number,
  audit?: AuditRecorder,
  now: () => number = Date.now,
  opts: SubActorRateLimitOptions = {},
): RequestHandler {
  return (req, res, next) => {
    const sub = req.rcClient?.subActor;
    if (!sub) {
      const tokenId = req.rcClient?.id;
      if (!opts.perToken || !tokenId) {
        next();
        return;
      }
      const verdict = limiter.tryConsume(
        TOKEN_KEY_PREFIX + tokenId,
        cap,
        now(),
      );
      if (!verdict.allowed) {
        if (verdict.firstDrop) {
          void audit?.record({
            action: 'token_rate_limited',
            actorTokenId: tokenId,
            shareId: req.rcClient?.shareId,
            shareLabel: req.rcClient?.shareLabel,
            target: req.params.id,
          });
        }
        res
          .status(429)
          .json({ error: 'Rate limit exceeded', code: 'rate_limited' });
        return;
      }
      next();
      return;
    }
    const { allowed, firstDrop } = limiter.tryConsume(sub, cap, now());
    if (!allowed) {
      if (firstDrop) {
        void audit?.record({
          action: 'sub_actor_rate_limited',
          actorTokenId: req.rcClient?.id,
          subActor: sub,
          target: req.params.id,
        });
      }
      res.status(429).json({
        error: 'Sub-actor rate limit exceeded',
        code: 'sub_actor_rate_limited',
      });
      return;
    }
    next();
  };
}

/**
 * Require a scope on the resolved client, or 403 (+ audit scope_denied).
 * Uses {@link hasScope} for transitive implication: a token with `owner`
 * passes a check for `write`, `approve`, or `session:read`.
 */
export function requireScope(
  scope: RcScope,
  audit?: AuditRecorder,
): RequestHandler {
  return (req, res, next) => {
    if (!req.rcClient || !hasScope(req.rcClient.scopes, scope)) {
      void audit?.record({
        action: 'scope_denied',
        actorTokenId: req.rcClient?.id,
        shareId: req.rcClient?.shareId,
        shareLabel: req.rcClient?.shareLabel,
        detail: { required: scope },
      });
      res
        .status(403)
        .json({ error: 'Insufficient scope', code: 'scope_required' });
      return;
    }
    next();
  };
}
