/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { daemonErrorBody, asDaemonHttpError } from '../daemonHttpError.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * Issue #110: the per-session agent reads the SDK already wraps, relayed 1:1.
 *
 *  - `GET /session/:id/agents`: the roster. Every agent the daemon's registry
 *    holds (running ones carry live `stats` and `recentActivities`) plus the
 *    finished ones read back off their sidecars, which carry neither.
 *  - `GET /session/:id/agent-trace`: the lineage, who spawned whom, read off
 *    the sidecars. `?rootAgentId=` narrows it to one top-level agent's tree on
 *    the daemon. It carries no steps, tool calls or messages: the steps a
 *    reader sees come from the stream the page already watches.
 *  - `GET /session/:id/saved-workflows/:name`: one saved workflow definition,
 *    or `workflow: null`.
 *
 * The first two are read scope and the saved workflow read is WRITE scope
 * (server.ts, #110: it returns a script and its path). All three are unaudited, like the `/tasks` and `/stats`
 * reads beside them: a roster is a poll, and auditing a poll would bury the
 * writes the audit log exists to reconstruct.
 *
 * The one place this departs from a verbatim relay is the saved workflow read
 * for a share guest (a session-locked token). Its answer is a script from the
 * user's project or home directory, with its absolute path, which is not part
 * of the conversation the share was made for, and the route takes the name
 * from the caller, so a guest could ask for any name. A guest gets the
 * daemon's own fail-closed envelope, the one it already answers for an
 * untrusted workspace, so the refusal is indistinguishable from "no such
 * workflow" in exactly the way the daemon designed it to be.
 */

/** The daemon's own bound on an agent id (`MAX_VIRTUAL_SESSION_ID_PART_LENGTH`). */
const MAX_AGENT_ID_LENGTH = 500;

/**
 * One refusal mapping for the three reads. A session the daemon has dropped
 * stays a 404, because flattening it to 502 would tell someone looking at a
 * finished conversation that the gateway is broken. A 404 carrying no code is
 * a daemon that predates these routes, which is a different answer from "no
 * such session" and is named as one. A daemon 400 is the caller's input and
 * relays as itself.
 */
function sendAgentsError(res: Response, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof UnknownSessionError) {
    res
      .status(404)
      .json({ error: 'Session not found', code: 'session_not_found' });
    return;
  }
  const http = asDaemonHttpError(err);
  const body = daemonErrorBody(err);
  const code = typeof body?.['code'] === 'string' ? body['code'] : undefined;
  if (http?.status === 404) {
    if (code === undefined) {
      res.status(502).json({
        error: 'Daemon does not serve the session agent routes',
        code: 'agents_unsupported',
      });
      return;
    }
    res
      .status(404)
      .json({ error: 'Session not found', code: 'session_not_found' });
    return;
  }
  if (http?.status === 400) {
    // The daemon's message is not echoed: it can name a path.
    res.status(400).json({
      error: 'Daemon rejected the request',
      code: code ?? 'daemon_rejected',
    });
    return;
  }
  res
    .status(502)
    .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
}

function refuseMalformedSession(res: Response): void {
  res.status(404).json({ error: 'Session not found', code: 'session_not_found' });
}

/** GET /session/:id/agents: the session's agent roster, verbatim. */
export function createSessionAgentsRoute(
  daemon: Pick<SessionDaemon, 'sessionAgents'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    if (!isValidSessionId(sessionId)) return refuseMalformedSession(res);
    try {
      res.status(200).json(await daemon.sessionAgents(sessionId));
    } catch (err) {
      sendAgentsError(res, err);
    }
  };
}

/**
 * GET /session/:id/agent-trace[?rootAgentId=]: the agents' lineage, verbatim.
 * A malformed `rootAgentId` is refused here with the daemon's own code, before
 * the daemon is asked, so an array or an oversize id never leaves the gateway.
 */
export function createSessionAgentTraceRoute(
  daemon: Pick<SessionDaemon, 'sessionAgentTrace'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    if (!isValidSessionId(sessionId)) return refuseMalformedSession(res);
    const raw = req.query['rootAgentId'];
    if (
      raw !== undefined &&
      (typeof raw !== 'string' ||
        raw.length === 0 ||
        raw.length > MAX_AGENT_ID_LENGTH)
    ) {
      res.status(400).json({
        error: '`rootAgentId` must be a non-empty agent id',
        code: 'invalid_root_agent_id',
      });
      return;
    }
    try {
      res
        .status(200)
        .json(
          await daemon.sessionAgentTrace(
            sessionId,
            raw === undefined ? {} : { rootAgentId: raw },
          ),
        );
    } catch (err) {
      sendAgentsError(res, err);
    }
  };
}

/**
 * GET /session/:id/saved-workflows/:name: one saved workflow definition. A
 * share guest gets the fail-closed envelope without the daemon being asked
 * (see the module comment).
 */
export function createSessionSavedWorkflowRoute(
  daemon: Pick<SessionDaemon, 'sessionSavedWorkflow'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    if (!isValidSessionId(sessionId)) return refuseMalformedSession(res);
    const name = req.params.name;
    if (typeof name !== 'string' || name.length === 0) {
      res.status(400).json({
        error: '`name` route parameter is required',
        code: 'invalid_workflow_name',
      });
      return;
    }
    if (req.rcClient?.sessionLockId !== undefined) {
      res.status(200).json({ v: 1, sessionId, name, workflow: null });
      return;
    }
    try {
      res.status(200).json(await daemon.sessionSavedWorkflow(sessionId, name));
    } catch (err) {
      sendAgentsError(res, err);
    }
  };
}
