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
import { createSessionTranscriptRoute } from './sessionTranscript.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/**
 * The relay path runs a real `DaemonClient` against the stub, so the query
 * string the daemon receives is built by the SDK's own
 * `transcriptPageSuffix` rather than by the test. That is the difference
 * between proving the parameters arrive and proving only that this file passes
 * them to something.
 */
async function mountGateway(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.get('/session/:id/transcript', createSessionTranscriptRoute(daemon));
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
    getSessionTranscriptPage: async () => {
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return (
        behaviour.result ?? {
          v: 1,
          sessionId: SID,
          events: [
            { id: 1, v: 1, type: 'user_message', data: { text: 'one' } },
            { id: 2, v: 1, type: 'user_message', data: { text: 'two' } },
            { id: 3, v: 1, type: 'user_message', data: { text: 'three' } },
          ],
          nextCursor: 'c3',
          hasMore: true,
        }
      );
    },
  } as unknown as SessionDaemon;
}

async function callRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  params: Record<string, string> = { id: SID },
  query: Record<string, string> = {},
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
    query,
    rcClient: { id: 'tok_test' },
  } as unknown as express.Request;
  await createSessionTranscriptRoute(daemon, audit)(req, res, () => {});
  return { status: res.code, body: res.body };
}

describe('GET /session/:id/transcript', () => {
  it('relays the page the daemon served', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/transcript`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The paging envelope arrives intact: the cursor the caller needs for the
    // next request is the daemon's, not one the gateway invented.
    expect(body.v).toBe(1);
    expect(body.sessionId).toBe(SID);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe('eyJyZWNvcmRJZCI6IjIifQ');
    expect((body.events as unknown[]).length).toBe(2);
  });

  it('carries the paging parameters the caller sent through to the daemon', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(
      `${url}/session/${SID}/transcript` +
        '?direction=backward&beforeRecordId=rec-9&limit=7',
    );
    expect(res.status).toBe(200);
    // What the daemon was actually asked for. An absent parameter here means
    // the gateway dropped it and the caller silently got the default page.
    expect(stub.lastTranscriptQuery).toMatchObject({
      direction: 'backward',
      beforeRecordId: 'rec-9',
      limit: '7',
    });
  });

  it('sends only the parameters the caller sent', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/transcript?cursor=c2`);
    expect(res.status).toBe(200);
    const query = stub.lastTranscriptQuery ?? {};
    expect(query['cursor']).toBe('c2');
    // A pinned cursor and a record boundary are mutually exclusive at the
    // daemon, so filling in an untouched key here would make a valid request
    // an invalid one.
    expect(query['beforeRecordId']).toBeUndefined();
    expect(query['atRecordId']).toBeUndefined();
    expect(query['direction']).toBeUndefined();
  });

  it('keeps a bad paging combination a 400 instead of laundering it', async () => {
    stub = await startStubDaemon({
      workspaceCwd: '/proj',
      transcriptStatusCode: 400,
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(
      `${url}/session/${SID}/transcript?atRecordId=rec-1`,
    );
    // The daemon refused the anchor combination. Telling the caller the
    // gateway is broken sends them to retry a request that can never work.
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('invalid_transcript_query');
  });

  it('rejects a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/not-an-id/transcript`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('session_not_found');
    expect(stub.lastTranscriptQuery).toBeUndefined();
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
      error: 'Open this conversation before reading its transcript',
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

  it('audits the read with counts, never the records', async () => {
    const { audit, entries } = recorder();
    const out = await callRoute(fakeDaemon(), audit);
    expect(out.status).toBe(200);
    expect(entries[0]).toMatchObject({
      action: 'session_transcript_read',
      actorTokenId: 'tok_test',
      target: SID,
      detail: { records: 3, hasMore: true },
    });
    // The page is the conversation. The record must not carry any of it.
    const detail = entries[0]?.detail as Record<string, unknown>;
    expect(detail.events).toBeUndefined();
    expect(JSON.stringify(entries[0])).not.toContain('one');
  });
});
