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
import { createSessionCancelRoute } from './sessionCancel.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function mountGateway(
  daemon: DaemonClient,
  audit?: AuditRecorder,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { rcClient?: unknown }).rcClient = {
      id: 'tkn-owner',
      scopes: ['write', 'session:read'],
    };
    next();
  });
  app.post('/session/:id/cancel', createSessionCancelRoute(daemon, audit));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function waitForAudit(
  audit: ReturnType<typeof fakeAudit>,
  action: string,
): Promise<AuditEntry | undefined> {
  const deadline = Date.now() + 2000;
  while (
    !audit.calls.some((c) => c.action === action) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return audit.calls.find((c) => c.action === action);
}

describe('POST /session/:id/cancel', () => {
  it('returns 200 and audits session_cancelled on success', async () => {
    stub = await startStubDaemon({});
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mountGateway(daemon, audit);

    const res = await fetch(`${url}/session/sess-1/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: 'sess-1', cancelled: true });

    const row = await waitForAudit(audit, 'session_cancelled');
    expect(row).toBeDefined();
    expect(row!.actorTokenId).toBe('tkn-owner');
    expect(row!.target).toBe('sess-1');
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ cancelSessionStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/sess-1/cancel`, { method: 'POST' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('daemon_unavailable');
  });

  it('does not audit when the daemon errors', async () => {
    stub = await startStubDaemon({ cancelSessionStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mountGateway(daemon, audit);

    await fetch(`${url}/session/sess-1/cancel`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 50));
    expect(audit.calls.some((c) => c.action === 'session_cancelled')).toBe(
      false,
    );
  });

  it('forwards the session id from the route param', async () => {
    stub = await startStubDaemon({});
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/my-session-42/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(stub.lastCancelledSessionId).toBe('my-session-42');
  });

  it('is idempotent — a repeated cancel still succeeds', async () => {
    // A mobile stop button is easy to double-tap, and the daemon answers 204
    // whether or not a turn was actually running.
    stub = await startStubDaemon({});
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${url}/session/sess-1/cancel`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
    }
  });

  it('does not end the session — cancel and end are distinct', async () => {
    stub = await startStubDaemon({});
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    await fetch(`${url}/session/sess-1/cancel`, { method: 'POST' });

    expect(stub.lastCancelledSessionId).toBe('sess-1');
    expect(stub.lastEndedSessionId).toBeUndefined();
  });
});
