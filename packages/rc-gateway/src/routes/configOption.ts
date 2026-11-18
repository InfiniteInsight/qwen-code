/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type {
  DaemonSessionConfigOptionResult,
  ReasoningSelection,
} from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';
import { OWNER, hasScope } from '../scopes.js';
import { isValidSessionId } from '../sessions/chatsPath.js';
import { UnknownSessionError } from '../daemonPool.js';
import { isSessionLevelGone } from '../daemonHttpError.js';
import { relayDaemonAuthFailure } from './daemonAuth.js';

export const ALLOWED_REASONING_SELECTIONS: readonly ReasoningSelection[] = [
  'none',
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function isReasoningSelection(v: unknown): v is ReasoningSelection {
  return (
    typeof v === 'string' &&
    (ALLOWED_REASONING_SELECTIONS as readonly string[]).includes(v)
  );
}

/** The daemon surface this route needs: `setSessionConfigOption`. */
export interface ConfigOptionDaemon {
  setSessionConfigOption?(
    sessionId: string,
    configId: 'reasoning_effort',
    value: ReasoningSelection,
    clientOrOptions?: string | { clientId?: string; persist?: boolean },
  ): Promise<DaemonSessionConfigOptionResult>;
}

export interface ConfigOptionRouteDeps {
  audit?: AuditRecorder;
}

/**
 * POST /session/:id/config-option - proxy the daemon's session config option
 * change (`reasoning_effort`) via the SDK.
 *
 * Tiered scope (fail-closed): session-scoped changes need WRITE (the mount
 * floor - see server.ts); a durable `persist: true` write to settings demands
 * OWNER, checked in-handler before any daemon call.
 */
export function createConfigOptionRoute(
  daemon: ConfigOptionDaemon,
  deps: ConfigOptionRouteDeps = {},
): RequestHandler {
  return async (req, res) => {
    try {
      await handleConfigOption(req, res, daemon, deps);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Reasoning effort change failed',
          code: 'config_option_failed',
        });
      }
    }
  };
}

async function handleConfigOption(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  daemon: ConfigOptionDaemon,
  deps: ConfigOptionRouteDeps,
): Promise<void> {
  const sessionId = req.params.id;

  if (!isValidSessionId(sessionId)) {
    res
      .status(404)
      .json({ error: 'Session not found', code: 'session_not_found' });
    return;
  }

  const body = (req.body ?? {}) as {
    configId?: unknown;
    value?: unknown;
    persist?: unknown;
  };

  if (body.configId !== 'reasoning_effort') {
    res.status(400).json({
      error: 'Invalid configId: must be reasoning_effort',
      code: 'invalid_config_option',
    });
    return;
  }

  if (!isReasoningSelection(body.value)) {
    res.status(400).json({
      error: 'Invalid reasoning effort',
      code: 'invalid_reasoning_effort',
      allowed: ALLOWED_REASONING_SELECTIONS,
    });
    return;
  }
  const value = body.value;

  if (body.persist !== undefined && typeof body.persist !== 'boolean') {
    res
      .status(400)
      .json({ error: 'Invalid persist flag', code: 'invalid_persist_flag' });
    return;
  }
  const persist = body.persist === true;

  if (persist && !hasScope(req.rcClient?.scopes ?? [], OWNER)) {
    void deps.audit?.record({
      action: 'scope_denied',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      detail: {
        required: 'owner',
        reason: 'config_option',
        configId: 'reasoning_effort',
        value,
        persist,
      },
    });
    res
      .status(403)
      .json({ error: 'Owner scope required', code: 'owner_scope_required' });
    return;
  }

  if (typeof daemon.setSessionConfigOption !== 'function') {
    res.status(502).json({
      error: 'Daemon does not support reasoning-effort control',
      code: 'config_option_unsupported',
    });
    return;
  }

  try {
    const result = await daemon.setSessionConfigOption(
      sessionId,
      'reasoning_effort',
      value,
      persist ? { persist: true } : undefined,
    );
    res.status(200).json({
      sessionId,
      configId: 'reasoning_effort',
      value,
      configOptions: Array.isArray(result?.configOptions)
        ? result.configOptions
        : [],
      persisted: result?.persisted === true,
    });
  } catch (err) {
    if (relayDaemonAuthFailure(res, err, 'config_option')) return;
    const status = (err as { status?: unknown }).status;
    if (err instanceof UnknownSessionError || isSessionLevelGone(err)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    if (status === 404) {
      res.status(502).json({
        error: 'Daemon does not support reasoning-effort control',
        code: 'config_option_unsupported',
      });
      return;
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const eBody = (err as { body?: unknown }).body as
        | { error?: unknown; message?: unknown }
        | undefined;
      const message =
        (typeof eBody?.error === 'string' && eBody.error) ||
        (typeof eBody?.message === 'string' && eBody.message) ||
        'Daemon rejected the reasoning-effort change';
      res.status(status).json({
        error: message,
        code: 'config_option_failed',
      });
      return;
    }
    res
      .status(502)
      .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
  }
}
