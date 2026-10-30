/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import {
  startStubDaemon,
  type StubDaemon,
  type StubDaemonOptions,
} from '../testing/stubDaemon.js';
import {
  DaemonPool,
  UnknownSessionError,
  type PooledDaemonSpawn,
  type SessionDaemon,
} from '../daemonPool.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { createGatewayApp } from '../server.js';
import { SESSION_READ, SHARE, WRITE } from '../scopes.js';
import type { AuditRecorder } from '../auditLog.js';
import {
  createSessionGoalClearRoute,
  createSessionGoalReadRoute,
  createSessionGoalSetRoute,
} from './sessionGoal.js';

const SID = '11111111-1111-1111-1111-111111111111';
const OTHER_SID = '22222222-2222-2222-2222-222222222222';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;
let tmp: string | undefined;
let pool: DaemonPool | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (pool) await pool.stopAll();
  if (stub) await stub.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  gateway = undefined;
  stub = undefined;
  tmp = undefined;
  pool = undefined;
});

async function listen(app: express.Express): Promise<string> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Row {
  action: string;
  actorTokenId?: string;
  target?: string;
  detail?: Record<string, unknown>;
}

async function mountRoutes(
  daemon: SessionDaemon,
  opts: { rows?: Row[] } = {},
): Promise<string> {
  const app = express();
  app.use(express.json());
  const audit = opts.rows
    ? ({
        record: async (row: Row) => {
          opts.rows!.push(row);
        },
      } as unknown as AuditRecorder)
    : undefined;
  app.get('/session/:id/goal', createSessionGoalReadRoute(daemon));
  app.post('/session/:id/goal', createSessionGoalSetRoute(daemon, audit));
  app.post(
    '/session/:id/goal/clear',
    createSessionGoalClearRoute(daemon, audit),
  );
  return listen(app);
}

/** Over a REAL DaemonClient (spec ledger D61). */
async function mountReal(
  opts: StubDaemonOptions = {},
  routeOpts: { rows?: Row[] } = {},
): Promise<string> {
  stub = await startStubDaemon(opts);
  return mountRoutes(
    new DaemonClient({ baseUrl: stub.baseUrl }) as unknown as SessionDaemon,
    routeOpts,
  );
}

async function send(
  url: string,
  method: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function throwing(err: unknown): SessionDaemon {
  const fail = async () => {
    throw err;
  };
  return {
    sessionGoal: fail,
    sessionGoalControl: fail,
    sessionGoalClear: fail,
  } as unknown as SessionDaemon;
}

const GOAL = (base: string, suffix = '') => `${base}/session/${SID}/goal${suffix}`;
const SEED = { objective: 'Ship the migration', lastReason: 'the tests are red' };

type Snapshot = {
  v: number;
  goal: null | {
    goalId: string;
    revision: number;
    objective: string;
    status: string;
    lastReason?: string;
  };
  activity: string;
};

describe('GET /session/:id/goal (#135)', () => {
  it('relays the daemon snapshot through the SDK: objective, status, reason, activity', async () => {
    const base = await mountReal({ goal: { seed: { [SID]: SEED } } });
    const out = await send(GOAL(base), 'GET');
    expect(out.status).toBe(200);
    const snap = out.body['snapshot'] as Snapshot;
    expect(snap).toMatchObject({
      v: 2,
      activity: 'idle',
      goal: {
        objective: 'Ship the migration',
        status: 'active',
        revision: 1,
        lastReason: 'the tests are red',
      },
    });
    expect(stub?.goalCalls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/session/' + SID + '/goal'],
    ]);
  });

  it('a session with no goal answers a null goal, not an error', async () => {
    const base = await mountReal();
    const out = await send(GOAL(base), 'GET');
    expect(out.status).toBe(200);
    expect((out.body['snapshot'] as Snapshot).goal).toBeNull();
  });

  it('refuses a malformed session id without asking the daemon', async () => {
    const base = await mountReal();
    const out = await send(`${base}/session/not-an-id/goal`, 'GET');
    expect(out.status).toBe(404);
    expect(out.body['code']).toBe('session_not_found');
    expect(stub?.goalCalls).toEqual([]);
  });

  it('a daemon without the route (a plain-text 404) is goal_unsupported, a JSON 404 is a missing session', async () => {
    const base = await mountRoutes(
      throwing(new DaemonHttpError(404, 'Cannot GET /session/x/goal', 'r')),
    );
    const old = await send(GOAL(base), 'GET');
    expect(old.status).toBe(502);
    expect(old.body['code']).toBe('goal_unsupported');
    gateway?.close();
    const base2 = await mountRoutes(
      throwing(
        new DaemonHttpError(
          404,
          { error: 'No session', code: 'session_not_found' },
          'r',
        ),
      ),
    );
    const gone = await send(GOAL(base2), 'GET');
    expect(gone.status).toBe(404);
    expect(gone.body['code']).toBe('session_not_found');
  });

  it('a session the pool does not hold is a 404, and a dead daemon is a 502', async () => {
    const base = await mountRoutes(throwing(new UnknownSessionError(SID)));
    expect((await send(GOAL(base), 'GET')).status).toBe(404);
    gateway?.close();
    const base2 = await mountRoutes(throwing(new Error('connect ECONNREFUSED')));
    const dead = await send(GOAL(base2), 'GET');
    expect(dead.status).toBe(502);
    expect(dead.body['code']).toBe('daemon_unavailable');
  });

  it('a body the daemon sent without a snapshot is not passed on as a goal', async () => {
    stub = await startStubDaemon();
    const base = await mountRoutes({
      sessionGoal: async () => ({}),
    } as unknown as SessionDaemon);
    const out = await send(GOAL(base), 'GET');
    expect(out.status).toBe(502);
  });
});

