/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendored = join(here, '..', 'public', 'vendor', 'markdown-it.js');
const scriptUrl = pathToFileURL(
  join(here, '..', 'scripts', 'vendor-markdown-it.mjs'),
).href;

const REGEN_HINT =
  'public/vendor/markdown-it.js is out of date with the installed ' +
  'markdown-it / esbuild. Re-run: ' +
  '`node scripts/vendor-markdown-it.mjs` (in packages/rc-gateway) and ' +
  'commit the result.';

describe('vendored markdown-it', () => {
  it('is byte-identical to a fresh build', async () => {
    const { buildMarkdownIt } = (await import(scriptUrl)) as {
      buildMarkdownIt: () => Promise<string>;
    };
    const fresh = await buildMarkdownIt();
    const committed = readFileSync(vendored, 'utf8');
    // The hint rides along as the "expected" string so it shows in the failure.
    expect(committed === fresh ? 'up to date' : REGEN_HINT).toBe('up to date');
  });

  it('exports exactly MarkdownIt', async () => {
    const mod = (await import(pathToFileURL(vendored).href)) as Record<
      string,
      unknown
    >;
    expect(typeof mod['MarkdownIt']).toBe('function');
    expect(Object.keys(mod).sort()).toEqual(['MarkdownIt']);
  });

  it('starts with a provenance comment naming the pinned version', () => {
    const firstLine = readFileSync(vendored, 'utf8').split('\n')[0];
    expect(firstLine).toMatch(/^\/\*.*markdown-it 15\.0\.0.*\*\/$/);
  });

  it('ships a license file', () => {
    const license = readFileSync(
      join(here, '..', 'public', 'vendor', 'markdown-it.LICENSE'),
      'utf8',
    );
    expect(license).toContain('Copyright (c) 2014 Vitaly Puzrin');
    expect(license).toContain('Permission is hereby granted, free of charge');
  });
});

