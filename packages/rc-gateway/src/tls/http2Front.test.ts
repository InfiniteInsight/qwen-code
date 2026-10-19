/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the HTTP/2 front: boots the real front listener with a
 * real express app and drives it with the real node:http2 and node:https
 * clients. Hermetic, no external service, runs in any lane.
 *
 * The cases are not decoration. Each pins a failure that was measured while
 * choosing this design: feeding the express app to `http2.createSecureServer`
 * directly hangs every route, the fallthrough case is the exact path that hangs,
 * the event-stream case pins that frames are not batched to end of turn, and the
 * peer cases pin that the loopback hop does not turn remote clients into
 * loopback clients.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  connect as h2connect,
  constants as H2,
  type ClientHttp2Session,
} from 'node:http2';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import {
  createHttp2Front,
  forwardedPeer,
  FRONT_ATTESTATION,
  PEER_HEADER,
  type FrontListener,
} from './http2Front.js';
import {
  LOCALHOST_TEST_CERT,
  LOCALHOST_TEST_KEY,
} from '../nativePush/testfixtures/localhostTls.js';

let front: FrontListener | undefined;

afterEach(async () => {
  if (front) await front.close();
  front = undefined;
});

interface Inner {
  app: express.Express;
  /** Count of client aborts the inner app observed, which the hop must carry. */
  aborted: number;
}

/** Echoes what the inner app can see, which is what the hop must not corrupt. */
function buildInner(): Inner {
  const app = express();
  const state: Inner = { app, aborted: 0 };

  app.use(express.json());

  app.get('/probe', (req, res) => {
    res.status(200).json({
      ok: true,
      // Must be a real TCP socket able to set TCP_NODELAY: this is why the
      // design hops rather than feeding the app to the compat API.
      hasSocket: typeof req.socket?.setNoDelay === 'function',
      socketPeer: req.socket?.remoteAddress ?? null,
      peer: forwardedPeer(req) ?? null,
      method: req.method,
      path: req.path,
      query: req.query.v ?? null,
      forged: req.headers['x-forged'] ?? null,
      cookie: req.headers.cookie ?? null,
    });
  });

  app.post('/echo', (req, res) => {
    res.status(201).json({ got: req.body ?? null });
  });

  // Falls through every handler to express's own finalizer, which calls
  // req.resume(). That call is what deadlocks the compat API.
  app.get('/fallthrough', (_req, _res, next) => next());

  app.get('/sse', (req: Request, res: Response) => {
    req.socket?.setNoDelay?.(true);
    // Deliberately the exact header set routes/ownerEvents.ts sends. Node
    // rejects a connection-specific header on an HTTP/2 response, so this pins
    // that the front strips it on the way out rather than failing the stream.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    const t0 = Date.now();
    res.write(`a+${Date.now() - t0}\n\n`);
    const second = setTimeout(() => res.write(`b+${Date.now() - t0}\n\n`), 140);
    second.unref?.();
    const done = setTimeout(() => res.end(), 280);
    done.unref?.();
  });

  // Slow enough that serial delivery would be obvious next to parallel.
  app.get('/slow', (_req, res) => {
    const t = setTimeout(() => res.status(200).json({ done: true }), 150);
    t.unref?.();
  });

  // Long-lived stream of the /rc/events shape: it only ends when the client
  // goes away, so the abort has to cross the hop or the handler never learns.
  app.get('/abort-watcher', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders?.();
    res.write('open\n\n');
    req.on('close', () => {
      state.aborted += 1;
    });
  });

  return state;
}

async function bootFront(inner: Inner = buildInner()): Promise<number> {
  front = createHttp2Front(inner.app, {
    cert: LOCALHOST_TEST_CERT,
    key: LOCALHOST_TEST_KEY,
  });
  await new Promise<void>((r) => front!.listen(0, '127.0.0.1', r));
  const addr = front!.address();
  if (typeof addr === 'object' && addr !== null)
    return (addr as AddressInfo).port;
  throw new Error('the front did not bind');
}

function openSession(port: number): Promise<ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = h2connect(`https://127.0.0.1:${port}`, {
      rejectUnauthorized: false,
      servername: 'localhost',
    });
    session.once('connect', () => resolve(session));
    session.once('error', reject);
  });
}

interface H2Result {
  status: number;
  body: string;
  headers: Record<string, string>;
  /** Arrival time of each DATA frame, ms from request start. */
  frames: number[];
}

