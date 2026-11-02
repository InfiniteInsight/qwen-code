/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manual verification (NOT a CI test) for the background task roster reaching
 * the web shell's status line (issues InfiniteInsight/Qwen-Code-Remote#222 to
 * #225). Each scenario prints `PASS|FAIL <name>`; the process exits 1 on any
 * FAIL.
 *
 *   npx tsx scripts/verify-background-task-visibility.mts
 *   ONLY=P3,P5 npx tsx scripts/verify-background-task-visibility.mts
 *
 * Each scenario boots its own gateway, stub daemon and browser and drives the
 * shipped public/index.html through the page's own globals, so what is under
 * test is the shipped shell rather than a copy of its logic.
 *
 * Whether the poll is still running is read off the stub's own log
 * (stub.state.tasksQueries) and never off the DOM: the panel only ever shows
 * the last draw, so it cannot say whether another read is coming. The status
 * line is read off its own dataset.state, which is what the colour and the
 * word are keyed on.
 */
import type { Page } from 'playwright';
import {
  bootViewer,
  type BootViewerOptions,
  type Frame,
  type Viewer,
} from './lib/viewerHarness.mjs';

type Result = { name: string; ok: boolean; detail: string };

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** One roster row as the daemon's /session/:id/tasks serves it. */
function shellRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bg_one',
    kind: 'shell',
    status: 'running',
    label: 'vitest run',
    command: 'vitest run',
    pid: 4100,
    startTime: 1_800_000_000_000,
    runtimeMs: 41_000,
    ...over,
  };
}

/** The frame that marks the stream connected and draws nothing. */
function ready(): Frame[] {
  return [{ id: 1, type: 'client_joined', data: {} }];
}

