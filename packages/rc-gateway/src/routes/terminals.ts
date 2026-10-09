/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import {
  planTerminalCommand,
  type TerminalPlanOptions,
  type TerminalRequestLog,
} from '../terminals.js';

/**
 * POST /rc/terminals — ask the gateway to open a terminal on its own host
 * showing one conversation (issue #49).
 *
 * The gateway records the request and returns immediately; the Windows-side
 * launcher app drains the request log and spawns the actual tab. It cannot do
 * that itself: the gateway runs headless, and WSL only lets a process create a
 * Win32 window from inside the user's interactive session.
 *
 * Body: `{ sessionId }`. The workspace is NOT taken from the body — the pool
 * already knows which daemon owns the session, and that daemon's loopback
 * endpoint + token are what a terminal needs to attach to the SAME session.
 * Deriving it from the session id is also what keeps a client from naming an
 * arbitrary directory to get a shell in.
 *
 * The response carries only the request id. The daemon token stays on the host
 * filesystem (in the request log, mode 0600) and is never sent over the network:
 * the launcher reads the log locally rather than fetching it, which is why this
 * is the only HTTP surface the feature needs.
 *
 * Audit records the session id and request id only — no paths, no tokens.
 */
export function createTerminalOpenRoute(
  daemon: SessionDaemon,
  requests: TerminalRequestLog,
  audit?: AuditRecorder,
  planOpts: TerminalPlanOptions = {},
): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as { sessionId?: unknown };
    const sessionId =
      typeof body.sessionId === 'string' && body.sessionId.length > 0
        ? body.sessionId
        : undefined;
    if (!sessionId) {
      res.status(400).json({
        error: 'sessionId is required',
        code: 'invalid_request',
      });
      return;
    }

    // A gateway wired to a plain single daemon (no pool) has no endpoint
    // lookup, so host terminals are unavailable rather than broken.
    if (typeof daemon.daemonEndpointForSession !== 'function') {
      res.status(501).json({
        error: 'This gateway cannot open host terminals',
        code: 'host_terminals_unsupported',
      });
      return;
    }

    let endpoint;
    try {
      endpoint = daemon.daemonEndpointForSession(sessionId);
    } catch (err) {
      if (err instanceof UnknownSessionError) {
        res.status(404).json({ error: 'Unknown session', code: 'not_found' });
        return;
      }
      throw err;
    }
    if (!endpoint?.token) {
      // Reachable in attach mode (the gateway did not mint the daemon's token)
      // and for any daemon registered without endpoint material.
      res.status(409).json({
        error: 'No credentials for this session daemon',
        code: 'daemon_unavailable',
      });
      return;
    }

    const command = planTerminalCommand(
      {
        sessionId,
        workspaceCwd: endpoint.workspaceCwd,
        daemonUrl: endpoint.url,
        daemonToken: endpoint.token,
      },
      planOpts,
    );
    const request = await requests.enqueue({
      sessionId,
      workspaceCwd: endpoint.workspaceCwd,
      daemonUrl: endpoint.url,
      daemonToken: endpoint.token,
      linuxArgv: command.linuxArgv,
      title: command.title,
    });

    void audit?.record({
      action: 'terminal_requested',
      actorTokenId: req.rcClient?.id,
      target: sessionId,
      detail: { requestId: request.id },
    });

    res.status(202).json({ requestId: request.id });
  };
}
