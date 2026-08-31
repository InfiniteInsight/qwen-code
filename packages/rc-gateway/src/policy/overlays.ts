/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Policy, PolicyAction, PolicyRule } from './loader.js';

/**
 * Session-scoped permission overlays (issue #33). A TTL-bound rule set that
 * an operator can set from the dashboard to override the file-based policy
 * for a bounded period — "deny `web_fetch` just for this session", "allow
 * everything for 5 minutes while I test".
 *
 * **Ephemeral by design:** the store is in-memory only. Overlays live for the
 * life of the gateway process AND their TTL — a restart drops all of them
 * (fail-closed: the file policy is the only durable source of truth).
 *
 * **Bounded by design:** every overlay MUST carry a future `expiresAt`; the
 * route enforces a 24h maximum TTL. `list()` prunes expired entries lazily,
 * so an overlay that has expired is inert even before it is pruned.
 */

/** One ephemeral override. */
export interface PermissionOverlay {
  /** Stable id (`overlay-<uuid>`); audited as `overlayId` / `ruleId`. */
  id: string;
  /** Bound to one session; `undefined` = applies to all sessions. */
  sessionId?: string;
  /** Normalized tool kind to match; `undefined` = any tool. */
  tool?: string;
  action: PolicyAction;
  /** Epoch ms at which the overlay auto-expires (always set, always future at creation). */
  expiresAt: number;
  /** Optional short operator note (audited, echoed in the UI). */
  reason?: string;
  /** Epoch ms of creation. */
  createdAt: number;
}

/** Hard cap on concurrent overlays (protects the synthesized-policy scan). */
export const OVERLAY_CAP = 50;

/** Thrown by {@link PermissionOverlayStore.add} when the cap is reached. */
export class OverlayLimitError extends Error {
  constructor() {
    super(`too many active overlays (max ${OVERLAY_CAP})`);
    this.name = 'OverlayLimitError';
  }
}

/**
 * In-memory overlay store shared by the permission-overlay routes and the
 * {@link PolicyEnforcer} (issue #33). Not concurrency-safe beyond the JS
 * event-loop model: every method is synchronous, and the enforcer's overlay
 * evaluation runs without an `await` between the read and the vote, so a
 * decision never observes a torn state.
 */
export class PermissionOverlayStore {
  private readonly overlays = new Map<string, PermissionOverlay>();

  /**
   * Add an overlay. `expiresAt` MUST be strictly in the future at `nowMs`
   * (the route validates the TTL; the store re-checks so a direct caller
   * cannot create an already-expired rule). Throws {@link OverlayLimitError}
   * when the cap is reached (after pruning expired entries — an operator
   * whose overrides all lapsed can still add new ones).
   */
  add(
    entry: Omit<PermissionOverlay, 'id' | 'createdAt'>,
    nowMs: number,
  ): PermissionOverlay {
    this.prune(nowMs);
    if (this.overlays.size >= OVERLAY_CAP) throw new OverlayLimitError();
    if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= nowMs) {
      throw new Error('overlay expiresAt must be a finite future instant');
    }
    const overlay: PermissionOverlay = {
      ...entry,
      id: `overlay-${randomUUID()}`,
      createdAt: nowMs,
    };
    this.overlays.set(overlay.id, overlay);
    return overlay;
  }

  /** Remove by id. Returns true iff an (unexpired) overlay was removed. */
  revoke(id: string, nowMs: number = Date.now()): boolean {
    this.prune(nowMs);
    return this.overlays.delete(id);
  }

  /** All active overlays, newest first (expired entries pruned as a side effect). */
  list(nowMs: number = Date.now()): PermissionOverlay[] {
    this.prune(nowMs);
    return [...this.overlays.values()].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  }

  /**
   * Synthesize the per-session overlay policy for the enforcer: the active
   * overlays that apply to `sessionId` (bound overlays for THAT session, plus
   * all session-unbound overlays) rendered as a standalone {@link Policy}.
   *
   * The evaluator's `source === 'policy'` is the "an overlay rule matched"
   * discriminator — the enforcer falls back to the file policy whenever no
   * overlay rule matches (defaults action `prompt`, source `default`).
   *
   * `expiresAt` is rendered as an ISO STRING: `parseExpiresAt` accepts strings
   * only, and a non-string would classify as `malformed-expiresAt` (unevaluable
   * → safety downgrade → prompt), silently neutering every overlay.
   * Overlays never offer `maxPerWindow` (the route cannot set one), so the
   * enforcer evaluates this policy without the quota oracle.
   */
  policyFor(sessionId: string, nowMs: number = Date.now()): Policy {
    this.prune(nowMs);
    const rules: PolicyRule[] = [];
    for (const ov of this.overlays.values()) {
      if (ov.sessionId !== undefined && ov.sessionId !== sessionId) continue;
      rules.push({
        id: ov.id,
        match: ov.tool ? { tool: ov.tool } : {},
        action: ov.action,
        expiresAt: new Date(ov.expiresAt).toISOString(),
        ...(ov.reason ? { reason: ov.reason } : {}),
      });
    }
    return {
      defaults: { action: 'prompt', requireScope: 'approve' },
      rules,
    };
  }

  /** Drop expired entries. Pure bookkeeping; called by every public method. */
  private prune(nowMs: number): void {
    for (const [id, ov] of this.overlays) {
      if (nowMs >= ov.expiresAt) this.overlays.delete(id);
    }
  }
}
