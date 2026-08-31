/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditQuery,
  type AuditReader,
} from '../auditLog.js';

/**
 * GET /rc/audit?limit&since&action&actor&shareId&tool&rule → newest-first
 * audit records. `tool`/`rule` (issue #32) filter on `detail.tool` /
 * `detail.ruleId` so a permission decisions feed can query per rule.
 */
export function createAuditQueryRoute(reader: AuditReader): RequestHandler {
  return async (req, res) => {
    const q: AuditQuery = {};

    const limit = Number(req.query.limit);
    if (Number.isFinite(limit) && limit >= 1) q.limit = Math.trunc(limit);

    const since = Number(req.query.since);
    if (req.query.since !== undefined && Number.isFinite(since))
      q.since = since;

    const action = req.query.action;
    if (
      typeof action === 'string' &&
      (AUDIT_ACTIONS as readonly string[]).includes(action)
    ) {
      q.action = action as AuditAction;
    }

    const actor = req.query.actor;
    if (typeof actor === 'string' && actor.length > 0) q.actor = actor;

    const shareId = req.query.shareId;
    if (typeof shareId === 'string' && shareId.length > 0) q.shareId = shareId;

    const tool = req.query.tool;
    if (typeof tool === 'string' && tool.length > 0) q.tool = tool;

    const rule = req.query.rule;
    if (typeof rule === 'string' && rule.length > 0) q.rule = rule;

    const rows = await reader.query(q);
    res.status(200).json(rows);
  };
}
