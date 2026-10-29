/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditEntry } from '../auditLog.js';
import type { SessionDaemon } from '../daemonPool.js';
import {
  isDaemonRequestDenied,
  resetDaemonAuthAuditThrottle,
} from './daemonAuth.js';
import { createAttachmentListRoute } from './sessionAttachments.js';
import { createPendingPromptsRoute } from './sessionQueue.js';
import { createSessionLiveStateRoute } from './sessionLiveState.js';
import { createSessionBtwRoute } from './sessionBtw.js';
import { createSessionRecapRoute } from './sessionRecap.js';
import { createSessionWorktreeResetRoute } from './sessionWorktreeReset.js';
import { createWorkspaceListRoute } from './workspaceFiles.js';

const SID = '11111111-1111-1111-1111-111111111111';

let server: Server | undefined;
beforeEach(() => resetDaemonAuthAuditThrottle());
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

/** A daemon whose every call is refused with the given status and body. */
function refusingDaemon(
  status: number,
  body: Record<string, unknown>,
): SessionDaemon {
  return new Proxy(
    {},
    {
      get: () => async () => {
        throw Object.assign(new Error(String(body['error'])), {
          name: 'DaemonHttpError',
          status,
          body,
        });
      },
    },
  ) as unknown as SessionDaemon;
}

/** A daemon whose every call is refused with the daemon's own 401. */
function unauthorisedDaemon(): SessionDaemon {
  return refusingDaemon(401, { error: 'Unauthorized' });
}

/** A daemon whose request wall (Host or CORS check) refuses every call. */
function walledDaemon(): SessionDaemon {
  return refusingDaemon(403, { error: 'Invalid Host header' });
}

const cases: Array<{
  name: string;
  method: 'GET' | 'POST';
  path: string;
  mount: string;
  handler: (d: SessionDaemon) => RequestHandler;
  body?: unknown;
}> = [
  {
    name: 'attachments',
    method: 'GET',
    mount: '/session/:id/attachments',
    path: `/session/${SID}/attachments`,
    handler: (d) => createAttachmentListRoute(d),
  },
  {
    name: 'queue',
    method: 'GET',
    mount: '/session/:id/pending-prompts',
    path: `/session/${SID}/pending-prompts`,
    handler: (d) => createPendingPromptsRoute(d),
  },
  {
    name: 'live_state',
    method: 'GET',
    mount: '/rc/sessions/live-state',
    path: '/rc/sessions/live-state?spawn=1',
    handler: (d) => createSessionLiveStateRoute(d),
  },
  {
    name: 'btw',
    method: 'POST',
    mount: '/session/:id/btw',
    path: `/session/${SID}/btw`,
    body: { question: 'what is going on?' },
    handler: (d) => createSessionBtwRoute(d),
  },
  {
    name: 'recap',
    method: 'POST',
    mount: '/session/:id/recap',
    path: `/session/${SID}/recap`,
    handler: (d) => createSessionRecapRoute(d),
  },
  {
    name: 'worktree_reset',
    method: 'POST',
    mount: '/session/:id/worktree/reset',
    path: `/session/${SID}/worktree/reset`,
    handler: (d) => createSessionWorktreeResetRoute(d),
  },
  {
    name: 'workspace_files',
    method: 'GET',
    mount: '/rc/workspace/list',
    path: '/rc/workspace/list?path=src',
    handler: (d) => createWorkspaceListRoute(d),
  },
];

describe("a daemon 401 is not relayed as the caller's own 401", () => {
  for (const c of cases) {
    it(`${c.name}: 502 daemon_auth_failed, audited once for the operator`, async () => {
      const rows: AuditEntry[] = [];
      const app = express();
      app.locals.audit = { record: async (e: AuditEntry) => void rows.push(e) };
      app.use(express.json());
      app.use((req, _res, next) => {
        req.rcClient = { id: 'tok1', scopes: ['owner'] };
        next();
      });
      const h = c.handler(unauthorisedDaemon());
      if (c.method === 'GET') app.get(c.mount, h);
      else app.post(c.mount, h);
      server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}${c.path}`;
      const call = () =>
        fetch(url, {
          method: c.method,
          headers: { 'Content-Type': 'application/json' },
          ...(c.method === 'POST'
            ? { body: JSON.stringify(c.body ?? {}) }
            : {}),
        });

      const res = await call();
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: 'daemon_auth_failed' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'daemon_auth_failed',
        actorTokenId: 'tok1',
        detail: { route: c.name },
      });

      // A second one inside the window is counted, not written again.
      const again = await call();
      expect(again.status).toBe(502);
      expect(rows).toHaveLength(1);
    });
  }
});

describe("a daemon request-wall 403 is not relayed as the caller's own 403", () => {
  for (const c of cases) {
    it(`${c.name}: 502 daemon_request_denied, audited once for the operator`, async () => {
      const rows: AuditEntry[] = [];
      const app = express();
      app.locals.audit = { record: async (e: AuditEntry) => void rows.push(e) };
      app.use(express.json());
      app.use((req, _res, next) => {
        req.rcClient = { id: 'tok1', scopes: ['owner'] };
        next();
      });
      const h = c.handler(walledDaemon());
      if (c.method === 'GET') app.get(c.mount, h);
      else app.post(c.mount, h);
      server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}${c.path}`;
      const call = () =>
        fetch(url, {
          method: c.method,
          headers: { 'Content-Type': 'application/json' },
          ...(c.method === 'POST'
            ? { body: JSON.stringify(c.body ?? {}) }
            : {}),
        });

      const res = await call();
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: 'daemon_request_denied' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'daemon_auth_failed',
        actorTokenId: 'tok1',
        detail: { route: c.name, status: 403 },
      });

      // A second one inside the window is counted, not written again.
      const again = await call();
      expect(again.status).toBe(502);
      expect(rows).toHaveLength(1);
    });
  }
});

describe('isDaemonRequestDenied', () => {
  const err = (status: number, body: unknown) => ({ status, body });
  it('recognises the daemon request wall (Host and CORS refusals)', () => {
    expect(
      isDaemonRequestDenied(err(403, { error: 'Invalid Host header' })),
    ).toBe(true);
    expect(
      isDaemonRequestDenied(
        err(403, { error: 'Request denied by CORS policy' }),
      ),
    ).toBe(true);
  });
  it('leaves a 403 that is a verdict about the request alone', () => {
    expect(
      isDaemonRequestDenied(
        err(403, { errorKind: 'untrusted_folder', error: 'untrusted' }),
      ),
    ).toBe(false);
    expect(
      isDaemonRequestDenied(err(403, { error: 'Folder is not trusted' })),
    ).toBe(false);
    expect(isDaemonRequestDenied(err(403, undefined))).toBe(false);
    expect(
      isDaemonRequestDenied(err(401, { error: 'Invalid Host header' })),
    ).toBe(false);
  });
});
