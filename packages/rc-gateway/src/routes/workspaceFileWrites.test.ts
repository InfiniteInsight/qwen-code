/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #123, the file-write slice. Every relay test runs the real gateway app
 * (`createGatewayApp`) over a real `DaemonClient` against the stub, so the
 * scope check, the body reader and the SDK's own request building are all in
 * the path, and the pool-method-name trap D61 records (a name the bare client
 * lacks is `undefined` at runtime while tsc stays clean) would show up as a
 * 502 here rather than in production.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
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
  storeDir = await mkdtemp(join(tmpdir(), 'rc-ws-fwrite-store-'));
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
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-ws-fwrite-'));
  auditPath = join(runtimeBase, 'audit.log');
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  await rm(runtimeBase, { recursive: true, force: true });
});

const hashOf = (text: string) =>
  `sha256:${createHash('sha256').update(text, 'utf-8').digest('hex')}`;

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

function upload(
  base: string,
  query: string,
  token: string,
  body: Uint8Array | string,
) {
  return fetch(`${base}/rc/workspace/file/upload${query}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body,
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

describe('scope: every file write refuses a token without write', () => {
  const writeCalls: Array<
    [string, (ctx: Awaited<ReturnType<typeof setup>>, token: string) => Promise<Response>]
  > = [
    [
      'write',
      (ctx, t) =>
        postJson(ctx.baseUrl, '/rc/workspace/file/write', t, {
          path: 'a.txt',
          content: '',
          mode: 'create',
        }),
    ],
    [
      'edit',
      (ctx, t) =>
        postJson(ctx.baseUrl, '/rc/workspace/file/edit', t, {
          path: 'README.md',
          oldText: 'hello',
          newText: 'bye',
          expectedHash: hashOf('# hello\n'),
        }),
    ],
    ['upload', (ctx, t) => upload(ctx.baseUrl, '?path=a.bin', t, 'abc')],
    [
      'delete',
      (ctx, t) =>
        postJson(ctx.baseUrl, '/rc/workspace/file/delete', t, {
          path: 'README.md',
        }),
    ],
    [
      'stat',
      (ctx, t) =>
        fetch(`${ctx.baseUrl}/rc/workspace/stat?path=README.md`, {
          headers: { Authorization: `Bearer ${t}` },
        }),
    ],
  ];

  for (const [name, call] of writeCalls) {
    it(`${name}: a share token gets 403 and the daemon is never asked`, async () => {
      const ctx = await setup();
      const res = await call(ctx, ctx.shareToken);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('scope_required');
      expect(ctx.stub.lastFileWrite).toBeUndefined();
      expect(ctx.stub.lastFileEdit).toBeUndefined();
      expect(ctx.stub.lastFileUpload).toBeUndefined();
      expect(ctx.stub.lastFileDelete).toBeUndefined();
      expect(ctx.stub.lastStatQuery).toBeUndefined();
    });

    it(`${name}: a session:read token and a read+approve token get 403`, async () => {
      const ctx = await setup();
      for (const t of [ctx.readToken, ctx.approveToken]) {
        const res = await call(ctx, t);
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('scope_required');
      }
      expect(ctx.stub.lastFileWrite).toBeUndefined();
      expect(ctx.stub.lastFileUpload).toBeUndefined();
      expect(ctx.stub.lastFileDelete).toBeUndefined();
    });
  }

  it('the refusal is audited as scope_denied with the write scope named', async () => {
    const ctx = await setup();
    await postJson(ctx.baseUrl, '/rc/workspace/file/delete', ctx.shareToken, {
      path: 'README.md',
    });
    const rows = await auditActions();
    const denied = rows.find((r) => r['action'] === 'scope_denied');
    expect(denied).toBeDefined();
    expect((denied!['detail'] as Record<string, unknown>)['required']).toBe(
      'write',
    );
  });

  it('a share token body is never parsed: an oversize upload is still a 403, not a 413', async () => {
    const ctx = await setup({}, { maxAttachmentBytes: 16 });
    const res = await upload(
      ctx.baseUrl,
      '?path=big.bin',
      ctx.shareToken,
      new Uint8Array(1024),
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /rc/workspace/file/write', () => {
  it('creates an empty file: 201 with the daemon result, path passed through unchanged', async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/file/write',
      ctx.writeToken,
      { path: 'notes/../new file.md', content: '', mode: 'create' },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kind).toBe('file_write');
    expect(body.created).toBe(true);
    expect(body.hash).toBe(hashOf(''));
    // Containment is the daemon's: the gateway did not normalise the path.
    expect(ctx.stub.lastFileWrite).toEqual({
      path: 'notes/../new file.md',
      content: '',
      mode: 'create',
    });
  });

  it('replaces with the hash the read returned: 200 and the new hash', async () => {
    const ctx = await setup();
    const read = await fetch(
      `${ctx.baseUrl}/rc/workspace/file?path=README.md`,
      { headers: { Authorization: `Bearer ${ctx.writeToken}` } },
    );
    const file = await read.json();
    expect(file.hash).toBe(hashOf('# hello\n'));
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/file/write',
      ctx.writeToken,
      {
        path: 'README.md',
        content: '# bye\n',
        mode: 'replace',
        expectedHash: file.hash,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.hash).toBe(hashOf('# bye\n'));
    expect(ctx.stub.workspaceFiles.get('README.md')).toBe('# bye\n');
  });

  it('a stale replace is refused 409 hash_mismatch with the daemon hint, and nothing is written', async () => {
    const ctx = await setup();
    // Another client changes the file after this one read it.
    ctx.stub.workspaceFiles.set('README.md', 'changed elsewhere\n');
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/file/write',
      ctx.writeToken,
      {
        path: 'README.md',
        content: 'mine\n',
        mode: 'replace',
        expectedHash: hashOf('# hello\n'),
      },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('hash_mismatch');
    expect(body.hint).toMatch(/re-read/);
    expect(ctx.stub.workspaceFiles.get('README.md')).toBe(
      'changed elsewhere\n',
    );
  });

  it('a create over an existing name relays 409 file_already_exists', async () => {
    const ctx = await setup();
    ctx.stub.workspaceFiles.set('taken.md', 'x');
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/file/write',
      ctx.writeToken,
      { path: 'taken.md', content: '', mode: 'create' },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('file_already_exists');
  });

  it('refuses malformed input with 400 before the daemon is asked', async () => {
    const ctx = await setup();
    const bad: unknown[] = [
      { path: '', content: '', mode: 'create' },
      { path: 7, content: '', mode: 'create' },
      { content: '', mode: 'create' },
      { path: 'a', content: 3, mode: 'create' },
      { path: 'a', content: '', mode: 'overwrite' },
      { path: 'a', content: '', mode: 'replace' },
      { path: 'a', content: '', mode: 'create', expectedHash: 5 },
      { path: 'a', content: '', mode: 'create', workspace: 9 },
    ];
    for (const body of bad) {
      const res = await postJson(
        ctx.baseUrl,
        '/rc/workspace/file/write',
        ctx.writeToken,
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(ctx.stub.lastFileWrite).toBeUndefined();
  });

  it('a body above the 100 KB app parser default is accepted (it reads its own body)', async () => {
    const ctx = await setup();
    const content = 'x'.repeat(300 * 1024);
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/file/write',
      ctx.writeToken,
      { path: 'big.txt', content, mode: 'create' },
    );
    expect(res.status).toBe(201);
    expect(ctx.stub.workspaceFiles.get('big.txt')?.length).toBe(content.length);
  });

  it('a body above the #196 limit is refused 413 file_too_large with maxBytes, unread by the daemon', async () => {
    const ctx = await setup({}, { maxAttachmentBytes: 1024 });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/file/write',
      ctx.writeToken,
      { path: 'big.txt', content: 'x'.repeat(4096), mode: 'create' },
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe('file_too_large');
    expect(body.maxBytes).toBe(1024);
    expect(ctx.stub.lastFileWrite).toBeUndefined();
  });

  it('a success is audited without the path', async () => {
    const ctx = await setup();
    await postJson(ctx.baseUrl, '/rc/workspace/file/write', ctx.writeToken, {
      path: 'secret-name.md',
      content: '',
      mode: 'create',
    });
    const rows = await auditActions();
    const row = rows.find((r) => r['action'] === 'workspace_file_written');
    expect(row).toBeDefined();
    expect(row!['detail']).toEqual({ mode: 'create' });
    expect(JSON.stringify(row)).not.toContain('secret-name');
  });

  it('a daemon without the routes (404, no envelope) is 502 file_writes_unsupported', async () => {
    const ctx = await setup({ fileWriteStatus: 404, fileWriteErrorBody: {} });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/file/write',
      ctx.writeToken,
      { path: 'a.txt', content: '', mode: 'create' },
    );
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('file_writes_unsupported');
  });
});

describe('POST /rc/workspace/file/edit', () => {
  it('relays the single replacement with the hash check', async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/file/edit',
      ctx.writeToken,
      {
        path: 'README.md',
        oldText: 'hello',
        newText: 'there',
        expectedHash: hashOf('# hello\n'),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe('file_edit');
    expect(body.hash).toBe(hashOf('# there\n'));
    expect(ctx.stub.lastFileEdit).toEqual({
      path: 'README.md',
      oldText: 'hello',
      newText: 'there',
      expectedHash: hashOf('# hello\n'),
    });
  });

  it('refuses a missing expectedHash or a non-string text with 400', async () => {
    const ctx = await setup();
    for (const body of [
      { path: 'README.md', oldText: 'a', newText: 'b' },
      { path: 'README.md', oldText: 1, newText: 'b', expectedHash: 'x' },
      { path: '', oldText: 'a', newText: 'b', expectedHash: 'x' },
    ]) {
      const res = await postJson(
        ctx.baseUrl,
        '/rc/workspace/file/edit',
        ctx.writeToken,
        body,
      );
      expect(res.status).toBe(400);
    }
    expect(ctx.stub.lastFileEdit).toBeUndefined();
  });

  it('relays the daemon 422 for text that is not there', async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/file/edit',
      ctx.writeToken,
      {
        path: 'README.md',
        oldText: 'absent',
        newText: 'x',
        expectedHash: hashOf('# hello\n'),
      },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('text_not_found');
  });
});

describe('POST /rc/workspace/file/upload', () => {
  it('carries the bytes as octet-stream to the path given and answers the numbered name', async () => {
    const ctx = await setup();
    ctx.stub.workspaceFiles.set('docs/photo.jpg', 'already here');
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const res = await upload(
      ctx.baseUrl,
      '?path=docs%2Fphoto.jpg',
      ctx.writeToken,
      bytes,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kind).toBe('file_upload');
    // The daemon never overwrites; the name it chose is the one relayed.
    expect(body.path).toBe('docs/photo (1).jpg');
    expect(body.sizeBytes).toBe(5);
    expect(ctx.stub.lastFileUpload).toEqual({
      path: 'docs/photo.jpg',
      contentType: 'application/octet-stream',
      byteLength: 5,
    });
  });

  it('a JSON-named file is not claimed by the app JSON parser', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/file/upload?path=data.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.writeToken}`,
          'Content-Type': 'application/json',
        },
        body: '{"a":1}',
      },
    );
    expect(res.status).toBe(201);
    expect(ctx.stub.lastFileUpload?.byteLength).toBe(7);
  });

  it('accepts an empty file', async () => {
    const ctx = await setup();
    const res = await upload(ctx.baseUrl, '?path=empty.txt', ctx.writeToken, '');
    expect(res.status).toBe(201);
    expect(ctx.stub.lastFileUpload?.byteLength).toBe(0);
  });

  it('a body above the #196 limit is refused 413 file_too_large before the daemon sees it', async () => {
    const ctx = await setup({}, { maxAttachmentBytes: 1000 });
    const res = await upload(
      ctx.baseUrl,
      '?path=big.bin',
      ctx.writeToken,
      new Uint8Array(1001),
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe('file_too_large');
    expect(body.maxBytes).toBe(1000);
    expect(ctx.stub.lastFileUpload).toBeUndefined();
  });

  it('a body of exactly the limit is accepted', async () => {
    const ctx = await setup({}, { maxAttachmentBytes: 1000 });
    const res = await upload(
      ctx.baseUrl,
      '?path=edge.bin',
      ctx.writeToken,
      new Uint8Array(1000),
    );
    expect(res.status).toBe(201);
  });

  it("relays the daemon's own 413 with its maxBytes", async () => {
    const ctx = await setup({
      fileUploadStatus: 413,
      fileUploadErrorBody: {
        errorKind: 'file_too_large',
        error: 'Request body too large (max 50 MiB)',
        status: 413,
        maxBytes: 52428800,
      },
    });
    const res = await upload(ctx.baseUrl, '?path=a.bin', ctx.writeToken, 'abc');
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Request body too large (max 50 MiB)',
      code: 'file_too_large',
      maxBytes: 52428800,
    });
  });

  it('refuses an absent or empty path with 400', async () => {
    const ctx = await setup();
    for (const q of ['', '?path=']) {
      const res = await upload(ctx.baseUrl, q, ctx.writeToken, 'abc');
      expect(res.status).toBe(400);
    }
    expect(ctx.stub.lastFileUpload).toBeUndefined();
  });

  it('is audited with the size and without the name', async () => {
    const ctx = await setup();
    await upload(ctx.baseUrl, '?path=private.bin', ctx.writeToken, 'abcd');
    const rows = await auditActions();
    const row = rows.find((r) => r['action'] === 'workspace_file_uploaded');
    expect(row!['detail']).toEqual({ sizeBytes: 4 });
    expect(JSON.stringify(row)).not.toContain('private');
  });
});

