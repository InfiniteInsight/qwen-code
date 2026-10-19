/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HTTP/2 front listener.
 *
 * Why this exists: browsers cap HTTP/1.1 at six connections per origin, and a
 * viewer tab holds two long-lived ones (the `/rc/events` stream and the
 * whole-turn `POST /session/:id/prompt`), so three tabs exhaust the pool and a
 * further request parks silently with no error and no output. HTTP/2 puts every
 * stream on one connection and removes the cap.
 *
 * Why it is a proxy rather than `http2.createSecureServer(app)`: feeding the
 * express app straight into the compat API hangs every route on Node 22 with
 * express 4. Express's finalizer calls `req.resume()` on each request, which
 * reaches `IncomingMessage._read`, whose last line is
 * `if (this.socket.readable) readStart(this.socket)`. A compat HTTP/2 request
 * has no usable `socket`, so the read throws inside Node's own internals and no
 * response is ever sent. Verified four ways, each of which only moved the
 * failure: passing the app directly, mapping `req.socket` onto the session
 * socket (Node refuses: "HTTP/2 sockets should not be directly manipulated"),
 * installing a socket stub, and overriding `resume`. Serving HTTP/2 in front of
 * an express app therefore needs a hop, which is what nginx does for the same
 * reason.
 *
 * The hop has one consequence that must not be overlooked. Past it, the inner
 * express app sees a loopback socket for EVERY request, including those from
 * remote browsers, so any gate that trusts `req.socket.remoteAddress` would open
 * to the whole network. The front therefore carries the true peer in
 * {@link PEER_HEADER}, and {@link forwardedPeer} only honours that header when
 * the request also carries the per-process {@link FRONT_ATTESTATION}, which a
 * remote client cannot know. Without a front the header is never honoured and
 * the socket stays the authority.
 */

import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from 'node:http';
import {
  createSecureServer,
  type Http2SecureServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { SecureContext } from 'node:tls';
import { randomBytes } from 'node:crypto';

/** Carries the real client address across the front-to-inner hop. */
export const PEER_HEADER = 'x-rc-peer';

/** Proves {@link PEER_HEADER} was written by this process's front. */
const PEER_ATTESTATION_HEADER = 'x-rc-front';

/**
 * Never sent to a client, so only this process can present it. With no front in
 * play the header is absent and cannot be used to spoof a loopback peer.
 */
export const FRONT_ATTESTATION: string = randomBytes(24).toString('base64url');

/**
 * The address the client actually connected from, or `undefined` when it cannot
 * be established. Gates that allow loopback MUST fail closed on `undefined`.
 */
export function forwardedPeer(req: IncomingMessage): string | undefined {
  const attestation = req.headers[PEER_ATTESTATION_HEADER];
  if (attestation === FRONT_ATTESTATION) {
    const carried = req.headers[PEER_HEADER];
    if (typeof carried === 'string' && carried.length > 0) return carried;
  }
  return req.socket?.remoteAddress ?? undefined;
}

/**
 * Connection-specific fields. RFC 9112 forbids them on an HTTP/2 connection, and
 * Node throws `HTTP/1 Connection specific headers are forbidden` when an
 * upstream response carries one onward, so they are dropped in both directions.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'transfer-encoding',
  'upgrade',
]);

type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * Rewrites the header set for one hop. HTTP/2 pseudo-headers (`:method`,
 * `:path`, `:scheme`, `:authority`) are not valid HTTP/1.1 field names, so
 * forwarding `req.headers` verbatim throws `Header name must be a valid HTTP
 * token`. The peer fields are rewritten rather than copied, so a client cannot
 * pre-seed them.
 */
function forwardableHeaders(incoming: HeaderBag, peer: string): HeaderBag {
  const out: HeaderBag = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (name.startsWith(':')) continue;
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (name === PEER_HEADER || name === PEER_ATTESTATION_HEADER) continue;
    out[name] = value;
  }
  out[PEER_HEADER] = peer;
  out[PEER_ATTESTATION_HEADER] = FRONT_ATTESTATION;
  return out;
}

