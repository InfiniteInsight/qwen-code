/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { createPromptRoute } from './prompt.js';

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

/**
 * A daemon that emits `frames` frames, waiting `gapMs` before each, then ends
 * the turn.
 *
 * Deliberately not `startStubDaemon`: over a real socket the gap between two
 * frames is whatever the scheduler and the loopback stack allow, so an
 * assertion on the recorded value would be a load assertion. These tests pin
 * what the route records and where; the size of a gap is the meter's own
 * business, covered with a hand-driven clock in turnProgress.test.ts.
 */
function daemonEmitting(frames: number, gapMs = 5): SessionDaemon {
  return {
    async prompt(
      _sessionId: string,
      _req: unknown,
      _signal: AbortSignal | undefined,
      _clientId: string | undefined,
      onTurnFrame?: (frameType: string) => void,
    ) {
      for (let i = 0; i < frames; i += 1) {
        await new Promise((r) => setTimeout(r, gapMs));
        onTurnFrame?.('session_update');
      }
      return { stopReason: 'end_turn' };
    },
  } as unknown as SessionDaemon;
}

async function mount(
  daemon: SessionDaemon,
  audit: AuditRecorder,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = { id: 'tok1', scopes: ['write'] };
    next();
  });
  app.post('/session/:id/prompt', createPromptRoute(daemon, audit));
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postPrompt(url: string, prompt: string): Promise<Response> {
  return fetch(`${url}/session/sess-1/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
}

async function completedTurnDetail(
  daemon: SessionDaemon,
): Promise<Record<string, unknown>> {
  const audit = fakeAudit();
  const url = await mount(daemon, audit);
  const res = await postPrompt(url, 'hello');
  expect(res.status).toBe(200);
  const entry = audit.calls.find((c) => c.action === 'prompt_sent');
  expect(entry).toBeDefined();
  return entry!.detail as Record<string, unknown>;
}

describe('prompt route turn progress', () => {
  it('records how quiet a completed turn was on the row it already writes', async () => {
    const detail = await completedTurnDetail(daemonEmitting(3));
    expect(detail.stopReason).toBe('end_turn');
    expect(detail.frames).toBe(3);
    expect(typeof detail.maxGapMs).toBe('number');
    expect(detail.maxGapMs).toBeGreaterThan(0);
  });

  it('records neither number for a turn that produced no frame at all', async () => {
    // The 200 path. Absence has to survive to the audit row: a `maxGapMs` of
    // zero here is indistinguishable from a measured "never went quiet", and
    // the two mean opposite things to whoever picks a window from these rows.
    const detail = await completedTurnDetail(daemonEmitting(0));
    expect(detail.stopReason).toBe('end_turn');
    expect(detail).not.toHaveProperty('frames');
    expect(detail).not.toHaveProperty('maxGapMs');
  });

  it('carries no frame content in either number', async () => {
    // The observer signature allows only a frame type through, and the audit
    // row takes only the two numbers. Asserted on the serialized row because a
    // measurement that leaks content is exactly how a new audit field becomes a
    // prompt-content field by accident.
    const audit = fakeAudit();
    const url = await mount(daemonEmitting(2), audit);
    await postPrompt(url, 'a secret prompt');
    const entry = audit.calls.find((c) => c.action === 'prompt_sent');
    expect(JSON.stringify(entry)).not.toContain('secret');
  });

  it('still writes the row, and still answers, when nothing is passed to observe', async () => {
    // The route always passes an observer, so this pins the other half of the
    // additivity claim: a turn whose wait reports nothing is unaffected. The
    // SDK-side test covers a caller that opts out entirely.
    const daemon = {
      async prompt(): Promise<{ stopReason: string }> {
        return { stopReason: 'end_turn' };
      },
    } as unknown as SessionDaemon;
    const detail = await completedTurnDetail(daemon);
    expect(detail).toEqual({ stopReason: 'end_turn', blocks: 1 });
  });
});
