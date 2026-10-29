/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_STAMP_ZONE, UiPrefsStore } from './uiPrefsStore.js';
import { isValidTimeZone } from './policy/conditions.js';
import { BIG, observeDuringWrite, parsesAsJson } from './testing/tornRead.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'rc-uiprefs-')), 'ui-prefs.json');
}

describe('#165 UiPrefsStore crash-safe persistence', () => {
  it('a reader never sees a torn prefs file while a persist is in flight', async () => {
    const path = tempPath();
    // A big existing file, so the next persist spans many event-loop turns.
    writeFileSync(
      path,
      JSON.stringify({ byToken: { big: { stampZone: 'UTC', pad: BIG } } }),
    );
    const store = await UiPrefsStore.open(path);
    const { reads, torn } = await observeDuringWrite(
      path,
      () => store.setStampZone('tokA', 'Europe/Paris'),
      parsesAsJson,
    );
    expect(reads).toBeGreaterThan(0);
    expect(torn).toBe(0);
    expect((await UiPrefsStore.open(path)).get('tokA').stampZone).toBe(
      'Europe/Paris',
    );
    expect(readdirSync(dirname(path))).toEqual(['ui-prefs.json']);
  });

  it('a corrupt file is logged and set aside', async () => {
    const path = tempPath();
    writeFileSync(path, '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await UiPrefsStore.open(path);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(
        readdirSync(dirname(path)).some((f) =>
          f.startsWith('ui-prefs.json.corrupt-'),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('UiPrefsStore', () => {
  it('reads a missing file as an empty store rather than failing to open', async () => {
    const store = await UiPrefsStore.open(tempPath());
    expect(store.get('tokA')).toEqual({});
  });

  it('reads a corrupt file as an empty store rather than throwing', async () => {
    const path = tempPath();
    writeFileSync(path, '{not json');
    const store = await UiPrefsStore.open(path);
    expect(store.get('tokA')).toEqual({});
  });

  it('get never returns undefined, so callers can read fields directly', async () => {
    const store = await UiPrefsStore.open(tempPath());
    expect(store.get('nobody')).toEqual({});
  });

  it('sets a zone, reports it, and it survives reopen', async () => {
    const path = tempPath();
    const store = await UiPrefsStore.open(path);

    expect(await store.setStampZone('tokA', 'Asia/Tokyo')).toBe(true);
    expect(store.get('tokA').stampZone).toBe('Asia/Tokyo');

    const reopened = await UiPrefsStore.open(path);
    expect(reopened.get('tokA').stampZone).toBe('Asia/Tokyo');
  });

  it('persists the file at mode 0600', async () => {
    const path = tempPath();
    const store = await UiPrefsStore.open(path);
    await store.setStampZone('tokA', 'Asia/Tokyo');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('writes the IANA name, not an abbreviation', async () => {
    const path = tempPath();
    const store = await UiPrefsStore.open(path);
    await store.setStampZone('tokA', 'America/New_York');
    expect(JSON.parse(readFileSync(path, 'utf8')).byToken.tokA.stampZone).toBe(
      'America/New_York',
    );
  });

  it('clearing removes the field so the record reads "use the default"', async () => {
    const path = tempPath();
    const store = await UiPrefsStore.open(path);
    await store.setStampZone('tokA', 'Asia/Tokyo');

    expect(await store.setStampZone('tokA', undefined)).toBe(true);
    // Absent rather than a stored copy of the default: the default is free to
    // change without stranding a stale value on every record.
    expect('stampZone' in store.get('tokA')).toBe(false);

    const reopened = await UiPrefsStore.open(path);
    expect('stampZone' in reopened.get('tokA')).toBe(false);
  });

  it('rejects an empty name, a made-up name, and an absurdly long one', async () => {
    const store = await UiPrefsStore.open(tempPath());
    expect(await store.setStampZone('tokA', '')).toBe(false);
    expect(await store.setStampZone('tokA', 'Mars/Olympus_Mons')).toBe(false);
    expect(await store.setStampZone('tokA', 'A'.repeat(65))).toBe(false);
    expect(store.get('tokA')).toEqual({});
  });

  it('a rejected write cannot blank a value that was already saved', async () => {
    const path = tempPath();
    const store = await UiPrefsStore.open(path);
    await store.setStampZone('tokA', 'Asia/Tokyo');

    expect(await store.setStampZone('tokA', 'Mars/Olympus_Mons')).toBe(false);
    expect(store.get('tokA').stampZone).toBe('Asia/Tokyo');

    // And the file on disk still holds the good value, not a half-written edit.
    const reopened = await UiPrefsStore.open(path);
    expect(reopened.get('tokA').stampZone).toBe('Asia/Tokyo');
  });

  it("keys per token, so one device cannot read another's choice", async () => {
    const store = await UiPrefsStore.open(tempPath());
    await store.setStampZone('phone', 'Asia/Tokyo');
    expect(store.get('laptop')).toEqual({});
    expect(store.get('phone').stampZone).toBe('Asia/Tokyo');
  });

  it('accepts exactly the names the policy evaluator accepts', async () => {
    // The store and the time-of-day policy share one probe, so a zone that
    // would pass a policy check must also be storable here. If the two ever
    // grow separate validators this assertion is where the drift shows.
    const store = await UiPrefsStore.open(tempPath());
    for (const zone of ['America/New_York', 'Europe/Berlin', 'UTC']) {
      expect(isValidTimeZone(zone)).toBe(true);
      expect(await store.setStampZone('tokA', zone)).toBe(true);
    }
    for (const zone of ['', 'Not/A_Zone']) {
      expect(isValidTimeZone(zone)).toBe(false);
      expect(await store.setStampZone('tokA', zone)).toBe(false);
    }
    // 'EST' is accepted, and that is correct rather than a hole to plug: Intl
    // treats it as a usable zone, so someone who names it explicitly gets the
    // time they asked for. It is a FIXED offset, though (measured: EST renders
    // 12:00 in July where America/New_York renders 13:00 EDT), so it sits an
    // hour out for the months Eastern is on daylight time. That is why the
    // default and the Settings picker use canonical Region/City names and never
    // offer the abbreviation, rather than the validator trying to reject it.
    expect(isValidTimeZone('EST')).toBe(true);
  });

  it('the default is a real zone, since every unstamped row renders in it', async () => {
    expect(isValidTimeZone(DEFAULT_STAMP_ZONE)).toBe(true);
  });
});
