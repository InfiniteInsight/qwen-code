/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonCapabilities } from '@qwen-code/sdk';
import { RC_PROTOCOL_VERSION } from '../mdns/advert.js';
import type { NativeShellsCapability } from '../nativePush/nativeShells.js';

/**
 * How long discovery waits for the daemon's own list before answering without
 * it. The SDK's own fetch timeout is 30s, which is far too long to sit in
 * front of a page load: this route is what the viewer awaits before it shows
 * anything.
 */
const DEFAULT_DAEMON_BUDGET_MS = 2000;

async function readDaemonStatus(
  read: () => Promise<DaemonCapabilities>,
  budgetMs: number,
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const caps = await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('budget')), budgetMs);
      }),
    ]);
    // Marker last: a daemon field must not be able to shadow it.
    return { ...caps, available: true };
  } catch {
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /rc/capabilities — the gateway's capability surface. The daemon's own
 * `/capabilities` is un-editable under the fork boundary, so the gateway serves
 * its own `remoteControl` block. Always mounted (mDNS reports here even when cost
 * tracking is off); any authenticated token; no secrets.
 *
 * Composes optional sub-blocks from deps:
 *  - `costTracking` — only when a usage store is wired (`add-cost-tracking`).
 *  - `mdns` — `{ advertising, instanceName? }` (`add-mdns-discovery`); the spec's
 *    `version` is sourced from {@link RC_PROTOCOL_VERSION}, the same constant the
 *    mDNS TXT record advertises, so the two never drift.
 *
 * `workspaceControl` is STATIC: the `/rc/workspace/*` routes are always
 * mounted, so the gateway always offers the surface. The flags exist so an
 * older UI can degrade gracefully and so a future gateway can disable a
 * sub-surface without removing the routes.
 *
 * The daemon's own list is passed through VERBATIM under `remoteControl.daemon`
 * (#96). Nothing here names a single flag: a hand-picked field list is how the
 * surface got narrow in the first place, since each capability would then have
 * to be carried across the boundary by hand twice. A flag the daemon adds
 * tomorrow therefore reaches the UI with no gateway edit. The envelope is
 * copied rather than summarized for the same reason.
 *
 * The daemon read is bounded by {@link DEFAULT_DAEMON_BUDGET_MS} and never
 * turns this response into a 5xx: the block is what mDNS reports and what an
 * older UI refuses to render without, so a daemon that is down or slow must
 * cost the daemon's list and nothing else. Absence of the list is reported as
 * `daemon: { available: false }` rather than by omitting the key, so a UI can
 * tell "the daemon supports nothing" apart from "we could not ask" — the
 * second must not hide the sections that only the gateway serves.
 */
export function createCapabilityRoute(deps: {
  costTracking?: { currencyLabel: () => string };
  mdnsStatus?: () => { advertising: boolean; instanceName?: string };
  nativeShells?: () => NativeShellsCapability;
  /** Read of the daemon's own `/capabilities` envelope (see #96). */
  daemonStatus?: () => Promise<DaemonCapabilities>;
  /** Test seam for the daemon read's bound. */
  daemonBudgetMs?: number;
}): RequestHandler {
  return async (req, res) => {
    if (!req.rcClient) {
      res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      return;
    }
    const remoteControl: Record<string, unknown> = {
      version: RC_PROTOCOL_VERSION,
      supportedTransports: ['sse', 'ws'],
      supportedScopes: ['owner', 'write', 'approve', 'read'],
      pairingEnabled: true,
      auditEnabled: true,
      walHorizonSec: 86400,
      walMaxEvents: 10000,
      workspaceControl: {
        permissions: true,
        trust: true,
        tools: true,
        mcp: true,
      },
      // #190: /rc/sessions/live-state takes `spawn=0`. The page is served
      // from public/ on disk, so a new page can meet a gateway still running
      // the old route, which ignores the switch and starts a daemon for every
      // folder it is asked about. The page reads other folders only when this
      // says the switch is honoured.
      liveStateNoSpawn: true,
    };
    if (deps.costTracking) {
      remoteControl.costTracking = {
        enabled: true,
        currencyLabel: deps.costTracking.currencyLabel(),
        rateTablePath: '~/.qwen/rc/model-rates.yaml',
      };
    }
    if (deps.mdnsStatus) {
      const m = deps.mdnsStatus();
      remoteControl.mdns = m.advertising
        ? { advertising: true, instanceName: m.instanceName }
        : { advertising: false };
    }
    if (deps.nativeShells) {
      remoteControl.nativeShells = deps.nativeShells();
    }
    if (deps.daemonStatus) {
      remoteControl.daemon = await readDaemonStatus(
        deps.daemonStatus,
        deps.daemonBudgetMs ?? DEFAULT_DAEMON_BUDGET_MS,
      );
    }
    res.status(200).json({ remoteControl });
  };
}
