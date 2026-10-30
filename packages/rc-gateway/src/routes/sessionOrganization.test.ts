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
import { DaemonClient, type DaemonSessionSummary } from '@qwen-code/sdk';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import {
  startStubDaemon,
  type StubDaemon,
  type StubDaemonOptions,
} from '../testing/stubDaemon.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { createGatewayApp } from '../server.js';
import { SESSION_READ, SHARE, WRITE } from '../scopes.js';
import {
  createSessionGroupCreateRoute,
  createSessionOrganizationRoute,
} from './sessionOrganization.js';

const SID = '11111111-1111-1111-1111-111111111111';
const WS = '/stub/workspace';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;
let tmp: string | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  gateway = undefined;
  stub = undefined;
  tmp = undefined;
});

/** A fresh catalog per test: the stub files sessions into it in place. */
function catalog(): NonNullable<StubDaemonOptions['catalog']> {
  return {
    [WS]: {
      sessions: [
        {
          sessionId: SID,
          workspaceCwd: WS,
          updatedAt: '2026-10-29T00:00:00.000Z',
        } as DaemonSessionSummary,
      ],
      groups: [
        {
          id: 'g-work',
          name: 'Work',
          color: 'blue',
          order: 0,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    },
  };
}

async function listen(app: express.Express): Promise<string> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function mountRoutes(daemon: SessionDaemon): Promise<string> {
  const app = express();
  app.use(express.json());
  app.patch(
    '/session/:id/organization',
    createSessionOrganizationRoute(daemon),
  );
  app.post('/rc/workspace/session-groups', createSessionGroupCreateRoute(daemon));
  return listen(app);
}

/** Over a REAL DaemonClient, so the method names are the shipped SDK's
 * (spec ledger D61: a pool method no SDK call names is undefined here). */
async function mountReal(opts: StubDaemonOptions = {}): Promise<string> {
  stub = await startStubDaemon({ catalog: catalog(), ...opts });
  return mountRoutes(
    new DaemonClient({ baseUrl: stub.baseUrl }) as unknown as SessionDaemon,
  );
}

async function send(
  url: string,
  method: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

function throwing(err: unknown): SessionDaemon {
  const fail = async () => {
    throw err;
  };
  return {
    updateSessionOrganization: fail,
    createSessionGroup: fail,
  } as unknown as SessionDaemon;
}

describe('PATCH /session/:id/organization (#110)', () => {
  it('files the session under a group through the SDK and relays the effective organization', async () => {
    const base = await mountReal();
    const out = await send(`${base}/session/${SID}/organization`, 'PATCH', {
      groupId: 'g-work',
      color: null,
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      sessionId: SID,
      groupId: 'g-work',
      color: null,
      isPinned: false,
    });
    expect(typeof out.body['updatedAt']).toBe('string');
    expect(stub?.organizationCalls).toEqual([
      { sessionId: SID, body: { groupId: 'g-work', color: null } },
    ]);
  });

  it('a colour tag and a pin pass through as sent', async () => {
    const base = await mountReal();
    const out = await send(`${base}/session/${SID}/organization`, 'PATCH', {
      color: 'purple',
      groupId: null,
      isPinned: true,
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      color: 'purple',
      groupId: null,
      isPinned: true,
    });
    expect(stub?.organizationCalls[0]?.body).toEqual({
      color: 'purple',
      groupId: null,
      isPinned: true,
    });
  });

  it('refuses an unknown field, an empty change and every wrong type without asking the daemon', async () => {
    const base = await mountReal();
    const cases: Array<[unknown, string]> = [
      [{ groupId: 'g-work', pinned: true }, 'invalid_session_organization'],
      [{}, 'empty_organization_update'],
      [[], 'invalid_session_organization'],
      [{ isPinned: 'yes' }, 'invalid_session_organization'],
      [{ groupId: 7 }, 'invalid_session_organization'],
      [{ groupId: '' }, 'invalid_session_organization'],
      [{ groupId: 'x'.repeat(201) }, 'invalid_session_organization'],
      [{ color: 'teal' }, 'invalid_session_organization'],
      [{ color: '#ff0000' }, 'invalid_session_organization'],
    ];
    for (const [body, code] of cases) {
      const out = await send(`${base}/session/${SID}/organization`, 'PATCH', body);
      expect(out.status, JSON.stringify(body)).toBe(400);
      expect(out.body['code'], JSON.stringify(body)).toBe(code);
    }
    expect(stub?.organizationCalls).toEqual([]);
  });

  it('refuses a malformed session id before touching the daemon', async () => {
    const base = await mountReal();
    const out = await send(`${base}/session/not..a..session/organization`, 'PATCH', {
      color: 'red',
    });
    expect(out.status).toBe(404);
    expect(out.body['code']).toBe('session_not_found');
    expect(stub?.organizationCalls).toEqual([]);
  });

  it("a group from another folder is the daemon's group_not_found, and its message (which quotes the id) is not echoed", async () => {
    const base = await mountReal();
    const out = await send(`${base}/session/${SID}/organization`, 'PATCH', {
      groupId: 'g-elsewhere',
    });
    expect(out.status).toBe(404);
    expect(out.body['code']).toBe('group_not_found');
    expect(JSON.stringify(out.body)).not.toContain('g-elsewhere');
  });

  it('a daemon 400 keeps its code and drops its message', async () => {
    const base = await mountReal({
      organizationStatus: 400,
      organizationErrorBody: {
        error: '`groupId` must be a string or null near /home/u',
        code: 'invalid_session_organization',
        field: 'groupId',
      },
    });
    const out = await send(`${base}/session/${SID}/organization`, 'PATCH', {
      groupId: 'g-work',
    });
    expect(out.status).toBe(400);
    expect(out.body['code']).toBe('invalid_session_organization');
    expect(JSON.stringify(out.body)).not.toContain('/home/u');
  });

  it("the daemon's own no-such-session 404 stays a 404", async () => {
    const base = await mountReal({
      organizationStatus: 404,
      organizationErrorBody: { error: 'No session with id', sessionId: SID },
    });
    const out = await send(`${base}/session/${SID}/organization`, 'PATCH', {
      color: 'red',
    });
    expect(out.status).toBe(404);
    expect(out.body['code']).toBe('session_not_found');
  });

  it('a daemon without the route is named, not read as a missing session', async () => {
    const base = await mountRoutes(
      throwing(new DaemonHttpError(404, 'Cannot PATCH /session/x/organization', 'nf')),
    );
    const out = await send(`${base}/session/${SID}/organization`, 'PATCH', {
      color: 'red',
    });
    expect(out.status).toBe(502);
    expect(out.body['code']).toBe('organization_unsupported');
  });

  it('a session the pool does not hold is 404, and anything else is 502 without the error text', async () => {
    let base = await mountRoutes(throwing(new UnknownSessionError(SID)));
    let out = await send(`${base}/session/${SID}/organization`, 'PATCH', {
      color: 'red',
    });
    expect(out.status).toBe(404);
    expect(out.body['code']).toBe('session_not_found');
    await new Promise<void>((r) => gateway!.close(() => r()));
    base = await mountRoutes(throwing(new Error('ENOENT /home/u/.qwen/x')));
    out = await send(`${base}/session/${SID}/organization`, 'PATCH', {
      color: 'red',
    });
    expect(out.status).toBe(502);
    expect(out.body['code']).toBe('daemon_unavailable');
    expect(JSON.stringify(out.body)).not.toContain('/home/u');
  });
});

describe('POST /rc/workspace/session-groups (#110)', () => {
  it("makes the group in the named folder's store and answers 201 with it", async () => {
    const base = await mountReal();
    const out = await send(
      `${base}/rc/workspace/session-groups?workspace=${encodeURIComponent(WS)}`,
      'POST',
      { name: '  Release  ', color: 'green' },
    );
    expect(out.status).toBe(201);
    const group = out.body['group'] as Record<string, unknown>;
    expect(group).toMatchObject({ name: 'Release', color: 'green' });
    expect(typeof group['id']).toBe('string');
    expect(stub?.groupCreates).toEqual([
      { workspace: WS, body: { name: 'Release', color: 'green' } },
    ]);
  });

  it('a group made here is one a session can then be filed under', async () => {
    const base = await mountReal();
    const made = await send(
      `${base}/rc/workspace/session-groups?workspace=${encodeURIComponent(WS)}`,
      'POST',
      { name: 'Docs', color: '#a371f7' },
    );
    const id = (made.body['group'] as { id: string }).id;
    const out = await send(`${base}/session/${SID}/organization`, 'PATCH', {
      groupId: id,
      color: null,
    });
    expect(out.status).toBe(200);
    expect(out.body['groupId']).toBe(id);
  });

  it('refuses a missing folder, a bad name, a bad colour and an unknown field without asking the daemon', async () => {
    const base = await mountReal();
    const at = `${base}/rc/workspace/session-groups?workspace=${encodeURIComponent(WS)}`;
    const cases: Array<[string, unknown, string]> = [
      [`${base}/rc/workspace/session-groups`, { name: 'A', color: 'red' }, 'invalid_workspace'],
      [at, { name: '   ', color: 'red' }, 'invalid_group_name'],
      [at, { name: 'x'.repeat(65), color: 'red' }, 'invalid_group_name'],
      [at, { name: 'a\u0007b', color: 'red' }, 'invalid_group_name'],
      [at, { name: 'A', color: 'teal' }, 'invalid_group_color'],
      [at, { name: 'A', color: 'red', order: 1 }, 'invalid_group'],
    ];
    for (const [url, body, code] of cases) {
      const out = await send(url, 'POST', body);
      expect(out.status, JSON.stringify(body)).toBe(400);
      expect(out.body['code'], JSON.stringify(body)).toBe(code);
    }
    expect(stub?.groupCreates).toEqual([]);
  });

  it("a name already used in that folder, in any case, is the daemon's 409 and says so", async () => {
    const base = await mountReal();
    const out = await send(
      `${base}/rc/workspace/session-groups?workspace=${encodeURIComponent(WS)}`,
      'POST',
      { name: 'work', color: 'red' },
    );
    expect(out.status).toBe(409);
    expect(out.body['code']).toBe('group_name_conflict');
    expect(JSON.stringify(out.body)).not.toContain('work"');
  });

  it("a folder the daemon does not serve keeps the daemon's code", async () => {
    const base = await mountReal();
    const out = await send(
      `${base}/rc/workspace/session-groups?workspace=${encodeURIComponent('/elsewhere')}`,
      'POST',
      { name: 'A', color: 'red' },
    );
    expect(out.status).toBe(400);
    expect(out.body['code']).toBe('workspace_mismatch');
  });
});

describe('the #110 organization routes as the gateway mounts them', () => {
  async function bootGateway(): Promise<{ url: string; store: TokenStore }> {
    stub = await startStubDaemon({ catalog: catalog() });
    tmp = mkdtempSync(join(tmpdir(), 'rc-org-'));
    const store = await TokenStore.open(join(tmp, 'tokens.json'));
    const { app } = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(tmp, 'audit.log'),
    });
    return { url: await listen(app), store };
  }

  it('a write token files the session and makes a group', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([WRITE], 'phone');
    const filed = await send(
      `${url}/session/${SID}/organization`,
      'PATCH',
      { color: 'red', groupId: null },
      token,
    );
    expect(filed.status).toBe(200);
    const made = await send(
      `${url}/rc/workspace/session-groups?workspace=${encodeURIComponent(WS)}`,
      'POST',
      { name: 'New', color: 'orange' },
      token,
    );
    expect(made.status).toBe(201);
  });

  it('a read-only token is refused both, and the daemon is never asked', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([SESSION_READ], 'reader');
    const filed = await send(
      `${url}/session/${SID}/organization`,
      'PATCH',
      { color: 'red' },
      token,
    );
    expect(filed.status).toBe(403);
    const made = await send(
      `${url}/rc/workspace/session-groups?workspace=${encodeURIComponent(WS)}`,
      'POST',
      { name: 'New', color: 'orange' },
      token,
    );
    expect(made.status).toBe(403);
    expect(stub?.organizationCalls).toEqual([]);
    expect(stub?.groupCreates).toEqual([]);
  });

  it('a share locked to this very session cannot file it', async () => {
    const { url, store } = await bootGateway();
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: SID,
      ttlSec: 3600,
      parentId: 'owner',
    });
    const out = await send(
      `${url}/session/${SID}/organization`,
      'PATCH',
      { color: 'red' },
      share.token,
    );
    expect(out.status).toBe(403);
    expect(stub?.organizationCalls).toEqual([]);
  });

  it('the capability flag says the routes are mounted', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([SESSION_READ], 'reader');
    const res = await fetch(`${url}/rc/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as {
      remoteControl: { sessionOrganization?: unknown };
    };
    expect(body.remoteControl.sessionOrganization).toBe(true);
  });
});
