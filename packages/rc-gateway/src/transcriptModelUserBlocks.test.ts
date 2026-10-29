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
const IMG = {
  type: 'image',
  attachmentId: 'IMG_1.jpg',
  mimeType: 'image/jpeg',
  size: 10,
};

describe('a message of several blocks is one user row (#171)', () => {
  it('reads a block it does not draw as a chip, not as an empty bubble', () => {
    expect(
      api.userBlockOf({ type: 'audio', mimeType: 'audio/wav' }),
    ).toMatchObject({
      kind: 'file',
      name: 'audio block',
      mimeType: 'audio/wav',
    });
    expect(api.userBlockOf(IMG)).toMatchObject({ kind: 'image' });
    expect(api.userBlockOf({ type: 'text', text: 'hi' })).toBeNull();
    expect(api.userBlockOf({ type: 'text', text: '' })).toBeNull();
    expect(api.userBlockOf(null)).toBeNull();
  });

  it('draws text after a picture in the row the picture opened', () => {
    const rows = api.replayStoredPage([
      flat('user_message_chunk', { content: IMG }),
      flat('user_message_chunk', text('what is this?')),
      flat('agent_message_chunk', text('a cat')),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['user', 'asst']);
    expect(rows[0].text).toBe('what is this?');
    expect(rows[0].parts).toHaveLength(1);
  });

  it('opens no bubble for a frame that carries nothing', () => {
    const rows = api.replayStoredPage([
      flat('user_message_chunk', { content: { type: 'text', text: '' } }),
      flat('user_message_chunk', {}),
      flat('user_message_chunk', { content: { type: 'audio' } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].parts?.[0].name).toBe('audio block');
  });

  it('addUserChunk fills a text-less row, but opens a row after a message that has text', () => {
    const m = api.createTranscriptModel();
    m.addUserPart({ kind: 'file', name: 'a', mimeType: '', size: 0 });
    expect(m.addUserChunk('caption').merged).toBe(true);
    expect(m.items).toHaveLength(1);
    expect(m.items[0].text).toBe('caption');
    // Two prompts queued back to back are two messages.
    expect(m.addUserChunk('second').merged).toBe(false);
    expect(m.userTurns()).toHaveLength(2);
  });

  it('a rewind to turn 1 keeps the whole of the first message and nothing of the second', () => {
    const m = api.createTranscriptModel();
    for (const r of api.replayStoredPage([
      flat('user_message_chunk', { content: IMG }),
      flat('user_message_chunk', text('first, picture first')),
      flat('agent_message_chunk', text('one')),
      flat('user_message_chunk', text('second')),
      flat('user_message_chunk', { content: IMG }),
      flat('agent_message_chunk', text('two')),
    ]))
      m.items.push(r);
    expect(m.userTurns()).toHaveLength(2);
    expect(m.cutAtUserTurn(1)).toBe(true);
    expect(m.items.map((i) => i.text)).toEqual(['first, picture first', 'one']);
    expect(m.items[0].parts).toHaveLength(1);
  });
});
