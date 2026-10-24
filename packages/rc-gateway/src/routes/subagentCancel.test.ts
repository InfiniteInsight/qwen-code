/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { createSubagentCancelRoute } from './subagentCancel.js';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';

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

function recorder() {
  const entries: Array<Record<string, unknown>> = [];
  const audit = {
    record: async (e: Record<string, unknown>) => {
      entries.push(e);
    },
  } as unknown as AuditRecorder;
  return { audit, entries };
}

/**
 * `thrown` is what the daemon answers, so a test can hand it the exact 404
 * shape the SDK's guards read. A refusal must be provable as a refusal, not
 * inferred from a status code that several causes share.
 */
function fakeDaemon(behaviour: { cancelled?: boolean; thrown?: unknown } = {}) {
  const calls: Array<{ sessionId: string; subagentRef: string }> = [];
  const daemon = {
    cancelSubagentSession: async (sessionId: string, subagentRef: string) => {
      calls.push({ sessionId, subagentRef });
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return { cancelled: behaviour.cancelled ?? true };
    },
  } as unknown as SessionDaemon;
  return { daemon, calls };
}

async function call(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  params = { id: SESS, subagentRef: REF },
): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = { params, rcClient: { id: 'tok_test' } } as unknown as Request;
  await createSubagentCancelRoute(daemon, audit)(req, res, () => {});
  return captured;
}

/** The daemon's own 404 for one named child: body carries the toolCallId. */
function childGone(ref: string) {
  return new DaemonHttpError(
    404,
    { code: 'session_not_found', sessionId: SESS, toolCallId: ref },
    'No such subagent',
  );
}

/** The daemon's session-level 404: same code, no identifying toolCallId. */
function parentGone() {
  return new DaemonHttpError(
    404,
    { code: 'session_not_found', sessionId: SESS },
    'No such session',
  );
}

describe('POST /session/:id/subagents/:subagentRef/cancel (#110)', () => {
  it('cancels and audits, passing the daemon verdict through', async () => {
    const { daemon, calls } = fakeDaemon();
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      subagentRef: REF,
      cancelled: true,
    });
    expect(calls[0]).toEqual({ sessionId: SESS, subagentRef: REF });
    expect(entries[0]).toMatchObject({
      action: 'subagent_cancelled',
      actorTokenId: 'tok_test',
      target: SESS + ':' + REF,
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

  it('answers 404 when the named child is gone', async () => {
    const { daemon } = fakeDaemon({ thrown: childGone(REF) });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(404);
    expect(out.body?.code).toBe('subagent_not_found');
    expect(entries[0]).toMatchObject({
      action: 'subagent_cancel_failed',
      detail: { reason: 'subagent_not_found' },
    });
  });

  it('answers 503, not 502, when the PARENT session is unreachable', async () => {
    // The same 404 code with no toolCallId also means the owning workspace
    // runtime is merely not active, which is reversible. Blaming the gateway
    // with a 502 would send someone debugging the wrong thing.
    const { daemon } = fakeDaemon({ thrown: parentGone() });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(503);
    expect(out.body?.code).toBe('session_unreachable');
    expect(entries[0]).toMatchObject({
      action: 'subagent_cancel_failed',
      detail: { reason: 'session_unreachable' },
    });
  });

  it('answers 502 for any other daemon failure', async () => {
    const { daemon } = fakeDaemon({ thrown: new Error('/cancel refused') });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(502);
    expect(out.body?.code).toBe('daemon_unavailable');
    expect(entries[0]).toMatchObject({
      action: 'subagent_cancel_failed',
      detail: { reason: 'daemon_unavailable' },
    });
  });

  it('never echoes the daemon message, so no path can leak', async () => {
    const leaky = new DaemonHttpError(
      404,
      { code: 'session_not_found', sessionId: SESS },
      '/home/secret/user/should-not-surface',
    );
    const { daemon } = fakeDaemon({ thrown: leaky });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    const wire = JSON.stringify(out.body) + JSON.stringify(entries);
    expect(wire).not.toContain('/home/');
    expect(wire).not.toContain('should-not-surface');
  });

  it("a 404 naming a different child is not this row's 404", async () => {
    // The guard takes the ref so another agent's absence cannot answer for
    // this one; it falls through to the generic verdict instead.
    const { daemon } = fakeDaemon({ thrown: childGone('toolu_other') });
    const out = await call(daemon);
    expect(out.status).toBe(502);
  });
});
