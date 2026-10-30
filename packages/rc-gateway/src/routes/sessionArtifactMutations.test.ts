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
  createSessionArtifactAddRoute,
  createSessionArtifactRemoveRoute,
} from './sessionArtifactMutations.js';
import { createSessionSourceAddRoute } from './sessionSources.js';

const SID = '11111111-1111-1111-1111-111111111111';
const OTHER_SID = '22222222-2222-2222-2222-222222222222';
const FILE = { title: 'notes.md', workspacePath: 'docs/notes.md' };

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
  opts: { rcClient?: Record<string, unknown>; rows?: Row[] } = {},
): Promise<string> {
  const app = express();
  app.use(express.json());
  if (opts.rcClient) {
    app.use((req, _res, next) => {
      (req as unknown as { rcClient: unknown }).rcClient = opts.rcClient;
      next();
    });
  }
  const audit = opts.rows
    ? ({
        record: async (row: Row) => {
          opts.rows!.push(row);
        },
      } as unknown as AuditRecorder)
    : undefined;
  app.post('/session/:id/artifacts', createSessionArtifactAddRoute(daemon, audit));
  app.delete(
    '/session/:id/artifacts/:artifactId',
    createSessionArtifactRemoveRoute(daemon, audit),
  );
  // The sources add route, to compare the client id refusal word for word.
  app.post('/session/:id/sources', createSessionSourceAddRoute(daemon));
  return listen(app);
}

/** Over a REAL DaemonClient (spec ledger D61). */
async function mountReal(
  opts: StubDaemonOptions = {},
  routeOpts: { rcClient?: Record<string, unknown>; rows?: Row[] } = {},
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
    addSessionArtifact: fail,
    removeSessionArtifact: fail,
    upsertSessionSource: fail,
  } as unknown as SessionDaemon;
}

const URL_ = (base: string, suffix = '') => `${base}/session/${SID}/artifacts${suffix}`;

