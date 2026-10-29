/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #171: the transcript model and view findings. Each test here was red before
// its fix; the fixtures put every field where the DAEMON puts it (a stored page
// carries its clock at data._meta.timestamp, or at data.update._meta.timestamp
// when the update is nested), not where the code under test happened to look.

import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

interface Part {
  kind: string;
  name: string;
  mimeType: string;
  size: number;
}
interface Item {
  id: number;
  kind: string;
  text?: string;
  time?: number;
  live?: boolean;
  durLabel?: string | null;
  toolCallId?: string;
  label?: string;
  status?: string;
  input?: unknown;
  result?: unknown;
  open?: Array<{ text: string; status: string }>;
  parts?: Part[];
  sub?: { tools: Array<{ id: string; label: string; status: string }> } | null;
}
interface Model {
  items: Item[];
  addUser(text: string, time?: number): Item;
  addUserPart(part: unknown, time?: number): { item: Item; merged: boolean };
  addUserChunk(text: string, time?: number): { item: Item; merged: boolean };
  appendAssistant(text: string): void;
  appendThought(text: string): void;
  setPlan(entries: unknown[]): void;
  upsertTool(u: Record<string, unknown>): void;
  upsertSubagentTool(u: Record<string, unknown>, parentId: string): void;
  userTurns(): Item[];
  cutAtUserTurn(keep: number): boolean;
  prependItems(list: Item[]): number;
}
interface Api {
  createTranscriptModel(opts?: { now?: () => number }): Model;
  replayStoredPage(events: unknown[]): Item[];
  userBlockOf(content: unknown): Part | null;
  frameStamp(ev: unknown): number | undefined;
}

let api: Api;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  await import(
    pathToFileURL(join(here, '..', 'public', 'transcript-model.js')).href
  );
  api = (globalThis as unknown as { TranscriptModel: Api }).TranscriptModel;
});

// The flat form: the update spread onto data, its clock at data._meta.timestamp.
function flat(
  sessionUpdate: string,
  extra: Record<string, unknown> = {},
  ts?: number,
): Record<string, unknown> {
  return {
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate,
      ...extra,
      ...(ts ? { _meta: { timestamp: ts } } : {}),
    },
  };
}
const text = (t: string) => ({ content: { type: 'text', text: t } });
// A frame as the stored page serves it, nested form: the update under
// data.update, its clock at data.update._meta.timestamp.
function nested(
  sessionUpdate: string,
  extra: Record<string, unknown> = {},
  ts?: number,
): Record<string, unknown> {
  return {
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate,
        ...extra,
        ...(ts ? { _meta: { timestamp: ts } } : {}),
      },
    },
  };
}

describe('the clock of a stored page (#171)', () => {
  for (const [name, mk] of [
    ['flat', flat],
    ['nested', nested],
  ] as const) {
    it(`reads the time of a ${name} frame from its _meta.timestamp`, () => {
      const rows = api.replayStoredPage([
        mk('user_message_chunk', text('q'), 1_700_000_000_000),
        mk('agent_message_chunk', text('a'), 1_700_000_005_000),
      ]);
      expect(rows[0].time).toBe(1_700_000_000_000);
      expect(rows[1].time).toBe(1_700_000_005_000);
    });

    it(`folds a historical thought of a ${name} page to the time it really took`, () => {
      const rows = api.replayStoredPage([
        mk('agent_thought_chunk', text('a '), 5_000),
        mk('agent_thought_chunk', text('b'), 64_000),
        mk('agent_message_chunk', text('done'), 64_000),
      ]);
      expect(rows[0].kind).toBe('thought');
      expect(rows[0].durLabel).toBe('59s');
    });
  }

  it('still honours the envelope clock the live stream and the WAL carry', () => {
    const rows = api.replayStoredPage([
      {
        v: 1,
        type: 'session_update',
        data: { update: { sessionUpdate: 'user_message_chunk', ...text('q') } },
        _meta: { serverTimestamp: 1_700_000_000_000 },
      },
    ]);
    expect(rows[0].time).toBe(1_700_000_000_000);
  });

  it('reads an ISO string stamp as the epoch it names', () => {
    const rows = api.replayStoredPage([
      flat('user_message_chunk', {
        ...text('q'),
        _meta: { timestamp: '2026-01-01T00:00:00.000Z' },
      }),
    ]);
    expect(rows[0].time).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });
});

describe('frameStamp reads the clock where stampOf does (#202)', () => {
  it('finds the stored timestamp on data, on data.update, and on the envelope', () => {
    expect(
      api.frameStamp(flat('user_message_chunk', text('q'), 1_700_000_000_000)),
    ).toBe(1_700_000_000_000);
    expect(
      api.frameStamp(
        nested('user_message_chunk', text('q'), 1_700_000_001_000),
      ),
    ).toBe(1_700_000_001_000);
    expect(
      api.frameStamp({
        type: 'session_update',
        data: {},
        _meta: { serverTimestamp: 1_700_000_002_000 },
      }),
    ).toBe(1_700_000_002_000);
  });

  it('is undefined for a frame with no clock', () => {
    expect(
      api.frameStamp(flat('user_message_chunk', text('q'))),
    ).toBeUndefined();
    expect(api.frameStamp(null)).toBeUndefined();
  });
});
