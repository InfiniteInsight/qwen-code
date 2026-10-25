/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { classifySubagentFailure } from './subagentFailure.js';
import type { SessionDaemon } from '../daemonPool.js';

/**
 * GET /session/:id/subagents/:subagentRef — read ONE subagent's own run state.
 *
 * This is the read half of the pair whose write half already ships as
 * `/cancel`. A viewer can already draw a nested subagent block and already
 * stop it, but cannot say what it is doing or what it cost, which is why that
 * block is display only today. `subagentRef` is the PARENT transcript's
 * tool-call id (the daemon matches it against `task.toolUseId`), the same value
 * the page holds as `_meta.parentToolCallId`, so no new identifier is introduced.
 *
 * The daemon's resolution is passed through verbatim. It carries task id,
 * title, status, duration and token counts, and no workspace path
 * (`virtual-subagent-sessions.ts:979-990`), so there is nothing here to strip
 * and no local schema to drift from when the daemon adds a field.
 *
 * No audit record: this is a read, and the gateway's other session reads
 * (`pending-prompts`, `mid-turn-messages`, `status`, `context`) record nothing.
 * Auditing a poll would bury the writes the audit log exists to reconstruct.
 */
export function createSubagentInspectRoute(
  daemon: Pick<SessionDaemon, 'resolveSubagentSession'>,
): RequestHandler {
  return async (req, res) => {
    const subagentRef = req.params.subagentRef;
    let resolved;
    try {
      resolved = await daemon.resolveSubagentSession(
        req.params.id,
        subagentRef,
      );
    } catch (err) {
      const code = classifySubagentFailure(err, subagentRef);
      // The daemon's own message is never echoed, so a workspace path cannot
      // leak through it.
      if (code === 'subagent_not_found') {
        res
          .status(404)
          .json({ error: 'Subagent not found in this session', code });
        return;
      }
      if (code === 'session_unreachable') {
        res
          .status(503)
          .json({ error: 'That session is not reachable right now', code });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }
    res.status(200).json(resolved);
  };
}
