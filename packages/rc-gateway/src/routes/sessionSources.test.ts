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
  type SessionDaemon,
} from '../daemonPool.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { createGatewayApp } from '../server.js';
import { SESSION_READ, SHARE, WRITE } from '../scopes.js';
import {
  createSessionSourceAddRoute,
  createSessionSourceRemoveRoute,
  createSessionSourcesRoute,
} from './sessionSources.js';

const SID = '11111111-1111-1111-1111-111111111111';

/** Two sources as the daemon stores them, newest first. */
const SOURCES = [
  {
    title: 'The spec',
    locator: { type: 'url', url: 'https://example.test/spec' },
    id: 'b'.repeat(64),
    kind: 'link',
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T10:00:00.000Z',
  },
  {
    title: 'server.ts',
    locator: { type: 'workspace_file', workspacePath: 'src/server.ts' },
    id: 'a'.repeat(64),
    kind: 'file',
    workspaceCwd: '/home/u/proj',
    createdAt: '2026-10-29T09:00:00.000Z',
    updatedAt: '2026-10-29T09:00:00.000Z',
  },
];

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

async function mountRoutes(
  daemon: SessionDaemon,
  rcClient?: Record<string, unknown>,
): Promise<string> {
  const app = express();
  app.use(express.json());
  if (rcClient) {
    app.use((req, _res, next) => {
      (req as unknown as { rcClient: unknown }).rcClient = rcClient;
      next();
    });
  }
  app.get('/session/:id/sources', createSessionSourcesRoute(daemon));
  app.post('/session/:id/sources', createSessionSourceAddRoute(daemon));
  app.delete(
    '/session/:id/sources/:sourceId',
    createSessionSourceRemoveRoute(daemon),
  );
  return listen(app);
}

/** Over a REAL DaemonClient (spec ledger D61). */
async function mountReal(
  opts: StubDaemonOptions = {},
  rcClient?: Record<string, unknown>,
): Promise<string> {
  stub = await startStubDaemon(opts);
  return mountRoutes(
    new DaemonClient({ baseUrl: stub.baseUrl }) as unknown as SessionDaemon,
    rcClient,
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
    listSessionSources: fail,
    upsertSessionSource: fail,
    removeSessionSource: fail,
  } as unknown as SessionDaemon;
}

describe('GET /session/:id/sources (#110)', () => {
  it('relays the list verbatim through the SDK', async () => {
    const base = await mountReal({ sources: { [SID]: SOURCES } });
    const out = await send(`${base}/session/${SID}/sources`, 'GET');
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ revision: 0, sources: SOURCES });
    expect(stub?.sourceCalls.map((c) => [c.method, c.clientId])).toEqual([
      ['GET', undefined],
    ]);
  });

  it("a share guest gets the list without each file's host folder", async () => {
    const base = await mountReal(
      { sources: { [SID]: SOURCES } },
      { id: 'guest', scopes: ['share', 'session:read'], sessionLockId: SID },
    );
    const out = await send(`${base}/session/${SID}/sources`, 'GET');
    expect(out.status).toBe(200);
    const sources = out.body['sources'] as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(2);
    expect(JSON.stringify(out.body)).not.toContain('/home/u/proj');
    expect(sources[1]).toEqual(
      Object.fromEntries(
        Object.entries(SOURCES[1]!).filter(([k]) => k !== 'workspaceCwd'),
      ),
    );
  });

  it('a daemon without the routes is named, not read as a missing session', async () => {
    const base = await mountRoutes(
      throwing(new DaemonHttpError(404, 'Cannot GET /session/x/sources', 'nf')),
    );
    const out = await send(`${base}/session/${SID}/sources`, 'GET');
    expect(out.status).toBe(502);
    expect(out.body['code']).toBe('sources_unsupported');
  });

  it("the daemon's session 404 stays a 404, and a malformed id never reaches it", async () => {
    const base = await mountReal({
      sourcesStatus: 404,
      sourcesErrorBody: { error: 'nope', code: 'session_not_found', sessionId: SID },
    });
    let out = await send(`${base}/session/${SID}/sources`, 'GET');
    expect(out.status).toBe(404);
    expect(out.body['code']).toBe('session_not_found');
    out = await send(`${base}/session/not..a..session/sources`, 'GET');
    expect(out.status).toBe(404);
    expect(stub?.sourceCalls).toHaveLength(1);
  });

  it('a stored list the daemon cannot read is a 503 that says so', async () => {
    const base = await mountReal({
      sourcesStatus: 503,
      sourcesErrorBody: {
        error: 'Stored sources are unavailable',
        code: 'source_persistence_unavailable',
      },
    });
    const out = await send(`${base}/session/${SID}/sources`, 'GET');
    expect(out.status).toBe(503);
    expect(out.body['code']).toBe('source_persistence_unavailable');
  });
});

