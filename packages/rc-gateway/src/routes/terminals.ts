/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { isSessionMirrored } from '../hostMirrors.js';
import {
  planTerminalCommand,
  type TerminalPlanOptions,
  type TerminalRequestLog,
} from '../terminals.js';

/**
 * The launcher's poll interval, which it drives from its own main process
 * (`launcher-app/src/main/main.ts`, `TERMINAL_POLL_MS`). Duplicated rather than
 * imported because the launcher is a separate app with its own build, and the
 * only thing this needs is how long a silence is normal.
 */
export const LAUNCHER_POLL_MS = 4_000;

/**
 * A launcher that has missed three polls is treated as gone. Three is the same
 * tolerance the bridge registry uses for a missed heartbeat, so the two liveness
 * notions on this host do not disagree about what "stopped" means.
 */
export const LAUNCHER_STALE_MS = 3 * LAUNCHER_POLL_MS;

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
 * The response carries the request id plus what was known about the launcher at
 * the moment of the request. The id alone invited a lie: 202 means the request
 * was written down, and a client that reports it as "opening a terminal" is
 * claiming a future it cannot support. `launcherState` says whether anyone is
 * on this host who could act on it, which is the difference between "a tab will
 * appear" and "this is queued and may sit there".
 *
 * The daemon token stays on the host filesystem (in the request log, mode 0600)
 * and is never sent over the network: the launcher reads the log locally rather
 * than fetching it, which is why this is the only HTTP surface the feature
 * needs.
 *
 * When a terminal is already attached to the session on this host (a live
 * process whose argv carries `--attach-session <id>`, see `hostMirrors.ts`) the
 * route answers 200 `{ alreadyMirrored: true, sessionId }` and writes nothing:
 * no request, no audit record. A tab attached to a dead daemon still counts.
 *
 * Audit records the session id and request id only — no paths, no tokens.
 */
export function createTerminalOpenRoute(
  daemon: SessionDaemon,
  requests: TerminalRequestLog,
  audit?: AuditRecorder,
  planOpts: TerminalPlanOptions = {},
  isMirrored: (sessionId: string) => Promise<boolean> = (id) =>
    isSessionMirrored(id),
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

    // One tab per session (#194): a terminal already attached to this
    // conversation is the answer, not a reason to open a second. Checked after
    // the session and its credentials are known good, so every refusal above
    // reads the same as before. A check that throws is treated as "none":
    // a missing tab is worse than a rare duplicate one.
    let mirrored = false;
    try {
      mirrored = await isMirrored(sessionId);
    } catch {
      mirrored = false;
    }
    if (mirrored) {
      res.status(200).json({ alreadyMirrored: true, sessionId });
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

    // Read after the append so the answer describes the host as of now rather
    // than as of whenever this request landed. A missing or unreadable marker
    // is reported as such rather than defaulted to live: guessing live is the
    // optimistic direction, and the optimistic direction is what produced the
    // "opening on the host" note that this replaces.
    const { state, seenMsAgo } =
      await requests.launcherLiveness(LAUNCHER_STALE_MS);

    res.status(202).json({
      requestId: request.id,
      launcherState: state,
      launcherSeenMsAgo: seenMsAgo,
    });
  };
}
