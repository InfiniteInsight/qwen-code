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
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import {
  createMidTurnMessageEnqueueRoute,
  createMidTurnMessageRemoveRoute,
  createMidTurnMessagesRoute,
  createMidTurnMessagesSendNowRoute,
  createPendingPromptRemoveRoute,
  createPendingPromptsRoute,
} from './sessionQueue.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

async function mountGateway(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.get('/session/:id/pending-prompts', createPendingPromptsRoute(daemon));
  app.delete(
    '/session/:id/pending-prompts/:promptId',
    createPendingPromptRemoveRoute(daemon, audit),
  );
  app.get('/session/:id/mid-turn-messages', createMidTurnMessagesRoute(daemon));
  app.delete(
    '/session/:id/mid-turn-messages/:messageId',
    createMidTurnMessageRemoveRoute(daemon, audit),
  );
  app.post(
    '/session/:id/mid-turn-message',
    createMidTurnMessageEnqueueRoute(daemon, audit),
  );
  app.post(
    '/session/:id/mid-turn-messages/send-now',
    createMidTurnMessagesSendNowRoute(daemon, audit),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A daemon stand-in answering on command, for the verdicts a live client
 * cannot produce (a shaped refusal, a bare 404, a thrown transport error). */
function fakeDaemon(
  behavior: 'throw' | 'ok' = 'ok',
  err?: unknown,
): {
  daemon: SessionDaemon;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const boom = () => {
    if (behavior === 'throw') throw err ?? new Error('daemon down');
  };
  return {
    calls,
    daemon: {
      getPendingPrompts: async (...args: unknown[]) => {
        calls.push({ kind: 'pendingPrompts', args });
        boom();
        return { pendingPrompts: [] };
      },
      removePendingPrompt: async (...args: unknown[]) => {
        calls.push({ kind: 'removePendingPrompt', args });
        boom();
        return { removed: true };
      },
      getMidTurnMessages: async (...args: unknown[]) => {
        calls.push({ kind: 'midTurnMessages', args });
        boom();
        return { messages: [], settledMessageIds: [], promotedMessageIds: [] };
      },
      removeMidTurnMessage: async (...args: unknown[]) => {
        calls.push({ kind: 'removeMidTurnMessage', args });
        boom();
        return { removed: true };
      },
      enqueueMidTurnMessage: async (...args: unknown[]) => {
        calls.push({ kind: 'enqueueMidTurnMessage', args });
        boom();
        return { accepted: true, messageId: 'm-2' };
      },
      sendMidTurnMessagesNow: async (...args: unknown[]) => {
        calls.push({ kind: 'sendMidTurnMessagesNow', args });
        boom();
        return { requested: true };
      },
    } as unknown as SessionDaemon,
  };
}

/** The daemon's fs-style refusal: an envelope with its own numeric status. */
function refusal(status: number, body: unknown): Error {
  return Object.assign(new Error('daemon refused'), { status, body });
}

async function call(
  base: string,
  method: string,
  url: string,
  json?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + url, {
    method,
    ...(json === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(json),
        }),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

function collectingAudit(): {
  audit: AuditRecorder;
  rows: Array<Record<string, unknown>>;
} {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    audit: {
      record: (entry: Record<string, unknown>) => {
        rows.push(entry);
      },
    } as unknown as AuditRecorder,
  };
}

describe('GET /session/:id/pending-prompts', () => {
  it('relays the daemon queue untouched, state included', async () => {
    stub = await startStubDaemon();
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await call(base, 'GET', '/session/s-1/pending-prompts');

    expect(res.status).toBe(200);
    // The running prompt and the FIFO-waiting one both appear, which is the
    // whole point: a queue the user can see is distinguishable from a lost
    // message (issue #84).
    expect(res.body['pendingPrompts']).toEqual([
      {
        promptId: 'p-run',
        text: 'the one in flight',
        queuedAt: 1700000000000,
        state: 'running',
      },
      {
        promptId: 'p-queue',
        text: 'waiting its turn',
        queuedAt: 1700000000500,
        state: 'queued',
      },
    ]);
    expect(stub.lastPendingPromptsSessionId).toBe('s-1');
  });

  it('treats an empty queue as an answer, not a failure', async () => {
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon);

    const res = await call(base, 'GET', '/session/s-1/pending-prompts');

    expect(res.status).toBe(200);
    expect(res.body['pendingPrompts']).toEqual([]);
  });

  it('maps a bare 404 to 502 queue_unsupported', async () => {
    // An older daemon has no route at all, which is a capability gap rather
    // than a queue that happens to be empty.
    const fake = fakeDaemon('throw', refusal(404, { error: 'no route' }));
    const base = await mountGateway(fake.daemon);

    const res = await call(base, 'GET', '/session/s-1/pending-prompts');

    expect(res.status).toBe(502);
    expect(res.body['code']).toBe('queue_unsupported');
  });

  it('relays a 404 that does carry an envelope', async () => {
    const fake = fakeDaemon(
      'throw',
      refusal(404, {
        errorKind: 'session_not_found',
        error: 'no such session',
      }),
    );
    const base = await mountGateway(fake.daemon);

    const res = await call(base, 'GET', '/session/nope/pending-prompts');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'no such session',
      code: 'session_not_found',
    });
  });

  it('maps a transport failure to 502 daemon_unavailable', async () => {
    const fake = fakeDaemon('throw', new Error('socket hang up'));
    const base = await mountGateway(fake.daemon);

    const res = await call(base, 'GET', '/session/s-1/pending-prompts');

    expect(res.status).toBe(502);
    expect(res.body['code']).toBe('daemon_unavailable');
  });
});

