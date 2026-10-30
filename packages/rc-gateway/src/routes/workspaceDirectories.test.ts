/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #123, the directory slice. Same shape as workspaceFileWrites.test.ts: the
 * real gateway app over a real `DaemonClient` against the stub, so the scope
 * check and the SDK's own request building are in the path and the D61 trap
 * (a name the bare client lacks) would show as a 502 here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { DaemonPool, type SessionDaemon } from '../daemonPool.js';
import { SHARE, SESSION_READ, APPROVE } from '../scopes.js';

let server: Server | undefined;
let runtimeBase: string;
let auditPath: string;
let stub: StubDaemon | undefined;

let storeDir: string;
let store: TokenStore;
const tokens = {
  readToken: '',
  approveToken: '',
  writeToken: '',
  ownerToken: '',
  shareToken: '',
};

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'rc-ws-dir-store-'));
  store = await TokenStore.open(join(storeDir, 'tokens.json'));
  tokens.readToken = (await store.issue([SESSION_READ], 'r')).token;
  tokens.approveToken = (await store.issue([SESSION_READ, APPROVE], 'a')).token;
  tokens.writeToken = (await store.issue(['write'], 'w')).token;
  tokens.ownerToken = (await store.issue(['owner'], 'o')).token;
  tokens.shareToken = (
    await store.issueShare({
      scopes: [SHARE, SESSION_READ, APPROVE],
      label: 'guest',
      sessionLockId: 's1',
      ttlSec: 3600,
      parentId: 'owner-1',
    })
  ).token;
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

beforeEach(async () => {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-ws-dir-'));
  auditPath = join(runtimeBase, 'audit.log');
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  await rm(runtimeBase, { recursive: true, force: true });
});

