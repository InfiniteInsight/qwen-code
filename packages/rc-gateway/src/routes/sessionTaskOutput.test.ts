/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { createSessionTaskOutputRoute } from './sessionTaskOutput.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { OWNER, READ, WRITE } from '../scopes.js';

const SESS = '11111111111111111111111111111111';

interface Captured {
  status?: number;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function fakeRes(): { res: Response; captured: Captured } {
  const captured: Captured = { headers: {} };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    set(name: string, val: string) {
      captured.headers[name.toLowerCase()] = val;
      return res;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, captured };
}

function makeReq(opts: {
  id?: string;
  taskId?: string;
  query?: Record<string, unknown>;
  scopes?: string[];
  sessionLockId?: string;
}): Request {
  return {
    params: {
      id: opts.id ?? SESS,
      taskId: opts.taskId ?? 'sh-1',
    },
    query: opts.query ?? {},
    rcClient: {
      tokenId: 'tok-1',
      scopes: opts.scopes ?? [READ],
      ...(opts.sessionLockId ? { sessionLockId: opts.sessionLockId } : {}),
    },
  } as unknown as Request;
}

describe('createSessionTaskOutputRoute (#110)', () => {
  it('relays shell task output to READ tokens without opting into workflows', async () => {
    const calls: Array<{
      sessionId: string;
      taskId: string;
      opts: Record<string, unknown> | undefined;
    }> = [];
    const daemon: Pick<SessionDaemon, 'sessionTaskOutput'> = {
      sessionTaskOutput: async (sessionId, taskId, opts) => {
        calls.push({ sessionId, taskId, opts });
        return {
          v: 1,
          sessionId,
          taskId,
          kind: 'shell',
          label: 'npm test',
          status: 'running',
          available: true,
          content: 'PASS suite 1\n',
          truncated: false,
          byteLength: 13,
          totalBytes: 13,
        };
      },
    };
    const route = createSessionTaskOutputRoute(daemon);
    const { res, captured } = fakeRes();
    await route(
      makeReq({
        query: { kind: 'shell', maxBytes: '8192' },
        scopes: [READ],
      }),
      res,
      () => {},
    );
    expect(captured.status).toBe(200);
    expect(captured.headers['cache-control']).toBe('no-store');
    expect(captured.body?.['content']).toBe('PASS suite 1\n');
    expect(calls).toEqual([
      {
        sessionId: SESS,
        taskId: 'sh-1',
        opts: { kind: 'shell', maxBytes: 8192 },
      },
    ]);
  });

  it('withholds workflow task output from readers and share links, and opts in for WRITE/OWNER', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const daemon: Pick<SessionDaemon, 'sessionTaskOutput'> = {
      sessionTaskOutput: async (sessionId, taskId, opts) => {
        calls.push(opts);
        return {
          v: 1,
          sessionId,
          taskId,
          kind: 'workflow',
          label: 'release',
          status: 'completed',
          available: true,
          content: 'step 1 ok',
          truncated: false,
          byteLength: 9,
          totalBytes: 9,
        };
      },
    };
    const route = createSessionTaskOutputRoute(daemon);

    // Reader asking explicitly for workflow kind gets 404 before any daemon call
    const rReader = fakeRes();
    await route(
      makeReq({ taskId: 'wf-1', query: { kind: 'workflow' }, scopes: [READ] }),
      rReader.res,
      () => {},
    );
    expect(rReader.captured.status).toBe(404);
    expect(rReader.captured.body?.['code']).toBe('task_not_found');
    expect(calls).toHaveLength(0);

    // Session-locked share link never gets includeWorkflows even if scopes carry WRITE
    const rShare = fakeRes();
    await route(
      makeReq({
        taskId: 'wf-1',
        query: { kind: 'workflow' },
        scopes: [READ, WRITE],
        sessionLockId: SESS,
      }),
      rShare.res,
      () => {},
    );
    expect(rShare.captured.status).toBe(404);
    expect(calls).toHaveLength(0);

    // Owner token opts into includeWorkflows
    const rOwner = fakeRes();
    await route(
      makeReq({
        taskId: 'wf-1',
        query: { kind: 'workflow' },
        scopes: [OWNER, WRITE, READ],
      }),
      rOwner.res,
      () => {},
    );
    expect(rOwner.captured.status).toBe(200);
    expect(calls).toEqual([{ kind: 'workflow', includeWorkflows: true }]);
  });

  it('rejects malformed sessionId, taskId, kind, and maxBytes before calling daemon', async () => {
    let called = false;
    const route = createSessionTaskOutputRoute({
      sessionTaskOutput: async () => {
        called = true;
        throw new Error('should not run');
      },
    });

    const badSession = fakeRes();
    await route(makeReq({ id: '../etc/passwd' }), badSession.res, () => {});
    expect(badSession.captured.status).toBe(404);

    const badTask = fakeRes();
    await route(makeReq({ taskId: 'a/b' }), badTask.res, () => {});
    expect(badTask.captured.status).toBe(400);
    expect(badTask.captured.body?.['code']).toBe('invalid_task_id');

    const badKind = fakeRes();
    await route(
      makeReq({ query: { kind: 'arbitrary' } }),
      badKind.res,
      () => {},
    );
    expect(badKind.captured.status).toBe(400);
    expect(badKind.captured.body?.['code']).toBe('invalid_task_kind');

    const badBytes = fakeRes();
    await route(
      makeReq({ query: { maxBytes: '9999999' } }),
      badBytes.res,
      () => {},
    );
    expect(badBytes.captured.status).toBe(400);
    expect(badBytes.captured.body?.['code']).toBe('invalid_max_bytes');

    expect(called).toBe(false);
  });

  it('maps UnknownSessionError, daemon task_not_found, pre-route 404, and daemon failure cleanly', async () => {
    const unknownRoute = createSessionTaskOutputRoute({
      sessionTaskOutput: async () => {
        throw new UnknownSessionError(SESS);
      },
    });
    const r1 = fakeRes();
    await unknownRoute(makeReq({}), r1.res, () => {});
    expect(r1.captured.status).toBe(404);
    expect(r1.captured.body?.['code']).toBe('session_not_found');

    const taskMissingRoute = createSessionTaskOutputRoute({
      sessionTaskOutput: async () => {
        throw new DaemonHttpError(
          404,
          { error: 'Task not found', code: 'task_not_found' },
          'Task not found',
        );
      },
    });
    const r2 = fakeRes();
    await taskMissingRoute(makeReq({}), r2.res, () => {});
    expect(r2.captured.status).toBe(404);
    expect(r2.captured.body?.['code']).toBe('task_not_found');

    const oldDaemonRoute = createSessionTaskOutputRoute({
      sessionTaskOutput: async () => {
        throw new DaemonHttpError(404, {}, 'Cannot GET');
      },
    });
    const r3 = fakeRes();
    await oldDaemonRoute(makeReq({}), r3.res, () => {});
    expect(r3.captured.status).toBe(501);
    expect(r3.captured.body?.['code']).toBe('task_output_unsupported');

    const brokenDaemonRoute = createSessionTaskOutputRoute({
      sessionTaskOutput: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const r4 = fakeRes();
    await brokenDaemonRoute(makeReq({}), r4.res, () => {});
    expect(r4.captured.status).toBe(502);
    expect(r4.captured.body?.['code']).toBe('daemon_unavailable');
  });
});