describe('POST /session/:id/sources (#110)', () => {
  it('adds a workspace file and a link, and adding the same file again retitles it', async () => {
    const base = await mountReal();
    const file = await send(`${base}/session/${SID}/sources`, 'POST', {
      title: 'server.ts',
      locator: { type: 'workspace_file', workspacePath: 'src/server.ts' },
    });
    expect(file.status).toBe(200);
    expect(file.body['change']).toBe('created');
    expect(file.body['source']).toMatchObject({
      kind: 'file',
      title: 'server.ts',
      locator: { type: 'workspace_file', workspacePath: 'src/server.ts' },
    });
    const link = await send(`${base}/session/${SID}/sources`, 'POST', {
      title: 'Docs',
      description: 'the API page',
      locator: { type: 'url', url: 'https://example.test/docs' },
    });
    expect(link.body['source']).toMatchObject({ kind: 'link', description: 'the API page' });
    const again = await send(`${base}/session/${SID}/sources`, 'POST', {
      title: 'The server',
      locator: { type: 'workspace_file', workspacePath: 'src/server.ts' },
    });
    expect(again.body['change']).toBe('updated');
    const list = await send(`${base}/session/${SID}/sources`, 'GET');
    expect((list.body['sources'] as unknown[]).length).toBe(2);
  });

  it('refuses an unknown field, a bad locator and every oversize field without asking the daemon', async () => {
    const base = await mountReal();
    const cases: unknown[] = [
      [],
      { title: 'x', locator: { type: 'url', url: 'https://a.test/' }, extra: 1 },
      { title: '', locator: { type: 'url', url: 'https://a.test/' } },
      { title: 'x'.repeat(201), locator: { type: 'url', url: 'https://a.test/' } },
      { title: 'x', description: 'd'.repeat(1001), locator: { type: 'url', url: 'https://a.test/' } },
      { title: 'x', locator: 'https://a.test/' },
      { title: 'x', locator: { type: 'ftp', url: 'ftp://a.test/' } },
      { title: 'x', locator: { type: 'url', url: 'https://a.test/', workspacePath: 'a' } },
      { title: 'x', locator: { type: 'url', url: 'h'.repeat(2049) } },
      { title: 'x', locator: { type: 'workspace_file', workspacePath: 'p'.repeat(501) } },
      { title: 'x', locator: { type: 'attachment', attachmentId: '' } },
    ];
    for (const body of cases) {
      const out = await send(`${base}/session/${SID}/sources`, 'POST', body);
      expect(out.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(out.body['code']).toBe('invalid_source');
    }
    expect(stub?.sourceCalls).toEqual([]);
  });

  it("relays the daemon's validator message for what only the daemon checks", async () => {
    const base = await mountReal();
    for (const [locator, message] of [
      [{ type: 'workspace_file', workspacePath: '/etc/passwd' }, 'Workspace path must be relative'],
      [{ type: 'workspace_file', workspacePath: '../outside' }, 'Workspace path escapes its root'],
      [{ type: 'url', url: 'https://u:p@example.test/' }, 'Source URL must be HTTP(S) without credentials'],
    ] as const) {
      const out = await send(`${base}/session/${SID}/sources`, 'POST', {
        title: 'x',
        locator,
      });
      expect(out.status).toBe(400);
      expect(out.body).toEqual({ error: message, code: 'invalid_source' });
    }
  });

  it('the source limit and an unknown attachment keep their codes', async () => {
    let base = await mountReal({
      sourcesStatus: 409,
      sourcesErrorBody: {
        error: 'A session can contain at most 200 sources',
        code: 'source_limit_reached',
      },
    });
    let out = await send(`${base}/session/${SID}/sources`, 'POST', {
      title: 'x',
      locator: { type: 'url', url: 'https://a.test/' },
    });
    expect(out.status).toBe(409);
    expect(out.body['code']).toBe('source_limit_reached');
    await new Promise<void>((r) => gateway!.close(() => r()));
    base = await mountRoutes(
      throwing(
        new DaemonHttpError(
          404,
          { error: 'Session attachment not found', code: 'source_attachment_not_found' },
          'nf',
        ),
      ),
    );
    out = await send(`${base}/session/${SID}/sources`, 'POST', {
      title: 'x',
      locator: { type: 'attachment', attachmentId: 'att-1' },
    });
    expect(out.status).toBe(404);
    expect(out.body['code']).toBe('source_attachment_not_found');
  });

  it('a session the pool does not hold is 404; anything else is 502 without the error text', async () => {
    let base = await mountRoutes(throwing(new UnknownSessionError(SID)));
    let out = await send(`${base}/session/${SID}/sources`, 'POST', {
      title: 'x',
      locator: { type: 'url', url: 'https://a.test/' },
    });
    expect(out.status).toBe(404);
    await new Promise<void>((r) => gateway!.close(() => r()));
    base = await mountRoutes(throwing(new Error('ECONNRESET /home/u/x')));
    out = await send(`${base}/session/${SID}/sources`, 'POST', {
      title: 'x',
      locator: { type: 'url', url: 'https://a.test/' },
    });
    expect(out.status).toBe(502);
    expect(JSON.stringify(out.body)).not.toContain('/home/u');
  });
});

describe('DELETE /session/:id/sources/:sourceId (#110)', () => {
  it('removes one, and a second remove is removed:false at 200', async () => {
    const base = await mountReal({ sources: { [SID]: SOURCES } });
    const id = SOURCES[1]!.id;
    let out = await send(`${base}/session/${SID}/sources/${id}`, 'DELETE');
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ revision: 1, removed: true });
    out = await send(`${base}/session/${SID}/sources/${id}`, 'DELETE');
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ revision: 1, removed: false });
    const list = await send(`${base}/session/${SID}/sources`, 'GET');
    expect((list.body['sources'] as Array<{ id: string }>).map((s) => s.id)).toEqual([
      SOURCES[0]!.id,
    ]);
  });

  it('refuses something that is not a source id without asking the daemon', async () => {
    const base = await mountReal();
    const out = await send(
      `${base}/session/${SID}/sources/${encodeURIComponent('a b')}`,
      'DELETE',
    );
    expect(out.status).toBe(400);
    expect(out.body['code']).toBe('invalid_source_id');
    expect(stub?.sourceCalls).toEqual([]);
  });
});

