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
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { createGatewayApp } from '../server.js';
import { SESSION_READ, SHARE } from '../scopes.js';
import {
  createSessionAgentsRoute,
  createSessionAgentTraceRoute,
  createSessionSavedWorkflowRoute,
} from './sessionAgents.js';

const SID = '11111111-1111-1111-1111-111111111111';

/** A roster as the daemon shapes it: one live registry agent, one sidecar. */
const ROSTER = {
  v: 1,
  sessionId: SID,
  now: 1_767_225_660_000,
  tasks: [
    {
      kind: 'agent',
      id: 'agent-a',
      label: 'Explore: read the gateway routes',
      description: 'read the gateway routes',
      status: 'running',
      startTime: 1_767_225_600_000,
      runtimeMs: 60_000,
      outputFile: '/home/u/.qwen/projects/p/subagents/s/agent-agent-a.jsonl',
      subagentType: 'Explore',
      isBackgrounded: false,
      stats: { totalTokens: 12_345, toolUses: 8, durationMs: 60_000 },
      recentActivities: [
        { name: 'read_file', description: 'server.ts', at: 1_767_225_650_000 },
      ],
      prompt: 'Read the gateway routes and list the session reads.',
      toolUseId: 'tc-1',
      depth: 0,
    },
    {
      kind: 'agent',
      id: 'agent-b',
      label: 'general-purpose: check the tests',
      description: 'check the tests',
      status: 'completed',
      startTime: 1_767_225_000_000,
      endTime: 1_767_225_090_000,
      runtimeMs: 90_000,
      subagentType: 'general-purpose',
      isBackgrounded: false,
      toolUseId: 'tc-0',
    },
  ],
};

/** A lineage of two trees, as readAgentTrace builds it. */
const TRACE = {
  v: 1,
  sessionId: SID,
  nodes: [
    {
      agentId: 'agent-a',
      agentType: 'Explore',
      description: 'read the gateway routes',
      parentSessionId: SID,
      parentAgentId: null,
      rootAgentId: 'agent-a',
      toolUseId: 'tc-1',
      depth: 0,
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      lineageState: 'complete',
    },
    {
      agentId: 'agent-c',
      agentType: 'Explore',
      description: 'grep the routes',
      parentSessionId: SID,
      parentAgentId: 'agent-a',
      rootAgentId: 'agent-a',
      depth: 1,
      status: 'completed',
      createdAt: '2026-01-01T00:00:10.000Z',
      lineageState: 'complete',
    },
    {
      agentId: 'agent-b',
      agentType: 'general-purpose',
      description: 'check the tests',
      parentSessionId: SID,
      parentAgentId: null,
      rootAgentId: 'agent-b',
      toolUseId: 'tc-0',
      depth: 0,
      status: 'completed',
      createdAt: '2025-12-31T23:50:00.000Z',
      lineageState: 'complete',
    },
  ],
  rootAgentIds: ['agent-a', 'agent-b'],
  warnings: [],
};

const WORKFLOW = {
  v: 1,
  sessionId: SID,
  name: 'nightly',
  source: 'project',
  scriptPath: '/home/u/proj/.qwen/workflows/nightly.js',
  script: 'export const meta = { name: "nightly", description: "d" };',
  meta: { name: 'nightly', description: 'd' },
};

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

async function listen(app: express.Express): Promise<string> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The three routes on a bare app, over whichever daemon the test hands in. */
async function mountRoutes(
  daemon: SessionDaemon,
  rcClient?: Record<string, unknown>,
): Promise<string> {
  const app = express();
  if (rcClient) {
    app.use((req, _res, next) => {
      (req as unknown as { rcClient: unknown }).rcClient = rcClient;
      next();
    });
  }
  app.get('/session/:id/agents', createSessionAgentsRoute(daemon));
  app.get('/session/:id/agent-trace', createSessionAgentTraceRoute(daemon));
  app.get(
    '/session/:id/saved-workflows/:name',
    createSessionSavedWorkflowRoute(daemon),
  );
  return listen(app);
}

/** The routes over a REAL DaemonClient against the stub daemon, so the method
 * names, the paths and the query are whatever the shipped SDK does. A pool
 * method that names no SDK call would be undefined here at runtime, which is
 * the trap `tsc` cannot see (spec ledger D61). */
async function mountReal(
  stubOpts: Parameters<typeof startStubDaemon>[0] = {},
): Promise<string> {
  stub = await startStubDaemon(stubOpts);
  return mountRoutes(
    new DaemonClient({ baseUrl: stub.baseUrl }) as unknown as SessionDaemon,
  );
}

