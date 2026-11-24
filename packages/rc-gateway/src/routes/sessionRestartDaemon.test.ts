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
import {
  CannotRestartAttachedDaemonError,
  DaemonPool,
  UnknownSessionError,
  type SessionDaemon,
} from '../daemonPool.js';
import { RecoveryOrchestrator } from '../recovery/orchestrator.js';
import type { AuditRecorder } from '../auditLog.js';
import { createSessionRestartDaemonRoute } from './sessionRestartDaemon.js';

let gateway: Server | undefined;
const stubs: StubDaemon[] = [];
const pools: DaemonPool[] = [];

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  gateway = undefined;
  while (pools.length > 0) {
    await pools.pop()!.stopAll();
  }
  while (stubs.length > 0) {
    await stubs.pop()!.close();
  }
});

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

async function mountRoute(
  daemon: Pick<SessionDaemon, 'restartSessionDaemon'>,
  audit?: AuditRecorder,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.rcClient = { id: 'tok_owner', scopes: ['owner'] };
    next();
  });
  app.post(
    '/rc/sessions/:id/restart-daemon',
    createSessionRestartDaemonRoute(daemon, audit),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('POST /rc/sessions/:id/restart-daemon', () => {
  it('stops a pooled workspace daemon with SIGTERM/SIGKILL, spawns a fresh daemon, and recovers the session via RecoveryOrchestrator', async () => {
    const defaultStub = await startStubDaemon();
    stubs.push(defaultStub);
    const defaultClient = new DaemonClient({ baseUrl: defaultStub.baseUrl });

    const stopSignals: Array<boolean> = [];
    let spawnCount = 0;

    const pool = new DaemonPool({
      defaultDaemon: defaultClient,
      defaultWorkspaceCwd: '/proj/default',
      spawn: async (cwd) => {
        spawnCount += 1;
        const s = await startStubDaemon({ sessionId: SID });
        stubs.push(s);
        return {
          client: new DaemonClient({ baseUrl: s.baseUrl }),
          stop: async (opts) => {
            stopSignals.push(opts?.force === true);
            await s.close();
          },
          workspaceCwd: cwd,
          endpoint: { url: s.baseUrl, token: undefined, workspaceCwd: cwd },
        };
      },
    });
    pools.push(pool);

    const orchestrator = new RecoveryOrchestrator({
      pool,
      promptQueue: { isInFlight: () => false },
    });
    pool.setRecoveryProvider(orchestrator);
    pool.setOnDaemonDeath((key, sessions, exit) =>
      orchestrator.recover(key, sessions, exit),
    );

    const created = await pool.createOrAttachSession({
      workspaceCwd: '/proj/alpha',
    });
    const sid = created.sessionId;
    expect(spawnCount).toBe(1);
    const firstEndpoint = pool.daemonEndpointForSession(sid)?.url;

    const { audit, entries } = recorder();
    const base = await mountRoute(pool, audit);

    // 1) Graceful restart (force: false)
    const res1 = await fetch(`${base}/rc/sessions/${sid}/restart-daemon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as Record<string, unknown>;
    expect(body1).toEqual({
      sessionId: sid,
      restarted: true,
      recovered: true,
      force: false,
      sessionCount: 1,
    });
    expect(stopSignals).toEqual([false]);
    expect(spawnCount).toBe(2);
    const secondEndpoint = pool.daemonEndpointForSession(sid)?.url;
    expect(secondEndpoint).toBeDefined();
    expect(secondEndpoint).not.toBe(firstEndpoint);

    // 2) Force restart (force: true)
    const res2 = await fetch(`${base}/rc/sessions/${sid}/restart-daemon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2).toMatchObject({
      sessionId: sid,
      restarted: true,
      recovered: true,
      force: true,
    });
    expect(stopSignals).toEqual([false, true]);
    expect(spawnCount).toBe(3);

    // Audit records never leak workspace paths
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries)).not.toContain('/proj/alpha');
    expect(entries[0]).toMatchObject({
      action: 'session_daemon_restarted',
      target: sid,
      outcome: 'ok',
      detail: { force: false, recovered: true, sessionCount: 1 },
    });
    expect(entries[1]).toMatchObject({
      action: 'session_daemon_restarted',
      target: sid,
      outcome: 'ok',
      detail: { force: true, recovered: true, sessionCount: 1 },
    });
  });

  it('restarts a cold/untracked session when workspaceCwd fallback is provided', async () => {
    const defaultStub = await startStubDaemon();
    stubs.push(defaultStub);
    const pool = new DaemonPool({
      defaultDaemon: new DaemonClient({ baseUrl: defaultStub.baseUrl }),
      defaultWorkspaceCwd: '/proj/default',
      spawn: async (cwd) => {
        const s = await startStubDaemon({ sessionId: SID });
        stubs.push(s);
        return {
          client: new DaemonClient({ baseUrl: s.baseUrl }),
          stop: async () => {
            await s.close();
          },
          workspaceCwd: cwd,
        };
      },
    });
    pools.push(pool);

    const base = await mountRoute(pool);
    const res = await fetch(`${base}/rc/sessions/${SID}/restart-daemon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceCwd: '/proj/cold' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: SID,
      restarted: true,
      recovered: true,
      force: false,
      sessionCount: 1,
    });
    expect(pool.sessionWorkspaceCwd(SID)).toBe('/proj/cold');
  });

  it('refuses with 409 attached_daemon_not_managed when the session runs on an externally attached default daemon', async () => {
    const attachedStub = await startStubDaemon({ sessionId: SID });
    stubs.push(attachedStub);
    const pool = new DaemonPool({
      defaultDaemon: new DaemonClient({ baseUrl: attachedStub.baseUrl }),
      defaultWorkspaceCwd: '/proj/attached',
      respawnDefaultDaemon: false,
      spawn: async () => {
        throw new Error('must not spawn');
      },
    });
    pools.push(pool);
    const created = await pool.createOrAttachSession({});

    const base = await mountRoute(pool);
    const res = await fetch(
      `${base}/rc/sessions/${created.sessionId}/restart-daemon`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'attached_daemon_not_managed',
    });
  });

  it('rejects malformed session ids with 404, non-boolean force with 400, relative workspaceCwd with 400, and unknown sessions with 404', async () => {
    const base = await mountRoute({
      restartSessionDaemon: async (id) => {
        throw new UnknownSessionError(id);
      },
    });

    const badId = await fetch(
      `${base}/rc/sessions/not..valid/restart-daemon`,
      { method: 'POST' },
    );
    expect(badId.status).toBe(404);

    const badForce = await fetch(`${base}/rc/sessions/${SID}/restart-daemon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: 'yes' }),
    });
    expect(badForce.status).toBe(400);
    expect(await badForce.json()).toMatchObject({ code: 'invalid_body' });

    const badCwd = await fetch(`${base}/rc/sessions/${SID}/restart-daemon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceCwd: 'relative/path' }),
    });
    expect(badCwd.status).toBe(400);
    expect(await badCwd.json()).toMatchObject({ code: 'invalid_workspace' });

    const missing = await fetch(`${base}/rc/sessions/${SID}/restart-daemon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'session_not_found' });
  });

  it('maps CannotRestartAttachedDaemonError directly on route unit boundary', async () => {
    const base = await mountRoute({
      restartSessionDaemon: async () => {
        throw new CannotRestartAttachedDaemonError();
      },
    });
    const res = await fetch(`${base}/rc/sessions/${SID}/restart-daemon`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'attached_daemon_not_managed',
    });
  });
});
