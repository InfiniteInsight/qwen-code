/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UnknownSessionError,
  WorkspacePoolFullError,
  type DaemonEndpoint,
} from '../daemonPool.js';
import {
  AUDIT_ACTIONS,
  type AuditEntry,
  type AuditRecorder,
} from '../auditLog.js';
import { FRONT_ATTESTATION, PEER_HEADER } from '../tls/http2Front.js';
import {
  createHostAttachRoutes,
  type HostAttachDaemon,
  type HostAttachDeps,
} from './hostAttach.js';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { OWNER, SESSION_READ, APPROVE, WRITE } from '../scopes.js';
import type { SessionDaemon } from '../daemonPool.js';
import { HostAttachedWorkspaces } from '../hostAttachedWorkspaces.js';
import { resolveChatsDir } from '../sessions/chatsPath.js';

const TOKEN = 'host-attach-token-1';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const QWEN = ['/usr/bin/node', '/opt/qwen/dist/index.js'];

let dir: string;
let workspace: string;
let gateway: Server | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-host-attach-'));
  workspace = join(dir, 'proj');
  await mkdir(workspace);
});

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  gateway = undefined;
  await rm(dir, { recursive: true, force: true });
});

interface Calls {
  create: Array<{ workspaceCwd?: string; sessionScope?: string }>;
  resume: Array<{ id: string; workspaceCwd: string }>;
  endpoint: string[];
}

/**
 * A pool stand-in. `known` is the set of session ids the pool tracks; create
 * and resume add to it, the way DaemonPool.trackSession does, so the endpoint
 * lookup that follows them succeeds.
 */
function fakePool(
  over: {
    known?: string[];
    endpoint?: (id: string) => DaemonEndpoint | undefined;
    create?: () => Promise<{ sessionId: string; workspaceCwd: string }>;
    resume?: (id: string) => Promise<unknown>;
    noEndpointLookup?: boolean;
  } = {},
): { daemon: HostAttachDaemon; calls: Calls } {
  const known = new Set(over.known ?? []);
  const calls: Calls = { create: [], resume: [], endpoint: [] };
  const endpointFor = (id: string): DaemonEndpoint | undefined =>
    over.endpoint
      ? over.endpoint(id)
      : {
          url: 'http://127.0.0.1:46135',
          token: 'daemon-secret',
          workspaceCwd: workspace,
        };
  const daemon = {
    createOrAttachSession: async (req: {
      workspaceCwd?: string;
      sessionScope?: string;
    }) => {
      calls.create.push(req);
      const session = over.create
        ? await over.create()
        : { sessionId: SESSION, workspaceCwd: req.workspaceCwd ?? '' };
      known.add(session.sessionId);
      return { ...session, attached: false };
    },
    resumeSession: async (id: string, req: { workspaceCwd: string }) => {
      calls.resume.push({ id, workspaceCwd: req.workspaceCwd });
      const restored = over.resume ? await over.resume(id) : { sessionId: id };
      known.add(id);
      return restored;
    },
    ...(over.noEndpointLookup
      ? {}
      : {
          daemonEndpointForSession: (id: string) => {
            calls.endpoint.push(id);
            if (!known.has(id)) throw new UnknownSessionError(id);
            return endpointFor(id);
          },
        }),
  } as unknown as HostAttachDaemon;
  return { daemon, calls };
}

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function mount(
  daemon: HostAttachDaemon,
  over: Partial<HostAttachDeps> = {},
) {
  const audit = fakeAudit();
  const routes = createHostAttachRoutes({
    daemon,
    token: TOKEN,
    audit,
    planOpts: { qwenArgv: QWEN },
    ...over,
  });
  const app = express();
  app.use(express.json());
  app.post('/rc/host/attach', routes.create);
  app.post('/rc/host/attach/:sessionId', routes.attach);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, audit };
}

