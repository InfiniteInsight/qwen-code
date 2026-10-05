/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end proof for `POST /session/:id/model` (rc-gateway model picker,
 * issue #52), mounted through the REAL `createGatewayApp` — real
 * TokenStore/PairingService/requireScope(WRITE) mount, real stub daemon over
 * HTTP — mirroring approvalMode.integration.test.ts's `setup()` pattern.
 *
 * Covers what the route-unit tests (modelSwitch.test.ts) cannot: that the
 * WRITE scope floor is actually enforced AT THE MOUNT (not merely assumed),
 * replacing the route-unit 403 test removed per the plan (that guarantee now
 * lives here, the same way approval-mode's WRITE floor is covered only at
 * the mount level); plus the two daemon-error-mapping paths round-tripped
 * through a real HTTP stub rather than a hand-mocked daemon object.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';

const SESSION_ID = 'abcdef1234567890abcdef1234567890';

let server: Server | undefined;
let runtimeBase: string;
let stub: StubDaemon | undefined;

beforeEach(async () => {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-model-switch-integ-'));
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  await rm(runtimeBase, { recursive: true, force: true });
});

/** Boots a real gateway app + stub daemon pair, returns a ready-to-fetch baseUrl. */
async function setup(stubOpts: Parameters<typeof startStubDaemon>[0] = {}) {
  stub = await startStubDaemon(stubOpts);
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
  const gw = createGatewayApp({
    daemon,
    store,
    pairing: new PairingService(),
    auditPath: join(runtimeBase, 'audit.log'),
  });
  server = await new Promise((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, store };
}

describe('model-switch integration (mount)', () => {
  it('a WRITE-scoped token succeeds: 200 with { modelId, result }', async () => {
    const { baseUrl, store } = await setup({
      setModelResult: { modelId: 'qwen3.5-sonar-8k', ok: true },
    });
    const { token } = await store.issue(['write'], 'writer-1');

    const res = await fetch(`${baseUrl}/session/${SESSION_ID}/model`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ modelId: 'qwen3.5-sonar-8k' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      modelId: 'qwen3.5-sonar-8k',
      result: { modelId: 'qwen3.5-sonar-8k', ok: true },
    });
  });

  it('a token with no scopes gets 403 at the mount (proves the WRITE floor)', async () => {
    const { baseUrl, store } = await setup();
    const { token } = await store.issue([], 'scopeless-1');

    const res = await fetch(`${baseUrl}/session/${SESSION_ID}/model`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ modelId: 'qwen3.5-sonar-8k' }),
    });
    expect(res.status).toBe(403);
  });

  it('stub 404 maps to 502 model_switch_unsupported', async () => {
    const { baseUrl, store } = await setup({ setModelStatus: 404 });
    const { token } = await store.issue(['write'], 'writer-1');

    const res = await fetch(`${baseUrl}/session/${SESSION_ID}/model`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ modelId: 'qwen3.5-sonar-8k' }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('model_switch_unsupported');
  });

  it('stub 422 with an error body passes through unchanged', async () => {
    const { baseUrl, store } = await setup({
      setModelStatus: 422,
      setModelBody: { error: 'unknown model id' },
    });
    const { token } = await store.issue(['write'], 'writer-1');

    const res = await fetch(`${baseUrl}/session/${SESSION_ID}/model`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ modelId: 'nope' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('unknown model id');
  });
});
