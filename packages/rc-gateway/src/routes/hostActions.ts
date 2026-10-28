/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import type { HostActions } from '../hostActions.js';

/**
 * Host actions (InfiniteInsight/Qwen-Code-Remote#192), OWNER-scoped at the
 * mount and mounted only when the gateway was given a store, so a host with
 * no `host-actions.json` answers 404 and the page draws nothing.
 *
 * - `GET  /rc/host/actions` -> `{ actions: [{ name, label, running }] }`, each
 *   `running` a live probe. The probes run side by side, so the read takes as
 *   long as the slowest one (capped at 10s) rather than their sum.
 * - `POST /rc/host/actions/:name/start` -> `{ name, running }` once the start
 *   argv has exited 0 and the action has been probed again; 404
 *   `host_action_unknown` for a name the file does not hold; 502
 *   `host_action_failed` with `exitCode` (null when there was none: killed at
 *   the cap, or never started) when the start argv did not exit 0.
 *
 * A start that exits 0 but leaves the probe reading not running is a 200
 * with `running: false`, not an error: the start argv did what it was asked,
 * and what the reader needs to know is the state it left, which is the one
 * thing the body says.
 *
 * OWNER rather than WRITE: these run programs on the host, outside any
 * conversation, and a WRITE token (or a share) is scoped to talking to a
 * session, not to the machine it runs on.
 */
export interface HostActionRoutes {
  list: RequestHandler;
  start: RequestHandler;
}

export function createHostActionRoutes(
  store: HostActions,
  deps: { audit?: AuditRecorder } = {},
): HostActionRoutes {
  const list: RequestHandler = async (_req, res) => {
    try {
      const actions = await Promise.all(
        store.list().map(async (a) => ({
          name: a.name,
          label: a.label,
          running: await store.probe(a.name),
        })),
      );
      res.json({ actions });
    } catch {
      // The store reads every runner failure as "not running", so this is a
      // backstop for something unforeseen, not a path a probe takes.
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Host action probe failed',
          code: 'host_action_probe_failed',
        });
      }
    }
  };

  const start: RequestHandler = async (req, res) => {
    const name = req.params['name'];
    try {
      if (typeof name !== 'string' || !store.has(name)) {
        res.status(404).json({
          error: 'No host action by that name',
          code: 'host_action_unknown',
        });
        return;
      }
      const outcome = await store.start(name);
      // One row per press that reached a start, whatever it came to. The
      // argv is not recorded: the file is the record of what runs, and the
      // name is the key into it.
      void deps.audit?.record({
        action: 'host_action_started',
        actorTokenId: req.rcClient?.id,
        shareId: req.rcClient?.shareId,
        shareLabel: req.rcClient?.shareLabel,
        outcome: outcome.ok ? 'ok' : 'failed',
        detail: outcome.ok
          ? { name, running: outcome.running }
          : { name, exitCode: outcome.code },
      });
      if (!outcome.ok) {
        res.status(502).json({
          error:
            outcome.code === null
              ? 'The start command did not finish (no exit code)'
              : `The start command exited ${outcome.code}`,
          code: 'host_action_failed',
          exitCode: outcome.code,
        });
        return;
      }
      res.json({ name, running: outcome.running });
    } catch {
      if (!res.headersSent) {
        res.status(502).json({
          error: 'The start command could not be run',
          code: 'host_action_failed',
          exitCode: null,
        });
      }
    }
  };

  return { list, start };
}
