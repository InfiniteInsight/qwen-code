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
import { createSessionStatusRoute } from './sessionStatus.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

async function mountGateway(daemon: DaemonClient): Promise<string> {
  const app = express();
  app.get('/session/:id/status', createSessionStatusRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';

describe('GET /session/:id/status', () => {
  it('relays the daemon session status, pendingInteractions verbatim', async () => {
    stub = await startStubDaemon({
      workspaceCwd: '/proj',
      sessionStatus: {
        sessionId: SID,
        workspaceCwd: '/proj',
        clientCount: 1,
        hasActivePrompt: true,
        isWaitingForUserQuestion: true,
        pendingInteractionCount: 1,
        pendingInteractions: [
          {
            requestId: 'req-1',
            kind: 'user_question',
            createdAt: '2026-09-22T00:00:00.000Z',
            title: 'Pick a plan',
            questions: [
              {
                answerKey: '0',
                header: 'Plan',
                question: 'Which plan?',
                options: [{ label: 'A' }, { label: 'B' }],
                multiSelect: false,
              },
            ],
            options: [
              { optionId: 'allow_once', label: 'Submit', kind: 'allow_once' },
              { optionId: 'cancelled', label: 'Cancel', kind: 'cancelled' },
            ],
          },
        ],
      },
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sessionId).toBe(SID);
    expect(body.hasActivePrompt).toBe(true);
    // The UI's card-recovery path depends on this array arriving untouched.
    expect(body.pendingInteractions).toEqual([
      {
        requestId: 'req-1',
        kind: 'user_question',
        createdAt: '2026-09-22T00:00:00.000Z',
        title: 'Pick a plan',
        questions: [
          {
            answerKey: '0',
            header: 'Plan',
            question: 'Which plan?',
            options: [{ label: 'A' }, { label: 'B' }],
            multiSelect: false,
          },
        ],
        options: [
          { optionId: 'allow_once', label: 'Submit', kind: 'allow_once' },
          { optionId: 'cancelled', label: 'Cancel', kind: 'cancelled' },
        ],
      },
    ]);
  });

  it('404s a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/zzz-not-a-valid-id/status`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
  });

  it('maps a daemon 404 to 404 session_not_found', async () => {
    stub = await startStubDaemon({ sessionStatusCode: 404 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/status`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ sessionStatusCode: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/status`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('daemon_unavailable');
  });
});