/** Response headers minus the fields that must not cross an HTTP/2 boundary. */
function onwardResponseHeaders(incoming: HeaderBag): HeaderBag {
  const out: HeaderBag = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * The address the front saw the peer connect from. Under HTTP/2 the connection
 * is the session's socket, because the per-stream `req.socket` is a stream and
 * carries no address. Under the HTTP/1.1 fallback the request still owns a real
 * socket.
 */
function peerAddressOf(req: Http2ServerRequest): string {
  const fromSession = req.stream?.session?.socket?.remoteAddress;
  if (typeof fromSession === 'string' && fromSession.length > 0) {
    return fromSession;
  }
  const fromSocket = req.socket?.remoteAddress;
  return typeof fromSocket === 'string' ? fromSocket : '';
}

export interface Http2FrontTls {
  cert?: Buffer | string;
  key?: Buffer | string;
  /** Serves the current ACME cert; must hand back a real `SecureContext`. */
  sniCallback?: (
    servername: string,
    cb: (err: Error | null, ctx?: SecureContext) => void,
  ) => void;
}

/**
 * The subset of a server the CLI uses. `listen` keeps the signature the
 * `https.Server` had so the call site does not change shape.
 */
export interface FrontListener {
  listen(port: number, host: string, onListening: () => void): void;
  close(): Promise<void>;
  address(): AddressInfo | string | null;
}

/**
 * Wraps `app` in a TLS listener that speaks HTTP/2 and still accepts HTTP/1.1.
 * `app` itself keeps being served by an ordinary HTTP/1.1 server bound to
 * loopback, so every route sees a real request with a real socket and needs no
 * HTTP/2 awareness.
 */
export function createHttp2Front(
  app: RequestListener,
  tls: Http2FrontTls,
): FrontListener {
  // Loopback on an ephemeral port: reachable from this host only, never a
  // public surface. Bounded by listen() so the bind order matches the server
  // the caller previously held.
  let inner: Server | undefined;
  let front: Http2SecureServer | undefined;

  const handler = (req: Http2ServerRequest, res: Http2ServerResponse): void => {
    const innerAddress = inner?.address();
    if (typeof innerAddress !== 'object' || innerAddress === null) {
      res.writeHead(500);
      res.end('inner listener is not ready');
      return;
    }

    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: innerAddress.port,
        method: req.method,
        path: req.url,
        headers: forwardableHeaders(req.headers, peerAddressOf(req)),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 500, onwardResponseHeaders(up.headers));
        // Piped, never buffered: the `/rc/events` stream must deliver each
        // frame as it arrives rather than at end of turn.
        up.pipe(res);
        up.on('error', () => res.destroy());
      },
    );

    upstream.on('error', () => {
      // End rather than leave open, so the browser stops waiting instead of
      // holding a half-written response.
      if (!res.headersSent) res.writeHead(502);
      res.destroy();
    });

    req.pipe(upstream);
    req.on('error', () => upstream.destroy());

    // The abort has to cross the hop or the inner `/rc/events` handler never
    // sees a close, so its bus subscription and heartbeat leak until the
    // subscriber cap is reached.
    req.stream?.on('close', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
  };

  return {
    listen(port, host, onListening) {
      inner = createHttpServer(app);
      inner.listen(0, '127.0.0.1', () => {
        front = createSecureServer(
          {
            ...(tls.key !== undefined ? { key: tls.key } : {}),
            ...(tls.cert !== undefined ? { cert: tls.cert } : {}),
            ...(tls.sniCallback ? { SNICallback: tls.sniCallback } : {}),
            // Keeps every existing HTTP/1.1 consumer working: curl, hook
            // runners, native clients, and ALPN clients that prefer h1.
            allowHTTP1: true,
          },
          handler,
        );
        front.listen(port, host, onListening);
      });
    },
    async close() {
      const open: Array<Promise<void>> = [];
      if (front) open.push(new Promise((r) => front!.close(() => r())));
      if (inner) open.push(new Promise((r) => inner!.close(() => r())));
      await Promise.all(open);
    },
    address() {
      return front?.address() ?? null;
    },
  };
}
