/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { isValidSessionId } from '../sessions/chatsPath.js';
import { WRITE } from '../scopes.js';

/**
 * GET /session/:id/supported-commands — relay the daemon's per-session slash
 * command list so the web UI's Commands panel can show what the WATCHED
 * session actually supports, next to the gateway's own file-defined commands
 * (GET /rc/commands). The payload is the daemon's
 * `DaemonSessionSupportedCommandsStatus` verbatim: `availableCommands` (each
 * with `name`, optional `description`, `input.hint`, and `_meta.sourceLabel`
 * like `Built-in` / `Skill` / `MCP: <server>`) plus `availableSkills`.
 *
 * Read-scoped, bare namespace (transparent-proxy topology — 1:1 with the
 * daemon's own GET /session/:id/supported-commands) plus ONE gateway-added
 * field, `invocableByYou`, because the daemon's payload has no such thing and
 * the caller cannot derive it: the token's scopes are shown at pair time and
 * kept nowhere, so the page has no way to know whether it holds WRITE. Every
 * session row shares one gate (the invoke route's requireScope(WRITE)), so it
 * is one flag for the whole list rather than a per-row field. Without it the
 * panel could only render Invoke buttons that answer 403, which is the failure
 * this page's own file-command list already avoids by listing rows the caller
 * cannot run with `invocableByYou:false` (see routes/commands.ts).
 *
 * The gateway holds the daemon token; the daemon does the work. Not audited: a
 * command-list read is a status poll with no mutation and no path/arg payload,
 * identical in kind to GET /session/:id/context.
 */
export function createSupportedCommandsRoute(
  daemon: SessionDaemon,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id before any daemon call —
    // mirrors the sibling session routes (context, status).
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    try {
      const status = await daemon.sessionSupportedCommands(sessionId);
      res.status(200).json({
        ...status,
        invocableByYou: (req.rcClient?.scopes ?? []).includes(WRITE),
      });
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}

/**
 * POST /session/:id/supported-commands/:name — run one of the WATCHED
 * session's own slash commands by posting `/name` (plus optional `args`) as
 * that session's prompt text. The daemon interprets leading-slash text on the
 * prompt path itself, so no new daemon capability is needed here; what this
 * route adds over a plain POST /session/:id/prompt is the pre-flight
 * membership check and its own audit record, so a panel invoke is
 * distinguishable from a typed message in both the logs and the error shape.
 *
 * The membership check is the whole design: the command name is validated
 * against the daemon's advertised list BEFORE any text is built, which makes
 * that list the only source of invocable names. A name the session does not
 * advertise is refused (404 `command_not_available`) rather than forwarded, so
 * the route can never be used to push an arbitrary string to the model while
 * looking like a command. A throw from the list read is refused the same way
 * (fail-closed), matching the review saga's skill guard.
 *
 * Body: `{ args?: string }` — the literal text placed after a single space
 * following the name, exactly as it would have been typed. Not re-tokenized or
 * re-quoted: the daemon's own parser sees whatever the caller wrote.
 *
 * Mounted behind the session pipeline (requireScope(WRITE) → recordActivity →
 * enforceSessionLock). WRITE, not SESSION_READ, because these commands mutate
 * session state (`/clear` drops history, `/model` switches the model).
 *
 * The `args` text is NEVER audited — same rule as the prompt route. The audit
 * record carries the command name and the turn's stopReason only.
 *
 * The turn is BOUNDED by `promptTimeoutMs`, the composer route's own knob. It
 * aborts a turn that never settles, which is the only thing that stops one
 * stalled command from holding a daemon admission slot, and so the session's
 * whole prompt queue, indefinitely. See the await below.
 */
export function createSessionCommandInvokeRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  promptTimeoutMs = 600_000,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const name = req.params.name;
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }

    const body = (req.body ?? {}) as { args?: unknown };
    if (body.args !== undefined && typeof body.args !== 'string') {
      res.status(400).json({ error: 'Invalid args', code: 'invalid_args' });
      return;
    }

    let advertised = false;
    try {
      const status = await daemon.sessionSupportedCommands(sessionId);
      const commands = Array.isArray(status.availableCommands)
        ? status.availableCommands
        : [];
      advertised = commands.some((c) => c?.name === name);
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }
    if (!advertised) {
      void audit?.record({
        action: 'session_command_unavailable',
        actorTokenId: req.rcClient?.id,
        target: sessionId,
        detail: { name },
      });
      res.status(404).json({
        error: 'Command not available on this session',
        code: 'command_not_available',
      });
      return;
    }

    const text =
      typeof body.args === 'string' && body.args.length > 0
        ? `/${name} ${body.args}`
        : `/${name}`;

    // Two ways this await can end without a finished turn, and the catch has to
    // tell them apart.
    //
    // A client disconnect stops the WAIT only; the turn itself keeps running,
    // which is routes/prompt.ts's rule (#38) that a backgrounded phone must not
    // lose its turn. There is nothing left to answer, so return silently.
    //
    // The timer is what this route was missing. daemon.prompt() resolves at END
    // OF TURN, so a turn that never settles left this await pending forever:
    // the panel's Invoke button stuck on "invoking…" with it, and, because the
    // daemon caps admission at 5 pending prompts per session, every later
    // prompt on that session then answering 503 `queue full`. Aborting is what
    // actually frees the slot: the SDK's _awaitTurnComplete sends
    // cancel(sessionId, {cancelReason:'interrupted'}) when its signal aborts
    // (DaemonClient.ts:6466-6474), reaching acpAgent.cancel() and the aborts it
    // applies to calls still waiting at admission (acpAgent.ts:7246). A timer
    // that merely stopped the wait would free nothing.
    //
    // Same knob and same 504 shape as the composer route (routes/prompt.ts:81).
    const controller = new AbortController();
    let abortSource = '';
    const timer = setTimeout(() => {
      abortSource = 'timer';
      controller.abort();
    }, promptTimeoutMs);
    res.on('close', () => {
      if (abortSource === '') abortSource = 'disconnect';
      controller.abort();
    });

    let result;
    try {
      result = await daemon.prompt(
        sessionId,
        { prompt: [{ type: 'text', text }] },
        controller.signal,
      );
    } catch {
      if (abortSource === 'timer') {
        // The command WAS invoked, then this route cancelled its turn. No
        // stopReason, because there isn't one.
        void audit?.record({
          action: 'session_command_invoked',
          actorTokenId: req.rcClient?.id,
          subActor: req.rcClient?.subActor,
          target: sessionId,
          detail: { name, timedOut: true },
        });
        if (!res.closed) {
          res
            .status(504)
            .json({ error: 'prompt_timeout', code: 'prompt_timeout' });
        }
        return;
      }
      if (controller.signal.aborted) return;
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    } finally {
      clearTimeout(timer);
    }

    // A timer that fired only after the turn had already resolved is not a
    // failure: the SDK cancels from its catch path alone, so nothing was
    // interrupted and the stopReason it returned is real.
    if (abortSource === 'disconnect') return;

    void audit?.record({
      action: 'session_command_invoked',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: sessionId,
      detail: { name, stopReason: result.stopReason },
    });

    res.status(200).json({ stopReason: result.stopReason });
  };
}
