/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { createGatewayApp } from './server.js';
import { OWNER, SESSION_READ, SHARE, WRITE } from './scopes.js';

let stub: StubDaemon | undefined;
let server: Server | undefined;
let dir: string | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  server = undefined;
  stub = undefined;
  dir = undefined;
});

describe('POST /rc/sessions/catalog mount (#132)', () => {
  it('serves an owner, refuses read, write and share tokens, and is advertised', async () => {
    stub = await startStubDaemon({
      workspaceCwd: '/stub/workspace',
      catalog: {
        '/stub/workspace': {
          sessions: [
            {
              sessionId: 's-1',
              workspaceCwd: '/stub/workspace',
              updatedAt: '2026-10-01T00:00:00.000Z',
            },
          ],
        },
      },
    });
    dir = mkdtempSync(join(tmpdir(), 'rc-catalog-srv-'));
    const store = await TokenStore.open(join(dir, 'tokens.json'));
    const { app } = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(dir, 'audit.log'),
    });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const owner = (await store.issue([OWNER], 'owner')).token;
    const reader = (await store.issue([SESSION_READ], 'reader')).token;
    const writer = (await store.issue([WRITE], 'writer')).token;
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: 's-1',
      ttlSec: 3600,
      parentId: 'owner',
    });
    const ask = (token: string) =>
      fetch(`${url}/rc/sessions/catalog`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ workspaces: ['/stub/workspace'] }),
      });
    for (const t of [reader, writer, share.token]) {
      expect((await ask(t)).status).toBe(403);
    }
    const ok = await ask(owner);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      sessions: Array<{ sessionId: string; source: string }>;
    };
    expect(body.sessions).toEqual([
      expect.objectContaining({ sessionId: 's-1', source: 'daemon' }),
    ]);
    const caps = await fetch(`${url}/rc/capabilities`, {
      headers: { Authorization: `Bearer ${owner}` },
    });
    expect(
      ((await caps.json()) as { remoteControl: Record<string, unknown> })
        .remoteControl['sessionCatalog'],
    ).toBe(true);
  });
});
