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
import { WorkspacePoolFullError, type SessionDaemon } from '../daemonPool.js';
import {
  createWorkspaceFileBytesRoute,
  createWorkspaceFileRoute,
  createWorkspaceGlobRoute,
  createWorkspaceListRoute,
} from './workspaceFiles.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/**
 * The relay path runs a real `DaemonClient` against the stub, so the query the
 * daemon actually receives is the one produced by an HTTP exchange. A
 * hand-written daemon object could not prove the caller's path survived the
 * SDK's own URL building.
 */
async function mountGateway(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.get('/rc/workspace/list', createWorkspaceListRoute(daemon));
  app.get('/rc/workspace/glob', createWorkspaceGlobRoute(daemon));
  app.get('/rc/workspace/file', createWorkspaceFileRoute(daemon));
  app.get('/rc/workspace/file/bytes', createWorkspaceFileBytesRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function getJson(
  base: string,
  url: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + url);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** A daemon that records what it was called with, for the verdicts and
 * arguments a live client cannot show (the pool routing target, a thrown
 * pool-full error). */
function fakeDaemon(behaviour: { result?: unknown; thrown?: unknown } = {}): {
  daemon: SessionDaemon;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const record = (name: string, args: unknown[]) => {
    calls.push({ name, args });
    if (behaviour.thrown !== undefined) throw behaviour.thrown;
    return behaviour.result ?? { kind: 'list', entries: [] };
  };
  const daemon = {
    dirList: async (p: string, w?: string) => record('dirList', [p, w]),
    glob: async (p: string, w?: string) => record('glob', [p, w]),
    readWorkspaceFile: async (p: string, o?: unknown, c?: string, w?: string) =>
      record('readWorkspaceFile', [p, o, c, w]),
    readWorkspaceFileBytes: async (
      p: string,
      o?: unknown,
      c?: string,
      w?: string,
    ) => record('readWorkspaceFileBytes', [p, o, c, w]),
  } as unknown as SessionDaemon;
  return { daemon, calls };
}

describe('workspace file browser (read-only, #107)', () => {
  it('relays a directory listing and carries the caller path to the daemon', async () => {
    stub = await startStubDaemon();
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const base = await mountGateway(client);
    const { status, body } = await getJson(
      base,
      '/rc/workspace/list?path=src%2Fcomponents',
    );
    expect(status).toBe(200);
    expect(body['kind']).toBe('list');
    expect(body['path']).toBe('src/components');
    const entries = body['entries'] as Array<Record<string, unknown>>;
    expect(entries[0]).toEqual({
      name: 'src',
      kind: 'directory',
      ignored: false,
    });
    // The caller's path is what the daemon was asked for, not a default.
    expect(stub.lastListQuery?.['path']).toBe('src/components');
  });

  it('never forwards the workspace target to the daemon', async () => {
    stub = await startStubDaemon();
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const base = await mountGateway(client);
    const { status } = await getJson(
      base,
      '/rc/workspace/list?path=src&workspace=%2Fother%2Fproj',
    );
    expect(status).toBe(200);
    // `workspace` picks which pooled daemon answers; it is not a daemon query.
    expect(stub.lastListQuery?.['workspace']).toBeUndefined();
    expect(stub.lastListQuery?.['path']).toBe('src');
  });

  it('hands the workspace target to the pool as the trailing argument', async () => {
    const { daemon, calls } = fakeDaemon({ result: { kind: 'list' } });
    const base = await mountGateway(daemon);
    const { status } = await getJson(
      base,
      '/rc/workspace/list?path=src&workspace=%2Fother%2Fproj',
    );
    expect(status).toBe(200);
    expect(calls[0]).toEqual({ name: 'dirList', args: ['src', '/other/proj'] });
  });

  it('relays a text file read with its window fields intact', async () => {
    stub = await startStubDaemon({
      fileResult: {
        kind: 'file',
        path: 'README.md',
        content: '# hello\n',
        encoding: 'utf-8',
        bom: false,
        lineEnding: 'lf',
        sizeBytes: 8192,
        returnedBytes: 1024,
        truncated: true,
        matchedIgnore: null,
        originalLineCount: 200,
        nextCursor: 'cur-2',
        hasMore: true,
      },
    });
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const base = await mountGateway(client);
    const { status, body } = await getJson(
      base,
      '/rc/workspace/file?path=README.md&line=10&limit=20&maxBytes=1024',
    );
    expect(status).toBe(200);
    expect(body['content']).toBe('# hello\n');
    // A partial file must not read as a whole one: the flags travel.
    expect(body['truncated']).toBe(true);
    expect(body['hasMore']).toBe(true);
    expect(body['nextCursor']).toBe('cur-2');
    expect(stub.lastFileQuery?.['line']).toBe('10');
    expect(stub.lastFileQuery?.['limit']).toBe('20');
    expect(stub.lastFileQuery?.['maxBytes']).toBe('1024');
  });

  it('relays a glob result', async () => {
    stub = await startStubDaemon();
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const base = await mountGateway(client);
    const { status, body } = await getJson(
      base,
      '/rc/workspace/glob?pattern=src%2F**%2F*.ts',
    );
    expect(status).toBe(200);
    expect(body['kind']).toBe('glob');
    expect(body['matches']).toEqual(['src/index.ts']);
    expect(stub.lastGlobQuery?.['pattern']).toBe('src/**/*.ts');
  });

  it('relays the binary read as base64 json', async () => {
    stub = await startStubDaemon();
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const base = await mountGateway(client);
    const { status, body } = await getJson(
      base,
      '/rc/workspace/file/bytes?path=docs%2Fimg.png',
    );
    expect(status).toBe(200);
    expect(body['kind']).toBe('file_bytes');
    expect(
      Buffer.from(String(body['contentBase64']), 'base64').toString(),
    ).toBe('pngbytes');
    expect(stub.lastFileBytesQuery?.['path']).toBe('docs/img.png');
  });

  it('refuses a missing path before asking the daemon anything', async () => {
    const { daemon, calls } = fakeDaemon();
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(base, '/rc/workspace/list');
    expect(status).toBe(400);
    expect(body['code']).toBe('invalid_query');
    expect(calls).toHaveLength(0);
  });

  it('refuses a repeated path rather than guessing which one was meant', async () => {
    const { daemon, calls } = fakeDaemon();
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(
      base,
      '/rc/workspace/list?path=a&path=b',
    );
    expect(status).toBe(400);
    expect(body['code']).toBe('invalid_query');
    expect(calls).toHaveLength(0);
  });

  it('refuses a non-numeric window rather than sending one the SDK cannot type', async () => {
    const { daemon, calls } = fakeDaemon();
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(
      base,
      '/rc/workspace/file?path=a&line=abc',
    );
    expect(status).toBe(400);
    expect(body['code']).toBe('invalid_query');
    expect(calls).toHaveLength(0);
  });

  it('refuses a malformed workspace target rather than defaulting it', async () => {
    const { daemon, calls } = fakeDaemon();
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(
      base,
      '/rc/workspace/list?path=a&workspace=1&workspace=2',
    );
    expect(status).toBe(400);
    expect(body['code']).toBe('invalid_workspace');
    expect(calls).toHaveLength(0);
  });

  it('relays the daemon 404 for a path that is not there', async () => {
    stub = await startStubDaemon({
      listStatus: 404,
      listErrorBody: {
        errorKind: 'not_found',
        error: 'path does not exist',
        status: 404,
      },
    });
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const base = await mountGateway(client);
    const { status, body } = await getJson(
      base,
      '/rc/workspace/list?path=nope',
    );
    expect(status).toBe(404);
    expect(body['code']).toBe('not_found');
  });

  it('relays the daemon 422 that says the file is binary', async () => {
    // The caller's cue to reach for /file/bytes, so it must not arrive as a 502.
    stub = await startStubDaemon({
      fileStatus: 422,
      fileErrorBody: {
        errorKind: 'binary_file',
        error: 'binary content',
        status: 422,
      },
    });
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const base = await mountGateway(client);
    const { status, body } = await getJson(
      base,
      '/rc/workspace/file?path=img.png',
    );
    expect(status).toBe(422);
    expect(body['code']).toBe('binary_file');
  });

  it('relays the daemon 403 with its hint intact', async () => {
    stub = await startStubDaemon({
      fileStatus: 403,
      fileErrorBody: {
        errorKind: 'path_outside_workspace',
        error: 'path resolved outside workspace',
        hint: 'stay inside the workspace',
        status: 403,
      },
    });
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const base = await mountGateway(client);
    const { status, body } = await getJson(
      base,
      '/rc/workspace/file?path=..%2Fsecret',
    );
    expect(status).toBe(403);
    expect(body['code']).toBe('path_outside_workspace');
    expect(body['hint']).toBe('stay inside the workspace');
  });

  it('calls a bare 404 an unsupported surface, not a missing path', async () => {
    // A daemon with no file routes answers 404 with no fs envelope. That is a
    // capability gap, not an answer about the path the caller asked about.
    stub = await startStubDaemon({ listStatus: 404, listErrorBody: {} });
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const base = await mountGateway(client);
    const { status, body } = await getJson(base, '/rc/workspace/list?path=a');
    expect(status).toBe(502);
    expect(body['code']).toBe('file_reads_unsupported');
  });

  it('maps a full pool to 503, not to a daemon failure', async () => {
    const { daemon } = fakeDaemon({ thrown: new WorkspacePoolFullError(4) });
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(base, '/rc/workspace/list?path=a');
    expect(status).toBe(503);
    expect(body['code']).toBe('workspace_pool_full');
  });

  it('maps an unexpected daemon failure to 502', async () => {
    const { daemon } = fakeDaemon({ thrown: new Error('socket reset') });
    const base = await mountGateway(daemon);
    const { status, body } = await getJson(base, '/rc/workspace/list?path=a');
    expect(status).toBe(502);
    expect(body['code']).toBe('daemon_unavailable');
  });
});
