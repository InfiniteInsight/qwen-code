/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * GET /session/:id/resources — relay what one live conversation has loaded:
 * its skills and its MCP servers, as the daemon sanitises them for a reader.
 *
 * WHY THIS IS NOT THE WORKSPACE READ
 *
 * The SDK builds this from one session's own Config
 * (`DaemonSessionResourcesStatus`, packages/sdk-typescript/src/daemon/types.ts:2520),
 * so the MCP half reports that session's manager rather than the
 * workspace-owned pool. The workspace-scoped view is a different question, and
 * a reader who wants the pool has to ask the workspace. Handing this over
 * labelled as a session fact is the whole job; relabelling it as a workspace
 * fact would be a lie about which budget it describes.
 *
 * WHY NOTHING HERE IS AUDITED
 *
 * It carries names of skills and MCP servers, which is configuration a reader
 * at this scope can already reach: `GET /session/:id/supported-commands`
 * relays the per-session command list with no audit handle, and
 * `GET /session/:id/stats` is un-audited while relaying tool names. Names sit
 * at session-read by the rule #107 settled, and an audit row would record that
 * a reader asked something they were always allowed to ask.
 *
 * WHY THE PANEL DRAWS NO AUTHENTICATION STATE
 *
 * The type says the name-keyed `hasOAuthTokens`, `requiresAuth`,
 * `authenticationState` and `authenticationError` fields are always absent on
 * this route, and that a consumer must not treat their absence as a negative
 * authentication state (types.ts:2526-2533). So a page that drew "not
 * authenticated" for a server with no such field would be inventing a verdict
 * the daemon never gave, in the one direction that would send someone to
 * re-authorise a working server. Absence draws nothing.
 *
 * WHY A MISSING POOL BINDING IS 409 AND NOT 404
 *
 * Same reasoning `sessionStats` records, with a stronger footing here: this
 * payload is built from a live session's Config, so a session the gateway holds
 * no binding for has nothing to report by definition. That is proof there is no
 * one to ask, not proof the conversation is gone, and `POST /session/:id/resume`
 * is what the error text tells a reader to do.
 *
 * WHY A DAEMON 404 STAYS A 404
 *
 * `session_resources` is advertised `since: 'v1'`
 * (packages/cli/src/serve/capabilities.ts:164), so no daemon version lacks this
 * route. A 404 from the daemon can therefore only mean the conversation is not
 * there, and it is relayed as one rather than invented into a capability
 * verdict the way the recap read has to be.
 */
export function createSessionResourcesRoute(
  daemon: Pick<SessionDaemon, 'sessionResources'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed or path-traversal-shaped id before any daemon call,
    // as the sibling session routes do.
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    try {
      const status = await daemon.sessionResources(sessionId);
      res.status(200).json(status);
    } catch (err) {
      const daemonStatus = (err as { status?: unknown } | undefined)?.status;
      if (daemonStatus === 404) {
        res
          .status(404)
          .json({ error: 'Session not found', code: 'session_not_found' });
        return;
      }
      // Test the class rather than a text match: `UnknownSessionError` says
      // only "Unknown session: <id>", which a "not found" match would miss.
      if (err instanceof UnknownSessionError) {
        res.status(409).json({
          error: 'Open this conversation before reading its resources',
          code: 'session_not_loaded',
        });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}
