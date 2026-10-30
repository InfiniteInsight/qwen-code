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

import { describe, it, expect, afterEach, vi } from 'vitest';
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
import { TerminalRequestLog } from '../terminals.js';
import { SESSION_READ, SHARE, WRITE } from '../scopes.js';
import {
  AUTO_REOPEN_WINDOW_MS,
  autoReopenEligible,
  sessionEndpointResolver,
  type TabEndpointAnswer,
} from './hostTabs.js';
import {
  UnknownSessionError,
  WorkspacePoolFullError,
  type DaemonEndpoint,
} from '../daemonPool.js';
import { FRONT_ATTESTATION, PEER_HEADER } from '../tls/http2Front.js';
import { AUDIT_ACTIONS } from '../auditLog.js';

// Every test boots the real app and issues real argon2id tokens (about 0.4 s
// each), so a loaded machine needs more than the default 15 s.
vi.setConfig({ testTimeout: 60_000 });

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

interface BootOpts {
  /** Mount the tab routes at all (an older gateway does not). */
  tabs?: boolean;
  endpointFor?: (sessionId: string, cwd: string) => Promise<TabEndpointAnswer>;
  isMirrored?: (sessionId: string) => Promise<boolean>;
  /** Wire no request log, as a gateway without host terminals. */
  noRequests?: boolean;
  /** `--reopen-crashed-tabs`. */
  autoReopen?: boolean;
  /** Also issue write, reader and share tokens (each is a real argon2id hash). */
  scoped?: boolean;
}

const ENDPOINT = (cwd: string): TabEndpointAnswer => ({
  ok: true,
  endpoint: {
    url: 'http://127.0.0.1:46135',
    token: 'daemon-secret',
    workspaceCwd: cwd,
  },
});

