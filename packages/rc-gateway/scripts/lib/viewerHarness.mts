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

export type Frame = { id: number; type: string; data: unknown };

export interface BootViewerOptions {
  /** Frames the stub daemon replays on /session/:id/events. */
  frames?: Frame[];
  /** Keep the stub's SSE response open this long after the frames (ms). */
  holdOpenMs?: number;
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
  });
  const dir = mkdtempSync(join(tmpdir(), 'rc-viewer-'));
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const { token } = await store.issue(['owner'], 'viewer-harness');
  const { app } = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(dir, 'audit.log'),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const browser = await chromium.launch({
    args: ['--enable-precise-memory-info'],
    executablePath: process.env['CHROMIUM_PATH'] || undefined,
  });
  const page = await browser.newPage();
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
