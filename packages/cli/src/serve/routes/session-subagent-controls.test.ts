/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import express, { type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import type { WorkspaceFileSystemFactory } from '../fs/index.js';
import { registerSessionRoutes } from './session.js';
import {
  createVirtualSubagentSessionId,
  type VirtualSubagentSessions,
} from '../virtual-subagent-sessions.js';

/**
 * #259: POST /session/:id/subagents/:subagentRef/resume and /abandon, shaped
 * like the cancel and message routes. The child answers with an outcome or a
 * refusal (code + reason); a refusal is a 200, an unknown ref is a 404.
 */

const ROOT = 'root-session';
const CWD = path.resolve('/workspace/subagent-controls');
const AGENT = 'researcher-agent-1';
const VIRTUAL = createVirtualSubagentSessionId(ROOT, AGENT);

function makeRuntime(bridge: Partial<AcpSessionBridge>): WorkspaceRuntime {
  return {
    workspaceId: 'primary',
    workspaceCwd: CWD,
    primary: true,
    bridge: {
      getSessionSummary: vi.fn((sessionId: string) => {
        if (sessionId !== ROOT) throw new SessionNotFoundError(sessionId);
        return { sessionId };
      }),
      ...bridge,
    } as unknown as AcpSessionBridge,
    sessionRuntimeBaseDir: path.join(CWD, '.runtime'),
    trusted: true,
    routeFileSystemFactory: {
      forRequest: vi.fn(),
      assertCanWrite: vi.fn(),
    } as WorkspaceFileSystemFactory,
  } as WorkspaceRuntime;
}

function makeApp(
  runtime: WorkspaceRuntime,
  subagents?: VirtualSubagentSessions,
) {
  const app = express();
  app.use(express.json());
  const registry = createWorkspaceRegistry([runtime]);
  registerSessionRoutes(app, {
    boundWorkspace: CWD,
    bridge: runtime.bridge,
    workspaceRegistry: registry,
    archiveCoordinator: {
      runSharedMany: async (_sessionIds, fn) => await fn(),
    } as Parameters<typeof registerSessionRoutes>[1]['archiveCoordinator'],
    mutate: () => (_req, _res, next) => next(),
    sendBridgeError: (res: Response, err: unknown) => {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        code: 'bridge_error',
      });
    },
    sessionShellCommandEnabled: true,
    languageCodes: ['en'],
    virtualSubagentSessions: subagents,
  });
  return app;
}

function makeSubagents(found = true) {
  const resolve = vi.fn().mockResolvedValue(
    found
      ? {
          sessionId: VIRTUAL,
          taskId: AGENT,
          title: 'researcher: dig into auth',
          status: 'paused',
        }
      : undefined,
  );
  const updateTargetStatus = vi.fn();
  return {
    resolve,
    updateTargetStatus,
    sessions: {
      resolve,
      updateTargetStatus,
    } as unknown as VirtualSubagentSessions,
  };
}

const REFUSALS = [
  ['agent_not_found', 'No background agent "x" is registered in this session.'],
  ['not_paused', 'Background agent "x" is running, not paused.'],
  ['resume_blocked', 'Subagent "deleted-agent" is no longer available.'],
  [
    'metadata_missing',
    'Background agent "x" has no saved metadata to resume from.',
  ],
  [
    'metadata_unreadable',
    'The saved metadata of background agent "x" could not be read.',
  ],
  [
    'transcript_missing',
    'Background agent "x" has no saved transcript to resume from.',
  ],
  [
    'capacity_full',
    'Cannot start background agent: maximum concurrent background agents (4) reached.',
  ],
  ['resume_failed', 'model provider is offline'],
] as const;

