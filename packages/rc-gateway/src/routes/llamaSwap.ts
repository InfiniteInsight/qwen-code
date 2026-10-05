/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { LlamaSwapStatusResponse } from '../llama-swap/llamaSwapStatus.js';

export type LlamaSwapProbe = () => Promise<LlamaSwapStatusResponse>;

/**
 * `GET /rc/llama-swap` — owner-only (enforced at the mount), read-only
 * llama-swap status. Returns `200 { available, models }` (the probe result
 * verbatim), or `500 llama_swap_probe_failed` on an unexpected probe failure.
 * No daemon call, no mutation.
 */
export function createLlamaSwapRoute(probe: LlamaSwapProbe): RequestHandler {
  return async (_req, res) => {
    try {
      const status = await probe();
      res.status(200).json(status);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'llama-swap probe failed',
          code: 'llama_swap_probe_failed',
        });
      }
    }
  };
}