async function setup(
  stubOpts: Parameters<typeof startStubDaemon>[0] = {},
  gatewayOpts: { daemon?: SessionDaemon } = {},
) {
  stub = await startStubDaemon(stubOpts);
  const daemon =
    gatewayOpts.daemon ?? new DaemonClient({ baseUrl: stub.baseUrl });
  const gw = createGatewayApp({
    daemon,
    store,
    pairing: new PairingService(),
    auditPath,
  });
  server = await new Promise((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server!.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, stub: stub!, ...tokens };
}

function postJson(base: string, path: string, token: string, body: unknown) {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function list(base: string, token: string, path: string) {
  const res = await fetch(
    `${base}/rc/workspace/list?path=${encodeURIComponent(path)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function auditActions(): Promise<Array<Record<string, unknown>>> {
  await new Promise((r) => setTimeout(r, 50));
  const dateKey = new Date().toISOString().slice(0, 10);
  const text = await readFile(
    join(runtimeBase, `audit-${dateKey}.log`),
    'utf-8',
  ).catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const DIR_ROUTES = ['create', 'delete'] as const;

describe('scope: both directory routes refuse a token without write', () => {
  for (const name of DIR_ROUTES) {
    const url = `/rc/workspace/directory/${name}`;
    it(`${name}: a share token gets 403 and the daemon is never asked`, async () => {
      const ctx = await setup();
      const res = await postJson(ctx.baseUrl, url, ctx.shareToken, { path: 'src' });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('scope_required');
      expect(ctx.stub.lastDirectoryCreate).toBeUndefined();
      expect(ctx.stub.lastDirectoryDelete).toBeUndefined();
    });

    it(`${name}: a session:read token and a read+approve token get 403`, async () => {
      const ctx = await setup();
      for (const t of [ctx.readToken, ctx.approveToken]) {
        const res = await postJson(ctx.baseUrl, url, t, { path: 'src' });
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('scope_required');
      }
      expect(ctx.stub.lastDirectoryCreate).toBeUndefined();
      expect(ctx.stub.lastDirectoryDelete).toBeUndefined();
    });
  }

  it('the refusal is audited as scope_denied with the write scope named', async () => {
    const ctx = await setup();
    await postJson(ctx.baseUrl, '/rc/workspace/directory/delete', ctx.shareToken, {
      path: 'src',
    });
    const denied = (await auditActions()).find((r) => r['action'] === 'scope_denied');
    expect(denied).toBeDefined();
    expect((denied!['detail'] as Record<string, unknown>)['required']).toBe('write');
  });
});

describe('POST /rc/workspace/directory/create', () => {
  it("addresses the daemon's primary workspace and the new folder lists", async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/directory/create',
      ctx.writeToken,
      { path: 'docs' },
    );
    expect(res.status).toBe(204);
    expect(ctx.stub.lastDirectoryCreate).toEqual({
      workspace: '/stub/workspace',
      path: 'docs',
    });
    const root = await list(ctx.baseUrl, ctx.writeToken, '.');
    expect(root.body['entries']).toContainEqual({
      name: 'docs',
      kind: 'directory',
      ignored: false,
    });
    // And it is a folder: it lists empty.
    expect((await list(ctx.baseUrl, ctx.writeToken, 'docs')).body['entries']).toEqual([]);
  });

  it('a name that is taken relays 409 file_already_exists', async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/directory/create',
      ctx.writeToken,
      { path: 'src' },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('file_already_exists');
    expect(body.error).toBe('path already exists');
  });

  it('a missing parent relays the daemon 404 path_not_found', async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/directory/create',
      ctx.writeToken,
      { path: 'nowhere/inside' },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('path_not_found');
  });

  it('refuses an empty or non-string path, and a bad workspace target, before the daemon', async () => {
    const ctx = await setup();
    for (const body of [{}, { path: '' }, { path: ['a'] }]) {
      const res = await postJson(
        ctx.baseUrl,
        '/rc/workspace/directory/create',
        ctx.writeToken,
        body,
      );
      expect(res.status).toBe(400);
    }
    const bad = await postJson(
      ctx.baseUrl,
      '/rc/workspace/directory/create',
      ctx.writeToken,
      { path: 'a', workspace: 5 },
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_workspace');
    expect(ctx.stub.lastDirectoryCreate).toBeUndefined();
  });

  it('passes a suspicious path through for the daemon to judge, and relays its refusal', async () => {
    const ctx = await setup({
      directoryCreateStatus: 400,
      directoryCreateErrorBody: {
        errorKind: 'path_outside_workspace',
        error: 'path contains a suspicious pattern',
        status: 400,
      },
    });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/directory/create',
      ctx.writeToken,
      { path: '../escape' },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('path_outside_workspace');
    expect(ctx.stub.lastDirectoryCreate?.path).toBe('../escape');
  });

  it('a daemon without the route (404, no envelope) is 502 file_writes_unsupported', async () => {
    const ctx = await setup({ directoryCreateStatus: 404, directoryCreateErrorBody: {} });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/directory/create',
      ctx.writeToken,
      { path: 'docs' },
    );
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('file_writes_unsupported');
  });

  it('is audited without the path', async () => {
    const ctx = await setup();
    await postJson(ctx.baseUrl, '/rc/workspace/directory/create', ctx.ownerToken, {
      path: 'private-name',
    });
    const row = (await auditActions()).find(
      (r) => r['action'] === 'workspace_directory_created',
    );
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('private-name');
  });
});

describe('POST /rc/workspace/directory/delete', () => {
  it('removes the folder and everything in it, and the listing no longer shows it', async () => {
    const ctx = await setup({
      workspaceTree: { 'old/a.txt': 10, 'old/inner/b.txt': 20, 'keep/c.txt': 5 },
    });
    expect((await list(ctx.baseUrl, ctx.writeToken, 'old')).body['entries']).toHaveLength(2);
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/directory/delete',
      ctx.writeToken,
      { path: 'old' },
    );
    expect(res.status).toBe(204);
    expect(ctx.stub.lastDirectoryDelete).toEqual({
      workspace: '/stub/workspace',
      path: 'old',
    });
    const root = await list(ctx.baseUrl, ctx.writeToken, '.');
    const names = (root.body['entries'] as Array<{ name: string }>).map((e) => e.name);
    expect(names).not.toContain('old');
    expect(names).toContain('keep');
    expect(ctx.stub.workspaceTree.has('old/inner/b.txt')).toBe(false);
    expect(ctx.stub.workspaceTree.has('keep/c.txt')).toBe(true);
  });

  it('relays the daemon refusal of a file (only directories), and a missing folder 404', async () => {
    const ctx = await setup({ workspaceTree: { 'old/a.txt': 10 } });
    const file = await postJson(
      ctx.baseUrl,
      '/rc/workspace/directory/delete',
      ctx.writeToken,
      { path: 'old/a.txt' },
    );
    expect(file.status).toBe(400);
    expect((await file.json()).error).toBe('Only directories can be deleted');
    const gone = await postJson(
      ctx.baseUrl,
      '/rc/workspace/directory/delete',
      ctx.writeToken,
      { path: 'never' },
    );
    expect(gone.status).toBe(404);
    expect((await gone.json()).code).toBe('path_not_found');
  });

  it('relays the daemon refusal of a workspace root', async () => {
    const ctx = await setup({
      directoryDeleteStatus: 400,
      directoryDeleteErrorBody: {
        errorKind: 'path_outside_workspace',
        error: 'Cannot delete a workspace root',
        status: 400,
      },
    });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/directory/delete',
      ctx.writeToken,
      { path: '.' },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Cannot delete a workspace root');
  });

  it('refuses an empty or non-string path with 400 before the daemon', async () => {
    const ctx = await setup();
    for (const body of [{}, { path: '' }, { path: 3 }]) {
      const res = await postJson(
        ctx.baseUrl,
        '/rc/workspace/directory/delete',
        ctx.writeToken,
        body,
      );
      expect(res.status).toBe(400);
    }
    expect(ctx.stub.lastDirectoryDelete).toBeUndefined();
  });

  it('is audited without the path', async () => {
    const ctx = await setup({ workspaceTree: { 'secret-dir/a': 1 } });
    await postJson(ctx.baseUrl, '/rc/workspace/directory/delete', ctx.ownerToken, {
      path: 'secret-dir',
    });
    const row = (await auditActions()).find(
      (r) => r['action'] === 'workspace_directory_deleted',
    );
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('secret');
  });
});

describe('the pool carries both under the SDK names (D61)', () => {
  it('a bare DaemonClient has neither name, the qualified client has both', () => {
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:1' });
    for (const name of ['createWorkspaceDirectory', 'deleteWorkspaceDirectory']) {
      expect(typeof (client as unknown as Record<string, unknown>)[name]).toBe(
        'undefined',
      );
    }
    const q = client.workspaceByCwd('/x');
    expect(typeof q.createWorkspaceDirectory).toBe('function');
    expect(typeof q.deleteWorkspaceDirectory).toBe('function');
  });

  it('a DaemonPool over the stub creates and deletes through the qualified routes', async () => {
    stub = await startStubDaemon();
    const pool = new DaemonPool({
      defaultDaemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      defaultWorkspaceCwd: '/stub/workspace',
      spawn: async () => {
        throw new Error('no spawn in this test');
      },
    });
    try {
      await pool.createWorkspaceDirectory('pooled');
      expect(stub.lastDirectoryCreate).toEqual({
        workspace: '/stub/workspace',
        path: 'pooled',
      });
      await pool.deleteWorkspaceDirectory('pooled');
      expect(stub.lastDirectoryDelete).toEqual({
        workspace: '/stub/workspace',
        path: 'pooled',
      });
    } finally {
      await pool.stopAll();
    }
  });

  it('through the gateway on a pool, both routes reach the daemon', async () => {
    const inner = await startStubDaemon();
    const pool = new DaemonPool({
      defaultDaemon: new DaemonClient({ baseUrl: inner.baseUrl }),
      defaultWorkspaceCwd: '/stub/workspace',
      spawn: async () => {
        throw new Error('no spawn in this test');
      },
    });
    try {
      const ctx = await setup({}, { daemon: pool });
      const made = await postJson(
        ctx.baseUrl,
        '/rc/workspace/directory/create',
        ctx.writeToken,
        { path: 'viapool' },
      );
      expect(made.status).toBe(204);
      expect(inner.lastDirectoryCreate?.path).toBe('viapool');
      const gone = await postJson(
        ctx.baseUrl,
        '/rc/workspace/directory/delete',
        ctx.writeToken,
        { path: 'viapool' },
      );
      expect(gone.status).toBe(204);
      expect(inner.lastDirectoryDelete?.path).toBe('viapool');
    } finally {
      await pool.stopAll();
      await inner.close();
    }
  });
});

describe('/rc/capabilities', () => {
  it('reports workspaceDirectoryWrites beside the file writes flag', async () => {
    const ctx = await setup();
    const asWriter = await (
      await fetch(`${ctx.baseUrl}/rc/capabilities`, {
        headers: { Authorization: `Bearer ${ctx.writeToken}` },
      })
    ).json();
    expect(asWriter.remoteControl.workspaceDirectoryWrites).toBe(true);
    expect(asWriter.remoteControl.workspaceFileWrites).toBe(true);
  });
});
