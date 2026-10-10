/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manual measurement harness (NOT a CI test) for the viewer's long-session
 * growth (issue InfiniteInsight/Qwen-Code-Remote#57). Boots the real gateway
 * against the stub daemon, replays a synthetic N-turn session into the shipped
 * public/index.html in headless Chromium, and reports JS heap, DOM node count,
 * the size of the hidden raw-JSON log, and per-chunk streaming cost (both the
 * synchronous frame handling, `perChunkMs`, and the main-thread time per
 * chunk with one chunk per animation frame, `perChunkFrameMs`, which includes
 * deferred rendering). It also attributes heap to the transcript vs. the raw
 * log by clearing each in turn.
 *
 *   npx tsx scripts/measure-viewer-growth.mts
 *   TURNS=3000 CHUNKS=30 npx tsx scripts/measure-viewer-growth.mts
 */
import { execFileSync } from 'node:child_process';
import { bootViewer, type Frame } from './lib/viewerHarness.mjs';

const TURNS = Number(process.env['TURNS'] ?? 2000);
const CHUNKS = Number(process.env['CHUNKS'] ?? 20);

function buildFrames(): Frame[] {
  const frames: Frame[] = [];
  let id = 0;
  const upd = (update: Record<string, unknown>) =>
    frames.push({ id: ++id, type: 'session_update', data: { update } });
  for (let t = 0; t < TURNS; t++) {
    upd({ sessionUpdate: 'user_message_chunk', content: { text: `q${t}` } });
    for (let k = 0; k < 3; k++)
      upd({
        sessionUpdate: 'agent_thought_chunk',
        content: { text: `thinking about turn ${t} step ${k}. ` },
      });
    for (let k = 0; k < CHUNKS; k++)
      upd({
        sessionUpdate: 'agent_message_chunk',
        content: { text: `turn ${t} chunk ${k}: lorem ipsum dolor sit amet. ` },
      });
    upd({
      sessionUpdate: 'tool_call',
      toolCallId: `tc-${t}`,
      title: 'read_file',
      status: 'in_progress',
    });
    upd({
      sessionUpdate: 'tool_call_update',
      toolCallId: `tc-${t}`,
      status: 'completed',
    });
    frames.push({ id: ++id, type: 'turn_complete', data: {} });
  }
  return frames;
}

async function main(): Promise<void> {
  const frames = buildFrames();
  const viewer = await bootViewer({ frames, holdOpenMs: 600_000 });
  const { page, url } = viewer;
  const browser = page.context().browser()!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const heapMb = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = metrics.find((x) => x.name === 'JSHeapUsedSize');
    return (m?.value ?? 0) / 1024 / 1024;
  };

  await page.goto(`${url}/ui/`);
  const browserCdp = await browser.newBrowserCDPSession();
  const rendererRssMb = async (): Promise<number> => {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const pids = processInfo
      .filter((p) => p.type === 'renderer')
      .map((p) => p.id);
    let max = 0;
    for (const pid of pids) {
      const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf8',
      });
      max = Math.max(max, Number(out.trim() || 0));
    }
    return max / 1024;
  };
  const t0 = Date.now();
  page.on('crash', () => console.error('PAGE CRASHED'));
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.evaluate((id) => {
    void startWatch(id);
  }, viewer.sessionId);
  const samples: Array<{ s: number; frames: number }> = [];
  const deadline = Date.now() + Number(process.env['TIMEOUT_S'] ?? 240) * 1000;
  for (;;) {
    const got = await page.evaluate(() => lastSeenEventId);
    samples.push({ s: Math.round((Date.now() - t0) / 1000), frames: got });
    if (got >= frames.length) break;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(2000);
  }
  const finished = samples[samples.length - 1]!.frames >= frames.length;
  const replayMs = Date.now() - t0;

  const stats = await page.evaluate(() => ({
    transcriptNodes: document.querySelectorAll('#transcript *').length,
    totalNodes: document.getElementsByTagName('*').length,
    logChars: document.getElementById('log')?.textContent?.length ?? 0,
  }));

  // Per-chunk streaming cost with the grown page (one assistant chunk). Both
  // numbers are the best of several rounds: GC pauses, timers and scheduler
  // noise only ever add time, and at these sizes they would dominate one
  // sample.
  //
  // First with one chunk per animation frame, as main-thread time (CDP
  // TaskDuration): this includes the render work a view defers to the frame.
  // It runs first so the streamed bubble is a realistic size.
  const taskMs = async (): Promise<number> => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return (metrics.find((x) => x.name === 'TaskDuration')?.value ?? 0) * 1000;
  };
  const FRAME_ROUNDS = 3;
  const FRAME_CHUNKS = 60;
  let perChunkFrameMs = Infinity;
  for (let round = 0; round < FRAME_ROUNDS; round++) {
    const before = await taskMs();
    await page.evaluate(async (n) => {
      for (let i = 0; i < n; i++) {
        renderFrame({
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { text: 'x' },
            },
          },
        });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }, FRAME_CHUNKS);
    perChunkFrameMs = Math.min(
      perChunkFrameMs,
      ((await taskMs()) - before) / FRAME_CHUNKS,
    );
  }

  // Then the synchronous frame handling alone, in batches of 200 until a
  // round's total is well above performance.now()'s resolution (~0.1 ms): a
  // virtualized page handles 200 chunks in a small fraction of that.
  const perChunkMs = await page.evaluate(() => {
    let best = Infinity;
    for (let round = 0; round < 5; round++) {
      let n = 0;
      const t = performance.now();
      do {
        for (let i = 0; i < 200; i++)
          renderFrame({
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { text: 'x' },
              },
            },
          });
        n += 200;
      } while (performance.now() - t < 50 && n < 50000);
      best = Math.min(best, (performance.now() - t) / n);
    }
    return best;
  });

  const heapAll = await heapMb();
  const rssMb = await rendererRssMb();

  console.log(
    JSON.stringify(
      {
        turns: TURNS,
        framesPerTurn: Math.round(frames.length / TURNS),
        frames: frames.length,
        replayMs,
        finished,
        progress: samples.filter(
          (_, i) =>
            i % Math.max(1, Math.floor(samples.length / 6)) === 0 ||
            i === samples.length - 1,
        ),
        ...stats,
        perChunkMs: Number(perChunkMs.toFixed(6)),
        perChunkFrameMs: Number(perChunkFrameMs.toFixed(4)),
        jsHeapMb: Number(heapAll.toFixed(1)),
        rendererRssMb: Number(rssMb.toFixed(0)),
      },
      null,
      2,
    ),
  );

  await viewer.close();
}

declare const startWatch: (id: string) => Promise<void>;
declare const lastSeenEventId: number;
declare const renderFrame: (ev: unknown) => void;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
