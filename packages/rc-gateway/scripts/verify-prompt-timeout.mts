/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manual verification (NOT a CI test) for the per-turn ceiling and its knob
 * (issues InfiniteInsight/Qwen-Code-Remote#237 and #238). Each scenario prints
 * `PASS|FAIL <name>`; the process exits 1 on any FAIL.
 *
 *   npx tsx scripts/verify-prompt-timeout.mts
 *   ONLY=P1,P5 npx tsx scripts/verify-prompt-timeout.mts
 *
 * What this adds over src/routes/prompt.test.ts, which already drives the route
 * with a hand-built audit recorder: here the number is produced the way the
 * shipped binary produces it. `parseServeFlags` reads the flag or the
 * environment, `promptTimeoutMsFromSec` converts it, and the result is handed to
 * `createGatewayApp` exactly as cli.ts hands it, so a scenario measures the whole
 * chain (knob -> route -> what the client and the audit trail actually got)
 * rather than the route alone.
 *
 * Every assertion is on a delivered artifact: the HTTP status and body, the
 * `stream_error` frame a real /session/:id/events subscriber receives, and the
 * `prompt_timed_out` row in the audit file. Never on a log substring. The boot
 * line that prints the effective ceiling is for the operator; a string in stdout
 * says nothing about what the route enforced.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { DaemonClient } from '@qwen-code/sdk';
import {
  startStubDaemon,
  type StubDaemon,
  type StubDaemonOptions,
} from '../src/testing/stubDaemon.js';
import { TokenStore } from '../src/tokenStore.js';
import { PairingService } from '../src/pairing.js';
import { createGatewayApp } from '../src/server.js';
import { parseServeFlags } from '../src/cli.js';
import {
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_SEC,
  promptTimeoutMsFromSec,
} from '../src/routes/promptTimeout.js';

type Result = { name: string; ok: boolean; detail: string };

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * The session under test. /session/:id/* validates the id against
 * SESSION_FILE_RE (32-36 hex+dash chars) before anything else, so a readable
 * placeholder like "sess-1" is a 404 and the scenario would measure the guard
 * rather than the ceiling.
 */
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

/**
 * Nothing here may resolve against the host's real ~/.qwen, so the runtime root
 * is redirected before anything reads it. (viewerHarness.mts has the same
 * helper but also imports Playwright; this verifier needs no browser.)
 */
process.env['QWEN_RUNTIME_DIR'] = mkdtempSync(
  join(tmpdir(), 'rc-timeout-home-'),
);

/** A gateway booted in front of the stub daemon. */
type Gateway = {
  url: string;
  token: string;
  dir: string;
  auditDir: string;
  stub: StubDaemon;
  close: () => Promise<void>;
};

/**
 * Boot a gateway given `promptTimeoutMs` the way cli.ts passes it, in front of a
 * stub that holds every prompt unanswered for `promptDelayMs`.
 */
async function bootGateway(
  promptTimeoutMs: number | undefined,
  promptDelayMs: number,
): Promise<Gateway> {
  const dir = mkdtempSync(join(tmpdir(), 'rc-timeout-'));
  const auditDir = join(dir, 'audit');
  const stubOpts: StubDaemonOptions = {
    frames: [],
    holdOpenMs: 60_000,
    promptDelayMs,
  };
  const stub = await startStubDaemon(stubOpts);
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const { token } = await store.issue(['owner'], 'verify-prompt-timeout');
  const { app } = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(auditDir, 'audit.log'),
    ...(promptTimeoutMs !== undefined ? { promptTimeoutMs } : {}),
  });
  const server: Server = await new Promise((resolve) => {
    const s = (app as Express).listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    token,
    dir,
    auditDir,
    stub,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every audit row the gateway has written so far. */
function auditRows(gw: Gateway): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const f of readdirSync(gw.auditDir).filter((n) =>
    /^audit-.*\.log$/.test(n),
  )) {
    for (const line of readFileSync(join(gw.auditDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // A torn trailing line mid-flush; the next read picks it up whole.
      }
    }
  }
  return rows;
}

/** A live /session/:id/events subscriber that parses SSE frames. */
type Watcher = {
  frames: Array<Record<string, unknown>>;
  waitFor: (
    pred: (f: Record<string, unknown>) => boolean,
    ms: number,
  ) => Promise<Record<string, unknown> | undefined>;
  close: () => void;
};

async function openWatcher(gw: Gateway, sessionId: string): Promise<Watcher> {
  const ac = new AbortController();
  const res = await fetch(`${gw.url}/session/${sessionId}/events`, {
    headers: {
      authorization: `Bearer ${gw.token}`,
      accept: 'text/event-stream',
    },
    signal: ac.signal,
  });
  if (!res.ok || !res.body) {
    ac.abort();
    throw new Error(`watch open failed with ${res.status}`);
  }
  const frames: Array<Record<string, unknown>> = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const cut = buf.indexOf('\n\n');
        if (cut < 0) break;
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            frames.push(JSON.parse(line.slice(5).trim()));
          } catch {
            // Comment lines and unparsable partials carry no frame.
          }
        }
      }
    }
  };
  void pump().catch(() => {
    // The socket ends when the watcher closes or the gateway shuts down.
  });
  return {
    frames,
    waitFor: async (pred, ms) => {
      const until = Date.now() + ms;
      for (;;) {
        const hit = frames.find(pred);
        if (hit) return hit;
        if (Date.now() > until) return undefined;
        await sleep(20);
      }
    },
    close: () => ac.abort(),
  };
}

