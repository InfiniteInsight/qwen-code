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
 * the size of the hidden raw-JSON log, and per-chunk streaming cost. It also
 * attributes heap to the transcript vs. the raw log by clearing each in turn.
 *
 *   npx tsx scripts/measure-viewer-growth.mts
 *   TURNS=3000 CHUNKS=30 npx tsx scripts/measure-viewer-growth.mts
 */
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon } from '../src/testing/stubDaemon.js';
import { TokenStore } from '../src/tokenStore.js';
import { PairingService } from '../src/pairing.js';
import { createGatewayApp } from '../src/server.js';

const TURNS = Number(process.env['TURNS'] ?? 2000);
const CHUNKS = Number(process.env['CHUNKS'] ?? 20);
const SESSION = '11111111-2222-3333-4444-555555555555';

type Frame = { id: number; type: string; data: unknown };

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
  const stub = await startStubDaemon({ frames, holdOpenMs: 600_000 });
  const dir = mkdtempSync(join(tmpdir(), 'rc-measure-'));
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const { token } = await store.issue(['owner'], 'measure');
  const { app } = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(dir, 'audit.log'),
  });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const browser = await chromium.launch({
    args: ['--enable-precise-memory-info'],
    executablePath: process.env['CHROMIUM_PATH'] || undefined,
  });
  const page = await browser.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('qwen-rc-token', t);
  }, token);
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
  }, SESSION);
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

  // Per-chunk streaming cost with the grown page (one assistant chunk).
  const perChunkMs = await page.evaluate(() => {
    const N = 200;
    const t = performance.now();
    for (let i = 0; i < N; i++)
      renderFrame({
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { text: 'x' },
          },
        },
      });
    return (performance.now() - t) / N;
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
        perChunkMs: Number(perChunkMs.toFixed(3)),
        jsHeapMb: Number(heapAll.toFixed(1)),
        rendererRssMb: Number(rssMb.toFixed(0)),
      },
      null,
      2,
    ),
  );

  await browser.close();
  server.close();
  await stub.close();
}

declare const startWatch: (id: string) => Promise<void>;
declare const lastSeenEventId: number;
declare const renderFrame: (ev: unknown) => void;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
