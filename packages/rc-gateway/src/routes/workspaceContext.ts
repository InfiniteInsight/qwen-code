/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonCreateAgentRequest } from '@qwen-code/sdk/daemon';
import type { AuditRecorder } from '../auditLog.js';
import type { SessionDaemon } from '../daemonPool.js';
import { WorkspacePoolFullError } from '../daemonPool.js';
import {
  asDaemonHttpError,
  daemonErrorBody,
  workspacePoolFullBody,
} from '../daemonHttpError.js';
import { relayDaemonAuthFailure } from './daemonAuth.js';

/** The daemon surface these two routes need. */
export type WorkspaceContextDaemon = Pick<
  SessionDaemon,
  'workspaceMemory' | 'listWorkspaceAgents'
>;

/**
 * rc-workspace-scoping (#28): resolve the optional `workspace` target out of
 * a GET query value. Absent or empty string → the default/boot workspace
 * (`undefined`); a non-empty string is trimmed and used as the target cwd;
 * any other shape is a 400 `invalid_workspace` (the handler sends it and
 * returns). Copied from the settings sibling so both parse the same shape.
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

const UNSUPPORTED: Record<'memory' | 'agents', { code: string; text: string }> =
  {
    memory: {
      code: 'memory_unsupported',
      text: 'Daemon does not support workspace memory read',
    },
    agents: {
      code: 'agents_unsupported',
      text: 'Daemon does not support workspace agents read',
    },
  };

/**
 * The shared body of the two context reads. One function rather than two copies
 * for the reason the inventory sibling already records: the payloads carry
 * different lists, the envelope discipline and the verdict set do not, and two
 * copies drift into one panel reporting a daemon problem differently from its
 * neighbour.
 *
 * A daemon 404 becomes a 502 with a named per-route verdict, same as the
 * inventory and diagnostics siblings, and NOT the session resources relay's
 * rule: these paths carry no identity in the URL, so a 404 can only mean "this
 * daemon will not answer this".
 *
 * The 200 is relayed verbatim, with one exception worth stating because it looks
 * like an oversight and is not: see `createWorkspaceMemoryRoute` for why this
 * gateway never asks the daemon for file CONTENT, whatever the caller sends.
 */
function contextRead(
  daemon: WorkspaceContextDaemon,
  which: 'memory' | 'agents',
): RequestHandler {
  return async (req, res) => {
    const target = parseWorkspaceTarget(req.query.workspace);
    if (!target.ok) {
      res.status(400).json({
        error: 'Invalid workspace target',
        code: 'invalid_workspace',
      });
      return;
    }
    try {
      const result =
        which === 'memory'
          ? await daemon.workspaceMemory(target.cwd)
          : await daemon.listWorkspaceAgents(target.cwd);
      res.status(200).json(result);
    } catch (err) {
      // rc-workspace-scoping (#28): targeting a non-default workspace spawns
      // on demand; at the pool cap with no idle victim this is a 503, not a
      // daemon failure.
      if (err instanceof WorkspacePoolFullError) {
        res.status(503).json(workspacePoolFullBody(req, err));
        return;
      }
      if (relayDaemonAuthFailure(res, err, `workspace_${which}`)) return;
      const status = (err as { status?: unknown }).status;
      if (status === 404) {
        res.status(502).json({
          error: UNSUPPORTED[which].text,
          code: UNSUPPORTED[which].code,
        });
        return;
      }
      if (!res.headersSent) {
        res
          .status(502)
          .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      }
    }
  };
}
/**
 * GET /rc/workspace/memory - the workspace's context files (QWEN.md and friends).
 * WRITE floor.
 *
 * WRITE for the same reason as its siblings: each entry is a `path` on the host
 * plus a `scope` of `workspace` or `global`
 * (packages/sdk-typescript/src/daemon/types.ts:2625), so the payload says which
 * context files exist on this machine and how large they are.
 *
 * The load-bearing constraint on this route is that it never asks for file
 * CONTENT. `DaemonWorkspaceMemoryFile.content` (:2632) is present only when the
 * caller passed `includeContent: true`, and the SDK records what that flag is
 * actually for (packages/sdk-typescript/src/daemon/DaemonClient.ts:2614): it "is
 * the only way to read the global file, which sits outside the bound workspace
 * and so is refused by `readWorkspaceFile`". So the flag is not a convenience, it
 * is the designed exception to a boundary the file browser enforces.
 *
 * Exposing it here would make this relay a back door around that refusal: a
 * device that can read one metadata list could read the home-directory context
 * file the same gateway's own file routes will not open. So the pool method takes
 * no options, the route reads no `content` query parameter, and the flag is not
 * reachable from the wire at all. The 200 is still relayed verbatim, which means
 * the guard is "we never ask" rather than "we strip" - if a future daemon started
 * returning content unasked, the page would still not draw it, and the page
 * scenario that asserts exactly that is the tripwire.
 */