describe('POST /rc/workspace/file/delete', () => {
  it("addresses the daemon's primary workspace by the cwd its capabilities name", async () => {
    const ctx = await setup();
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/file/delete',
      ctx.writeToken,
      { path: 'README.md' },
    );
    expect(res.status).toBe(204);
    expect(ctx.stub.lastFileDelete).toEqual({
      workspace: '/stub/workspace',
      path: 'README.md',
    });
    // Gone: a read now answers the daemon's 404.
    const read = await fetch(`${ctx.baseUrl}/rc/workspace/file?path=README.md`, {
      headers: { Authorization: `Bearer ${ctx.writeToken}` },
    });
    expect(read.status).toBe(404);
  });

  it('relays the daemon refusal of a directory (it deletes regular files only)', async () => {
    const ctx = await setup({
      fileDeleteStatus: 400,
      fileDeleteErrorBody: {
        errorKind: 'parse_error',
        error: 'Only regular files can be deleted',
        status: 400,
      },
    });
    const res = await postJson(
      ctx.baseUrl,
      '/rc/workspace/file/delete',
      ctx.writeToken,
      { path: 'src' },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Only regular files can be deleted');
  });

  it('refuses an empty or non-string path with 400', async () => {
    const ctx = await setup();
    for (const body of [{}, { path: '' }, { path: ['a'] }]) {
      const res = await postJson(
        ctx.baseUrl,
        '/rc/workspace/file/delete',
        ctx.writeToken,
        body,
      );
      expect(res.status).toBe(400);
    }
    expect(ctx.stub.lastFileDelete).toBeUndefined();
  });

  it('is audited without the path', async () => {
    const ctx = await setup();
    await postJson(ctx.baseUrl, '/rc/workspace/file/delete', ctx.ownerToken, {
      path: 'README.md',
    });
    const rows = await auditActions();
    const row = rows.find((r) => r['action'] === 'workspace_file_deleted');
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('README');
  });
});

