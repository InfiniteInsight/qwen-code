/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manual verification (NOT a CI test) for the composer's slash command picker
 * (InfiniteInsight/Qwen-Code-Remote#240). Each scenario prints `PASS|FAIL
 * <name>`; the process exits 1 on any FAIL.
 *
 *   npx tsx scripts/verify-slash-command-picker.mts
 *   ONLY=P3,P8 npx tsx scripts/verify-slash-command-picker.mts
 *
 * Every scenario drives the shipped public/index.html through the real gateway
 * and the stub daemon, in a phone-sized viewport, because the whole point of
 * the feature is the phone. Both command sources are answered by page.route
 * rather than by the stub's own defaults, for the reason the harness records
 * elsewhere: a scenario that asserts a drawn row has to name the row itself,
 * or it is checking an invention of the harness.
 *
 * The two assertions that carry the most weight are the ones that cannot be
 * made anywhere else. P1 compares the picker's name set against the Commands
 * panel's, which is what "the same two responses" has to mean in practice. P8
 * reads the box's computed height and the composer's place in the viewport,
 * which only the real page can answer: the harness's own container applies no
 * rules from index.html at all.
 */
import type { Page } from 'playwright';
import {
  bootViewer,
  type BootViewerOptions,
  type Viewer,
} from './lib/viewerHarness.mjs';

type Result = { name: string; ok: boolean; detail: string };

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * The watched session's own commands. `agents-review` is here to be the
 * substring-only match: the filter `rev` has to rank it below `review`, which
 * starts with it, and still show it.
 */
const SESSION_COMMANDS = [
  {
    name: 'review',
    description: 'review the pending diff',
    _meta: { sourceLabel: 'Built-in' },
  },
  {
    name: 'resume',
    description: 'resume a saved session',
    _meta: { sourceLabel: 'Built-in' },
  },
  {
    name: 'agents-review',
    description: 'fan out reviewers',
    _meta: { sourceLabel: 'Skill' },
  },
];

/** The gateway's own file commands, tagged with the scope and source the panel shows. */
const FILE_COMMANDS = [
  {
    name: 'deploy',
    description: 'ship the current build',
    scope: 'write',
    tool: null,
    sessionScope: 'session',
    args: null,
    source: 'user',
    invocableByYou: true,
  },
  {
    name: 'rebase',
    description: 'rebase onto main',
    scope: 'write',
    tool: null,
    sessionScope: 'session',
    args: null,
    source: 'workspace',
    invocableByYou: true,
  },
];

type Opened = {
  viewer: Viewer;
  page: Page;
  /** What the browser put on the wire, counted. A keystroke must not cost reads. */
  reads: { commands: number; supported: number; prompts: number };
};

type SourceFault = { commandsStatus?: number; supportedStatus?: number };

async function open(
  opts: BootViewerOptions & SourceFault = {},
  rows: {
    session?: unknown[];
    file?: unknown[];
  } = {},
): Promise<Opened> {
  const viewer = await bootViewer({ holdOpenMs: 600_000, ...opts });
  const { page } = viewer;
  const reads = { commands: 0, supported: 0, prompts: 0 };
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (/\/rc\/commands$/.test(p)) reads.commands += 1;
    if (/\/supported-commands$/.test(p)) reads.supported += 1;
    if (/\/session\/[^/]+\/prompt$/.test(p)) reads.prompts += 1;
  });
  const session = rows.session ?? SESSION_COMMANDS;
  const file = rows.file ?? FILE_COMMANDS;
  await page.route('**/rc/commands', (route) =>
    route.fulfill({
      status: opts.commandsStatus ?? 200,
      contentType: 'application/json',
      body: JSON.stringify({ commands: file }),
    }),
  );
  await page.route('**/supported-commands', (route) =>
    route.fulfill({
      status: opts.supportedStatus ?? 200,
      contentType: 'application/json',
      body: JSON.stringify({
        availableCommands: session,
        invocableByYou: true,
      }),
    }),
  );
  // A phone, because this feature exists for the phone. 390x844 is a common
  // viewport and short enough that an unbounded list would push the composer
  // out of it, which is the failure P8 is there to catch.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${viewer.url}/ui/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof startWatch === 'function');
  return { viewer, page, reads };
}

/** Watches the harness session and waits for the composer to be on screen. */
async function watch(page: Page, id: string): Promise<void> {
  await page.evaluate((sid) => {
    void startWatch(sid);
  }, id);
  await page.waitForFunction(
    () => document.getElementById('composer').style.display === '',
    undefined,
    { timeout: 20_000 },
  );
}

type Box = {
  visible: boolean;
  names: string[];
  note: string;
  selected: number;
};

/** The picker as the reader sees it: whether it is up, and what it lists. */
async function box(page: Page): Promise<Box> {
  return (await page.evaluate(() => {
    const el = document.getElementById('cmd-pick');
    const opts = Array.from(el.querySelectorAll('.cmdopt'));
    return {
      visible: !el.hidden,
      names: opts.map((o) => o.querySelector('.cmd-name').textContent ?? ''),
      note: Array.from(el.querySelectorAll('.cmd-note'))
        .map((n) => n.textContent ?? '')
        .join(' | '),
      selected: opts.findIndex(
        (o) => o.getAttribute('aria-selected') === 'true',
      ),
    };
  })) as Box;
}

/** The composer's own state, which is what a completion has to leave right. */
async function field(
  page: Page,
): Promise<{ value: string; caret: number; focus: string }> {
  return (await page.evaluate(() => {
    const el = document.getElementById('prompt');
    return {
      value: el.value,
      caret: el.selectionStart ?? -1,
      focus: document.activeElement ? document.activeElement.id : '',
    };
  })) as { value: string; caret: number; focus: string };
}

/**
 * Types into the composer. `wantsList` is what the finished text should be
 * asking for: with it, the wait is for the list or the no-match note to be
 * drawn; without it the text is one the picker must leave alone, so the wait is
 * only for the handlers to have run.
 */
async function type(page: Page, text: string, wantsList = true): Promise<void> {
  await page.locator('#prompt').click();
  await page.locator('#prompt').pressSequentially(text, { delay: 90 });
  if (!wantsList) {
    await sleep(500);
    return;
  }
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('#cmd-pick .cmdopt')).length > 0 ||
      document.querySelectorAll('#cmd-pick .cmd-note').length > 0,
    undefined,
    { timeout: 10_000 },
  );
}

async function clearField(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('prompt');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(150);
}

/** The Commands panel's row names, read off the panel itself. */
async function panelNames(page: Page): Promise<string[]> {
  // The Commands card lives behind More, so this drives the page's own reveal
  // and reads the key off the DOM rather than hard-coding which panel screen
  // happens to hold it today.
  await page.evaluate(() => {
    const card = document.getElementById('list-commands').closest('.panel');
    openPanel(card.dataset.panel);
  });
  await page.locator('#list-commands').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#commands-list .token-row').length > 0,
    undefined,
    { timeout: 15_000 },
  );
  return (await page.evaluate(() =>
    Array.from(document.querySelectorAll('#commands-list .token-row')).map(
      (row) => {
        // The label text node is the kind tag's next sibling inside the row's
        // info span; the row's own first span is that wrapper, whose next
        // sibling is the Invoke button.
        const kind = row.querySelector('.cmd-kind');
        const text = kind ? (kind.nextSibling?.textContent ?? '') : '';
        return (text ?? '').replace(/^\/([^ ]+) .*/, '/$1');
      },
    ),
  )) as string[];
}

type Case = { name: string; run: () => Promise<string> };

const CASES: Case[] = [];

CASES.push({
  name: 'P1 a leading slash opens the list, from both sources, and the panel agrees',
  async run() {
    const { viewer, page, reads } = await open();
    try {
      await watch(page, viewer.sessionId);
      await type(page, '/');
      const b = await box(page);
      expect(b.visible, 'the list did not open on a bare slash');
      expect(
        JSON.stringify(b.names) ===
          JSON.stringify([
            '/agents-review',
            '/deploy',
            '/rebase',
            '/resume',
            '/review',
          ]),
        `the unfiltered list drew ${JSON.stringify(b.names)}`,
      );
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#cmd-pick .cmdopt')).map((r) => ({
          tag: r.querySelector('.cmd-tag')?.textContent ?? '',
          desc: r.querySelector('.cmd-desc')?.textContent ?? '',
        })),
      );
      expect(
        rows[0].tag === 'session' && rows[1].tag === 'file',
        `rows are not tagged by source: ${JSON.stringify(rows)}`,
      );
      expect(
        rows[0].desc === 'fan out reviewers',
        `row one desc ${rows[0].desc}`,
      );
      // Counted before the panel is opened: pressing List commands buys its own
      // pair of reads, and what this asserts is that the picker's five keystrokes
      // of typing did not each buy one.
      expect(
        reads.commands === 1 && reads.supported === 1,
        `opening cost ${reads.commands} + ${reads.supported} reads, not one each`,
      );
      // The promise of the shared loader: the picker and the Commands panel cannot
      // disagree about what is available, because there is one read behind both
      // of them. Order is deliberately NOT compared: the panel groups by source
      // (session rows first, by its own comment) and the picker ranks by prefix
      // then name. Membership is the fact that must not drift.
      const panel = await panelNames(page);
      expect(
        JSON.stringify([...panel].sort()) ===
          JSON.stringify([...b.names].sort()),
        `picker ${JSON.stringify(b.names)} vs panel ${JSON.stringify(panel)}`,
      );
      expect(
        panel.length === new Set(panel).size,
        `the panel listed a name twice: ${JSON.stringify(panel)}`,
      );
      return `${b.names.length} rows from 2 sources, panel names identical`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P2 typing narrows: prefix first, substring kept, no match says so',
  async run() {
    const { viewer, page } = await open();
    try {
      await watch(page, viewer.sessionId);
      await type(page, '/re');
      const all = await box(page);
      expect(
        JSON.stringify(all.names) ===
          JSON.stringify(['/rebase', '/resume', '/review', '/agents-review']),
        `filter "re" drew ${JSON.stringify(all.names)}`,
      );
      await type(page, 'v');
      const rev = await box(page);
      expect(
        JSON.stringify(rev.names) ===
          JSON.stringify(['/review', '/agents-review']),
        `filter "rev" drew ${JSON.stringify(rev.names)}: prefix rank lost`,
      );
      expect(
        rev.selected === 0,
        `highlight sat on ${rev.selected} after refilter`,
      );
      await clearField(page);
      await type(page, '/zzz');
      const none = await box(page);
      expect(
        none.names.length === 0,
        `zzz still listed ${JSON.stringify(none.names)}`,
      );
      expect(
        none.note.includes('no command matches /zzz'),
        `no-match note was ${JSON.stringify(none.note)}`,
      );
      return `"rev" ranked /review over /agents-review; /zzz said ${JSON.stringify(none.note)}`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P3 arrows move the highlight and Tab completes without sending',
  async run() {
    const { viewer, page, reads } = await open();
    try {
      await watch(page, viewer.sessionId);
      await type(page, '/re');
      const before = await box(page);
      expect(before.selected === 0, `open list highlighted ${before.selected}`);
      await page.keyboard.press('ArrowDown');
      expect((await box(page)).selected === 1, 'ArrowDown did not move down');
      await page.keyboard.press('ArrowUp');
      expect((await box(page)).selected === 0, 'ArrowUp did not move back');
      await page.keyboard.press('ArrowUp');
      expect(
        (await box(page)).selected === 3,
        'ArrowUp from the top did not wrap to the last row',
      );
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Tab');
      const f = await field(page);
      expect(
        f.value === '/resume ',
        `Tab left ${JSON.stringify(f.value)} in the box, not "/resume "`,
      );
      expect(f.caret === 8, `caret at ${f.caret}, not after the one space`);
      expect(f.focus === 'prompt', `focus went to ${f.focus}, not the field`);
      expect(
        (await box(page)).visible === false,
        'the list stayed open after Tab',
      );
      expect(
        reads.prompts === 0,
        `completing sent ${reads.prompts} prompt(s); completion inserts, it does not send`,
      );
      return `arrows moved and wrapped; Tab left ${JSON.stringify(f.value)} with the field focused and nothing sent`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P4 Enter completes the highlighted row and drops no newline',
  async run() {
    const { viewer, page, reads } = await open();
    try {
      await watch(page, viewer.sessionId);
      await type(page, '/dep');
      await page.keyboard.press('Enter');
      const f = await field(page);
      expect(
        f.value === '/deploy ',
        `Enter left ${JSON.stringify(f.value)}, not "/deploy "`,
      );
      expect(
        !f.value.includes('\n'),
        `Enter dropped a newline into ${JSON.stringify(f.value)}`,
      );
      expect(
        reads.prompts === 0,
        `Enter sent ${reads.prompts} prompt(s) from the picker`,
      );
      // Second Enter, with the list gone: the key is the field's again, and a
      // textarea writes the newline the user asked for.
      await page.keyboard.press('Enter');
      expect(
        (await field(page)).value === '/deploy \n',
        `Enter after the picker closed produced ${JSON.stringify((await field(page)).value)}`,
      );
      return `Enter completed /deploy and then behaved as a textarea again`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P5 Escape closes and keeps what is typed; Tab is the field’s again once shut',
  async run() {
    const { viewer, page } = await open();
    try {
      await watch(page, viewer.sessionId);
      await type(page, '/rev');
      await page.keyboard.press('Escape');
      const b = await box(page);
      const f = await field(page);
      expect(b.visible === false, 'Escape left the list open');
      expect(
        f.value === '/rev',
        `Escape changed the text to ${JSON.stringify(f.value)}`,
      );
      // With nothing open, Tab must not be eaten by the picker. It belongs to
      // the idle ghost when there is one and to the focus ring otherwise, and
      // either way the field has to give it up.
      await page.keyboard.press('Tab');
      const after = await field(page);
      expect(
        after.focus !== 'prompt',
        'Tab with the list closed did not leave the field; the picker owns a key it should not',
      );
      return `Escape kept ${JSON.stringify(f.value)} and shut the list; Tab moved focus to ${after.focus || 'nothing'}`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P6 past the token it closes, back inside the token it opens',
  async run() {
    const { viewer, page } = await open();
    try {
      await watch(page, viewer.sessionId);
      await type(page, '/review ', false);
      expect(
        (await box(page)).visible === false,
        'the list stayed up past the space',
      );
      // A message that only happens to start with a path is not a command.
      await clearField(page);
      await type(page, '/etc/hosts says otherwise', false);
      expect(
        (await box(page)).visible === false,
        'a path-shaped message got a command list over it',
      );
      // Put the caret back inside the first token: the list is wanted again.
      await clearField(page);
      await page.evaluate(() => {
        const el = document.getElementById('prompt');
        el.value = '/review --path src/a.ts';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await sleep(200);
      expect(
        (await box(page)).visible === false,
        'a space inside the first word opened it',
      );
      await page.evaluate(() => {
        const el = document.getElementById('prompt');
        el.focus();
        el.setSelectionRange(4, 4);
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForFunction(
        () => !document.getElementById('cmd-pick').hidden,
        undefined,
        { timeout: 8_000 },
      );
      const f = await field(page);
      await page.keyboard.press('Tab');
      const done = await field(page);
      expect(
        done.value === '/review --path src/a.ts',
        `completing mid-sentence rewrote the argument: ${JSON.stringify(done.value)}`,
      );
      expect(
        done.caret === 8,
        `caret landed at ${done.caret}, not before the surviving argument`,
      );
      return `closed past the space and for a path; reopened at caret 4 and kept the argument ${JSON.stringify(f.value === '/review --path src/a.ts' ? done.value : f.value)}`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P7 a tap completes, and the field keeps focus',
  async run() {
    const { viewer, page, reads } = await open();
    try {
      await watch(page, viewer.sessionId);
      await type(page, '/re');
      const b = await box(page);
      // Row one is /rebase (a file row) and row two /resume, both prefix
      // matches; the tap has to land on the row under the thumb, not the first.
      expect(b.names[1] === '/resume', `row two was ${b.names[1]}`);
      await page.locator('#cmd-pick .cmdopt').nth(1).click();
      const f = await field(page);
      expect(
        f.value === '/resume ',
        `tapping row two left ${JSON.stringify(f.value)}`,
      );
      expect(
        f.focus === 'prompt',
        `the tap took focus to ${f.focus || 'nothing'}; a thumb could not keep typing`,
      );
      expect(reads.prompts === 0, `the tap sent ${reads.prompts} prompt(s)`);
      return `tap on ${b.names[1]} inserted ${JSON.stringify(f.value)} with the field focused`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P8 a long list stays inside the bounded box and the composer stays on screen',
  async run() {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: 'cmd' + String(i).padStart(2, '0'),
      description: 'the ' + i + 'th command',
      scope: 'read',
      tool: null,
      sessionScope: 'session',
      args: null,
      source: 'user',
      invocableByYou: true,
    }));
    const { viewer, page } = await open({}, { file: many, session: [] });
    try {
      await watch(page, viewer.sessionId);
      await type(page, '/');
      const b = await box(page);
      expect(b.names.length === 40, `drew ${b.names.length} of 40 rows`);
      const geom = (await page.evaluate(() => {
        const boxEl = document.getElementById('cmd-pick');
        const cs = getComputedStyle(boxEl);
        const composer = document
          .getElementById('composer')
          .getBoundingClientRect();
        const fieldRect = document
          .getElementById('prompt')
          .getBoundingClientRect();
        return {
          maxHeight: cs.maxHeight,
          overflowY: cs.overflowY,
          scrollHeight: boxEl.scrollHeight,
          clientHeight: boxEl.clientHeight,
          boxHeight: boxEl.getBoundingClientRect().height,
          composerBottom: composer.bottom,
          fieldBottom: fieldRect.bottom,
          inner: window.innerHeight,
        };
      })) as {
        maxHeight: string;
        overflowY: string;
        scrollHeight: number;
        clientHeight: number;
        boxHeight: number;
        composerBottom: number;
        fieldBottom: number;
        inner: number;
      };
      expect(
        geom.maxHeight === '140px',
        `the box's max-height is ${geom.maxHeight}`,
      );
      expect(
        geom.overflowY === 'auto',
        `the box's overflow-y is ${geom.overflowY}`,
      );
      expect(
        geom.scrollHeight > geom.clientHeight,
        `40 rows did not need to scroll (${geom.scrollHeight} in ${geom.clientHeight})`,
      );
      // max-height bounds the CONTENT box, so the rendered height carries the
      // panel's own padding on top of the bound. The padding is read rather than
      // assumed, or this assertion becomes a statement about the stylesheet's
      // pixels instead of about its bound.
      const pad = (await page.evaluate(() => {
        const cs = getComputedStyle(document.getElementById('cmd-pick'));
        return parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      })) as number;
      expect(
        geom.boxHeight <= 140 + pad + 1,
        `the box grew to ${geom.boxHeight}px, past its 140px bound plus ${pad}px of padding`,
      );
      expect(
        geom.fieldBottom <= geom.inner + 1,
        `the composer's field sat at ${geom.fieldBottom} in a ${geom.inner} tall viewport`,
      );
      expect(
        geom.composerBottom <= geom.inner + 1,
        `the composer bottom was ${geom.composerBottom} in a ${geom.inner} tall viewport`,
      );
      return `40 rows in a ${Math.round(geom.boxHeight)}px bounded scrollable box, composer bottom ${Math.round(geom.composerBottom)} of ${geom.inner}`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P9 one source refused is named, not silently a shorter list',
  async run() {
    const { viewer, page } = await open({ supportedStatus: 502 });
    try {
      await watch(page, viewer.sessionId);
      await type(page, '/');
      const b = await box(page);
      expect(
        JSON.stringify(b.names) === JSON.stringify(['/deploy', '/rebase']),
        `with the session list refused it drew ${JSON.stringify(b.names)}`,
      );
      expect(
        b.note.includes('session commands'),
        `the refusal went unmentioned; note was ${JSON.stringify(b.note)}`,
      );
      return `session read refused, 2 file rows still listed, note ${JSON.stringify(b.note)}`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P10 a new conversation refetches rather than reusing the last one’s list',
  async run() {
    const { viewer, page, reads } = await open();
    try {
      await watch(page, viewer.sessionId);
      await type(page, '/');
      expect(
        (await box(page)).names.length === 5,
        'the first list was not full',
      );
      expect(
        reads.supported === 1,
        `first open read supported-commands ${reads.supported} times`,
      );
      await clearField(page);
      const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      await page.evaluate((sid) => {
        void startWatch(sid);
      }, other);
      await sleep(600);
      await type(page, '/');
      const b = await box(page);
      expect(
        b.names.length === 5,
        `after the switch it drew ${JSON.stringify(b.names)}`,
      );
      expect(
        reads.supported === 2,
        `the second conversation reused the cache (${reads.supported} reads for two sessions)`,
      );
      return `two conversations, ${reads.supported} session reads, ${b.names.length} rows each`;
    } finally {
      await viewer.close();
    }
  },
});

function selected(name: string): boolean {
  const only = process.env['ONLY'];
  if (!only) return true;
  const tag = name.split(' ')[0]!;
  return only.split(',').includes(tag);
}

async function main(): Promise<void> {
  const results: Result[] = [];
  for (const c of CASES) {
    if (!selected(c.name)) continue;
    const started = Date.now();
    try {
      results.push({
        name: c.name,
        ok: true,
        detail:
          (await c.run()) + ` (${((Date.now() - started) / 1000).toFixed(1)}s)`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        name: c.name,
        ok: false,
        detail:
          msg.split('\n')[0]! +
          ` (${((Date.now() - started) / 1000).toFixed(1)}s)`,
      });
    }
    const r = results[results.length - 1]!;
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} - ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
