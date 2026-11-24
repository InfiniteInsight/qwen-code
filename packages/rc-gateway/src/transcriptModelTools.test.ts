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
  toolKind?: string;
  locations?: Array<{ path: string; line?: number | null }>;
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

  it('retains toolKind and locations across status updates for inline file downloads (#282)', () => {
    const m = api.createTranscriptModel();
    m.upsertTool({
      toolCallId: 'w1',
      title: 'WriteFile Writing to docs/report.md',
      kind: 'edit',
      status: 'in_progress',
      locations: [{ path: '/repo/docs/report.md', line: null }],
      rawInput: { file_path: 'docs/report.md', content: '# Report' },
    });
    m.upsertTool({
      toolCallId: 'w1',
      status: 'completed',
    });
    expect(m.items).toHaveLength(1);
    expect(m.items[0].status).toBe('completed');
    expect(m.items[0].toolKind).toBe('edit');
    expect(m.items[0].locations).toEqual([
      { path: '/repo/docs/report.md', line: null },
    ]);
  });

  it('retains toolName and attaches or upserts assistant files across updates and pages', () => {
    const m = api.createTranscriptModel() as Model & {
      upsertAssistantFile(spec: Record<string, unknown>, time?: number): Item;
      removeAssistantFile(key: string): boolean;
    };
    m.upsertTool({
      toolCallId: 'rec1',
      title: 'Recording artifact report.pdf',
      status: 'in_progress',
      _meta: { toolName: 'record_artifact' },
      rawInput: { title: 'Q3 Report', workspacePath: 'reports/report.pdf' },
    });
    m.upsertTool({ toolCallId: 'rec1', status: 'completed' });
    expect((m.items[0] as Item & { toolName?: string }).toolName).toBe(
      'record_artifact',
    );
    const owner = m.upsertAssistantFile({
      key: 'ws:reports/report.pdf',
      artifactId: 'art-1',
      toolCallId: 'rec1',
      name: 'report.pdf',
      workspacePath: 'reports/report.pdf',
      size: 4096,
      kind: 'pdf',
    });
    expect(owner.id).toBe(m.items[0].id);
    expect(m.items).toHaveLength(1);
    expect(
      (m.items[0] as Item & { artifactFiles?: unknown[] }).artifactFiles,
    ).toHaveLength(1);

    // Standalone file without a toolCallId renders its own `file` row and can be removed.
    const standalone = m.upsertAssistantFile(
      {
        key: 'art:snap-1',
        artifactId: 'snap-1',
        snapshotId: 'snap-1',
        name: 'Dashboard',
        kind: 'html',
        size: 1024,
      },
      2000,
    );
    expect(standalone.kind).toBe('file');
    expect(m.items).toHaveLength(2);
    expect(m.removeAssistantFile('art:snap-1')).toBe(true);
    expect(m.items).toHaveLength(1);

    const pageRows = api.replayStoredPage([
      flat('agent_message_chunk', text('Sending summary:')),
      flat('agent_message_chunk', {
        content: {
          type: 'resource_link',
          uri: 'file:///repo/docs/summary.csv',
          name: 'summary.csv',
          mimeType: 'text/csv',
          size: 512,
        },
      }),
    ]);
    expect(pageRows).toHaveLength(1);
    expect(pageRows[0].parts).toHaveLength(1);
  });

  it('retains record_artifact rawInput workspacePath and result across completion updates (#285)', () => {
    const m = api.createTranscriptModel();
    m.upsertTool({
      toolCallId: 'ra1',
      title: 'Recording artifact summary.pdf',
      kind: 'other',
      status: 'in_progress',
      rawInput: { title: 'Quarterly summary', workspacePath: 'reports/summary.pdf' },
    });
    m.upsertTool({
      toolCallId: 'ra1',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'Recorded artifact "summary.pdf".\nstatus: available\nworkspacePath: reports/summary.pdf\nresolvedPath: /repo/reports/summary.pdf',
          },
        },
      ],
    });
    expect(m.items).toHaveLength(1);
    expect(m.items[0].status).toBe('completed');
    expect(m.items[0].input).toEqual({
      title: 'Quarterly summary',
      workspacePath: 'reports/summary.pdf',
    });
  });
});
