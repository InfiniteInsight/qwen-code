/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Assistant-sent files inline in the chat conversation and surfaced to the
// page's `+ -> Files` registry: non-text `agent_message_chunk` blocks
// (`resource_link`, `resource`, attachment images), markdown workspace links
// and images, tool-produced files (`record_artifact`, `write_file`, `image_gen`,
// `display_image`), and standalone `file` rows from `artifact_changed`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => join(here, '..', 'public', f);

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type FileSpec = {
  key: string;
  name: string;
  workspacePath?: string;
  uri?: string;
  attachmentId?: string;
  snapshotId?: string;
  mimeType?: string;
  size?: number;
  kind?: string;
  data?: string;
  textData?: string;
};

type Item = {
  id: number;
  kind: string;
  text?: string;
  parts?: unknown[];
  file?: FileSpec;
  fileDl?: Record<string, { busy: boolean; note: string }>;
};

type Model = {
  items: Item[];
  appendAssistant: (t: string, time?: number) => void;
  addAssistantPart: (p: unknown, time?: number) => { item: Item; merged: boolean };
  upsertAssistantFile: (spec: FileSpec, time?: number) => Item;
  upsertTool: (u: Record<string, unknown>, time?: number) => Item;
  addImage: (mime: string, data: string) => void;
  touch: (item: Item) => void;
  search: (q: string) => Array<{ id: number; fields: string[] }>;
};

type ModelApi = {
  createTranscriptModel: () => Model;
  replayStoredPage: (events: unknown[]) => Item[];
  asstBlockOf: (content: unknown) => FileSpec | null;
};

type View = { destroy: () => void };

let rafQueue = new Map<number, () => void>();
let rafId = 0;
let dom: JSDOM;
let scroller: HTMLElement;
let view: View | null = null;
let api: ModelApi;
let model: Model;
let downloads: FileSpec[];
let discovered: FileSpec[];

function tick(): void {
  for (let round = 0; round < 4 && rafQueue.size; round++) {
    const due = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, fn] of due) fn();
  }
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  tick();
};

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window;
  rafQueue = new Map();
  rafId = 0;
  downloads = [];
  discovered = [];
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    Node: w.Node,
    Event: w.Event,
    requestAnimationFrame: (fn: () => void) => {
      rafQueue.set(++rafId, fn);
      return rafId;
    },
    cancelAnimationFrame: (id: number) => {
      rafQueue.delete(id);
    },
  });
  scroller = w.document.createElement('div');
  w.document.body.appendChild(scroller);
  await import(pathToFileURL(pub('transcript-model.js')).href);
  await import(pathToFileURL(pub('transcript-view.js')).href);
  api = (globalThis as unknown as { TranscriptModel: ModelApi }).TranscriptModel;
  const TV = (globalThis as unknown as {
    TranscriptView: { createTranscriptView: (o: Record<string, unknown>) => View };
  }).TranscriptView;
  const mdBundle = await import(
    pathToFileURL(join(pub('vendor'), 'markdown-it.js')).href
  );
  model = api.createTranscriptModel();
  view = TV.createTranscriptView({
    model,
    scroller,
    virtualCore: null,
    markdownIt: mdBundle,
    resolveWorkspaceFile: (href: string) => {
      if (href.startsWith('file:///workspace/')) {
        const rel = href.slice('file:///workspace/'.length);
        return {
          key: 'ws:' + rel,
          name: rel.split('/').pop() || rel,
          workspacePath: rel,
          mimeType: rel.endsWith('.png') ? 'image/png' : 'application/pdf',
          kind: rel.endsWith('.png') ? 'image' : 'file',
        };
      }
      if (/^[a-z0-9_./-]+\.[a-z0-9]{2,6}$/i.test(href) && !href.startsWith('..')) {
        const rel = href.replace(/^\.\//, '');
        return {
          key: 'ws:' + rel,
          name: rel.split('/').pop() || rel,
          workspacePath: rel,
          mimeType: rel.endsWith('.png') ? 'image/png' : 'text/csv',
          kind: rel.endsWith('.png') ? 'image' : 'file',
        };
      }
      return null;
    },
    resolveToolFiles: (item: Item & { toolName?: string; status?: string; input?: Record<string, unknown> }) => {
      if (item.status !== 'completed') return [];
      const p = String(item.input?.workspacePath || item.input?.file_path || '');
      if (!p) return [];
      return [
        {
          key: 'ws:' + p,
          name: p.split('/').pop() || p,
          workspacePath: p,
          size: 8192,
          kind: p.endsWith('.png') ? 'image' : 'pdf',
        },
      ];
    },
    loadWorkspaceThumb: async (relPath: string) =>
      relPath.endsWith('.png') ? { url: 'blob:ws-thumb-' + relPath } : null,
    onDownloadFile: (spec: FileSpec) => {
      downloads.push(spec);
    },
    onDiscoverFiles: (files: FileSpec[]) => {
      for (const f of files) discovered.push(f);
    },
  });
  tick();
});

afterEach(() => {
  if (view) view.destroy();
  view = null;
  dom.window.close();
});

