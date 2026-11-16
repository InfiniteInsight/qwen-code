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
  type DaemonSubagentResumeResult,
} from '@qwen-code/sdk/daemon';
import { createSubagentResumeRoute } from './subagentResume.js';
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
    result?: DaemonSubagentResumeResult;
    thrown?: unknown;
  } = {},
) {
  const calls: Array<{
    sessionId: string;
    subagentRef: string;
    message?: string;
  }> = [];
  const daemon = {
    resumeSubagentSession: async (
      sessionId: string,
      subagentRef: string,
      message?: string,
    ) => {
      calls.push({ sessionId, subagentRef, message });
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return (
        behaviour.result ?? {
          sessionId,
          subagentRef,
          taskId: 'agent-1',
          outcome: 'resumed',
          status: 'running',
        }
      );
    },
  } as unknown as SessionDaemon;
  return { daemon, calls };
}

async function call(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  body: unknown = {},
  params = { id: SESS, subagentRef: REF },
): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = {
    params,
    body,
    rcClient: { id: 'tok_test' },
  } as unknown as Request;
  await createSubagentResumeRoute(daemon, audit)(req, res, () => {});
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

describe('POST /session/:id/subagents/:subagentRef/resume (#267)', () => {
  it('resumes without a message and audits subagent_resumed', async () => {
    const { daemon, calls } = fakeDaemon();
    const { audit, entries } = recorder();
    const out = await call(daemon, audit, {});
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      subagentRef: REF,
      taskId: 'agent-1',
      outcome: 'resumed',
      status: 'running',
    });
    expect(calls).toEqual([
      { sessionId: SESS, subagentRef: REF, message: undefined },
    ]);
    expect(entries[0]).toMatchObject({
      action: 'subagent_resumed',
      actorTokenId: 'tok_test',
      target: SESS + ':' + REF,
    });
  });

  it('resumes with a trimmed message without recording message text in audit', async () => {
    const { daemon, calls } = fakeDaemon();
    const { audit, entries } = recorder();
    const out = await call(daemon, audit, {
      message: '  focus on auth tests  ',
    });
    expect(out.status).toBe(200);
    expect(calls).toEqual([
      {
        sessionId: SESS,
        subagentRef: REF,
        message: 'focus on auth tests',
      },
    ]);
    expect(entries[0]).toMatchObject({
      action: 'subagent_resumed',
      actorTokenId: 'tok_test',
      target: SESS + ':' + REF,
    });
    expect(JSON.stringify(entries)).not.toContain('focus on auth tests');
  });

  it('forwards refused outcome with code and reason and audits subagent_resume_failed', async () => {
    const { daemon } = fakeDaemon({
      result: {
        sessionId: SESS,
        subagentRef: REF,
        taskId: 'agent-1',
        outcome: 'refused',
        code: 'capacity_full',
        reason: 'Background agent concurrency cap (4) is full.',
        status: 'paused',
      },
    });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit, {});
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      subagentRef: REF,
      taskId: 'agent-1',
      outcome: 'refused',
      code: 'capacity_full',
      reason: 'Background agent concurrency cap (4) is full.',
      status: 'paused',
    });
    expect(entries[0]).toMatchObject({
      action: 'subagent_resume_failed',
      detail: {
        code: 'capacity_full',
        reason: 'Background agent concurrency cap (4) is full.',
      },
    });
  });

  it('rejects non-string message with 400 invalid_message', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, undefined, { message: 42 });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      error: 'message must be a string when present',
      code: 'invalid_message',
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects message exceeding 64 KiB with 413 message_too_large', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, undefined, {
      message: 'x'.repeat(65_537),
    });
    expect(out.status).toBe(413);
    expect(out.body).toEqual({
      error: 'message too large',
      code: 'message_too_large',
    });
    expect(calls).toHaveLength(0);
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

  it('enforces WRITE scope, subActorBan, and subActorRateLimit on bridge fan-in users', async () => {
    stub = await startStubDaemon();
    tmp = mkdtempSync(join(tmpdir(), 'rc-subagent-resume-'));
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
      `${base}/session/${SESS}/subagents/${REF}/resume`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${reader.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
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
      `${base}/session/${SESS}/subagents/${REF}/resume`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          'X-RC-SubActor': 'telegram:banned',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );
    expect(bannedRes.status).toBe(403);

    const first = await fetch(
      `${base}/session/${SESS}/subagents/${REF}/resume`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          'X-RC-SubActor': 'telegram:alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'continue' }),
      },
    );
    expect(first.status).toBe(200);

    const second = await fetch(
      `${base}/session/${SESS}/subagents/${REF}/resume`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          'X-RC-SubActor': 'telegram:alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'again' }),
      },
    );
    expect(second.status).toBe(429);
    expect(stub.subagentResumes).toHaveLength(1);
  });
});
