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
  type DaemonSubagentPauseResult,
} from '@qwen-code/sdk/daemon';
import { createSubagentPauseRoute } from './subagentPause.js';
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
    result?: DaemonSubagentPauseResult;
    thrown?: unknown;
  } = {},
) {
  const calls: Array<{ sessionId: string; subagentRef: string }> = [];
  const daemon = {
    pauseSubagentSession: async (sessionId: string, subagentRef: string) => {
      calls.push({ sessionId, subagentRef });
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return (
        behaviour.result ?? {
          sessionId,
          subagentRef,
          taskId: 'agent-1',
          outcome: 'paused',
          status: 'paused',
          agentId: 'agent-1',
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
  await createSubagentPauseRoute(daemon, audit)(req, res, () => {});
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

describe('POST /session/:id/subagents/:subagentRef/pause (#267)', () => {
  it('pauses and audits subagent_paused when outcome is paused', async () => {
    const { daemon, calls } = fakeDaemon();
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      subagentRef: REF,
      taskId: 'agent-1',
      outcome: 'paused',
      status: 'paused',
      agentId: 'agent-1',
    });
    expect(calls).toEqual([{ sessionId: SESS, subagentRef: REF }]);
    expect(entries[0]).toMatchObject({
      action: 'subagent_paused',
      actorTokenId: 'tok_test',
      target: SESS + ':' + REF,
    });
  });

  it('forwards refused outcome with code and reason and audits subagent_pause_failed', async () => {
    const { daemon } = fakeDaemon({
      result: {
        sessionId: SESS,
        subagentRef: REF,
        taskId: 'agent-1',
        outcome: 'refused',
        code: 'pause_blocked',
        reason:
          'Background task worktree isolation cannot be reconstructed after session restore.',
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
      code: 'pause_blocked',
      reason:
        'Background task worktree isolation cannot be reconstructed after session restore.',
      status: 'running',
    });
    expect(entries[0]).toMatchObject({
      action: 'subagent_pause_failed',
      actorTokenId: 'tok_test',
      target: SESS + ':' + REF,
      detail: {
        code: 'pause_blocked',
        reason:
          'Background task worktree isolation cannot be reconstructed after session restore.',
      },
    });
  });

  it('maps 404 daemon session_not_found to 404 not_found', async () => {
    const { daemon } = fakeDaemon({
      thrown: new DaemonHttpError(
        404,
        { code: 'session_not_found', sessionId: SESS, subagentRef: REF },
        'Subagent session not found',
      ),
    });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(404);
    expect(out.body).toEqual({
      error: 'session or subagent not found',
      code: 'not_found',
    });
    expect(entries[0]).toMatchObject({
      action: 'subagent_pause_failed',
      detail: { code: 'not_found' },
    });
  });

  it('maps 409 daemon error to 409 with code', async () => {
    const { daemon } = fakeDaemon({
      thrown: new DaemonHttpError(
        409,
        { code: 'session_busy', error: 'Session is busy' },
        'Session is busy',
      ),
    });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: 'Session is busy',
      code: 'session_busy',
    });
    expect(entries[0]).toMatchObject({
      action: 'subagent_pause_failed',
      detail: { code: 'session_busy' },
    });
  });

  it('maps bare 404 (older daemon missing route) and 501 to 501 unsupported', async () => {
    for (const thrown of [
      new DaemonHttpError(404, {}, 'Cannot POST'),
      new DaemonHttpError(501, { code: 'not_implemented' }, 'Not implemented'),
    ]) {
      const { daemon } = fakeDaemon({ thrown });
      const { audit, entries } = recorder();
      const out = await call(daemon, audit);
      expect(out.status).toBe(501);
      expect(out.body).toEqual({
        error: 'daemon does not support subagent lifecycle controls',
        code: 'unsupported',
      });
      expect(entries[0]).toMatchObject({
        action: 'subagent_pause_failed',
        detail: { code: 'unsupported' },
      });
    }
  });

  it('maps other daemon failures to 502 daemon_unavailable without echoing host paths', async () => {
    const { daemon } = fakeDaemon({
      thrown: new Error('ECONNREFUSED /home/secret/path'),
    });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(502);
    expect(out.body).toEqual({
      error: 'daemon subagent pause failed',
      code: 'daemon_unavailable',
    });
    expect(JSON.stringify(out.body) + JSON.stringify(entries)).not.toContain(
      '/home/secret',
    );
  });

  it('enforces WRITE scope and subActorBan at gateway mount without rate-limiting pause', async () => {
    stub = await startStubDaemon();
    tmp = mkdtempSync(join(tmpdir(), 'rc-subagent-pause-'));
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
      `${base}/session/${SESS}/subagents/${REF}/pause`,
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
      `${base}/session/${SESS}/subagents/${REF}/pause`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          'X-RC-SubActor': 'telegram:banned',
        },
      },
    );
    expect(bannedRes.status).toBe(403);

    // Pause is a stop-work control and is not throttled by subActorCap: 1.
    for (let i = 0; i < 3; i++) {
      const okRes = await fetch(
        `${base}/session/${SESS}/subagents/${REF}/pause`,
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
    expect(stub.subagentPauses).toHaveLength(3);
  });
});
