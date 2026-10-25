/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { createSessionTasksRoute } from './sessionTasks.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';

const SESS = '11111111111111111111111111111111';

interface Captured {
  status?: number;
  body?: Record<string, unknown>;
}

function fakeRes(): { res: Response; captured: Captured } {
  const captured: Captured = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, captured };
}

/** One shell task and one agent task, as the daemon shapes them. */
const STATUS = {
  v: 1,
  sessionId: SESS,
  now: 1_700_000_000_000,
  tasks: [
    {
      kind: 'shell',
      id: 'sh-1',
      label: 'run tests',
      description: 'vitest run',
      status: 'running',
      command: 'npx vitest run',
      cwd: '/home/evan/projects/qwen-code',
      startTime: 1_700_000_000_000,
      runtimeMs: 1200,
      isBackgrounded: false,
    },
    {
      kind: 'agent',
      id: 'ag-1',
      label: 'explore',
      description: 'read the routes',
      status: 'completed',
      startTime: 1_700_000_000_000,
      runtimeMs: 4000,
      isBackgrounded: true,
    },
  ],
};

function fakeDaemon(behaviour: { status?: unknown; thrown?: unknown } = {}) {
  const calls: string[] = [];
  const daemon = {
    sessionTasks: async (sessionId: string) => {
      calls.push(sessionId);
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return behaviour.status ?? STATUS;
    },
  } as unknown as SessionDaemon;
  return { daemon, calls };
}

async function call(
  daemon: SessionDaemon,
  sessionId = SESS,
): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = { params: { id: sessionId } } as unknown as Request;
  await createSessionTasksRoute(daemon)(req, res, () => {});
  return captured;
}

describe('GET /session/:id/tasks (#110)', () => {
  it('relays the daemon task list verbatim', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon);
    expect(out.status).toBe(200);
    expect(out.body).toEqual(STATUS);
    expect(calls).toEqual([SESS]);
  });

  it('treats an empty task list as a real answer, not a failure', async () => {
    // A session with nothing running is the normal state. Answering 502 or 404
    // there would make an idle session look broken.
    const { daemon } = fakeDaemon({ status: { ...STATUS, tasks: [] } });
    const out = await call(daemon);
    expect(out.status).toBe(200);
    expect(out.body?.['tasks']).toEqual([]);
  });

  it('refuses a malformed session id before touching the daemon', async () => {
    // The guard is that no daemon call happens at all, so assert the call list
    // is empty rather than only the status: a traversal-shaped id must never
    // reach a client that could act on it.
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, '../../etc/passwd');
    expect(out.status).toBe(404);
    expect(out.body?.code).toBe('session_not_found');
    expect(calls).toEqual([]);
  });

  it('answers 404 when the pool has no record of the session', async () => {
    // `UnknownSessionError` says only "Unknown session: <id>", which a "not
    // found" text match misses, so this pins the class check.
    const { daemon } = fakeDaemon({ thrown: new UnknownSessionError(SESS) });
    const out = await call(daemon);
    expect(out.status).toBe(404);
    expect(out.body?.code).toBe('session_not_found');
  });

  it('answers 404 when the daemon itself says the session is gone', async () => {
    const { daemon } = fakeDaemon({
      thrown: new DaemonHttpError(
        404,
        { code: 'session_not_found', sessionId: SESS },
        'No such session',
      ),
    });
    const out = await call(daemon);
    expect(out.status).toBe(404);
    expect(out.body?.code).toBe('session_not_found');
  });

  it('answers 502 for any other daemon failure', async () => {
    const { daemon } = fakeDaemon({ thrown: new Error('tasks read refused') });
    const out = await call(daemon);
    expect(out.status).toBe(502);
    expect(out.body?.code).toBe('daemon_unavailable');
  });

  it('never echoes the daemon message', async () => {
    const { daemon } = fakeDaemon({
      thrown: new DaemonHttpError(
        500,
        { code: 'internal', sessionId: SESS },
        '/home/secret/should-not-surface',
      ),
    });
    const out = await call(daemon);
    expect(JSON.stringify(out.body)).not.toContain('should-not-surface');
  });
});
