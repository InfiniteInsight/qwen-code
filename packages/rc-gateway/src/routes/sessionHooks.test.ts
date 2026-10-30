/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import {
  startStubDaemon,
  type StubDaemon,
  type StubDaemonOptions,
} from '../testing/stubDaemon.js';
import {
  DaemonPool,
  UnknownSessionError,
  type PooledDaemonSpawn,
  type SessionDaemon,
} from '../daemonPool.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { createGatewayApp } from '../server.js';
import { SESSION_READ, SHARE, WRITE } from '../scopes.js';
import { commandPreview, createSessionHooksReadRoute } from './sessionHooks.js';

const SID = '11111111-1111-1111-1111-111111111111';
const OTHER_SID = '22222222-2222-2222-2222-222222222222';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;
let tmp: string | undefined;
let pool: DaemonPool | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (pool) await pool.stopAll();
  if (stub) await stub.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  gateway = undefined;
  stub = undefined;
  tmp = undefined;
  pool = undefined;
});

async function listen(app: express.Express): Promise<string> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function mountRoute(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.use(express.json());
  app.get('/session/:id/hooks', createSessionHooksReadRoute(daemon));
  return listen(app);
}

/** Over a REAL DaemonClient (spec ledger D61). */
async function mountReal(opts: StubDaemonOptions = {}): Promise<string> {
  stub = await startStubDaemon(opts);
  return mountRoute(
    new DaemonClient({ baseUrl: stub.baseUrl }) as unknown as SessionDaemon,
  );
}

