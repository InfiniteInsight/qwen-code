/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { BTW_MAX_INPUT_LENGTH } from '@qwen-code/qwen-code-core';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { createSessionBtwRoute } from './sessionBtw.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/**
 * The relay path runs a real `DaemonClient` against the stub, so the request
 * the daemon receives is built by the SDK's own `btwSession` rather than by
 * this file. That is the difference between proving the daemon was handed the
 * caller's question and proving only that something was called.
 */
async function mountGateway(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post('/session/:id/btw', createSessionBtwRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';
const QUESTION = 'why did the paging skip a row';
// Text the daemon derived from the conversation. It must never reach the audit
// record, so it has to be something a passing assertion can search for.
const SECRET_ANSWER =
  'the offset was computed before the filter narrowed the set';
// The daemon's own bound, imported rather than copied, by the route and by
// this file alike: a bump upstream moves both with it instead of leaving a
// number behind that quietly no longer matches anything.
const CAP = BTW_MAX_INPUT_LENGTH;

function recorder() {
  const entries: Array<Record<string, unknown>> = [];
  const audit = {
    record: async (e: Record<string, unknown>) => {
      entries.push(e);
    },
  } as unknown as AuditRecorder;
  return { audit, entries };
}

/** A daemon that answers with a chosen outcome, for the verdicts a live
 * client cannot produce (the pool having dropped the session). */
function fakeDaemon(
  behaviour: { result?: unknown; thrown?: unknown } = {},
): SessionDaemon {
  return {
    btwSession: async () => {
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return behaviour.result ?? { sessionId: SID, answer: SECRET_ANSWER };
    },
  } as unknown as SessionDaemon;
}

function fakeReq(opts: {
  params?: Record<string, string>;
  body?: unknown;
}): express.Request {
  return {
    params: opts.params ?? { id: SID },
    query: {},
    body: opts.body,
    rcClient: { id: 'tok_test' },
  } as unknown as express.Request;
}

/**
 * A response that can be hung up on. The route listens for `close` on the
 * RESPONSE, because that is the only event that distinguishes an answer that
 * was delivered from a connection that died early, so the only way to exercise
 * the hang-up path is to own this emitter and decide when the caller leaves.
 * `writableEnded` stays false until something writes, which is what the route
 * reads to tell the two cases apart.
 */
function fakeRes(): express.Response & {
  code?: number;
  body?: unknown;
  emitClose(): void;
} {
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    status(code: number) {
      this.code = code;
      // Writing an answer is what makes a later `close` ordinary rather than
      // a hang-up, so the flag moves with the code the route chose.
      this.writableEnded = true;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    writableEnded: false,
    emitClose() {
      emitter.emit('close');
    },
  });
  return res as unknown as express.Response & {
    code?: number;
    body?: unknown;
    emitClose(): void;
  };
}

async function callRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  opts: { res?: ReturnType<typeof fakeRes>; req?: express.Request } = {},
) {
  const res = opts.res ?? fakeRes();
  const request = opts.req ?? fakeReq({ body: { question: QUESTION } });
  await createSessionBtwRoute(daemon, audit)(request, res, () => undefined);
  return { status: res.code, body: res.body };
}

