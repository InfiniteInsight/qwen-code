/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { DaemonClient } from '@qwen-code/sdk';
import {
  DaemonHttpError,
  type DaemonSubagentAbandonResult,
} from '@qwen-code/sdk/daemon';
import { createSubagentAbandonRoute } from './subagentAbandon.js';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { createGatewayApp } from '../server.js';
import { BRIDGE, OWNER, SESSION_READ, WRITE } from '../scopes.js';

const SESS = '11111111111111111111111111111111';
const REF = 'toolu_01AbCdEf';

interface Captured {
  status?: number;
  body?: Record<string, unknown>;
}

function fakeRes(): { res: Response; captured: Captured } {
  const captured: Captured = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, captured };
}

function recorder() {
  const entries: Array<Record<string, unknown>> = [];
  const audit = {
    record: async (e: Record<string, unknown>) => {
      entries.push(e);
    },
  } as unknown as AuditRecorder;
  return { audit, entries };
}

function fakeDaemon(
  behaviour: {
    result?: DaemonSubagentAbandonResult;
    thrown?: unknown;
  } = {},
) {
  const calls: Array<{ sessionId: string; subagentRef: string }> = [];
  const daemon = {
    abandonSubagentSession: async (sessionId: string, subagentRef: string) => {
      calls.push({ sessionId, subagentRef });
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return (
        behaviour.result ?? {
          sessionId,
          subagentRef,
          taskId: 'agent-1',
          outcome: 'abandoned',
          status: 'cancelled',
        }
      );
    },
  } as unknown as SessionDaemon;
  return { daemon, calls };
}

async function call(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  params = { id: SESS, subagentRef: REF },
): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = { params, rcClient: { id: 'tok_test' } } as unknown as Request;
  await createSubagentAbandonRoute(daemon, audit)(req, res, () => {});
  return captured;
}

let gateway: Server | undefined;
let stub: StubDaemon | undefined;
let tmp: string | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  gateway = undefined;
  stub = undefined;
  tmp = undefined;
});

describe('POST /session/:id/subagents/:subagentRef/abandon (#267)', () => {
  it('abandons and audits subagent_abandoned when outcome is abandoned', async () => {
    const { daemon, calls } = fakeDaemon();
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      subagentRef: REF,
      taskId: 'agent-1',
      outcome: 'abandoned',
      status: 'cancelled',
    });
    expect(calls).toEqual([{ sessionId: SESS, subagentRef: REF }]);
    expect(entries[0]).toMatchObject({
      action: 'subagent_abandoned',
      actorTokenId: 'tok_test',
      target: SESS + ':' + REF,
    });
  });

  it('forwards refused outcome with code and reason and audits subagent_abandon_failed', async () => {
    const { daemon } = fakeDaemon({
      result: {
        sessionId: SESS,
        subagentRef: REF,
        taskId: 'agent-1',
        outcome: 'refused',
        code: 'not_paused',
        reason: 'Background agent "agent-1" is running, not paused.',
        status: 'running',
      },
    });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      subagentRef: REF,
      taskId: 'agent-1',
      outcome: 'refused',
      code: 'not_paused',
      reason: 'Background agent "agent-1" is running, not paused.',
      status: 'running',
    });
    expect(entries[0]).toMatchObject({
      action: 'subagent_abandon_failed',
      detail: {
        code: 'not_paused',
        reason: 'Background agent "agent-1" is running, not paused.',
      },
    });
  });

  it('maps 404, 409, 501, and 502 daemon errors accurately', async () => {
    const r404 = await call(
      fakeDaemon({
        thrown: new DaemonHttpError(
          404,
          { code: 'session_not_found', sessionId: SESS, subagentRef: REF },
          'Subagent session not found',
        ),
      }).daemon,
    );
    expect(r404.status).toBe(404);
    expect(r404.body?.code).toBe('not_found');

    const r409 = await call(
      fakeDaemon({
        thrown: new DaemonHttpError(
          409,
          { code: 'conflict', error: 'Conflict' },
          'Conflict',
        ),
      }).daemon,
    );
    expect(r409.status).toBe(409);
    expect(r409.body?.code).toBe('conflict');

    const r501 = await call(
      fakeDaemon({
        thrown: new DaemonHttpError(404, {}, 'Cannot POST'),
      }).daemon,
    );
    expect(r501.status).toBe(501);
    expect(r501.body?.code).toBe('unsupported');

    const r502 = await call(
      fakeDaemon({ thrown: new Error('boom') }).daemon,
    );
    expect(r502.status).toBe(502);
    expect(r502.body?.code).toBe('daemon_unavailable');
  });

  it('enforces WRITE scope and subActorBan at gateway mount without rate-limiting abandon', async () => {
    stub = await startStubDaemon();
    tmp = mkdtempSync(join(tmpdir(), 'rc-subagent-abandon-'));
    const store = await TokenStore.open(join(tmp, 'tokens.json'));
    const { app } = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(tmp, 'audit.log'),
      subActorCap: 1,
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    gateway = server;
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const reader = await store.issue([SESSION_READ], 'reader');
    const readerRes = await fetch(
      `${base}/session/${SESS}/subagents/${REF}/abandon`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${reader.token}` },
      },
    );
    expect(readerRes.status).toBe(403);

    const owner = await store.issue([OWNER], 'owner');
    const bridge = await store.issue(
      [BRIDGE, SESSION_READ, WRITE],
      'tg-bridge',
    );
    await fetch(`${base}/rc/bridges/tg/ban`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subActor: 'telegram:banned' }),
    });

    const bannedRes = await fetch(
      `${base}/session/${SESS}/subagents/${REF}/abandon`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          'X-RC-SubActor': 'telegram:banned',
        },
      },
    );
    expect(bannedRes.status).toBe(403);

    for (let i = 0; i < 3; i++) {
      const okRes = await fetch(
        `${base}/session/${SESS}/subagents/${REF}/abandon`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bridge.token}`,
            'X-RC-SubActor': 'telegram:alice',
          },
        },
      );
      expect(okRes.status).toBe(200);
    }
    expect(stub.subagentAbandons).toHaveLength(3);
  });
});
