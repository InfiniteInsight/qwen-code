/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/**
 * The cursor-store partition key for a bridge token: a short SHA-256
 * fingerprint, never the token itself (cursors.json must not hold a bearer
 * credential). Stable for a token, so a restart finds its cursors; a new
 * token (re-pairing) starts a fresh partition.
 */
export function cursorPartitionOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** File writes the store makes (injectable so tests can hold a write open). */
export interface CursorStoreIo {
  writeFile(path: string, data: string): Promise<void>;
}

const defaultIo: CursorStoreIo = {
  writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
};

/**
 * The cursor state persisted for a single bridge session.
 * `lastEventId` is the highest SSE frame id seen on the subscription stream;
 * `lastDeliveredEventId` is the highest id actually delivered to the chat.
 * Both values are used for resume-cursor on reconnect.
 */
export interface CursorEntry {
  lastEventId: number;
  lastDeliveredEventId: number;
}

/**
 * Durable bridge cursor store (`add-cursor-persistence`): persists
 * `{ lastEventId, lastDeliveredEventId }` per bridge token (scoped by a
 * `tokenId`) + session id to a JSON file so SSE resume cursors survive
 * a bridge restart. Writes are atomic (write-temp + rename) so a crash during
 * flush cannot corrupt the existing cursor file.
 *
 * File layout: `{ "<tokenId>/<sessionId>": { lastEventId, lastDeliveredEventId } }`.
 *
 * In-memory; every update flushes, and the returned promise resolves once a
 * write carrying it has landed. Writes are serialized (#168): one in flight at
 * a time, and every update made meanwhile is folded into a single follow-up
 * write, so an SSE stream costs one write per write-duration rather than one
 * per frame, and an older snapshot can never be renamed over a newer one.
 * Missing/corrupt file fails open to empty cursors (FAIL-OPEN: a restart lets
 * a small replay window close the gap rather than wedging the bridge). Never
 * throws.
 */
export class CursorStore {
  private readonly path: string;
  private readonly io: CursorStoreIo;
  /** Composite key `"<tokenId>/<sessionId>"` → CursorEntry. */
  private readonly map = new Map<string, CursorEntry>();
  /** The write in flight, if any. */
  private inFlight?: Promise<void>;
  /** The follow-up write queued behind it (snapshots the map when it starts). */
  private queued?: Promise<void>;

  private constructor(path: string, io: CursorStoreIo) {
    this.path = path;
    this.io = io;
  }

  /** Open (and load) the store. Missing/corrupt file → empty. Never throws. */
  static async open(
    path: string,
    io: Partial<CursorStoreIo> = {},
  ): Promise<CursorStore> {
    const store = new CursorStore(path, { ...defaultIo, ...io });
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<
        string,
        unknown
      >;
      for (const [key, val] of Object.entries(raw)) {
        if (
          val !== null &&
          typeof val === 'object' &&
          typeof (val as Record<string, unknown>)['lastEventId'] === 'number' &&
          typeof (val as Record<string, unknown>)['lastDeliveredEventId'] ===
            'number'
        ) {
          store.map.set(key, {
            lastEventId: (val as Record<string, unknown>)[
              'lastEventId'
            ] as number,
            lastDeliveredEventId: (val as Record<string, unknown>)[
              'lastDeliveredEventId'
            ] as number,
          });
        }
      }
    } catch {
      // ENOENT / parse error → start empty.
    }
    return store;
  }

  /** Composite key for a (tokenId, sessionId) pair. */
  private static key(tokenId: string, sessionId: string): string {
    return `${tokenId}/${sessionId}`;
  }

  /** Return the stored cursor for the given token+session, or undefined. */
  get(tokenId: string, sessionId: string): CursorEntry | undefined {
    return this.map.get(CursorStore.key(tokenId, sessionId));
  }

  /**
   * Update `lastEventId` for the given token+session and flush to disk.
   * If `lastDeliveredEventId` is not yet set it is initialised to the same value.
   */
  async setLastEventId(
    tokenId: string,
    sessionId: string,
    id: number,
  ): Promise<void> {
    const k = CursorStore.key(tokenId, sessionId);
    const prev = this.map.get(k);
    this.map.set(k, {
      lastEventId: id,
      lastDeliveredEventId: prev?.lastDeliveredEventId ?? id,
    });
    await this.persist();
  }

  /**
   * Update `lastDeliveredEventId` for the given token+session and flush.
   * If no entry exists yet it is created with both fields set to `id`.
   */
  async setLastDeliveredEventId(
    tokenId: string,
    sessionId: string,
    id: number,
  ): Promise<void> {
    const k = CursorStore.key(tokenId, sessionId);
    const prev = this.map.get(k);
    this.map.set(k, {
      lastEventId: prev?.lastEventId ?? id,
      lastDeliveredEventId: id,
    });
    await this.persist();
  }

  /** Remove the cursor for a token+session (e.g. on explicit unbind). */
  async delete(tokenId: string, sessionId: string): Promise<void> {
    this.map.delete(CursorStore.key(tokenId, sessionId));
    await this.persist();
  }

  /**
   * Flush the map: start a write now, or fold this update into the one write
   * queued behind the write in flight (it snapshots the map when it starts, so
   * it carries every update made before then).
   */
  private persist(): Promise<void> {
    if (this.queued) return this.queued;
    if (!this.inFlight) return this.startWrite();
    this.queued = this.inFlight.then(() => {
      this.queued = undefined;
      return this.startWrite();
    });
    return this.queued;
  }

  private startWrite(): Promise<void> {
    const p = this.writeSnapshot().finally(() => {
      if (this.inFlight === p) this.inFlight = undefined;
    });
    this.inFlight = p;
    return p;
  }

  /** Atomic write: temp file + rename so a crash cannot corrupt the cursor file. */
  private async writeSnapshot(): Promise<void> {
    const obj: Record<string, CursorEntry> = {};
    for (const [k, v] of this.map) obj[k] = v;
    const json = JSON.stringify(obj);
    const dir = dirname(this.path);
    try {
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.cursors-${randomBytes(6).toString('hex')}.tmp`);
      await this.io.writeFile(tmp, json);
      await rename(tmp, this.path);
    } catch {
      // Best-effort persistence; in-memory cursors still work this session.
    }
  }
}
