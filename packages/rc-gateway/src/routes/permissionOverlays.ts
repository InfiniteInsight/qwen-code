/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import { normalizeTool, PolicyError } from '../policy/loader.js';
import type { PolicyAction } from '../policy/loader.js';
import type { PermissionOverlayStore } from '../policy/overlays.js';
import {
  OverlayLimitError,
  type PermissionOverlay,
} from '../policy/overlays.js';

/**
 * Session-scoped permission overlays (issue #33) — TTL-bound overrides an
 * operator sets from the dashboard. Owner-scoped at the mount (mirrors
 * `/policy/explain`): no daemon call, gateway-local store.
 *
 * - `GET    /rc/permission-overlays` — active overlays (expired ones pruned).
 * - `POST   /rc/permission-overlays` — set one; body
 *   `{ sessionId?, tool?, action, ttlSeconds, reason? }`. `sessionId` absent
 *   = all sessions; `tool` absent = any tool. Every overlay MUST carry a TTL
 *   of 1..{@link OVERLAY_MAX_TTL_SEC} seconds (the 24h cap is what makes an
 *   override ephemeral — there is no persistent form of this API).
 * - `DELETE /rc/permission-overlays/:id` — revoke early (404 `overlay_not_found`
 *   when unknown or already expired).
 *
 * Overlays live in gateway memory only: a restart drops them (fail-closed —
 * the file policy is the only durable source of truth).
 */

/** Hard TTL cap: 24 hours. Enforced here so no override can outlive a day. */
export const OVERLAY_MAX_TTL_SEC = 86_400;

/** `reason` is a short operator note — capped so it stays audit/UI-friendly. */
const OVERLAY_REASON_MAX_LEN = 200;

const ACTIONS: readonly PolicyAction[] = ['allow', 'deny', 'prompt'];

export interface PermissionOverlayRouteDeps {
  audit?: AuditRecorder;
}

export interface PermissionOverlayRoutes {
  get: RequestHandler;
  post: RequestHandler;
  remove: RequestHandler;
}

interface OverlayBody {
  sessionId?: unknown;
  tool?: unknown;
  action?: unknown;
  ttlSeconds?: unknown;
  reason?: unknown;
}

/**
 * Build the three overlay route handlers around a shared in-memory store
 * (the same instance the PolicyEnforcer evaluates against). All responses
 * echo only the closed fields the operator supplied — never anything from
 * a permission frame.
 */
export function createPermissionOverlayRoutes(
  store: PermissionOverlayStore,
  deps: PermissionOverlayRouteDeps = {},
): PermissionOverlayRoutes {
  const get: RequestHandler = (_req, res) => {
    res.status(200).json({ overlays: store.list() });
  };

  const post: RequestHandler = (req, res) => {
    const body = (req.body ?? {}) as OverlayBody;

    const action = ACTIONS.find((a) => a === body.action);
    if (!action) {
      res.status(400).json({
        error: 'action must be one of allow | deny | prompt',
        code: 'invalid_action',
      });
      return;
    }
    const ttl = body.ttlSeconds;
    if (
      typeof ttl !== 'number' ||
      !Number.isInteger(ttl) ||
      ttl < 1 ||
      ttl > OVERLAY_MAX_TTL_SEC
    ) {
      res.status(400).json({
        error: `ttlSeconds must be an integer between 1 and ${OVERLAY_MAX_TTL_SEC}`,
        code: 'invalid_ttl',
      });
      return;
    }
    let tool: string | undefined;
    if (body.tool !== undefined) {
      if (typeof body.tool !== 'string' || body.tool.length === 0) {
        res.status(400).json({
          error: 'tool must be a non-empty string',
          code: 'invalid_tool',
        });
        return;
      }
      try {
        // Same fail-closed normalization the YAML loader applies: a kind, a
        // glob, or a known tool NAME (mapped to its kind).
        tool = normalizeTool(body.tool, 'overlay.tool');
      } catch (err) {
        if (err instanceof PolicyError) {
          res.status(400).json({ error: err.message, code: 'invalid_tool' });
          return;
        }
        throw err;
      }
    }
    let sessionId: string | undefined;
    if (body.sessionId !== undefined) {
      if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
        res.status(400).json({
          error: 'sessionId must be a non-empty string',
          code: 'invalid_session',
        });
        return;
      }
      sessionId = body.sessionId;
    }
    let reason: string | undefined;
    if (body.reason !== undefined) {
      if (
        typeof body.reason !== 'string' ||
        body.reason.length > OVERLAY_REASON_MAX_LEN
      ) {
        res.status(400).json({
          error: `reason must be a string of at most ${OVERLAY_REASON_MAX_LEN} chars`,
          code: 'invalid_reason',
        });
        return;
      }
      if (body.reason.length > 0) reason = body.reason;
    }

    const nowMs = Date.now();
    let overlay: PermissionOverlay;
    try {
      overlay = store.add(
        {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(tool !== undefined ? { tool } : {}),
          action,
          expiresAt: nowMs + ttl * 1000,
          ...(reason !== undefined ? { reason } : {}),
        },
        nowMs,
      );
    } catch (err) {
      if (err instanceof OverlayLimitError) {
        res.status(409).json({ error: err.message, code: 'too_many_overlays' });
        return;
      }
      throw err;
    }

    void deps.audit?.record({
      action: 'permission_overlay_set',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      detail: {
        overlayId: overlay.id,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(tool !== undefined ? { tool } : {}),
        action: overlay.action,
        ttlSeconds: ttl,
        ...(reason !== undefined ? { reason } : {}),
      },
    });

    res.status(201).json({ overlay });
  };

  const remove: RequestHandler = (req, res) => {
    const id = typeof req.params['id'] === 'string' ? req.params['id'] : '';
    if (!id) {
      res
        .status(400)
        .json({ error: 'overlay id is required', code: 'invalid_id' });
      return;
    }
    const removed = store.revoke(id);
    if (!removed) {
      res
        .status(404)
        .json({ error: 'overlay not found', code: 'overlay_not_found' });
      return;
    }
    void deps.audit?.record({
      action: 'permission_overlay_revoked',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      detail: { overlayId: id },
    });
    res.status(200).json({ ok: true, overlayId: id });
  };

  return { get, post, remove };
}
