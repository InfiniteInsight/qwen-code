/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// A turn that ends in turn_error (#199). The daemon publishes that frame
// INSTEAD of turn_complete when a prompt fails, and the viewer used to ignore
// it, so a failed turn kept its thinking row. The model keeps the reply so far,
// folds the live thought, drops the processing row and adds one error row.
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

interface Item {
  id: number;
  kind: string;
  text?: string;
  live?: boolean;
  err?: boolean;
  turnError?: boolean;
  status?: string;
  sub?: { done: boolean; failed: boolean } | null;
}
interface Model {
  items: Item[];
  curAsst: Item | null;
  addUser(text: string): Item;
  appendAssistant(text: string): void;
  appendThought(text: string): void;
  showProcessing(): void;
  failTurn(text: string, key?: unknown): Item | null;
  upsertTool(u: Record<string, unknown>): void;
  appendSubagentText(parentId: string, text: string): void;
}
interface Api {
  createTranscriptModel(opts?: { now?: () => number }): Model;
  replayStoredPage(events: unknown[]): Item[];
  turnErrorText(data: unknown): string;
}

let api: Api;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  await import(
    pathToFileURL(join(here, '..', 'public', 'transcript-model.js')).href
  );
  api = (globalThis as unknown as { TranscriptModel: Api }).TranscriptModel;
});

// The frame as the daemon sends it (fork PR #184's fixture, broadcastTurnError).
const interrupted = {
  sessionId: 's1',
  message: 'terminated',
  errorKind: 'model_stream_interrupted',
  promptId: 'prompt-1',
};

describe('turn_error', () => {
  it('says why in the TUI wording, and names an unknown error', () => {
    expect(api.turnErrorText(interrupted)).toBe(
      'The reply stopped: the connection to the model was lost (terminated).',
    );
    expect(
      api.turnErrorText({ message: ' 429 rate limit exceeded ' }),
    ).toBe('The turn failed: 429 rate limit exceeded');
    expect(api.turnErrorText({})).toBe('The turn failed: unknown error');
    expect(api.turnErrorText(undefined)).toBe('The turn failed: unknown error');
  });

  it('commits the reply so far, adds one error row and leaves the model idle', () => {
    const m = api.createTranscriptModel();
    m.addUser('do it');
    m.showProcessing();
    m.appendThought('weighing options');
    m.appendAssistant('I started to ans');
    expect(m.curAsst).not.toBeNull();

    const row = m.failTurn(api.turnErrorText(interrupted), 'prompt-1');

    const kinds = m.items.map((i) => i.kind);
    expect(kinds).toEqual(['user', 'thought', 'asst', 'system']);
    expect(m.items.some((i) => i.kind === 'processing')).toBe(false);
    expect(m.items[1]!.live).toBe(false);
    expect(m.items[2]!.text).toBe('I started to ans');
    expect(row).toBe(m.items[3]);
    expect(row!.err).toBe(true);
    expect(row!.turnError).toBe(true);
    expect(row!.text).toContain('the connection to the model was lost');
    // Idle: the next chunk opens a new bubble instead of extending the cut one.
    expect(m.curAsst).toBeNull();
    m.appendAssistant('next');
    expect(m.items[2]!.text).toBe('I started to ans');
    expect(m.items.at(-1)!.kind).toBe('asst');
  });

  it('adds the row once when the same failure is delivered twice', () => {
    const m = api.createTranscriptModel();
    m.addUser('do it');
    expect(m.failTurn('The turn failed: x', 'prompt-1')).not.toBeNull();
    expect(m.failTurn('The turn failed: x', 'prompt-1')).toBeNull();
    expect(m.items.filter((i) => i.turnError).length).toBe(1);
    // A different prompt's failure is its own row.
    m.addUser('again');
    expect(m.failTurn('The turn failed: x', 'prompt-2')).not.toBeNull();
    expect(m.items.filter((i) => i.turnError).length).toBe(2);
  });

  it('settles a subagent that was still running as failed', () => {
    const m = api.createTranscriptModel();
    m.upsertTool({ toolCallId: 'agent-1', title: 'Agent', status: 'in_progress' });
    m.appendSubagentText('agent-1', 'working');
    const tool = m.items.find((i) => i.toolCallId === 'agent-1')!;
    expect(tool.sub!.done).toBe(false);
    m.failTurn('The turn failed: x', 'p');
    expect(tool.sub!.done).toBe(true);
    expect(tool.sub!.failed).toBe(true);
  });

  it('draws the same row from a stored page', () => {
    const rows = api.replayStoredPage([
      {
        id: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { text: 'partial' },
          },
        },
      },
      { id: 2, type: 'turn_error', data: interrupted },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['asst', 'system']);
    expect(rows[1]!.err).toBe(true);
    expect(rows[1]!.text).toContain('the connection to the model was lost');
  });
});