describe('POST /session/:id/goal (#135)', () => {
  it('with no goal sends a create carrying the trimmed objective, and nothing else', async () => {
    const rows: Row[] = [];
    const base = await mountReal({}, { rows });
    const out = await send(GOAL(base), 'POST', { objective: '  Ship it  ' });
    expect(out.status).toBe(200);
    expect((out.body['snapshot'] as Snapshot).goal).toMatchObject({
      objective: 'Ship it',
      status: 'active',
    });
    const posts = stub!.goalCalls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ action: 'create', objective: 'Ship it' });
    expect(rows).toEqual([
      {
        action: 'session_goal_set',
        actorTokenId: undefined,
        target: SID,
        detail: { action: 'create' },
      },
    ]);
  });

  it('with a goal sends a replace that carries its id and revision, as /goal <text> does', async () => {
    const rows: Row[] = [];
    const base = await mountReal({ goal: { seed: { [SID]: SEED } } }, { rows });
    const before = (await send(GOAL(base), 'GET')).body['snapshot'] as Snapshot;
    const out = await send(GOAL(base), 'POST', { objective: 'Something else' });
    expect(out.status).toBe(200);
    const posts = stub!.goalCalls.filter((c) => c.method === 'POST');
    expect(posts[0]!.body).toEqual({
      action: 'replace',
      objective: 'Something else',
      expectedGoalId: before.goal!.goalId,
      expectedRevision: before.goal!.revision,
    });
    const after = (await send(GOAL(base), 'GET')).body['snapshot'] as Snapshot;
    expect(after.goal!.objective).toBe('Something else');
    expect(after.goal!.goalId).not.toBe(before.goal!.goalId);
    expect(rows[0]).toMatchObject({
      action: 'session_goal_set',
      detail: { action: 'replace' },
    });
    // The words the user typed are not in the audit record.
    expect(JSON.stringify(rows)).not.toContain('Something else');
  });

  it('refuses a body of the wrong shape without asking the daemon', async () => {
    const base = await mountReal();
    const cases: unknown[] = [
      [],
      {},
      { objective: '' },
      { objective: '   ' },
      { objective: 7 },
      { objective: 'x', action: 'clear' },
      { objective: 'x', expectedGoalId: 'g' },
      { objective: 'x'.repeat(4001) },
    ];
    for (const body of cases) {
      const out = await send(GOAL(base), 'POST', body);
      expect(out.status, JSON.stringify(body)).toBe(400);
      expect(out.body['code']).toBe('invalid_goal');
    }
    expect(stub?.goalCalls).toEqual([]);
  });

  it('takes an objective of exactly the longest length', async () => {
    const base = await mountReal();
    const out = await send(GOAL(base), 'POST', { objective: 'x'.repeat(4000) });
    expect(out.status).toBe(200);
  });

  it('an untrusted folder is a 403 untrusted_workspace in the gateway\'s words', async () => {
    const rows: Row[] = [];
    const base = await mountReal({ goal: { untrusted: true } }, { rows });
    const out = await send(GOAL(base), 'POST', { objective: 'x' });
    expect(out.status).toBe(403);
    expect(out.body['code']).toBe('untrusted_workspace');
    expect(out.body['error']).toMatch(/not trusted/);
    expect(rows[0]).toMatchObject({
      action: 'session_goal_set_failed',
      detail: { reason: 'untrusted' },
    });
  });

  it('a goal that moved between the read and the write is a 409 carrying the daemon\'s current snapshot, not a silent overwrite', async () => {
    let reads = 0;
    stub = await startStubDaemon({
      goal: {
        seed: { [SID]: SEED },
        // The agent moves the goal after the route's own read.
        change: () => {
          reads += 1;
          return reads === 2
            ? { objective: 'Moved under you', status: 'paused' }
            : undefined;
        },
      },
    });
    const base = await mountRoutes(
      new DaemonClient({ baseUrl: stub.baseUrl }) as unknown as SessionDaemon,
    );
    const out = await send(GOAL(base), 'POST', { objective: 'Mine' });
    expect(out.status).toBe(409);
    expect(out.body['code']).toBe('goal_conflict');
    expect((out.body['snapshot'] as Snapshot).goal).toMatchObject({
      objective: 'Moved under you',
      status: 'paused',
    });
    // The daemon's message quotes the goal's version; it is not relayed.
    expect(out.body['error']).toBe('The goal changed while this was sent');
  });

  it('a daemon without the routes is goal_unsupported', async () => {
    const base = await mountRoutes(
      throwing(new DaemonHttpError(404, 'Cannot GET /session/x/goal', 'r')),
    );
    const out = await send(GOAL(base), 'POST', { objective: 'x' });
    expect(out.status).toBe(502);
    expect(out.body['code']).toBe('goal_unsupported');
  });

  it('a save the daemon failed (goal_persist_failed) is a 502 that does not echo its message', async () => {
    const base = await mountRoutes(
      throwing(
        new DaemonHttpError(
          500,
          { error: 'ENOSPC /home/x/.qwen', code: 'goal_persist_failed' },
          'r',
        ),
      ),
    );
    const out = await send(GOAL(base), 'POST', { objective: 'x' });
    expect(out.status).toBe(502);
    expect(out.body['code']).toBe('goal_persist_failed');
    expect(JSON.stringify(out.body)).not.toContain('ENOSPC');
  });
});

