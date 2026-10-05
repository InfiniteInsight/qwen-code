/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createLlamaSwapRoute, type LlamaSwapProbe } from './llamaSwap.js';
import type { LlamaSwapStatusResponse } from '../llama-swap/llamaSwapStatus.js';

function fakeRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      this.headersSent = true;
      return this;
    },
  };
}

const call = async (probe: LlamaSwapProbe) => {
  const res = fakeRes();
  await createLlamaSwapRoute(probe)(
    {} as never,
    res as never,
    (() => {}) as never,
  );
  return res;
};

describe('createLlamaSwapRoute', () => {
  it('200 with llama-swap data when available', async () => {
    const llamaSwapData: LlamaSwapStatusResponse = {
      available: true,
      models: [
        {
          id: 'llama-2-7b',
          aliases: ['llama2'],
          loaded: true,
        },
      ],
    };
    const res = await call(async () => llamaSwapData);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(llamaSwapData);
  });

  it('200 with available:false when no models', async () => {
    const llamaSwapData: LlamaSwapStatusResponse = {
      available: false,
      models: [],
    };
    const res = await call(async () => llamaSwapData);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(llamaSwapData);
  });

  it('500 when probe throws', async () => {
    const res = await call(async () => {
      throw new Error('probe failed');
    });
    expect(res.statusCode).toBe(500);
    expect((res.body as { code: string }).code).toBe('llama_swap_probe_failed');
  });
});
