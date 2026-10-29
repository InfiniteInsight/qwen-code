/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DaemonPool driven through the REAL SDK `DaemonClient` against a fake daemon
 * on a real loopback socket. The two behaviours under test here depend on
 * what the SDK and undici actually surface (the error shape of a torn-down SSE
 * body, the `DaemonHttpError` body of a 404), so a hand-built fake error would
 * test the fake rather than the gateway.
 *
 * - Issue #153: the daemon evicts a slow SSE subscriber by writing
 *   `client_evicted` and then destroying the socket
 *   (cli/src/serve/routes/sse-events.ts). That reaches the pool as
 *   `TypeError: terminated` with an `UND_ERR_SOCKET` cause, the same shape a
 *   dead daemon produces, while the daemon is alive and still holds the
 *   session.
 * - Issue #154: the daemon's own reaper closes sessions nobody is subscribed
 *   to, so no `session_closed` frame ever reaches the pool. The daemon's
 *   answer for such an id is `GET /session/:id/status` -> 404
 *   `session_not_found`.
 */

import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient } from '@qwen-code/sdk';
import { DaemonPool, type DaemonExitInfo } from './daemonPool.js';

interface FakeDaemon {
  url: string;
  server: http.Server;
  close: () => Promise<void>;
}

const running: FakeDaemon[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((d) => d.close()));
});