describe('GET /rc/workspace/stat', () => {
  it('relays the daemon stat shape', async () => {
    const ctx = await setup();
    const res = await fetch(
      `${ctx.baseUrl}/rc/workspace/stat?path=README.md`,
      { headers: { Authorization: `Bearer ${ctx.writeToken}` } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: 'stat',
      path: 'README.md',
      type: 'file',
      sizeBytes: 8,
      modifiedMs: 1767225600000,
    });
    expect(ctx.stub.lastStatQuery).toEqual({ path: 'README.md' });
  });

  it('refuses a missing path with 400', async () => {
    const ctx = await setup();
    const res = await fetch(`${ctx.baseUrl}/rc/workspace/stat`, {
      headers: { Authorization: `Bearer ${ctx.writeToken}` },
    });
    expect(res.status).toBe(400);
    expect(ctx.stub.lastStatQuery).toBeUndefined();
  });
});

describe('the pool carries every write under the SDK name (D61)', () => {
  it('a DaemonPool over the stub reaches all five daemon routes', async () => {
    stub = await startStubDaemon();
    const pool = new DaemonPool({
      defaultDaemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      defaultWorkspaceCwd: '/stub/workspace',
      spawn: async () => {
        throw new Error('no spawn in this test');
      },
    });
    try {
      const stat = (await pool.fileStat('README.md')) as Record<string, unknown>;
      expect(stat['kind']).toBe('stat');
      const created = await pool.writeWorkspaceFile({
        path: 'p.txt',
        content: 'one two',
        mode: 'create',
      });
      expect(created.created).toBe(true);
      const edited = await pool.editWorkspaceFile({
        path: 'p.txt',
        oldText: 'two',
        newText: 'three',
        expectedHash: created.hash,
      });
      expect(edited.hash).toBe(hashOf('one three'));
      const up = await pool.uploadWorkspaceFile({
        path: 'u.bin',
        data: new Uint8Array([9]),
      });
      expect(up.path).toBe('u.bin');
      await pool.deleteWorkspaceFile('p.txt');
      expect(stub.lastFileDelete).toEqual({
        workspace: '/stub/workspace',
        path: 'p.txt',
      });
    } finally {
      await pool.stopAll();
    }
  });

  it('a bare DaemonClient has every required method by these names', () => {
    const client = new DaemonClient({ baseUrl: 'http://127.0.0.1:1' });
    for (const name of [
      'fileStat',
      'writeWorkspaceFile',
      'editWorkspaceFile',
      'uploadWorkspaceFile',
    ] as const) {
      expect(typeof client[name]).toBe('function');
    }
    // The one that is not there, which is why the interface marks it
    // optional and the route falls back to the qualified client.
    expect(
      typeof (client as unknown as Record<string, unknown>)[
        'deleteWorkspaceFile'
      ],
    ).toBe('undefined');
    expect(typeof client.workspaceByCwd('/x').deleteWorkspaceFile).toBe(
      'function',
    );
  });

  it('through the gateway on a pool, the delete reaches the qualified route too', async () => {
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
      const res = await postJson(
        ctx.baseUrl,
        '/rc/workspace/file/delete',
        ctx.writeToken,
        { path: 'README.md' },
      );
      expect(res.status).toBe(204);
      expect(inner.lastFileDelete).toEqual({
        workspace: '/stub/workspace',
        path: 'README.md',
      });
    } finally {
      await pool.stopAll();
      await inner.close();
    }
  });
});

describe('/rc/capabilities', () => {
  it('reports workspaceFileWrites and the writeScope the page gates on', async () => {
    const ctx = await setup();
    const asWriter = await (
      await fetch(`${ctx.baseUrl}/rc/capabilities`, {
        headers: { Authorization: `Bearer ${ctx.writeToken}` },
      })
    ).json();
    expect(asWriter.remoteControl.workspaceFileWrites).toBe(true);
    expect(asWriter.remoteControl.writeScope).toBe(true);
    const asReader = await (
      await fetch(`${ctx.baseUrl}/rc/capabilities`, {
        headers: { Authorization: `Bearer ${ctx.readToken}` },
      })
    ).json();
    expect(asReader.remoteControl.writeScope).toBe(false);
  });
});
