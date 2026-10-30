/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { createSessionWorkflowActionRoute } from './sessionWorkflowAction.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

const SESS = '11111111111111111111111111111111';
const TASK = 'wf_01AbCdEf';

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

function recorder() {
  const entries: Array<Record<string, unknown>> = [];
  const audit = {
    record: async (e: Record<string, unknown>) => {
      entries.push(e);
    },
  } as unknown as AuditRecorder;
  return { audit, entries };
}

function fakeDaemon(
  behaviour: { verdict?: Record<string, unknown>; thrown?: unknown } = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  const daemon = {
    sessionWorkflowTaskAction: async (
      sessionId: string,
      taskId: string,
      action: string,
    ) => {
      calls.push({ sessionId, taskId, action });
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return behaviour.verdict ?? { changed: true, status: 'paused' };
    },
  } as unknown as SessionDaemon;
  return { daemon, calls };
}

async function call(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  body: unknown = { action: 'pause' },
  params: Record<string, string> = { id: SESS, taskId: TASK },
): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = {
    params,
    body,
    rcClient: { id: 'tok_test' },
  } as unknown as Request;
  await createSessionWorkflowActionRoute(daemon, audit)(req, res, () => {});
  return captured;
}

describe('POST /session/:id/tasks/:taskId/workflow-action (#110)', () => {
  it.each(['pause', 'resume', 'retry', 'rerun', 'delete-history'])(
    'relays %s to the daemon under the run id and audits it',
    async (action) => {
      const { daemon, calls } = fakeDaemon();
      const { audit, entries } = recorder();
      const out = await call(daemon, audit, { action });
      expect(out.status).toBe(200);
      expect(out.body).toEqual({
        sessionId: SESS,
        changed: true,
        status: 'paused',
      });
      expect(calls).toEqual([{ sessionId: SESS, taskId: TASK, action }]);
      expect(entries[0]).toMatchObject({
        action: 'workflow_action',
        actorTokenId: 'tok_test',
        target: SESS + ':' + TASK,
        detail: { action, changed: true },
      });
    },
  );

  it('passes changed:false through as it is, with no reason made up', async () => {
    // The daemon answers a bare {changed:false} for an untrusted folder,
    // workflows switched off and a run that already moved on.
    const { daemon } = fakeDaemon({ verdict: { changed: false } });
    const out = await call(daemon);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ sessionId: SESS, changed: false });
  });

  it.each(['run-saved', 'run-script'])(
    'refuses %s with its own code and never asks the daemon',
    async (action) => {
      const { daemon, calls } = fakeDaemon();
      const out = await call(daemon, undefined, {
        action,
        script: 'await agent("x")',
      });
      expect(out.status).toBe(400);
      expect(out.body?.code).toBe('workflow_action_withheld');
      expect(calls).toEqual([]);
    },
  );

  it.each([{}, { action: 'approve' }, { action: 7 }, null, 'pause'])(
    'refuses an action outside the control set (%j) before the daemon',
    async (body) => {
      const { daemon, calls } = fakeDaemon();
      const out = await call(daemon, undefined, body);
      expect(out.status).toBe(400);
      expect(out.body?.code).toBe('invalid_workflow_action');
      expect(calls).toEqual([]);
    },
  );

  it('refuses a malformed session id before touching the daemon', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, undefined, { action: 'pause' }, {
      id: '../../etc/passwd',
      taskId: TASK,
    });
    expect(out.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('answers 404 for an unknown session and for a daemon 404', async () => {
    for (const thrown of [
      new UnknownSessionError(SESS),
      new DaemonHttpError(404, { code: 'session_not_found' }, 'gone'),
    ]) {
      const { daemon } = fakeDaemon({ thrown });
      const { audit, entries } = recorder();
      const out = await call(daemon, audit);
      expect(out.status).toBe(404);
      expect(out.body?.code).toBe('session_not_found');
      expect(entries[0]).toMatchObject({ action: 'workflow_action_failed' });
    }
  });

  it('answers 502 without echoing the daemon message', async () => {
    const { daemon } = fakeDaemon({
      thrown: new Error('ENOENT /home/evan/secret-workdir'),
    });
    const out = await call(daemon);
    expect(out.status).toBe(502);
    expect(out.body?.code).toBe('daemon_unavailable');
    expect(JSON.stringify(out.body)).not.toContain('secret-workdir');
  });
});
