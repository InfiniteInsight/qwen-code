/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The host tab routes (#212), mounted through the REAL `createGatewayApp`
 * (real TokenStore and scope mounts, real audit log on disk) over the stub
 * daemon, with a real registry whose /proc probe is a table the test edits.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { HostTabRegistry, type TabProcProbe } from '../hostTabs.js';
import { FRONT_ATTESTATION, PEER_HEADER } from '../tls/http2Front.js';
import { AUDIT_ACTIONS } from '../auditLog.js';

const HOST_TOKEN = 'host-attach-token-212';
const S1 = 'a9a5ddef-edc9-472e-8c52-ea6da2609e80';

let server: Server | undefined;
let stub: StubDaemon | undefined;
let base: string | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  if (base) await rm(base, { recursive: true, force: true });
  base = undefined;
});

/** A probe over a table: pid -> fd 0. A pid not in it does not exist. */
function tableProbe(): TabProcProbe & { fd0: Map<number, string> } {
  const fd0 = new Map<number, string>();
  return {
    fd0,
    startTime: async (pid) => (fd0.has(pid) ? '1' : undefined),
    stdinTarget: async (pid) => fd0.get(pid),
    bootId: async () => 'boot',
  };
}

async function boot() {
  base = await mkdtemp(join(tmpdir(), 'rc-host-tabs-route-'));
  stub = await startStubDaemon();
  const probe = tableProbe();
  let clock = 1_000_000;
  const registry = await HostTabRegistry.open(join(base, 'host-tabs.json'), {
    now: () => clock,
    probe,
    ghostGraceMs: 12_000,
  });
  const store = await TokenStore.open(join(base, 'tokens.json'));
  const { token: owner } = await store.issue(['owner'], 'o');
  const auditPath = join(base, 'audit.log');
  const gw = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath,
    hostAttach: { token: HOST_TOKEN },
    hostTabs: { registry },
  });
  server = await new Promise<Server>((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    owner,
    registry,
    probe,
    auditPath,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

async function send(
  url: string,
  path: string,
  opts: {
    method?: string;
    token?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: opts.method ?? 'POST',
    headers: {
      ...(opts.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(opts.token === null
        ? {}
        : { Authorization: `Bearer ${opts.token ?? HOST_TOKEN}` }),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return {
    status: res.status,
    body: ((await res.json().catch(() => ({}))) ?? {}) as Record<
      string,
      unknown
    >,
  };
}

/** Audit rows for `action`, read from every rotated file beside the path. */
async function auditRows(
  path: string,
  action: string,
  n: number,
): Promise<Array<Record<string, unknown>>> {
  const dir = join(path, '..');
  const read = () =>
    readdirSync(dir)
      .filter((f) => /^audit-.*\.log$/.test(f))
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r['action'] === action);
  const deadline = Date.now() + 2000;
  let rows = read();
  while (rows.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    rows = read();
  }
  return rows;
}

describe('host tab audit actions', () => {
  it('registers every action, so /rc/audit can filter on them', () => {
    for (const a of [
      'host_tab_started',
      'host_tab_ended',
      'host_tab_reopened',
      'host_tab_dismissed',
      'host_tab_removed',
    ]) {
      expect(AUDIT_ACTIONS).toContain(a);
    }
  });
});

describe('POST /rc/host/tabs/:tabId/end (the wrapper)', () => {
  it('records the exit code and answers the state, quit, closed and crashed', async () => {
    const { url, registry, probe, auditPath } = await boot();
    const got: unknown[] = [];
    for (const [i, code] of [0, 129, 137].entries()) {
      probe.fd0.set(100 + i, '/dev/pts/1');
      const sid = `c0000000-0000-4000-8000-00000000000${i}`;
      const t = await registry.start({
        sessionId: sid,
        cwd: '/srv/w',
        pid: 100 + i,
      });
      const res = await send(url, `/rc/host/tabs/${t.tabId}/end`, {
        body: { exitCode: code },
      });
      got.push([res.status, res.body.state, res.body.reason]);
    }
    expect(got).toEqual([
      [200, 'quit', 'quit'],
      [200, 'closed', 'terminal_closed'],
      [200, 'crashed', 'crashed'],
    ]);
    const rows = await auditRows(auditPath, 'host_tab_ended', 3);
    expect(rows.map((r) => r['detail'])).toEqual([
      expect.objectContaining({ exitCode: 0, reason: 'quit' }),
      expect.objectContaining({ exitCode: 129, reason: 'terminal_closed' }),
      expect.objectContaining({ exitCode: 137, reason: 'crashed' }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('/srv/w');
  });

  it('404s a malformed or unknown tab and 400s a code that is not an exit status', async () => {
    const { url, registry } = await boot();
    const t = await registry.start({ sessionId: S1, cwd: '/srv/w', pid: 5 });
    const bad = await send(url, '/rc/host/tabs/not-a-tab/end', {
      body: { exitCode: 0 },
    });
    const unknown = await send(
      url,
      '/rc/host/tabs/00000000-0000-4000-8000-000000000999/end',
      { body: { exitCode: 0 } },
    );
    expect([bad.status, bad.body.code]).toEqual([404, 'tab_not_found']);
    expect([unknown.status, unknown.body.code]).toEqual([404, 'tab_not_found']);
    for (const exitCode of [-1, 256, 1.5, '0', null]) {
      const res = await send(url, `/rc/host/tabs/${t.tabId}/end`, {
        body: { exitCode },
      });
      expect([res.status, res.body.code]).toEqual([400, 'invalid_exit_code']);
    }
    expect(registry.get(t.tabId)?.endedAt).toBeUndefined();
  });

  it('takes only the host-attach token from a loopback peer; a phone token is refused', async () => {
    const { url, registry, owner } = await boot();
    const t = await registry.start({ sessionId: S1, cwd: '/srv/w', pid: 5 });
    const path = `/rc/host/tabs/${t.tabId}/end`;
    const remote = await send(url, path, {
      body: { exitCode: 137 },
      headers: {
        [PEER_HEADER]: '203.0.113.9',
        'x-rc-front': FRONT_ATTESTATION,
      },
    });
    const phone = await send(url, path, {
      body: { exitCode: 137 },
      token: owner,
    });
    const none = await send(url, path, {
      body: { exitCode: 137 },
      token: null,
    });
    expect([remote.status, remote.body.code]).toEqual([403, 'loopback_only']);
    expect([phone.status, none.status]).toEqual([401, 401]);
    expect(registry.get(t.tabId)?.endedAt).toBeUndefined();
  });
});
