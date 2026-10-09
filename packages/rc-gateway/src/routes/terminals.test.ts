/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminalOpenRoute } from './terminals.js';
import { TerminalRequestLog } from '../terminals.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';

interface Captured {
  status?: number;
  body?: Record<string, unknown>;
}

function fakeRes(): { res: unknown; out: Captured } {
  const out: Captured = {};
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(b: Record<string, unknown>) {
      out.body = b;
      return res;
    },
  };
  return { res, out };
}

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ENDPOINT = {
  url: 'http://127.0.0.1:46135',
  token: 'secret-tok',
  workspaceCwd: '/srv/work/proj',
};

let dir: string;
let log: TerminalRequestLog;
let audits: Array<Record<string, unknown>>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-term-route-'));
  log = TerminalRequestLog.open(join(dir, 'terminal-requests.jsonl'));
  audits = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function daemonWith(
  lookup: ((id: string) => unknown) | undefined,
): SessionDaemon {
  return (lookup ? { daemonEndpointForSession: lookup } : {}) as SessionDaemon;
}

async function call(daemon: SessionDaemon, body: unknown): Promise<Captured> {
  const { res, out } = fakeRes();
  const handler = createTerminalOpenRoute(daemon, log, {
    record: (r: Record<string, unknown>) => {
      audits.push(r);
    },
  } as never);
  await handler({ body, rcClient: { id: 'tok-1' } } as never, res as never);
  return out;
}

describe('POST /rc/terminals', () => {
  it('rejects a missing sessionId', async () => {
    const out = await call(
      daemonWith(() => ENDPOINT),
      {},
    );
    expect(out.status).toBe(400);
    expect(out.body?.code).toBe('invalid_request');
    expect(await log.readAll()).toEqual([]);
  });

  it('answers 501 when the daemon cannot resolve endpoints', async () => {
    const out = await call(daemonWith(undefined), { sessionId: SESSION });
    expect(out.status).toBe(501);
    expect(out.body?.code).toBe('host_terminals_unsupported');
  });

  it('404s an unknown session', async () => {
    const out = await call(
      daemonWith(() => {
        throw new UnknownSessionError(SESSION);
      }),
      { sessionId: SESSION },
    );
    expect(out.status).toBe(404);
  });

  it('409s when the daemon has no token to hand over', async () => {
    const out = await call(
      daemonWith(() => ({ ...ENDPOINT, token: undefined })),
      { sessionId: SESSION },
    );
    expect(out.status).toBe(409);
    expect(await log.readAll()).toEqual([]);
  });

  it('queues the request and returns only its id', async () => {
    const out = await call(
      daemonWith(() => ENDPOINT),
      { sessionId: SESSION },
    );
    expect(out.status).toBe(202);
    expect(typeof out.body?.requestId).toBe('string');
    // The token must never be echoed to the calling client.
    expect(JSON.stringify(out.body)).not.toContain('secret-tok');

    const queued = await log.readAll();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      sessionId: SESSION,
      daemonUrl: ENDPOINT.url,
      workspaceCwd: ENDPOINT.workspaceCwd,
      daemonToken: 'secret-tok',
    });
  });

  it('audits the session and request id without path or token', async () => {
    await call(
      daemonWith(() => ENDPOINT),
      { sessionId: SESSION },
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'terminal_requested',
      actorTokenId: 'tok-1',
      target: SESSION,
    });
    expect(JSON.stringify(audits[0])).not.toContain('secret-tok');
    expect(JSON.stringify(audits[0])).not.toContain('/srv/work/proj');
  });
});
