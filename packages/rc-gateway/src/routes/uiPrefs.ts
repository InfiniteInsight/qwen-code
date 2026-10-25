/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import { DEFAULT_STAMP_ZONE, type UiPrefsStore } from '../uiPrefsStore.js';

/**
 * The response shape for both endpoints. `stampZone` is the EFFECTIVE zone (what
 * the caller's rows will actually be rendered in), so a client never has to
 * reproduce the default to know what it will see. `saved` says whether that came
 * from a choice this token made or from the default, which is what lets the
 * Settings control show "reset to default" honestly rather than always.
 */
function body(store: UiPrefsStore, tokenId: string) {
  const saved = store.get(tokenId).stampZone;
  return {
    stampZone: saved ?? DEFAULT_STAMP_ZONE,
    saved: saved !== undefined,
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
  // Anything else shape-wise is a 400, not a silent ignore — a client that
  // meant to change the zone and got a 200 would believe it had.
  router.put('/', async (req, res) => {
    const body_ = (req.body ?? {}) as { stampZone?: unknown };
    if (!('stampZone' in body_)) {
      res
        .status(400)
        .json({ error: 'stampZone is required', code: 'invalid_zone' });
      return;
    }
    const raw = body_.stampZone;
    if (raw !== null && typeof raw !== 'string') {
      res.status(400).json({ error: 'Invalid timezone', code: 'invalid_zone' });
      return;
    }
    const zone = raw === null ? undefined : raw;
    const ok = await store.setStampZone(req.rcClient!.id, zone);
    if (!ok) {
      res.status(400).json({
        error: 'Not a usable IANA timezone',
        code: 'invalid_zone',
      });
      return;
    }
    void audit?.record({
      action: 'ui_prefs_set',
      actorTokenId: req.rcClient!.id,
      shareId: req.rcClient?.shareId,
      shareLabel: req.rcClient?.shareLabel,
      detail: { stampZone: zone ?? DEFAULT_STAMP_ZONE },
    });
    res.json(body(store, req.rcClient!.id));
  });

  return router;
}
