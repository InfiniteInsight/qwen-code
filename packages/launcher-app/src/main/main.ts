/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { app, BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc.js';
import { readAppConfig, writeAppConfig } from './appConfig.js';
import { realRunWsl } from './wsl.js';
import { drainTerminalRequests, realExecWt } from './terminalLauncher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** How often to check the gateway's host-terminal request log (issue #49). */
const TERMINAL_POLL_MS = 4000;

/**
 * Drain host-terminal requests into Windows Terminal tabs.
 *
 * This has to live in the main process rather than the renderer: the renderer
 * only exists while a window is open, and a tab should appear for a
 * conversation started from a phone whether or not this window is up.
 */
function startTerminalPolling(): void {
  // Sessions with a tab already open, for this app run only. Restarting the
  // launcher forgets them, which is correct — the old tabs are gone too.
  const openSessions = new Set<string>();
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // a slow `wt` launch must not let passes pile up
    running = true;
    try {
      const before = readAppConfig();
      const cursor = before.terminalCursor ?? 0;
      const out = await drainTerminalRequests(
        cursor,
        openSessions,
        { runWsl: realRunWsl(before.distro), execWt: realExecWt() },
        { distro: before.distro },
      );
      if (out.cursor !== cursor) {
        writeAppConfig({ ...readAppConfig(), terminalCursor: out.cursor });
      }
      for (const f of out.failed) {
        // eslint-disable-next-line no-console
        console.warn(`terminal ${f.id}: ${f.error}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`terminal poll: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), TERMINAL_POLL_MS);
}

function createWindow(): BrowserWindow {
  const config = readAppConfig();
  const bounds = config.windowBounds;

  const win = new BrowserWindow({
    width: bounds?.width ?? 960,
    height: bounds?.height ?? 720,
    x: bounds?.x,
    y: bounds?.y,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void win.loadFile(join(__dirname, '../renderer/index.html'));

  registerIpc(win);

  const persistBounds = (): void => {
    if (win.isDestroyed()) return;
    writeAppConfig({ ...readAppConfig(), windowBounds: win.getBounds() });
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  return win;
}

void app.whenReady().then(() => {
  createWindow();
  startTerminalPolling();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