describe('POST /session/:id/goal/clear (#135)', () => {
  it('clears the goal, says it did, and the next read has none', async () => {
    const rows: Row[] = [];
    const base = await mountReal({ goal: { seed: { [SID]: SEED } } }, { rows });
    const out = await send(GOAL(base, '/clear'), 'POST', {});
    expect(out.status).toBe(200);
    expect(out.body['cleared']).toBe(true);
    expect((out.body['snapshot'] as Snapshot).goal).toBeNull();
    // The cleared goal's words are not echoed back.
    expect(JSON.stringify(out.body)).not.toContain('Ship the migration');
    const after = await send(GOAL(base), 'GET');
    expect((after.body['snapshot'] as Snapshot).goal).toBeNull();
    expect(rows).toEqual([
      {
        action: 'session_goal_cleared',
        actorTokenId: undefined,
        target: SID,
        detail: { cleared: true },
      },
    ]);
  });

  it('clearing nothing is an answer at 200, cleared false', async () => {
    const base = await mountReal();
    const out = await send(GOAL(base, '/clear'), 'POST', {});
    expect(out.status).toBe(200);
    expect(out.body['cleared']).toBe(false);
  });

  it('a daemon refusal is told apart and audited as a failure', async () => {
    const rows: Row[] = [];
    const base = await mountRoutes(
      throwing(new DaemonHttpError(404, 'Cannot POST /session/x/goal/clear', 'r')),
      { rows },
    );
    const out = await send(GOAL(base, '/clear'), 'POST', {});
    expect(out.status).toBe(502);
    expect(out.body['code']).toBe('goal_unsupported');
    expect(rows[0]).toMatchObject({
      action: 'session_goal_clear_failed',
      detail: { reason: 'unsupported' },
    });
  });
});

