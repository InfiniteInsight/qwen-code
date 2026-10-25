/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { createSubagentInspectRoute } from './subagentInspect.js';
import type { SessionDaemon } from '../daemonPool.js';

const SESS = '11111111111111111111111111111111';
const REF = 'toolu_01AbCdEf';

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

/** The daemon's resolution as `virtual-subagent-sessions.ts:979-990` builds it. */
const RESOLVED = {
  sessionId: 'sub_' + REF,
  taskId: 'task-7',
  title: 'explore the reconnect path',
  status: 'running',
  durationMs: 6100,
  totalTokens: 2400,
  inputTokens: 2000,
  outputTokens: 400,
};

function fakeDaemon(behaviour: { resolved?: unknown; thrown?: unknown } = {}) {
  const calls: Array<{ sessionId: string; subagentRef: string }> = [];
  const daemon = {
    resolveSubagentSession: async (sessionId: string, subagentRef: string) => {
      calls.push({ sessionId, subagentRef });
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return behaviour.resolved ?? RESOLVED;
    },
  } as unknown as SessionDaemon;
  return { daemon, calls };
}

async function call(
  daemon: SessionDaemon,
  params = { id: SESS, subagentRef: REF },
): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = { params, rcClient: { id: 'tok_test' } } as unknown as Request;
  await createSubagentInspectRoute(daemon)(req, res, () => {});
  return captured;
}

/** The child-gone 404 exactly as `session.ts:5484-5489` sends it. */
function childGone(ref: string) {
  return new DaemonHttpError(
    404,
    { code: 'session_not_found', sessionId: SESS, subagentRef: ref },
    'Subagent session not found',
  );
}

/** The parent-level 404: same code, nothing naming a child. */
function parentGone() {
  return new DaemonHttpError(
    404,
    { code: 'session_not_found', sessionId: SESS },
    'No such session',
  );
}

describe('GET /session/:id/subagents/:subagentRef (#110)', () => {
  it('passes the daemon resolution through untouched', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon);
    expect(out.status).toBe(200);
    expect(out.body).toEqual(RESOLVED);
    expect(calls[0]).toEqual({ sessionId: SESS, subagentRef: REF });
  });

  it('does not invent fields the daemon did not send', async () => {
    // The point of the read is to report what the child is doing. A field the
    // gateway makes up becomes a fact the operator trusts.
    const { daemon } = fakeDaemon({
      resolved: { sessionId: 's', taskId: 't', title: 'x', status: 'running' },
    });
    const out = await call(daemon);
    expect(Object.keys(out.body ?? {}).sort()).toEqual([
      'sessionId',
      'status',
      'taskId',
      'title',
    ]);
  });

  it('answers 404 when the named child is gone', async () => {
    const { daemon } = fakeDaemon({ thrown: childGone(REF) });
    const out = await call(daemon);
    expect(out.status).toBe(404);
    expect(out.body?.code).toBe('subagent_not_found');
  });

  it('answers 503, not 502, when the PARENT session is unreachable', async () => {
    // Reversible, so a 502 would send someone debugging the gateway.
    const { daemon } = fakeDaemon({ thrown: parentGone() });
    const out = await call(daemon);
    expect(out.status).toBe(503);
    expect(out.body?.code).toBe('session_unreachable');
  });

  it('answers 502 for any other daemon failure', async () => {
    const { daemon } = fakeDaemon({ thrown: new Error('read refused') });
    const out = await call(daemon);
    expect(out.status).toBe(502);
    expect(out.body?.code).toBe('daemon_unavailable');
  });

  it("a 404 naming a different child is not this row's 404", async () => {
    const { daemon } = fakeDaemon({ thrown: childGone('toolu_other') });
    const out = await call(daemon);
    expect(out.status).toBe(502);
  });

  it('never echoes the daemon message, so no path can leak', async () => {
    const leaky = new DaemonHttpError(
      404,
      { code: 'session_not_found', sessionId: SESS },
      '/home/secret/user/should-not-surface',
    );
    const { daemon } = fakeDaemon({ thrown: leaky });
    const out = await call(daemon);
    const wire = JSON.stringify(out.body);
    expect(wire).not.toContain('/home/');
    expect(wire).not.toContain('should-not-surface');
  });
});