async function startFakeDaemon(
  handler: http.RequestListener,
): Promise<FakeDaemon> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as { port: number };
  const daemon: FakeDaemon = {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  running.push(daemon);
  return daemon;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The daemon's `formatSseFrame` shape: the whole event, id included, on one
 * `data:` line, plus an `id:` line when the event has one. */
function sseFrame(type: string, id?: number, data: unknown = {}): string {
  const event =
    id === undefined ? { v: 1, type, data } : { id, v: 1, type, data };
  const head = id === undefined ? '' : `id: ${id}\n`;
  return `${head}data: ${JSON.stringify(event)}\n\n`;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
};

/** The pool-facing client: session creation is faked (it is not under test),
 * while every call these tests are about goes over the socket through the
 * real SDK. */
function pooledClient(
  real: DaemonClient,
  sessionId: string,
  cwd: string,
): DaemonClient {
  return {
    async createOrAttachSession() {
      return { sessionId, workspaceCwd: cwd, attached: false };
    },
    subscribeEvents: (
      id: string,
      opts?: Parameters<DaemonClient['subscribeEvents']>[1],
    ) => real.subscribeEvents(id, opts),
    health: () => real.health(),
    sessionStatus: (id: string, clientId?: string) =>
      real.sessionStatus(id, clientId),
  } as unknown as DaemonClient;
}

interface Death {
  key: string;
  sessions: string[];
}

function poolOn(
  daemon: FakeDaemon,
  opts: { sessionId?: string; defaultOnDaemon?: boolean } = {},
) {
  const sessionId = opts.sessionId ?? 's1';
  const real = new DaemonClient({ baseUrl: daemon.url });
  const deaths: Death[] = [];
  const stopped: string[] = [];
  const spawned: string[] = [];
  const pool = new DaemonPool({
    defaultDaemon: opts.defaultOnDaemon
      ? pooledClient(real, sessionId, '/home/evan')
      : ({} as DaemonClient),
    defaultWorkspaceCwd: '/home/evan',
    idleReapMs: 999_999_999,
    spawn: async (cwd) => {
      spawned.push(cwd);
      return {
        client: pooledClient(real, sessionId, cwd),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      };
    },
    onDaemonDeath: (key, sessions) => deaths.push({ key, sessions }),
  });
  return { pool, deaths, stopped, spawned };
}

async function drain(
  it: AsyncGenerator<{ type: string; id?: number }>,
): Promise<{
  types: string[];
  ids: Array<number | undefined>;
  error?: unknown;
}> {
  const types: string[] = [];
  const ids: Array<number | undefined> = [];
  try {
    for await (const ev of it) {
      types.push(ev.type);
      ids.push(ev.id);
    }
    return { types, ids };
  } catch (error) {
    return { types, ids, error };
  }
}

describe('DaemonPool subscription loss vs daemon death (#153)', () => {
  it('an eviction (client_evicted, then destroy in the same tick) is not a daemon death; the re-subscribe reaches the same daemon', async () => {
    const lastEventIds: Array<string | undefined> = [];
    const daemon = await startFakeDaemon((req, res) => {
      if (req.url === '/health') return json(res, 200, { status: 'ok' });
      if (req.url?.startsWith('/session/s1/events')) {
        const cursor = req.headers['last-event-id'];
        lastEventIds.push(typeof cursor === 'string' ? cursor : undefined);
        res.writeHead(200, SSE_HEADERS);
        if (lastEventIds.length === 1) {
          res.write(sseFrame('agent_message_chunk', 1));
          // Byte-for-byte the daemon's eviction (sse-events.ts): the frame
          // write and the destroy share one tick.
          setTimeout(() => {
            res.write(
              sseFrame('client_evicted', undefined, { droppedAfter: 1 }),
            );
            res.destroy();
          }, 30);
        } else {
          res.end(sseFrame('agent_message_chunk', 2));
        }
        return;
      }
      json(res, 404, { error: 'not found' });
    });
    const { pool, deaths, stopped, spawned } = poolOn(daemon);
    await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });

    const first = await drain(pool.subscribeEvents('s1', {}));
    // The stream still ends in an error: that is what makes every consumer
    // (events relay, push pump, review bridge) re-subscribe with its own
    // backoff. A clean end would make the review bridge stop listening.
    expect(first.error).toBeDefined();
    expect(first.types).toEqual(['agent_message_chunk']);

    // The daemon is alive and still holds the session: nothing died.
    expect(deaths).toEqual([]);
    expect(pool.size()).toBe(1);
    expect(pool.workspaces()).toEqual(['/proj/a']);
    expect(stopped).toEqual([]);

    // The consumer's re-subscribe resumes from its cursor on the SAME daemon.
    const second = await drain(pool.subscribeEvents('s1', { lastEventId: 1 }));
    expect(second.error).toBeUndefined();
    expect(second.ids).toEqual([2]);
    expect(lastEventIds).toEqual([undefined, '1']);
    expect(spawned).toEqual(['/proj/a']); // never a second daemon
  });

  it('relays a client_evicted frame that reaches the socket, and needs no health check to call it a subscription loss', async () => {
    let healthHits = 0;
    const daemon = await startFakeDaemon((req, res) => {
      if (req.url === '/health') {
        // A probe here would read as a dead daemon. The frame alone has to
        // settle it.
        healthHits++;
        req.socket.destroy();
        return;
      }
      if (req.url?.startsWith('/session/s1/events')) {
        res.writeHead(200, SSE_HEADERS);
        res.write(sseFrame('agent_message_chunk', 1));
        setTimeout(() => {
          res.write(sseFrame('client_evicted', undefined, { droppedAfter: 1 }));
          // A later tick, so the frame is flushed before the teardown.
          setTimeout(() => res.destroy(), 30);
        }, 30);
        return;
      }
      json(res, 404, { error: 'not found' });
    });
    const { pool, deaths } = poolOn(daemon);
    await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });

    const out = await drain(pool.subscribeEvents('s1', {}));
    expect(out.types).toEqual(['agent_message_chunk', 'client_evicted']);
    expect(out.error).toBeDefined();
    expect(deaths).toEqual([]);
    expect(pool.size()).toBe(1);
    expect(healthHits).toBe(0);
  });

  it('a stream torn down by a daemon that no longer answers is still a death', async () => {
    const daemon = await startFakeDaemon((req, res) => {
      if (req.url === '/health') return json(res, 200, { status: 'ok' });
      if (req.url?.startsWith('/session/s1/events')) {
        res.writeHead(200, SSE_HEADERS);
        res.write(sseFrame('agent_message_chunk', 1));
        setTimeout(() => {
          // The process goes away: listener closed, every socket dropped.
          daemon.server.close();
          daemon.server.closeAllConnections();
        }, 30);
        return;
      }
      json(res, 404, { error: 'not found' });
    });
    const { pool, deaths } = poolOn(daemon);
    await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });

    const out = await drain(pool.subscribeEvents('s1', {}));
    expect(out.error).toBeDefined();
    expect(deaths).toEqual([{ key: '/proj/a', sessions: ['s1'] }]);
    expect(pool.size()).toBe(0);
  });

  it('an eviction on the default workspace does not use up the boot daemon death latch', async () => {
    const daemon = await startFakeDaemon((req, res) => {
      if (req.url === '/health') return json(res, 200, { status: 'ok' });
      if (req.url?.startsWith('/session/s1/events')) {
        res.writeHead(200, SSE_HEADERS);
        res.write(sseFrame('agent_message_chunk', 1));
        setTimeout(() => {
          res.write(sseFrame('client_evicted', undefined, { droppedAfter: 1 }));
          res.destroy();
        }, 30);
        return;
      }
      json(res, 404, { error: 'not found' });
    });
    const { pool, deaths } = poolOn(daemon, { defaultOnDaemon: true });
    await pool.createOrAttachSession({}); // routed to the boot daemon

    const out = await drain(pool.subscribeEvents('s1', {}));
    expect(out.error).toBeDefined();
    expect(deaths).toEqual([]);

    // A REAL boot daemon death afterwards is still reported.
    const exit: DaemonExitInfo = { code: 1, signal: null };
    pool.handleDaemonExit('/home/evan', exit);
    expect(deaths).toEqual([{ key: '/home/evan', sessions: ['s1'] }]);
  });
});

