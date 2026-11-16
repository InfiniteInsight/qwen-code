/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { HostTabRegistry } from '../hostTabs.js';
import type { WatchPresence } from '../webpush/watchPresence.js';

export interface ActiveSessionDeps {
  watchPresence: WatchPresence;
  hostTabs?: HostTabRegistry;
}

/**
 * GET /rc/sessions/active (#113).
 *
 * OWNER-scoped server-side pointer to whichever conversation is currently live
 * on the host terminal (`qwen-rc attach`) or actively watched over SSE on
 * another device. Lets a phone or second browser profile with no local pointer
 * (or a stale local pointer) discover the live conversation immediately instead
 * of starting a disconnected session.
 */
export function createSessionActiveRoute(
  deps: ActiveSessionDeps,
): RequestHandler {
  return async (_req, res) => {
    let liveTab: { sessionId: string; cwd: string; startedAt: number } | null =
      null;
    if (deps.hostTabs) {
      try {
        const tabs = await deps.hostTabs.list();
        const found = tabs.find((t) => t.state === 'live');
        if (found) {
          liveTab = {
            sessionId: found.sessionId,
            cwd: found.cwd,
            startedAt: found.startedAt,
          };
        }
      } catch {
        liveTab = null;
      }
    }

    const watched = deps.watchPresence.mostRecentWatched();

    if (liveTab && (!watched || liveTab.startedAt >= watched.joinedAt)) {
      res.status(200).set('Cache-Control', 'no-store').json({
        active: {
          sessionId: liveTab.sessionId,
          cwd: liveTab.cwd,
          source: 'host_tab',
          watcherCount: deps.watchPresence.watcherCount(liveTab.sessionId),
        },
      });
      return;
    }

    if (watched) {
      const tabCwd =
        liveTab && liveTab.sessionId === watched.sessionId
          ? liveTab.cwd
          : undefined;
      res.status(200).set('Cache-Control', 'no-store').json({
        active: {
          sessionId: watched.sessionId,
          ...(tabCwd ? { cwd: tabCwd } : {}),
          source:
            liveTab && liveTab.sessionId === watched.sessionId
              ? 'host_tab'
              : 'watch',
          watcherCount: watched.watcherCount,
        },
      });
      return;
    }

    res.status(200).set('Cache-Control', 'no-store').json({ active: null });
  };
}