// transcript-view.js walks markdown-it's token stream into DOM nodes and never
// calls render(), so the HTML string it would produce is not the safety
// boundary here. These checks pin the token-level contract the walker depends
// on, including the two properties that keep model-authored text from becoming
// markup: raw HTML arrives as escaped text, and hostile link targets never
// arrive as a link at all. A vendor bump that changes any of them fails here,
// not in a browser.
describe('token stream transcript-view.js relies on', () => {
  type Token = {
    type: string;
    tag: string;
    nesting: number;
    block: boolean;
    hidden: boolean;
    attrs: Array<[string, string]> | null;
    content: string;
    info: string;
    children: Token[] | null;
  };
  type Parser = {
    parse: (src: string, env: Record<string, unknown>) => Token[];
    validateLink: (url: string) => boolean;
  };

  async function make(): Promise<Parser> {
    const mod = (await import(pathToFileURL(vendored).href)) as {
      MarkdownIt: new (opts: Record<string, unknown>) => Parser;
    };
    // The exact options transcript-view.js constructs the parser with. If the
    // view ever turns html on, the raw-HTML checks below stop holding, and this
    // string is where that shows up.
    return new mod.MarkdownIt({
      html: false,
      linkify: false,
      typographer: false,
    });
  }

  function walk(tokens: Token[], fn: (t: Token) => void): void {
    for (const t of tokens) {
      fn(t);
      if (t.children) walk(t.children, fn);
    }
  }

  it('parses into a flat block sequence whose inline tokens carry children', async () => {
    const md = await make();
    const tokens = md.parse('# T\n\ntext', {});
    expect(tokens.map((t) => t.type)).toEqual([
      'heading_open',
      'inline',
      'heading_close',
      'paragraph_open',
      'inline',
      'paragraph_close',
    ]);
    expect(tokens.every((t) => t.block)).toBe(true);
    expect(tokens[1]!.children!.map((c) => c.type)).toEqual(['text']);
  });

  it('gives raw HTML no element to become: it arrives as a text token', async () => {
    const md = await make();
    for (const src of [
      '<img src=x onerror=alert(1)>',
      '<div onclick="alert(1)">hi</div>',
      '<script>alert(1)</script>',
    ]) {
      const tokens = md.parse(src, {});
      const types: string[] = [];
      walk(tokens, (t) => types.push(t.type));
      expect(types.some((t) => t === 'html_block' || t === 'html_inline')).toBe(
        false,
      );
      // The payload survives verbatim, so the viewer shows it as typed.
      const text = tokens
        .flatMap((t) => t.children ?? [t])
        .filter((t) => t.type === 'text')
        .map((t) => t.content)
        .join('');
      expect({ src, text }).toEqual({ src, text: src });
    }
  });

  it('refuses hostile link targets before they reach a token', async () => {
    const md = await make();
    for (const src of [
      '[click](javascript:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
      '[x](vbscript:msgbox(1))',
    ]) {
      const tokens = md.parse(src, {});
      const links: Token[] = [];
      walk(tokens, (t) => {
        if (t.type === 'link_open') links.push(t);
      });
      expect({ src, links }).toEqual({ src, links: [] });
    }
    const good = md.parse('[docs](https://example.com/a?b=1)', {});
    const links: Token[] = [];
    walk(good, (t) => {
      if (t.type === 'link_open') links.push(t);
    });
    expect(links).toHaveLength(1);
    expect(links[0]!.tag).toBe('a');
    expect(links[0]!.attrs).toEqual([['href', 'https://example.com/a?b=1']]);
  });

  it('keeps the language of a fence out of the token attrs', async () => {
    const md = await make();
    const [fence] = md.parse('```js\nconst a = 1;\n```', {});
    expect(fence!.type).toBe('fence');
    expect(fence!.tag).toBe('code');
    expect(fence!.nesting).toBe(0);
    expect(fence!.content).toBe('const a = 1;\n');
    // info is model-authored and unvalidated; markdown-it's own renderer puts it
    // in a class name, so the walker must not.
    expect(fence!.info).toBe('js');
    expect(fence!.attrs).toBeNull();
  });

  it('marks a tight list paragraph hidden but still emits its inline token', async () => {
    const md = await make();
    const tokens = md.parse('- a\n- b\n', {});
    const opens = tokens.filter((t) => t.type === 'paragraph_open');
    expect(opens).toHaveLength(2);
    expect(opens.every((t) => t.hidden)).toBe(true);
    expect(tokens.filter((t) => t.type === 'inline')).toHaveLength(2);
    expect(
      tokens
        .filter((t) => t.type === 'inline')
        .map((t) => t.children!.map((c) => c.content).join('')),
    ).toEqual(['a', 'b']);
  });

  it('emits empty text tokens at emphasis boundaries, so the walker skips them', async () => {
    const md = await make();
    const tokens = md.parse('**bold _mix_**', {});
    const empties = tokens[1]!.children!.filter(
      (t) => t.type === 'text' && t.content === '',
    );
    expect(empties.length).toBeGreaterThan(0);
  });

  it('validates links with the defaults the walker relies on', async () => {
    const md = await make();
    expect(md.validateLink('javascript:alert(1)')).toBe(false);
    expect(md.validateLink('data:text/html,x')).toBe(false);
    expect(md.validateLink('https://x')).toBe(true);
    expect(md.validateLink('mailto:a@b')).toBe(true);
    expect(md.validateLink('#frag')).toBe(true);
    expect(md.validateLink('/rel')).toBe(true);
  });

  // transcript-view.js copies the whole style attribute onto th/td (#101), which
  // is safe only because the parser emits nothing else. Pin that here: a vendor
  // bump that started emitting another attribute, or another property inside
  // style, would otherwise widen what model-authored text can set on a row, and
  // nothing in the tree would notice. The document is broad on purpose, because
  // the guard is about the whole emitted set rather than tables alone.
  it('emits no attribute beyond the set the copier relies on', async () => {
    const md = await make();
    const src =
      '| l | c | r |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n\n' +
      '# h\n\n[l](https://e.test/a) ![alt](https://e.test/i.png) **b**\n\n' +
      '- i\n\n> q\n\n```js\nx\n```\n\n---\n';
    const names = new Set<string>();
    const styles = new Set<string>();
    walk(md.parse(src, {}), (t) => {
      for (const [name, value] of t.attrs ?? []) {
        names.add(`${t.tag}::${name}`);
        if (name === 'style') styles.add(value);
      }
    });
    expect([...names].sort()).toEqual([
      'a::href',
      'img::alt',
      'img::src',
      'td::style',
      'th::style',
    ]);
    expect([...styles].sort()).toEqual([
      'text-align:center',
      'text-align:left',
      'text-align:right',
    ]);
  });
});
