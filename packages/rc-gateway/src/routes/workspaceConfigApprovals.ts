/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join, resolve } from 'node:path';
import { Router } from 'express';
import type { AuditRecorder } from '../auditLog.js';
import { loadWorkspacePolicy } from '../policy/loader.js';
import {
  readContainedWorkspaceConfig,
  type WorkspaceConfigApprovalRecord,
  type WorkspaceConfigApprovalStore,
  type WorkspaceConfigKind,
} from '../policy/workspaceConfigApprovals.js';
import {
  canSuppressCriticalKind,
  loadRoutingConfig,
} from '../routing/rules.js';

const PREVIEW_MAX_CHARS = 4096;

export interface WorkspaceConfigApprovalsDeps {
  store: WorkspaceConfigApprovalStore;
  workspaceCwd: () => string | undefined;
  onApproved?: (
    kind: WorkspaceConfigKind,
    filePath: string,
  ) => void | Promise<void>;
  audit?: AuditRecorder;
}

export interface WorkspaceConfigFileStatus {
  kind: WorkspaceConfigKind;
  path: string;
  status: 'absent' | 'approved' | 'held' | 'invalid';
  sha256?: string;
  heldPhase?: 'boot' | 'reload' | 'unapproved';
  heldAt?: string | null;
  ruleCount?: number;
  violations?: string[];
  preview?: string;
  previewTruncated?: boolean;
  error?: string;
  approved: WorkspaceConfigApprovalRecord | null;
}

function inspectOneConfig(
  store: WorkspaceConfigApprovalStore,
  workspaceCwd: string,
  kind: WorkspaceConfigKind,
): WorkspaceConfigFileStatus {
  const fallbackPath = join(
    resolve(workspaceCwd),
    '.qwen',
    kind === 'policy' ? 'policy.yaml' : 'routing.yaml',
  );
  let contained;
  try {
    contained = readContainedWorkspaceConfig(workspaceCwd, kind);
  } catch (err) {
    return {
      kind,
      path: fallbackPath,
      status: 'invalid',
      error: (err as Error).message,
      approved: store.getApproval(fallbackPath) ?? null,
    };
  }

  const approved = store.getApproval(contained.path) ?? null;
  if (contained.absent) {
    store.clearHeld(contained.path);
    return {
      kind,
      path: contained.path,
      status: 'absent',
      approved,
    };
  }

  let ruleCount = 0;
  let violations: string[] = [];
  try {
    if (kind === 'policy') {
      const parsed = loadWorkspacePolicy(contained.text);
      ruleCount = parsed.policy.rules.length;
      violations = parsed.violations;
    } else {
      const parsed = loadRoutingConfig(contained.text);
      const ignored = parsed.rules.filter((r) => canSuppressCriticalKind(r));
      ruleCount = parsed.rules.length - ignored.length;
      violations = ignored.map(
        (r) =>
          `rule '${r.id || '<unnamed>'}' drops action-required events and is ignored`,
      );
    }
  } catch (err) {
    return {
      kind,
      path: contained.path,
      status: 'invalid',
      sha256: contained.sha256,
      error: (err as Error).message,
      approved,
    };
  }

  if (approved && approved.sha256 === contained.sha256) {
    store.clearHeld(contained.path);
    return {
      kind,
      path: contained.path,
      status: 'approved',
      sha256: contained.sha256,
      ruleCount,
      violations,
      approved,
    };
  }

  const held = store.getHeld(contained.path);
  const heldPhase =
    held && held.sha256 === contained.sha256 ? held.phase : 'unapproved';
  const previewTruncated = contained.text.length > PREVIEW_MAX_CHARS;
  const preview = previewTruncated
    ? contained.text.slice(0, PREVIEW_MAX_CHARS)
    : contained.text;

  return {
    kind,
    path: contained.path,
    status: 'held',
    sha256: contained.sha256,
    heldPhase,
    heldAt: held && held.sha256 === contained.sha256 ? held.heldAt : null,
    ruleCount,
    violations,
    preview,
    previewTruncated,
    approved,
  };
}

export function createWorkspaceConfigApprovalRoutes(
  deps: WorkspaceConfigApprovalsDeps,
): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const cwd = deps.workspaceCwd();
    if (!cwd) {
      res.status(200).json({ workspaceCwd: null, files: [] });
      return;
    }
    const resolvedCwd = resolve(cwd);
    const files: WorkspaceConfigFileStatus[] = [
      inspectOneConfig(deps.store, resolvedCwd, 'policy'),
      inspectOneConfig(deps.store, resolvedCwd, 'routing'),
    ];
    res.status(200).json({ workspaceCwd: resolvedCwd, files });
  });

  router.post('/approve', async (req, res) => {
    const body = (req.body ?? {}) as { kind?: unknown; sha256?: unknown };
    if (body.kind !== 'policy' && body.kind !== 'routing') {
      res.status(400).json({
        error: 'Expected kind to be "policy" or "routing"',
        code: 'invalid_kind',
      });
      return;
    }
    if (
      typeof body.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(body.sha256.trim())
    ) {
      res.status(400).json({
        error: 'Expected sha256 to be a 64-character hex digest',
        code: 'invalid_sha256',
      });
      return;
    }
    const expectedSha = body.sha256.trim().toLowerCase();
    const cwd = deps.workspaceCwd();
    if (!cwd) {
      res.status(409).json({
        error: 'Gateway has no bound workspace directory to approve',
        code: 'workspace_unavailable',
      });
      return;
    }

    let contained;
    try {
      contained = readContainedWorkspaceConfig(cwd, body.kind);
    } catch (err) {
      res.status(400).json({
        error: `Refusing workspace ${body.kind}.yaml: ${(err as Error).message}`,
        code: 'invalid_config',
      });
      return;
    }

    if (contained.absent) {
      res.status(404).json({
        error: `Workspace ${body.kind}.yaml does not exist at ${contained.path}`,
        code: 'config_file_missing',
      });
      return;
    }

    if (contained.sha256 !== expectedSha) {
      res.status(409).json({
        error:
          `Workspace ${body.kind}.yaml changed on disk (now ${contained.sha256.slice(0, 12)}); ` +
          `refresh and review the current bytes before approving`,
        code: 'config_changed',
        currentSha256: contained.sha256,
      });
      return;
    }

    try {
      if (body.kind === 'policy') {
        loadWorkspacePolicy(contained.text);
      } else {
        loadRoutingConfig(contained.text);
      }
    } catch (err) {
      res.status(400).json({
        error: `Workspace ${body.kind}.yaml is invalid: ${(err as Error).message}`,
        code: 'invalid_config',
      });
      return;
    }

    const approvedBy = req.rcClient?.id ?? 'owner';
    const record = deps.store.approve({
      path: contained.path,
      kind: body.kind,
      sha256: contained.sha256,
      approvedBy,
    });
    await deps.audit?.record({
      action: 'workspace_config_approved',
      actorTokenId: req.rcClient?.id,
      target: contained.path,
      detail: {
        kind: body.kind,
        sha256: contained.sha256,
      },
    });
    if (deps.onApproved) {
      await deps.onApproved(body.kind, contained.path);
    }
    res.status(200).json({ ok: true, approval: record });
  });

  return router;
}