function request(
  session: ClientHttp2Session,
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<H2Result> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const headers: Record<string, string | number> = {
      [H2.HTTP2_HEADER_METHOD]: method,
      [H2.HTTP2_HEADER_PATH]: path,
      ...opts.headers,
    };
    if (opts.body) headers['content-type'] = 'application/json';
    const stream = session.request(headers);
    const out: H2Result = { status: 0, body: '', headers: {}, frames: [] };
    stream.once('response', (h) => {
      out.status = Number(h[H2.HTTP2_HEADER_STATUS]);
      for (const [k, v] of Object.entries(h)) {
        if (!k.startsWith(':')) out.headers[k] = String(v);
      }
    });
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      out.frames.push(Date.now() - started);
      out.body += String(chunk);
    });
    stream.once('error', reject);
    stream.once('end', () => resolve(out));
    if (opts.body) stream.end(opts.body);
    else stream.end();
  });
}

/**
 * A plain HTTP/1.1 TLS client, which is what curl and the hook runners are.
 * `offerAlpn` mirrors the real difference between clients: curl offers no ALPN
 * at all, while a client that names only http/1.1 gets exactly that selected.
 */
function http1Get(
  port: number,
  path: string,
  offerAlpn?: string[],
): Promise<{
  alpn: string | false | null | undefined;
  status: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://127.0.0.1:${port}${path}`,
      {
        rejectUnauthorized: false,
        servername: 'localhost',
        ...(offerAlpn ? { ALPNProtocols: offerAlpn } : {}),
      },
      (res) => {
        // Read it before the body, since the socket can be gone by 'end'.
        const alpn = res.socket?.alpnProtocol;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += String(c)));
        res.on('end', () =>
          resolve({ alpn, status: res.statusCode ?? 0, body }),
        );
      },
    );
    req.once('error', reject);
  });
}