describe('DELETE /session/:id/pending-prompts/:promptId', () => {
  it('carries the session and prompt ids to the daemon and audits the session', async () => {
    const { audit, rows } = collectingAudit();
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon, audit);

    const res = await call(base, 'DELETE', '/session/s-4/pending-prompts/p-9');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
    expect(fake.calls[0]).toEqual({
      kind: 'removePendingPrompt',
      args: ['s-4', 'p-9'],
    });
    expect(rows).toEqual([{ action: 'pending_prompt_removed', target: 's-4' }]);
  });

  it('relays removed:false as a 200, since the daemon answered', async () => {
    // An id the daemon does not hold is an answer about that id, not a
    // refusal, so it must not be turned into a 404 the caller cannot act on.
    const fake = fakeDaemon();
    fake.daemon.removePendingPrompt = async () => ({ removed: false });
    const base = await mountGateway(fake.daemon);

    const res = await call(base, 'DELETE', '/session/s-1/pending-prompts/gone');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: false });
  });

  it('audits nothing when the removal failed', async () => {
    const { audit, rows } = collectingAudit();
    const fake = fakeDaemon('throw', new Error('socket hang up'));
    const base = await mountGateway(fake.daemon, audit);

    const res = await call(base, 'DELETE', '/session/s-1/pending-prompts/p-1');

    expect(res.status).toBe(502);
    expect(rows).toHaveLength(0);
  });
});

describe('GET /session/:id/mid-turn-messages', () => {
  it('relays all three snapshot fields', async () => {
    stub = await startStubDaemon();
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await call(base, 'GET', '/session/s-2/mid-turn-messages');

    expect(res.status).toBe(200);
    // The settled and promoted rings travel too: a caller reconciles against
    // them to decide whether a message may be resent.
    expect(res.body).toEqual({
      messages: [{ messageId: 'm-1', text: 'typed mid-turn' }],
      settledMessageIds: ['m-old'],
      promotedMessageIds: [],
    });
    expect(stub.lastMidTurnMessagesSessionId).toBe('s-2');
  });

  it('maps a bare 404 to 502 queue_unsupported', async () => {
    // The SDK documents that older daemons answer 404 for this route, so a
    // bare 404 is exactly that case.
    const fake = fakeDaemon('throw', refusal(404, { error: 'no route' }));
    const base = await mountGateway(fake.daemon);

    const res = await call(base, 'GET', '/session/s-1/mid-turn-messages');

    expect(res.status).toBe(502);
    expect(res.body['code']).toBe('queue_unsupported');
  });

  it('relays a shaped refusal with its hint', async () => {
    const fake = fakeDaemon(
      'throw',
      refusal(409, {
        errorKind: 'queue_full',
        error: 'too many waiting',
        hint: 'wait for the turn to end',
      }),
    );
    const base = await mountGateway(fake.daemon);

    const res = await call(base, 'GET', '/session/s-1/mid-turn-messages');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'too many waiting',
      code: 'queue_full',
      hint: 'wait for the turn to end',
    });
  });
});

describe('DELETE /session/:id/mid-turn-messages/:messageId', () => {
  it('carries the ids and audits the session', async () => {
    const { audit, rows } = collectingAudit();
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon, audit);

    const res = await call(
      base,
      'DELETE',
      '/session/s-5/mid-turn-messages/m-3',
    );

    expect(res.status).toBe(200);
    expect(fake.calls[0]).toEqual({
      kind: 'removeMidTurnMessage',
      args: ['s-5', 'm-3'],
    });
    expect(rows).toEqual([
      { action: 'mid_turn_message_withdrawn', target: 's-5' },
    ]);
  });

  it('does not audit a read', async () => {
    const { audit, rows } = collectingAudit();
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon, audit);

    await call(base, 'GET', '/session/s-1/mid-turn-messages');
    await call(base, 'GET', '/session/s-1/pending-prompts');

    expect(rows).toHaveLength(0);
  });
});

