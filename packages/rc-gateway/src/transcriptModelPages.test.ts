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
  prependItems(list: Item[], beforeSplice?: () => void): number;
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

describe('a call and its result on different pages (#171)', () => {
  // Paging runs newest to oldest: the page holding the RESULT is read and drawn
  // first, the page holding the CALL arrives later and goes in front of it.
  it('is one row named by the call, with the status the result carried', () => {
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([
        flat('tool_call_update', {
          toolCallId: 't1',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'out' } },
          ],
        }),
        flat('agent_message_chunk', text('all done')),
      ]),
    );
    expect(m.items[0].label).toBe('t1'); // the raw id until its call turns up
    m.prependItems(
      api.replayStoredPage([
        flat('user_message_chunk', text('read it')),
        flat('tool_call', {
          toolCallId: 't1',
          title: 'read_file',
          status: 'in_progress',
          rawInput: { path: 'a.txt' },
        }),
      ]),
    );
    expect(m.items.map((i) => i.kind)).toEqual(['user', 'tool', 'asst']);
    const tool = m.items[1];
    expect(tool.label).toBe('read_file');
    expect(tool.status).toBe('completed');
    expect(tool.input).toEqual({ path: 'a.txt' });
    expect(tool.result).toBeTruthy();
    expect(new Set(m.items.map((i) => i.id)).size).toBe(m.items.length);
  });

  it('later live updates still reach a live row the call is merged into', () => {
    const m = api.createTranscriptModel();
    // The live stream opened on the result: nothing told it a title.
    m.upsertTool({ toolCallId: 't9', status: 'in_progress' });
    m.prependItems(
      api.replayStoredPage([
        flat('tool_call', { toolCallId: 't9', title: 'shell' }),
      ]),
    );
    m.upsertTool({ toolCallId: 't9', status: 'completed' });
    expect(m.items.filter((i) => i.kind === 'tool')).toHaveLength(1);
    expect(m.items[0].label).toBe('shell');
    expect(m.items[0].status).toBe('completed');
  });

  it('keeps one to-do row, the newest list, when two pages each carried one', () => {
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([
        flat('plan', { entries: [{ content: 'new', status: 'pending' }] }),
      ]),
    );
    m.prependItems(
      api.replayStoredPage([
        flat('plan', { entries: [{ content: 'old', status: 'pending' }] }),
        flat('agent_message_chunk', text('older answer')),
      ]),
    );
    const plans = m.items.filter((i) => i.kind === 'plan');
    expect(plans).toHaveLength(1);
    expect(plans[0].open?.[0].text).toBe('new');
    expect(m.items.map((i) => i.kind)).toEqual(['asst', 'plan']);
  });

  it('keeps an older to-do row when the newer page had none', () => {
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([flat('agent_message_chunk', text('x'))]),
    );
    m.prependItems(
      api.replayStoredPage([
        flat('plan', { entries: [{ content: 'old', status: 'pending' }] }),
      ]),
    );
    expect(m.items.map((i) => i.kind)).toEqual(['plan', 'asst']);
  });
});

describe('prependItems does not draw a record twice (#171)', () => {
  const page = () =>
    api.replayStoredPage([
      flat('user_message_chunk', text('question')),
      flat('agent_message_chunk', text('answer')),
      flat('tool_call', { toolCallId: 'x1', title: 'ls', status: 'completed' }),
    ]);

  it('drops a page the live rows already hold', () => {
    const m = api.createTranscriptModel();
    m.prependItems(page());
    const before = m.items.map((i) => i.id);
    expect(m.prependItems(page())).toBe(0);
    expect(m.items.map((i) => i.id)).toEqual(before);
  });

  it('drops only the overlapping tail of a page and keeps what is older', () => {
    const m = api.createTranscriptModel();
    m.prependItems(page());
    const p = api.replayStoredPage([
      flat('user_message_chunk', text('older question')),
      flat('agent_message_chunk', text('older answer')),
      flat('user_message_chunk', text('question')),
      flat('agent_message_chunk', text('answer')),
      flat('tool_call', { toolCallId: 'x1', title: 'ls', status: 'completed' }),
    ]);
    expect(m.prependItems(p)).toBe(2);
    expect(m.items.map((i) => i.text ?? i.label)).toEqual([
      'older question',
      'older answer',
      'question',
      'answer',
      'ls',
    ]);
  });

  it('names a result-only row from the call in the overlap it drops', () => {
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([
        flat('agent_message_chunk', text('answer')),
        flat('tool_call_update', { toolCallId: 'x1', status: 'completed' }),
      ]),
    );
    expect(
      m.prependItems(
        api.replayStoredPage([
          flat('user_message_chunk', text('q')),
          flat('agent_message_chunk', text('answer')),
          flat('tool_call', { toolCallId: 'x1', title: 'ls' }),
        ]),
      ),
    ).toBe(1);
    expect(m.items.map((r) => r.text ?? r.label)).toEqual([
      'q',
      'answer',
      'ls',
    ]);
    expect(m.items[2].status).toBe('completed');
  });

  it('calls beforeSplice only when rows go in', () => {
    const m = api.createTranscriptModel();
    m.prependItems(page());
    let calls = 0;
    m.prependItems(page(), () => calls++);
    expect(calls).toBe(0);
    m.prependItems(
      api.replayStoredPage([flat('agent_message_chunk', text('older'))]),
      () => calls++,
    );
    expect(calls).toBe(1);
  });

  it('does not take a repeated pair sent at another time for the same record', () => {
    const m = api.createTranscriptModel();
    m.prependItems(
      api.replayStoredPage([
        flat('user_message_chunk', text('continue'), 2_000_000),
        flat('agent_message_chunk', text('ok'), 2_001_000),
      ]),
    );
    const older = api.replayStoredPage([
      flat('user_message_chunk', text('continue'), 1_000_000),
      flat('agent_message_chunk', text('ok'), 1_001_000),
    ]);
    expect(m.prependItems(older)).toBe(2);
    expect(m.items).toHaveLength(4);
  });

  it('does not take one repeated word for the same record', () => {
    const m = api.createTranscriptModel();
    m.addUser('yes');
    m.appendAssistant('ok');
    const p = api.replayStoredPage([
      flat('user_message_chunk', text('first thing')),
      flat('agent_message_chunk', text('ok')),
      flat('user_message_chunk', text('yes')),
    ]);
    // "yes" alone matches a live row; one row of overlap is not proof.
    expect(m.prependItems(p)).toBe(3);
  });
});
