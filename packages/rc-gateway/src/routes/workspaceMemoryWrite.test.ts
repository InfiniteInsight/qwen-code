/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #123, the memory write and the workspace reload. Every relay test runs the real gateway app
 * (`createGatewayApp`) over a real `DaemonClient` against the stub, so the
 * scope check, the body reader and the SDK's own request building are all in
 * the path, and the pool-method-name trap D61 records (a name the bare client
 * lacks is `undefined` at runtime while tsc stays clean) would show up as a
 * 502 here rather than in production.
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

// One token store for the file: issuing is an argon2id hash per token, and
// minting five per test made this file take minutes. Each test still gets
// its own gateway, stub and audit directory.
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
  storeDir = await mkdtemp(join(tmpdir(), 'rc-ws-mem-store-'));
  store = await TokenStore.open(join(storeDir, 'tokens.json'));
  tokens.readToken = (await store.issue([SESSION_READ], 'r')).token;
  tokens.approveToken = (await store.issue([SESSION_READ, APPROVE], 'a')).token;
  tokens.writeToken = (await store.issue(['write'], 'w')).token;
  tokens.ownerToken = (await store.issue(['owner'], 'o')).token;
  // A share token exactly as /rc/share mints one: the share marker, the read
  // scope and (when the owner allows votes) approve. Session-locked and
  // TTL-bounded, and never write.
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
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-ws-mem-'));
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
  gatewayOpts: { maxAttachmentBytes?: number; daemon?: SessionDaemon } = {},
) {
  stub = await startStubDaemon(stubOpts);
  const daemon =
    gatewayOpts.daemon ?? new DaemonClient({ baseUrl: stub.baseUrl });
  const { readToken, approveToken, writeToken, ownerToken, shareToken } =
    tokens;
  const gw = createGatewayApp({
    daemon,
    store,
    pairing: new PairingService(),
    auditPath,
    ...(gatewayOpts.maxAttachmentBytes !== undefined
      ? { maxAttachmentBytes: gatewayOpts.maxAttachmentBytes }
      : {}),
  });
  server = await new Promise((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server!.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stub: stub!,
    readToken,
    approveToken,
    writeToken,
    ownerToken,
    shareToken,
  };
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

async function auditActions(): Promise<Array<Record<string, unknown>>> {
  // Rows are appended without awaiting; give the recorder a beat. The log
  // rotates daily, so the file is `audit-<date>.log` beside `auditPath`.
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


const WRITE_CALLS: Array<
  [string, (ctx: Awaited<ReturnType<typeof setup>>, token: string) => Promise<Response>]
> = [
  [
    'memory write',
    (ctx, t) =>
      postJson(ctx.baseUrl, '/rc/workspace/memory', t, {
        scope: 'workspace',
        content: 'x',
        mode: 'append',
      }),
  ],
  [
    'reload',
    (ctx, t) => postJson(ctx.baseUrl, '/rc/workspace/reload', t, {}),
  ],
];

describe('scope: the memory write and the reload refuse a token without write', () => {
  for (const [name, call] of WRITE_CALLS) {
    it(`${name}: a share token gets 403 and the daemon is never asked`, async () => {
      const ctx = await setup();
      const res = await call(ctx, ctx.shareToken);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('scope_required');
      expect(ctx.stub.memoryWrites).toEqual([]);
      expect(ctx.stub.reloadCount).toBe(0);
    });

    it(`${name}: a session:read token and a read+approve token get 403`, async () => {
      const ctx = await setup();
      for (const t of [ctx.readToken, ctx.approveToken]) {
        const res = await call(ctx, t);
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('scope_required');
      }
      expect(ctx.stub.memoryWrites).toEqual([]);
      expect(ctx.stub.reloadCount).toBe(0);
    });

    it(`${name}: a write token and an owner token pass the scope check`, async () => {
      const ctx = await setup();
      for (const t of [ctx.writeToken, ctx.ownerToken]) {
        const res = await call(ctx, t);
        expect(res.status).toBe(200);
      }
    });
  }

  it('a share token body is never parsed: an oversize memory body is still a 403, not a 413', async () => {
    const ctx = await setup({}, { maxAttachmentBytes: 16 });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/memory',
      ctx.shareToken,
      { scope: 'workspace', content: 'x'.repeat(4096), mode: 'replace' },
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /rc/workspace/memory', () => {
  it('replaces the workspace file: 200 with the daemon result, and a read-back shows the new text', async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/memory',
      ctx.writeToken,
      { scope: 'workspace', content: '# memory\nuse tabs\n', mode: 'replace' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      filePath: '/proj/QWEN.md',
      bytesWritten: 18,
      mode: 'replace',
      changed: true,
    });
    expect(ctx.stub.memoryWrites).toEqual([
      { scope: 'workspace', content: '# memory\nuse tabs\n', mode: 'replace' },
    ]);
    const read = await fetch(`${ctx.baseUrl}/rc/workspace/file?path=QWEN.md`, {
      headers: { Authorization: `Bearer ${ctx.writeToken}` },
    });
    expect((await read.json()).content).toBe('# memory\nuse tabs\n');
  });

  it('appends: the text goes to the end of what is there', async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/memory',
      ctx.writeToken,
      { scope: 'workspace', content: 'and this\n', mode: 'append' },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('append');
    expect(ctx.stub.workspaceFiles.get('QWEN.md')).toBe('# hello\nand this\n');
  });

  it('a whitespace-only append is the daemon 200 with changed false, and leaves no audit row', async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/memory',
      ctx.writeToken,
      { scope: 'workspace', content: '  \n', mode: 'append' },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(false);
    expect(body.bytesWritten).toBe(0);
    const rows = await auditActions();
    expect(rows.find((r) => r['action'] === 'workspace_memory_written')).toBeUndefined();
  });

  it('the workspace target picks the daemon and never reaches it', async () => {
    const ctx = await setup();
    await postJson(ctx.baseUrl, '/rc/workspace/memory', ctx.writeToken, {
      scope: 'workspace',
      content: 'a',
      mode: 'append',
      workspace: '',
    });
    expect(ctx.stub.memoryWrites).toEqual([
      { scope: 'workspace', content: 'a', mode: 'append' },
    ]);
  });

  it('refuses the global scope with 400 global_scope_not_supported, before the daemon is asked', async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/memory',
      ctx.ownerToken,
      { scope: 'global', content: 'x', mode: 'replace' },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('global_scope_not_supported');
    expect(ctx.stub.memoryWrites).toEqual([]);
  });

  it('refuses a request that cannot be one with 400 invalid_body, before the daemon is asked', async () => {
    const ctx = await setup();
    const bad: unknown[] = [
      { content: 'x', mode: 'append' },
      { scope: 'project', content: 'x', mode: 'append' },
      { scope: 'workspace', mode: 'append' },
      { scope: 'workspace', content: 7, mode: 'append' },
      { scope: 'workspace', content: 'x' },
      { scope: 'workspace', content: 'x', mode: 'create' },
      { scope: 'workspace', content: 'x', mode: 'append', workspace: 5 },
    ];
    for (const b of bad) {
      const res = await postJson(
        ctx.baseUrl,
        '/rc/workspace/memory',
        ctx.writeToken,
        b,
      );
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
    expect(ctx.stub.memoryWrites).toEqual([]);
  });

  it('a body above the #196 limit is refused 413 file_too_large with maxBytes, unread by the daemon', async () => {
    const ctx = await setup({}, { maxAttachmentBytes: 1024 });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/memory',
      ctx.writeToken,
      { scope: 'workspace', content: 'x'.repeat(4096), mode: 'replace' },
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe('file_too_large');
    expect(body.maxBytes).toBe(1024);
    expect(ctx.stub.memoryWrites).toEqual([]);
  });

  it('a body between the 100 KB app parser and the limit is accepted', async () => {
    const ctx = await setup({}, { maxAttachmentBytes: 400_000 });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/memory',
      ctx.writeToken,
      { scope: 'workspace', content: 'x'.repeat(200_000), mode: 'replace' },
    );
    expect(res.status).toBe(200);
    expect(ctx.stub.workspaceFiles.get('QWEN.md')?.length).toBe(200_000);
  });

  it("relays the daemon's own refusals with their status, code and words", async () => {
    const cases: Array<{
      status: number;
      body: Record<string, unknown>;
      expectStatus: number;
      code: string;
    }> = [
      {
        status: 400,
        body: { error: '`content` exceeds the 1048576-byte limit', code: 'content_too_large' },
        expectStatus: 400,
        code: 'content_too_large',
      },
      {
        status: 403,
        body: { error: 'Workspace is not trusted.', code: 'untrusted_workspace' },
        expectStatus: 403,
        code: 'untrusted_workspace',
      },
      {
        status: 413,
        body: {
          error: 'Existing memory file exceeds the safe-append cap.',
          code: 'memory_file_too_large',
          scope: 'workspace',
          mode: 'append',
          bytes: 2_000_000,
          limit: 1_048_576,
        },
        expectStatus: 413,
        code: 'memory_file_too_large',
      },
      {
        status: 500,
        body: {
          error: 'Workspace memory write timed out waiting for the per-file lock.',
          code: 'memory_write_timeout',
          scope: 'workspace',
          mode: 'replace',
          timeoutMs: 5000,
        },
        expectStatus: 502,
        code: 'memory_write_timeout',
      },
      {
        status: 500,
        body: { error: 'Failed to write workspace memory', code: 'file_error', osCode: 'EACCES' },
        expectStatus: 502,
        code: 'file_error',
      },
    ];
    for (const c of cases) {
      const ctx = await setup({
        memoryWriteStatus: c.status,
        memoryWriteErrorBody: c.body,
      });
      const res = await postJson(
        ctx.baseUrl,
        '/rc/workspace/memory',
        ctx.writeToken,
        { scope: 'workspace', content: 'x', mode: 'replace' },
      );
      expect(res.status, c.code).toBe(c.expectStatus);
      const got = await res.json();
      expect(got.code).toBe(c.code);
      expect(got.error).toBe(c.body['error']);
      if (typeof c.body['bytes'] === 'number') {
        expect(got.bytes).toBe(c.body['bytes']);
        expect(got.limit).toBe(c.body['limit']);
      }
      if (typeof c.body['timeoutMs'] === 'number') {
        expect(got.timeoutMs).toBe(c.body['timeoutMs']);
      }
      server && (await new Promise<void>((r) => server!.close(() => r())));
      server = undefined;
      await stub!.close();
      stub = undefined;
    }
  });

  it('a daemon without the route (404, no envelope) is 502 memory_write_unsupported', async () => {
    const ctx = await setup({ memoryWriteStatus: 404 });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/memory',
      ctx.writeToken,
      { scope: 'workspace', content: 'x', mode: 'replace' },
    );
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('memory_write_unsupported');
  });

  it('a daemon that rejects the gateway credential is 502 daemon_auth_failed, not a 401 the page would take for its own', async () => {
    const ctx = await setup({
      memoryWriteStatus: 401,
      memoryWriteErrorBody: { error: 'token required', code: 'token_required' },
    });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/memory',
      ctx.writeToken,
      { scope: 'workspace', content: 'x', mode: 'replace' },
    );
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_auth_failed');
  });

  it('a daemon failure with no envelope is 502 daemon_unavailable', async () => {
    const ctx = await setup({ memoryWriteStatus: 500 });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/memory',
      ctx.writeToken,
      { scope: 'workspace', content: 'x', mode: 'replace' },
    );
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('daemon_unavailable');
  });

  it('is audited with the mode and without the content or any path', async () => {
    const ctx = await setup();
    await postJson(ctx.baseUrl, '/rc/workspace/memory', ctx.writeToken, {
      scope: 'workspace',
      content: 'a private rule',
      mode: 'replace',
    });
    const rows = await auditActions();
    const row = rows.find((r) => r['action'] === 'workspace_memory_written');
    expect(row).toBeDefined();
    expect(row!['detail']).toEqual({ mode: 'replace' });
    expect(JSON.stringify(row)).not.toContain('private');
    expect(JSON.stringify(row)).not.toContain('QWEN');
  });
});