describe('POST /session/:id/mid-turn-message', () => {
  it('reaches the daemon through the SDK method name', async () => {
    // The route holds a `Pick<SessionDaemon, 'enqueueMidTurnMessage'>`, and this
    // test injects a bare DaemonClient exactly as the other route tests do. A
    // gateway-invented name would be `undefined` here and `tsc` cannot see it
    // (D61), so this call is the proof, not the type.
    stub = await startStubDaemon();
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await call(base, 'POST', '/session/s-1/mid-turn-message', {
      message: 'a thought mid-turn',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true, messageId: 'm-2' });
    expect(stub.lastEnqueueMidTurnMessage).toEqual({
      sessionId: 's-1',
      message: 'a thought mid-turn',
    });
  });

  it('carries the session, the text and the caller id, and audits the session only', async () => {
    const { audit, rows } = collectingAudit();
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon, audit);

    const res = await call(base, 'POST', '/session/s-7/mid-turn-message', {
      message: 'hold this until the tool boundary',
      messageId: 'm-9',
    });

    expect(res.status).toBe(200);
    expect(fake.calls[0]).toEqual({
      kind: 'enqueueMidTurnMessage',
      args: ['s-7', 'hold this until the tool boundary', { messageId: 'm-9' }],
    });
    expect(rows).toEqual([
      { action: 'mid_turn_message_queued', target: 's-7' },
    ]);
    // The queued text is chat content and never belongs in the audit log.
    expect(JSON.stringify(rows)).not.toContain('hold this');
  });

  it('omits the options object entirely when no id was supplied', async () => {
    // A daemon that is handed nothing at all is a different request from one
    // handed `{ messageId: undefined }`, so the route passes nothing.
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon);

    await call(base, 'POST', '/session/s-1/mid-turn-message', {
      message: 'no id this time',
    });

    expect(fake.calls[0]).toEqual({
      kind: 'enqueueMidTurnMessage',
      args: ['s-1', 'no id this time', undefined],
    });
  });

  it('relays accepted:false as a 200, since the turn ending is an answer', async () => {
    // The session went idle between the caller looking and the caller writing,
    // so the daemon declined to hold the text and said why. Turning that into a
    // 502 would hide the one action the caller can take: send it as an ordinary
    // prompt.
    const fake = fakeDaemon();
    fake.daemon.enqueueMidTurnMessage = async () => ({
      accepted: false,
      reason: 'session_idle',
    });
    const base = await mountGateway(fake.daemon);

    const res = await call(base, 'POST', '/session/s-1/mid-turn-message', {
      message: 'sent a moment too late',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: false, reason: 'session_idle' });
  });

  it('refuses an empty message without disturbing the daemon', async () => {
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon);

    const res = await call(base, 'POST', '/session/s-1/mid-turn-message', {
      message: '   ',
    });

    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('invalid_message');
    expect(fake.calls).toHaveLength(0);
  });

  it('maps a bare 404 to 502 queue_unsupported', async () => {
    // An older daemon has no write route, which is a capability gap and not a
    // queue that refused this particular message.
    const fake = fakeDaemon('throw', refusal(404, { error: 'no route' }));
    const base = await mountGateway(fake.daemon);

    const res = await call(base, 'POST', '/session/s-1/mid-turn-message', {
      message: 'to an old daemon',
    });

    expect(res.status).toBe(502);
    expect(res.body['code']).toBe('queue_unsupported');
  });

  it('relays a shaped refusal with its hint', async () => {
    const fake = fakeDaemon(
      'throw',
      refusal(409, {
        errorKind: 'queue_full',
        error: 'too many waiting',
        hint: 'wait for the turn to end',
      }),
    );
    const base = await mountGateway(fake.daemon);

    const res = await call(base, 'POST', '/session/s-1/mid-turn-message', {
      message: 'one past the cap',
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'too many waiting',
      code: 'queue_full',
      hint: 'wait for the turn to end',
    });
  });

  it('audits nothing when the message was not queued', async () => {
    const { audit, rows } = collectingAudit();
    const fake = fakeDaemon('throw', new Error('socket hang up'));
    const base = await mountGateway(fake.daemon, audit);

    const res = await call(base, 'POST', '/session/s-1/mid-turn-message', {
      message: 'nowhere to go',
    });

    expect(res.status).toBe(502);
    expect(rows).toHaveLength(0);
  });
});

