/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from './server.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import { APPROVE, OWNER, SESSION_READ, SHARE, WRITE } from './scopes.js';

// #110, workflow runs: the disclosure rule and the action route, through the
// real gateway and a real DaemonClient, because the pool method names have to
// be the SDK's and tsc cannot see a mismatch there.

const SID = '11111111-2222-3333-4444-555555555555';

const SHELL = {
  kind: 'shell',
  id: 'sh-1',
  label: 'pnpm test',
  description: 'd',
  status: 'completed',
  startTime: 0,
  runtimeMs: 2000,
  command: 'pnpm test',
  cwd: '/stub/workspace',
  exitCode: 0,
};
const WORKFLOW = {
  kind: 'workflow',
  id: 'wf-1',
  label: 'release',
  description: 'ship it',
  workflowName: 'release',
  status: 'running',
  startTime: 0,
  runtimeMs: 5000,
  isBackgrounded: true,
  currentPhase: 'Build',
  phaseVisits: [],
  dispatches: [],
  agentsDispatched: 3,
  agentsCompleted: 1,
  tokensSpent: 0,
  tokenBudgetTotal: null,
  recentLogs: [],
  pendingApprovalCount: 0,
};

let server: Server | undefined;
let stub: StubDaemon | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (stub) await stub.close();
  server = undefined;
  stub = undefined;
});

async function setup(stubOpts: Parameters<typeof startStubDaemon>[0] = {}) {
  stub = await startStubDaemon({
    tasksResult: [SHELL],
    workflowTasksResult: [WORKFLOW],
    ...stubOpts,
  });
  const dir = await mkdtemp(join(tmpdir(), 'srv-wfruns-'));
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const gw = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(dir, 'audit.log'),
  });
  server = await new Promise((resolve) => {
    const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const tokens = {
    owner: (await store.issue([OWNER], 'o')).token,
    write: (await store.issue([WRITE, SESSION_READ], 'w')).token,
    read: (await store.issue([SESSION_READ], 'r')).token,
    approve: (await store.issue([APPROVE, SESSION_READ], 'a')).token,
    share: (
      await store.issueShare({
        scopes: [SHARE, SESSION_READ],
        label: 'guest',
        sessionLockId: SID,
        ttlSec: 3600,
        parentId: 'owner',
      })
    ).token,
  };
  const get = (token: string) =>
    fetch(`${url}/session/${SID}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  const post = (token: string, path: string, body: unknown) =>
    fetch(`${url}/session/${SID}/tasks/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  return { url, tokens, get, post };
}

const kinds = async (r: Response) =>
  ((await r.json()) as { tasks: Array<{ kind: string }> }).tasks.map(
    (t) => t.kind,
  );

describe('workflow runs in the tasks list (#110)', () => {
  it('lists them for owner and write, and asks the daemon to expand them', async () => {
    const { tokens, get } = await setup();
    for (const t of [tokens.owner, tokens.write]) {
      stub!.tasksQueries.length = 0;
      const r = await get(t);
      expect(r.status).toBe(200);
      expect(await kinds(r)).toEqual(['shell', 'workflow']);
      expect(stub!.tasksQueries).toEqual([{ includeWorkflows: 'true' }]);
    }
  });

  it('gives a reader, an approve-only token and a share link today\'s list, and never opts in', async () => {
    const { tokens, get } = await setup();
    for (const t of [tokens.read, tokens.approve, tokens.share]) {
      stub!.tasksQueries.length = 0;
      const r = await get(t);
      expect(r.status).toBe(200);
      expect(await kinds(r)).toEqual(['shell']);
      expect(stub!.tasksQueries).toEqual([{}]);
    }
  });

  it('lists none for an owner on an untrusted workspace: the daemon withholds them', async () => {
    const { tokens, get } = await setup({ workspaceTrusted: false });
    const r = await get(tokens.owner);
    expect(await kinds(r)).toEqual(['shell']);
    // The opt-in was still sent; the daemon's own trust gate is what held them.
    expect(stub!.tasksQueries).toEqual([{ includeWorkflows: 'true' }]);
  });

  it('advertises the workflowRuns flag', async () => {
    const { url, tokens } = await setup();
    const r = await fetch(`${url}/rc/capabilities`, {
      headers: { Authorization: `Bearer ${tokens.owner}` },
    });
    const body = (await r.json()) as {
      remoteControl: Record<string, unknown>;
    };
    expect(body.remoteControl['workflowRuns']).toBe(true);
  });
});

describe('POST /session/:id/tasks/:taskId/workflow-action (#110)', () => {
  it('is write scope: a reader, an approve-only token and a share link get 403 and the daemon is not asked', async () => {
    const { tokens, post } = await setup();
    for (const t of [tokens.read, tokens.approve, tokens.share]) {
      const r = await post(t, 'wf-1/workflow-action', { action: 'pause' });
      expect(r.status).toBe(403);
    }
    expect(stub!.workflowActions).toEqual([]);
  });

  it('relays a control from write and owner under the run id, with the daemon\'s answer', async () => {
    const { tokens, post } = await setup();
    for (const t of [tokens.write, tokens.owner]) {
      const r = await post(t, 'wf-1/workflow-action', { action: 'pause' });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        sessionId: SID,
        changed: true,
        taskId: 'wf-1',
      });
    }
    expect(stub!.workflowActions).toEqual([
      { sessionId: SID, taskId: 'wf-1', body: { action: 'pause' } },
      { sessionId: SID, taskId: 'wf-1', body: { action: 'pause' } },
    ]);
  });

  it('withholds the two start verbs and rejects an unknown word, without asking the daemon', async () => {
    const { tokens, post } = await setup();
    for (const [body, code] of [
      [{ action: 'run-script', script: 'x' }, 'workflow_action_withheld'],
      [{ action: 'run-saved' }, 'workflow_action_withheld'],
      [{ action: 'approve' }, 'invalid_workflow_action'],
    ] as const) {
      const r = await post(tokens.write, 'wf-1/workflow-action', body);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { code: string }).code).toBe(code);
    }
    expect(stub!.workflowActions).toEqual([]);
  });

  it('passes the daemon\'s untrusted answer through as changed:false', async () => {
    const { tokens, post } = await setup({ workspaceTrusted: false });
    const r = await post(tokens.write, 'wf-1/workflow-action', {
      action: 'resume',
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sessionId: SID, changed: false });
  });
});

describe('GET /session/:id/saved-workflows/:name (#110)', () => {
  it('is write scope: a reader, an approve-only token and a share link get 403; write and owner read it', async () => {
    const { url, tokens } = await setup({
      savedWorkflowResult: { name: 'release', source: 'project', script: 's' },
    });
    const read = (t: string) =>
      fetch(`${url}/session/${SID}/saved-workflows/release`, {
        headers: { Authorization: `Bearer ${t}` },
      });
    for (const t of [tokens.read, tokens.approve, tokens.share]) {
      expect((await read(t)).status).toBe(403);
    }
    expect(stub!.lastSavedWorkflow).toBeUndefined();
    for (const t of [tokens.write, tokens.owner]) {
      const r = await read(t);
      expect(r.status).toBe(200);
      expect(
        ((await r.json()) as { workflow: { name: string } }).workflow.name,
      ).toBe('release');
    }
  });
});
