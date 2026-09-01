/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { createPromptRoute } from './prompt.js';
import { PromptQueue } from './promptQueue.js';
import { PromptEventBroadcaster } from './promptEventBroadcaster.js';

let server: Server | undefined;
let stub: StubDaemon | undefined;

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

interface MountOpts {
  queueWaitMs?: number;
  promptTimeoutMs?: number;
  promptEventBroadcaster?: PromptEventBroadcaster;
  queue?: PromptQueue;
}

async function mount(
  daemon: DaemonClient,
  audit: AuditRecorder,
  opts: MountOpts = {},
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = { id: 'tok1', scopes: ['write'] };
    next();
  });
  app.post(
    '/session/:id/prompt',
    createPromptRoute(daemon, audit, undefined, opts),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postPrompt(
  url: string,
  body: unknown,
  sessionId = 'sess-1',
): Promise<Response> {
  return fetch(`${url}/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('prompt route', () => {
  it('sends a string prompt and returns the stopReason (200)', async () => {
    stub = await startStubDaemon({ promptStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, { prompt: 'hello' });
    expect(res.status).toBe(200);
    expect((await res.json()).stopReason).toBe('end_turn');
  });

  it('accepts a blocks array verbatim (200)', async () => {
    stub = await startStubDaemon({ promptStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, {
      blocks: [{ type: 'text', text: 'hi' }],
    });
    expect(res.status).toBe(200);
  });

  it('400s an empty body', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, {});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_prompt');
  });

  it('400s an empty prompt string', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, { prompt: '' });
    expect(res.status).toBe(400);
  });

  it('400s an empty blocks array', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, { blocks: [] });
    expect(res.status).toBe(400);
  });

  it('502s when the daemon errors', async () => {
    stub = await startStubDaemon({ promptStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, { prompt: 'hello' });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('audits prompt_sent without the prompt text', async () => {
    stub = await startStubDaemon({ promptStatus: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mount(daemon, audit);
    const res = await postPrompt(url, { prompt: 'hello' });
    expect(res.status).toBe(200);
    const entry = audit.calls.find((c) => c.action === 'prompt_sent');
    expect(entry).toBeDefined();
    expect(entry!.actorTokenId).toBe('tok1');
    expect(entry!.target).toBe('sess-1');
    expect(entry!.detail).toMatchObject({ stopReason: 'end_turn' });
    expect(typeof entry!.detail!.blocks).toBe('number');
    // The audit entry must never carry the prompt text.
    expect(JSON.stringify(entry)).not.toContain('hello');
  });

  // ── Session FIFO / queue-wait timeout (Task 2.4) ─────────────────────────

  it('queues a second prompt behind the first and both succeed', async () => {
    // Slow daemon — first prompt takes 80ms, giving the second time to queue.
    stub = await startStubDaemon({ promptStatus: 200, promptDelayMs: 80 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    // Give both prompts 500ms queue-wait — plenty of time.
    const queue = new PromptQueue();
    const url = await mount(daemon, audit, { queueWaitMs: 500, queue });

    const [r1, r2] = await Promise.all([
      postPrompt(url, { prompt: 'first' }),
      postPrompt(url, { prompt: 'second' }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((await r1.json()).stopReason).toBe('end_turn');
    expect((await r2.json()).stopReason).toBe('end_turn');
  });

  it('returns 503 queue_timeout when the slot is not free within queueWaitMs', async () => {
    // Daemon takes 200ms; queue-wait is only 30ms — second prompt times out.
    stub = await startStubDaemon({ promptStatus: 200, promptDelayMs: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const queue = new PromptQueue();
    const url = await mount(daemon, audit, { queueWaitMs: 30, queue });

    // Fire both concurrently.  The first acquires the slot; the second waits.
    const p1 = postPrompt(url, { prompt: 'slow' });
    // Small delay so p1 definitely acquires the slot first.
    await new Promise((r) => setTimeout(r, 5));
    const p2 = postPrompt(url, { prompt: 'queued' });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200); // first prompt completes normally
    expect(r2.status).toBe(503); // second times out waiting for the slot
    expect((await r2.json()).code).toBe('queue_timeout');
  });

  it('first prompt continues executing after the queued prompt times out', async () => {
    // The in-flight prompt must not be interrupted when a queued one times out.
    stub = await startStubDaemon({
      promptStatus: 200,
      promptDelayMs: 150,
      promptStopReason: 'end_turn',
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const queue = new PromptQueue();
    const url = await mount(daemon, audit, { queueWaitMs: 30, queue });

    const p1 = postPrompt(url, { prompt: 'in-flight' });
    await new Promise((r) => setTimeout(r, 5));
    const p2 = postPrompt(url, { prompt: 'queued-timeout' });

    const r2 = await p2; // queue timeout resolves quickly
    expect(r2.status).toBe(503);

    const r1 = await p1; // in-flight prompt still completes
    expect(r1.status).toBe(200);
    expect((await r1.json()).stopReason).toBe('end_turn');
  });

  // ── Prompt-execution timeout (Task 2.4) ──────────────────────────────────

  it('returns 504 prompt_timeout and emits stream_error when daemon is too slow', async () => {
    // Daemon takes 300ms; prompt-execution budget is only 50ms.
    stub = await startStubDaemon({ promptStatus: 200, promptDelayMs: 300 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const broadcaster = new PromptEventBroadcaster();

    const emitted: Array<{ type: string; data: unknown }> = [];
    broadcaster.register('sess-1', (ev) => emitted.push(ev));

    const queue = new PromptQueue();
    const url = await mount(daemon, audit, {
      promptTimeoutMs: 50,
      promptEventBroadcaster: broadcaster,
      queue,
    });

    const res = await postPrompt(url, { prompt: 'slow-turn' });
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.code).toBe('prompt_timeout');

    // The broadcaster must have received a stream_error event.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('stream_error');
    expect((emitted[0]!.data as { code: string }).code).toBe('prompt_timeout');
  });

  it('queue slot is released after a prompt timeout (next prompt can proceed)', async () => {
    // First prompt times out (budget=50ms, daemon=200ms).
    // After timeout, queue slot is released and a third (fast) prompt should succeed.
    stub = await startStubDaemon({ promptStatus: 200, promptDelayMs: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const queue = new PromptQueue();
    const url = await mount(daemon, audit, {
      promptTimeoutMs: 50,
      queueWaitMs: 500,
      queue,
    });

    // First prompt — will time out during execution.
    const r1 = await postPrompt(url, { prompt: 'slow' });
    expect(r1.status).toBe(504);

    // Now create a new stub that responds fast and point daemon to it.
    // Actually, we need to swap the stub — instead we just wait for the slot
    // to be free and confirm a second prompt against the same slow daemon
    // would also be served (it will timeout again, but the important thing
    // is that the queue isn't deadlocked).
    const r2 = await postPrompt(url, { prompt: 'second-slow' });
    // Second prompt also times out (daemon still slow), but it WAS processed —
    // the queue was not deadlocked.
    expect(r2.status).toBe(504);
  });

  // ── Client disconnect vs. timeout (issue #38) ────────────────────────────

  it('does NOT cancel the daemon prompt when the client disconnects mid-turn (#38)', async () => {
    // Mobile clients get backgrounded routinely (screen off, app switch) and
    // the OS kills their sockets. The daemon turn must keep running: its
    // events land in the per-session bus ring and the client resumes +
    // watches from the watermark when it returns.
    stub = await startStubDaemon({ promptStatus: 200, promptDelayMs: 200 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    // Default promptTimeoutMs (600s) — the execution timeout must NOT be the
    // thing that decides this test.
    const queue = new PromptQueue();
    const url = await mount(daemon, audit, { queue });

    const ac = new AbortController();
    const p = fetch(`${url}/session/sess-1/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'backgrounded' }),
      signal: ac.signal,
    });
    p.catch(() => {}); // swallow the abort rejection; asserted below.

    // Simulate the mobile app being backgrounded ~50ms in.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    // The gateway must keep awaiting the daemon's turn even though the HTTP
    // client is gone. The stub only logs a prompt call when its own socket
    // stays open to completion — so a completed entry proves the gateway did
    // NOT propagate the client disconnect into the daemon prompt.
    const deadline = Date.now() + 2000;
    while (stub.promptCallLog.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(stub.promptCallLog).toHaveLength(1);
    const call = stub.promptCallLog[0]!;
    // The turn ran to completion (>= the 200ms stub delay), not cut short.
    expect(call.endedAt - call.startedAt).toBeGreaterThanOrEqual(195);

    // The audit record is written even though the HTTP client is gone.
    const entry = audit.calls.find((c) => c.action === 'prompt_sent');
    expect(entry).toBeDefined();
    expect(entry!.target).toBe('sess-1');
    expect(entry!.detail).toMatchObject({ stopReason: 'end_turn' });

    // The client's own fetch rejected on abort — expected, and must not have
    // turned into a 500 on the gateway side.
    await expect(p).rejects.toThrow();
  });

  it('prompt timeout DOES cancel the daemon prompt (the only remaining abort, #38)', async () => {
    // Daemon takes 300ms; the execution budget is 50ms. The gateway must
    // abort the daemon turn on timeout — the stub observes the socket close
    // and never logs a completed call.
    stub = await startStubDaemon({ promptStatus: 200, promptDelayMs: 300 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const queue = new PromptQueue();
    const url = await mount(daemon, audit, { promptTimeoutMs: 50, queue });

    const res = await postPrompt(url, { prompt: 'too-slow' });
    expect(res.status).toBe(504);

    // Give the stub a moment to observe the socket close.
    await new Promise((r) => setTimeout(r, 50));
    // The daemon turn was cancelled — the stub never completed it.
    expect(stub.promptCallLog).toHaveLength(0);
    // No audit record for a turn that never finished.
    expect(audit.calls.find((c) => c.action === 'prompt_sent')).toBeUndefined();
  });
});