export function createWorkspaceMemoryRoute(
  daemon: WorkspaceContextDaemon,
): RequestHandler {
  return contextRead(daemon, 'memory');
}

/**
 * GET /rc/workspace/agents - the workspace's subagent definitions. WRITE floor.
 *
 * `DaemonWorkspaceAgentSummary`
 * (packages/sdk-typescript/src/daemon/types.ts:2948) carries `filePath`, a host
 * path, alongside `level`, `model`, `tools`, `mcpServerNames` and `hookEvents`.
 * Between them that names which files define each agent and what each one is
 * allowed to reach, which is the host half of the #107 line rather than a name.
 */
export function createWorkspaceAgentsRoute(
  daemon: WorkspaceContextDaemon,
): RequestHandler {
  return contextRead(daemon, 'agents');
}

const MAX_AGENT_NAME_LENGTH = 64;
const MAX_AGENT_DESCRIPTION_LENGTH = 1024;
const MAX_AGENT_PROMPT_LENGTH = 65_536;
const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * POST /rc/workspace/agents?workspace=<cwd> (#123).
 *
 * WRITE floor, audited. Restricted strictly to `scope: 'workspace'` (project
 * `.qwen/agents/`), mirroring `workspaceMemoryWrite.ts` refusing `global` so a
 * remote token cannot write outside the target workspace, and refusing inline
 * `mcpServers` and `hooks` process definitions.
 */
export function createWorkspaceAgentCreateRoute(
  daemon: Pick<SessionDaemon, 'createWorkspaceAgent'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const actorTokenId = req.rcClient?.id;
    const target = parseWorkspaceTarget(req.query.workspace);
    if (!target.ok) {
      res.status(400).json({
        error: 'Invalid workspace target',
        code: 'invalid_workspace',
      });
      return;
    }
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({
        error: 'Body must be an object',
        code: 'invalid_agent_config',
      });
      return;
    }
    const b = body as Record<string, unknown>;
    if (b['scope'] !== undefined && b['scope'] !== 'workspace') {
      res.status(400).json({
        error: 'Only workspace-scoped subagents can be created remotely',
        code: 'global_scope_not_supported',
      });
      return;
    }
    if (b['mcpServers'] !== undefined || b['hooks'] !== undefined) {
      res.status(400).json({
        error: 'Remote agent definitions cannot embed mcpServers or hooks',
        code: 'agent_host_config_forbidden',
      });
      return;
    }
    const name = typeof b['name'] === 'string' ? b['name'].trim() : '';
    if (
      !name ||
      name.length > MAX_AGENT_NAME_LENGTH ||
      !AGENT_NAME_RE.test(name)
    ) {
      res.status(400).json({
        error:
          'Agent name must be 1 to 64 alphanumeric, dash, or underscore characters',
        code: 'invalid_agent_name',
      });
      return;
    }
    const description =
      typeof b['description'] === 'string' ? b['description'].trim() : '';
    if (!description || description.length > MAX_AGENT_DESCRIPTION_LENGTH) {
      res.status(400).json({
        error: 'Agent description must be 1 to 1024 characters',
        code: 'invalid_agent_description',
      });
      return;
    }
    const systemPrompt =
      typeof b['systemPrompt'] === 'string' ? b['systemPrompt'] : '';
    if (!systemPrompt.trim() || systemPrompt.length > MAX_AGENT_PROMPT_LENGTH) {
      res.status(400).json({
        error: 'Agent systemPrompt must be 1 to 65536 characters',
        code: 'invalid_agent_prompt',
      });
      return;
    }
    const payload: DaemonCreateAgentRequest = {
      name,
      description,
      systemPrompt,
      scope: 'workspace',
      ...(Array.isArray(b['tools']) &&
      b['tools'].every((t): t is string => typeof t === 'string')
        ? { tools: b['tools'] }
        : {}),
      ...(Array.isArray(b['disallowedTools']) &&
      b['disallowedTools'].every((t): t is string => typeof t === 'string')
        ? { disallowedTools: b['disallowedTools'] }
        : {}),
      ...(typeof b['model'] === 'string' && b['model'].trim()
        ? { model: b['model'].trim() }
        : {}),
      ...(typeof b['color'] === 'string' && b['color'].trim()
        ? { color: b['color'].trim() }
        : {}),
    };

    try {
      const result = await daemon.createWorkspaceAgent(
        payload,
        undefined,
        target.cwd,
      );
      void audit?.record({ action: 'workspace_agent_created', actorTokenId });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof WorkspacePoolFullError) {
        void audit?.record({
          action: 'workspace_agent_create_failed',
          actorTokenId,
          detail: { reason: 'pool_full' },
        });
        res.status(503).json(workspacePoolFullBody(req, err));
        return;
      }
      if (relayDaemonAuthFailure(res, err, 'workspace_agents')) return;
      const http = asDaemonHttpError(err);
      const dBody = daemonErrorBody(err);
      const code =
        typeof dBody?.['code'] === 'string' ? dBody['code'] : undefined;
      if (http?.status === 409) {
        void audit?.record({
          action: 'workspace_agent_create_failed',
          actorTokenId,
          detail: { reason: 'conflict' },
        });
        res.status(409).json({
          error: 'A workspace agent with that name already exists',
          code: code ?? 'agent_already_exists',
        });
        return;
      }
      if (http !== undefined && http.status >= 400 && http.status < 500) {
        void audit?.record({
          action: 'workspace_agent_create_failed',
          actorTokenId,
          detail: { reason: 'rejected' },
        });
        res.status(http.status).json({
          error:
            typeof dBody?.['error'] === 'string'
              ? dBody['error']
              : 'The daemon refused this agent definition',
          code: code ?? 'invalid_config',
        });
        return;
      }
      void audit?.record({
        action: 'workspace_agent_create_failed',
        actorTokenId,
        detail: { reason: 'daemon_unavailable' },
      });
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}