describe('POST /session/:id/subagents/:subagentRef/resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resumes the subagent with its first instruction and re-reads the target', async () => {
    const resumeSessionTask = vi
      .fn()
      .mockResolvedValue({ outcome: 'resumed', status: 'running' });
    const subagents = makeSubagents();
    const app = makeApp(makeRuntime({ resumeSessionTask }), subagents.sessions);

    const res = await request(app)
      .post(`/session/${ROOT}/subagents/call-1/resume`)
      .send({ message: '  pick up the TODO list  ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionId: ROOT,
      subagentRef: 'call-1',
      taskId: AGENT,
      outcome: 'resumed',
      status: 'running',
    });
    expect(resumeSessionTask).toHaveBeenCalledWith(
      ROOT,
      AGENT,
      'pick up the TODO list',
    );
    // Once to find the task, once after the resume to refresh its state.
    expect(subagents.resolve).toHaveBeenCalledTimes(2);
  });

  it('resumes without an instruction when the body has none or only spaces', async () => {
    const resumeSessionTask = vi
      .fn()
      .mockResolvedValue({ outcome: 'resumed', status: 'running' });
    const app = makeApp(
      makeRuntime({ resumeSessionTask }),
      makeSubagents().sessions,
    );

    await request(app).post(`/session/${ROOT}/subagents/call-1/resume`).send();
    await request(app)
      .post(`/session/${ROOT}/subagents/call-1/resume`)
      .send({ message: '   ' });

    expect(resumeSessionTask.mock.calls).toEqual([
      [ROOT, AGENT, undefined],
      [ROOT, AGENT, undefined],
    ]);
  });

  it.each(REFUSALS)(
    'answers the %s refusal with its code and reason',
    async (code, reason) => {
      const resumeSessionTask = vi.fn().mockResolvedValue({
        outcome: 'refused',
        code,
        reason,
        status: 'paused',
      });
      const subagents = makeSubagents();
      const app = makeApp(
        makeRuntime({ resumeSessionTask }),
        subagents.sessions,
      );

      const res = await request(app)
        .post(`/session/${ROOT}/subagents/call-1/resume`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: ROOT,
        subagentRef: 'call-1',
        taskId: AGENT,
        outcome: 'refused',
        code,
        reason,
        status: 'paused',
      });
      expect(subagents.resolve).toHaveBeenCalledTimes(1);
    },
  );

  it('answers 404 for an unknown subagent ref without reaching the child', async () => {
    const resumeSessionTask = vi.fn();
    const app = makeApp(
      makeRuntime({ resumeSessionTask }),
      makeSubagents(false).sessions,
    );

    const res = await request(app)
      .post(`/session/${ROOT}/subagents/nobody/resume`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'Subagent session not found',
      code: 'session_not_found',
      sessionId: ROOT,
      subagentRef: 'nobody',
    });
    expect(resumeSessionTask).not.toHaveBeenCalled();
  });

  it('rejects an over-long ref and a non-string message with 400', async () => {
    const resumeSessionTask = vi.fn();
    const app = makeApp(
      makeRuntime({ resumeSessionTask }),
      makeSubagents().sessions,
    );

    const longRef = await request(app)
      .post(`/session/${ROOT}/subagents/${'r'.repeat(501)}/resume`)
      .send({});
    const badMessage = await request(app)
      .post(`/session/${ROOT}/subagents/call-1/resume`)
      .send({ message: 42 });

    expect(longRef.status).toBe(400);
    expect(longRef.body.code).toBe('invalid_subagent_ref');
    expect(badMessage.status).toBe(400);
    expect(badMessage.body).toMatchObject({
      code: 'invalid_message',
      sessionId: ROOT,
      subagentRef: 'call-1',
    });
    expect(resumeSessionTask).not.toHaveBeenCalled();
  });

  it('answers 404 when the daemon has no subagent sessions at all', async () => {
    const res = await request(makeApp(makeRuntime({})))
      .post(`/session/${ROOT}/subagents/call-1/resume`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('session_not_found');
  });

  it('refuses with unsupported when the bridge cannot resume', async () => {
    const app = makeApp(makeRuntime({}), makeSubagents().sessions);

    const res = await request(app)
      .post(`/session/${ROOT}/subagents/call-1/resume`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: 'refused',
      code: 'unsupported',
      reason: 'This daemon cannot resume subagents.',
    });
  });

  it('unwraps a virtual parent session id to its root session', async () => {
    const resumeSessionTask = vi
      .fn()
      .mockResolvedValue({ outcome: 'resumed', status: 'running' });
    const subagents = makeSubagents();
    const app = makeApp(makeRuntime({ resumeSessionTask }), subagents.sessions);
    const parent = createVirtualSubagentSessionId(ROOT, 'parent-agent');

    const res = await request(app)
      .post(`/session/${encodeURIComponent(parent)}/subagents/nested/resume`)
      .send({});

    expect(res.status).toBe(200);
    expect(subagents.resolve.mock.calls[0]?.slice(1)).toEqual([
      parent,
      'nested',
    ]);
    expect(resumeSessionTask).toHaveBeenCalledWith(ROOT, AGENT, undefined);
  });

  it('sends a bridge failure through the error envelope', async () => {
    const resumeSessionTask = vi
      .fn()
      .mockRejectedValue(new SessionNotFoundError(ROOT));
    const app = makeApp(
      makeRuntime({ resumeSessionTask }),
      makeSubagents().sessions,
    );

    const res = await request(app)
      .post(`/session/${ROOT}/subagents/call-1/resume`)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('bridge_error');
  });
});

