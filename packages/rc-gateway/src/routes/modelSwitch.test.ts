/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createModelSwitchRoute } from './modelSwitch.js';
import type { ModelSwitchDaemon } from './modelSwitch.js';

describe('createModelSwitchRoute', () => {
  let daemon: ModelSwitchDaemon;
  let captured: { status: number; body: unknown };

  beforeEach(() => {
    daemon = {
      setSessionModel: vi.fn().mockResolvedValue({}),
    };
    captured = { status: 0, body: {} };
  });

  function makeResponder() {
    return {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(data: unknown) {
        captured.body = data;
        return this;
      },
      get headersSent() {
        return captured.status !== 0;
      },
    } as unknown as Express.Response;
  }

  it('returns 404 for invalid session ids', async () => {
    const req = {
      params: { id: '../../etc/passwd' },
      body: { modelId: 'gpt-4' },
      rcClient: { id: 'test-token', scopes: ['write'] },
    } as unknown as Express.Request;
    await createModelSwitchRoute(daemon)(req, makeResponder(), vi.fn());
    expect(captured.status).toBe(404);
    expect(captured.body).toEqual({
      error: 'Session not found',
      code: 'session_not_found',
    });
  });

  it('returns 400 for missing modelId', async () => {
    const req = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: {},
      rcClient: { id: 'test-token', scopes: ['write'] },
    } as unknown as Express.Request;
    await createModelSwitchRoute(daemon)(req, makeResponder(), vi.fn());
    expect(captured.status).toBe(400);
    expect(captured.body).toEqual({
      error: 'Invalid model id',
      code: 'invalid_model_id',
    });
  });

  it('returns 400 for non-string modelId', async () => {
    const req = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: { modelId: 42 },
      rcClient: { id: 'test-token', scopes: ['write'] },
    } as unknown as Express.Request;
    await createModelSwitchRoute(daemon)(req, makeResponder(), vi.fn());
    expect(captured.status).toBe(400);
    expect(captured.body.code).toBe('invalid_model_id');
  });

  it('returns 400 for empty string modelId', async () => {
    const req = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: { modelId: '' },
      rcClient: { id: 'test-token', scopes: ['write'] },
    } as unknown as Express.Request;
    await createModelSwitchRoute(daemon)(req, makeResponder(), vi.fn());
    expect(captured.status).toBe(400);
    expect(captured.body.code).toBe('invalid_model_id');
  });

  it('calls daemon.setSessionModel and returns 200 on success', async () => {
    daemon.setSessionModel.mockResolvedValue({ modelId: 'qwen3.5-sonar-8k' });
    const req = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: { modelId: 'qwen3.5-sonar-8k' },
      rcClient: { id: 'test-token', scopes: ['write'] },
    } as unknown as Express.Request;
    await createModelSwitchRoute(daemon)(req, makeResponder(), vi.fn());
    expect(captured.status).toBe(200);
    expect(captured.body.modelId).toBe('qwen3.5-sonar-8k');
    expect(daemon.setSessionModel).toHaveBeenCalledWith(
      'abcdef1234567890abcdef1234567890',
      'qwen3.5-sonar-8k',
    );
  });

  it('returns 502 when daemon throws', async () => {
    daemon.setSessionModel.mockRejectedValue(new Error('network error'));
    const req = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: { modelId: 'gpt-4' },
      rcClient: { id: 'test-token', scopes: ['write'] },
    } as unknown as Express.Request;
    await createModelSwitchRoute(daemon)(req, makeResponder(), vi.fn());
    expect(captured.status).toBe(502);
    expect(captured.body.code).toBe('daemon_unavailable');
  });

  it('maps a daemon 404 to 502 model_switch_unsupported', async () => {
    const notFoundDaemon: ModelSwitchDaemon = {
      setSessionModel: async () => {
        throw Object.assign(new Error('not found'), { status: 404 });
      },
    };
    const req = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: { modelId: 'gpt-4' },
      rcClient: { id: 'test-token', scopes: ['write'] },
    } as unknown as Express.Request;
    await createModelSwitchRoute(notFoundDaemon)(req, makeResponder(), vi.fn());
    expect(captured.status).toBe(502);
    expect(captured.body.code).toBe('model_switch_unsupported');
  });

  it('passes through a daemon-origin 4xx with its real status and message', async () => {
    const unprocessableDaemon: ModelSwitchDaemon = {
      setSessionModel: async () => {
        throw Object.assign(new Error('bad'), {
          status: 422,
          body: { error: 'unknown model id' },
        });
      },
    };
    const req = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: { modelId: 'nope' },
      rcClient: { id: 'test-token', scopes: ['write'] },
    } as unknown as Express.Request;
    await createModelSwitchRoute(unprocessableDaemon)(
      req,
      makeResponder(),
      vi.fn(),
    );
    expect(captured.status).toBe(422);
    expect(captured.body.error).toBe('unknown model id');
  });
});
