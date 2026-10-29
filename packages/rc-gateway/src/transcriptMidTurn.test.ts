/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #190. A message sent now joins the running turn through the mid-turn route,
// and the daemon does not count it as a turn: its rewind index and the
// gateway's turn resolver (src/sessions/turnResolver.ts, NOT_A_TURN_SUBTYPES)
// skip `mid_turn_user_message`. The row the transcript draws for it has to be
// skipped the same way, or every rewind and fork after it names the wrong turn.

import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

interface Item {
  id: number;
  kind: string;
  text?: string;
  midTurn?: boolean;
}
interface Model {
  items: Item[];
  addUser(text: string, time?: number): Item;
  addMidTurnUser(text: string, time?: number): Item;
  appendAssistant(text: string): void;
  userTurns(): Item[];
  cutAtUserTurn(keep: number): boolean;
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

describe('a message that joined the running turn (#190)', () => {
  it('is drawn as a user row that is not a turn', () => {
    const m = api.createTranscriptModel();
    m.addUser('turn one');
    m.appendAssistant('working');
    m.addMidTurnUser('also check the cache');
    m.appendAssistant('checked');
    m.addUser('turn two');
    expect(m.items.map((i) => i.kind)).toEqual([
      'user',
      'asst',
      'user',
      'asst',
      'user',
    ]);
    expect(m.items[2]).toMatchObject({
      text: 'also check the cache',
      midTurn: true,
    });
    // The answer after it is a bubble of its own, not glued to the one above.
    expect(m.items[3].text).toBe('checked');
    expect(m.userTurns().map((i) => i.text)).toEqual(['turn one', 'turn two']);
  });

  it('is cut with its turn, not counted as one', () => {
    const m = api.createTranscriptModel();
    m.addUser('turn one');
    m.addMidTurnUser('mid');
    m.appendAssistant('a1');
    m.addUser('turn two');
    m.appendAssistant('a2');
    // Keep one turn: everything from "turn two" goes, the mid-turn row stays.
    expect(m.cutAtUserTurn(1)).toBe(true);
    expect(m.items.map((i) => i.text)).toEqual(['turn one', 'mid', 'a1']);
  });

  it('comes back from a stored page marked the same way', () => {
    const rows = api.replayStoredPage([
      {
        v: 1,
        type: 'session_update',
        data: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'turn one' },
        },
      },
      {
        v: 1,
        type: 'session_update',
        data: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'sent mid-turn' },
          _meta: { source: 'mid_turn_message_injected', qwenDiscreteMessage: true },
        },
      },
      {
        v: 1,
        type: 'session_update',
        data: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'answer' },
        },
      },
    ]);
    expect(rows.map((r) => [r.kind, r.text, !!r.midTurn])).toEqual([
      ['user', 'turn one', false],
      ['user', 'sent mid-turn', true],
      ['asst', 'answer', false],
    ]);
  });
});
