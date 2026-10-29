/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ForkRecord } from '../sessions/forkTranscript.js';

/**
 * Subtypes core's `selectTranscriptLeaf` never treats as the transcript leaf
 * (`isTranscriptConversationRecord` in core `transcript-records.ts`). Kept in
 * step by hand: they are side records, so the walk must not start from one.
 */
const NON_LEAF_SUBTYPES = new Set([
  'session_artifact_event',
  'session_artifact_snapshot',
  'session_sources_snapshot',
  'managed_session_header_v1',
  'managed_session_event_v1',
  'managed_session_commit_v1',
]);

export interface ActiveBranch {
  /** The records on the live branch, plus any record that carries no uuid. */
  records: ForkRecord[];
  /** `indices[i]` is the position of `records[i]` in the input array. */
  indices: number[];
}

/**
 * The live branch of a session transcript.
 *
 * A rewind does not delete anything: core re-roots the `parentUuid` chain at
 * the kept turn and appends a `rewind` record, so every record after that
 * point stays in the JSONL as an abandoned branch. Counting user lines over
 * the raw file therefore overcounts after the first rewind. This walks the
 * chain from the last conversation record, the same leaf core's
 * `reconstructHistory` picks, and drops the conversation records that are not
 * on it.
 *
 * Total, and conservative: when the transcript has no usable uuid chain (no
 * uuids or `parentUuid` keys, a leaf with a broken or cyclic chain) the input is returned
 * unchanged, which is the behaviour before this existed.
 */
export function activeBranch(records: readonly ForkRecord[]): ActiveBranch {
  const identity = (): ActiveBranch => ({
    records: [...records],
    indices: records.map((_r, i) => i),
  });

  const isConversation = (r: ForkRecord): boolean =>
    !(
      r['type'] === 'system' &&
      typeof r['subtype'] === 'string' &&
      NON_LEAF_SUBTYPES.has(r['subtype'])
    );
  const uuidOf = (r: ForkRecord): string | undefined =>
    typeof r['uuid'] === 'string' && r['uuid'].length > 0
      ? r['uuid']
      : undefined;

  const parentByUuid = new Map<string, string | null>();
  for (const r of records) {
    const u = uuidOf(r);
    if (u === undefined || !isConversation(r) || parentByUuid.has(u)) continue;
    const p = r['parentUuid'];
    // Core always writes `parentUuid` (a string, or null for a root). A record
    // without the key came from something other than a real session file, so
    // there is no chain to trust.
    if (p === undefined) return identity();
    parentByUuid.set(u, typeof p === 'string' && p.length > 0 ? p : null);
  }

  let leaf: string | undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    const u = uuidOf(r);
    if (u !== undefined && isConversation(r)) {
      leaf = u;
      break;
    }
  }
  if (leaf === undefined) return identity();

  const live = new Set<string>();
  let cur: string | null = leaf;
  while (cur !== null) {
    if (live.has(cur)) return identity(); // cycle
    if (!parentByUuid.has(cur)) return identity(); // gap: chain is not whole
    live.add(cur);
    cur = parentByUuid.get(cur)!;
  }

  const out: ActiveBranch = { records: [], indices: [] };
  records.forEach((r, i) => {
    const u = uuidOf(r);
    if (u !== undefined && isConversation(r) && !live.has(u)) return;
    out.records.push(r);
    out.indices.push(i);
  });
  return out;
}