async function get(
  url: string,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

const HOOKS = (base: string) => `${base}/session/${SID}/hooks`;

// What the daemon sends for a session: env and headers unmasked, the whole
// command, a prompt hook's prompt (acpAgent.serializeHookConfig).
const SEED = [
  {
    kind: 'hook',
    eventName: 'PreToolUse',
    matcher: 'Bash',
    source: 'session',
    enabled: true,
    sequential: true,
    hookId: 'h-1',
    skillRoot: '/home/evan/.qwen/skills/guard',
    config: {
      type: 'command',
      command: 'GUARD_TOKEN=s3cr3t-token python3 tools/guard.py --key sk-live-123',
      name: 'Guard',
      description: 'Refuses a Bash call that touches the release branch',
      timeout: 30,
      env: { GUARD_TOKEN: 's3cr3t-token' },
      async: false,
      shell: 'bash',
      statusMessage: 'guarding',
    },
  },
  {
    kind: 'hook',
    eventName: 'Stop',
    source: 'session',
    enabled: true,
    hookId: 'h-2',
    config: {
      type: 'http',
      url: 'https://user:pw@hooks.example.test/notify?token=abc#frag',
      headers: { Authorization: 'Bearer sk-live-456' },
      allowedEnvVars: ['AWS_SECRET_ACCESS_KEY'],
      timeout: 10,
    },
  },
  {
    kind: 'hook',
    eventName: 'UserPromptSubmit',
    source: 'session',
    enabled: true,
    config: { type: 'prompt', prompt: 'Rewrite the user prompt with the secret handshake', model: 'm' },
  },
];

type View = {
  v: number;
  sessionId: string;
  workspaceCwd: string;
  disabled: boolean;
  hooks: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>;
};

describe('GET /session/:id/hooks (#135)', () => {
  it('answers a projection through the SDK: event, matcher, source, type, name, timeout and the first words of a command', async () => {
    const base = await mountReal({ hooks: { seed: { [SID]: SEED } } });
    const out = await get(HOOKS(base));
    expect(out.status).toBe(200);
    const view = out.body as unknown as View;
    expect(view).toMatchObject({ v: 1, sessionId: SID, disabled: false });
    expect(view.hooks).toHaveLength(3);
    expect(view.hooks[0]).toEqual({
      eventName: 'PreToolUse',
      matcher: 'Bash',
      source: 'session',
      enabled: true,
      sequential: true,
      hookId: 'h-1',
      skill: 'guard',
      type: 'command',
      name: 'Guard',
      description: 'Refuses a Bash call that touches the release branch',
      timeout: 30,
      async: false,
      command: 'python3 tools/guard.py',
    });
    expect(view.hooks[1]).toEqual({
      eventName: 'Stop',
      source: 'session',
      enabled: true,
      hookId: 'h-2',
      type: 'http',
      timeout: 10,
      host: 'hooks.example.test',
    });
    expect(view.hooks[2]).toEqual({
      eventName: 'UserPromptSubmit',
      source: 'session',
      enabled: true,
      type: 'prompt',
    });
    expect(stub?.hooksCalls).toEqual([SID]);
  });

  it('never carries what the daemon leaves unmasked: env, headers, a prompt, the rest of a command, a URL path or password', async () => {
    const base = await mountReal({ hooks: { seed: { [SID]: SEED } } });
    const text = JSON.stringify((await get(HOOKS(base))).body);
    for (const secret of [
      's3cr3t-token',
      'sk-live-123',
      'sk-live-456',
      'AWS_SECRET_ACCESS_KEY',
      'secret handshake',
      'token=abc',
      'user:pw',
      '/notify',
      'GUARD_TOKEN',
      '--key',
      'env',
      'headers',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('a session with no hooks answers an empty list, and disabled and status cells come through in the daemon\'s words', async () => {
    const empty = await get(HOOKS(await mountReal()));
    expect(empty.status).toBe(200);
    expect(empty.body['hooks']).toEqual([]);
    expect(empty.body['errors']).toBeUndefined();
    gateway?.close();
    const base = await mountReal({
      hooks: {
        disabled: true,
        errors: [
          {
            kind: 'session_hooks',
            status: 'error',
            error: 'hook system failed to initialize: settings.json line 4',
            errorKind: 'init_failed',
            hint: 'fix the file and reload the workspace',
          },
        ],
      },
    });
    const out = (await get(HOOKS(base))).body as unknown as View;
    expect(out.disabled).toBe(true);
    expect(out.errors).toEqual([
      {
        kind: 'session_hooks',
        status: 'error',
        error: 'hook system failed to initialize: settings.json line 4',
        errorKind: 'init_failed',
        hint: 'fix the file and reload the workspace',
      },
    ]);
  });

  it('refuses a malformed session id without asking the daemon', async () => {
    const base = await mountReal();
    const out = await get(`${base}/session/not-an-id/hooks`);
    expect(out.status).toBe(404);
    expect(out.body['code']).toBe('session_not_found');
    expect(stub?.hooksCalls).toEqual([]);
  });

  it('each daemon failure is told in the gateway\'s words with a code', async () => {
    const failing = (err: unknown) =>
      ({
        sessionHooks: async () => {
          throw err;
        },
      }) as unknown as SessionDaemon;
    const cases: Array<[unknown, number, string]> = [
      [new DaemonHttpError(404, 'Cannot GET /session/x/hooks', 'r'), 502, 'hooks_unsupported'],
      [new DaemonHttpError(404, { error: 'No session', code: 'session_not_found' }, 'r'), 404, 'session_not_found'],
      [new DaemonHttpError(409, { error: 'x', code: 'hosted_hooks_unavailable' }, 'r'), 502, 'hosted_hooks_unavailable'],
      [new DaemonHttpError(403, { error: 'x', code: 'nope' }, 'r'), 403, 'nope'],
      [new UnknownSessionError(SID), 404, 'session_not_found'],
      [new Error('connect ECONNREFUSED'), 502, 'daemon_unavailable'],
    ];
    for (const [err, status, code] of cases) {
      const base = await mountRoute(failing(err));
      const out = await get(HOOKS(base));
      expect([out.status, out.body['code']], String(err)).toEqual([status, code]);
      await new Promise<void>((r) => gateway!.close(() => r()));
      gateway = undefined;
    }
  });

  it('a body without a hooks list (the Hosted Harness { catalog } shape, say) is not passed on', async () => {
    const base = await mountRoute({
      sessionHooks: async () => ({ catalog: null }),
    } as unknown as SessionDaemon);
    const out = await get(HOOKS(base));
    expect(out.status).toBe(502);
    expect(out.body['code']).toBe('daemon_unavailable');
  });
});

describe('commandPreview (#135)', () => {
  it.each([
    ['python3 tools/guard.py --strict', 'python3 tools/guard.py'],
    ['./scripts/lint.sh', './scripts/lint.sh'],
    ['  node   check.js  ', 'node check.js'],
    ['TOKEN=abc A=b ./run.sh now', './run.sh now'],
    ['curl -H "Authorization: x" https://h', 'curl'],
    ['bash -c "echo $SECRET"', 'bash'],
    ['curl https://user:pw@host/x', 'curl'],
    ['tool a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2', 'tool'],
    ['TOKEN=abc', undefined],
    ['', undefined],
  ])('%s -> %s', (command, want) => {
    expect(commandPreview(command)).toBe(want);
  });
  it('is undefined for a non-string', () => {
    expect(commandPreview(7)).toBeUndefined();
  });
});

describe('DaemonPool: sessionHooks goes through the SDK\'s own name (#135)', () => {
  it('reaches the client unchanged', async () => {
    const seen: string[] = [];
    const client = {
      async createOrAttachSession(req: { workspaceCwd?: string }) {
        return {
          sessionId: 'sid-1',
          workspaceCwd: req.workspaceCwd ?? '/home',
          attached: false,
        };
      },
      async closeSession() {},
      async sessionHooks(s: string) {
        seen.push(`hooks ${s}`);
        return { v: 1, sessionId: s, workspaceCwd: '/w', disabled: false, hooks: [] };
      },
      async capabilities() {
        return { workspaceCwd: '/home' };
      },
      async health() {
        return { status: 'ok' };
      },
    } as unknown as DaemonClient;
    const spawn = async (cwd: string): Promise<PooledDaemonSpawn> => ({
      client,
      stop: async () => {},
      workspaceCwd: cwd,
    });
    pool = new DaemonPool({
      defaultDaemon: client,
      defaultWorkspaceCwd: '/home',
      deathProbeDelayMs: 0,
      spawn,
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/w' });
    await pool.sessionHooks(s.sessionId);
    expect(seen).toEqual(['hooks sid-1']);
  });
});

describe('the #135 hooks read as the gateway mounts it', () => {
  async function bootGateway(
    opts: StubDaemonOptions = {},
  ): Promise<{ url: string; store: TokenStore }> {
    stub = await startStubDaemon(opts);
    tmp = mkdtempSync(join(tmpdir(), 'rc-hooks-'));
    const store = await TokenStore.open(join(tmp, 'tokens.json'));
    const { app } = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(tmp, 'audit.log'),
    });
    return { url: await listen(app), store };
  }

  it('a read-only token reads the hooks, the projection and not the config', async () => {
    const { url, store } = await bootGateway({ hooks: { seed: { [SID]: SEED } } });
    const { token } = await store.issue([SESSION_READ], 'reader');
    const out = await get(HOOKS(url), token);
    expect(out.status).toBe(200);
    expect((out.body as unknown as View).hooks).toHaveLength(3);
    expect(JSON.stringify(out.body)).not.toContain('s3cr3t-token');
  });

  it('a write token reads it too, and no token does not', async () => {
    const { url, store } = await bootGateway({ hooks: { seed: { [SID]: SEED } } });
    const { token } = await store.issue([WRITE], 'phone');
    expect((await get(HOOKS(url), token)).status).toBe(200);
    expect((await get(HOOKS(url))).status).toBe(401);
  });

  it('a share token locked to this session reads it; one locked to another does not', async () => {
    const { url, store } = await bootGateway({ hooks: { seed: { [SID]: SEED } } });
    const mine = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: SID,
      ttlSec: 3600,
      parentId: 'owner',
    });
    const other = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: OTHER_SID,
      ttlSec: 3600,
      parentId: 'owner',
    });
    expect((await get(HOOKS(url), mine.token)).status).toBe(200);
    expect((await get(HOOKS(url), other.token)).status).toBe(403);
  });

  it('the capability flag says the route is mounted, and nothing that writes a hook is', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([WRITE], 'phone');
    const res = await fetch(`${url}/rc/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { remoteControl: { sessionHooks?: unknown } };
    expect(body.remoteControl.sessionHooks).toBe(true);
    for (const [method, path] of [
      ['POST', `/session/${SID}/hooks/operations`],
      ['POST', `/session/${SID}/hooks/registrations`],
      ['GET', `/session/${SID}/hooks/operations/x`],
    ] as const) {
      const r = await fetch(`${url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(r.status, path).toBe(404);
    }
    expect(stub?.hooksCalls).toEqual([]);
  });
});
