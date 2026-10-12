/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Launch and close decisions (issue #49 follow-up).
 *
 * The host-terminal drain only works while this app is running, and it has to
 * keep running after the window is shut — a conversation opened from a phone
 * still needs its tab. So the app lives in the tray and the window is just a
 * view. These are the pure decisions behind that; the Electron wiring is in
 * `tray.ts` (kept out of here so this stays unit-testable without Electron).
 */

/** Launch flags this app understands. */
export interface LaunchFlags {
  /** Start with no window — the login-item launch. */
  hidden: boolean;
}

/**
 * Args registered on the login item, so an autostart never pops a window over
 * the user's desktop. This is the only thing that launches the app hidden, so
 * the flag's whole purpose is visible from here.
 */
export const LOGIN_ITEM_ARGS: readonly string[] = ['--hidden'];

/**
 * Parse launch flags. `/hidden` and `-hidden` are accepted alongside
 * `--hidden` because a Windows Run-key or Task Scheduler entry is commonly
 * written in PowerShell style.
 */
export function parseLaunchFlags(argv: readonly string[]): LaunchFlags {
  const seen = new Set(argv.map((a) => a.toLowerCase()));
  return {
    hidden: ['--hidden', '/hidden', '-hidden', '--autostart'].some((f) =>
      seen.has(f),
    ),
  };
}

/**
 * Whether a window-close should be swallowed in favour of hiding.
 *
 * Only while there is a tray: without one, a hidden window is unrecoverable,
 * so closing has to mean leaving.
 */
export function shouldHideInsteadOfClose(opts: {
  trayAvailable: boolean;
  quitting: boolean;
}): boolean {
  return opts.trayAvailable && !opts.quitting;
}

/**
 * Whether the last window closing should end the app. The inverse case above:
 * no tray means no way back in. macOS keeps running on an empty dock by
 * convention, so it never quits here.
 */
export function shouldQuitOnWindowClosed(opts: {
  platform: NodeJS.Platform;
  trayAvailable: boolean;
}): boolean {
  if (opts.platform === 'darwin') return false;
  return !opts.trayAvailable;
}

/** What the tray menu should offer, decided without touching Electron. */
export interface TrayMenuSpec {
  openLabel: string;
  quitLabel: string;
  /** Omitted when a login item cannot be registered: an unpackaged run would
   * register Electron itself, not this app. */
  loginItemLabel?: string;
  loginItemChecked: boolean;
}

/** Labels for the tray menu. */
export const TRAY_LABELS = {
  open: 'Show Qwen Remote Launcher',
  loginItem: 'Launch at login',
  quit: 'Quit',
} as const;

/** Shown while the drain is healthy, so a working app is not indistinguishable
 * from a stuck one. */
export const TRAY_IDLE_NOTE = 'Watching for conversations';

/**
 * Shorten a child-process failure for the tray's single status line.
 *
 * Node prefixes these with `Command failed: <full argv>` and repeats the argv
 * inside stderr, which would push the actual reason off the menu.
 */
export function summarizeError(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? raw.trim();
  return last.length > 90 ? `${last.slice(0, 89)}…` : last;
}

/** Decide the tray menu's contents for the current app state. */
export function trayMenuSpec(opts: {
  packaged: boolean;
  loginItemEnabled: boolean;
}): TrayMenuSpec {
  if (!opts.packaged) {
    return {
      openLabel: TRAY_LABELS.open,
      quitLabel: TRAY_LABELS.quit,
      loginItemChecked: false,
    };
  }
  return {
    openLabel: TRAY_LABELS.open,
    quitLabel: TRAY_LABELS.quit,
    loginItemLabel: TRAY_LABELS.loginItem,
    loginItemChecked: opts.loginItemEnabled,
  };
}