async function boot(opts: BootOpts = {}) {
  base = await mkdtemp(join(tmpdir(), 'rc-host-tabs-route-'));
  stub = await startStubDaemon();
  const probe = tableProbe();
  let clock = 1_000_000;
  const now = () => clock;
  const registry = await HostTabRegistry.open(join(base, 'host-tabs.json'), {
    now,
    probe,
    ghostGraceMs: 12_000,
  });
  const requests = TerminalRequestLog.open(
    join(base, 'terminal-requests.jsonl'),
    { now },
  );
  const store = await TokenStore.open(join(base, 'tokens.json'));
  const { token: owner } = await store.issue(['owner'], 'o');
  let write = '';
  let reader = '';
  let shareToken = '';
  if (opts.scoped) {
    write = (await store.issue([WRITE, SESSION_READ], 'w')).token;
    reader = (await store.issue([SESSION_READ], 'r')).token;
    shareToken = (
      await store.issueShare({
        scopes: [SHARE, SESSION_READ],
        label: 'guest',
        sessionLockId: S1,
        ttlSec: 3600,
        parentId: 'owner',
      })
    ).token;
  }
  const auditPath = join(base, 'audit.log');
  const gw = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath,
    hostAttach: { token: HOST_TOKEN },
    ...(opts.noRequests ? {} : { terminalRequests: requests }),
    terminalRcArgv: ['qwen-rc'],
    ...(opts.tabs === false
      ? {}
      : {
          hostTabs: {
            registry,
            endpointFor: opts.endpointFor ?? (async (_s, cwd) => ENDPOINT(cwd)),
            isMirrored: opts.isMirrored ?? (async () => false),
            autoReopen: opts.autoReopen === true,
          },
        }),
  });
  server = await new Promise<Server>((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    owner,
    write,
    reader,
    share: shareToken,
    registry,
    requests,
    probe,
    auditPath,
    tick: (ms: number) => {
      clock += ms;
    },
    /** The launcher polls now. */
    poll: () => requests.recordPoll(0),
    sweep: gw.hostTabSweep,
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

const S2 = 'b9a5ddef-edc9-472e-8c52-ea6da2609e81';

/** A crashed record of S1 (exit 137) and a live one of S2. */
async function seed(g: Awaited<ReturnType<typeof boot>>) {
  g.probe.fd0.set(11, '/dev/pts/1');
  g.probe.fd0.set(12, '/dev/pts/2');
  const crashed = await g.registry.start({
    sessionId: S1,
    cwd: '/srv/w',
    pid: 11,
  });
  await g.registry.end(crashed.tabId, 137);
  g.tick(1_000);
  const live = await g.registry.start({
    sessionId: S2,
    cwd: '/srv/v',
    pid: 12,
  });
  return { crashed, live };
}

describe('GET /rc/host/tabs', () => {
  it('lists every record with its derived state and the launcher, to owner and write tokens', async () => {
    const g = await boot({ scoped: true });
    const { crashed, live } = await seed(g);
    await g.poll();
    for (const token of [g.owner, g.write]) {
      const res = await send(g.url, '/rc/host/tabs', { method: 'GET', token });
      expect(res.status).toBe(200);
      const tabs = res.body.tabs as Array<Record<string, unknown>>;
      expect(tabs.map((t) => [t.tabId, t.state, t.reason, t.exitCode])).toEqual(
        [
          [live.tabId, 'live', null, null],
          [crashed.tabId, 'crashed', 'crashed', 137],
        ],
      );
      expect(tabs[1]).toMatchObject({
        sessionId: S1,
        cwd: '/srv/w',
        dismissed: false,
      });
      expect(tabs[1]).not.toHaveProperty('pidStart');
      expect(res.body.launcher).toEqual({ state: 'live', seenMsAgo: 0 });
    }
  });

  it('refuses a reader and a share; capabilities say hostTabs', async () => {
    const g = await boot({ scoped: true });
    for (const token of [g.reader, g.share]) {
      const res = await send(g.url, '/rc/host/tabs', { method: 'GET', token });
      expect([res.status, res.body.code]).toEqual([403, 'scope_required']);
    }
    const caps = await send(g.url, '/rc/capabilities', {
      method: 'GET',
      token: g.owner,
    });
    expect((caps.body.remoteControl as Record<string, unknown>).hostTabs).toBe(
      true,
    );
  });

  it('is absent on a gateway without the registry, and capabilities say so', async () => {
    const old = await boot({ tabs: false });
    const res = await send(old.url, '/rc/host/tabs', {
      method: 'GET',
      token: old.owner,
    });
    expect(res.status).toBe(404);
    const oldCaps = await send(old.url, '/rc/capabilities', {
      method: 'GET',
      token: old.owner,
    });
    expect(
      (oldCaps.body.remoteControl as Record<string, unknown>).hostTabs,
    ).toBe(false);
  });
});

describe('POST /rc/host/tabs/:tabId/reopen', () => {
  it('queues a terminal request for the crashed tab, notes the reopen and audits it without a path', async () => {
    const g = await boot({ scoped: true });
    const { crashed } = await seed(g);
    await g.poll();
    const res = await send(g.url, `/rc/host/tabs/${crashed.tabId}/reopen`, {
      token: g.write,
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      tabId: crashed.tabId,
      requestId: expect.any(String),
      launcherState: 'live',
      launcherSeenMsAgo: 0,
    });
    expect(JSON.stringify(res.body)).not.toContain('daemon-secret');
    const queued = await g.requests.readAll();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      id: res.body.requestId,
      sessionId: S1,
      workspaceCwd: '/srv/w',
      daemonToken: 'daemon-secret',
      linuxArgv: ['qwen-rc', 'attach', '--session', S1, '/srv/w'],
    });
    expect(g.registry.get(crashed.tabId)?.reopenedAt).toBeDefined();
    expect(g.registry.get(crashed.tabId)?.autoReopenedAt).toBeUndefined();
    const rows = await auditRows(g.auditPath, 'host_tab_reopened', 1);
    expect(rows[0]).toMatchObject({
      target: S1,
      outcome: 'ok',
      detail: {
        tabId: crashed.tabId,
        requestId: res.body.requestId,
        auto: false,
      },
    });
    expect(JSON.stringify(rows)).not.toContain('/srv/w');
    // The tab the launcher opens attaches with a pid: it replaces the record.
    g.probe.fd0.set(13, '/dev/pts/3');
    const next = await g.registry.start({
      sessionId: S1,
      cwd: '/srv/w',
      pid: 13,
    });
    expect(next.origin).toBe('reopen');
    const list = await send(g.url, '/rc/host/tabs', {
      method: 'GET',
      token: g.owner,
    });
    const states = Object.fromEntries(
      (list.body.tabs as Array<{ tabId: string; state: string }>).map((t) => [
        t.tabId,
        t.state,
      ]),
    );
    expect(states[crashed.tabId]).toBe('replaced');
    expect(states[next.tabId]).toBe('live');
  });

  it('reopens a ghost too: an open record whose wrapper is gone', async () => {
    const g = await boot();
    g.probe.fd0.set(21, '/dev/pts/1');
    const t = await g.registry.start({ sessionId: S1, cwd: '/srv/w', pid: 21 });
    g.probe.fd0.delete(21);
    await g.poll();
    const res = await send(g.url, `/rc/host/tabs/${t.tabId}/reopen`, {
      token: g.owner,
    });
    expect(res.status).toBe(202);
  });

  it('refuses with the launcher liveness when the launcher is stale or never ran, and queues nothing', async () => {
    const g = await boot();
    const { crashed } = await seed(g);
    const never = await send(g.url, `/rc/host/tabs/${crashed.tabId}/reopen`, {
      token: g.owner,
    });
    expect(never.status).toBe(409);
    expect(never.body).toMatchObject({
      code: 'launcher_unavailable',
      launcherState: 'never',
      launcherSeenMsAgo: null,
    });
    await g.poll();
    g.tick(60_000);
    const stale = await send(g.url, `/rc/host/tabs/${crashed.tabId}/reopen`, {
      token: g.owner,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'launcher_unavailable',
      launcherState: 'stale',
      launcherSeenMsAgo: 60_000,
    });
    expect(await g.requests.readAll()).toEqual([]);
    expect(g.registry.get(crashed.tabId)?.reopenedAt).toBeUndefined();
    const rows = await auditRows(g.auditPath, 'host_tab_reopened', 2);
    expect(
      rows.map((r) => [r['outcome'], (r['detail'] as { code: string }).code]),
    ).toEqual([
      ['failed', 'launcher_unavailable'],
      ['failed', 'launcher_unavailable'],
    ]);
  });

  it('refuses a live tab, a quit one, an unknown one, and a gateway with no request log', async () => {
    const g = await boot();
    const { live } = await seed(g);
    await g.poll();
    const quit = await g.registry.start({
      sessionId: 'c0000000-0000-4000-8000-000000000001',
      cwd: '/srv/w',
      pid: 31,
    });
    await g.registry.end(quit.tabId, 0);
    const a = await send(g.url, `/rc/host/tabs/${live.tabId}/reopen`, {
      token: g.owner,
    });
    const b = await send(g.url, `/rc/host/tabs/${quit.tabId}/reopen`, {
      token: g.owner,
    });
    const c = await send(
      g.url,
      '/rc/host/tabs/00000000-0000-4000-8000-000000000999/reopen',
      { token: g.owner },
    );
    const d = await send(g.url, '/rc/host/tabs/x/reopen', { token: g.owner });
    expect([a.status, a.body.code, a.body.state]).toEqual([
      409,
      'tab_live',
      'live',
    ]);
    expect([b.status, b.body.code, b.body.state]).toEqual([
      409,
      'tab_not_reopenable',
      'quit',
    ]);
    expect([c.status, c.body.code]).toEqual([404, 'tab_not_found']);
    expect([d.status, d.body.code]).toEqual([404, 'tab_not_found']);
    expect(await g.requests.readAll()).toEqual([]);
  });

  it('answers alreadyMirrored and queues nothing when a terminal already shows the conversation', async () => {
    const g = await boot({ isMirrored: async (id) => id === S1 });
    const { crashed } = await seed(g);
    await g.poll();
    const res = await send(g.url, `/rc/host/tabs/${crashed.tabId}/reopen`, {
      token: g.owner,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      alreadyMirrored: true,
      sessionId: S1,
      tabId: crashed.tabId,
    });
    expect(await g.requests.readAll()).toEqual([]);
  });

  it('passes on why no daemon could take the session, and queues nothing', async () => {
    const g = await boot({
      endpointFor: async () => ({
        ok: false,
        status: 404,
        code: 'session_not_found',
        error: 'Session not found',
      }),
    });
    const { crashed } = await seed(g);
    await g.poll();
    const res = await send(g.url, `/rc/host/tabs/${crashed.tabId}/reopen`, {
      token: g.owner,
    });
    expect([res.status, res.body.code]).toEqual([404, 'session_not_found']);
    expect(await g.requests.readAll()).toEqual([]);
  });

  it('is never reachable on read scope', async () => {
    const g = await boot({ scoped: true });
    const { crashed } = await seed(g);
    await g.poll();
    for (const token of [g.reader, g.share]) {
      const res = await send(g.url, `/rc/host/tabs/${crashed.tabId}/reopen`, {
        token,
      });
      expect(res.status).toBe(403);
    }
    expect(await g.requests.readAll()).toEqual([]);
  });
});