/**
 * DELETE /rc/workspace/agents/:agentType?workspace=<cwd> (#123).
 *
 * Restricted to `scope: 'workspace'` so global user agents in `~/.qwen/agents`
 * cannot be deleted remotely.
 */
export function createWorkspaceAgentDeleteRoute(
  daemon: Pick<SessionDaemon, 'deleteWorkspaceAgent'>,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const actorTokenId = req.rcClient?.id;
    const target = parseWorkspaceTarget(req.query.workspace);
    if (!target.ok) {
      res.status(400).json({
        error: 'Invalid workspace target',
        code: 'invalid_workspace',
      });
      return;
    }
    const rawScope = req.query.scope;
    if (rawScope !== undefined && rawScope !== 'workspace') {
      res.status(400).json({
        error: 'Only workspace-scoped subagents can be deleted remotely',
        code: 'global_scope_not_supported',
      });
      return;
    }
    const agentType = req.params.agentType;
    if (
      typeof agentType !== 'string' ||
      !agentType ||
      agentType.length > MAX_AGENT_NAME_LENGTH ||
      !AGENT_NAME_RE.test(agentType)
    ) {
      res.status(400).json({
        error: 'Invalid agentType parameter',
        code: 'invalid_agent_name',
      });
      return;
    }
    try {
      await daemon.deleteWorkspaceAgent(
        agentType,
        { scope: 'workspace' },
        undefined,
        target.cwd,
      );
      void audit?.record({ action: 'workspace_agent_deleted', actorTokenId });
      res.status(200).json({ deleted: true, name: agentType });
    } catch (err) {
      if (err instanceof WorkspacePoolFullError) {
        void audit?.record({
          action: 'workspace_agent_delete_failed',
          actorTokenId,
          detail: { reason: 'pool_full' },
        });
        res.status(503).json(workspacePoolFullBody(req, err));
        return;
      }
      if (relayDaemonAuthFailure(res, err, 'workspace_agents')) return;
      const http = asDaemonHttpError(err);
      const dBody = daemonErrorBody(err);
      const code =
        typeof dBody?.['code'] === 'string' ? dBody['code'] : undefined;
      if (http !== undefined && http.status >= 400 && http.status < 500) {
        void audit?.record({
          action: 'workspace_agent_delete_failed',
          actorTokenId,
          detail: { reason: 'rejected' },
        });
        res.status(http.status).json({
          error:
            typeof dBody?.['error'] === 'string'
              ? dBody['error']
              : 'The daemon refused to delete that agent',
          code: code ?? 'daemon_rejected',
        });
        return;
      }
      void audit?.record({
        action: 'workspace_agent_delete_failed',
        actorTokenId,
        detail: { reason: 'daemon_unavailable' },
      });
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
    }
  };
}