async function ask(
  url: string,
  sessionId: string,
  question: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}/session/${sessionId}/btw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(question === undefined ? {} : { question }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe('POST /session/:id/btw', () => {
  it('relays the answer pair the daemon served', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await ask(url, SID, QUESTION);
    expect(out.status).toBe(200);
    // The pair arrives as the daemon wrote it. A gateway that re-stamped the
    // session id, or substituted its own text for the answer, would leave the
    // reader unable to tell which conversation the answer describes.
    expect(out.body.sessionId).toBe(SID);
    expect(typeof out.body.answer).toBe('string');
    expect((out.body.answer as string).length).toBeGreaterThan(0);
  });

  it('hands the daemon the named session and the caller own words', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await ask(url, SID, QUESTION);
    expect(out.status).toBe(200);
    // Both halves matter. The id proves the gateway asked about the
    // conversation in the URL rather than another one; the question proves it
    // forwarded what was typed rather than a paraphrase of it.
    expect(stub.lastBtwSessionId).toBe(SID);
    expect(stub.lastBtwQuestion).toBe(QUESTION);
  });

  it('keeps a null answer a 200, not a failure', async () => {
    // `answer` is `string | null` by contract. The gateway cannot tell "the
    // model had nothing to say" apart from a failure, so it relays the pair
    // rather than inventing an error the daemon did not raise.
    stub = await startStubDaemon({
      workspaceCwd: '/proj',
      btwResult: { sessionId: SID, answer: null },
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await ask(url, SID, QUESTION);
    expect(out.status).toBe(200);
    expect(out.body.answer).toBeNull();
  });

  it('reports a daemon with no btw route as unsupported, not as a missing conversation', async () => {
    // A bare 404 is what a daemon from before this route existed answers.
    // Saying `session_not_found` would send the reader to look for a
    // conversation that is still there.
    stub = await startStubDaemon({ workspaceCwd: '/proj', btwStatusCode: 404 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await ask(url, SID, QUESTION);
    expect(out.status).toBe(502);
    expect(out.body.code).toBe('btw_unsupported');
  });

  it('reports the session guard 404 as recoverable, not as a missing conversation', async () => {
    // The other 404, and the reason this route cannot copy the recap route's
    // single reading. The daemon answers this shape for an id it cannot
    // resolve AND for an owning workspace that is merely mid drain, which the
    // SDK documents as reversible, so the gateway must not claim the
    // conversation is gone.
    stub = await startStubDaemon({
      workspaceCwd: '/proj',
      btwStatusCode: 404,
      btwResult: {
        error: `No session with id "${SID}"`,
        code: 'session_not_found',
        sessionId: SID,
      },
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await ask(url, SID, QUESTION);
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('session_not_loaded');
    // And it must not be the unsupported code either: the daemon has the
    // route, it just could not act on this conversation right now.
    expect(out.body.code).not.toBe('btw_unsupported');
  });

  it('tells the two 404s apart rather than collapsing them', async () => {
    // The pair, side by side through the same route and the same status, so
    // the discrimination is what is being asserted rather than one outcome.
    const bare = await callRoute(
      fakeDaemon({
        thrown: new DaemonHttpError(404, { error: 'Not Found' }, 'x'),
      }),
    );
    expect(bare.status).toBe(502);
    expect(bare.body).toEqual({
      error: 'Daemon does not support side questions',
      code: 'btw_unsupported',
    });

    const guarded = await callRoute(
      fakeDaemon({
        thrown: new DaemonHttpError(
          404,
          { error: 'gone', code: 'session_not_found', sessionId: SID },
          'x',
        ),
      }),
    );
    expect(guarded.status).toBe(409);
    expect(guarded.body).toEqual({
      error: 'This conversation is not answering right now',
      code: 'session_not_loaded',
    });
  });

  it('rejects a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const out = await ask(url, 'not-an-id', QUESTION);
    expect(out.status).toBe(404);
    expect(out.body.code).toBe('session_not_found');
    // A malformed id must never cost a model call.
    expect(stub.lastBtwSessionId).toBeUndefined();
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['not a string', 42],
  ])(
    'refuses a question that is %s before any daemon call',
    async (_label, question) => {
      stub = await startStubDaemon({ workspaceCwd: '/proj' });
      const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
      const url = await mountGateway(daemon);

      const out = await ask(url, SID, question);
      expect(out.status).toBe(400);
      expect(out.body.code).toBe('question_invalid');
      // Refused locally, so the daemon was never reached and no tokens were
      // spent on a question that could not have been asked.
      expect(stub.lastBtwSessionId).toBeUndefined();
    },
  );

  it('refuses an over-long question using the daemon own bound', async () => {
    stub = await startStubDaemon({ workspaceCwd: '/proj' });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    // One over the line, measured against the live constant rather than a
    // number copied into this file, so the bound cannot drift from the
    // daemon's unnoticed.
    expect(CAP).toBe(4096);
    const out = await ask(url, SID, 'x'.repeat(CAP + 1));
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('question_invalid');
    expect(stub.lastBtwSessionId).toBeUndefined();

    // And a question at the bound is not refused, which is what proves the
    // check is a bound rather than an accident of the string used above.
    const at = await ask(url, SID, 'x'.repeat(CAP));
    expect(at.status).toBe(200);
    expect(stub.lastBtwQuestion).toBe('x'.repeat(CAP));
  });

  it('says session_not_loaded when the pool no longer holds the session', async () => {
    const out = await callRoute(
      fakeDaemon({ thrown: new UnknownSessionError(SID) }),
    );
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: 'Open this conversation before asking it a side question',
      code: 'session_not_loaded',
    });
  });

  it('passes a daemon rejection that is not a missing route through', async () => {
    const out = await callRoute(
      fakeDaemon({ thrown: new DaemonHttpError(429, {}, 'slow down') }),
    );
    expect(out.status).toBe(429);
    expect(out.body).toEqual({
      error: 'Daemon rejected the side question',
      code: 'daemon_rejected',
    });
  });

  it('falls through to 502 for a daemon failure that is not a verdict', async () => {
    const out = await callRoute(
      fakeDaemon({ thrown: new DaemonHttpError(500, {}, 'boom') }),
    );
    expect(out.status).toBe(502);
    expect(out.body).toEqual({
      error: 'Daemon unavailable',
      code: 'daemon_unavailable',
    });
  });

  it('stops the generation when the caller hangs up', async () => {
    // The reason this route exists in this shape. A side answer has nowhere to
    // wait: it is not in the transcript and not in any store, so finishing it
    // for a caller that has gone produces a fact nobody will read, at the cost
    // of the tokens it took. The daemon already stops when its caller hangs
    // up, and the gateway is that caller, so the abort has to be threaded.
    let sawSignal: AbortSignal | undefined;
    let released: (() => void) | undefined;
    const daemon = {
      btwSession: async (
        _id: string,
        _q: string,
        opts?: { signal?: AbortSignal },
      ) => {
        sawSignal = opts?.signal;
        // The generation is in flight when the caller hangs up, which is the
        // only moment the distinction is testable.
        await new Promise<void>((resolve) => {
          released = resolve;
          opts?.signal?.addEventListener('abort', () => resolve());
        });
        throw new DOMException('aborted', 'AbortError');
      },
    } as unknown as SessionDaemon;

    const res = fakeRes();
    const pending = callRoute(daemon, undefined, { res });
    // The handler runs synchronously as far as the daemon call, so the signal
    // is already in hand and must not be aborted yet: the caller is still
    // listening, and a route that cancelled its own call here could never
    // answer anything.
    expect(sawSignal).toBeDefined();
    expect(sawSignal?.aborted).toBe(false);
    // The caller leaves mid-generation. Nothing was written, so this close is
    // a hang-up rather than an ordinary end of response.
    res.emitClose();
    await new Promise((r) => setTimeout(r, 0));
    released?.();
    const out = await pending;

    expect(sawSignal?.aborted).toBe(true);
    // And a hang-up is not a failure to report. The response is unsendable and
    // the caller has moved on, so nothing is written.
    expect(out.status).toBeUndefined();
    expect(out.body).toBeUndefined();
  });

  it('leaves the signal alone while the caller is still listening', async () => {
    // The mirror of the test above, and the one that keeps the first honest:
    // a request nobody hung up on must arrive unaborted, or the route would
    // cancel its own calls and this feature could never answer anything.
    let sawSignal: AbortSignal | undefined;
    const daemon = {
      btwSession: async (
        _id: string,
        _q: string,
        opts?: { signal?: AbortSignal },
      ) => {
        sawSignal = opts?.signal;
        return { sessionId: SID, answer: SECRET_ANSWER };
      },
    } as unknown as SessionDaemon;

    const out = await callRoute(daemon);
    expect(out.status).toBe(200);
    expect(sawSignal).toBeDefined();
    expect(sawSignal?.aborted).toBe(false);
  });

  it('audits the answer by naming the session, never the answer', async () => {
    const { audit, entries } = recorder();
    const out = await callRoute(fakeDaemon(), audit);
    expect(out.status).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'session_btw_answered',
      actorTokenId: 'tok_test',
      target: SID,
    });
    // The question is the caller's words and the answer is a reduction of the
    // conversation. The record may say an answer was produced and about which
    // session; it may not carry either text.
    const row = JSON.stringify(entries[0]);
    expect(row).not.toContain(SECRET_ANSWER);
    expect(row).not.toContain(QUESTION);
  });

  it('writes no audit row when the daemon had nothing to say', async () => {
    // A null answer is not an achievement worth recording.
    const { audit, entries } = recorder();
    const out = await callRoute(
      fakeDaemon({ result: { sessionId: SID, answer: null } }),
      audit,
    );
    expect(out.status).toBe(200);
    expect(entries).toHaveLength(0);
  });
});
