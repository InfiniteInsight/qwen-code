/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  LOGIN_ITEM_ARGS,
  parseLaunchFlags,
  shouldHideInsteadOfClose,
  shouldQuitOnWindowClosed,
  summarizeError,
  trayMenuSpec,
} from './appLifecycle.js';

describe('parseLaunchFlags', () => {
  it('is visible by default', () => {
    expect(parseLaunchFlags([])).toEqual({ hidden: false });
    expect(parseLaunchFlags(['.'])).toEqual({ hidden: false });
  });

  it('starts hidden for the login-item launch, in any of its spellings', () => {
    for (const flag of ['--hidden', '/hidden', '-hidden', '--autostart']) {
      expect(parseLaunchFlags(['C:\\app\\Launcher.exe', flag]).hidden).toBe(
        true,
      );
    }
  });

  it('ignores case, as Windows does', () => {
    expect(parseLaunchFlags(['--HIDDEN']).hidden).toBe(true);
  });

  it('registers the login item with the hidden flag, so a boot never pops a window', () => {
    expect(parseLaunchFlags([...LOGIN_ITEM_ARGS]).hidden).toBe(true);
  });
});

describe('shouldHideInsteadOfClose', () => {
  it('hides while a tray can bring the window back', () => {
    expect(
      shouldHideInsteadOfClose({ trayAvailable: true, quitting: false }),
    ).toBe(true);
  });

  it('lets the window close when there is no tray to show it again', () => {
    expect(
      shouldHideInsteadOfClose({ trayAvailable: false, quitting: false }),
    ).toBe(false);
  });

  it('lets it close during a real quit, or a hidden window is unrecoverable', () => {
    expect(
      shouldHideInsteadOfClose({ trayAvailable: true, quitting: true }),
    ).toBe(false);
  });
});

describe('shouldQuitOnWindowClosed', () => {
  it('quits with no tray, which is the pre-tray behaviour', () => {
    expect(
      shouldQuitOnWindowClosed({ platform: 'win32', trayAvailable: false }),
    ).toBe(true);
  });

  it('stays alive with a tray — the terminal drain must outlive the window', () => {
    expect(
      shouldQuitOnWindowClosed({ platform: 'win32', trayAvailable: true }),
    ).toBe(false);
  });

  it('never quits on an empty dock', () => {
    expect(
      shouldQuitOnWindowClosed({ platform: 'darwin', trayAvailable: false }),
    ).toBe(false);
  });
});

describe('summarizeError', () => {
  it('keeps the reason, not the argv Node repeats', () => {
    expect(
      summarizeError(
        'Command failed: wt.exe new-tab --title qwen wsl.exe\r\nAccess is denied.',
      ),
    ).toBe('Access is denied.');
  });

  it('passes a one-line spawn failure through', () => {
    expect(summarizeError('spawn wt.exe ENOENT')).toBe('spawn wt.exe ENOENT');
  });

  it('fits the menu', () => {
    expect(summarizeError('x'.repeat(500)).length).toBeLessThanOrEqual(90);
  });
});

describe('trayMenuSpec', () => {
  it('offers the login item only for a packaged build', () => {
    expect(trayMenuSpec({ packaged: true, loginItemEnabled: false })).toEqual({
      openLabel: 'Show Qwen Remote Launcher',
      quitLabel: 'Quit',
      loginItemLabel: 'Launch at login',
      loginItemChecked: false,
    });
  });

  it('omits it when unpackaged, which would register Electron itself', () => {
    const spec = trayMenuSpec({ packaged: false, loginItemEnabled: true });
    expect(spec.loginItemLabel).toBeUndefined();
    expect(spec.loginItemChecked).toBe(false);
  });

  it('reflects the OS state in the checkbox', () => {
    expect(
      trayMenuSpec({ packaged: true, loginItemEnabled: true }).loginItemChecked,
    ).toBe(true);
  });
});
