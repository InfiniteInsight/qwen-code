/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { createSubagentMessageRoute } from './subagentMessage.js';
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

function fakeDaemon(
  behaviour: {
    delivered?: boolean;
    action?: 'queued' | 'resumed' | 'continued';
    status?: string;
    reason?: string;
    thrown?: unknown;
  } = {},
) {
  const calls: Array<{
    sessionId: string;
    subagentRef: string;
    message: string;
  }> = [];
  const daemon = {
    messageSubagentSession: async (
      sessionId: string,
      subagentRef: string,
      message: string,
    ) => {
      calls.push({ sessionId, subagentRef, message });
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return {
        delivered: behaviour.delivered ?? true,
        ...(behaviour.action ? { action: behaviour.action } : {}),
        ...(behaviour.status ? { status: behaviour.status } : {}),
        ...(behaviour.reason ? { reason: behaviour.reason } : {}),
      };
    },
  } as unknown as SessionDaemon;
  return { daemon, calls };
}

async function call(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  body: unknown = { message: 'focus on src/routes' },
  params = { id: SESS, subagentRef: REF },
): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = {
    params,
    body,
    rcClient: { id: 'tok_test' },
  } as unknown as Request;
  await createSubagentMessageRoute(daemon, audit)(req, res, () => {});
  return captured;
}

function childGoneAsTheDaemonSendsIt(ref: string) {
  return new DaemonHttpError(
    404,
    { code: 'session_not_found', sessionId: SESS, subagentRef: ref },
    'Subagent session not found',
  );
}

function parentGone() {
  return new DaemonHttpError(
    404,
    { code: 'session_not_found', sessionId: SESS },
    'No such session',
  );
}

describe('POST /session/:id/subagents/:subagentRef/message', () => {
  it('messages and audits without recording the message text', async () => {
    const { daemon, calls } = fakeDaemon({
      delivered: true,
      action: 'queued',
      status: 'running',
    });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit, {
      message: '  check the status line  ',
    });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      subagentRef: REF,
      delivered: true,
      action: 'queued',
      status: 'running',
    });
    expect(calls[0]).toEqual({
      sessionId: SESS,
      subagentRef: REF,
      message: 'check the status line',
    });
    expect(entries[0]).toMatchObject({
      action: 'subagent_messaged',
      actorTokenId: 'tok_test',
      target: SESS + ':' + REF,
      detail: { deliveryAction: 'queued' },
    });
    expect(JSON.stringify(entries)).not.toContain('check the status line');
  });

  it('rejects an empty or missing message with 400 invalid_message', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, undefined, { message: '   ' });
    expect(out.status).toBe(400);
    expect(out.body?.code).toBe('invalid_message');
    expect(calls).toHaveLength(0);
  });

  it('passes through delivered:false and audits as subagent_message_failed', async () => {
    const { daemon } = fakeDaemon({
      delivered: false,
      status: 'cancelled',
      reason: 'status_cancelled',
    });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      sessionId: SESS,
      subagentRef: REF,
      delivered: false,
      status: 'cancelled',
      reason: 'status_cancelled',
    });
    expect(entries[0]).toMatchObject({
      action: 'subagent_message_failed',
      detail: { reason: 'status_cancelled' },
    });
  });

  it('answers 404 when the named child is gone', async () => {
    const { daemon } = fakeDaemon({
      thrown: childGoneAsTheDaemonSendsIt(REF),
    });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(404);
    expect(out.body?.code).toBe('subagent_not_found');
    expect(entries[0]).toMatchObject({
      action: 'subagent_message_failed',
      detail: { reason: 'subagent_not_found' },
    });
  });

  it('answers 503 when the parent session is unreachable', async () => {
    const { daemon } = fakeDaemon({ thrown: parentGone() });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(503);
    expect(out.body?.code).toBe('session_unreachable');
    expect(entries[0]).toMatchObject({
      action: 'subagent_message_failed',
      detail: { reason: 'session_unreachable' },
    });
  });

  it('answers 502 for any other daemon failure', async () => {
    const { daemon } = fakeDaemon({ thrown: new Error('/message refused') });
    const { audit, entries } = recorder();
    const out = await call(daemon, audit);
    expect(out.status).toBe(502);
    expect(out.body?.code).toBe('daemon_unavailable');
    expect(entries[0]).toMatchObject({
      action: 'subagent_message_failed',
      detail: { reason: 'daemon_unavailable' },
    });
  });
});