describe('POST /session/:id/subagents/:subagentRef/abandon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('abandons the subagent and marks its virtual target cancelled', async () => {
    const abandonSessionTask = vi
      .fn()
      .mockResolvedValue({ outcome: 'abandoned', status: 'cancelled' });
    const subagents = makeSubagents();
    const runtime = makeRuntime({ abandonSessionTask });
    const app = makeApp(runtime, subagents.sessions);

    const res = await request(app).post(
      `/session/${ROOT}/subagents/call-1/abandon`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionId: ROOT,
      subagentRef: 'call-1',
      taskId: AGENT,
      outcome: 'abandoned',
      status: 'cancelled',
    });
    expect(abandonSessionTask).toHaveBeenCalledWith(ROOT, AGENT);
    expect(subagents.updateTargetStatus).toHaveBeenCalledWith(
      runtime,
      VIRTUAL,
      'cancelled',
    );
  });

  it.each([
    [
      'not_paused',
      'Background agent "x" is running; only a paused agent can be abandoned.',
    ],
    [
      'agent_not_found',
      'No background agent "x" is registered in this session.',
    ],
  ] as const)(
    'answers the %s refusal with its code and reason',
    async (code, reason) => {
      const abandonSessionTask = vi
        .fn()
        .mockResolvedValue({ outcome: 'refused', code, reason });
      const subagents = makeSubagents();
      const app = makeApp(
        makeRuntime({ abandonSessionTask }),
        subagents.sessions,
      );

      const res = await request(app).post(
        `/session/${ROOT}/subagents/call-1/abandon`,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: ROOT,
        subagentRef: 'call-1',
        taskId: AGENT,
        outcome: 'refused',
        code,
        reason,
      });
      expect(subagents.updateTargetStatus).not.toHaveBeenCalled();
    },
  );

  it('answers 404 for an unknown subagent ref without reaching the child', async () => {
    const abandonSessionTask = vi.fn();
    const app = makeApp(
      makeRuntime({ abandonSessionTask }),
      makeSubagents(false).sessions,
    );

    const res = await request(app).post(
      `/session/${ROOT}/subagents/nobody/abandon`,
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('session_not_found');
    expect(abandonSessionTask).not.toHaveBeenCalled();
  });

  it('refuses with unsupported when the bridge cannot abandon', async () => {
    const app = makeApp(makeRuntime({}), makeSubagents().sessions);

    const res = await request(app).post(
      `/session/${ROOT}/subagents/call-1/abandon`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: 'refused',
      code: 'unsupported',
      reason: 'This daemon cannot abandon subagents.',
    });
  });

  it('sends a bridge failure (an unknown parent session) through the error envelope', async () => {
    const abandonSessionTask = vi
      .fn()
      .mockRejectedValue(new SessionNotFoundError('other-session'));
    const subagents = makeSubagents();
    const app = makeApp(
      makeRuntime({ abandonSessionTask }),
      subagents.sessions,
    );

    const res = await request(app).post(
      `/session/other-session/subagents/call-1/abandon`,
    );

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('bridge_error');
    expect(subagents.updateTargetStatus).not.toHaveBeenCalled();
  });
});