describe('DaemonPool: the goal methods go through the SDK\'s own names (#135)', () => {
  it('sessionGoal, sessionGoalControl and sessionGoalClear reach the client unchanged', async () => {
    const seen: string[] = [];
    const client = {
      async createOrAttachSession(req: { workspaceCwd?: string }) {
        return {
          sessionId: 'sid-1',
          workspaceCwd: req.workspaceCwd ?? '/home',
          attached: false,
        };
      },
      async closeSession() {},
      async sessionGoal(s: string, c?: string) {
        seen.push(`goal ${s} ${c}`);
        return { snapshot: { v: 2, goal: null, activity: 'idle' } };
      },
      async sessionGoalControl(s: string, r: { action: string }, c?: string) {
        seen.push(`control ${s} ${r.action} ${c}`);
        return { snapshot: { v: 2, goal: null, activity: 'idle' } };
      },
      async sessionGoalClear(s: string, c?: string) {
        seen.push(`clear ${s} ${c}`);
        return { cleared: false };
      },
      async capabilities() {
        return { workspaceCwd: '/home' };
      },
      async health() {
        return { status: 'ok' };
      },
    } as unknown as DaemonClient;
    const spawn = async (cwd: string): Promise<PooledDaemonSpawn> => ({
      client,
      stop: async () => {},
      workspaceCwd: cwd,
    });
    pool = new DaemonPool({
      defaultDaemon: client,
      defaultWorkspaceCwd: '/home',
      deathProbeDelayMs: 0,
      spawn,
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/w' });
    await pool.sessionGoal(s.sessionId);
    await pool.sessionGoalControl(s.sessionId, {
      action: 'create',
      objective: 'x',
    });
    await pool.sessionGoalClear(s.sessionId);
    // No bound client id is added: the daemon's goal routes take none.
    expect(seen).toEqual([
      'goal sid-1 undefined',
      'control sid-1 create undefined',
      'clear sid-1 undefined',
    ]);
  });
});

describe('the #135 goal routes as the gateway mounts them', () => {
  async function bootGateway(
    opts: StubDaemonOptions = {},
  ): Promise<{ url: string; store: TokenStore }> {
    stub = await startStubDaemon(opts);
    tmp = mkdtempSync(join(tmpdir(), 'rc-goal-'));
    const store = await TokenStore.open(join(tmp, 'tokens.json'));
    const { app } = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(tmp, 'audit.log'),
    });
    return { url: await listen(app), store };
  }

  it('a token with write reads, sets and clears the goal', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([WRITE], 'phone');
    const set = await send(GOAL(url), 'POST', { objective: 'Ship it' }, token);
    expect(set.status).toBe(200);
    const read = await send(GOAL(url), 'GET', undefined, token);
    expect((read.body['snapshot'] as Snapshot).goal?.objective).toBe('Ship it');
    const clear = await send(GOAL(url, '/clear'), 'POST', {}, token);
    expect(clear.body['cleared']).toBe(true);
  });

  it('a read-only token reads the goal and is refused the set and the clear', async () => {
    const { url, store } = await bootGateway({ goal: { seed: { [SID]: SEED } } });
    const { token } = await store.issue([SESSION_READ], 'reader');
    const read = await send(GOAL(url), 'GET', undefined, token);
    expect(read.status).toBe(200);
    expect((read.body['snapshot'] as Snapshot).goal?.objective).toBe(
      'Ship the migration',
    );
    const set = await send(GOAL(url), 'POST', { objective: 'x' }, token);
    expect(set.status).toBe(403);
    expect(set.body['code']).toBe('scope_required');
    const clear = await send(GOAL(url, '/clear'), 'POST', {}, token);
    expect(clear.status).toBe(403);
    expect(stub?.goalCalls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a share token, locked to this session or another, is refused both writes, and its body is never read', async () => {
    const { url, store } = await bootGateway({ goal: { seed: { [SID]: SEED } } });
    for (const lock of [SID, OTHER_SID]) {
      const share = await store.issueShare({
        scopes: [SHARE, SESSION_READ],
        label: 'guest',
        sessionLockId: lock,
        ttlSec: 3600,
        parentId: 'owner',
      });
      // A body that would be a 400 for anyone who got as far as reading it.
      const set = await send(GOAL(url), 'POST', { nonsense: true }, share.token);
      expect(set.status, lock).toBe(403);
      expect(set.body['code']).toBe('scope_required');
      const clear = await send(GOAL(url, '/clear'), 'POST', {}, share.token);
      expect(clear.status, lock).toBe(403);
    }
    expect(stub?.goalCalls).toEqual([]);
  });

  it('a share token locked to this session reads the goal; one locked to another does not', async () => {
    const { url, store } = await bootGateway({ goal: { seed: { [SID]: SEED } } });
    const mine = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: SID,
      ttlSec: 3600,
      parentId: 'owner',
    });
    const other = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: OTHER_SID,
      ttlSec: 3600,
      parentId: 'owner',
    });
    expect((await send(GOAL(url), 'GET', undefined, mine.token)).status).toBe(200);
    expect((await send(GOAL(url), 'GET', undefined, other.token)).status).toBe(403);
  });

  it('the capability flag says the routes are mounted', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([SESSION_READ], 'reader');
    const res = await fetch(`${url}/rc/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as {
      remoteControl: { sessionGoal?: unknown };
    };
    expect(body.remoteControl.sessionGoal).toBe(true);
  });
});
