/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tray presence (issue #49 follow-up).
 *
 * The terminal drain in `main.ts` has to outlive the window, so the app needs a
 * surface that exists without one. On Windows a left click on the tray icon
 * fires `click` and a right click opens the context menu, which gives the usual
 * arrangement: click to bring the window back, right-click for the menu.
 *
 * It is also the only output this app has. A packaged Windows build has no
 * console, so a refused `wt` launch would otherwise be invisible — hence the
 * status line at the top of the menu.
 */
import { Menu, Tray, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { trayMenuSpec } from './appLifecycle.js';

/** What the tray can ask the app to do. */
export interface TrayHost {
  /** Bring the window back, creating it if the app started hidden. */
  show: () => void;
  /** Leave the app for real (the only path that ends the terminal drain). */
  quit: () => void;
}

/** Login-item state, read from and written to the OS. */
export interface LoginItemControl {
  get: () => boolean;
  set: (enabled: boolean) => void;
}

export interface TrayOptions {
  /** `.ico` on Windows; the tray needs a real icon or it is invisible. */
  iconPath: string;
  tooltip: string;
  host: TrayHost;
  /** Omit when a login item cannot be registered (an unpackaged run). */
  loginItem?: LoginItemControl;
  /** What to show at the top of the menu: idle state, or the last failure. */
  note?: () => string | undefined;
}

/** Redraws the menu once the status note has changed. */
export interface TrayHandle {
  refresh: () => void;
}

/**
 * Create the tray, or `undefined` when no usable icon is available.
 *
 * Returning rather than throwing is deliberate: a missing icon must not take
 * the whole app down, and the caller falls back to quit-on-window-close, which
 * is the pre-tray behaviour. The handle keeps the `Tray` alive by closing over
 * it — an unreferenced Tray would be collected and the icon would vanish.
 */
export function createTray(opts: TrayOptions): TrayHandle | undefined {
  if (!existsSync(opts.iconPath)) return undefined;
  const image = nativeImage.createFromPath(opts.iconPath);
  if (image.isEmpty()) return undefined;

  const tray = new Tray(image);

  const setMenu = (): void => {
    const note = opts.note?.();
    tray.setToolTip(note ? `${opts.tooltip} — ${note}` : opts.tooltip);
    const spec = trayMenuSpec({
      packaged: !!opts.loginItem,
      loginItemEnabled: opts.loginItem?.get() ?? false,
    });
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (note) template.push({ label: note, enabled: false });
    template.push({ label: spec.openLabel, click: () => opts.host.show() });
    if (spec.loginItemLabel && opts.loginItem) {
      const control = opts.loginItem;
      template.push({
        label: spec.loginItemLabel,
        type: 'checkbox',
        checked: spec.loginItemChecked,
        click: (item) => {
          control.set(item.checked);
          // Reflect what the OS actually holds now, in case the write was
          // refused (group policy, non-writable Run key).
          setMenu();
        },
      });
    }
    template.push({ label: spec.quitLabel, click: () => opts.host.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };
  setMenu();

  tray.on('click', () => opts.host.show());
  return { refresh: setMenu };
}