describe('dismiss and remove', () => {
  it('dismiss keeps the record and marks it; remove deletes it; both audited', async () => {
    const g = await boot({ scoped: true });
    const { crashed } = await seed(g);
    const dis = await send(g.url, `/rc/host/tabs/${crashed.tabId}/dismiss`, {
      token: g.write,
    });
    expect(dis.status).toBe(200);
    expect(dis.body.tab).toMatchObject({
      tabId: crashed.tabId,
      state: 'crashed',
      dismissed: true,
    });
    const del = await send(g.url, `/rc/host/tabs/${crashed.tabId}`, {
      method: 'DELETE',
      token: g.write,
    });
    expect(del.body).toEqual({ tabId: crashed.tabId, removed: true });
    const again = await send(g.url, `/rc/host/tabs/${crashed.tabId}`, {
      method: 'DELETE',
      token: g.write,
    });
    expect([again.status, again.body.code]).toEqual([404, 'tab_not_found']);
    expect(g.registry.get(crashed.tabId)).toBeUndefined();
    const d = await auditRows(g.auditPath, 'host_tab_dismissed', 1);
    const r = await auditRows(g.auditPath, 'host_tab_removed', 1);
    expect(d[0]).toMatchObject({
      target: S1,
      detail: { tabId: crashed.tabId },
    });
    expect(r[0]).toMatchObject({
      target: S1,
      detail: { tabId: crashed.tabId },
    });
  });

  it('refuses a live tab, and a reader', async () => {
    const g = await boot({ scoped: true });
    const { crashed, live } = await seed(g);
    const a = await send(g.url, `/rc/host/tabs/${live.tabId}/dismiss`, {
      token: g.owner,
    });
    const b = await send(g.url, `/rc/host/tabs/${live.tabId}`, {
      method: 'DELETE',
      token: g.owner,
    });
    expect([a.status, a.body.code, b.status, b.body.code]).toEqual([
      409,
      'tab_live',
      409,
      'tab_live',
    ]);
    const c = await send(g.url, `/rc/host/tabs/${crashed.tabId}/dismiss`, {
      token: g.reader,
    });
    const d = await send(g.url, `/rc/host/tabs/${crashed.tabId}`, {
      method: 'DELETE',
      token: g.reader,
    });
    expect([c.status, d.status]).toEqual([403, 403]);
    expect(g.registry.get(crashed.tabId)?.dismissedAt).toBeUndefined();
  });
});