describe('POST /session/:id/artifacts (#128)', () => {
  it('records a workspace file and a link through the SDK, and the daemon answers its own result', async () => {
    const base = await mountReal();
    const file = await send(URL_(base), 'POST', FILE);
    expect(file.status).toBe(200);
    expect(file.body).toMatchObject({
      v: 1,
      sessionId: SID,
      changes: [
        {
          action: 'created',
          artifact: { title: 'notes.md', storage: 'workspace', workspacePath: 'docs/notes.md' },
        },
      ],
    });
    const link = await send(URL_(base), 'POST', {
      title: 'Docs',
      kind: 'link',
      url: 'https://example.test/docs',
      description: 'the API page',
      sizeBytes: 12,
      metadata: { a: 'b', n: 1, t: true, z: null },
      clientRetained: true,
      retention: 'restorable',
    });
    expect(link.status).toBe(200);
    expect(link.body['changes']).toMatchObject([
      { action: 'created', artifact: { storage: 'external_url', kind: 'link' } },
    ]);
    expect(stub?.artifactMutationCalls.map((c) => [c.method, c.sessionId])).toEqual([
      ['POST', SID],
      ['POST', SID],
    ]);
    expect(stub?.artifactMutationCalls[1]?.body).toMatchObject({
      metadata: { a: 'b', n: 1, t: true, z: null },
      clientRetained: true,
    });
  });

  it('refuses a body of the wrong shape without asking the daemon', async () => {
    const base = await mountReal();
    const cases: unknown[] = [
      [],
      {},
      { title: 3, workspacePath: 'a' },
      { ...FILE, extra: 1 },
      { ...FILE, source: 'tool' },
      { ...FILE, clientId: 'client_x' },
      { ...FILE, kind: 4 },
      { ...FILE, sizeBytes: '12' },
      { ...FILE, clientRetained: 'yes' },
      { ...FILE, metadata: 'x' },
      { ...FILE, metadata: [] },
      { ...FILE, metadata: { a: { b: 1 } } },
      { ...FILE, workspacePath: ['a'] },
    ];
    for (const body of cases) {
      const out = await send(URL_(base), 'POST', body);
      expect(out.status, JSON.stringify(body)).toBe(400);
      expect(out.body['code']).toBe('invalid_artifact');
    }
    const bad = await send(`${base}/session/not..a..session/artifacts`, 'POST', FILE);
    expect(bad.status).toBe(404);
    expect(stub?.artifactMutationCalls).toEqual([]);
  });

  it('does not judge values the daemon judges: an empty title or two locators reach it, and its refusal comes back', async () => {
    const base = await mountReal();
    let out = await send(URL_(base), 'POST', { title: '  ', workspacePath: 'a' });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      error: 'The daemon refused the title field',
      code: 'VALIDATION_FAILED',
      field: 'title',
    });
    out = await send(URL_(base), 'POST', {
      title: 'x',
      workspacePath: 'a',
      url: 'https://a.test/',
    });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      error: 'The daemon refused this artifact',
      code: 'VALIDATION_FAILED',
    });
    out = await send(URL_(base), 'POST', { title: 'x', url: 'https://a.test/', storage: 'published' });
    expect(out.status).toBe(400);
    expect(out.body['field']).toBe('storage');
    expect(stub?.artifactMutationCalls).toHaveLength(3);
  });

  it("never echoes the daemon's message: a path the daemon could not inspect stays on the host", async () => {
    const base = await mountReal();
    const out = await send(URL_(base), 'POST', {
      title: 'x',
      workspacePath: '/home/u/secret/place',
    });
    expect(out.status).toBe(400);
    expect(out.body['code']).toBe('VALIDATION_FAILED');
    expect(out.body['field']).toBe('workspacePath');
    expect(JSON.stringify(out.body)).not.toContain('secret');
    expect(JSON.stringify(out.body)).not.toContain('ENOENT');
  });

  it('passes the daemon status and code through for a refusal it makes', async () => {
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [
        403,
        {
          error: 'Session artifact art-1 belongs to another client',
          code: 'session_artifact_forbidden',
          artifactId: 'art-1',
        },
        'session_artifact_forbidden',
      ],
      [404, { error: 'nope', code: 'session_not_found' }, 'session_not_found'],
      [409, { error: 'busy', code: 'session_archiving' }, 'session_archiving'],
      [413, { error: 'big' }, 'daemon_rejected'],
    ];
    for (const [status, errorBody, code] of cases) {
      const base = await mountReal({
        artifactMutationStatus: status,
        artifactMutationErrorBody: errorBody,
      });
      const out = await send(URL_(base), 'POST', FILE);
      expect(out.status).toBe(status);
      expect(out.body['code']).toBe(code);
      expect(JSON.stringify(out.body)).not.toContain('art-1');
      await new Promise<void>((r) => gateway!.close(() => r()));
      await stub!.close();
      gateway = undefined;
      stub = undefined;
    }
  });

  it('a daemon without the routes is named, a 503 keeps its code, anything else is 502 without the error text', async () => {
    let base = await mountRoutes(
      throwing(new DaemonHttpError(404, 'Cannot POST /session/x/artifacts', 'nf')),
    );
    let out = await send(URL_(base), 'POST', FILE);
    expect(out.status).toBe(502);
    expect(out.body['code']).toBe('artifact_mutations_unsupported');
    await new Promise<void>((r) => gateway!.close(() => r()));
    base = await mountRoutes(
      throwing(
        new DaemonHttpError(
          503,
          { error: 'x', code: 'artifact_persistence_unavailable' },
          'u',
        ),
      ),
    );
    out = await send(URL_(base), 'POST', FILE);
    expect(out.status).toBe(503);
    expect(out.body['code']).toBe('artifact_persistence_unavailable');
    await new Promise<void>((r) => gateway!.close(() => r()));
    base = await mountRoutes(throwing(new Error('ECONNRESET /home/u/x')));
    out = await send(URL_(base), 'POST', FILE);
    expect(out.status).toBe(502);
    expect(out.body['code']).toBe('daemon_unavailable');
    expect(JSON.stringify(out.body)).not.toContain('/home/u');
  });

  it('a session the pool does not hold is 409 session_not_loaded, as the artifact reads answer it', async () => {
    const base = await mountRoutes(throwing(new UnknownSessionError(SID)));
    const out = await send(URL_(base), 'POST', FILE);
    expect(out.status).toBe(409);
    expect(out.body['code']).toBe('session_not_loaded');
  });
});

