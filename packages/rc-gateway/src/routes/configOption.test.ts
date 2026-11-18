/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConfigOptionRoute } from './configOption.js';
import type { ConfigOptionDaemon } from './configOption.js';
import { UnknownSessionError } from '../daemonPool.js';

describe('createConfigOptionRoute', () => {
  let daemon: {
    setSessionConfigOption: ReturnType<typeof vi.fn>;
  } & ConfigOptionDaemon;
  let captured: { status: number; body: Record<string, unknown> };

  beforeEach(() => {
    daemon = {
      setSessionConfigOption: vi.fn().mockResolvedValue({
        configOptions: [{ id: 'reasoning_effort', currentValue: 'high' }],
        persisted: false,
      }),
    };
    captured = { status: 0, body: {} };
  });

  function makeResponder() {
    return {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(data: Record<string, unknown>) {
        captured.body = data;
        return this;
      },
      get headersSent() {
        return captured.status !== 0;
      },
    } as unknown as Parameters<ReturnType<typeof createConfigOptionRoute>>[1];
  }

  it('returns 404 for invalid session ids', async () => {
    const req = {
      params: { id: '../../etc/passwd' },
      body: { configId: 'reasoning_effort', value: 'high' },
      rcClient: { id: 'test-token', scopes: ['write'] },
    } as unknown as Parameters<ReturnType<typeof createConfigOptionRoute>>[0];
    await createConfigOptionRoute(daemon)(req, makeResponder(), vi.fn());
    expect(captured.status).toBe(404);
    expect(captured.body['code']).toBe('session_not_found');
  });

  it('returns 400 for invalid configId or value', async () => {
    const req1 = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: { configId: 'other', value: 'high' },
      rcClient: { id: 'test-token', scopes: ['write'] },
    } as unknown as Parameters<ReturnType<typeof createConfigOptionRoute>>[0];
    await createConfigOptionRoute(daemon)(req1, makeResponder(), vi.fn());
    expect(captured.status).toBe(400);
    expect(captured.body['code']).toBe('invalid_config_option');

    const req2 = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: { configId: 'reasoning_effort', value: 'ultra' },
      rcClient: { id: 'test-token', scopes: ['write'] },
    } as unknown as Parameters<ReturnType<typeof createConfigOptionRoute>>[0];
    await createConfigOptionRoute(daemon)(req2, makeResponder(), vi.fn());
    expect(captured.status).toBe(400);
    expect(captured.body['code']).toBe('invalid_reasoning_effort');
  });

  it('requires owner scope when persist: true', async () => {
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const req = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: { configId: 'reasoning_effort', value: 'high', persist: true },
      rcClient: { id: 'write-token', scopes: ['session-write'] },
    } as unknown as Parameters<ReturnType<typeof createConfigOptionRoute>>[0];
    await createConfigOptionRoute(daemon, { audit })(
      req,
      makeResponder(),
      vi.fn(),
    );
    expect(captured.status).toBe(403);
    expect(captured.body['code']).toBe('owner_scope_required');
    expect(daemon.setSessionConfigOption).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scope_denied' }),
    );
  });

  it('calls daemon.setSessionConfigOption and returns 200 on success', async () => {
    const req = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: { configId: 'reasoning_effort', value: 'xhigh', persist: true },
      rcClient: { id: 'owner-token', scopes: ['owner'] },
    } as unknown as Parameters<ReturnType<typeof createConfigOptionRoute>>[0];
    daemon.setSessionConfigOption.mockResolvedValue({
      configOptions: [{ id: 'reasoning_effort', currentValue: 'xhigh' }],
      persisted: true,
    });
    await createConfigOptionRoute(daemon)(req, makeResponder(), vi.fn());
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({
      sessionId: 'abcdef1234567890abcdef1234567890',
      configId: 'reasoning_effort',
      value: 'xhigh',
      configOptions: [{ id: 'reasoning_effort', currentValue: 'xhigh' }],
      persisted: true,
    });
    expect(daemon.setSessionConfigOption).toHaveBeenCalledWith(
      'abcdef1234567890abcdef1234567890',
      'reasoning_effort',
      'xhigh',
      { persist: true },
    );
  });

  it('maps UnknownSessionError to 404 session_not_found', async () => {
    daemon.setSessionConfigOption.mockRejectedValue(
      new UnknownSessionError('abcdef1234567890abcdef1234567890'),
    );
    const req = {
      params: { id: 'abcdef1234567890abcdef1234567890' },
      body: { configId: 'reasoning_effort', value: 'low' },
      rcClient: { id: 'test-token', scopes: ['session-write'] },
    } as unknown as Parameters<ReturnType<typeof createConfigOptionRoute>>[0];
    await createConfigOptionRoute(daemon)(req, makeResponder(), vi.fn());
    expect(captured.status).toBe(404);
    expect(captured.body['code']).toBe('session_not_found');
  });
});
