/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Assistant text is markdown (#93). These drive the shipped transcript-view.js
// in jsdom — the real build/patch path, not a copy of the walker — because the
// property that matters is that model-authored text never becomes an element it
// did not ask for, and that lives in the wiring as much as in the parser.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const pub = (f: string) => join(here, '..', 'public', f);

type Item = { id: number; kind: string; text?: string };
type Model = {
  items: Item[];
  addUser: (t: string) => Item;
  appendAssistant: (t: string) => void;
  appendThought: (t: string) => void;
};
type View = { destroy: () => void };

let rafQueue = new Map<number, () => void>();
let rafId = 0;
let dom: JSDOM;
let scroller: HTMLElement;
let view: View | null = null;
let model: Model;

// Runs every pass the view scheduled, including one a pass itself schedules.
function tick(): void {
  for (let round = 0; round < 4 && rafQueue.size; round++) {
    const due = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, fn] of due) fn(0);
  }
}

async function attach(markdownIt: unknown): Promise<void> {
  const TranscriptModel = (globalThis as { TranscriptModel: never })
    .TranscriptModel as unknown as {
    createTranscriptModel: () => Model;
  };
  const TranscriptView = (globalThis as { TranscriptView: never })
    .TranscriptView as unknown as {
    createTranscriptView: (o: Record<string, unknown>) => View;
  };
  model = TranscriptModel.createTranscriptModel();
  view = TranscriptView.createTranscriptView({
    model,
    scroller,
    virtualCore: null, // the render-all path: every item is in the DOM
    markdownIt,
  });
  tick();
}

function asstRow(): Element | undefined {
  return [...scroller.querySelectorAll('.bubble.asst')].pop();
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window;
  rafQueue = new Map();
  rafId = 0;
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
});

afterEach(() => {
  if (view) view.destroy();
  view = null;
  dom.window.close();
});

// The bundle the page actually loads, so a change to public/vendor/markdown-it.js
// is covered here and not only by the freshness check.
async function bundle() {
  return import(pathToFileURL(join(pub('vendor'), 'markdown-it.js')).href);
}

