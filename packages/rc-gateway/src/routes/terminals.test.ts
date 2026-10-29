/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminalOpenRoute, LAUNCHER_STALE_MS } from './terminals.js';
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

async function call(
  daemon: SessionDaemon,
  body: unknown,
  isMirrored: (sessionId: string) => Promise<boolean> = async () => false,
): Promise<Captured> {
  const { res, out } = fakeRes();
  const handler = createTerminalOpenRoute(
    daemon,
    log,
    {
      record: (r: Record<string, unknown>) => {
        audits.push(r);
      },
    } as never,
    {},
    isMirrored,
  );
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

  it('queues the request and reports the launcher it could not see', async () => {
    const out = await call(
      daemonWith(() => ENDPOINT),
      { sessionId: SESSION },
    );
    expect(out.status).toBe(202);
    expect(typeof out.body?.requestId).toBe('string');
    // Nothing has ever polled on this temp host, so the honest answer is
    // "never". Defaulting this to live is the optimistic direction, and the
    // optimistic direction is what had the viewer promising a window.
    expect(out.body?.launcherState).toBe('never');
    expect(out.body?.launcherSeenMsAgo).toBeNull();
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

  it('reports the launcher live once its poll has been seen', async () => {
    await log.recordPoll(0);
    const out = await call(
      daemonWith(() => ENDPOINT),
      { sessionId: SESSION },
    );
    expect(out.body?.launcherState).toBe('live');
    expect(typeof out.body?.launcherSeenMsAgo).toBe('number');
  });

  it('reports a launcher whose polls stopped, with how long ago', async () => {
    // A clock behind the route's, so the marker reads as three missed polls
    // old. This is the state that used to answer "terminal opening on the
    // host" while no window could ever arrive.
    const past = TerminalRequestLog.open(join(dir, 'terminal-requests.jsonl'), {
      now: () => Date.now() - LAUNCHER_STALE_MS - 5_000,
    });
    await past.recordPoll(0);
    const out = await call(
      daemonWith(() => ENDPOINT),
      { sessionId: SESSION },
    );
    expect(out.body?.launcherState).toBe('stale');
    expect((out.body?.launcherSeenMsAgo as number) >= LAUNCHER_STALE_MS).toBe(
      true,
    );
  });

  it('still answers 202 with the request when liveness cannot be read', async () => {
    // Liveness is reporting. A host that cannot read the marker still has to be
    // able to queue its terminal.
    await writeFile(join(dir, 'terminal-launcher-heartbeat.json'), '{oops', {
      encoding: 'utf8',
    });
    const out = await call(
      daemonWith(() => ENDPOINT),
      { sessionId: SESSION },
    );
    expect(out.status).toBe(202);
    expect(out.body?.launcherState).toBe('unreadable');
    expect(await log.readAll()).toHaveLength(1);
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

  it('answers 200 alreadyMirrored and queues nothing when a terminal is attached', async () => {
    const asked: string[] = [];
    const out = await call(
      daemonWith(() => ENDPOINT),
      { sessionId: SESSION },
      async (id) => {
        asked.push(id);
        return true;
      },
    );
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ alreadyMirrored: true, sessionId: SESSION });
    expect(asked).toEqual([SESSION]);
    expect(await log.readAll()).toEqual([]);
    expect(audits).toEqual([]);
    expect(JSON.stringify(out.body)).not.toContain('secret-tok');
  });

  it('still refuses an unknown session before looking for a mirror', async () => {
    const out = await call(
      daemonWith(() => {
        throw new UnknownSessionError(SESSION);
      }),
      { sessionId: SESSION },
      async () => true,
    );
    expect(out.status).toBe(404);
  });

  it('queues with 202 when nothing is attached to the session', async () => {
    const out = await call(
      daemonWith(() => ENDPOINT),
      { sessionId: SESSION },
      async () => false,
    );
    expect(out.status).toBe(202);
    expect(out.body?.alreadyMirrored).toBeUndefined();
    expect(await log.readAll()).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('queues with 202 when the mirror check itself fails', async () => {
    const out = await call(
      daemonWith(() => ENDPOINT),
      { sessionId: SESSION },
      async () => {
        throw new Error('boom');
      },
    );
    expect(out.status).toBe(202);
    expect(await log.readAll()).toHaveLength(1);
  });
});