describe('POST /rc/workspace/reload', () => {
  it('relays the daemon answer untouched', async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/reload',
      ctx.writeToken,
      {},
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      env: { updatedKeys: ['QWEN_MODEL'], removedKeys: [] },
      changedKeys: ['QWEN_MODEL'],
      childReloaded: true,
      sessionsRefreshed: ['s-1'],
      sessionsSkipped: [],
    });
    expect(ctx.stub.reloadCount).toBe(1);
  });

  it('answers 200 with childError when the daemon did, rather than calling it a failure', async () => {
    const answer = {
      env: { updatedKeys: [], removedKeys: [] },
      changedKeys: [],
      childReloaded: false,
      childError: 'ACP child not running',
    };
    const ctx = await setup({ reloadResult: answer });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/reload',
      ctx.writeToken,
      {},
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
  });

  it('works with no body at all', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/reload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.writeToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('refuses a workspace target that is not a string with 400, before the daemon is asked', async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/reload',
      ctx.writeToken,
      { workspace: 5 },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_workspace');
    expect(ctx.stub.reloadCount).toBe(0);
  });

  it("relays the daemon's refusals: 403 keeps its code, 404 is unsupported, 500 without an envelope is unavailable", async () => {
    let ctx = await setup({
      reloadStatus: 403,
      reloadErrorBody: { error: 'Workspace is not trusted.', code: 'untrusted_workspace' },
    });
    let res = await postJson(ctx.baseUrl, '/rc/workspace/reload', ctx.writeToken, {});
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('untrusted_workspace');

    for (const [status, expectStatus, code] of [
      [404, 502, 'workspace_reload_unsupported'],
      [500, 502, 'daemon_unavailable'],
    ] as const) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
      await stub!.close();
      stub = undefined;
      ctx = await setup({ reloadStatus: status });
      res = await postJson(ctx.baseUrl, '/rc/workspace/reload', ctx.writeToken, {});
      expect(res.status).toBe(expectStatus);
      expect((await res.json()).code).toBe(code);
    }
  });

  it('is audited without anything the daemon answered', async () => {
    const ctx = await setup();
    await postJson(ctx.baseUrl, '/rc/workspace/reload', ctx.writeToken, {});
    const rows = await auditActions();
    const row = rows.find((r) => r['action'] === 'workspace_reloaded');
    expect(row).toBeDefined();
    expect(row!['detail']).toEqual({});
    expect(JSON.stringify(row)).not.toContain('QWEN_MODEL');
  });
});