describe('assistant-sent files inline in chat & discovered for + Files', () => {
  it('parses resource_link and resource blocks on agent_message_chunk in live and stored replay', () => {
    const part = api.asstBlockOf({
      type: 'resource_link',
      uri: 'file:///workspace/reports/q3.pdf',
      name: 'q3.pdf',
      mimeType: 'application/pdf',
      size: 15360,
    });
    expect(part).toMatchObject({
      kind: 'file',
      name: 'q3.pdf',
      uri: 'file:///workspace/reports/q3.pdf',
      mimeType: 'application/pdf',
      size: 15360,
    });
    // Raw inline image stays null here so addImage keeps owning .bubble.image (#100).
    expect(
      api.asstBlockOf({ type: 'image', mimeType: 'image/png', data: PNG }),
    ).toBeNull();

    const rows = api.replayStoredPage([
      {
        v: 1,
        type: 'session_update',
        data: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Here is your Q3 report:' },
        },
      },
      {
        v: 1,
        type: 'session_update',
        data: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'resource_link',
            uri: 'file:///workspace/reports/q3.pdf',
            name: 'q3.pdf',
            mimeType: 'application/pdf',
            size: 15360,
          },
        },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('asst');
    expect(rows[0].text).toBe('Here is your Q3 report:');
    expect(rows[0].parts).toHaveLength(1);
  });

  it('renders an inline file card inside the assistant bubble for resource_link and triggers download', () => {
    model.appendAssistant('Generated the report.');
    model.addAssistantPart(
      api.asstBlockOf({
        type: 'resource_link',
        uri: 'file:///workspace/reports/q3.pdf',
        name: 'q3.pdf',
        mimeType: 'application/pdf',
        size: 15360,
      }),
    );
    tick();
    const card = scroller.querySelector('.bubble.asst .asst-file-card')!;
    expect(card).not.toBeNull();
    expect(card.querySelector('.asst-file-ext')?.textContent).toBe('PDF');
    expect(card.querySelector('.asst-file-name')?.textContent).toBe('q3.pdf');
    expect(card.querySelector('.asst-file-meta')?.textContent).toContain(
      'reports/q3.pdf',
    );
    expect(card.querySelector('.asst-file-meta')?.textContent).toContain(
      '15 KB',
    );
    const btn = card.querySelector('button.tool-dl') as HTMLButtonElement;
    expect(btn.textContent).toBe('Download q3.pdf');
    btn.click();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].workspacePath).toBe('reports/q3.pdf');
    expect(discovered.some((d) => d.workspacePath === 'reports/q3.pdf')).toBe(
      true,
    );
    expect(model.search('q3.pdf')).toHaveLength(1);
  });

  it('turns workspace markdown links and images into inline file cards with raster previews', async () => {
    model.appendAssistant(
      'See [users.csv](exports/users.csv) and ![Chart](charts/plot.png).',
    );
    tick();
    await flush();
    const cards = scroller.querySelectorAll('.bubble.asst .asst-file-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.asst-file-name')?.textContent).toBe(
      'users.csv',
    );
    expect(cards[1].querySelector('.asst-file-name')?.textContent).toBe(
      'plot.png',
    );
    const thumb = cards[1].querySelector('img.att-thumb');
    expect(thumb?.getAttribute('src')).toBe('blob:ws-thumb-charts/plot.png');

    // Clicking the inline markdown link downloads without navigating away.
    const link = scroller.querySelector(
      '.bubble.asst a.md-ws-link',
    ) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    link.click();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].workspacePath).toBe('exports/users.csv');
  });

  it('renders inline file cards on completed record_artifact / tool rows and standalone file rows', async () => {
    model.upsertTool({
      toolCallId: 't1',
      title: 'Recording artifact chart.png',
      status: 'completed',
      _meta: { toolName: 'record_artifact' },
      rawInput: { title: 'Chart', workspacePath: 'out/chart.png' },
    });
    model.upsertAssistantFile({
      key: 'art:snap-9',
      snapshotId: 'snap-9',
      name: 'Interactive Tour.html',
      kind: 'html',
      size: 4096,
    });
    tick();
    await flush();

    const toolCard = scroller.querySelector('.bubble.tool .asst-file-card')!;
    expect(toolCard).not.toBeNull();
    expect(toolCard.querySelector('.asst-file-name')?.textContent).toBe(
      'chart.png',
    );
    expect(
      toolCard.querySelector('img.att-thumb')?.getAttribute('src'),
    ).toBe('blob:ws-thumb-out/chart.png');

    const fileBubble = scroller.querySelector('.bubble.asst-file-bubble')!;
    expect(fileBubble).not.toBeNull();
    expect(fileBubble.querySelector('.asst-file-name')?.textContent).toBe(
      'Interactive Tour.html',
    );
    (fileBubble.querySelector('button.tool-dl') as HTMLButtonElement).click();
    expect(downloads.at(-1)?.snapshotId).toBe('snap-9');
  });

  it('offers a Download button on inline base64 assistant images (#100)', () => {
    model.addImage('image/png', PNG);
    tick();
    const dl = scroller.querySelector(
      '.bubble.image .image-file-acts button.tool-dl',
    ) as HTMLButtonElement;
    expect(dl).not.toBeNull();
    dl.click();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].data).toBe(PNG);
  });

  it('swaps between warm session models in one frame via setModel without losing rows', () => {
    const modelB = api.createTranscriptModel();
    model.appendAssistant('Reply in session A');
    modelB.appendAssistant('Reply in session B');
    tick();
    expect(scroller.textContent).toContain('Reply in session A');

    (view as View & { setModel: (m: Model) => void }).setModel(modelB);
    tick();
    expect(scroller.textContent).toContain('Reply in session B');
    expect(scroller.textContent).not.toContain('Reply in session A');

    // Background updates to session A while B is on screen remain intact when swapping back.
    model.appendAssistant(' + streamed in background');
    (view as View & { setModel: (m: Model) => void }).setModel(model);
    tick();
    expect(scroller.textContent).toContain(
      'Reply in session A + streamed in background',
    );
  });
});
