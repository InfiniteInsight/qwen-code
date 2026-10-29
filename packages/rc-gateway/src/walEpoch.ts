/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getSharedWal, type WalFrame } from './wal.js';

/**
 * Per-session event-id renumbering state (add-mid-turn-recovery §4).
 *
 * A respawned daemon starts a fresh bus epoch whose raw event ids restart low,
 * so raw passthrough would make downstream ids go backwards (breaking
 * Last-Event-ID cursors) and collide with WAL ids. The relay therefore maps
 * each raw id to a downstream/WAL id via `epochOffset`; `lastOutId` is the last
 * raw id relayed, which is both the cursor the daemon is resumed from and, when
 * the daemon reports no epoch token, the epoch-boundary test
 * (`frame.id <= lastOutId`).
 *
 * Persisted in a sidecar next to the session WAL so a gateway restart resumes
 * the same mapping. The sidecar is intentionally a separate file (not a WAL
 * segment) so the WAL's numeric-suffix segment scanner ignores it. It is a
 * cache: every relayed frame also carries its raw id and epoch in the WAL
 * itself (see {@link RelayStamp}), and {@link resolveEpochState} prefers that.
 */
export interface EpochState {
  /** downstream id = raw id + epochOffset (constant within one daemon epoch,
   * except that it only ever grows to step over a marker). */
  epochOffset: number;
  /** Last raw daemon id relayed. */
  lastOutId: number;
  /**
   * The daemon bus epoch token `lastOutId` belongs to (`X-Qwen-Event-Epoch`),
   * when the daemon reports one. Handed back on resubscribe so a daemon whose
   * bus was rebuilt says so and replays its new epoch from the start, rather
   * than the relay guessing from id arithmetic.
   */
  daemonEpoch?: string;
}

/**
 * What a relayed frame records about where it came from, under `_rc` in the
 * WAL. Gateway-private: stripped before a frame is written to a client.
 * Markers (rewind, fork, recovery, resync) carry none, which is how the WAL
 * tells relayed frames from its own annotations.
 */
export interface RelayStamp {
  /** The daemon's raw event id. */
  raw: number;
  /** The daemon bus epoch token that id belongs to, when reported. */
  epoch?: string;
}

/** The stamp on a WAL frame, or undefined for a marker or an older frame. */
export function readRelayStamp(frame: WalFrame): RelayStamp | undefined {
  const rc = frame['_rc'] as Partial<RelayStamp> | undefined;
  if (
    rc === undefined ||
    rc === null ||
    typeof rc.raw !== 'number' ||
    !Number.isFinite(rc.raw)
  ) {
    return undefined;
  }
  return typeof rc.epoch === 'string'
    ? { raw: rc.raw, epoch: rc.epoch }
    : { raw: rc.raw };
}

function sidecarPath(walDir: string, sessionId: string): string {
  return join(walDir, 'wal', `${sessionId}.epoch.json`);
}

/**
 * Conservative fallback for any sidecar read failure (missing file, torn
 * write, bad JSON): the next live frame is treated as the start of a new
 * epoch, so the relay re-anchors `epochOffset` above `wal.latestId()` and
 * stays gapless. For a brand-new session (empty WAL) this yields offset 0,
 * identical to a fresh state, so the same fallback is safe in both cases.
 */
export const CONSERVATIVE_EPOCH: Readonly<EpochState> = Object.freeze({
  epochOffset: 0,
  lastOutId: Number.MAX_SAFE_INTEGER,
});

/**
 * Load the persisted epoch state for a session. Returns a fresh copy of
 * {@link CONSERVATIVE_EPOCH} on any read/parse failure (never throws).
 */
export function loadEpochState(walDir: string, sessionId: string): EpochState {
  try {
    const raw = readFileSync(sidecarPath(walDir, sessionId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<EpochState>;
    if (
      typeof parsed.epochOffset === 'number' &&
      Number.isFinite(parsed.epochOffset) &&
      typeof parsed.lastOutId === 'number' &&
      Number.isFinite(parsed.lastOutId)
    ) {
      return {
        epochOffset: parsed.epochOffset,
        lastOutId: parsed.lastOutId,
        ...(typeof parsed.daemonEpoch === 'string'
          ? { daemonEpoch: parsed.daemonEpoch }
          : {}),
      };
    }
    return { ...CONSERVATIVE_EPOCH };
  } catch {
    return { ...CONSERVATIVE_EPOCH };
  }
}

/**
 * The epoch state as the WAL itself records it, falling back to the sidecar.
 *
 * The relay appends a frame and only then rewrites the sidecar, so a crash
 * between the two leaves the sidecar one frame behind the log. Resuming the
 * daemon from that stale cursor replays a frame the WAL already holds, under
 * the id it already has. The newest stamped frame cannot be behind, so it
 * wins; the sidecar answers only for a log holding no stamped frame (written
 * before stamping, or every relayed frame aged out and only markers remain).
 */
export function resolveEpochState(
  walDir: string,
  sessionId: string,
): EpochState {
  const sidecar = loadEpochState(walDir, sessionId);
  const last = getSharedWal(walDir, sessionId).findLast(
    (f) => readRelayStamp(f) !== undefined,
  );
  if (last === undefined) return sidecar;
  const stamp = readRelayStamp(last)!;
  return {
    epochOffset: last.id - stamp.raw,
    lastOutId: stamp.raw,
    ...(stamp.epoch !== undefined ? { daemonEpoch: stamp.epoch } : {}),
  };
}

/**
 * Persist epoch state atomically (tmp + rename). Best-effort: a failed write
 * degrades to the WAL's own stamps, or the conservative fallback, on the next
 * load (still gapless) and never crashes the relay. The caller is expected to
 * have already created the `<walDir>/wal/` directory (the SessionWal
 * constructor does).
 */
export function saveEpochState(
  walDir: string,
  sessionId: string,
  state: EpochState,
): void {
  const path = sidecarPath(walDir, sessionId);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Best-effort (see above).
  }
}
