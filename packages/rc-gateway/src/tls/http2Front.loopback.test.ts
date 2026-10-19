/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The second, loopback-only socket the front can bind. It exists because a
 * gateway bound to one tailnet address is unreachable from its own machine when
 * the browser sits behind a WSL boundary. It is also the one option that could
 * widen exposure if the guard around it were wrong, so the guard is the point of
 * these cases.
 *
 * The primary binds 127.0.0.2 rather than a real tailnet address: the whole
 * 127/8 is local, so the pair is hermetic and runs in any lane, and the code
 * path that decides whether to add the second socket is the same one either way.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  connect as h2connect,
  constants as H2,
  type ClientHttp2Session,
} from 'node:http2';
import type { RequestListener } from 'node:http';
import {
  createHttp2Front,
  forwardedPeer,
  PEER_HEADER,
  type FrontListener,
} from './http2Front.js';
import {
  LOCALHOST_TEST_CERT,
  LOCALHOST_TEST_KEY,
} from '../nativePush/testfixtures/localhostTls.js';
import { getFreePort } from '../freePort.js';

const TLS = { cert: LOCALHOST_TEST_CERT, key: LOCALHOST_TEST_KEY };
/** A second address to bind the primary to, distinct from the loopback one. */
const PUBLIC = '127.0.0.2';
const LOOPBACK = '127.0.0.1';

let front: FrontListener | undefined;

afterEach(async () => {
  if (front) await front.close();
  front = undefined;
});

/** Echoes what the inner app can see, which is what the guard must not leak. */
function probeApp(): RequestListener {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        hasSocket: typeof req.socket?.setNoDelay === 'function',
        peer: forwardedPeer(req) ?? null,
      }),
    );
  };
}

/** Binds the front to `host` and, unless that is the same address, to loopback. */
async function bootPair(host: string): Promise<number> {
  const port = await getFreePort();
  front = createHttp2Front(probeApp(), TLS, {
    loopbackBindHost: LOOPBACK,
  });
  await new Promise<void>((r) => front!.listen(port, host, r));
  return port;
}

function open(host: string, port: number): Promise<ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = h2connect(`https://${host}:${port}`, {
      rejectUnauthorized: false,
      servername: 'localhost',
    });
    session.once('connect', () => resolve(session));
    session.once('error', reject);
  });
}

function get(
  session: ClientHttp2Session,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const stream = session.request({
      [H2.HTTP2_HEADER_METHOD]: 'GET',
      [H2.HTTP2_HEADER_PATH]: '/probe',
      ...headers,
    });
    let raw = '';
    let status = 0;
    stream.once('response', (h) => {
      status = Number(h[H2.HTTP2_HEADER_STATUS]);
    });
    stream.setEncoding('utf8');
    stream.on('data', (c) => (raw += String(c)));
    stream.once('error', reject);
    stream.once('end', () => resolve({ status, body: JSON.parse(raw) }));
  });
}

describe('loopbackBindHost', () => {
  it('refuses a second bind that is not loopback', () => {
    // The one outcome this option must never produce is a wider surface.
    expect(() =>
      createHttp2Front(probeApp(), TLS, { loopbackBindHost: '0.0.0.0' }),
    ).toThrow(/must be loopback/);
  });

  it('serves the same app on both addresses over one port', async () => {
    const port = await bootPair(PUBLIC);
    for (const host of [PUBLIC, LOOPBACK]) {
      const session = await open(host, port);
      try {
        const res = await get(session);
        expect(res.status).toBe(200);
        expect(res.body.hasSocket).toBe(true);
        expect(res.body.peer).not.toBeNull();
      } finally {
        session.close();
      }
    }
  });

  it('rewrites the peer field on the loopback path too', async () => {
    const port = await bootPair(PUBLIC);
    const session = await open(LOOPBACK, port);
    try {
      // Injecting exactly what the guard must reject, from the socket that the
      // new option makes reachable.
      const res = await get(session, { [PEER_HEADER]: '203.0.113.9' });
      expect(res.body.peer).not.toBe('203.0.113.9');
    } finally {
      session.close();
    }
  });

  it('does not double-bind when the primary already is that address', async () => {
    // Without the skip the second bind collides with the first and reports it,
    // which would print a false failure on every loopback gateway boot.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const port = await bootPair(LOOPBACK);
      const session = await open(LOOPBACK, port);
      try {
        expect((await get(session)).status).toBe(200);
      } finally {
        session.close();
      }
      const text = logged.mock.calls
        .map((c) => c.map(String).join(' '))
        .join('');
      expect(text).not.toContain('NOT bound');
    } finally {
      logged.mockRestore();
    }
  });
});
