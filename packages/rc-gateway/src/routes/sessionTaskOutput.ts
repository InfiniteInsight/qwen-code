/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import {
  asDaemonHttpError,
  daemonErrorBody,
  isSessionLevelGone,
} from '../daemonHttpError.js';
import { isValidSessionId } from '../sessions/chatsPath.js';
import { WRITE, hasScope } from '../scopes.js';

const MAX_TASK_ID_LENGTH = 200;
const MAX_TASK_OUTPUT_BYTES = 262_144;

type TaskKind = 'agent' | 'shell' | 'monitor' | 'workflow';

/**
 * GET /session/:id/tasks/:taskId/output (#110).
 *
 * Read-scoped, bare namespace (1:1 with the daemon's own route). The client
 * names a `taskId`, never a path; the daemon looks up the task in its own
 * session registry and reads only the file it recorded itself.
 *
 * Workflow task outputs follow the exact disclosure line as `sessionTasks.ts`:
 * only non-session-locked tokens holding `WRITE` opt into `includeWorkflows`.
 */
export function createSessionTaskOutputRoute(
  daemon: Pick<SessionDaemon, 'sessionTaskOutput'>,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const taskId = req.params.taskId;
    if (
      typeof taskId !== 'string' ||
      taskId.length === 0 ||
      taskId.length > MAX_TASK_ID_LENGTH ||
      taskId.includes('/') ||
      taskId.includes('\0')
    ) {
      res.status(400).json({
        error: 'Invalid taskId parameter',
        code: 'invalid_task_id',
      });
      return;
    }
    const rawKind = req.query.kind;
    let kind: TaskKind | undefined;
    if (rawKind !== undefined) {
      if (
        rawKind !== 'agent' &&
        rawKind !== 'shell' &&
        rawKind !== 'monitor' &&
        rawKind !== 'workflow'
      ) {
        res.status(400).json({
          error: 'kind must be agent, shell, monitor, or workflow',
          code: 'invalid_task_kind',
        });
        return;
      }
      kind = rawKind;
    }
    const rawMaxBytes = req.query.maxBytes;
    let maxBytes: number | undefined;
    if (rawMaxBytes !== undefined) {
      if (typeof rawMaxBytes !== 'string' || !/^\d+$/.test(rawMaxBytes)) {
        res.status(400).json({
          error: `maxBytes must be an integer between 1 and ${MAX_TASK_OUTPUT_BYTES}`,
          code: 'invalid_max_bytes',
        });
        return;
      }
      const parsed = Number.parseInt(rawMaxBytes, 10);
      if (
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_TASK_OUTPUT_BYTES
      ) {
        res.status(400).json({
          error: `maxBytes must be an integer between 1 and ${MAX_TASK_OUTPUT_BYTES}`,
          code: 'invalid_max_bytes',
        });
        return;
      }
      maxBytes = parsed;
    }

    const scopes = req.rcClient?.scopes;
    const mayHaveWorkflows =
      Array.isArray(scopes) &&
      req.rcClient?.sessionLockId === undefined &&
      hasScope(scopes, WRITE);
    if (kind === 'workflow' && !mayHaveWorkflows) {
      res
        .status(404)
        .json({ error: 'Task not found', code: 'task_not_found' });
      return;
    }

    try {
      const output = await daemon.sessionTaskOutput(sessionId, taskId, {
        ...(kind !== undefined ? { kind } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(mayHaveWorkflows ? { includeWorkflows: true } : {}),
      });
      res.status(200).set('Cache-Control', 'no-store').json(output);
    } catch (err) {
      if (err instanceof UnknownSessionError || isSessionLevelGone(err)) {
        res
          .status(404)
          .json({ error: 'Session not found', code: 'session_not_found' });
        return;
      }
      const http = asDaemonHttpError(err);
      const body = daemonErrorBody(err);
      if (http?.status === 404) {
        if (body?.['code'] === 'task_not_found') {
          res
            .status(404)
            .json({ error: 'Task not found', code: 'task_not_found' });
          return;
        }
        if (body?.['code'] === undefined && body?.['errorKind'] === undefined) {
          res.status(501).json({
            error: 'Connected daemon does not support task output reads',
            code: 'task_output_unsupported',
          });
          return;
        }
        res
          .status(404)
          .json({ error: 'Session not found', code: 'session_not_found' });
        return;
      }
      if (http?.status === 400) {
        res.status(400).json({
          error:
            typeof body?.['error'] === 'string'
              ? body['error']
              : 'Invalid task output request',
          code:
            typeof body?.['code'] === 'string'
              ? body['code']
              : 'invalid_request',
        });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}
