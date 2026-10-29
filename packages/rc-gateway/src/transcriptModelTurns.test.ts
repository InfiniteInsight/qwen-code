/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #129: jump to a turn. The turn index names a turn by the record id of its
// user message (`turnId`), and a stored frame carries that id at
// `_meta['qwen.session.recordId']` beside `_meta.timestamp` (checked against a
// live daemon, 59 of 59 turns across 14 sessions). The model keeps that id on
// the user row it draws, and `rowOfRecord` is how the page turns a turn into a
// row. The fixtures put the id where the daemon puts it: flat on `data._meta`
// for a stored page, or on `data.update._meta` when the update is nested.

import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

interface Item {
  id: number;
  kind: string;
  text?: string;
  midTurn?: boolean;
  recordIds?: string[];
  parts?: unknown[];
}
interface Model {
  items: Item[];
  addUser(text: string, time?: number): Item;
  addMidTurnUser(text: string, time?: number, recordId?: string): Item;
  addUserPart(
    part: unknown,
    time?: number,
    recordId?: string,
  ): { item: Item; merged: boolean };
  addUserChunk(
    text: string,
    time?: number,
    recordId?: string,
  ): { item: Item; merged: boolean };
  appendAssistant(text: string): void;
  cutAtUserTurn(keep: number): boolean;
  prependItems(list: Item[], beforeSplice?: () => void): number;
  rowOfRecord(recordId: string): Item | null;
}
interface Api {
  createTranscriptModel(opts?: { now?: () => number }): Model;
  replayStoredPage(events: unknown[]): Item[];
}

let api: Api;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  await import(
    pathToFileURL(join(here, '..', 'public', 'transcript-model.js')).href
  );
  api = (globalThis as unknown as { TranscriptModel: Api }).TranscriptModel;
});

const text = (t: string) => ({ content: { type: 'text', text: t } });
const picture = {
  content: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
};

// The flat form the daemon serves: the update spread onto data, the clock and
// the record id side by side in data._meta.
function flat(
  sessionUpdate: string,
  record: string | null,
  extra: Record<string, unknown> = {},
  ts = 1_700_000_000_000,
): Record<string, unknown> {
  return {
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate,
      ...extra,
      _meta: {
        timestamp: ts,
        ...(record ? { 'qwen.session.recordId': record } : {}),
        ...((extra['_meta'] as object) ?? {}),
      },
    },
  };
}
// The nested form: data.update, as a replayed bus event carries it.
function nested(
  sessionUpdate: string,
  record: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    type: 'session_update',
    data: {
      update: {
        sessionUpdate,
        ...extra,
        _meta: { timestamp: 1_700_000_000_000, 'qwen.session.recordId': record },
      },
    },
  };
}

