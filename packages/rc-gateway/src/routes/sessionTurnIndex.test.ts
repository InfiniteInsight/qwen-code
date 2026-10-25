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
import { createSessionTurnIndexRoute } from './sessionTurnIndex.js';

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
 * string the daemon receives is built by the SDK's own `turnIndexPageSuffix`
 * rather than by the test. That is the difference between proving the
 * parameters arrive and proving only that this file passes them to something.
 */
async function mountGateway(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.get('/session/:id/turn-index', createSessionTurnIndexRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';
// Text the daemon derives from the conversation. It must never reach the audit
// record, so it has to be something a passing assertion can search for.
const SECRET_LABEL = 'rebuild the widget factory';

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
    getSessionTurnIndexPage: async () => {
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return (
        behaviour.result ?? {
          v: 1,
          sessionId: SID,
          snapshot: 'sn-9',
          totalTurns: 3,
          start: 0,
          turns: [
            { ordinal: 0, turnId: 'turn-1', kind: 'prompt', label: 'one' },
            {
              ordinal: 1,
              turnId: 'turn-2',
              kind: 'prompt',
              label: SECRET_LABEL,
            },
            {
              ordinal: 2,
              turnId: 'turn-3',
              kind: 'scheduled',
              label: 'three',
            },
          ],
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
  await createSessionTurnIndexRoute(daemon, audit)(req, res, () => {});
  return { status: res.code, body: res.body };
}

describe('GET /session/:id/turn-index', () => {
  it('relays the index page the daemon served', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/turn-index`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The index envelope arrives intact, including the snapshot the caller
    // needs to ask for the NEXT window. A gateway that re-stamped it would hand
    // back a snapshot the daemon refuses to honour.
    expect(body.v).toBe(1);
    expect(body.sessionId).toBe(SID);
    expect(body.snapshot).toBe('sn-1');
    expect(body.totalTurns).toBe(2);
    expect(body.start).toBe(0);
    expect((body.turns as unknown[]).length).toBe(2);
  });

  it('carries the paging parameters the caller sent through to the daemon', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(
      `${url}/session/${SID}/turn-index?snapshot=sn-4&start=20&limit=5`,
    );
    expect(res.status).toBe(200);
    // What the daemon was actually asked for. An absent parameter here means
    // the gateway dropped it and the caller silently got the default window.
    expect(stub.lastTurnIndexQuery).toMatchObject({
      snapshot: 'sn-4',
      start: '20',
      limit: '5',
    });
  });

  it('sends only the parameters the caller sent', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/turn-index?limit=3`);
    expect(res.status).toBe(200);
    const query = stub.lastTurnIndexQuery ?? {};
    expect(query['limit']).toBe('3');
    // `start` is an offset INTO a snapshot and the daemon refuses it alone, so
    // filling in an untouched key here would turn a valid request into one the
    // daemon rejects.
    expect(query['start']).toBeUndefined();
    expect(query['snapshot']).toBeUndefined();
  });

  it('keeps a bad paging combination a 400 instead of laundering it', async () => {
    stub = await startStubDaemon({
      workspaceCwd: '/proj',
      turnIndexStatusCode: 400,
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/${SID}/turn-index?start=20`);
    // The daemon refused a bare offset. Telling the caller the gateway is
    // broken sends them to retry a request that can never work.
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('invalid_turn_index_query');
  });

  it('rejects a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session/not-an-id/turn-index`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('session_not_found');
    expect(stub.lastTurnIndexQuery).toBeUndefined();
  });

  it('says session_not_loaded when the pool no longer holds the session', async () => {
    // The pool drops its session-to-daemon map when a session dies, while the
    // turns stay on disk and the daemon would still index them. Claiming 404
    // here would tell the operator to stop looking.
    const out = await callRoute(
      fakeDaemon({ thrown: new UnknownSessionError(SID) }),
    );
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: 'Open this conversation before reading its turn index',
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

  it('audits the read with counts, never the turn labels', async () => {
    const { audit, entries } = recorder();
    const out = await callRoute(fakeDaemon(), audit);
    expect(out.status).toBe(200);
    expect(entries[0]).toMatchObject({
      action: 'session_turn_index_read',
      actorTokenId: 'tok_test',
      target: SID,
      detail: { turns: 3, totalTurns: 3 },
    });
    // The labels are text the daemon derived from the conversation. The record
    // must carry how many turns there were, not what they said.
    const detail = entries[0]?.detail as Record<string, unknown>;
    expect(detail.turns).toBe(3);
    expect(detail.entries).toBeUndefined();
    expect(JSON.stringify(entries[0])).not.toContain(SECRET_LABEL);
  });
});
