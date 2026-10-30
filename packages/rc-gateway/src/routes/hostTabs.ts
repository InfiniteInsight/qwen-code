/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import {
  isValidTabId,
  type HostTabRegistry,
  type HostTabView,
} from '../hostTabs.js';
import { hostAttachGate } from './hostAttach.js';

/** The largest exit status a process can report. */
const MAX_EXIT_CODE = 255;

export interface HostTabEndDeps {
  registry: Pick<HostTabRegistry, 'end'>;
  /** The persistent host-attach token the wrapper already holds. */
  token: string;
  audit?: AuditRecorder;
  /** Told of every end that landed, after it is recorded (the automatic reopen listens). */
  onEnded?: (tab: HostTabView) => void;
}

/**
 * `POST /rc/host/tabs/:tabId/end` body `{ exitCode }` (#212): the wrapper's
 * last word, posted from its exit path with a short timeout so a dying tab
 * never hangs on it. Same gates as the host attach routes (loopback peer,
 * then the host-attach bearer) and mounted beside them, before
 * `bearerResolve`: a phone token never reaches it.
 *
 * Answers `200 { tabId, state, reason }`, `404 tab_not_found` for a tab id
 * that is malformed or names no record (a record removed from the phone, so
 * the wrapper has nothing to keep), `400 invalid_exit_code` for anything but
 * a whole number from 0 to 255. A second end for the same record changes
 * nothing: the first one wins.
 *
 * Audit: `host_tab_ended` with the session as `target` and `{ tabId,
 * exitCode, reason }`. Never a path.
 */
export function createHostTabEndRoute(deps: HostTabEndDeps): RequestHandler {
  const admit = hostAttachGate(deps.token, deps.audit);
  return async (req, res) => {
    if (!admit(req, res)) return;
    const tabId = req.params['tabId'];
    if (!isValidTabId(tabId)) {
      res.status(404).json({ error: 'Tab not found', code: 'tab_not_found' });
      return;
    }
    const exitCode = ((req.body ?? {}) as { exitCode?: unknown }).exitCode;
    if (
      typeof exitCode !== 'number' ||
      !Number.isSafeInteger(exitCode) ||
      exitCode < 0 ||
      exitCode > MAX_EXIT_CODE
    ) {
      res.status(400).json({
        error: 'exitCode must be a whole number from 0 to 255',
        code: 'invalid_exit_code',
      });
      return;
    }
    const tab = await deps.registry.end(tabId, exitCode);
    if (!tab) {
      res.status(404).json({ error: 'Tab not found', code: 'tab_not_found' });
      return;
    }
    void deps.audit?.record({
      action: 'host_tab_ended',
      target: tab.sessionId,
      outcome: 'ok',
      detail: { tabId, exitCode: tab.exitCode, reason: tab.reason },
    });
    res
      .status(200)
      .json({ tabId, state: tab.state, reason: tab.reason ?? null });
    try {
      deps.onEnded?.(tab);
    } catch {
      // A listener never costs the wrapper its answer.
    }
  };
}
