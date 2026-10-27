/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import { WorkspacePoolFullError } from '../daemonPool.js';

/** The daemon surface these three routes need. */
export type WorkspaceInventoryDaemon = Pick<
  SessionDaemon,
  'workspaceSkills' | 'workspaceProviders' | 'workspaceHooks'
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

const UNSUPPORTED: Record<
  'skills' | 'providers' | 'hooks',
  { code: string; text: string }
> = {
  skills: {
    code: 'skills_unsupported',
    text: 'Daemon does not support workspace skills read',
  },
  providers: {
    code: 'providers_unsupported',
    text: 'Daemon does not support workspace providers read',
  },
  hooks: {
    code: 'hooks_unsupported',
    text: 'Daemon does not support workspace hooks read',
  },
};

/**
 * The shared body of the three inventory reads. One function rather than three
 * copies because the verdicts have to stay identical: the three payloads carry
 * different lists (`skills`, `providers`, `hooks`) but the same envelope
 * discipline (`v`, `workspaceCwd`, `initialized`, an optional `errors`), and
 * they must fail the same way. Two copies drift, and the drift shows up as one
 * panel reporting a daemon problem differently from its neighbours.
 *
 * As with the diagnostics pair, a daemon 404 becomes a 502 with a named
 * per-route verdict. That is deliberately NOT the rule the session resources
 * relay kept, where a daemon 404 stays a 404: there the 404 has a referent the
 * caller cares about, the conversation. These paths carry no identity in the
 * URL, so a 404 can only mean "this daemon will not answer this".
 *
 * The 200 is relayed verbatim. Each list's members are the daemon's own
 * records and it can add fields without this gateway changing, so nothing here
 * is filtered, reordered, or relabelled.
 */
function inventoryRead(
  daemon: WorkspaceInventoryDaemon,
  which: 'skills' | 'providers' | 'hooks',
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
        which === 'skills'
          ? await daemon.workspaceSkills(target.cwd)
          : which === 'providers'
            ? await daemon.workspaceProviders(target.cwd)
            : await daemon.workspaceHooks(target.cwd);
      res.status(200).json(result);
    } catch (err) {
      // rc-workspace-scoping (#28): targeting a non-default workspace spawns
      // on demand; at the pool cap with no idle victim this is a 503, not a
      // daemon failure.
      if (err instanceof WorkspacePoolFullError) {
        res.status(503).json({
          error: `Workspace daemon pool is full (max ${err.maxDaemons})`,
          code: 'workspace_pool_full',
        });
        return;
      }
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
 * GET /rc/workspace/skills — the workspace's installed skills. WRITE floor.
 *
 * WRITE because of what a skill record is. `DaemonWorkspaceSkillStatus`
 * (packages/sdk-typescript/src/daemon/types.ts:2493) carries `installedPath`, a
 * path on the host, plus `extensionName` and `level`. That is the host half of
 * the #107 line, and it is the same reasoning the gateway already applies to
 * every other workspace read it mounts (permissions, trust, settings, tools,
 * mcp, env, preflight all sit at WRITE).
 */
export function createWorkspaceSkillsRoute(
  daemon: WorkspaceInventoryDaemon,
): RequestHandler {
  return inventoryRead(daemon, 'skills');
}

/**
 * GET /rc/workspace/providers — the configured model providers. WRITE floor.
 *
 * The most identifying of the three. `DaemonWorkspaceProviderModel` (:2578)
 * carries `baseUrl` and `envKey`, so the payload names which environment
 * variable feeds each provider and where it points. A device that can read
 * this can enumerate the host's model endpoints, which is a fact about the
 * machine rather than about a conversation.
 */
export function createWorkspaceProvidersRoute(
  daemon: WorkspaceInventoryDaemon,
): RequestHandler {
  return inventoryRead(daemon, 'providers');
}

/**
 * GET /rc/workspace/hooks — the configured hooks. WRITE floor.
 *
 * The daemon masks what it calls the secret classes here before this gateway
 * ever sees them: `redactHookSecrets`
 * (packages/cli/src/acp-integration/acpAgent.ts:2549) runs on every entry
 * `readHooks` builds (:2728), replacing each `config.env` and `config.headers`
 * VALUE with a constant while keeping the key names. Two consequences this
 * relay has to respect rather than improve on:
 *
 * 1. It must not un-mask or reconstruct anything, and it does not: the payload
 *    is relayed as received.
 * 2. A masked value is not an absent value. `config.env` still lists its key
 *    names, and `config.command` is NOT masked at all, because a hook's shell
 *    command is configuration rather than a credential. So the wire carries
 *    real commands. The page draws hook identity and never the config block,
 *    which is a rendering choice and not a claim that the payload is safe to
 *    display wholesale.
 */
export function createWorkspaceHooksRoute(
  daemon: WorkspaceInventoryDaemon,
): RequestHandler {
  return inventoryRead(daemon, 'hooks');
}
