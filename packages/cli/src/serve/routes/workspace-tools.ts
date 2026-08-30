/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import {
  ToolNames,
  ToolDisplayNames,
  ToolNamesMigration,
} from '@qwen-code/qwen-code-core';
import { loadSettings } from '../../config/settings.js';
import { normalizeDisabledToolList } from '../../config/normalizeDisabledTools.js';
import { getNestedProperty } from '../../utils/settingsUtils.js';
import type { SendBridgeError } from '../server/error-response.js';
import {
  createBuildWorkspaceCtx,
  MAX_TOOL_NAME_LENGTH,
  parseAndValidateWorkspaceClientId,
} from '../server/request-helpers.js';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(ToolNames),
);
const LEGACY_TOOL_ALIASES: ReadonlySet<string> = new Set(
  Object.keys(ToolNamesMigration),
);

/**
 * A tool name is valid for the toggle routes when it is a built-in tool,
 * a legacy alias, or an MCP-discovered tool (`mcp__` prefix). `mcp__` names
 * are discovered at runtime, so they cannot be enumerated statically — but
 * `tools.disabled` is matched against every registered tool, including
 * MCP ones, so they must be accepted.
 */
export function isKnownToolName(name: string): boolean {
  if (BUILTIN_TOOL_NAMES.has(name)) return true;
  if (LEGACY_TOOL_ALIASES.has(name)) return true;
  return name.startsWith('mcp__') && name.length > 'mcp__'.length;
}

export interface ToolCatalogEntry {
  name: string;
  displayName?: string;
  disabled: boolean;
  source: 'builtin' | 'mcp' | 'unknown';
}

export interface ToolsCatalogResponse {
  v: 1;
  tools: ToolCatalogEntry[];
}

/**
 * Build the full tools catalog: every built-in tool with its per-tool
 * disabled state, plus one entry for each disabled name outside the
 * built-in catalog (MCP-discovered or unknown), sorted by name. Mirrors
 * the settings route's trust handling: untrusted workspaces read without
 * workspace-scope settings instead of being rejected.
 */
export function buildToolsCatalog(
  boundWorkspace: string,
  workspaceTrusted = true,
): ToolsCatalogResponse {
  const loaded = loadSettings(boundWorkspace, {
    skipLoadEnvironment: true,
    skipWorkspaceSettings: !workspaceTrusted,
    workspaceTrusted,
  });
  const disabled = normalizeDisabledToolList(
    getNestedProperty(
      loaded.merged as Record<string, unknown>,
      'tools.disabled',
    ),
  );
  const disabledSet = new Set(disabled);
  const tools: ToolCatalogEntry[] = [];
  for (const key of Object.keys(ToolNames) as Array<keyof typeof ToolNames>) {
    const name = ToolNames[key];
    tools.push({
      name,
      displayName: ToolDisplayNames[key],
      disabled: disabledSet.has(name),
      source: 'builtin',
    });
  }
  for (const name of disabled) {
    if (BUILTIN_TOOL_NAMES.has(name)) continue;
    tools.push({
      name,
      disabled: true,
      source: name.startsWith('mcp__') ? 'mcp' : 'unknown',
    });
  }
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { v: 1, tools };
}

interface RegisterWorkspaceToolsRoutesDeps {
  boundWorkspace: string;
  workspace: DaemonWorkspaceService;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
  isWorkspaceTrusted?: () => boolean;
  captureGenerationAssertion?: () => (() => void) | undefined;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
}