async function get(
  url: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url);
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function throwing(err: unknown): SessionDaemon {
  const fail = async () => {
    throw err;
  };
  return {
    sessionAgents: fail,
    sessionAgentTrace: fail,
    sessionSavedWorkflow: fail,
  } as unknown as SessionDaemon;
}

describe('GET /session/:id/agents (#110)', () => {
  it('relays the daemon roster verbatim through the SDK', async () => {
    const base = await mountReal({ sessionAgentsResult: ROSTER });
    const out = await get(`${base}/session/${SID}/agents`);
    expect(out.status).toBe(200);
    expect(out.body).toEqual(ROSTER);
    expect(stub?.lastAgentsSessionId).toBe(SID);
  });

  it('an empty roster is an answer, not a failure', async () => {
    const base = await mountReal();
    const out = await get(`${base}/session/${SID}/agents`);
    expect(out.status).toBe(200);
    expect(out.body['tasks']).toEqual([]);
  });

  it('refuses a malformed session id before touching the daemon', async () => {
    const base = await mountReal({ sessionAgentsResult: ROSTER });
    const out = await get(`${base}/session/not..a..session/agents`);
    expect(out.status).toBe(404);
    expect(out.body['code']).toBe('session_not_found');
    expect(stub?.agentsReadCount).toBe(0);
  });

  it('a session the daemon does not hold is a 404, not a 502', async () => {
    const base = await mountReal({
      sessionAgentsStatus: 404,
      sessionAgentsErrorBody: {
        error: 'No session',
        code: 'session_not_found',
        sessionId: SID,
      },
    });
    const out = await get(`${base}/session/${SID}/agents`);
    expect(out.status).toBe(404);
    expect(out.body['code']).toBe('session_not_found');
  });

  it('a daemon that predates the route is named, not read as a missing session', async () => {
    // A bare 404 with no code is express's own "Cannot GET", which is what a
    // daemon without the route answers.
    const base = await mountReal({ sessionAgentsStatus: 404 });
    const out = await get(`${base}/session/${SID}/agents`);
    expect(out.status).toBe(502);
    expect(out.body['code']).toBe('agents_unsupported');
  });

  it('a pool with no record of the session answers 404', async () => {
    const base = await mountRoutes(throwing(new UnknownSessionError(SID)));
    const out = await get(`${base}/session/${SID}/agents`);
    expect(out.status).toBe(404);
    expect(out.body['code']).toBe('session_not_found');
  });

  it('any other failure is 502 and never echoes the daemon message', async () => {
    const base = await mountRoutes(
      throwing(new Error('ENOENT /home/u/.qwen/secret-path')),
    );
    const out = await get(`${base}/session/${SID}/agents`);
    expect(out.status).toBe(502);
    expect(out.body['code']).toBe('daemon_unavailable');
    expect(JSON.stringify(out.body)).not.toContain('/home/u');
  });
});

describe('GET /session/:id/agent-trace (#110)', () => {
  it('relays the whole lineage when no root is named', async () => {
    const base = await mountReal({ agentTraceResult: TRACE });
    const out = await get(`${base}/session/${SID}/agent-trace`);
    expect(out.status).toBe(200);
    expect(out.body).toEqual(TRACE);
    expect(stub?.lastAgentTraceQuery).toEqual({});
  });

  it('carries rootAgentId to the daemon, which narrows the tree', async () => {
    const base = await mountReal({ agentTraceResult: TRACE });
    const out = await get(
      `${base}/session/${SID}/agent-trace?rootAgentId=agent-a`,
    );
    expect(out.status).toBe(200);
    expect(stub?.lastAgentTraceQuery).toEqual({ rootAgentId: 'agent-a' });
    const nodes = out.body['nodes'] as Array<{ agentId: string }>;
    expect(nodes.map((n) => n.agentId)).toEqual(['agent-a', 'agent-c']);
    expect(out.body['rootAgentIds']).toEqual(['agent-a']);
  });

  it('refuses an empty, repeated or oversize rootAgentId without asking the daemon', async () => {
    const base = await mountReal({ agentTraceResult: TRACE });
    for (const q of [
      'rootAgentId=',
      'rootAgentId=a&rootAgentId=b',
      'rootAgentId=' + 'x'.repeat(501),
    ]) {
      const out = await get(`${base}/session/${SID}/agent-trace?${q}`);
      expect(out.status).toBe(400);
      expect(out.body['code']).toBe('invalid_root_agent_id');
    }
    expect(stub?.lastAgentTraceQuery).toBeUndefined();
  });

  it('relays a daemon 400 with its code and without its message', async () => {
    const base = await mountRoutes(
      throwing(
        new DaemonHttpError(
          400,
          {
            error: 'bad id near /home/u/x',
            code: 'invalid_root_agent_id',
          },
          'bad',
        ),
      ),
    );
    const out = await get(`${base}/session/${SID}/agent-trace?rootAgentId=a`);
    expect(out.status).toBe(400);
    expect(out.body['code']).toBe('invalid_root_agent_id');
    expect(JSON.stringify(out.body)).not.toContain('/home/u');
  });
});