describe('sessionEndpointResolver', () => {
  const EP: DaemonEndpoint = {
    url: 'http://127.0.0.1:1',
    token: 't',
    workspaceCwd: '/srv/w',
  };
  function pool(over: {
    known?: boolean;
    resume?: () => Promise<unknown>;
    token?: string;
    noLookup?: boolean;
  }) {
    let known = over.known ?? false;
    const resumed: Array<[string, string]> = [];
    return {
      resumed,
      daemon: {
        resumeSession: async (id: string, req: { workspaceCwd: string }) => {
          resumed.push([id, req.workspaceCwd]);
          if (over.resume) await over.resume();
          known = true;
          return {};
        },
        ...(over.noLookup
          ? {}
          : {
              daemonEndpointForSession: (id: string) => {
                if (!known) throw new UnknownSessionError(id);
                return { ...EP, token: over.token ?? EP.token };
              },
            }),
      } as never,
    };
  }

  it('answers the pooled endpoint, or restores the session in the tab folder first', async () => {
    const pooled = pool({ known: true });
    expect(await sessionEndpointResolver(pooled.daemon)(S1, '/srv/w')).toEqual({
      ok: true,
      endpoint: EP,
    });
    expect(pooled.resumed).toEqual([]);
    const cold = pool({});
    expect(await sessionEndpointResolver(cold.daemon)(S1, '/srv/w')).toEqual({
      ok: true,
      endpoint: EP,
    });
    expect(cold.resumed).toEqual([[S1, '/srv/w']]);
  });

  it('names each failure', async () => {
    const code = async (p: ReturnType<typeof pool>) => {
      const a = await sessionEndpointResolver(p.daemon)(S1, '/srv/w');
      return a.ok ? 'ok' : `${a.status} ${a.code}`;
    };
    expect(await code(pool({ noLookup: true }))).toBe(
      '501 host_terminals_unsupported',
    );
    expect(
      await code(
        pool({
          resume: async () => {
            throw new UnknownSessionError(S1);
          },
        }),
      ),
    ).toBe('404 session_not_found');
    expect(
      await code(
        pool({
          resume: async () => {
            throw new WorkspacePoolFullError(4);
          },
        }),
      ),
    ).toBe('503 workspace_pool_full');
    expect(
      await code(
        pool({
          resume: async () => {
            throw new Error('boom');
          },
        }),
      ),
    ).toBe('502 daemon_unavailable');
    expect(await code(pool({ known: true, token: '' }))).toBe(
      '409 daemon_unavailable',
    );
  });
});