describe('createHttp2Front', () => {
  it('negotiates h2 and serves an express route with an intact request', async () => {
    const port = await bootFront();
    const session = await openSession(port);
    try {
      expect(session.alpnProtocol).toBe('h2');
      const res = await request(session, 'GET', '/probe?v=7', {
        headers: { 'x-forged': 'kept', cookie: 'sid=abc' },
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        ok: true,
        // The inner app still owns a real TCP socket, which is the whole point
        // of the hop.
        hasSocket: true,
        method: 'GET',
        path: '/probe',
        query: '7',
        // Ordinary headers survive the hop.
        forged: 'kept',
        cookie: 'sid=abc',
      });
      expect(res.headers['content-type']).toContain('application/json');
    } finally {
      session.close();
    }
  });

  it('overwrites the peer field so a client cannot claim loopback', async () => {
    const port = await bootFront();
    const session = await openSession(port);
    try {
      // Injecting precisely what the guard must reject. The front rewrites the
      // field, so the inner app must see the address it really connected from
      // rather than whatever the client asserted.
      const loopbackClaim = await request(session, 'GET', '/probe', {
        headers: { [PEER_HEADER]: '127.0.0.1' },
      });
      expect(JSON.parse(loopbackClaim.body).socketPeer).toBe('127.0.0.1');

      // A non-loopback claim must not be laundered into an accepted one either.
      const remoteClaim = await request(session, 'GET', '/probe', {
        headers: { [PEER_HEADER]: '203.0.113.9' },
      });
      expect(JSON.parse(remoteClaim.body).peer).not.toBe('203.0.113.9');
    } finally {
      session.close();
    }
  });

  it('forwards a POST body and the inner status', async () => {
    const port = await bootFront();
    const session = await openSession(port);
    try {
      const res = await request(session, 'POST', '/echo', {
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(res.status).toBe(201);
      expect(JSON.parse(res.body)).toEqual({ got: { hello: 'world' } });
    } finally {
      session.close();
    }
  });

  it('serves the finalizer fallthrough that deadlocks the compat API', async () => {
    const port = await bootFront();
    const session = await openSession(port);
    try {
      const res = await request(session, 'GET', '/fallthrough');
      expect(res.status).toBe(404);
      expect(res.body).toContain('Cannot GET /fallthrough');
    } finally {
      session.close();
    }
  });

  it('delivers event-stream frames as they are written, not at the end', async () => {
    const port = await bootFront();
    const session = await openSession(port);
    try {
      const res = await request(session, 'GET', '/sse');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.frames.length).toBeGreaterThanOrEqual(2);
      const last = res.frames[res.frames.length - 1];
      // Batched delivery would put every stamp at the same instant.
      expect(res.frames[0]).toBeLessThan(last);
      expect(res.body).toContain('a+');
      expect(res.body).toContain('b+');
    } finally {
      session.close();
    }
  });

  it('multiplexes concurrent streams onto the one connection', async () => {
    const port = await bootFront();
    const session = await openSession(port);
    try {
      const started = Date.now();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => request(session, 'GET', '/slow')),
      );
      const wall = Date.now() - started;
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(JSON.parse(r.body)).toEqual({ done: true });
      }
      // Eight 150ms routes in series need 1200ms. Sharing one connection is what
      // removes the browser's six-socket ceiling.
      expect(wall).toBeLessThan(700);
    } finally {
      session.close();
    }
  });

  it('propagates a client abort across the hop so streams can be released', async () => {
    const inner = buildInner();
    const port = await bootFront(inner);
    const session = await openSession(port);
    try {
      const stream = session.request({
        [H2.HTTP2_HEADER_METHOD]: 'GET',
        [H2.HTTP2_HEADER_PATH]: '/abort-watcher',
      });
      // Wait until the inner handler has actually answered, then drop the
      // stream the way a reload does, without ever ending the turn.
      await new Promise<void>((r) => stream.once('data', () => r()));
      expect(inner.aborted).toBe(0);
      stream.close();

      const released = await new Promise<boolean>((resolve) => {
        const deadline = setTimeout(() => resolve(false), 2000);
        deadline.unref?.();
        const poll = setInterval(() => {
          if (inner.aborted > 0) {
            clearTimeout(deadline);
            clearInterval(poll);
            resolve(true);
          }
        }, 20);
        poll.unref?.();
      });
      // Without this the owner event bus keeps the subscription and its
      // heartbeat until the subscriber cap is reached.
      expect(released).toBe(true);
    } finally {
      session.close();
    }
  });

  it('still serves an HTTP/1.1 client that offers no ALPN, as curl does', async () => {
    const port = await bootFront();
    const res = await http1Get(port, '/probe');
    // No ALPN was offered, so nothing was selected; the request is still served
    // because the front allows HTTP/1.1.
    expect(res.alpn).toBe(false);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, hasSocket: true });
  });

  it('serves a client that names only http/1.1 in ALPN', async () => {
    const port = await bootFront();
    const res = await http1Get(port, '/probe', ['http/1.1']);
    expect(res.alpn).toBe('http/1.1');
    expect(res.status).toBe(200);
  });

  it('serves the finalizer 404 to an HTTP/1.1 client too', async () => {
    const port = await bootFront();
    const res = await http1Get(port, '/fallthrough');
    expect(res.status).toBe(404);
    expect(res.body).toContain('Cannot GET /fallthrough');
  });
});

describe('forwardedPeer', () => {
  const fake = (headers: Record<string, string>, socketPeer?: string) =>
    ({
      headers,
      socket: socketPeer ? { remoteAddress: socketPeer } : undefined,
    }) as Request;

  it('honours an attested peer so the loopback hop does not erase it', () => {
    // The socket here is the hop's own loopback peer, so returning the header
    // value is what proves the carried address wins over the adjacent one.
    expect(
      forwardedPeer(
        fake(
          { [PEER_HEADER]: '203.0.113.7', 'x-rc-front': FRONT_ATTESTATION },
          '127.0.0.1',
        ),
      ),
    ).toBe('203.0.113.7');
  });

  it('ignores an unattested peer header, so loopback cannot be claimed', () => {
    expect(
      forwardedPeer(fake({ [PEER_HEADER]: '127.0.0.1' }, '203.0.113.7')),
    ).toBe('203.0.113.7');
  });

  it('ignores a wrong attestation', () => {
    expect(
      forwardedPeer(
        fake(
          {
            [PEER_HEADER]: '127.0.0.1',
            'x-rc-front': `${FRONT_ATTESTATION}x`,
          },
          '203.0.113.7',
        ),
      ),
    ).toBe('203.0.113.7');
  });

  it('falls back to the socket when no front is in play', () => {
    expect(forwardedPeer(fake({}, '127.0.0.1'))).toBe('127.0.0.1');
  });

  it('yields undefined rather than guessing, so gates fail closed', () => {
    expect(forwardedPeer(fake({}))).toBeUndefined();
  });
});