describe('DELETE /session/:id/artifacts/:artifactId (#128)', () => {
  it('drops one, and dropping it again is an empty change list at 200', async () => {
    const base = await mountReal();
    const added = await send(URL_(base), 'POST', FILE);
    const id = (added.body['changes'] as Array<{ artifactId: string }>)[0]!.artifactId;
    let out = await send(URL_(base, `/${id}`), 'DELETE');
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      v: 1,
      sessionId: SID,
      changes: [{ action: 'removed', artifactId: id, reason: 'explicit' }],
    });
    out = await send(URL_(base, `/${id}`), 'DELETE');
    expect(out.status).toBe(200);
    expect(out.body['changes']).toEqual([]);
    expect(stub?.artifactMutationCalls.map((c) => [c.method, c.artifactId])).toEqual([
      ['POST', undefined],
      ['DELETE', id],
      ['DELETE', id],
    ]);
  });

  it('refuses something that cannot be an artifact id without asking the daemon', async () => {
    const base = await mountReal();
    for (const bad of ['..%2Fx', 'a%2Fb', 'x'.repeat(513)]) {
      const out = await send(URL_(base, `/${bad}`), 'DELETE');
      expect(out.status, bad).toBe(400);
      expect(out.body['code']).toBe('invalid_artifact_id');
    }
    const gone = await send(`${base}/session/not..a..session/artifacts/x`, 'DELETE');
    expect(gone.status).toBe(404);
    expect(stub?.artifactMutationCalls).toEqual([]);
  });

  it("another client's artifact is the daemon's 403, relayed", async () => {
    const base = await mountReal({
      artifactMutationStatus: 403,
      artifactMutationErrorBody: {
        error: 'Session artifact art-9 belongs to another client',
        code: 'session_artifact_forbidden',
        artifactId: 'art-9',
      },
    });
    const out = await send(URL_(base, '/art-9'), 'DELETE');
    expect(out.status).toBe(403);
    expect(out.body['code']).toBe('session_artifact_forbidden');
    expect(JSON.stringify(out.body)).not.toContain('art-9');
  });
});