describe('the client id the daemon requires for a source mutation (#110)', () => {
  /** The gateway over a real pool whose daemon stamps and enforces ids. */
  async function bootPooled(): Promise<{ url: string; store: TokenStore }> {
    // The resume route stats the folder it is given, so the default
    // workspace is a real one: the test's own temporary folder.
    tmp = mkdtempSync(join(tmpdir(), 'rc-sources-'));
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
    const resumed = await send(
      `${url}/session/${SID}/resume`,
      'POST',
      { cwd: tmp },
      token,
    );
    expect(resumed.status).toBe(200);
    const added = await send(
      `${url}/session/${SID}/sources`,
      'POST',
      { title: 'Docs', locator: { type: 'url', url: 'https://example.test/' } },
      token,
    );
    expect(added.status).toBe(200);
    const id = (added.body['source'] as { id: string }).id;
    const removed = await send(
      `${url}/session/${SID}/sources/${id}`,
      'DELETE',
      undefined,
      token,
    );
    expect(removed.body['removed']).toBe(true);
    const listed = await send(`${url}/session/${SID}/sources`, 'GET', undefined, token);
    expect(listed.status).toBe(200);
    expect(stub?.sourceCalls.map((c) => [c.method, c.clientId])).toEqual([
      ['POST', 'client_stub-1'],
      ['DELETE', 'client_stub-1'],
      ['GET', undefined],
    ]);
  });

  it('without a bound id the refusal says to open the conversation again, never the id', async () => {
    for (const body of [
      { error: 'Source mutations require a session-bound client id', code: 'client_id_required' },
      { error: 'Invalid client id "client_x" for session s', code: 'invalid_client_id', clientId: 'client_x' },
    ]) {
      const base = await mountRoutes(
        throwing(new DaemonHttpError(body.code === 'client_id_required' ? 403 : 400, body, 'r')),
      );
      const out = await send(`${base}/session/${SID}/sources`, 'POST', {
        title: 'x',
        locator: { type: 'url', url: 'https://a.test/' },
      });
      expect(out.status).toBe(409);
      expect(out.body['code']).toBe('client_not_bound');
      expect(JSON.stringify(out.body)).not.toContain('client_x');
      await new Promise<void>((r) => gateway!.close(() => r()));
      gateway = undefined;
    }
  });
});

