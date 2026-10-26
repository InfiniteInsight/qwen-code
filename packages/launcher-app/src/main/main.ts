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
import { createTray, type TrayHandle } from './tray.js';
import {
  LOGIN_ITEM_ARGS,
  parseLaunchFlags,
  shouldHideInsteadOfClose,
  shouldQuitOnWindowClosed,
  summarizeError,
  terminalDrainNote,
  TRAY_IDLE_NOTE,
} from './appLifecycle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** How often to check the gateway's host-terminal request log (issue #49). */
const TERMINAL_POLL_MS = 4000;

/**
 * Must match `appId` in electron-builder.yml. Windows keys taskbar grouping and
 * toast ownership off this, so leaving it unset files the tray under "Electron".
 */
const APP_USER_MODEL_ID = 'com.qwen-code.launcher-app';

/** Packaged: `app.asar/assets/icon.ico`. Dev: `launcher-app/assets/icon.ico`. */
const ICON_PATH = join(__dirname, '../../assets/icon.ico');

const launchFlags = parseLaunchFlags(process.argv.slice(1));

// The tray handle must stay referenced: it closes over the Tray, and an
// unreferenced one would be collected, taking the icon with it.
let tray: TrayHandle | undefined;
let mainWindow: BrowserWindow | undefined;
let isQuitting = false;

/**
 * Top tray line. A packaged app has no console, so this is the only way the
 * drain can say anything — including when it is refusing to work.
 */
let terminalNote = TRAY_IDLE_NOTE;

function setTerminalNote(note: string): void {
  if (note === terminalNote) return;
  terminalNote = note;
  tray?.refresh();
}

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
      setTerminalNote(terminalDrainNote(out));
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      // eslint-disable-next-line no-console
      console.warn(`terminal poll: ${message}`);
      setTerminalNote(`poll failed: ${summarizeError(message)}`);
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
    // The login-item launch carries `--hidden`: an autostart must not drop a
    // window on the desktop every time the machine boots.
    show: !launchFlags.hidden,
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

  // With a tray, closing the window is "put it away", not "leave": the terminal
  // drain must keep running. Hiding rather than destroying also keeps the
  // renderer's IPC surface and its own polling alive.
  win.on('close', (event) => {
    if (
      !shouldHideInsteadOfClose({ trayAvailable: !!tray, quitting: isQuitting })
    ) {
      return;
    }
    event.preventDefault();
    persistBounds();
    win.hide();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
  });

  return win;
}

/** Show the window, creating it on first use (the app may have started hidden). */
function showWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = createWindow();
}

function quit(): void {
  isQuitting = true;
  app.quit();
}

function installTray(): void {
  tray = createTray({
    iconPath: ICON_PATH,
    tooltip: 'Qwen Remote Launcher',
    host: { show: showWindow, quit },
    note: () => terminalNote,
    // Only a packaged build can register itself; `electron .` would register
    // Electron rather than this app.
    loginItem: app.isPackaged
      ? {
          get: () => app.getLoginItemSettings().openAtLogin,
          set: (enabled) =>
            app.setLoginItemSettings({
              openAtLogin: enabled,
              args: [...LOGIN_ITEM_ARGS],
            }),
        }
      : undefined,
  });
}

// Two launchers means two drains, each with its own idea of which sessions
// already have a tab, so an autostart racing a manual launch would open the
// same tab twice.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

  void app.whenReady().then(() => {
    installTray();
    if (!launchFlags.hidden) showWindow();
    startTerminalPolling();

    app.on('activate', () => showWindow());
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (
    shouldQuitOnWindowClosed({
      platform: process.platform,
      trayAvailable: !!tray,
    })
  ) {
    app.quit();
  }
});