async function post(
  url: string,
  path: string,
  body: unknown,
  opts: { token?: string | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

const REMOTE_PEER = {
  [PEER_HEADER]: '203.0.113.9',
  'x-rc-front': FRONT_ATTESTATION,
};

describe('host attach audit actions', () => {
  it('registers both actions, so /rc/audit can filter on them', () => {
    expect(AUDIT_ACTIONS).toContain('host_attached');
    expect(AUDIT_ACTIONS).toContain('host_attach_rejected');
  });
});

describe('host attach gates', () => {
  for (const path of ['/rc/host/attach', `/rc/host/attach/${SESSION}`]) {
    it(`403s an attested remote peer on ${path} before the token is read`, async () => {
      const { daemon, calls } = fakePool({ known: [SESSION] });
      const { url, audit } = await mount(daemon);
      const res = await post(
        url,
        path,
        { cwd: workspace },
        { headers: REMOTE_PEER },
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('loopback_only');
      expect(calls.create).toHaveLength(0);
      expect(calls.endpoint).toHaveLength(0);
      expect(audit.calls).toEqual([
        {
          action: 'host_attach_rejected',
          detail: { reason: 'non_loopback' },
        },
      ]);
    });

    it(`401s a missing or wrong bearer on ${path}`, async () => {
      const { daemon, calls } = fakePool({ known: [SESSION] });
      const { url, audit } = await mount(daemon);
      const missing = await post(
        url,
        path,
        { cwd: workspace },
        { token: null },
      );
      // A phone's TokenStore token is just another wrong bearer here.
      const phone = await post(
        url,
        path,
        { cwd: workspace },
        { token: 'rc_phone_owner_token' },
      );
      expect(missing.status).toBe(401);
      expect(phone.status).toBe(401);
      expect(phone.body.code).toBe('unauthorized');
      expect(calls.create).toHaveLength(0);
      expect(calls.endpoint).toHaveLength(0);
      expect(audit.calls.map((c) => c.detail)).toEqual([
        { reason: 'bad_token' },
        { reason: 'bad_token' },
      ]);
    });
  }

  it('accepts an attested loopback peer, so the carried value is really read', async () => {
    const { daemon } = fakePool();
    const { url } = await mount(daemon);
    const res = await post(
      url,
      '/rc/host/attach',
      { cwd: workspace },
      {
        headers: {
          [PEER_HEADER]: '127.0.0.1',
          'x-rc-front': FRONT_ATTESTATION,
        },
      },
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /rc/host/attach (create)', () => {
  it('creates a thread session for the cwd and hands back the attach command', async () => {
    const { daemon, calls } = fakePool();
    const { url, audit } = await mount(daemon);
    const res = await post(url, '/rc/host/attach', { cwd: workspace });
    expect(res.status).toBe(200);
    expect(calls.create).toEqual([
      { workspaceCwd: workspace, sessionScope: 'thread' },
    ]);
    expect(res.body).toEqual({
      sessionId: SESSION,
      workspaceCwd: workspace,
      daemonUrl: 'http://127.0.0.1:46135',
      daemonToken: 'daemon-secret',
      linuxArgv: [
        ...QWEN,
        '--attach-daemon',
        'http://127.0.0.1:46135',
        '--daemon-token',
        'daemon-secret',
        '--attach-session',
        SESSION,
      ],
      title: `qwen ${SESSION.slice(0, 8)}`,
      via: 'created',
    });
    expect(audit.calls).toEqual([
      {
        action: 'host_attached',
        target: SESSION,
        outcome: 'ok',
        detail: { via: 'created' },
      },
    ]);
  });

  it('defaults the command to qwen on PATH when no argv is configured', async () => {
    const { daemon } = fakePool();
    const { url } = await mount(daemon, { planOpts: {} });
    const res = await post(url, '/rc/host/attach', { cwd: workspace });
    expect((res.body.linuxArgv as string[])[0]).toBe('qwen');
  });

  it('answers with the workspace the pool bound, not the spelling it was sent', async () => {
    const { daemon } = fakePool({
      endpoint: () => ({
        url: 'http://127.0.0.1:46135',
        token: 'daemon-secret',
        workspaceCwd: '/canonical/proj',
      }),
    });
    const { url } = await mount(daemon);
    const res = await post(url, '/rc/host/attach', { cwd: `${workspace}/` });
    expect(res.body.workspaceCwd).toBe('/canonical/proj');
  });

  it('400s a missing cwd as cwd_required without touching the daemon', async () => {
    const { daemon, calls } = fakePool();
    const { url, audit } = await mount(daemon);
    const res = await post(url, '/rc/host/attach', {});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('cwd_required');
    expect(calls.create).toHaveLength(0);
    expect(audit.calls).toEqual([
      {
        action: 'host_attached',
        outcome: 'failed',
        detail: { via: 'create', code: 'cwd_required' },
      },
    ]);
  });

  it('400s a cwd that is not an existing absolute directory', async () => {
    const file = join(dir, 'a-file');
    await writeFile(file, 'x');
    const { daemon, calls } = fakePool();
    const { url, audit } = await mount(daemon);
    for (const cwd of [join(dir, 'nope'), file, 'proj']) {
      const res = await post(url, '/rc/host/attach', { cwd });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_workspace');
      // The answer never echoes the path it was given.
      expect(JSON.stringify(res.body)).not.toContain(dir);
    }
    expect(calls.create).toHaveLength(0);
    // No path in the audit either.
    expect(JSON.stringify(audit.calls)).not.toContain(dir);
  });

  it('503s a full pool and 502s any other daemon failure', async () => {
    const full = fakePool({
      create: async () => {
        throw new WorkspacePoolFullError(3);
      },
    });
    const { url } = await mount(full.daemon);
    const r1 = await post(url, '/rc/host/attach', { cwd: workspace });
    expect(r1.status).toBe(503);
    expect(r1.body.code).toBe('workspace_pool_full');

    await new Promise<void>((r) => gateway!.close(() => r()));
    gateway = undefined;
    const broken = fakePool({
      create: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const second = await mount(broken.daemon);
    const r2 = await post(second.url, '/rc/host/attach', { cwd: workspace });
    expect(r2.status).toBe(502);
    expect(r2.body.code).toBe('daemon_unavailable');
  });

  it('409s when the owning daemon has no token to hand over', async () => {
    const { daemon } = fakePool({
      endpoint: () => ({
        url: 'http://127.0.0.1:46135',
        token: undefined,
        workspaceCwd: workspace,
      }),
    });
    const { url } = await mount(daemon);
    const res = await post(url, '/rc/host/attach', { cwd: workspace });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('daemon_unavailable');
  });

  it('501s a daemon with no endpoint lookup before creating anything', async () => {
    const { daemon, calls } = fakePool({ noEndpointLookup: true });
    const { url } = await mount(daemon);
    const res = await post(url, '/rc/host/attach', { cwd: workspace });
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('host_attach_unsupported');
    expect(calls.create).toHaveLength(0);
  });
});

describe('POST /rc/host/attach/:sessionId (attach by id)', () => {
  it('returns the endpoint of a session the pool already tracks, no cwd needed', async () => {
    const { daemon, calls } = fakePool({ known: [SESSION] });
    const { url, audit } = await mount(daemon);
    const res = await post(url, `/rc/host/attach/${SESSION}`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sessionId: SESSION,
      workspaceCwd: workspace,
      daemonUrl: 'http://127.0.0.1:46135',
      daemonToken: 'daemon-secret',
      via: 'pooled',
    });
    expect((res.body.linuxArgv as string[]).slice(-2)).toEqual([
      '--attach-session',
      SESSION,
    ]);
    expect(calls.create).toHaveLength(0);
    expect(calls.resume).toHaveLength(0);
    expect(audit.calls).toEqual([
      {
        action: 'host_attached',
        target: SESSION,
        outcome: 'ok',
        detail: { via: 'pooled' },
      },
    ]);
  });

  it('resumes a session the pool does not track, in the cwd it was given', async () => {
    const { daemon, calls } = fakePool();
    const { url, audit } = await mount(daemon);
    const res = await post(url, `/rc/host/attach/${SESSION}`, {
      cwd: workspace,
    });
    expect(res.status).toBe(200);
    expect(calls.resume).toEqual([{ id: SESSION, workspaceCwd: workspace }]);
    expect(res.body).toMatchObject({
      sessionId: SESSION,
      workspaceCwd: workspace,
      daemonToken: 'daemon-secret',
      via: 'resumed',
    });
    expect(audit.calls[0]).toMatchObject({
      action: 'host_attached',
      target: SESSION,
      outcome: 'ok',
      detail: { via: 'resumed' },
    });
  });

  it('400s cwd_required when the pool does not track the session and no cwd came', async () => {
    const { daemon, calls } = fakePool();
    const { url, audit } = await mount(daemon);
    const res = await post(url, `/rc/host/attach/${SESSION}`, {});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('cwd_required');
    expect(calls.resume).toHaveLength(0);
    expect(audit.calls).toEqual([
      {
        action: 'host_attached',
        target: SESSION,
        outcome: 'failed',
        detail: { via: 'resume', code: 'cwd_required' },
      },
    ]);
  });

  it('400s invalid_workspace for a resume cwd that is not a directory', async () => {
    const { daemon, calls } = fakePool();
    const { url } = await mount(daemon);
    const res = await post(url, `/rc/host/attach/${SESSION}`, {
      cwd: join(dir, 'nope'),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_workspace');
    expect(calls.resume).toHaveLength(0);
  });

  it('404s a session neither the pool nor the daemon knows', async () => {
    for (const err of [
      Object.assign(new Error('daemon said 404'), { status: 404 }),
      new UnknownSessionError(SESSION),
    ]) {
      const { daemon } = fakePool({
        resume: async () => {
          throw err;
        },
      });
      const { url } = await mount(daemon);
      const res = await post(url, `/rc/host/attach/${SESSION}`, {
        cwd: workspace,
      });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('session_not_found');
      await new Promise<void>((r) => gateway!.close(() => r()));
      gateway = undefined;
    }
  });

  it('502s a resume the daemon failed for another reason', async () => {
    const { daemon } = fakePool({
      resume: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const { url } = await mount(daemon);
    const res = await post(url, `/rc/host/attach/${SESSION}`, {
      cwd: workspace,
    });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('daemon_unavailable');
  });

  it('404s a malformed session id without asking the pool', async () => {
    const { daemon, calls } = fakePool();
    const { url } = await mount(daemon);
    const res = await post(url, '/rc/host/attach/..%2F..%2Fetc', {
      cwd: workspace,
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('session_not_found');
    expect(calls.endpoint).toHaveLength(0);
    expect(calls.resume).toHaveLength(0);
  });

  it('never writes a token or a path into the audit', async () => {
    const { daemon } = fakePool();
    const { url, audit } = await mount(daemon);
    await post(url, `/rc/host/attach/${SESSION}`, { cwd: workspace });
    await post(url, '/rc/host/attach', { cwd: workspace });
    const text = JSON.stringify(audit.calls);
    expect(text).not.toContain('daemon-secret');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(dir);
  });
});

/**
 * The whole app, so the mount order is what is under test: the routes sit
 * before bearerResolve, which means the host-attach token works there and
 * nowhere else, and a phone's owner token does not work there.
 */
async function bootApp(
  withHostAttach: boolean,
  attachedWorkspaces?: HostAttachedWorkspaces,
) {
  const { daemon } = fakePool();
  const fullDaemon = {
    ...(daemon as object),
    capabilities: async () => ({
      v: 1,
      mode: 'http-bridge',
      features: [],
      workspaceCwd: join(dir, 'boot'),
    }),
  } as unknown as SessionDaemon;
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const pairing = new PairingService();
  const { app } = createGatewayApp({
    daemon: fullDaemon,
    store,
    pairing,
    auditPath: join(dir, 'audit.log'),
    commandsUserDir: join(dir, 'user-commands'),
    terminalQwenArgv: QWEN,
    ...(withHostAttach ? { hostAttach: { token: TOKEN } } : {}),
    ...(attachedWorkspaces
      ? { hostAttachedWorkspaces: attachedWorkspaces }
      : {}),
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const { code } = pairing.mint([OWNER, SESSION_READ, APPROVE, WRITE]);
  const owner = (await (
    await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'phone' }),
    })
  ).json()) as { token: string };
  return { url, ownerToken: owner.token };
}

describe('mounted in the gateway app', () => {
  it('lets the host-attach token through and refuses a phone owner token', async () => {
    const { url, ownerToken } = await bootApp(true);
    const ok = await post(url, '/rc/host/attach', { cwd: workspace });
    expect(ok.status).toBe(200);
    expect(ok.body.linuxArgv as string[]).toContain('--attach-session');
    expect((ok.body.linuxArgv as string[]).slice(0, 2)).toEqual(QWEN);

    const phone = await post(
      url,
      '/rc/host/attach',
      { cwd: workspace },
      { token: ownerToken },
    );
    expect(phone.status).toBe(401);
  });

  it('never lets the host-attach token open a phone route', async () => {
    const { url, ownerToken } = await bootApp(true);
    const asHost = await fetch(`${url}/rc/capabilities`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(asHost.status).toBe(401);
    const asPhone = await fetch(`${url}/rc/capabilities`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(asPhone.status).toBe(200);
    const caps = (await asPhone.json()) as {
      remoteControl: { hostAttach?: boolean };
    };
    expect(caps.remoteControl.hostAttach).toBe(true);
  });

  it('does not mount without a token, and says so in capabilities', async () => {
    const { url, ownerToken } = await bootApp(false);
    // Unmounted, the path falls through to bearerResolve, which refuses the
    // host token as it would any unknown bearer.
    const res = await post(url, '/rc/host/attach', { cwd: workspace });
    expect(res.status).toBe(401);
    const caps = (await (
      await fetch(`${url}/rc/capabilities`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      })
    ).json()) as { remoteControl: { hostAttach?: boolean } };
    expect(caps.remoteControl.hostAttach).toBe(false);
  });
});

describe('the attached-workspaces record', () => {
  function fakeRecorder(fail = false) {
    const calls: string[] = [];
    return {
      calls,
      record: async (cwd: string) => {
        calls.push(cwd);
        if (fail) throw new Error('EACCES');
      },
    };
  }

  it('notes the canonical workspace on each of created, pooled and resumed', async () => {
    const rec = fakeRecorder();
    const canonical = {
      url: 'http://127.0.0.1:46135',
      token: 'daemon-secret',
      workspaceCwd: '/canonical/proj',
    };
    const OTHER = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { daemon } = fakePool({ known: [OTHER], endpoint: () => canonical });
    const { url } = await mount(daemon, { attachedWorkspaces: rec });
    const created = await post(url, '/rc/host/attach', { cwd: workspace });
    const pooled = await post(url, `/rc/host/attach/${OTHER}`, {});
    const resumed = await post(
      url,
      '/rc/host/attach/cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee',
      { cwd: workspace },
    );
    expect([created.body.via, pooled.body.via, resumed.body.via]).toEqual([
      'created',
      'pooled',
      'resumed',
    ]);
    expect(rec.calls).toEqual([
      '/canonical/proj',
      '/canonical/proj',
      '/canonical/proj',
    ]);
  });

  it('notes nothing on any refusal', async () => {
    const rec = fakeRecorder();
    const file = join(dir, 'a-file');
    await writeFile(file, 'x');
    const { daemon } = fakePool();
    const { url } = await mount(daemon, { attachedWorkspaces: rec });
    const statuses = [
      (
        await post(
          url,
          '/rc/host/attach',
          { cwd: workspace },
          { headers: REMOTE_PEER },
        )
      ).status,
      (
        await post(
          url,
          '/rc/host/attach',
          { cwd: workspace },
          { token: 'wrong' },
        )
      ).status,
      (await post(url, '/rc/host/attach', {})).status,
      (await post(url, '/rc/host/attach', { cwd: file })).status,
      (await post(url, `/rc/host/attach/${SESSION}`, {})).status,
      (await post(url, '/rc/host/attach/not-a-session', { cwd: workspace }))
        .status,
    ];
    expect(statuses).toEqual([403, 401, 400, 400, 400, 404]);

    // The daemon-side refusals too: no token, unknown session, daemon down.
    const remount = async (d: HostAttachDaemon) => {
      await new Promise<void>((r) => gateway!.close(() => r()));
      gateway = undefined;
      return (await mount(d, { attachedWorkspaces: rec })).url;
    };
    let u = await remount(
      fakePool({
        endpoint: () => ({
          url: 'http://127.0.0.1:1',
          token: undefined,
          workspaceCwd: workspace,
        }),
      }).daemon,
    );
    expect((await post(u, '/rc/host/attach', { cwd: workspace })).status).toBe(
      409,
    );
    expect(
      (await post(u, `/rc/host/attach/${SESSION}`, { cwd: workspace })).status,
    ).toBe(409);
    u = await remount(
      fakePool({
        resume: async () => {
          throw Object.assign(new Error('nope'), { status: 404 });
        },
      }).daemon,
    );
    expect(
      (await post(u, `/rc/host/attach/${SESSION}`, { cwd: workspace })).status,
    ).toBe(404);
    u = await remount(
      fakePool({
        create: async () => {
          throw new Error('ECONNREFUSED');
        },
      }).daemon,
    );
    expect((await post(u, '/rc/host/attach', { cwd: workspace })).status).toBe(
      502,
    );
    expect(rec.calls).toEqual([]);
  });

  it('still attaches when the record cannot be written', async () => {
    const rec = fakeRecorder(true);
    const { daemon } = fakePool();
    const { url } = await mount(daemon, { attachedWorkspaces: rec });
    const res = await post(url, '/rc/host/attach', { cwd: workspace });
    expect(res.status).toBe(200);
    expect(rec.calls).toEqual([workspace]);
  });

  it('puts a terminal-born conversation in a never-used folder into the phone list', async () => {
    const runtimeBase = join(dir, 'runtime');
    const prior = process.env['QWEN_RUNTIME_DIR'];
    process.env['QWEN_RUNTIME_DIR'] = runtimeBase;
    try {
      // The conversation's transcript lives under the attached folder only.
      const chats = resolveChatsDir(workspace);
      await mkdir(chats, { recursive: true });
      await writeFile(
        join(chats, `${SESSION}.jsonl`),
        `${JSON.stringify({ sessionId: SESSION, type: 'user' })}\n`,
      );
      const store = HostAttachedWorkspaces.open(
        join(dir, 'rc', 'host-attached-workspaces.json'),
      );
      const { url, ownerToken } = await bootApp(true, store);
      const list = async () =>
        (
          (await (
            await fetch(`${url}/rc/sessions`, {
              headers: { Authorization: `Bearer ${ownerToken}` },
            })
          ).json()) as { sessions: Array<{ sessionId: string }> }
        ).sessions.map((x) => x.sessionId);

      expect(await list()).not.toContain(SESSION);
      const res = await post(url, '/rc/host/attach', { cwd: workspace });
      expect(res.status).toBe(200);
      expect(await store.read()).toEqual([
        { cwd: workspace, at: expect.any(Number) },
      ]);
      expect(await list()).toContain(SESSION);
    } finally {
      if (prior === undefined) delete process.env['QWEN_RUNTIME_DIR'];
      else process.env['QWEN_RUNTIME_DIR'] = prior;
    }
  });
});
