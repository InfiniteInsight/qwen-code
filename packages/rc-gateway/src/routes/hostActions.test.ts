/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The host-action routes, mounted through the REAL `createGatewayApp` (real
 * TokenStore, real requireScope(OWNER) mount, real audit log on disk) with a
 * fake runner, so no program on the host is ever run. Proves both states of
 * the conditional mount, the scope floor against a WRITE token and a share,
 * and the bodies and audit row each outcome produces.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { HostActions, type HostActionRunner } from '../hostActions.js';
import { SESSION_READ, SHARE, WRITE } from '../scopes.js';

const CONFIG = {
  launcher: {
    label: 'Qwen Remote Launcher',
    status: ['probe-launcher'],
    start: ['start-launcher'],
  },
  llama: {
    label: 'llama-swap',
    status: ['probe-llama'],
    start: ['start-llama'],
  },
};

let server: Server | undefined;
let stub: StubDaemon | undefined;
let runtimeBase: string | undefined;

async function boot(hostActions?: HostActions) {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-host-actions-route-'));
  stub = await startStubDaemon();
  const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
  const { token: owner } = await store.issue(['owner'], 'o');
  const { token: write } = await store.issue([WRITE, SESSION_READ], 'w');
  const share = await store.issueShare({
    scopes: [SHARE, SESSION_READ],
    label: 'guest',
    sessionLockId: 'locked-sess',
    ttlSec: 3600,
    parentId: 'owner',
  });
  const auditPath = join(runtimeBase, 'audit.log');
  const gw = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath,
    hostActions,
  });
  server = await new Promise<Server>((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    owner,
    write,
    share: share.token,
    auditPath,
  };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (stub) await stub.close();
  stub = undefined;
  if (runtimeBase) await rm(runtimeBase, { recursive: true, force: true });
  runtimeBase = undefined;
});

async function call(
  url: string,
  token: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined,
  };
}

// The log rotates daily into `audit-YYYY-MM-DD.log` beside the path it was
// given, so the rows are read from every such file in that directory.
function hostRows(path: string): Array<Record<string, unknown>> {
  const dir = dirname(path);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^audit-.*\.log$/.test(f));
  } catch {
    return [];
  }
  return files
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r['action'] === 'host_action_started');
}

async function pollHostRows(
  path: string,
  n: number,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 2000;
  let rows = hostRows(path);
  while (rows.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    rows = hostRows(path);
  }
  return rows;
}

/** The runner the harness uses too: not running until one start has run. */
function flipRunner(startCode = 0): HostActionRunner & { calls: string[] } {
  let started = false;
  const calls: string[] = [];
  const run = (async (argv: readonly string[]) => {
    calls.push(argv[0]!);
    if (argv[0]!.startsWith('start-')) {
      if (startCode === 0) started = true;
      return { code: startCode };
    }
    return { code: argv[0] === 'probe-launcher' && started ? 0 : 1 };
  }) as HostActionRunner & { calls: string[] };
  run.calls = calls;
  return run;
}

describe('GET /rc/host/actions', () => {
  it('lists each action with a live probe, in file order', async () => {
    const { url, owner } = await boot(
      HostActions.fromConfig(CONFIG, async (argv) => ({
        code: argv[0] === 'probe-llama' ? 0 : 1,
      })),
    );
    const r = await call(`${url}/rc/host/actions`, owner);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      actions: [
        { name: 'launcher', label: 'Qwen Remote Launcher', running: false },
        { name: 'llama', label: 'llama-swap', running: true },
      ],
    });
  });

  it('runs the probes side by side rather than one after another', async () => {
    // Each probe waits until both have started; run in series, the first
    // would never see the second and the read would hang.
    let begun = 0;
    let bothBegun!: () => void;
    const together = new Promise<void>((r) => (bothBegun = r));
    const { url, owner } = await boot(
      HostActions.fromConfig(CONFIG, async () => {
        if (++begun === 2) bothBegun();
        await together;
        return { code: 0 };
      }),
    );
    const r = await call(`${url}/rc/host/actions`, owner);
    expect(r.status).toBe(200);
    expect(begun).toBe(2);
  });

  it('reads a probe whose runner throws as not running, not as an error', async () => {
    const { url, owner } = await boot(
      HostActions.fromConfig(CONFIG, async () => {
        throw new Error('spawn EACCES');
      }),
    );
    const r = await call(`${url}/rc/host/actions`, owner);
    expect(r.status).toBe(200);
    expect(
      (r.body!['actions'] as Array<{ running: boolean }>).map((a) => a.running),
    ).toEqual([false, false]);
  });

  it('reports a probe that could not be spawned as unknown, with the errno and program only', async () => {
    const { url, owner } = await boot(
      HostActions.fromConfig(
        {
          launcher: {
            label: 'Qwen Remote Launcher',
            status: ['powershell.exe', '-Command', 'secret'],
            start: ['start-launcher'],
          },
          llama: CONFIG.llama,
        },
        async (argv) =>
          argv[0] === 'powershell.exe'
            ? { code: null, error: 'ENOENT' }
            : { code: 0 },
      ),
    );
    const r = await call(`${url}/rc/host/actions`, owner);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      actions: [
        {
          name: 'launcher',
          label: 'Qwen Remote Launcher',
          running: false,
          status: 'unknown',
          error: 'ENOENT: powershell.exe',
        },
        { name: 'llama', label: 'llama-swap', running: true },
      ],
    });
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });

  it('404s when the gateway was given no store', async () => {
    const { url, owner } = await boot(undefined);
    expect((await call(`${url}/rc/host/actions`, owner)).status).toBe(404);
    expect(
      (await call(`${url}/rc/host/actions/launcher/start`, owner, 'POST'))
        .status,
    ).toBe(404);
  });
});

