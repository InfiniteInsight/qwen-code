/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-session event-id renumbering state (add-mid-turn-recovery §4).
 *
 * A respawned daemon starts a fresh bus epoch whose raw event ids restart low,
 * so raw passthrough would make downstream ids go backwards (breaking
 * Last-Event-ID cursors) and collide with WAL ids. The relay therefore maps
 * each raw id to a downstream/WAL id via `epochOffset`; `lastOutId` is the last
 * raw id observed, used to detect an epoch boundary (`frame.id <= lastOutId`).
 *
 * Persisted in a sidecar next to the session WAL so a gateway restart resumes
 * the same mapping. The sidecar is intentionally a separate file (not a WAL
 * segment) so the WAL's numeric-suffix segment scanner ignores it.
 */
export interface EpochState {
  /** downstream id = raw id + epochOffset (constant within one daemon epoch). */
  epochOffset: number;
  /** Last raw daemon id observed (epoch-boundary detection). */
  lastOutId: number;
}

function sidecarPath(walDir: string, sessionId: string): string {
  return join(walDir, 'wal', `${sessionId}.epoch.json`);
}

/**
 * Conservative fallback for any sidecar read failure (missing file, torn
 * write, bad JSON): the next live frame is treated as the start of a new
 * epoch, so the relay re-anchors `epochOffset` to `wal.latestId() + 1` and
 * stays gapless. For a brand-new session (empty WAL) this yields offset 0 —
 * identical to a fresh state — so the same fallback is safe in both cases.
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
      };
    }
    return { ...CONSERVATIVE_EPOCH };
  } catch {
    return { ...CONSERVATIVE_EPOCH };
  }
}

/**
 * Persist epoch state atomically (tmp + rename). Best-effort: a failed write
 * degrades to the conservative fallback on the next load (still gapless) and
 * never crashes the relay. The caller is expected to have already created the
 * `<walDir>/wal/` directory (the SessionWal constructor does).
 */
export function saveEpochState(
  walDir: string,
  sessionId: string,
  state: EpochState,
): void {
  const path = sidecarPath(walDir, sessionId);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path);
  } catch {
    // Best-effort (see above).
  }
}
