/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createGpuRoute, type GpuProbe } from './gpu.js';
import type { GpuStatusResponse } from '../gpu/gpuStatus.js';

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

const call = async (probe: GpuProbe) => {
  const res = fakeRes();
  await createGpuRoute(probe)(
    {} as never,
    res as never,
    (() => {}) as never,
  );
  return res;
};

describe('createGpuRoute', () => {
  it('200 with GPU data when available', async () => {
    const gpuData: GpuStatusResponse = {
      available: true,
      gpus: [
        {
          index: 0,
          name: 'RTX 4090',
          uuid: 'GPU-uuid-123',
          memoryUsedMiB: 1024,
          memoryTotalMiB: 24576,
          utilizationPct: 75,
          temperatureC: 65,
          processes: [],
        },
      ],
    };
    const res = await call(async () => gpuData);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(gpuData);
  });

  it('200 with available:false when no GPUs', async () => {
    const gpuData: GpuStatusResponse = {
      available: false,
      gpus: [],
    };
    const res = await call(async () => gpuData);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(gpuData);
  });

  it('500 when probe throws', async () => {
    const res = await call(async () => {
      throw new Error('probe failed');
    });
    expect(res.statusCode).toBe(500);
    expect((res.body as { code: string }).code).toBe('gpu_probe_failed');
  });
});
