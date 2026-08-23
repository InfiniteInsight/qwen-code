/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { GpuStatusResponse } from '../gpu/gpuStatus.js';

export type GpuProbe = () => Promise<GpuStatusResponse>;

/**
 * `GET /rc/gpu` — owner-only (enforced at the mount), read-only GPU status.
 * Returns `200 { available, gpus }` (the probe result verbatim), or `500
 * gpu_probe_failed` on an unexpected probe failure. No daemon call, no mutation.
 */
export function createGpuRoute(probe: GpuProbe): RequestHandler {
  return async (_req, res) => {
    try {
      const status = await probe();
      res.status(200).json(status);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'GPU probe failed',
          code: 'gpu_probe_failed',
        });
      }
    }
  };
}
