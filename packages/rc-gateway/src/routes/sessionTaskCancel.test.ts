/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { createSessionTaskCancelRoute } from './sessionTaskCancel.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

const SESS = '11111111111111111111111111111111';
const TASK = 'task_01AbCdEf';

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
  behaviour: {
    cancelled?: boolean;
    reason?: string;
    thrown?: unknown;
  } = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  const daemon = {
    cancelSessionTask: async (
      sessionId: string,
      taskId: string,
      kind: string,
      clientId?: string,
    ) => {
      calls.push({ sessionId, taskId, kind, clientId });
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return {
        cancelled: behaviour.cancelled ?? true,
        ...(behaviour.reason ? { reason: behaviour.reason } : {}),
      };
    },
  } as unknown as SessionDaemon;
  return { daemon, calls };
}

/**
 * `kind` travels in the BODY, which is what the daemon route requires
 * (`mutate({strict:true})`, packages/cli/src/serve/routes/session.ts:7451) —
 * the path segment names the task, the body names what sort of thing it is.
 */
async function call(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  params: Record<string, string> = { id: SESS, taskId: TASK },
  body: unknown = { kind: 'agent' },
): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = {
    params,
    body,
    rcClient: { id: 'tok_test' },
  } as unknown as Request;
  await createSessionTaskCancelRoute(daemon, audit)(req, res, () => {});
  return captured;
}

describe('POST /session/:id/tasks/:taskId/cancel (#110)', () => {
  it('cancels and audits, passing the daemon verdict through', async () => {
    const { daemon, calls } = fakeDaemon();
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      taskId: TASK,
      cancelled: true,
    });
    expect(calls[0]).toMatchObject({
      sessionId: SESS,
      taskId: TASK,
      kind: 'agent',
    });
    expect(entries[0]).toMatchObject({
      action: 'task_cancelled',
      actorTokenId: 'tok_test',
      target: SESS + ':' + TASK,
      detail: { kind: 'agent', cancelled: true },
    });
  });

  it('does not dress up a cancelled:false verdict as a success', async () => {
    // The daemon can answer 200 having not stopped anything. Reporting that as
    // a plain success is the flattened-failure class this issue is about.
    const { daemon } = fakeDaemon({ cancelled: false });
    const out = await call(daemon);
    expect(out.status).toBe(200);
    expect(out.body?.cancelled).toBe(false);
  });

  it('passes the disabled verdict through, reason included', async () => {
    // A `workflow` kind on an untrusted workspace is a policy answer from the
    // daemon, not a failure to reach it, so the reader has to see the reason.
    const { daemon } = fakeDaemon({ cancelled: false, reason: 'disabled' });
    const out = await call(
      daemon,
      undefined,
      { id: SESS, taskId: TASK },
      {
        kind: 'workflow',
      },
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      taskId: TASK,
      cancelled: false,
      reason: 'disabled',
    });
  });

  it.each(['agent', 'shell', 'monitor', 'workflow'])(
    'relays the kind %s',
    async (kind) => {
      const { daemon, calls } = fakeDaemon();
      const out = await call(
        daemon,
        undefined,
        { id: SESS, taskId: TASK },
        {
          kind,
        },
      );
      expect(out.status).toBe(200);
      expect(calls[0]).toMatchObject({ kind });
    },
  );

  it('refuses a kind the daemon would reject, without blaming the daemon', async () => {
    // The SDK turns the daemon's own 400 into a throw, which the catch would
    // report as 502 daemon_unavailable — the gateway taking the blame for the
    // caller's typo. Checking here is what keeps that status honest.
    const { daemon, calls } = fakeDaemon();
    const { audit, entries } = recorder();
    const out = await call(
      daemon,
      audit,
      { id: SESS, taskId: TASK },
      {
        kind: 'goal',
      },
    );
    expect(out.status).toBe(400);
    expect(out.body?.['code']).toBe('invalid_task_kind');
    expect(calls).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  // `undefined` cannot be used here: it would trip `call`'s default body and
  // silently send a valid kind. Under `express.json()` an absent body arrives
  // as `{}`, so that is the shape that has to be refused.
  it.each([
    ['an empty body', {}],
    ['a null body', null],
    ['a kind that is not a string', { kind: 7 }],
    ['a missing kind', { note: 'oops' }],
  ])('refuses %s with 400, not 500', async (_label, body) => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, undefined, { id: SESS, taskId: TASK }, body);
    expect(out.status).toBe(400);
    expect(out.body?.['code']).toBe('invalid_task_kind');
    expect(calls).toHaveLength(0);
  });

  it('answers 404 for a malformed session id before any daemon call', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, undefined, {
      id: 'not-a-session-id',
      taskId: TASK,
    });
    expect(out.status).toBe(404);
    expect(out.body?.['code']).toBe('session_not_found');
    expect(calls).toHaveLength(0);
  });

  it('answers 404 when the daemon says the session is gone', async () => {
    // Both shapes reach this route: the pool's own error when it holds no
    // record of the id, and the daemon's 404 marshalled by the SDK.
    for (const thrown of [
      new UnknownSessionError('no such session'),
      new DaemonHttpError(404, { code: 'session_not_found' }, 'gone'),
    ]) {
      const { daemon } = fakeDaemon({ thrown });
      const { audit, entries } = recorder();
      const out = await call(daemon, audit);
      expect(out.status).toBe(404);
      expect(out.body?.['code']).toBe('session_not_found');
      expect(entries[0]).toMatchObject({
        action: 'task_cancel_failed',
        detail: { reason: 'not_found' },
      });
    }
  });

  it('answers 502 on a transport failure without echoing the daemon message', async () => {
    const { daemon } = fakeDaemon({
      thrown: new DaemonHttpError(
        500,
        { code: 'boom' },
        'ECONNREFUSED 127.0.0.1:4180 /home/evan/.qwen/workspaces/secret',
      ),
    });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(502);
    expect(out.body?.['code']).toBe('daemon_unavailable');
    expect(JSON.stringify(out.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(out.body)).not.toContain('secret');
    expect(entries[0]).toMatchObject({
      action: 'task_cancel_failed',
      detail: { reason: 'daemon_unavailable' },
    });
  });
});
