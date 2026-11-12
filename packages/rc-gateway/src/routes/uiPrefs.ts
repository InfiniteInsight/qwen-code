/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import {
  DEFAULT_HIDE_THREADS,
  DEFAULT_STAMP_ZONE,
  type UiPrefsStore,
} from '../uiPrefsStore.js';

/**
 * The response shape for both endpoints. `stampZone` is the EFFECTIVE zone (what
 * the caller's rows will actually be rendered in), so a client never has to
 * reproduce the default to know what it will see. `saved` says whether that came
 * from a choice this token made or from the default, which is what lets the
 * Settings control show "reset to default" honestly rather than always.
 * `hideThreads` is the effective value too, and its presence in the answer is how
 * a page knows this gateway supports the setting.
 */
function body(store: UiPrefsStore, tokenId: string) {
  const saved = store.get(tokenId).stampZone;
  return {
    stampZone: saved ?? DEFAULT_STAMP_ZONE,
    saved: saved !== undefined,
    hideThreads: store.get(tokenId).hideThreads ?? DEFAULT_HIDE_THREADS,
  };
}

/**
 * Viewer display preferences, mounted under /rc/ui-prefs (so paths are / and
 * nothing deeper). The mount site applies requireScope(SESSION_READ).
 *
 * Keyed by the CALLER's token and read-only as to anyone else's record, so the
 * write half sits at the same read floor as the push prefs PATCH rather than at
 * WRITE: changing how your own rows are rendered cannot affect another client,
 * and gating it behind WRITE would lock a share token out of its own display.
 *
 * The zone is validated by the store before it is persisted, so an unusable name
 * is a 400 and never reaches a formatter.
 */
export function createUiPrefsRouter(
  store: UiPrefsStore,
  audit?: AuditRecorder,
): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(body(store, req.rcClient!.id));
  });

  // `stampZone` as a string sets it; as null it clears back to the default.
  // `hideThreads` as a boolean sets it; as null it clears back to the default.
  // A PUT may name either or both. Anything else shape-wise is a 400, not a
  // silent ignore: a client that meant to change a setting and got a 200 would
  // believe it had. Both fields are checked before either is written, so a bad
  // value for one never half-applies the other.
  router.put('/', async (req, res) => {
    const body_ = (req.body ?? {}) as {
      stampZone?: unknown;
      hideThreads?: unknown;
    };
    const namesZone = 'stampZone' in body_;
    const namesHide = 'hideThreads' in body_;
    if (!namesZone && !namesHide) {
      res.status(400).json({
        error: 'stampZone or hideThreads is required',
        code: 'invalid_zone',
      });
      return;
    }
    const rawZone = body_.stampZone;
    if (namesZone && rawZone !== null && typeof rawZone !== 'string') {
      res.status(400).json({ error: 'Invalid timezone', code: 'invalid_zone' });
      return;
    }
    const rawHide = body_.hideThreads;
    if (namesHide && rawHide !== null && typeof rawHide !== 'boolean') {
      res.status(400).json({
        error: 'hideThreads must be a boolean or null',
        code: 'invalid_hide_threads',
      });
      return;
    }
    const tokenId = req.rcClient!.id;
    const detail: Record<string, unknown> = {};
    if (namesZone) {
      const zone = rawZone === null ? undefined : (rawZone as string);
      // setStampZone validates before it writes, so a rejected zone leaves the
      // store (and therefore hideThreads, if also named) untouched.
      const ok = await store.setStampZone(tokenId, zone);
      if (!ok) {
        res.status(400).json({
          error: 'Not a usable IANA timezone',
          code: 'invalid_zone',
        });
        return;
      }
      detail.stampZone = zone ?? DEFAULT_STAMP_ZONE;
    }
    if (namesHide) {
      const hide = rawHide === null ? undefined : (rawHide as boolean);
      await store.setHideThreads(tokenId, hide);
      detail.hideThreads = hide ?? DEFAULT_HIDE_THREADS;
    }
    void audit?.record({
      action: 'ui_prefs_set',
      actorTokenId: tokenId,
      shareId: req.rcClient?.shareId,
      shareLabel: req.rcClient?.shareLabel,
      detail,
    });
    res.json(body(store, tokenId));
  });

  return router;
}
