/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { createSessionCreateRoute } from './sessionCreate.js';
import {
  DaemonPool,
  WorkspacePoolFullError,
  type SessionDaemon,
} from '../daemonPool.js';
import { AuditLog, type AuditEntry, type AuditRecorder } from '../auditLog.js';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;
const tmpDirs: string[] = [];

/** Real existing directory for tests that exercise the cwd-must-exist check. */
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function mountGateway(
  daemon: SessionDaemon,
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
  app.post('/session', createSessionCreateRoute(daemon, audit));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function pollAudit(
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

describe('POST /session (create)', () => {
  it('creates a session and returns its id + workspace', async () => {
    const projDir = makeTmpDir('qwen-session-create-proj-');
    stub = await startStubDaemon({ workspaceCwd: projDir });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: projDir }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      workspaceCwd: string;
    };
    expect(body.sessionId).toBe('stub-agent-1');
    expect(body.workspaceCwd).toBe(projDir);
    // The cwd + default scope are forwarded to the daemon.
    expect(stub.lastCreateSessionBody).toMatchObject({
      cwd: projDir,
      sessionScope: 'single',
    });
  });

  it('audits session_created with the id + scope, never the cwd path', async () => {
    const secretDir = makeTmpDir('qwen-session-create-secret-');
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mountGateway(daemon, audit);

    await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: secretDir }),
    });

    const row = await pollAudit(audit, 'session_created');
    expect(row).toBeDefined();
    expect(row!.actorTokenId).toBe('tkn-owner');
    expect(row!.target).toBe('stub-agent-1');
    expect(row!.detail).toEqual({ scope: 'single' });
    // Path hygiene: the cwd must never reach the audit record.
    expect(JSON.stringify(row)).not.toContain(secretDir);
  });

  it('rejects a create whose cwd is not an existing directory', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/does/not/exist', scope: 'thread' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_workspace');
    // Rejected before any daemon call.
    expect(stub.createdSessionCount).toBe(0);
  });

  it('returns 503 workspace_pool_full with slot holders and idleReapMs next step when the pool is full (#219)', async () => {
    const dir = makeTmpDir('qwen-session-create-full-');
    // A fake pool whose createOrAttachSession throws the pool's own
    // WorkspacePoolFullError (max concurrent workspace daemons, all busy):
    // the route must map this to a distinct, retryable 503 with slot holders
    // and how to free one (#219), not the generic 502 daemon_unavailable.
    const fullPool = {
      async createOrAttachSession() {
        throw new WorkspacePoolFullError(2, {
          requestedWorkspaceCwd: dir,
          idleReapMs: 15 * 60_000,
          slots: [
            {
              workspaceCwd: '/srv/work/alpha',
              idle: false,
              state: 'busy',
              sessionCount: 1,
              inFlightCount: 0,
              idleForMs: 60_000,
            },
            {
              workspaceCwd: '/srv/work/beta',
              idle: false,
              state: 'busy',
              sessionCount: 2,
              inFlightCount: 0,
              idleForMs: 300_000,
            },
          ],
        });
      },
    } as unknown as SessionDaemon;
    const url = await mountGateway(fullPool);

    const res = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: dir }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      code: string;
      error: string;
      maxDaemons: number;
      idleReapMs: number;
      requestedWorkspaceCwd: string;
      slots: Array<{ workspaceCwd: string; idle: boolean; state: string }>;
      next: string;
    };
    expect(body.code).toBe('workspace_pool_full');
    expect(body.maxDaemons).toBe(2);
    expect(body.idleReapMs).toBe(900_000);
    expect(body.requestedWorkspaceCwd).toBe(dir);
    expect(body.slots).toHaveLength(2);
    expect(body.slots[0]?.workspaceCwd).toBe('/srv/work/alpha');
    expect(body.slots[0]?.idle).toBe(false);
    expect(body.error).toContain('/srv/work/alpha');
    expect(body.error).toContain('/srv/work/beta');
    expect(body.next).toContain('idleReapMs: 900000 ms / 15 min');
  });

  it("defaults scope to 'single'; passes 'thread' through; omits empty cwd", async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    // Empty cwd → omitted on the wire (daemon falls back to bound workspace);
    // explicit thread scope → forwarded.
    const res = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '', scope: 'thread' }),
    });
    expect(res.status).toBe(200);
    const sent = stub.lastCreateSessionBody as Record<string, unknown>;
    expect(sent.sessionScope).toBe('thread');
    expect('cwd' in sent).toBe(false); // empty cwd is stripped, not sent as ""
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ createSessionStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const res = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('daemon_unavailable');
  });

  it('persists a hash-chained workspace_pool_full audit row and journal line on real pool refusal (#220)', async () => {
    const runtimeDir = makeTmpDir('qwen-pool-full-audit-');
    const wsOccupied = makeTmpDir('qwen-pool-full-occ-');
    const wsBlocked = makeTmpDir('qwen-pool-full-blk-');
    stub = await startStubDaemon();
    const journalLines: string[] = [];
    const pool = new DaemonPool({
      defaultDaemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      defaultWorkspaceCwd: makeTmpDir('qwen-pool-full-def-'),
      maxDaemons: 1,
      idleReapMs: 15 * 60_000,
      log: (line) => journalLines.push(line),
      spawn: async (cwd) => ({
        client: new DaemonClient({ baseUrl: stub!.baseUrl }),
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    const store = await TokenStore.open(join(runtimeDir, 'tokens.json'));
    const { token } = await store.issue(['write'], 'phone');
    const gw = createGatewayApp({
      daemon: pool,
      store,
      pairing: new PairingService(),
      auditPath: join(runtimeDir, 'audit.log'),
    });
    gateway = await new Promise((resolve) => {
      const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = gateway.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const okRes = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ cwd: wsOccupied, scope: 'thread' }),
    });
    expect(okRes.status).toBe(200);

    const fullRes = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ cwd: wsBlocked, scope: 'thread' }),
    });
    expect(fullRes.status).toBe(503);

    expect(journalLines).toHaveLength(1);
    expect(journalLines[0]).toContain(wsBlocked);
    expect(journalLines[0]).toContain(wsOccupied);

    const rows = await gw.audit.query({ action: 'workspace_pool_full' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'workspace_pool_full',
      outcome: 'failed',
      target: wsBlocked,
      detail: {
        requestedWorkspaceCwd: wsBlocked,
        maxDaemons: 1,
        idleReapMs: 900_000,
        slots: [
          expect.objectContaining({
            workspaceCwd: wsOccupied,
            idle: false,
            state: 'busy',
            sessionCount: 1,
          }),
        ],
      },
    });
    const chain = await AuditLog.verifyChain(runtimeDir);
    expect(chain.ok).toBe(true);
    await pool.stopAll();
  });
});