describe('DaemonPool and the keep-alive race on request/response calls (#203)', () => {
  it('a call whose reused socket the daemon closes, with no response, is not a daemon death', async () => {
    let statusHits = 0;
    let healthHits = 0;
    const daemon = await startFakeDaemon((req, res) => {
      if (req.url === '/health') {
        healthHits++;
        return json(res, 200, { status: 'ok' });
      }
      if (req.url === '/session/s1/status') {
        statusHits++;
        if (statusHits === 2) {
          // The keep-alive race as the client sees it: the request went out
          // on an idle socket the daemon was closing, and no response comes
          // back on it. The daemon itself is fine.
          req.socket.destroy();
          return;
        }
        return json(res, 200, { sessionId: 's1', workspaceCwd: '/proj/a' });
      }
      json(res, 404, { error: 'not found' });
    });
    const { pool, deaths, stopped, spawned } = poolOn(daemon);
    await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });

    await pool.sessionStatus('s1'); // leaves an idle keep-alive socket
    const err = await pool.sessionStatus('s1').then(
      () => undefined,
      (e: unknown) => e,
    );
    // The SDK hands the pool undici's own shape, not a daemon answer.
    expect(err).toBeInstanceOf(TypeError);
    expect(((err as { cause?: { code?: unknown } }).cause ?? {}).code).toBe(
      'UND_ERR_SOCKET',
    );

    expect(healthHits).toBe(1); // the one confirming probe
    expect(deaths).toEqual([]);
    expect(pool.size()).toBe(1);
    expect(stopped).toEqual([]);
    // The next call reaches the same daemon; nothing was respawned.
    await expect(pool.sessionStatus('s1')).resolves.toMatchObject({
      sessionId: 's1',
    });
    expect(spawned).toEqual(['/proj/a']);
  });
});

describe('DaemonPool reconciles against sessions the daemon reaped (#154)', () => {
  it('drops an id the daemon answers 404 session_not_found for, keeps one it holds or will not say, and reclaims the idle daemon', async () => {
    const daemon = await startFakeDaemon((req, res) => {
      const m = /^\/session\/([^/]+)\/status$/.exec(req.url ?? '');
      if (m && m[1] === 'reaped-1') {
        // Exactly what the daemon's status route sends for an id its reaper
        // already closed (SessionNotFoundError -> sendBridgeError).
        return json(res, 404, {
          error: 'No session with id "reaped-1"',
          code: 'session_not_found',
          sessionId: 'reaped-1',
        });
      }
      if (m && m[1] === 'live-1') {
        return json(res, 200, { sessionId: 'live-1', workspaceCwd: '/proj/b' });
      }
      if (m && m[1] === 'unsure-1') {
        // A 404 that is not about the session (no route, a proxy): not an
        // answer about this id.
        return json(res, 404, { error: 'Not Found' });
      }
      json(res, 404, { error: 'not found' });
    });
    const real = new DaemonClient({ baseUrl: daemon.url });
    let t = 0;
    const stopped: string[] = [];
    const ids: Record<string, string> = {
      '/proj/a': 'reaped-1',
      '/proj/b': 'live-1',
      '/proj/c': 'unsure-1',
    };
    const pool = new DaemonPool({
      defaultDaemon: {} as DaemonClient,
      defaultWorkspaceCwd: '/home/evan',
      maxDaemons: 3,
      idleReapMs: 1000,
      now: () => t,
      spawn: async (cwd) => ({
        client: pooledClient(real, ids[cwd]!, cwd),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });
    await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await pool.createOrAttachSession({ workspaceCwd: '/proj/b' });
    await pool.createOrAttachSession({ workspaceCwd: '/proj/c' });

    t = 10 * 60 * 60_000; // ten idle hours: well past the daemon's reaper
    await pool.reapIdle();

    expect(stopped).toEqual(['/proj/a']);
    expect(pool.workspaces().sort()).toEqual(['/proj/b', '/proj/c']);
    // The freed slot takes a new workspace instead of a 503.
    await pool.getOrSpawn('/proj/d');
    expect(pool.size()).toBe(3);
  });
});