describe('a turn is a row (#129)', () => {
  it('finds the user row a stored page drew by the record id of its message', () => {
    const rows = api.replayStoredPage([
      flat('user_message_chunk', 'rec-a', text('first question')),
      flat('agent_message_chunk', 'rec-b', text('first answer')),
      flat('user_message_chunk', 'rec-c', text('second question')),
    ]);
    const m = api.createTranscriptModel();
    m.prependItems(rows);
    expect(m.rowOfRecord('rec-a')?.text).toBe('first question');
    expect(m.rowOfRecord('rec-c')?.text).toBe('second question');
    expect(m.rowOfRecord('rec-c')).toBe(m.items[2]);
  });

  it('reads the id from a nested update too', () => {
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([nested('user_message_chunk', 'rec-n', text('hi'))]),
    );
    expect(m.rowOfRecord('rec-n')?.text).toBe('hi');
  });

  it('answers null for an id no row holds, and for nothing at all', () => {
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([flat('user_message_chunk', 'rec-a', text('hi'))]),
    );
    expect(m.rowOfRecord('rec-zzz')).toBeNull();
    expect(m.rowOfRecord('')).toBeNull();
    expect(m.rowOfRecord(undefined as unknown as string)).toBeNull();
    expect(api.createTranscriptModel().rowOfRecord('rec-a')).toBeNull();
  });

  it('draws the same rows as before for frames that carry no id', () => {
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([flat('user_message_chunk', null, text('hi'))]),
    );
    expect(m.items).toHaveLength(1);
    expect(m.items[0].recordIds).toBeUndefined();
  });

  it('does not match a record that only an answer row came from', () => {
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([
        flat('user_message_chunk', 'rec-a', text('q')),
        flat('agent_message_chunk', 'rec-b', text('a')),
      ]),
    );
    expect(m.rowOfRecord('rec-b')).toBeNull();
  });

  it('keeps the id of a message that joined a running turn on its own row', () => {
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([
        flat('user_message_chunk', 'rec-a', text('q')),
        flat('user_message_chunk', 'rec-mid', {
          ...text('and also'),
          _meta: { source: 'mid_turn_message_injected' },
        }),
      ]),
    );
    const row = m.rowOfRecord('rec-mid');
    expect(row?.midTurn).toBe(true);
    expect(row).not.toBe(m.rowOfRecord('rec-a'));
  });

  it('keeps every record of a message of several blocks on its one row', () => {
    // A picture sent first opens a text-less row and its caption arrives after
    // it, each as a record of its own. The turn index may name either.
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([
        flat('user_message_chunk', 'rec-pic', picture),
        flat('user_message_chunk', 'rec-cap', text('what is this')),
      ]),
    );
    expect(m.items).toHaveLength(1);
    expect(m.rowOfRecord('rec-pic')).toBe(m.items[0]);
    expect(m.rowOfRecord('rec-cap')).toBe(m.items[0]);
  });

  it('survives the row being re-keyed when a page goes in front', () => {
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([flat('user_message_chunk', 'rec-new', text('new'))]),
    );
    m.prependItems(
      api.replayStoredPage([flat('user_message_chunk', 'rec-old', text('old'))]),
    );
    expect(m.items.map((i) => i.text)).toEqual(['old', 'new']);
    expect(m.rowOfRecord('rec-old')).toBe(m.items[0]);
    expect(m.rowOfRecord('rec-new')).toBe(m.items[1]);
    expect(new Set(m.items.map((i) => i.id)).size).toBe(2);
  });

  it('finds the row of a message split across a page boundary by either record', () => {
    const m = api.createTranscriptModel();
    // The newer page opens with the caption, the older one ends in the picture.
    m.prependItems(
      api.replayStoredPage([flat('user_message_chunk', 'rec-cap', text('look'))]),
    );
    m.prependItems(
      api.replayStoredPage([flat('user_message_chunk', 'rec-pic', picture)]),
    );
    expect(m.items).toHaveLength(1);
    expect(m.rowOfRecord('rec-pic')).toBe(m.items[0]);
    expect(m.rowOfRecord('rec-cap')).toBe(m.items[0]);
  });

  it('gives a row drawn live the id its stored copy carries, when the page overlaps it', () => {
    // The resume drew these rows from the live journal, which stamps no record
    // id; the newest stored page holds the same two rows and does.
    const m = api.createTranscriptModel();
    m.addUserChunk('same words', 1_700_000_000_000);
    m.appendAssistant('same answer');
    expect(m.rowOfRecord('rec-a')).toBeNull();
    const added = m.prependItems(
      api.replayStoredPage([
        flat('user_message_chunk', 'rec-a', text('same words')),
        flat('agent_message_chunk', 'rec-b', text('same answer')),
      ]),
    );
    expect(added).toBe(0);
    expect(m.items).toHaveLength(2);
    expect(m.rowOfRecord('rec-a')).toBe(m.items[0]);
  });

  it('is told the id by the live verbs, for the frames of a resume', () => {
    const m = api.createTranscriptModel();
    const a = m.addUserChunk('q1', 1, 'rec-1');
    m.appendAssistant('a1');
    const b = m.addUserPart({ kind: 'image', name: 'x' }, 2, 'rec-2');
    // The caption of the picture joins its row and adds its record.
    const cap = m.addUserChunk('caption', 4, 'rec-2b');
    expect(cap.merged).toBe(true);
    expect(m.rowOfRecord('rec-2b')).toBe(b.item);
    const c = m.addMidTurnUser('extra', 3, 'rec-3');
    expect(m.rowOfRecord('rec-1')).toBe(a.item);
    expect(m.rowOfRecord('rec-2')).toBe(b.item);
    expect(m.rowOfRecord('rec-3')).toBe(c);
  });

  it('forgets a turn a rewind cut', () => {
    const m = api.createTranscriptModel();
    m.addUserChunk('q1', 1, 'rec-1');
    m.appendAssistant('a1');
    m.addUserChunk('q2', 2, 'rec-2');
    m.appendAssistant('a2');
    expect(m.cutAtUserTurn(1)).toBe(true);
    expect(m.rowOfRecord('rec-2')).toBeNull();
    expect(m.rowOfRecord('rec-1')?.text).toBe('q1');
  });

  it('never matches a row the reader typed in this window, which has no record yet', () => {
    const m = api.createTranscriptModel();
    m.addUser('typed here', 1);
    expect(m.rowOfRecord('typed here')).toBeNull();
    expect(m.items[0].recordIds).toBeUndefined();
  });
});