describe('GET /session/:id/saved-workflows/:name (#110)', () => {
  it('relays the definition through the SDK, the name encoded', async () => {
    const base = await mountReal({ savedWorkflowResult: WORKFLOW });
    const out = await get(
      `${base}/session/${SID}/saved-workflows/${encodeURIComponent('night ly')}`,
    );
    expect(out.status).toBe(200);
    expect(out.body['workflow']).toEqual(WORKFLOW);
    expect(stub?.lastSavedWorkflow).toEqual({ sessionId: SID, name: 'night ly' });
  });

  it('an unknown name is the daemon fail-closed envelope, relayed as an answer', async () => {
    const base = await mountReal();
    const out = await get(`${base}/session/${SID}/saved-workflows/nope`);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      v: 1,
      sessionId: SID,
      name: 'nope',
      workflow: null,
    });
  });

  it('a share guest gets the fail-closed envelope and the daemon is never asked', async () => {
    let asked = 0;
    const daemon = {
      sessionSavedWorkflow: async () => {
        asked += 1;
        return { v: 1, sessionId: SID, name: 'nightly', workflow: WORKFLOW };
      },
    } as unknown as SessionDaemon;
    const base = await mountRoutes(daemon, {
      id: 'guest',
      scopes: ['share', 'session:read'],
      sessionLockId: SID,
    });
    const out = await get(`${base}/session/${SID}/saved-workflows/nightly`);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      v: 1,
      sessionId: SID,
      name: 'nightly',
      workflow: null,
    });
    expect(asked).toBe(0);
  });
});

describe('the #110 reads as the gateway mounts them', () => {
  async function bootGateway(): Promise<{ url: string; store: TokenStore }> {
    stub = await startStubDaemon({
      sessionAgentsResult: ROSTER,
      agentTraceResult: TRACE,
      savedWorkflowResult: WORKFLOW,
    });
    tmp = mkdtempSync(join(tmpdir(), 'rc-agents-'));
    const store = await TokenStore.open(join(tmp, 'tokens.json'));
    const { app } = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store,
      pairing: new PairingService(),
      auditPath: join(tmp, 'audit.log'),
    });
    return { url: await listen(app), store };
  }

  it('a read-only token reads the roster and the lineage', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([SESSION_READ], 'reader');
    for (const path of ['agents', 'agent-trace?rootAgentId=agent-a']) {
      const res = await fetch(`${url}/session/${SID}/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it('an unauthenticated caller is refused', async () => {
    const { url } = await bootGateway();
    const res = await fetch(`${url}/session/${SID}/agents`);
    expect(res.status).toBe(401);
  });

  it('a share locked to another session cannot read this one', async () => {
    const { url, store } = await bootGateway();
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: '22222222-2222-2222-2222-222222222222',
      ttlSec: 3600,
      parentId: 'owner',
    });
    const res = await fetch(`${url}/session/${SID}/agents`, {
      headers: { Authorization: `Bearer ${share.token}` },
    });
    expect(res.status).toBe(403);
    expect(stub?.agentsReadCount).toBe(0);
  });

  it('a share locked to this session reads its agents but not a saved workflow', async () => {
    const { url, store } = await bootGateway();
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'guest',
      sessionLockId: SID,
      ttlSec: 3600,
      parentId: 'owner',
    });
    const auth = { headers: { Authorization: `Bearer ${share.token}` } };
    const agents = await fetch(`${url}/session/${SID}/agents`, auth);
    expect(agents.status).toBe(200);
    const wf = await fetch(`${url}/session/${SID}/saved-workflows/nightly`, auth);
    expect(wf.status).toBe(200);
    expect(((await wf.json()) as { workflow: unknown }).workflow).toBeNull();
    expect(stub?.lastSavedWorkflow).toBeUndefined();
  });

  it('the capability flag says the routes are mounted', async () => {
    const { url, store } = await bootGateway();
    const { token } = await store.issue([SESSION_READ], 'reader');
    const res = await fetch(`${url}/rc/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as {
      remoteControl: { sessionAgents?: unknown };
    };
    expect(body.remoteControl.sessionAgents).toBe(true);
  });
});
