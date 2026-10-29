/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  daemonRequest,
  probeHealth,
  DaemonHttpError,
  DaemonUnreachableError,
} from './daemonClient.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/rc/health') {
      return send(200, { status: 'ok' });
    }
    if (req.method === 'GET' && req.url === '/echo-auth') {
      return send(200, { auth: req.headers['authorization'] ?? null });
    }
    if (req.method === 'GET' && req.url === '/not-json') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('plain body');
    }
    if (req.method === 'POST' && req.url === '/echo-body') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () =>
        send(200, { body: JSON.parse(raw), ct: req.headers['content-type'] }),
      );
      return;
    }
    if (req.method === 'DELETE' && req.url === '/gone') {
      return send(200, { deleted: true });
    }
    if (req.method === 'GET' && req.url === '/slow') {
      return setTimeout(() => send(200, { late: true }), 500);
    }
    if (req.method === 'GET' && req.url === '/boom') {
      return send(500, { error: 'kaboom', code: 'internal' });
    }
    if (req.method === 'GET' && req.url === '/stall-after-headers') {
      // Headers and the first bytes go out, then nothing, ever.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"status":');
      return;
    }
    if (req.method === 'GET' && req.url === '/trickle') {
      // Each chunk well inside the idle window, the whole body well past it.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const parts = ['{"a":', '1,', '"b":', '2}'];
      let i = 0;
      const next = (): void => {
        if (i === parts.length) {
          res.end();
          return;
        }
        res.write(parts[i++]);
        setTimeout(next, 60);
      };
      next();
      return;
    }
    return send(404, { error: 'no such route', code: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // The stall route never ends its response on its own.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('daemonRequest', () => {
  it('performs an authenticated GET and parses JSON', async () => {
    const r = await daemonRequest(
      { url: base, token: 'qwk_t' },
      { method: 'GET', path: '/echo-auth' },
    );
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ auth: 'Bearer qwk_t' });
  });

  it('joins the path onto a base with a trailing slash', async () => {
    const r = await daemonRequest(
      { url: base + '/' },
      { method: 'GET', path: '/rc/health' },
    );
    expect((r.json as { status: string }).status).toBe('ok');
  });

  it('sends a JSON body with Content-Type on POST', async () => {
    const r = await daemonRequest(
      { url: base },
      {
        method: 'POST',
        path: '/echo-body',
        body: { transcript: 'include', fromEventId: 3 },
      },
    );
    expect(r.json).toEqual({
      body: { transcript: 'include', fromEventId: 3 },
      ct: 'application/json',
    });
  });

  it('supports DELETE without a body', async () => {
    const r = await daemonRequest(
      { url: base },
      {
        method: 'DELETE',
        path: '/gone',
      },
    );
    expect(r.json).toEqual({ deleted: true });
  });

  it('keeps non-JSON 2xx bodies as raw text', async () => {
    const r = await daemonRequest(
      { url: base },
      {
        method: 'GET',
        path: '/not-json',
      },
    );
    expect(r.json).toBe('plain body');
  });

  it('throws DaemonHttpError with status + code on non-2xx', async () => {
    try {
      await daemonRequest({ url: base }, { method: 'GET', path: '/boom' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonHttpError);
      const e = err as DaemonHttpError;
      expect(e.status).toBe(500);
      expect(e.code).toBe('internal');
      expect(e.message).toContain('500');
      expect(e.message).toContain('kaboom');
    }
  });

  it('throws DaemonUnreachableError for a refused connection', async () => {
    // Port 1 on localhost is closed on every sane machine.
    try {
      await daemonRequest(
        { url: 'http://127.0.0.1:1' },
        {
          method: 'GET',
          path: '/rc/health',
          timeoutMs: 2000,
        },
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonUnreachableError);
    }
  });

  it('throws DaemonUnreachableError on timeout', async () => {
    const started = Date.now();
    try {
      await daemonRequest(
        { url: base },
        {
          method: 'GET',
          path: '/slow',
          timeoutMs: 50,
        },
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonUnreachableError);
      expect(Date.now() - started).toBeLessThan(400);
    }
  });

  // #163: the timer used to be cleared once headers arrived, so a daemon that
  // stalled after them hung the command forever.
  it('throws DaemonUnreachableError when the body stalls after the headers', async () => {
    const started = Date.now();
    const err = await daemonRequest(
      { url: base },
      { method: 'GET', path: '/stall-after-headers', timeoutMs: 100 },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DaemonUnreachableError);
    expect((err as Error).message).toMatch(/no data for 100 ms/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('keeps reading a body that arrives slowly but steadily', async () => {
    // Four chunks 60 ms apart: longer in total than the 150 ms window, never
    // silent for that long.
    const r = await daemonRequest(
      { url: base },
      { method: 'GET', path: '/trickle', timeoutMs: 150 },
    );
    expect(r.json).toEqual({ a: 1, b: 2 });
  });
});

describe('probeHealth', () => {
  it('reports ok for a 200 /rc/health', async () => {
    await expect(probeHealth(base, 2000)).resolves.toBe('ok');
  });

  it('reports unreachable for a dead daemon', async () => {
    await expect(probeHealth('http://127.0.0.1:1', 500)).resolves.toBe(
      'unreachable',
    );
  });

  it('settles within its timeout for a daemon that stalls after the headers', async () => {
    // `qwen-rc daemons health` against this used to hang forever.
    const stalled = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
    });
    await new Promise<void>((resolve) =>
      stalled.listen(0, '127.0.0.1', resolve),
    );
    try {
      const url = `http://127.0.0.1:${(stalled.address() as AddressInfo).port}`;
      const started = Date.now();
      await expect(probeHealth(url, 100)).resolves.toBe('unreachable');
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });
});