export function registerWorkspaceToolsRoutes(
  app: Application,
  deps: RegisterWorkspaceToolsRoutesDeps,
): void {
  const {
    boundWorkspace,
    workspace,
    mutate,
    safeBody,
    sendBridgeError,
    parseAndValidateClientId,
  } = deps;
  const buildWorkspaceCtx = createBuildWorkspaceCtx(boundWorkspace);

  app.get('/workspace/tools/catalog', (_req: Request, res: Response) => {
    try {
      const assertGenerationOpen =
        deps.captureGenerationAssertion?.() ?? (() => {});
      assertGenerationOpen();
      res
        .status(200)
        .json(
          buildToolsCatalog(
            boundWorkspace,
            deps.isWorkspaceTrusted?.() ?? true,
          ),
        );
    } catch (err) {
      if (sendGenerationClosedError(res, err)) return;
      res.status(500).json({
        error: 'Failed to load tools catalog',
        code: 'internal_error',
      });
    }
  });

  app.post(
    '/workspace/tools/:name/enable',
    mutate({ strict: true }),
    async (req, res) => {
      const assertGenerationOpen =
        deps.captureGenerationAssertion?.() ?? (() => {});
      try {
        assertGenerationOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        throw err;
      }
      if (deps.isWorkspaceTrusted?.() === false) {
        res.status(403).json({
          error: 'Workspace is not trusted.',
          code: 'untrusted_workspace',
        });
        return;
      }
      const rawToolName = req.params['name'];
      if (!rawToolName || typeof rawToolName !== 'string') {
        res.status(400).json({
          error: 'Tool name path parameter is required',
          code: 'invalid_tool_name',
        });
        return;
      }
      const toolName = rawToolName.trim();
      if (toolName.length === 0) {
        res.status(400).json({
          error: 'Tool name path parameter is required',
          code: 'invalid_tool_name',
        });
        return;
      }
      if (toolName.length > MAX_TOOL_NAME_LENGTH) {
        res.status(400).json({
          error: `Tool name exceeds ${MAX_TOOL_NAME_LENGTH}-character limit`,
          code: 'invalid_tool_name',
        });
        return;
      }
      if (!isKnownToolName(toolName)) {
        res.status(400).json({
          error: `Unknown tool: ${toolName}. Must be a built-in tool, a legacy alias, or an mcp__-prefixed tool name.`,
          code: 'unknown_tool',
        });
        return;
      }
      const body = safeBody(req);
      const enabled = body['enabled'];
      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          error: '`enabled` is required and must be a boolean',
          code: 'invalid_enabled_flag',
        });
        return;
      }
      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;
      try {
        const ctx = buildWorkspaceCtx(
          'POST /workspace/tools/:name/enable',
          clientId,
        );
        const result = await workspace.setWorkspaceToolEnabled(
          ctx,
          toolName,
          enabled,
        );
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/tools/:name/enable',
        });
      }
    },
  );
}

export function registerWorkspaceQualifiedToolsRoutes(
  app: Application,
  deps: Pick<
    RegisterWorkspaceToolsRoutesDeps,
    'mutate' | 'safeBody' | 'sendBridgeError'
  > & {
    workspaceRegistry: WorkspaceRegistry;
  },
): void {
  app.post(
    '/workspaces/:workspace/tools/:name/enable',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const rawToolName = req.params['name'];
      if (!rawToolName || typeof rawToolName !== 'string') {
        res.status(400).json({
          error: 'Tool name path parameter is required',
          code: 'invalid_tool_name',
        });
        return;
      }
      const toolName = rawToolName.trim();
      if (toolName.length === 0) {
        res.status(400).json({
          error: 'Tool name path parameter is required',
          code: 'invalid_tool_name',
        });
        return;
      }
      if (toolName.length > MAX_TOOL_NAME_LENGTH) {
        res.status(400).json({
          error: `Tool name exceeds ${MAX_TOOL_NAME_LENGTH}-character limit`,
          code: 'invalid_tool_name',
        });
        return;
      }
      if (!isKnownToolName(toolName)) {
        res.status(400).json({
          error: `Unknown tool: ${toolName}. Must be a built-in tool, a legacy alias, or an mcp__-prefixed tool name.`,
          code: 'unknown_tool',
        });
        return;
      }
      const body = deps.safeBody(req);
      const enabled = body['enabled'];
      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          error: '`enabled` is required and must be a boolean',
          code: 'invalid_enabled_flag',
        });
        return;
      }
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      const route = 'POST /workspaces/:workspace/tools/:name/enable';
      try {
        const ctx = createBuildWorkspaceCtx(runtime.workspaceCwd)(
          route,
          clientId,
        );
        const result = await runtime.workspaceService.setWorkspaceToolEnabled(
          ctx,
          toolName,
          enabled,
        );
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );
}