/** POST a prompt; return the status and the parsed body. */
async function postPrompt(
  gw: Gateway,
  sessionId: string,
  text: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${gw.url}/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${gw.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prompt: text }),
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Non-JSON: the field assertions below fail loudly rather than silently.
  }
  return { status: res.status, body };
}

/**
 * The ceiling the shipped binary would enforce for these argv plus this
 * QWEN_RC_PROMPT_TIMEOUT_SEC. An explicit key set to undefined clears it, so a
 * scenario cannot inherit one from the operator's shell.
 */
function ceilingFromCli(
  argv: string[],
  env: Record<string, string | undefined>,
): { sec: number | undefined; ms: number } {
  const saved = process.env['QWEN_RC_PROMPT_TIMEOUT_SEC'];
  const want = env['QWEN_RC_PROMPT_TIMEOUT_SEC'];
  if (want === undefined) delete process.env['QWEN_RC_PROMPT_TIMEOUT_SEC'];
  else process.env['QWEN_RC_PROMPT_TIMEOUT_SEC'] = want;
  try {
    const parsed = parseServeFlags(['serve', ...argv]);
    return {
      sec: parsed.promptTimeoutSec,
      ms: promptTimeoutMsFromSec(parsed.promptTimeoutSec),
    };
  } finally {
    if (saved === undefined) delete process.env['QWEN_RC_PROMPT_TIMEOUT_SEC'];
    else process.env['QWEN_RC_PROMPT_TIMEOUT_SEC'] = saved;
  }
}

/** The frame the gateway injects when its own deadline fires. */
function isTimeoutFrame(f: Record<string, unknown>): boolean {
  const data = f['data'] as Record<string, unknown> | undefined;
  return f['type'] === 'stream_error' && data?.['code'] === 'prompt_timeout';
}

/** One turn driven end to end, with everything it left behind. */
type Turn = {
  sec: number | undefined;
  ms: number;
  status: number;
  body: Record<string, unknown>;
  frame: Record<string, unknown> | undefined;
  firings: Array<Record<string, unknown>>;
  actions: string[];
};

async function driveTurn(
  argv: string[],
  env: Record<string, string | undefined>,
  stubHoldMs: number,
): Promise<Turn> {
  const { sec, ms } = ceilingFromCli(argv, env);
  const gw = await bootGateway(ms, stubHoldMs);
  const sessionId = SESSION_ID;
  // Attach before the turn: the broadcast has no replay, so a subscriber that
  // shows up afterwards proves nothing about what the firing sent.
  const watcher = await openWatcher(gw, sessionId);
  try {
    const { status, body } = await postPrompt(gw, sessionId, 'hold the turn');
    const frame = await watcher.waitFor(isTimeoutFrame, 1_000);
    await sleep(150);
    const rows = auditRows(gw);
    return {
      sec,
      ms,
      status,
      body,
      frame,
      firings: rows.filter((r) => r['action'] === 'prompt_timed_out'),
      actions: rows.map((r) => String(r['action'])),
    };
  } finally {
    watcher.close();
    await gw.close();
  }
}

function detailOf(row: Record<string, unknown>): Record<string, unknown> {
  return (row['detail'] ?? {}) as Record<string, unknown>;
}

// ── Scenarios ───────────────────────────────────────────────────────────────

/** P1: --prompt-timeout-sec reaches the route and its firing is measurable. */
async function p1(): Promise<string> {
  const t = await driveTurn(
    ['--prompt-timeout-sec', '1'],
    { QWEN_RC_PROMPT_TIMEOUT_SEC: undefined },
    3_000,
  );
  expect(t.sec === 1 && t.ms === 1_000, `ceiling read as ${t.sec}s/${t.ms}ms`);
  expect(t.status === 504, `status was ${t.status}, want 504`);
  expect(
    t.body['code'] === 'prompt_timeout',
    `body code was ${String(t.body['code'])}`,
  );
  expect(
    t.body['timeoutMs'] === 1_000,
    `body timeoutMs was ${String(t.body['timeoutMs'])}, want 1000`,
  );
  const data = (t.frame?.['data'] ?? {}) as Record<string, unknown>;
  expect(
    t.frame !== undefined && data['timeoutMs'] === 1_000,
    `subscriber frame was ${t.frame ? JSON.stringify(data) : 'absent'}`,
  );
  expect(t.firings.length === 1, `${t.firings.length} audit rows, want 1`);
  const row = t.firings[0] ?? {};
  expect(row['target'] === SESSION_ID, `row target ${String(row['target'])}`);
  expect(
    detailOf(row)['timeoutMs'] === 1_000,
    `row timeoutMs ${String(detailOf(row)['timeoutMs'])}, want 1000`,
  );
  return `504 + stream_error + one prompt_timed_out row, all at 1000ms`;
}

