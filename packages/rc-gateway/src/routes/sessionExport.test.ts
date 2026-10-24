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
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { createSessionExportRoute } from './sessionExport.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/**
 * The relay path runs a real `DaemonClient` against the stub, so the headers
 * the SDK rebuilds the result from are produced by an actual HTTP exchange.
 * A hand-written daemon object could not prove the file survives that step.
 */
async function mountGateway(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.get('/session/:id/export', createSessionExportRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';

function recorder() {
  const entries: Array<Record<string, unknown>> = [];
  const audit = {
    record: async (e: Record<string, unknown>) => {
      entries.push(e);
    },
  } as unknown as AuditRecorder;
  return { audit, entries };
}

/** A daemon that answers with a chosen outcome, for the verdicts a live
 * client cannot produce (the pool having dropped the session). */
function fakeDaemon(
  behaviour: { result?: unknown; thrown?: unknown } = {},
): SessionDaemon {
  return {
    exportSession: async () => {
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return (
        behaviour.result ?? {
          content: '# one\n',
          filename: 'chat.md',
          mimeType: 'text/markdown; charset=utf-8',
          format: 'md',
        }
      );
    },
  } as unknown as SessionDaemon;
}

async function callRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  params: Record<string, string> = { id: SID },
) {
  const res = {
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  } as unknown as express.Response & { code?: number; body?: unknown };
  const req = {
    params,
    query: {},
    rcClient: { id: 'tok_test' },
  } as unknown as express.Request;
  await createSessionExportRoute(daemon, audit)(req, res, () => {});
  return { status: res.code, body: res.body };
}

describe('GET /session/:id/export', () => {
  it('relays the file the daemon served as bytes', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/export`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // All four fields the page needs to rebuild the download, and the filename
    // is the one the daemon put in Content-Disposition, not a local guess.
    expect(body.filename).toBe(`session-${SID.slice(0, 8)}.html`);
    expect(body.content).toBe(`# session ${SID.slice(0, 8)}\n`);
    expect(String(body.mimeType)).toContain('text/html');
    expect(body.format).toBe('html');
  });

  it('passes the requested format through to the daemon', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/export?format=md`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.format).toBe('md');
    expect(body.filename).toBe(`session-${SID.slice(0, 8)}.md`);
    expect(String(body.mimeType)).toContain('text/markdown');
  });

  it('keeps a bad format a 400 instead of laundering it into a 502', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/export?format=pdf`);
    // The caller asked for something that does not exist. Telling them the
    // gateway is broken sends them to retry a request that can never work.
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('invalid_export_format');
  });

  it('rejects a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/not-an-id/export`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('session_not_found');
  });

  it('says session_not_loaded when the pool no longer holds the session', async () => {
    // The pool drops its session-to-daemon map when a session dies, while the
    // transcript stays on disk and the daemon would still render it. Claiming
    // 404 here would tell the operator to stop looking.
    const out = await callRoute(
      fakeDaemon({ thrown: new UnknownSessionError(SID) }),
    );
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: 'Open this conversation before exporting it',
      code: 'session_not_loaded',
    });
  });

  it('falls through to 502 for a daemon failure that is not a verdict', async () => {
    const out = await callRoute(
      fakeDaemon({ thrown: new DaemonHttpError(500, {}, 'boom') }),
    );
    expect(out.status).toBe(502);
    expect(out.body).toEqual({
      error: 'Daemon unavailable',
      code: 'daemon_unavailable',
    });
  });

  it('audits the export with format and size, never the content', async () => {
    const { audit, entries } = recorder();
    const out = await callRoute(fakeDaemon(), audit);
    expect(out.status).toBe(200);
    expect(entries[0]).toMatchObject({
      action: 'session_exported',
      actorTokenId: 'tok_test',
      target: SID,
      detail: { format: 'md', bytes: 6 },
    });
    // The whole point of the route is moving conversation text; the record
    // must not carry any of it.
    const detail = entries[0]?.detail as Record<string, unknown>;
    expect(detail.content).toBeUndefined();
  });
});