describe('the pool carries both under the SDK name (D61)', () => {
  it('a DaemonPool over the stub reaches the memory write and the reload', async () => {
    stub = await startStubDaemon();
    const pool = new DaemonPool({
      defaultDaemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      defaultWorkspaceCwd: '/stub/workspace',
      spawn: async () => {
        throw new Error('no spawn in this test');
      },
    });
    try {
      const wrote = await pool.writeWorkspaceMemory({
        scope: 'workspace',
        content: 'one',
        mode: 'replace',
      });
      expect(wrote.ok).toBe(true);
      expect(wrote.changed).toBe(true);
      const reloaded = await pool.reload();
      expect(reloaded.childReloaded).toBe(true);
      expect(stub.reloadCount).toBe(1);
    } finally {
      await pool.stopAll();
    }
  });

  it('a bare DaemonClient has both methods by these names', () => {
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:1' });
    expect(typeof client.writeWorkspaceMemory).toBe('function');
    expect(typeof client.reload).toBe('function');
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
      const w = await postJson(ctx.baseUrl, '/rc/workspace/memory', ctx.writeToken, {
        scope: 'workspace',
        content: 'via pool',
        mode: 'replace',
      });
      expect(w.status).toBe(200);
      const r = await postJson(ctx.baseUrl, '/rc/workspace/reload', ctx.writeToken, {});
      expect(r.status).toBe(200);
      expect(inner.memoryWrites.length).toBe(1);
      expect(inner.reloadCount).toBe(1);
    } finally {
      await pool.stopAll();
      await inner.close();
    }
  });
});

describe('/rc/capabilities', () => {
  it('reports workspaceMemoryWrite and workspaceReload beside the writeScope the page gates on', async () => {
    const ctx = await setup();
    const asWriter = await (
      await fetch(`${ctx.baseUrl}/rc/capabilities`, {
        headers: { Authorization: `Bearer ${ctx.writeToken}` },
      })
    ).json();
    expect(asWriter.remoteControl.workspaceMemoryWrite).toBe(true);
    expect(asWriter.remoteControl.workspaceReload).toBe(true);
    expect(asWriter.remoteControl.writeScope).toBe(true);
    const asReader = await (
      await fetch(`${ctx.baseUrl}/rc/capabilities`, {
        headers: { Authorization: `Bearer ${ctx.readToken}` },
      })
    ).json();
    expect(asReader.remoteControl.writeScope).toBe(false);
  });
});