describe('the audit rows (#128)', () => {
  it('record the count of changes and the reason for a failure, never the content', async () => {
    const rows: Row[] = [];
    const base = await mountReal({}, { rows, rcClient: { id: 'tok-1', scopes: ['write'] } });
    const added = await send(URL_(base), 'POST', {
      title: 'Secret plan',
      workspacePath: 'private/plan.md',
    });
    const id = (added.body['changes'] as Array<{ artifactId: string }>)[0]!.artifactId;
    await send(URL_(base, `/${id}`), 'DELETE');
    await send(URL_(base), 'POST', { title: '', workspacePath: 'a' });
    expect(rows).toEqual([
      {
        action: 'session_artifact_added',
        actorTokenId: 'tok-1',
        target: SID,
        detail: { changes: 1 },
      },
      {
        action: 'session_artifact_removed',
        actorTokenId: 'tok-1',
        target: SID,
        detail: { changes: 1 },
      },
      {
        action: 'session_artifact_add_failed',
        actorTokenId: 'tok-1',
        target: SID,
        detail: { reason: 'rejected' },
      },
    ]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('private');
    expect(text).not.toContain(id);
  });

  it('a request refused for its shape, or as a share, writes no row and reaches no daemon', async () => {
    const rows: Row[] = [];
    const base = await mountReal(
      {},
      { rows, rcClient: { id: 'g', shareId: 'share-1', scopes: ['share', 'session:read'] } },
    );
    const out = await send(URL_(base), 'POST', { nonsense: true });
    expect(out.status).toBe(403);
    expect(rows).toEqual([]);
    expect(stub?.artifactMutationCalls).toEqual([]);
  });
});

describe('the client id the daemon requires for an artifact mutation (#128)', () => {
  /** The gateway over a real pool whose daemon stamps and enforces ids. */
  async function bootPooled(): Promise<{ url: string; store: TokenStore }> {
    tmp = mkdtempSync(join(tmpdir(), 'rc-artifacts-'));
    stub = await startStubDaemon({ stampClientIds: true, workspaceCwd: tmp });
    pool = new DaemonPool({
      defaultDaemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      defaultWorkspaceCwd: tmp,
      spawn: async () => {
        throw new Error('no spawn in this test');
      },
    });
    const store = await TokenStore.open(join(tmp, 'tokens.json'));
    const { app } = createGatewayApp({
      daemon: pool,
      store,
      pairing: new PairingService(),
      auditPath: join(tmp, 'audit.log'),
    });
    return { url: await listen(app), store };
  }

  it("adds and removes as the gateway's own attached client, the one the daemon stamped on the resume", async () => {
    const { url, store } = await bootPooled();
    const { token } = await store.issue([WRITE], 'phone');
    const resumed = await send(`${url}/session/${SID}/resume`, 'POST', { cwd: tmp }, token);
    expect(resumed.status).toBe(200);
    const added = await send(URL_(url), 'POST', FILE, token);
    expect(added.status).toBe(200);
    const id = (added.body['changes'] as Array<{ artifactId: string }>)[0]!.artifactId;
    const again = await send(URL_(url), 'POST', { ...FILE, title: 'renamed' }, token);
    expect(again.body['changes']).toMatchObject([{ action: 'updated' }]);
    const removed = await send(URL_(url, `/${id}`), 'DELETE', undefined, token);
    expect(removed.status).toBe(200);
    expect(removed.body['changes']).toMatchObject([{ action: 'removed', artifactId: id }]);
    expect(stub?.artifactMutationCalls.map((c) => [c.method, c.clientId])).toEqual([
      ['POST', 'client_stub-1'],
      ['POST', 'client_stub-1'],
      ['DELETE', 'client_stub-1'],
    ]);
  });

  it('a conversation the pool never attached to is the page message, not the daemon refusal', async () => {
    const { url, store } = await bootPooled();
    const { token } = await store.issue([WRITE], 'phone');
    const out = await send(URL_(url), 'POST', FILE, token);
    expect(out.status).toBe(409);
    expect(out.body['code']).toBe('session_not_loaded');
    expect(stub?.artifactMutationCalls).toEqual([]);
  });

  it('with no client id to send, the daemon 403 reads "open the conversation again", the sources routes\' answer exactly', async () => {
    // A bare DaemonClient never attached through a pool, so it holds no id.
    const base = await mountReal({ stampClientIds: true });
    const art = await send(URL_(base), 'POST', FILE);
    const del = await send(URL_(base, '/art-1'), 'DELETE');
    const src = await send(`${base}/session/${SID}/sources`, 'POST', {
      title: 'x',
      locator: { type: 'url', url: 'https://a.test/' },
    });
    expect(art.status).toBe(409);
    expect(art.body['code']).toBe('client_not_bound');
    expect(del.status).toBe(409);
    expect(del.body).toEqual(art.body);
    expect(art.body).toEqual(src.body);
    expect(stub?.artifactMutationCalls.map((c) => c.clientId)).toEqual([undefined, undefined]);
  });

  it('an id the daemon never stamped (400 invalid_client_id) reads the same, and never echoes the id', async () => {
    const base = await mountRoutes(
      throwing(
        new DaemonHttpError(
          400,
          {
            error: 'Invalid client id "client_x" for session s',
            code: 'invalid_client_id',
            clientId: 'client_x',
          },
          'r',
        ),
      ),
    );
    const out = await send(URL_(base), 'POST', FILE);
    expect(out.status).toBe(409);
    expect(out.body['code']).toBe('client_not_bound');
    expect(JSON.stringify(out.body)).not.toContain('client_x');
  });
});

describe('DaemonPool: the artifact writes send the bound client id (#128)', () => {
  function fakeClient(
    cwd: string,
    seen: Array<[string, string | undefined]>,
    stamp: () => string | undefined,
  ) {
    return {
      async createOrAttachSession(req: { workspaceCwd?: string }) {
        const clientId = stamp();
        return {
          sessionId: 'sid-' + (req.workspaceCwd ?? cwd),
          workspaceCwd: cwd,
          attached: false,
          ...(clientId ? { clientId } : {}),
        };
      },
      async closeSession() {},
      async addSessionArtifact(_s: string, _a: unknown, clientId?: string) {
        seen.push(['add', clientId]);
        return { v: 1, sessionId: _s, changes: [] };
      },
      async removeSessionArtifact(_s: string, _id: string, clientId?: string) {
        seen.push(['remove', clientId]);
        return { v: 1, sessionId: _s, changes: [] };
      },
      async capabilities() {
        return { workspaceCwd: cwd };
      },
      async health() {
        return { status: 'ok' };
      },
    } as unknown as DaemonClient;
  }

  function makePool(stamps: Array<string | undefined>) {
    const seen: Array<[string, string | undefined]> = [];
    const spawned: PooledDaemonSpawn[] = [];
    const next = () => stamps.shift();
    const p = new DaemonPool({
      defaultDaemon: fakeClient('/home', seen, next),
      defaultWorkspaceCwd: '/home',
      deathProbeDelayMs: 0,
      spawn: async (cwd) => {
        const sp: PooledDaemonSpawn = {
          client: fakeClient(cwd, seen, next),
          stop: async () => {},
          workspaceCwd: cwd,
        };
        spawned.push(sp);
        return sp;
      },
    });
    return { p, seen };
  }

  it('sends the stamped id on add and remove, a caller id wins, and an unstamped session sends none', async () => {
    const { p, seen } = makePool(['client_a', undefined]);
    const s = await p.createOrAttachSession({ workspaceCwd: '/w' });
    await p.addSessionArtifact(s.sessionId, { title: 't', workspacePath: 'a' });
    await p.removeSessionArtifact(s.sessionId, 'art');
    await p.addSessionArtifact(s.sessionId, { title: 't', workspacePath: 'a' }, 'mine');
    const t = await p.createOrAttachSession({ workspaceCwd: '/v' });
    await p.removeSessionArtifact(t.sessionId, 'art');
    expect(seen).toEqual([
      ['add', 'client_a'],
      ['remove', 'client_a'],
      ['add', 'mine'],
      ['remove', undefined],
    ]);
    await p.stopAll();
  });
});

describe('the #128 artifact routes as the gateway mounts them', () => {
  async function bootGateway(): Promise<{ url: string; store: TokenStore }> {
    stub = await startStubDaemon();
    tmp = mkdtempSync(join(tmpdir(), 'rc-artifacts-'));
    const store = await TokenStore.open(join(tmp, 'tokens.json'));
    const { app } = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(tmp, 'audit.log'),
    });
    return { url: await listen(app), store };
  }

  it('a token with write records and drops an artifact', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([WRITE], 'phone');
    const added = await send(URL_(url), 'POST', FILE, token);
    expect(added.status).toBe(200);
    const id = (added.body['changes'] as Array<{ artifactId: string }>)[0]!.artifactId;
    const removed = await send(URL_(url, `/${id}`), 'DELETE', undefined, token);
    expect(removed.status).toBe(200);
  });

  it('a read-only token reads the list and is refused the add and the remove', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([SESSION_READ], 'reader');
    const list = await send(URL_(url), 'GET', undefined, token);
    expect(list.status).toBe(200);
    const add = await send(URL_(url), 'POST', FILE, token);
    expect(add.status).toBe(403);
    expect(add.body['code']).toBe('scope_required');
    const del = await send(URL_(url, '/art-web-1'), 'DELETE', undefined, token);
    expect(del.status).toBe(403);
    expect(stub?.artifactMutationCalls).toEqual([]);
  });

  it('a share token, locked to this session or another, is refused both writes, and its body is never read', async () => {
    const { url, store } = await bootGateway();
    for (const lock of [SID, OTHER_SID]) {
      const share = await store.issueShare({
        scopes: [SHARE, SESSION_READ],
        label: 'guest',
        sessionLockId: lock,
        ttlSec: 3600,
        parentId: 'owner',
      });
      // A body that would be a 400 for anyone who got as far as reading it.
      const add = await send(URL_(url), 'POST', { nonsense: true }, share.token);
      expect(add.status, lock).toBe(403);
      expect(add.body['code']).toBe('scope_required');
      const del = await send(URL_(url, '/art-web-1'), 'DELETE', undefined, share.token);
      expect(del.status, lock).toBe(403);
    }
    expect(stub?.artifactMutationCalls).toEqual([]);
  });

  it('the capability flag says the routes are mounted', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([SESSION_READ], 'reader');
    const res = await fetch(`${url}/rc/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as {
      remoteControl: { sessionArtifactWrites?: unknown };
    };
    expect(body.remoteControl.sessionArtifactWrites).toBe(true);
  });
});
