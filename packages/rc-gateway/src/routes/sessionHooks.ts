/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import type {
  DaemonHookEntry,
  DaemonSessionHooksStatus,
  DaemonStatusCell,
} from '@qwen-code/sdk/daemon';
import {
  UnknownSessionError,
  WorkspacePoolFullError,
  type SessionDaemon,
} from '../daemonPool.js';
import { asDaemonHttpError, daemonErrorBody } from '../daemonHttpError.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * Issue #135: the session hooks read, the one slice of that issue's hooks
 * verdict the user chose to build ("it doesn't need to be on the main page").
 *
 * WHAT A HOOK IS HERE, AND WHAT THE DAEMON DOES NOT KEEP
 *
 * `GET /session/:id/hooks` (cli/src/serve/routes/session.ts, answered by
 * acpAgent.buildSessionHooksStatus) lists the hooks REGISTERED IN THIS SESSION:
 * the ones a skill or the agent added while it ran (`getAllSessionHooks`).
 * Every entry therefore has `source: 'session'`. The hooks in the settings
 * files (project, user, system, extensions) are the workspace's, read by
 * `GET /workspace/hooks`, which this gateway already serves at
 * `/rc/workspace/hooks` (write floor).
 *
 * An entry is a CONFIGURATION record: `eventName` (PreToolUse, Stop, ...),
 * `matcher`, `config` (type command, http, function or prompt, with a
 * timeout), `enabled`, `sequential`, `hookId`. It carries NO run history: no
 * last run, exit code, duration, stdout or stderr. The daemon keeps none and
 * the stream announces none; the one hook failure that reaches a client is a
 * Stop hook that outlasts the daemon's wait, which arrives as a turn_error.
 *
 * The `/session/:id/hooks/operations` and `/registrations` routes the issue
 * thread names exist only in the Hosted Harness profile
 * (cli/src/serve/hosted-harness-session.ts, a private managed-agent mode that
 * answers a different `GET /session/:id/hooks` body, { catalog }). The
 * standard daemon this gateway fronts does not serve them and the SDK has no
 * wrapper for them, so none is mounted here.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT RELAY
 *
 * The daemon's SESSION entries are not masked: serializeHookConfig passes
 * `config.env` and `config.headers` through as they are, where the workspace
 * read masks every value (redactHookSecrets). A share token holds
 * session-read, so relaying the entry would hand a reader the tokens a hook
 * passes to its script. The response is therefore a projection: event,
 * matcher, source, enabled, type, name, description (bounded), timeout,
 * async, the first words of a command (see commandPreview), the host of an
 * http hook (never its path, query or headers), and the daemon's status cells
 * in its own words. Not carried: env, headers, allowedEnvVars, a prompt hook's
 * prompt, `if`, the rest of a command.
 */

const MAX_NAME = 80;
const MAX_DESCRIPTION = 200;
const MAX_PREVIEW = 80;
const MAX_CELL_TEXT = 500;
const MAX_HOOKS = 500;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clip(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '') return undefined;
  return [...t].length > max ? [...t].slice(0, max).join('') + '…' : t;
}

/**
 * The command's first words, enough to tell `./scripts/lint.sh` from
 * `python3 tools/guard.py` and not enough to carry what a command line often
 * carries inline. Leading `NAME=value` assignments are skipped (the value is
 * the secret in `TOKEN=abc ./run`); the program is kept; one following word is
 * kept only when it is a plain path or word: not an option, not an assignment,
 * not a URL, not a long opaque string.
 */
export function commandPreview(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined;
  const words = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i += 1;
  const program = words[i];
  if (program === undefined) return undefined;
  const out = [program];
  const next = words[i + 1];
  if (
    next !== undefined &&
    next.length <= 40 &&
    /^[A-Za-z0-9_./~@+][A-Za-z0-9_./~@+-]*$/.test(next)
  ) {
    out.push(next);
  }
  return clip(out.join(' '), MAX_PREVIEW);
}

/** An http hook's host (never userinfo, path or query), or undefined. */
function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    return clip(new URL(url).host, MAX_NAME);
  } catch {
    return undefined;
  }
}

export interface SessionHookView {
  eventName: string;
  source: string;
  enabled: boolean;
  type: string;
  matcher?: string;
  sequential?: boolean;
  hookId?: string;
  /** The skill that registered it: the last segment of `skillRoot`. */
  skill?: string;
  name?: string;
  description?: string;
  timeout?: number;
  async?: boolean;
  command?: string;
  host?: string;
}

export interface SessionHooksView {
  v: 1;
  sessionId: string;
  workspaceCwd: string;
  disabled: boolean;
  hooks: SessionHookView[];
  errors?: Array<{
    kind: string;
    status: string;
    error?: string;
    errorKind?: string;
    hint?: string;
  }>;
}