describe('POST /session/:id/mid-turn-messages/send-now', () => {
  it('reaches the daemon through the SDK method name', async () => {
    stub = await startStubDaemon();
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await call(
      base,
      'POST',
      '/session/s-1/mid-turn-messages/send-now',
      {},
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requested: true });
    expect(stub.lastSendMidTurnMessagesNowSessionId).toBe('s-1');
  });

  it('relays the verdict and audits the session', async () => {
    const { audit, rows } = collectingAudit();
    const fake = fakeDaemon();
    const base = await mountGateway(fake.daemon, audit);

    const res = await call(
      base,
      'POST',
      '/session/s-8/mid-turn-messages/send-now',
      {},
    );

    expect(res.status).toBe(200);
    expect(fake.calls[0]).toEqual({
      kind: 'sendMidTurnMessagesNow',
      args: ['s-8'],
    });
    expect(rows).toEqual([
      { action: 'mid_turn_messages_sent_now', target: 's-8' },
    ]);
  });

  it('relays requested:false as a 200, since nothing was waiting', async () => {
    // `requested: false` means no user messages were waiting. That is the
    // daemon answering the question, so it must not surface as a failure the
    // operator reads as a dropped delivery.
    const fake = fakeDaemon();
    fake.daemon.sendMidTurnMessagesNow = async () => ({ requested: false });
    const base = await mountGateway(fake.daemon);

    const res = await call(
      base,
      'POST',
      '/session/s-1/mid-turn-messages/send-now',
      {},
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requested: false });
  });

  it('maps a bare 404 to 502 queue_unsupported', async () => {
    // The daemon advertises this control behind `session_mid_turn_send_now`, so
    // a daemon predating it reads as unsupported, not as a failed delivery.
    const fake = fakeDaemon('throw', refusal(404, { error: 'no route' }));
    const base = await mountGateway(fake.daemon);

    const res = await call(
      base,
      'POST',
      '/session/s-1/mid-turn-messages/send-now',
      {},
    );

    expect(res.status).toBe(502);
    expect(res.body['code']).toBe('queue_unsupported');
  });
});

describe('POST mid-turn writes against a real client and a refusing stub', () => {
  // Separate fixture from the blocks above on purpose. Those drive a
  // hand-rolled refusal object; these drive a real DaemonClient against a stub
  // configured to refuse, so the error shape is whatever the SDK's own
  // failOnError builds rather than whatever this file assumes it looks like.
  // The gateway's mapping is only trustworthy if it is checked against the
  // first.
  it('maps a daemon with no write route to 502 queue_unsupported', async () => {
    stub = await startStubDaemon({
      enqueueMidTurnMessageStatus: 404,
      enqueueMidTurnMessageErrorBody: { error: 'no route' },
    });
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await call(base, 'POST', '/session/s-1/mid-turn-message', {
      message: 'to an old daemon',
    });

    expect(res.status).toBe(502);
    expect(res.body['code']).toBe('queue_unsupported');
    // The stub records the request before it refuses, so this proves the text
    // reached the daemon and the verdict is about the daemon's answer, not
    // about a request that never left.
    expect(stub.lastEnqueueMidTurnMessage?.message).toBe('to an old daemon');
  });

  it('relays a shaped daemon refusal with its own code', async () => {
    stub = await startStubDaemon({
      enqueueMidTurnMessageStatus: 409,
      enqueueMidTurnMessageErrorBody: {
        errorKind: 'queue_full',
        error: 'too many waiting',
      },
    });
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await call(base, 'POST', '/session/s-1/mid-turn-message', {
      message: 'one past the cap',
    });

    expect(res.status).toBe(409);
    expect(res.body['code']).toBe('queue_full');
  });

  it('maps a daemon with no send-now route to 502 queue_unsupported', async () => {
    // The daemon advertises this control behind session_mid_turn_send_now, so
    // a daemon predating it must read as unsupported and not as a delivery that
    // failed, which are different actions for the operator.
    stub = await startStubDaemon({
      sendMidTurnMessagesNowStatus: 404,
      sendMidTurnMessagesNowErrorBody: { error: 'no route' },
    });
    const base = await mountGateway(
      new DaemonClient({ baseUrl: stub.baseUrl }),
    );

    const res = await call(
      base,
      'POST',
      '/session/s-1/mid-turn-messages/send-now',
      {},
    );

    expect(res.status).toBe(502);
    expect(res.body['code']).toBe('queue_unsupported');
  });
});