/** P2: the environment fallback reaches the route, not just the parser. */
async function p2(): Promise<string> {
  const t = await driveTurn([], { QWEN_RC_PROMPT_TIMEOUT_SEC: '2' }, 4_000);
  expect(t.sec === 2 && t.ms === 2_000, `env ceiling read as ${t.sec}s`);
  expect(t.status === 504, `status was ${t.status}, want 504`);
  expect(
    t.body['timeoutMs'] === 2_000,
    `body timeoutMs ${String(t.body['timeoutMs'])}, want 2000 (the env value, ` +
      `not a default)`,
  );
  expect(t.firings.length === 1, `${t.firings.length} audit rows, want 1`);
  expect(
    detailOf(t.firings[0] ?? {})['timeoutMs'] === 2_000,
    'audit row did not carry the env-derived ceiling',
  );
  return 'QWEN_RC_PROMPT_TIMEOUT_SEC=2 enforced as 2000ms';
}

/** P3: the flag outranks the environment. */
async function p3(): Promise<string> {
  const t = await driveTurn(
    ['--prompt-timeout-sec', '1'],
    { QWEN_RC_PROMPT_TIMEOUT_SEC: '2' },
    3_000,
  );
  expect(t.ms === 1_000, `ceiling was ${t.ms}ms, want the flag at 1000ms`);
  expect(
    t.body['timeoutMs'] === 1_000,
    `body timeoutMs ${String(t.body['timeoutMs'])}, want 1000`,
  );
  expect(
    detailOf(t.firings[0] ?? {})['timeoutMs'] === 1_000,
    'audit row carried the env value, not the flag',
  );
  return 'flag 1s beat env 2s';
}

/** P4: a turn that finishes inside the ceiling is left alone entirely. */
async function p4(): Promise<string> {
  const t = await driveTurn(
    ['--prompt-timeout-sec', '2'],
    { QWEN_RC_PROMPT_TIMEOUT_SEC: undefined },
    200,
  );
  expect(t.status === 200, `status was ${t.status}, want 200`);
  expect(
    typeof t.body['stopReason'] === 'string',
    `no stopReason in ${JSON.stringify(t.body)}`,
  );
  expect(t.frame === undefined, 'a stream_error arrived for a turn that ended');
  expect(t.firings.length === 0, `${t.firings.length} firings, want 0`);
  expect(
    t.actions.includes('prompt_sent'),
    `no prompt_sent row in ${t.actions.join(',')}`,
  );
  return '200 with stopReason, no frame, no firing';
}

/** P5: one ceiling, one source, no stale 600s literals left behind. */
async function p5(): Promise<string> {
  expect(
    DEFAULT_PROMPT_TIMEOUT_SEC === 7_200,
    `DEFAULT_PROMPT_TIMEOUT_SEC is ${DEFAULT_PROMPT_TIMEOUT_SEC}`,
  );
  expect(
    promptTimeoutMsFromSec(undefined) === DEFAULT_PROMPT_TIMEOUT_MS,
    'unset does not fall back to the shared constant',
  );
  expect(DEFAULT_PROMPT_TIMEOUT_MS === 7_200_000, 'default is not 2 hours');
  const unset = ceilingFromCli([], { QWEN_RC_PROMPT_TIMEOUT_SEC: undefined });
  expect(
    unset.sec === undefined && unset.ms === 7_200_000,
    `no flag, no env gave ${unset.ms}ms`,
  );
  const routesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const routes = [
    'routes/prompt.ts',
    'routes/commands.ts',
    'routes/supportedCommands.ts',
  ];
  for (const r of routes) {
    const src = readFileSync(join(routesDir, r), 'utf8');
    expect(!/600_000|600000/.test(src), `${r} still hard-codes a 600s default`);
    expect(
      src.includes('./promptTimeout.js'),
      `${r} does not import the shared ceiling`,
    );
  }
  return '7200s default, three routes share it, no 600_000 left';
}

const SCENARIOS: Array<{ name: string; run: () => Promise<string> }> = [
  { name: 'P1', run: p1 },
  { name: 'P2', run: p2 },
  { name: 'P3', run: p3 },
  { name: 'P4', run: p4 },
  { name: 'P5', run: p5 },
];

const only = process.env['ONLY']
  ? process.env['ONLY'].split(',').map((s) => s.trim())
  : null;

const results: Result[] = [];
for (const s of SCENARIOS) {
  if (only && !only.includes(s.name)) continue;
  try {
    results.push({ name: s.name, ok: true, detail: await s.run() });
  } catch (err) {
    results.push({
      name: s.name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} ${r.detail}`);
}
process.exit(results.some((r) => !r.ok) ? 1 : 0);