describe('the automatic reopen (--reopen-crashed-tabs)', () => {
  /** Wait for `n` queued requests (the end route's sweep runs after it answers). */
  async function queued(g: Awaited<ReturnType<typeof boot>>, n: number) {
    const deadline = Date.now() + 2000;
    let all = await g.requests.readAll();
    while (all.length < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      all = await g.requests.readAll();
    }
    return all;
  }
  const end = (
    g: Awaited<ReturnType<typeof boot>>,
    tabId: string,
    exitCode: number,
  ) => send(g.url, `/rc/host/tabs/${tabId}/end`, { body: { exitCode } });

  it('reopens a tab as soon as its end report says crashed, once, and marks the record', async () => {
    const g = await boot({ autoReopen: true });
    await g.poll();
    g.probe.fd0.set(41, '/dev/pts/1');
    const a = await g.registry.start({ sessionId: S1, cwd: '/srv/w', pid: 41 });
    expect((await end(g, a.tabId, 137)).status).toBe(200);
    const q = await queued(g, 1);
    expect(q.map((r) => r.sessionId)).toEqual([S1]);
    expect(g.registry.get(a.tabId)?.autoReopenedAt).toBeDefined();
    const rows = await auditRows(g.auditPath, 'host_tab_reopened', 1);
    expect(rows[0]).toMatchObject({
      outcome: 'ok',
      detail: { tabId: a.tabId, auto: true },
    });
    // Later passes leave it alone.
    await g.sweep!();
    await g.sweep!();
    expect(await g.requests.readAll()).toHaveLength(1);
    // The tab that answered it crashes too: that one is left to the user.
    g.probe.fd0.set(42, '/dev/pts/2');
    const b = await g.registry.start({ sessionId: S1, cwd: '/srv/w', pid: 42 });
    expect(b.origin).toBe('auto_reopen');
    await end(g, b.tabId, 137);
    await g.sweep!();
    expect(await queued(g, 2)).toHaveLength(1);
    const list = await send(g.url, '/rc/host/tabs', {
      method: 'GET',
      token: g.owner,
    });
    expect(list.body.autoReopen).toBe(true);
    const tabs = list.body.tabs as Array<{ tabId: string; state: string }>;
    expect(tabs.find((t) => t.tabId === b.tabId)?.state).toBe('crashed');
  });

  it('never reopens a tab the user quit, closed or interrupted', async () => {
    const g = await boot({ autoReopen: true });
    await g.poll();
    for (const [i, code] of [0, 129, 130].entries()) {
      g.probe.fd0.set(50 + i, '/dev/pts/1');
      const sid = `c0000000-0000-4000-8000-00000000000${i}`;
      const t = await g.registry.start({
        sessionId: sid,
        cwd: '/srv/w',
        pid: 50 + i,
      });
      await end(g, t.tabId, code);
    }
    await g.sweep!();
    expect(await queued(g, 1)).toEqual([]);
  });

  it('waits for a live launcher, with no audit row while it waits, then reopens', async () => {
    const g = await boot({ autoReopen: true });
    g.probe.fd0.set(61, '/dev/pts/1');
    const t = await g.registry.start({ sessionId: S1, cwd: '/srv/w', pid: 61 });
    await end(g, t.tabId, 1);
    await g.sweep!();
    expect(await g.requests.readAll()).toEqual([]);
    await g.poll();
    g.tick(20_000); // polled once, then silent past the stale window
    await g.sweep!();
    expect(await g.requests.readAll()).toEqual([]);
    expect(await auditRows(g.auditPath, 'host_tab_reopened', 0)).toEqual([]);
    await g.poll();
    await g.sweep!();
    expect(await queued(g, 1)).toHaveLength(1);
  });

  it('reopens a tab whose wrapper vanished (SIGKILL) once it turns crashed', async () => {
    const g = await boot({ autoReopen: true });
    g.probe.fd0.set(71, '/dev/pts/1');
    const t = await g.registry.start({ sessionId: S1, cwd: '/srv/w', pid: 71 });
    g.probe.fd0.delete(71);
    await g.poll();
    await g.sweep!(); // a ghost: not yet
    expect(await g.requests.readAll()).toEqual([]);
    g.tick(12_000);
    await g.poll();
    await g.sweep!();
    expect(await queued(g, 1)).toHaveLength(1);
    expect(g.registry.get(t.tabId)?.autoReopenedAt).toBeDefined();
  });

  it('leaves a dismissed crash and an old crash alone, and does nothing when it is off', async () => {
    const g = await boot({ autoReopen: true });
    const old = await g.registry.start({
      sessionId: S1,
      cwd: '/srv/w',
      pid: 81,
    });
    await g.registry.end(old.tabId, 137);
    g.tick(AUTO_REOPEN_WINDOW_MS + 1);
    const dis = await g.registry.start({
      sessionId: S2,
      cwd: '/srv/w',
      pid: 82,
    });
    await g.registry.end(dis.tabId, 137);
    await g.registry.dismiss(dis.tabId);
    await g.poll();
    await g.sweep!();
    expect(await g.requests.readAll()).toEqual([]);

    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    await stub!.close();
    stub = undefined;
    await rm(base!, { recursive: true, force: true });
    const off = await boot();
    await off.poll();
    const t = await off.registry.start({
      sessionId: S1,
      cwd: '/srv/w',
      pid: 83,
    });
    await end(off, t.tabId, 137);
    await off.sweep!();
    expect(await queued(off, 1)).toEqual([]);
    const list = await send(off.url, '/rc/host/tabs', {
      method: 'GET',
      token: off.owner,
    });
    expect(list.body.autoReopen).toBe(false);
  });
});

