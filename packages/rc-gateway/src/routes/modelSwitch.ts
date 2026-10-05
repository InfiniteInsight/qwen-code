/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import { isValidSessionId } from '../sessions/chatsPath.js';

/** The daemon surface this route needs: just `setSessionModel`. */
export type ModelSwitchDaemon = Pick<DaemonClient, 'setSessionModel'>;

/**
 * POST /session/:id/model — switch the active model for a session.
 * Proxies to the daemon's `setSessionModel`. WRITE is the mount floor —
 * see server.ts — enforced at the mount, not in this handler.
 *
 * Error mapping: 404 from the daemon → 502 `model_switch_unsupported`;
 * any other daemon failure → 502 `daemon_unavailable`.
 * A malformed id (path-traversal-shaped) → 404 `session_not_found`.
 * No audit row: model changes are informational, not policy actions.
 */
export function createModelSwitchRoute(
  daemon: ModelSwitchDaemon,
): RequestHandler {
  return async (req, res) => {
    try {
      await handleModelSwitch(req, res, daemon);
    } catch {
      // No global Express error middleware; map any unexpected failure to
      // a clean 500 (mirrors approvalMode.ts pattern).
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Model switch failed',
          code: 'model_switch_failed',
        });
      }
    }
  };
}

async function handleModelSwitch(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  daemon: ModelSwitchDaemon,
): Promise<void> {
  const sessionId = req.params.id;

  if (!isValidSessionId(sessionId)) {
    res
      .status(404)
      .json({ error: 'Session not found', code: 'session_not_found' });
    return;
  }

  const body = (req.body ?? {}) as { modelId?: unknown };

  // Validate modelId: must be a non-empty string, never silently default.
  const modelId = body.modelId;
  if (typeof modelId !== 'string' || modelId.length === 0) {
    res.status(400).json({
      error: 'Invalid model id',
      code: 'invalid_model_id',
    });
    return;
  }

  // Proxy to the daemon. Any failure aborts before any response is written.
  try {
    const result = await daemon.setSessionModel(sessionId, modelId);
    res.status(200).json({ modelId, result });
    return;
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 404) {
      res.status(502).json({
        error: 'Daemon does not support model switching',
        code: 'model_switch_unsupported',
      });
      return;
    }
    // Surface a daemon-origin 4xx (e.g., model not found / config error)
    // as its own status so the caller gets the real error code.
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const eBody = (err as { body?: unknown }).body;
      const message =
        typeof eBody === 'object' && eBody !== null && 'error' in eBody
          ? (eBody.error as string)
          : 'Model switch failed';
      res.status(status).json({ error: message, code: 'model_switch_failed' });
      return;
    }
    res
      .status(502)
      .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
  }
}
