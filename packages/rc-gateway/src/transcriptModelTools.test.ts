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

describe('a tool update that names no status (#171)', () => {
  it('leaves the status the call had', () => {
    const m = api.createTranscriptModel();
    m.upsertTool({ toolCallId: 'a1', title: 'agent', status: 'in_progress' });
    // subagentSessionReady: an update that carries a note and no status.
    m.upsertTool({ toolCallId: 'a1', _meta: { subagentSessionReady: true } });
    expect(m.items).toHaveLength(1);
    expect(m.items[0].status).toBe('in_progress');
    m.upsertTool({ toolCallId: 'a1', status: 'completed' });
    expect(m.items[0].status).toBe('completed');
  });

  it('does the same for a child tool of a subagent', () => {
    const m = api.createTranscriptModel();
    m.upsertTool({ toolCallId: 'p', title: 'agent', status: 'in_progress' });
    m.upsertSubagentTool(
      { toolCallId: 'c', title: 'grep', status: 'in_progress' },
      'p',
    );
    m.upsertSubagentTool({ toolCallId: 'c' }, 'p');
    expect(m.items[0].sub?.tools[0].status).toBe('in_progress');
  });
});

describe('a to-do list closes the thought before it (#171)', () => {
  it('folds a live thought when a plan arrives', () => {
    const m = api.createTranscriptModel({ now: () => 1000 });
    m.appendThought('planning');
    expect(m.items[0].live).toBe(true);
    m.setPlan([{ content: 'step', status: 'pending' }]);
    expect(m.items[0].live).toBe(false);
    expect(m.items[0].durLabel).toBeTruthy();
  });

  it('a plan frame that changes nothing leaves the thought open', () => {
    const m = api.createTranscriptModel({ now: () => 1000 });
    m.appendThought('planning');
    m.setPlan([]);
    expect(m.items[0].live).toBe(true);
  });
});
