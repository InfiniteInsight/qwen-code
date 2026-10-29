/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, RequestHandler, Response } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import { WorkspacePoolFullError } from '../daemonPool.js';
import { relayDaemonAuthFailure } from './daemonAuth.js';

/**
 * Which sessions are actually open right now (add-capability-parity #111).
 *
 *   GET /rc/sessions/live-state?workspace=<cwd>  -> the daemon's
 *       GET /workspaces/:workspace/sessions/live-state
 *
 * WHY THIS EXISTS AT ALL
 *
 * The rail lists conversations by reading transcripts off disk, so a
 * conversation with no transcript yet never appears, and a conversation that
 * has one looks identical whether or not anything is attached to it. Issue
 * #89 is the first half of that: a conversation one window started is invisible
 * to another. This route is what tells the two apart, because it answers from
 * the daemon's in-memory attachment state rather than from files: which
 * sessions are live, how many clients each has, and whether each is parked on
 * a permission or a question.
 *
 * WHY THE PAYLOAD IS THE DAEMON'S, UNTOUCHED
 *
 * The result is `DaemonWorkspaceSessionLiveState`: a `v` literal, a
 * `catalogVersion` generation-and-revision pair, and one entry per live
 * session. `v` and `catalogVersion` are equality tokens a caller compares
 * against the snapshot it already holds, so re-encoding them here would break
 * the one thing they are for. Per-entry `activeWorkState` is documented absent
 * against an older daemon, and `updatedAt` is recency for ordering only, not
 * proof of a flush. Both are the daemon's to extend, so every field travels.
 *
 * WHY A BARE 404 IS NOT A FAILURE
 *
 * The daemon's own capability note says released daemons advertise
 * `workspace_session_live_state` WITHOUT implementing this route, so clients
 * must pre-flight it directly. A 404 carrying no error envelope is therefore
 * the expected answer from exactly such a daemon, and it has to be
 * distinguishable from a transport failure: it maps to 502
 * `live_state_unsupported` so a caller can fall back to the full catalog once,
 * rather than retry a route that will never answer. A 404 that does carry an
 * envelope is the daemon answering a question about a workspace and relays as
 * itself.
 *
 * WHY `spawn=0` EXISTS (#190)
 *
 *   GET /rc/sessions/live-state?workspace=<cwd>&spawn=0
 *
 * The plain form resolves its workspace through the daemon pool, which starts
 * a daemon for a workspace that has none. The list reads every recent folder
 * beside the current one, so asking the plain form about each would start a
 * daemon per folder on every refresh. `spawn=0` answers from a daemon the
 * pool already holds and otherwise says nothing is open there:
 * `{ sessions: [], pooled: false }`. That carries no `v` or `catalogVersion`,
 * because no daemon issued one and an invented token would compare equal to
 * nothing a caller holds. A folder with no daemon has no live session this
 * gateway could reach, so the empty set is a statement, not a guess. Same
 * scope, same errors, and the same untouched payload when a daemon answers.
 *
 * WHY THE TRUST REFUSAL IS RELAYED AND NOT FLATTENED
 *
 * The same note says the route stays subject to the per-workspace trust check
 * even when the tag is advertised. So a 403 here is a real verdict about that
 * workspace, not a missing capability, and flattening it into a 502 would tell
 * a caller to give up on a workspace it could use after being granted trust.
 */

/** The daemon's refusal envelope, as `failOnError` builds it. */
interface ErrorBody {
  errorKind?: unknown;
  error?: unknown;
  hint?: unknown;
}

/**
 * rc-workspace-scoping (#28): resolve the optional `workspace` target out of a
 * GET query value. Absent or empty string means the default/boot workspace
 * (`undefined`); a non-empty string is trimmed and used as the target cwd; any
 * other shape is a 400 `invalid_workspace`.
 */
function parseWorkspaceTarget(
  raw: unknown,
): { ok: true; cwd: string | undefined } | { ok: false } {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, cwd: undefined };
  }
  if (typeof raw === 'string') return { ok: true, cwd: raw.trim() };
  return { ok: false };
}

/**
 * #190: the optional `spawn` switch. Absent or `1` is the spawning read the
 * route always was; `0` reads only from a daemon the pool already holds.
 * Anything else, a repeat included, is a 400 rather than a guess, since
 * guessing `1` would start the daemon the caller asked not to start.
 */
function parseSpawn(
  raw: unknown,
): { ok: true; spawn: boolean } | { ok: false } {
  if (raw === undefined || raw === '1') return { ok: true, spawn: true };
  if (raw === '0') return { ok: true, spawn: false };
  return { ok: false };
}

function sendLiveStateError(res: Response, err: unknown): void {
  if (res.headersSent) return;
  // Targeting a non-default workspace spawns on demand; at the pool cap with
  // no idle victim that is a 503, not a daemon failure.
  if (err instanceof WorkspacePoolFullError) {
    res.status(503).json({
      error: `Workspace daemon pool is full (max ${err.maxDaemons})`,
      code: 'workspace_pool_full',
    });
    return;
  }
  if (relayDaemonAuthFailure(res, err, 'live_state')) return;
  const status = (err as { status?: unknown }).status;
  const body = (err as { body?: unknown }).body as ErrorBody | undefined;
  const kind = typeof body?.errorKind === 'string' ? body.errorKind : undefined;
  const message = typeof body?.error === 'string' ? body.error : undefined;
  const hint = typeof body?.hint === 'string' ? body.hint : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    if (status === 404 && kind === undefined) {
      res.status(502).json({
        error: 'Daemon does not support the workspace session live-state route',
        code: 'live_state_unsupported',
      });
      return;
    }
    res.status(status).json({
      error: message ?? 'Daemon rejected the request',
      code: kind ?? 'daemon_rejected',
      ...(hint !== undefined ? { hint } : {}),
    });
    return;
  }
  res.status(502).json({
    error: 'Daemon unavailable',
    code: 'daemon_unavailable',
  });
}

/**
 * GET /rc/sessions/live-state - the workspace's live attachment snapshot.
 *
 * No audit row, matching every other read in this family: the answer is
 * ephemeral state that changes between two polls, so a row would record a
 * moment that had already passed by the time it was written, and the rail
 * polls it.
 */
export function createSessionLiveStateRoute(
  daemon: Pick<SessionDaemon, 'getSessionLiveState' | 'peekSessionLiveState'>,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const target = parseWorkspaceTarget(req.query['workspace']);
    if (!target.ok) {
      res
        .status(400)
        .json({ error: 'Invalid workspace target', code: 'invalid_workspace' });
      return;
    }
    const mode = parseSpawn(req.query['spawn']);
    if (!mode.ok) {
      res
        .status(400)
        .json({ error: 'spawn must be 0 or 1', code: 'invalid_spawn' });
      return;
    }
    try {
      if (mode.spawn) {
        res.status(200).json(await daemon.getSessionLiveState(target.cwd));
        return;
      }
      // A daemon with no pool behind it cannot say which workspaces have a
      // daemon running, so it does not answer as if none had.
      if (!daemon.peekSessionLiveState) {
        res.status(501).json({
          error: 'This gateway has no daemon pool to read without spawning',
          code: 'live_state_unpooled',
        });
        return;
      }
      const snapshot = await daemon.peekSessionLiveState(target.cwd);
      res
        .status(200)
        .json(
          snapshot === undefined ? { sessions: [], pooled: false } : snapshot,
        );
    } catch (err) {
      sendLiveStateError(res, err);
    }
  };
}