function projectHook(entry: DaemonHookEntry): SessionHookView | undefined {
  if (!isPlainObject(entry) || typeof entry.eventName !== 'string') {
    return undefined;
  }
  const config = (
    isPlainObject(entry.config) ? entry.config : {}
  ) as unknown as Record<string, unknown>;
  const type = typeof config['type'] === 'string' ? config['type'] : 'unknown';
  const skillRoot = clip(entry.skillRoot, 400);
  const skill = skillRoot
    ? clip(skillRoot.split(/[\\/]/).filter(Boolean).pop(), MAX_NAME)
    : undefined;
  const timeout = config['timeout'];
  const view: SessionHookView = {
    eventName: entry.eventName,
    source: typeof entry.source === 'string' ? entry.source : 'unknown',
    enabled: entry.enabled === true,
    type,
  };
  const matcher = clip(entry.matcher, MAX_NAME);
  if (matcher) view.matcher = matcher;
  if (typeof entry.sequential === 'boolean') view.sequential = entry.sequential;
  const hookId = clip(entry.hookId, MAX_NAME);
  if (hookId) view.hookId = hookId;
  if (skill) view.skill = skill;
  const name = clip(config['name'], MAX_NAME);
  if (name) view.name = name;
  const description = clip(config['description'], MAX_DESCRIPTION);
  if (description) view.description = description;
  if (typeof timeout === 'number' && Number.isFinite(timeout)) {
    view.timeout = timeout;
  }
  if (typeof config['async'] === 'boolean') view.async = config['async'];
  if (type === 'command') {
    const command = commandPreview(config['command']);
    if (command) view.command = command;
  }
  if (type === 'http') {
    const host = hostOf(config['url']);
    if (host) view.host = host;
  }
  return view;
}

function projectCell(
  cell: DaemonStatusCell,
): NonNullable<SessionHooksView['errors']>[number] | undefined {
  if (!isPlainObject(cell) || typeof cell.kind !== 'string') return undefined;
  const out: NonNullable<SessionHooksView['errors']>[number] = {
    kind: cell.kind,
    status: typeof cell.status === 'string' ? cell.status : 'unknown',
  };
  const error = clip(cell.error, MAX_CELL_TEXT);
  if (error) out.error = error;
  if (typeof cell.errorKind === 'string') out.errorKind = cell.errorKind;
  const hint = clip(cell.hint, MAX_CELL_TEXT);
  if (hint) out.hint = hint;
  return out;
}

/** The daemon's session hooks body as the page may see it, or undefined if it is not one. */
export function projectSessionHooks(
  status: DaemonSessionHooksStatus,
): SessionHooksView | undefined {
  if (!isPlainObject(status) || !Array.isArray(status.hooks)) return undefined;
  const hooks = status.hooks
    .slice(0, MAX_HOOKS)
    .map(projectHook)
    .filter((h): h is SessionHookView => h !== undefined);
  const errors = Array.isArray(status.errors)
    ? status.errors
        .map(projectCell)
        .filter((c): c is NonNullable<typeof c> => c !== undefined)
    : [];
  return {
    v: 1,
    sessionId: typeof status.sessionId === 'string' ? status.sessionId : '',
    workspaceCwd:
      typeof status.workspaceCwd === 'string' ? status.workspaceCwd : '',
    disabled: status.disabled === true,
    hooks,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function sendHooksError(res: Response, err: unknown): void {
  if (err instanceof UnknownSessionError) {
    res.status(404).json({
      error: 'Session is not loaded in the daemon',
      code: 'session_not_found',
    });
    return;
  }
  if (err instanceof WorkspacePoolFullError) {
    res
      .status(503)
      .json({ error: 'Workspace pool is full', code: 'workspace_pool_full' });
    return;
  }
  const http = asDaemonHttpError(err);
  const body = daemonErrorBody(err);
  const code = typeof body?.['code'] === 'string' ? body['code'] : undefined;
  if (http?.status === 404) {
    if (body !== undefined) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    // Express's own "Cannot GET": a daemon that predates the route.
    res.status(502).json({
      error: 'Daemon does not serve session hooks',
      code: 'hooks_unsupported',
    });
    return;
  }
  if (http !== undefined && http.status === 409) {
    // The Hosted Harness profile answers 409 hosted_hooks_unavailable for a
    // session that has no hook runtime. Say it in the gateway's words.
    res.status(502).json({
      error: 'The daemon has no hook runtime for this conversation',
      code: code ?? 'hooks_unavailable',
    });
    return;
  }
  if (http !== undefined && http.status >= 400 && http.status < 500) {
    res.status(http.status).json({
      error: 'The daemon refused this request',
      code: code ?? 'daemon_rejected',
    });
    return;
  }
  res
    .status(502)
    .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
}

/** GET /session/:id/hooks: the session's hooks, projected. */
export function createSessionHooksReadRoute(
  daemon: Pick<SessionDaemon, 'sessionHooks'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    let result: DaemonSessionHooksStatus;
    try {
      result = await daemon.sessionHooks(sessionId);
    } catch (err) {
      sendHooksError(res, err);
      return;
    }
    const view = projectSessionHooks(result);
    if (view === undefined) {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }
    res.status(200).json(view);
  };
}