const EXEC_OPTIONS = [
  { optionId: 'proceed_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
];
const PERM_FRAME = (requestId: string, command: string) => ({
  requestId,
  toolCall: {
    toolCallId: 'tc-' + requestId,
    title: command,
    kind: 'execute',
    rawInput: { command, description: 'clear the caches' },
  },
  options: EXEC_OPTIONS,
});
const PERM_PENDING = (requestId: string, command: string) => ({
  requestId,
  kind: 'permission',
  createdAt: '2026-11-02T09:00:00.000Z',
  action: { type: 'execute', title: command, input: { command } },
  options: EXEC_OPTIONS.map((o) => ({ optionId: o.optionId, label: o.name, kind: o.kind })),
});

type Opened = { viewer: Viewer; page: Page; rosterReads: string[] };

/** Boots one scenario's stack and loads the shell; no session watched yet. */
async function open(opts: BootViewerOptions = {}): Promise<Opened> {
  const viewer = await bootViewer({ holdOpenMs: 600_000, ...opts });
  const { page } = viewer;
  // What the browser actually put on the wire, which is the only place the
  // page's own choice of query parameters is visible.
  const rosterReads: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (/\/session\/[^/]+\/tasks$/.test(u.pathname)) {
      rosterReads.push(u.pathname + u.search);
    }
  });
  await page.setViewportSize({ width: 1280, height: 810 });
  await page.goto(`${viewer.url}/ui/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof startWatch === 'function');
  return { viewer, page, rosterReads };
}

async function watch(page: Page, id: string): Promise<void> {
  await page.evaluate((sid) => {
    void startWatch(sid);
  }, id);
}

type Status = { state: string; word: string };

async function status(page: Page): Promise<Status> {
  return (await page.evaluate(() => ({
    state: document.getElementById('h1-status').dataset.state ?? '',
    word: document.getElementById('h1-state').textContent ?? '',
  }))) as Status;
}

async function waitState(page: Page, want: string, timeout = 20_000): Promise<Status> {
  await page.waitForFunction(
    (w) => (document.getElementById('h1-status').dataset.state ?? '') === w,
    want,
    { timeout },
  );
  return status(page);
}

/** Waits for the status line to leave a state, and returns what it became. */
async function waitStateNot(page: Page, gone: string, timeout = 20_000): Promise<Status> {
  await page.waitForFunction(
    (g) => (document.getElementById('h1-status').dataset.state ?? '') !== g,
    gone,
    { timeout },
  );
  return status(page);
}

async function runsText(page: Page): Promise<string> {
  return (await page.evaluate(
    () => document.getElementById('runs-body').textContent ?? '',
  )) as string;
}

/** Reads the stub's own count of roster reads. */
function readCount(viewer: Viewer): number {
  return viewer.stub.tasksQueries.length;
}

// The Runs panel ships hidden behind the More screen, and a click needs a
// visible target, so a scenario that presses stop opens it the way a reader
// does. textContent reads a hidden node fine, which is why the row checks
// above never needed this.
async function openRuns(page: Page): Promise<void> {
  if (await page.isVisible('#panel-runs')) return;
  if (await page.isVisible('#panel-screen')) await page.click('#panel-back');
  if (!(await page.isVisible('#more-screen'))) await page.click('#h1-more');
  await page.click('#more-screen .row[data-panel="runs"]');
}

const CASES: Array<{ name: string; run: () => Promise<string> }> = [];

CASES.push({
  name: 'P1 a running shell with no turn open reads bg with the count and the oldest label, and the rows appear with no click',
  run: async () => {
    const { viewer, page, rosterReads } = await open({
      frames: ready(),
      runs: {
        tasks: [
          shellRow({
            id: 'bg_old',
            label: 'pnpm build',
            command: 'pnpm build',
            startTime: 1_800_000_000_000,
            runtimeMs: 63_000,
          }),
          shellRow({
            id: 'bg_new',
            label: 'vitest run',
            startTime: 1_800_000_030_000,
            runtimeMs: 9_000,
          }),
        ],
      },
    });
    try {
      await watch(page, viewer.sessionId);
      const s = await waitState(page, 'bg');
      expect(
        s.word.startsWith('2 background, '),
        `the status line reads ${JSON.stringify(s.word)}`,
      );
      expect(
        s.word.includes('pnpm build'),
        `the word names the newer row rather than the oldest: ${JSON.stringify(s.word)}`,
      );
      const rows = await runsText(page);
      expect(
        rows.includes('pnpm build') && rows.includes('vitest run'),
        `the panel holds ${JSON.stringify(rows)} although nothing was clicked`,
      );
      expect(rosterReads.length > 0, 'no roster read ever reached the daemon');
      expect(
        rosterReads.every((u) => !u.includes('includeWorkflows')),
        `the ambient read asked for workflow rows: ${JSON.stringify(rosterReads)}`,
      );
      return `state bg reading ${JSON.stringify(s.word)} over ${rosterReads.length} read(s), none asking for workflow rows`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P2 a pinned permission card outranks the background word, and bg returns when the card is answered',
  run: async () => {
    const { viewer, page } = await open({
      frames: [
        ...ready(),
        { id: 2, type: 'permission_request', data: PERM_FRAME('p2-p', 'gh cache delete --all') },
      ],
      runs: { tasks: [shellRow()] },
    });
    try {
      // The status read is what retires a card the daemon no longer holds, so
      // keep it listed while the scenario votes.
      const pending = new Map<string, unknown>([
        ['p2-p', PERM_PENDING('p2-p', 'gh cache delete --all')],
      ]);
      await page.route(/\/session\/[^/]+\/status$/, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            workspaceCwd: '/proj',
            clientCount: 1,
            hasActivePrompt: true,
            pendingInteractions: [...pending.values()],
          }),
        }),
      );
      page.on('requestfinished', (r) => {
        const m = /\/permission\/([^/?]+)$/.exec(new URL(r.url()).pathname);
        if (m) pending.delete(decodeURIComponent(m[1]!));
      });
      await watch(page, viewer.sessionId);
      await page.waitForFunction(
        () => !!document.querySelector('#cards .pcard:not([hidden]):not(.retiring)'),
        null,
        { timeout: 20_000 },
      );
      const pinned = await status(page);
      expect(
        pinned.state === 'wait' && pinned.word === 'waiting for you',
        `a running row outran the pinned card: ${JSON.stringify(pinned)}`,
      );
      await page.click('#cards .pcard:not([hidden]):not(.retiring) .pc-allow');
      const back = await waitState(page, 'bg');
      expect(
        back.word.startsWith('1 background, '),
        `after the answer the line reads ${JSON.stringify(back)}`,
      );
      return `the card held ${JSON.stringify(pinned.word)} over the run, then ${JSON.stringify(back.word)}`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P3 a run that settles stops the re-read: the line leaves bg and the daemon is asked nothing further',
  run: async () => {
    let reads = 0;
    const { viewer, page } = await open({
      frames: ready(),
      runs: {
        tasks: () => {
          reads += 1;
          return reads === 1
            ? [shellRow()]
            : [
                shellRow({
                  status: 'completed',
                  endTime: 1_800_000_041_000,
                  exitCode: 0,
                }),
              ];
        },
      },
    });
    try {
      await watch(page, viewer.sessionId);
      await waitState(page, 'bg');
      const settled = await waitStateNot(page, 'bg');
      expect(
        settled.state === 'idle',
        `a settled roster left the line at ${JSON.stringify(settled)}`,
      );
      const rows = await runsText(page);
      expect(
        rows.includes('completed') && rows.includes('exit 0'),
        `the settled row reads ${JSON.stringify(rows)}`,
      );
      const after = readCount(viewer);
      expect(after >= 2, `the settle was never re-read (${after} read(s))`);
      await sleep(3_500);
      expect(
        readCount(viewer) === after,
        `the poll kept running after every row settled (${after} then ${readCount(viewer)} reads)`,
      );
      return `bg gave ${JSON.stringify(settled.word)}, ${after} reads and no more over 3.5s`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P4 an empty roster asks once and starts no timer',
  run: async () => {
    const { viewer, page } = await open({ frames: ready(), runs: { tasks: [] } });
    try {
      await watch(page, viewer.sessionId);
      await waitState(page, 'idle');
      const rows = await runsText(page);
      expect(rows === '(no runs)', `an empty roster drew ${JSON.stringify(rows)}`);
      const after = readCount(viewer);
      expect(after === 1, `an empty roster was read ${after} times`);
      await sleep(3_500);
      expect(
        readCount(viewer) === after,
        `an empty roster kept asking (${after} then ${readCount(viewer)} reads)`,
      );
      return `one read, ${(await status(page)).word}, and the panel at ${JSON.stringify(rows)}`;
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P5 a failed roster read keeps the last status: the line stays bg and never claims idle',
  run: async () => {
    const { viewer, page } = await open({
      frames: ready(),
      runs: { tasks: [shellRow()] },
    });
    try {
      await watch(page, viewer.sessionId);
      const before = await waitState(page, 'bg');
      await page.route(/\/session\/[^/]+\/tasks$/, (route) =>
        route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'daemon_unreachable' } }),
        }),
      );
      await sleep(3_500);
      const after = await status(page);
      expect(
        after.state === 'bg',
        `a failed read moved the line to ${JSON.stringify(after)}`,
      );
      expect(
        after.word === before.word,
        `a failed read changed the word from ${JSON.stringify(before.word)} to ${JSON.stringify(after.word)}`,
      );
      const rows = await runsText(page);
      expect(
        rows.includes('vitest run') && rows.includes('list failed'),
        `the panel over a failed read holds ${JSON.stringify(rows)}`,
      );
      return `held ${JSON.stringify(after.word)} through a 502, rows kept under ${JSON.stringify(rows.split('\n')[0])}`;
    } finally {
      await viewer.close();
    }
  },
});

// The cancel is answered here rather than by the stub: the gateway's own SDK
// client throws for a session the page never created through it, so the real
// route answers 502 and the page would only ever show its transport failure.
// What is under test is the page's reading of the verdict body, which the
// gateway's pass-through is covered elsewhere.
async function serveCancel(page: Page, verdict: Record<string, unknown>): Promise<void> {
  await page.route(/\/tasks\/[^/]+\/cancel$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(verdict),
    }),
  );
}

CASES.push({
  name: 'P6 stop is judged by body.cancelled, so a 200 that did not stop the run is not printed as stopped, and it survives the next redraw',
  run: async () => {
    const { viewer, page } = await open({
      frames: ready(),
      runs: { tasks: [shellRow()] },
    });
    try {
      await watch(page, viewer.sessionId);
      await waitState(page, 'bg');
      await serveCancel(page, { sessionId: viewer.sessionId, taskId: 'bg_one', cancelled: false, reason: 'busy' });
      await openRuns(page);
      await page.click('#runs-body button');
      await page.waitForFunction(
        () => /did not stop/.test(document.getElementById('runs-body').textContent ?? ''),
        null,
        { timeout: 15_000 },
      );
      // The poll redraws this row from the roster a second later; the verdict
      // has to outlive that redraw or the reader watches their own result
      // vanish.
      await sleep(2_500);
      const rows = await runsText(page);
      expect(
        /did not stop/.test(rows),
        `the next redraw erased the verdict: ${JSON.stringify(rows)}`,
      );
      expect(
        !/stopped/.test(rows),
        `a run the daemon did not stop was printed as stopped: ${JSON.stringify(rows)}`,
      );
      return JSON.stringify(rows);
    } finally {
      await viewer.close();
    }
  },
});

CASES.push({
  name: 'P7 a cancel the daemon confirms reads stopped, so the refusal above is not a blanket failure',
  run: async () => {
    const { viewer, page } = await open({
      frames: ready(),
      runs: { tasks: [shellRow()] },
    });
    try {
      await watch(page, viewer.sessionId);
      await waitState(page, 'bg');
      await serveCancel(page, { sessionId: viewer.sessionId, taskId: 'bg_one', cancelled: true });
      await openRuns(page);
      await page.click('#runs-body button');
      await page.waitForFunction(
        () => /stopped/.test(document.getElementById('runs-body').textContent ?? ''),
        null,
        { timeout: 15_000 },
      );
      await sleep(2_500);
      const rows = await runsText(page);
      expect(
        /stopped/.test(rows),
        `the next redraw erased the confirmation: ${JSON.stringify(rows)}`,
      );
      return JSON.stringify(rows);
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
      results.push({ name: c.name, ok: true, detail: (await c.run()) + ` (${((Date.now() - started) / 1000).toFixed(1)}s)` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name: c.name, ok: false, detail: msg.split('\n')[0]! + ` (${((Date.now() - started) / 1000).toFixed(1)}s)` });
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