describe('the #110 sources routes as the gateway mounts them', () => {
  async function bootGateway(): Promise<{ url: string; store: TokenStore }> {
    stub = await startStubDaemon({ sources: { [SID]: SOURCES } });
    tmp = mkdtempSync(join(tmpdir(), 'rc-sources-'));
    const store = await TokenStore.open(join(tmp, 'tokens.json'));
    const { app } = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(tmp, 'audit.log'),
    });
    return { url: await listen(app), store };
  }

  it('a read-only token reads the list and is refused the add and the remove', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([SESSION_READ], 'reader');
    const list = await send(`${url}/session/${SID}/sources`, 'GET', undefined, token);
    expect(list.status).toBe(200);
    const add = await send(
      `${url}/session/${SID}/sources`,
      'POST',
      { title: 'x', locator: { type: 'url', url: 'https://a.test/' } },
      token,
    );
    expect(add.status).toBe(403);
    const del = await send(
      `${url}/session/${SID}/sources/${SOURCES[0]!.id}`,
      'DELETE',
      undefined,
      token,
    );
    expect(del.status).toBe(403);
    expect(stub?.sourceCalls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a share locked to this session reads the list, without host folders, and writes nothing', async () => {
    const { url, store } = await bootGateway();
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: SID,
      ttlSec: 3600,
      parentId: 'owner',
    });
    const list = await send(`${url}/session/${SID}/sources`, 'GET', undefined, share.token);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('/home/u/proj');
    const add = await send(
      `${url}/session/${SID}/sources`,
      'POST',
      { title: 'x', locator: { type: 'url', url: 'https://a.test/' } },
      share.token,
    );
    expect(add.status).toBe(403);
  });

  it('a share locked to another session cannot read this one', async () => {
    const { url, store } = await bootGateway();
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: '22222222-2222-2222-2222-222222222222',
      ttlSec: 3600,
      parentId: 'owner',
    });
    const list = await send(`${url}/session/${SID}/sources`, 'GET', undefined, share.token);
    expect(list.status).toBe(403);
    expect(stub?.sourceCalls).toEqual([]);
  });

  it('the capability flag says the routes are mounted', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([SESSION_READ], 'reader');
    const res = await fetch(`${url}/rc/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as {
      remoteControl: { sessionSources?: unknown };
    };
    expect(body.remoteControl.sessionSources).toBe(true);
  });
});
