/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Playwright harness for the manual viewer scripts (NOT a CI test).
 * Boots the real gateway (`createGatewayApp`) against the stub daemon, issues
 * an owner token and pre-seeds it into `localStorage['qwen-rc-token']`, and
 * launches headless Chromium (`CHROMIUM_PATH` overrides the browser binary).
 *
 * The page is returned un-navigated: callers `page.goto(url + '/ui/')` (or a
 * route of their own) after attaching whatever listeners/CDP sessions they
 * need. `url` is the gateway origin, e.g. `http://127.0.0.1:41234`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon } from '../../src/testing/stubDaemon.js';
import { TokenStore } from '../../src/tokenStore.js';
import { PairingService } from '../../src/pairing.js';
import { createGatewayApp } from '../../src/server.js';
import { UiPrefsStore } from '../../src/uiPrefsStore.js';

/**
 * `_meta` is the envelope the real EventBus stamps when it publishes
 * (`serverTimestamp`, `usage`). The stub echoes it verbatim, so a page scenario
 * can drive a send time without inventing a clock inside the ACP payload.
 */
export type Frame = {
  id: number;
  type: string;
  data: unknown;
  _meta?: Record<string, unknown>;
};

export interface BootViewerOptions {
  /** Frames the stub daemon replays on /session/:id/events. */
  frames?: Frame[];
  /** Keep the stub's SSE response open this long after the frames (ms). */
  holdOpenMs?: number;
  /** Status the stub answers POST /session/:id/prompt with (default 200). */
  promptStatus?: number;
  /**
   * Status the stub daemon answers a permission vote with. The gateway turns a
   * throw from the SDK into 502, so any non-2xx here reaches the page as a
   * failed vote, which is how a scenario drives the retry path.
   */
  permissionStatus?: number;
  /**
   * Body the stub serves on GET /session/:id/status. A card scenario sets this
   * to keep its request listed as pending, because the default body reports no
   * pending interactions and the page's 5s sweep would retire the card on its
   * own, leaving the vote path untested.
   */
  sessionStatus?: unknown;
  /** ms the stub holds a prompt open before answering (models a long turn). */
  promptDelayMs?: number;
  /**
   * Body the stub serves on GET /session/:id/transcript. Left unset it serves
   * its own default page; a scenario that asserts a specific number of paged
   * rows sets this, because otherwise it would be measuring whatever the stub
   * happened to invent rather than what it asked for.
   */
  transcriptPage?: unknown;
  /** Status the stub answers GET /session/:id/transcript with (default 200). */
  transcriptStatusCode?: number;
}

export interface Viewer {
  page: Page;
  /** Gateway origin, without a trailing slash. */
  url: string;
  /** A session id the page can `startWatch()` (the stub serves any id). */
  sessionId: string;
  close(): Promise<void>;
}

export const SESSION_ID = '11111111-2222-3333-4444-555555555555';

export async function bootViewer(
  opts: BootViewerOptions = {},
): Promise<Viewer> {
  const stub = await startStubDaemon({
    frames: opts.frames,
    holdOpenMs: opts.holdOpenMs,
    promptStatus: opts.promptStatus,
    permissionStatus: opts.permissionStatus,
    sessionStatus: opts.sessionStatus,
    promptDelayMs: opts.promptDelayMs,
    transcriptPage: opts.transcriptPage,
    transcriptStatusCode: opts.transcriptStatusCode,
  });
  const dir = mkdtempSync(join(tmpdir(), 'rc-viewer-'));
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const { token } = await store.issue(['owner'], 'viewer-harness');
  const { app } = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(dir, 'audit.log'),
    // The page reads /rc/ui-prefs at boot. Left unmounted, every scenario
    // would silently run the fallback path and the saved-zone feature could
    // never be observed, so the harness carries it the way cli.ts does.
    uiPrefs: await UiPrefsStore.open(join(dir, 'ui-prefs.json')),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const browser = await chromium.launch({
    args: ['--enable-precise-memory-info'],
    executablePath: process.env['CHROMIUM_PATH'] || undefined,
  });
  // An explicit context rather than browser.newPage(), which would create an
  // implicit one that refuses a second page. A scenario that needs two windows
  // on the same origin takes them from page.context(): they then share
  // localStorage and do not share sessionStorage, which is the seam #50 turns
  // on. Separate contexts would not model it, since each gets its own storage.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('qwen-rc-token', t);
  }, token);

  let closed = false;
  return {
    page,
    url,
    sessionId: SESSION_ID,
    async close() {
      if (closed) return;
      closed = true;
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