describe('POST /rc/host/actions/:name/start', () => {
  it('starts, re-probes, answers running, and audits the press', async () => {
    const run = flipRunner();
    const { url, owner, auditPath } = await boot(
      HostActions.fromConfig(CONFIG, run),
    );
    const before = await call(`${url}/rc/host/actions`, owner);
    expect(
      (before.body!['actions'] as Array<{ running: boolean }>)[0]!.running,
    ).toBe(false);

    const r = await call(`${url}/rc/host/actions/launcher/start`, owner, 'POST');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ name: 'launcher', running: true });
    expect(run.calls.slice(-2)).toEqual(['start-launcher', 'probe-launcher']);

    const rows = await pollHostRows(auditPath, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'host_action_started',
      outcome: 'ok',
      detail: { name: 'launcher', running: true },
    });
    expect(typeof rows[0]!['actorTokenId']).toBe('string');
  });

  it('answers 200 with running false when the start exits 0 but nothing came up', async () => {
    const { url, owner } = await boot(
      HostActions.fromConfig(CONFIG, async (argv) => ({
        code: argv[0]!.startsWith('start-') ? 0 : 1,
      })),
    );
    const r = await call(`${url}/rc/host/actions/launcher/start`, owner, 'POST');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ name: 'launcher', running: false });
  });

  it('answers 502 host_action_failed with the exit code, and audits the failure', async () => {
    const { url, owner, auditPath } = await boot(
      HostActions.fromConfig(CONFIG, flipRunner(5)),
    );
    const r = await call(`${url}/rc/host/actions/launcher/start`, owner, 'POST');
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: 'host_action_failed', exitCode: 5 });
    expect(typeof r.body!['error']).toBe('string');
    const rows = await pollHostRows(auditPath, 1);
    expect(rows[0]).toMatchObject({
      outcome: 'failed',
      detail: { name: 'launcher', exitCode: 5 },
    });
  });

  it('answers 502 with a null exit code when the start never finished', async () => {
    const { url, owner } = await boot(
      HostActions.fromConfig(CONFIG, async (argv) => ({
        code: argv[0]!.startsWith('start-') ? null : 1,
      })),
    );
    const r = await call(`${url}/rc/host/actions/llama/start`, owner, 'POST');
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: 'host_action_failed', exitCode: null });
  });

  it('answers 502 spawn_failed when the start command cannot be spawned, and audits it without the argv', async () => {
    const { url, owner, auditPath } = await boot(
      HostActions.fromConfig(
        {
          launcher: {
            label: 'Qwen Remote Launcher',
            status: ['probe-launcher'],
            start: ['/mnt/c/Windows/powershell.exe', '-Command', 'secret'],
          },
        },
        async (argv) =>
          argv[0]!.endsWith('powershell.exe')
            ? { code: null, error: 'ENOENT' }
            : { code: 1 },
      ),
    );
    const r = await call(`${url}/rc/host/actions/launcher/start`, owner, 'POST');
    expect(r.status).toBe(502);
    expect(r.body).toEqual({
      error: 'The start command could not be run (ENOENT: powershell.exe)',
      code: 'spawn_failed',
    });
    const rows = await pollHostRows(auditPath, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'failed',
      detail: { name: 'launcher', exitCode: null, spawnError: 'ENOENT' },
    });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('/mnt/c');
  });

  it('404s host_action_unknown for a name the file does not hold, and runs nothing', async () => {
    const run = flipRunner();
    const { url, owner, auditPath } = await boot(
      HostActions.fromConfig(CONFIG, run),
    );
    for (const name of ['nope', '__proto__', 'constructor']) {
      const r = await call(`${url}/rc/host/actions/${name}/start`, owner, 'POST');
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ code: 'host_action_unknown' });
    }
    expect(run.calls).toEqual([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(hostRows(auditPath)).toEqual([]);
  });
});

describe('scope', () => {
  it('403s a WRITE token and a share token on both routes, and runs nothing', async () => {
    const run = flipRunner();
    const { url, owner, write, share } = await boot(
      HostActions.fromConfig(CONFIG, run),
    );
    for (const token of [write, share]) {
      expect((await call(`${url}/rc/host/actions`, token)).status).toBe(403);
      expect(
        (await call(`${url}/rc/host/actions/launcher/start`, token, 'POST'))
          .status,
      ).toBe(403);
    }
    expect(run.calls).toEqual([]);
    // The same mount answers the owner, so the 403s above are the scope
    // floor and not a route that was never there.
    expect((await call(`${url}/rc/host/actions`, owner)).status).toBe(200);
  });
});