describe('autoReopenEligible', () => {
  const tab = {
    tabId: '00000000-0000-4000-8000-000000000001',
    sessionId: S1,
    cwd: '/srv/w',
    startedAt: 0,
    pid: 1,
    dismissed: false,
  };
  it('takes a recent crash and nothing else', () => {
    const now = 100_000;
    const yes = {
      ...tab,
      state: 'crashed' as const,
      endedAt: now - 1,
      exitCode: 137,
      reason: 'crashed' as const,
    };
    expect(autoReopenEligible(yes, now)).toBe(true);
    expect(
      autoReopenEligible({ ...tab, state: 'crashed', lostAt: now - 1 }, now),
    ).toBe(true);
    expect(autoReopenEligible({ ...yes, state: 'ghost' }, now)).toBe(false);
    expect(autoReopenEligible({ ...yes, dismissed: true }, now)).toBe(false);
    expect(autoReopenEligible({ ...yes, autoReopenedAt: 5 }, now)).toBe(false);
    expect(autoReopenEligible({ ...yes, origin: 'auto_reopen' }, now)).toBe(
      false,
    );
    expect(autoReopenEligible({ ...yes, origin: 'reopen' }, now)).toBe(true);
    expect(autoReopenEligible({ ...yes, reason: 'interrupted' }, now)).toBe(
      false,
    );
    expect(autoReopenEligible({ ...yes, reason: 'killed' }, now)).toBe(true);
    expect(
      autoReopenEligible(
        { ...yes, endedAt: now - AUTO_REOPEN_WINDOW_MS - 1 },
        now,
      ),
    ).toBe(false);
  });
});
