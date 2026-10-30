/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import type {
  DaemonSessionGroupInput,
  DaemonSessionOrganizationUpdate,
} from '@qwen-code/sdk';
import {
  UnknownSessionError,
  WorkspacePoolFullError,
  type SessionDaemon,
} from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { asDaemonHttpError, daemonErrorBody } from '../daemonHttpError.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * Issue #110: filing a conversation, the write half of what the session
 * catalog (#132) already reads.
 *
 *  - `PATCH /session/:id/organization`: the daemon's per-session sidecar in
 *    the workspace's organization store. Three fields, each optional:
 *    `groupId` (a named group of that workspace, or null), `color` (a colour
 *    tag, one of the six presets, or null) and `isPinned`. The daemon keeps
 *    group and colour independently; its own UI treats them as one choice
 *    (picking either clears the other), and the list's chip draws the colour
 *    over the group, so the page sends both together. The answer is the
 *    daemon's effective organization, `{ sessionId, groupId, isPinned,
 *    pinnedAt?, color, updatedAt }`, relayed as it comes.
 *  - `POST /rc/workspace/session-groups?workspace=<cwd>`: a new named group,
 *    `{ name, color }`, answered `201 { group }`. A group belongs to one
 *    workspace's store, so the workspace is required rather than defaulted:
 *    a group made in the wrong one is a group the session cannot be filed
 *    under (the daemon answers `group_not_found`).
 *
 * Both are WRITE and audited. Neither echoes a daemon message: the
 * organization store's messages quote the group id or name that was sent.
 */

const PRESET_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const ORGANIZATION_FIELDS = ['groupId', 'color', 'isPinned'];
/** A group id is the daemon's randomUUID; anything far past that is not one. */
const MAX_GROUP_ID_LENGTH = 200;
/** The daemon's `MAX_GROUP_NAME_LENGTH` (session-organization-service.ts:99). */
const MAX_GROUP_NAME_LENGTH = 64;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function invalid(res: Response, code: string, error: string): void {
  res.status(400).json({ error, code });
}

/**
 * A daemon 404 means three different things on the PATCH, and only the body
 * tells them apart: the organization store's `group_not_found`, the route's
 * own "No session" (a JSON body naming the session), and a daemon without the
 * route at all (express's plain-text "Cannot PATCH"). The last is named, not
 * read as a missing session. On the group create a JSON 404 is about the
 * workspace, never a session, so it keeps the daemon's code.
 */
function sendOrganizationError(
  res: Response,
  err: unknown,
  on: 'session' | 'group' = 'session',
): 'not_found' | 'rejected' | 'unsupported' | 'daemon_unavailable' {
  if (err instanceof UnknownSessionError) {
    res.status(404).json({
      error: 'Session is not loaded in the daemon',
      code: 'session_not_found',
    });
    return 'not_found';
  }
  if (err instanceof WorkspacePoolFullError) {
    res.status(503).json({
      error: 'Workspace pool is full',
      code: 'workspace_pool_full',
    });
    return 'daemon_unavailable';
  }
  const http = asDaemonHttpError(err);
  const body = daemonErrorBody(err);
  const code = typeof body?.['code'] === 'string' ? body['code'] : undefined;
  if (http?.status === 404) {
    if (code === 'group_not_found') {
      res.status(404).json({
        error: 'No such group in this conversation\'s folder',
        code,
      });
      return 'rejected';
    }
    if (body !== undefined && on === 'group') {
      res.status(404).json({
        error: 'The daemon does not serve that folder',
        code: code ?? 'workspace_not_found',
      });
      return 'not_found';
    }
    if (body !== undefined) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return 'not_found';
    }
    res.status(502).json({
      error: 'Daemon does not serve session organization',
      code: 'organization_unsupported',
    });
    return 'unsupported';
  }
  if (http?.status === 409 && code === 'group_name_conflict') {
    res
      .status(409)
      .json({ error: 'A group with that name already exists', code });
    return 'rejected';
  }
  if (http !== undefined && http.status >= 400 && http.status < 500) {
    res.status(http.status).json({
      error: 'The daemon refused this change',
      code: code ?? 'daemon_rejected',
    });
    return 'rejected';
  }
  res
    .status(502)
    .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
  return 'daemon_unavailable';
}

/** PATCH /session/:id/organization: file ONE session. */
export function createSessionOrganizationRoute(
  daemon: Pick<SessionDaemon, 'updateSessionOrganization'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const body: unknown = req.body;
    if (!isPlainObject(body)) {
      return invalid(
        res,
        'invalid_session_organization',
        'Body must be an object',
      );
    }
    const keys = Object.keys(body);
    // A field the daemon would ignore is refused rather than dropped: a
    // caller whose field was ignored would believe it was written.
    if (keys.some((k) => !ORGANIZATION_FIELDS.includes(k))) {
      return invalid(
        res,
        'invalid_session_organization',
        'Only `groupId`, `color` and `isPinned` can be set',
      );
    }
    // An empty PATCH changes nothing but still marks the daemon's catalog as
    // changed, so it is not a way to read the organization either.
    if (keys.length === 0) {
      return invalid(res, 'empty_organization_update', 'Nothing to change');
    }
    const update: DaemonSessionOrganizationUpdate = {};
    if (body['isPinned'] !== undefined) {
      if (typeof body['isPinned'] !== 'boolean') {
        return invalid(
          res,
          'invalid_session_organization',
          '`isPinned` must be a boolean',
        );
      }
      update.isPinned = body['isPinned'];
    }
    if (body['groupId'] !== undefined) {
      const g = body['groupId'];
      if (
        g !== null &&
        (typeof g !== 'string' ||
          g.length === 0 ||
          g.length > MAX_GROUP_ID_LENGTH)
      ) {
        return invalid(
          res,
          'invalid_session_organization',
          '`groupId` must be a group id or null',
        );
      }
      update.groupId = g;
    }
    if (body['color'] !== undefined) {
      const c = body['color'];
      if (c !== null && (typeof c !== 'string' || !PRESET_COLORS.includes(c))) {
        return invalid(
          res,
          'invalid_session_organization',
          '`color` must be one of ' + PRESET_COLORS.join(', ') + ', or null',
        );
      }
      update.color = c as DaemonSessionOrganizationUpdate['color'];
    }

    let result;
    try {
      result = await daemon.updateSessionOrganization(sessionId, update);
    } catch (err) {
      const reason = sendOrganizationError(res, err);
      void audit?.record({
        action: 'session_organize_failed',
        actorTokenId,
        target: sessionId,
        detail: { reason },
      });
      return;
    }
    void audit?.record({
      action: 'session_organized',
      actorTokenId,
      target: sessionId,
      detail: { fields: keys.sort() },
    });
    res.status(200).json(result);
  };
}

function parseWorkspace(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/** POST /rc/workspace/session-groups?workspace=<cwd>: a new named group. */
export function createSessionGroupCreateRoute(
  daemon: Pick<SessionDaemon, 'createSessionGroup'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const actorTokenId = req.rcClient?.id;
    const workspace = parseWorkspace(req.query['workspace']);
    if (workspace === undefined) {
      return invalid(
        res,
        'invalid_workspace',
        'A group belongs to one folder: name it with ?workspace=',
      );
    }
    const body: unknown = req.body;
    if (
      !isPlainObject(body) ||
      Object.keys(body).some((k) => k !== 'name' && k !== 'color')
    ) {
      return invalid(
        res,
        'invalid_group',
        'Body must be an object with `name` and `color`',
      );
    }
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (
      name.length === 0 ||
      name.length > MAX_GROUP_NAME_LENGTH ||
      /[\p{Cc}\p{Cf}]/u.test(name)
    ) {
      return invalid(
        res,
        'invalid_group_name',
        'A group name is 1 to 64 characters with no control characters',
      );
    }
    const color = typeof body['color'] === 'string' ? body['color'] : '';
    if (!PRESET_COLORS.includes(color) && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return invalid(
        res,
        'invalid_group_color',
        'A group colour is one of ' +
          PRESET_COLORS.join(', ') +
          ', or #RRGGBB',
      );
    }
    let group;
    try {
      group = await daemon.createSessionGroup(workspace, {
        name,
        color: color as DaemonSessionGroupInput['color'],
      });
    } catch (err) {
      const reason = sendOrganizationError(res, err, 'group');
      void audit?.record({
        action: 'session_group_create_failed',
        actorTokenId,
        detail: { reason },
      });
      return;
    }
    // No name and no folder in the record: the audit log carries no paths,
    // and a group's name is the user's own words.
    void audit?.record({ action: 'session_group_created', actorTokenId });
    res.status(201).json({ group });
  };
}
