/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readJsonStore, writeFileAtomic } from './atomicWrite.js';
import { isValidTimeZone } from './policy/conditions.js';

/**
 * What a row is stamped with when the viewer has saved nothing. The IANA name,
 * never the abbreviation: `EST` is a fixed offset and would sit an hour out for
 * the half of the year the Eastern zone is on EDT.
 */
export const DEFAULT_STAMP_ZONE = 'America/New_York';

/** Longest zone name accepted. The IANA database tops out well under this. */
const MAX_ZONE_LENGTH = 64;

export interface UiPrefs {
  /**
   * The zone message times are rendered in, or absent for "use the default".
   * Validated by {@link isValidTimeZone} before it is stored, so a stored value
   * always reaches `Intl.DateTimeFormat` without throwing.
   */
  stampZone?: string;
}

interface PersistShape {
  byToken: Record<string, UiPrefs>;
}

/**
 * Per-token display preferences, persisted as JSON at mode 0600. Modeled on
 * PushStore (private ctor + static async open).
 *
 * Keyed by token rather than stored once for the whole gateway because a display
 * zone describes where the READER is, not what the record holds. The same
 * person's phone and laptop can be in different zones, and the two are separate
 * tokens. This is the same reasoning that makes `quietHours.timezone`
 * per-subscription in PushStore rather than global.
 */
export class UiPrefsStore {
  private constructor(
    private readonly filePath: string,
    private readonly byToken: Record<string, UiPrefs>,
  ) {}

  static async open(filePath: string): Promise<UiPrefsStore> {
    let byToken: Record<string, UiPrefs> = {};
    // Missing/corrupt file → start empty, which reads as "everyone on the
    // default". A lost preference is a lost setting, not a wrong time; a
    // corrupt file is still logged and kept aside (#165).
    const parsed = (await readJsonStore(filePath)) as
      | Partial<PersistShape>
      | undefined;
    if (parsed && typeof parsed.byToken === 'object' && parsed.byToken) {
      byToken = parsed.byToken;
    }
    return new UiPrefsStore(filePath, byToken);
  }

  /** The token's saved preferences. Never undefined, so callers read fields directly. */
  get(tokenId: string): UiPrefs {
    return this.byToken[tokenId] ?? {};
  }

  /**
   * Set (or clear) the token's stamp zone; persists. `undefined` removes the
   * field so the record reads "use the default" rather than storing a copy of
   * it. Returns false when `zone` is not a usable IANA name, leaving the store
   * untouched — a rejected write must not be able to blank a saved preference.
   */
  async setStampZone(
    tokenId: string,
    zone: string | undefined,
  ): Promise<boolean> {
    if (zone !== undefined) {
      if (
        zone.length === 0 ||
        zone.length > MAX_ZONE_LENGTH ||
        !isValidTimeZone(zone)
      ) {
        return false;
      }
    }
    const rec = { ...this.byToken[tokenId] };
    if (zone === undefined) {
      delete rec.stampZone;
    } else {
      rec.stampZone = zone;
    }
    this.byToken[tokenId] = rec;
    await this.persist();
    return true;
  }

  /** Temp-and-rename (#165): a crash mid-write keeps the old file whole. */
  private async persist(): Promise<void> {
    await writeFileAtomic(
      this.filePath,
      () => {
        const body: PersistShape = { byToken: this.byToken };
        return JSON.stringify(body, null, 2);
      },
      { mode: 0o600 },
    );
  }
}