describe('assistant markdown (#93)', () => {
  beforeEach(async () => {
    await attach(await bundle());
  });

  it('renders structure instead of showing the markup characters', () => {
    model.appendAssistant('# Title\n\nSome **bold** and `code`.\n');
    tick();
    const row = asstRow();
    expect(row?.querySelector('h1')?.textContent).toBe('Title');
    expect(row?.querySelector('strong')?.textContent).toBe('bold');
    expect(row?.querySelector('code')?.textContent).toBe('code');
    // The markers are gone from the text the reader sees.
    expect(row?.textContent).not.toContain('**');
    expect(row?.textContent).not.toContain('# Title');
  });

  it('renders a list as a list and a fence as a code block', () => {
    model.appendAssistant('- one\n- two\n\n```js\nconst a = 1;\n```\n');
    tick();
    const row = asstRow();
    expect(
      [...(row?.querySelectorAll('ul li') ?? [])].map((li) => li.textContent),
    ).toEqual(['one', 'two']);
    const pre = row?.querySelector('pre');
    expect(pre?.textContent).toContain('const a = 1;');
    // The fence body keeps its newlines: pre, not a re-flowed paragraph.
    expect(pre?.querySelector('code')).toBeTruthy();
  });

  it('keeps the fence language out of the attributes', () => {
    model.appendAssistant('```<img src=x onerror=alert(1)>\ncode\n```\n');
    tick();
    const code = asstRow()?.querySelector('pre code');
    expect(code?.getAttribute('class')).toBeNull();
    expect(code?.textContent).toContain('code');
  });

  it('makes no element from raw HTML in the text', () => {
    model.appendAssistant(
      '<img src=x onerror=alert(1)>\n\n<div onclick="alert(1)">hi</div>\n',
    );
    tick();
    const row = asstRow();
    expect(row?.querySelector('img')).toBeNull();
    expect(row?.querySelector('div[onclick]')).toBeNull();
    // Shown as typed, which is what the reader needs to see.
    expect(row?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('makes no link from a hostile target, and none from a relative one', () => {
    model.appendAssistant(
      [
        '[a](javascript:alert(1))',
        '[b](data:text/html;base64,PHN2Zz48L3N2Zz4=)',
        '[c](/etc/passwd)',
        '[d](../logout)',
        '[e](#top)',
      ].join('\n\n'),
    );
    tick();
    expect(asstRow()?.querySelectorAll('a')).toHaveLength(0);
  });

  it('links an absolute http target, opening it away from the session', () => {
    model.appendAssistant('see [the docs](https://example.com/a?b=1)\n');
    tick();
    const a = asstRow()?.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com/a?b=1');
    // The viewer holds a live session: a link must not navigate it away.
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toContain('noopener');
    expect(a?.textContent).toBe('the docs');
  });

  it('names an image without fetching it', () => {
    model.appendAssistant('![a chart](https://example.com/x.png)\n');
    tick();
    const row = asstRow();
    expect(row?.querySelector('img')).toBeNull();
    expect(row?.textContent).toContain('a chart');
  });

  it('renders a table without carrying its style attribute', () => {
    model.appendAssistant('| a | b |\n|:--|--:|\n| 1 | 2 |\n');
    tick();
    const row = asstRow();
    expect(row?.querySelectorAll('table thead th')).toHaveLength(2);
    expect(row?.querySelectorAll('tbody td')).toHaveLength(2);
    for (const cell of [...(row?.querySelectorAll('th, td') ?? [])]) {
      expect(cell.getAttribute('style')).toBeNull();
    }
  });

  it('re-renders as the text streams, so a closing marker completes the element', () => {
    model.appendAssistant('note ');
    tick();
    expect(asstRow()?.querySelector('strong')).toBeNull();
    model.appendAssistant('**bo');
    tick();
    // Still unbalanced: the markers are literal until they close.
    expect(asstRow()?.textContent).toContain('**bo');
    model.appendAssistant('ld**');
    tick();
    expect(asstRow()?.querySelector('strong')?.textContent).toBe('bold');
    expect(asstRow()?.textContent).not.toContain('**');
  });

  it('leaves the user and thought rows as typed text', () => {
    model.addUser('run **this** please');
    model.appendThought('thinking **hard**');
    model.appendAssistant('done **work**');
    tick();
    const user = scroller.querySelector('.bubble.user');
    expect(user?.querySelector('strong')).toBeNull();
    expect(user?.textContent).toContain('run **this** please');
    const thought = scroller.querySelector('.bubble.thought');
    expect(thought?.querySelector('strong')).toBeNull();
    expect(thought?.textContent).toContain('**hard**');
    // Only the assistant row parsed.
    expect(asstRow()?.querySelector('strong')?.textContent).toBe('work');
  });

  it('keeps the text when the parser cannot read it', () => {
    // A parser that throws must not blank the row.
    const broken = {
      MarkdownIt: class {
        parse() {
          throw new Error('cannot parse');
        }
      },
    };
    view?.destroy();
    view = null;
    return attach(broken).then(() => {
      model.appendAssistant('plain **text**');
      tick();
      expect(asstRow()?.textContent).toContain('plain **text**');
    });
  });
});

describe('a parser that hands over a tag the view does not allow', () => {
  // The whitelist in MD_TAGS is defense for a case the shipped parser cannot
  // produce (html:false never emits an html_block, and markdown-it has no
  // script rule). It guards a future parser or an enabled plugin, so it is
  // exercised here with a token stream built by hand rather than skipped as
  // unreachable.
  function fakeParser(tokens: unknown[]) {
    return {
      MarkdownIt: class {
        parse() {
          return tokens;
        }
        validateLink() {
          return true;
        }
      },
    };
  }

  function tok(over: Record<string, unknown>) {
    return {
      type: 'text',
      tag: '',
      nesting: 0,
      block: false,
      hidden: false,
      attrs: null,
      content: '',
      info: '',
      children: null,
      ...over,
    };
  }

  it('builds no element for it, and keeps the text', async () => {
    await attach(
      fakeParser([
        tok({ type: 'paragraph_open', tag: 'p', nesting: 1, block: true }),
        tok({
          type: 'inline',
          block: true,
          children: [
            // What a script rule or an html-enabled parser would hand over.
            tok({
              type: 'html_inline',
              content: '<script>alert(1)</script>',
            }),
            tok({
              type: 'evil_open',
              tag: 'script',
              nesting: 1,
              attrs: [['src', 'https://evil.example/x.js']],
            }),
            tok({ content: 'payload' }),
            tok({ type: 'evil_close', tag: 'script', nesting: -1 }),
          ],
        }),
        tok({ type: 'paragraph_close', tag: 'p', nesting: -1, block: true }),
      ]),
    );
    // The fake parser ignores its argument, so any text opens the row that
    // the hand-built tokens above get rendered into.
    model.appendAssistant('ignored');
    tick();
    const row = asstRow();
    expect(row).toBeTruthy();
    expect(row?.querySelector('script')).toBeNull();
    expect(scroller.querySelectorAll('script')).toHaveLength(0);
    expect(row?.querySelector('[src]')).toBeNull();
    // Skipped, not deleted: the text between the disallowed markers stays.
    expect(row?.textContent).toContain('payload');
    expect(row?.textContent).toContain('<script>alert(1)</script>');
  });

  it('still nests the children it does allow under the disallowed tag', async () => {
    await attach(
      fakeParser([
        tok({
          type: 'blockquote_open',
          tag: 'blockquote',
          nesting: 1,
          block: true,
        }),
        tok({ type: 'evil_open', tag: 'object', nesting: 1, block: true }),
        tok({ type: 'paragraph_open', tag: 'p', nesting: 1, block: true }),
        tok({
          type: 'inline',
          block: true,
          children: [tok({ content: 'kept' })],
        }),
        tok({ type: 'paragraph_close', tag: 'p', nesting: -1, block: true }),
        tok({ type: 'evil_close', tag: 'object', nesting: -1, block: true }),
        tok({
          type: 'blockquote_close',
          tag: 'blockquote',
          nesting: -1,
          block: true,
        }),
      ]),
    );
    model.appendAssistant('ignored');
    tick();
    const row = asstRow();
    expect(row).toBeTruthy();
    expect(row?.querySelector('object')).toBeNull();
    // The stack stays balanced across the skipped element, so the allowed
    // blockquote around it is still built correctly.
    const bq = row?.querySelector('blockquote');
    expect(bq?.textContent).toBe('kept');
    expect(bq?.querySelector('p')?.textContent).toBe('kept');
  });
});

describe('with no markdown bundle', () => {
  beforeEach(async () => {
    await attach(null);
  });

  it('shows assistant text as typed, the pre-#93 behaviour', () => {
    model.appendAssistant('# Title\n\nSome **bold** text.\n');
    tick();
    const row = asstRow();
    expect(row?.querySelector('.md')).toBeNull();
    expect(row?.querySelector('h1')).toBeNull();
    expect(row?.textContent).toContain('# Title');
    expect(row?.textContent).toContain('Some **bold** text.');
  });

  it('still appends the tail while streaming rather than re-rendering', () => {
    model.appendAssistant('first');
    tick();
    const body = asstRow()?.querySelector('span');
    const firstNode = body?.firstChild;
    model.appendAssistant(' second');
    tick();
    expect(asstRow()?.textContent).toContain('first second');
    // The text node was appended to, not replaced.
    expect(body?.firstChild).toBe(firstNode);
  });
});
