/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Express backstop (#155): a rejected promise from any route handler, or an
 * error raised by middleware, answers JSON from createGatewayApp instead of
 * killing the process or rendering Express's HTML page with a stack trace.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TokenStore } from './tokenStore.js';
import { createGatewayApp } from './server.js';
import { PairingService } from './pairing.js';
import type { UiPrefsStore } from './uiPrefsStore.js';

const ALLOWED_ORIGIN = 'https://app.example.com';

let server: Server | undefined;
let dir: string;
let store: TokenStore;
let ownerToken: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rc-crashguard-'));
  store = await TokenStore.open(join(dir, 'tokens.json'));
  ownerToken = (await store.issue(['owner', 'session:read'], 'owner')).token;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function diskFull(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), {
    code: 'ENOSPC',
  });
}

async function boot(
  extra: Partial<Parameters<typeof createGatewayApp>[0]> = {},
): Promise<string> {
  const { app } = createGatewayApp({
    daemon: {} as never,
    store,
    pairing: {} as never,
    auditPath: join(dir, 'audit.log'),
    webRoot: dir,
    commandsUserDir: join(dir, 'no-commands'),
    corsConfigOrigins: [ALLOWED_ORIGIN],
    ...extra,
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A stack trace line as Node prints it (`    at fn (file:line:col)`). */
const STACK_FRAME = /\bat .+:\d+:\d+/;

describe('createGatewayApp error backstop', () => {
  it('answers JSON 500 when an app-level async route rejects', async () => {
    store.removeOrigin = async () => {
      throw diskFull();
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = await boot();
    const res = await fetch(
      `${url}/rc/cors/${encodeURIComponent('https://gone.example.com')}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` },
        signal: AbortSignal.timeout(3000),
      },
    );
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal', code: 'internal' });
    expect(text).not.toContain('ENOSPC');
    expect(text).not.toMatch(STACK_FRAME);
    // The operator still learns what failed, server side only.
    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('DELETE /rc/cors/');
    expect(logged).toContain('Error: ENOSPC');
  });

  it('answers JSON 500 when a handler inside a mounted Router rejects', async () => {
    const uiPrefs = {
      get: () => ({}),
      setStampZone: async () => {
        throw diskFull();
      },
    } as unknown as UiPrefsStore;
    const url = await boot({ uiPrefs });
    const res = await fetch(`${url}/rc/ui-prefs`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({ stampZone: 'Europe/Paris' }),
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal', code: 'internal' });
    // The backstop runs after the CORS middleware, so a browser can read it.
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });

  it('answers malformed JSON with a JSON 400, no HTML and no stack', async () => {
    const url = await boot();
    const res = await fetch(`${url}/session/x/prompt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
        Origin: ALLOWED_ORIGIN,
      },
      body: '{"oops":',
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'invalid_json',
      code: 'invalid_json',
    });
    expect(text).not.toContain('SyntaxError');
    expect(text).not.toMatch(STACK_FRAME);
    // The CORS headers are on the 400, so the browser sees it rather than a
    // CORS error.
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });

  // #163: the JSON parser used to run ahead of bearerResolve, so anyone could
  // make the gateway parse a body, and a malformed one was answered (400)
  // without ever being asked who was sending it.
  it('never parses an unauthenticated body: malformed or oversized, it is a 401', async () => {
    const url = await boot();
    const malformed = await fetch(`${url}/session/x/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"oops":',
      signal: AbortSignal.timeout(3000),
    });
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toEqual({
      error: 'Unauthorized',
      code: 'unauthorized',
    });
    // Over the parser's limit: a parser that ran would answer 413 first.
    const oversized = await fetch(`${url}/session/x/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(200 * 1024) }),
      signal: AbortSignal.timeout(3000),
    });
    expect(oversized.status).toBe(401);
  });

  it('answers JSON without a stack whatever NODE_ENV says', async () => {
    const prior = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';
    try {
      const url = await boot();
      const res = await fetch(`${url}/session/x/prompt`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
        },
        body: '{"oops":',
        signal: AbortSignal.timeout(3000),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: 'invalid_json',
        code: 'invalid_json',
      });
      expect(text).not.toMatch(STACK_FRAME);
      expect(text).not.toContain(dir);
    } finally {
      if (prior === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = prior;
    }
  });

  it('still parses the pairing redeem body, whose code is the credential', async () => {
    const url = await boot({ pairing: new PairingService() });
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'not-a-code', label: 'x' }),
      signal: AbortSignal.timeout(3000),
    });
    // The route read the body and refused the code itself.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      'invalid_pairing_code',
    );
  });

  it('parses a hook-ingest body only for the holder of the ingest token', async () => {
    const url = await boot({ hookIngest: { ingestToken: 'ingest-secret' } });
    const stranger = await fetch(`${url}/rc/hooks/ingest`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong',
        'Content-Type': 'application/json',
      },
      body: '{"oops":',
      signal: AbortSignal.timeout(3000),
    });
    expect(stranger.status).toBe(401);

    const holderMalformed = await fetch(`${url}/rc/hooks/ingest`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ingest-secret',
        'Content-Type': 'application/json',
      },
      body: '{"oops":',
      signal: AbortSignal.timeout(3000),
    });
    expect(holderMalformed.status).toBe(400);
    expect(await holderMalformed.json()).toEqual({
      error: 'invalid_json',
      code: 'invalid_json',
    });

    const holder = await fetch(`${url}/rc/hooks/ingest`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ingest-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event: 'PreToolUse' }),
      signal: AbortSignal.timeout(3000),
    });
    expect(holder.status).toBe(202);
  });

  it('does not parse a host-attach body for a caller without the host token', async () => {
    const url = await boot({ hostAttach: { token: 'host-secret' } });
    const res = await fetch(`${url}/rc/host/attach`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: '{"oops":',
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(401);
  });

  it('keeps the status of a client error raised by middleware', async () => {
    // The /ui static mount is fallthrough:false, so a missing file is a 404
    // error passed to next(); it must stay a 404, not become a 500.
    const url = await boot();
    const res = await fetch(`${url}/ui/no-such-file.js`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'not_found', code: 'not_found' });
    expect(text).not.toMatch(STACK_FRAME);
  });

  it('answers a malformed percent-escape in a route param with a JSON 400', async () => {
    const url = await boot();
    const res = await fetch(`${url}/rc/cors/%E0%A4%A`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'bad_request',
      code: 'bad_request',
    });
    expect(text).not.toMatch(STACK_FRAME);
  });

  it('does not relay an unmapped upstream 4xx as the caller own status', async () => {
    // A daemon 401 escaping a route must not tell the client its token failed.
    store.removeOrigin = async () => {
      throw Object.assign(new Error('daemon said 401'), {
        name: 'DaemonHttpError',
        status: 401,
      });
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = await boot();
    const res = await fetch(
      `${url}/rc/cors/${encodeURIComponent('https://gone.example.com')}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` },
        signal: AbortSignal.timeout(3000),
      },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal', code: 'internal' });
  });

  it('leaves explicit route error mappings untouched', async () => {
    const url = await boot();
    const res = await fetch(
      `${url}/rc/cors/${encodeURIComponent('https://never.example.com')}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` },
        signal: AbortSignal.timeout(3000),
      },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      'origin_not_found',
    );
  });
});
