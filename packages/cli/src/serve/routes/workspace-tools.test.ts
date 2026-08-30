/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ToolNames, ToolDisplayNames } from '@qwen-code/qwen-code-core';
import {
  buildToolsCatalog,
  isKnownToolName,
  registerWorkspaceToolsRoutes,
} from './workspace-tools.js';
import { loadSettings } from '../../config/settings.js';
import { sendBridgeError } from '../server/error-response.js';

vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return { ...actual, loadSettings: vi.fn() };
});

beforeEach(() => {
  vi.mocked(loadSettings).mockReturnValue({
    merged: {},
  } as never);
});

function makeApp(
  overrides: {
    isWorkspaceTrusted?: () => boolean;
  } = {},
) {
  const app = express();
  app.use(express.json());

  const setWorkspaceToolEnabled = vi.fn(
    async (_ctx: unknown, toolName: string, enabled: boolean) => ({
      toolName,
      enabled,
    }),
  );

  registerWorkspaceToolsRoutes(app, {
    boundWorkspace: '/workspace',
    workspace: { setWorkspaceToolEnabled } as never,
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    sendBridgeError,
    isWorkspaceTrusted: overrides.isWorkspaceTrusted,
    parseAndValidateClientId: () => undefined,
  });

  return { app, setWorkspaceToolEnabled };
}

describe('isKnownToolName', () => {
  it('accepts built-in tool names', () => {
    expect(isKnownToolName(ToolNames.READ_FILE)).toBe(true);
    expect(isKnownToolName(ToolNames.SHELL)).toBe(true);
  });

  it('accepts legacy alias names', () => {
    expect(isKnownToolName('replace')).toBe(true);
    expect(isKnownToolName('search_file_content')).toBe(true);
  });

  it('accepts mcp__-prefixed names with a non-empty suffix', () => {
    expect(isKnownToolName('mcp__search__lookup')).toBe(true);
  });

  it('rejects the bare mcp__ prefix', () => {
    expect(isKnownToolName('mcp__')).toBe(false);
  });

  it('rejects unknown names', () => {
    expect(isKnownToolName('definitely_not_a_tool')).toBe(false);
    expect(isKnownToolName('')).toBe(false);
  });
});

describe('buildToolsCatalog', () => {
  it('lists every built-in tool with its disabled state, sorted by name', () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: { tools: { disabled: [ToolNames.SHELL] } },
    } as never);

    const catalog = buildToolsCatalog('/workspace');

    expect(catalog.v).toBe(1);
    const names = catalog.tools.map((tool) => tool.name);
    expect(names).toEqual([...names].sort());
    for (const name of Object.values(ToolNames)) {
      const entry = catalog.tools.find((tool) => tool.name === name);
      expect(entry).toBeDefined();
      expect(entry!.source).toBe('builtin');
    }
    expect(
      catalog.tools.find((tool) => tool.name === ToolNames.SHELL)?.disabled,
    ).toBe(true);
    expect(
      catalog.tools.find((tool) => tool.name === ToolNames.READ_FILE)?.disabled,
    ).toBe(false);
    expect(
      catalog.tools.find((tool) => tool.name === ToolNames.SHELL)?.displayName,
    ).toBe(ToolDisplayNames.SHELL);
  });

  it('adds one entry per disabled non-builtin name with the right source', () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: {
        tools: { disabled: ['mcp__search__lookup', 'totally_bogus'] },
      },
    } as never);

    const catalog = buildToolsCatalog('/workspace');

    expect(catalog.tools).toContainEqual({
      name: 'mcp__search__lookup',
      disabled: true,
      source: 'mcp',
    });
    expect(catalog.tools).toContainEqual({
      name: 'totally_bogus',
      disabled: true,
      source: 'unknown',
    });
  });
});

describe('GET /workspace/tools/catalog', () => {
  it('returns the catalog reflecting the normalized disabled list', async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: { tools: { disabled: [ToolNames.SHELL, 'mcp__x__y'] } },
    } as never);
    const { app } = makeApp();

    const res = await request(app).get('/workspace/tools/catalog');

    expect(res.status).toBe(200);
    expect(res.body.v).toBe(1);
    expect(res.body.tools).toContainEqual({
      name: 'mcp__x__y',
      disabled: true,
      source: 'mcp',
    });
    expect(
      res.body.tools.find((t: { name: string }) => t.name === ToolNames.SHELL),
    ).toMatchObject({ disabled: true, source: 'builtin' });
  });

  it('untrusted workspace: reads without workspace settings instead of 403', async () => {
    vi.mocked(loadSettings).mockReturnValue({
      merged: { tools: { disabled: [ToolNames.SHELL] } },
    } as never);
    const { app } = makeApp({ isWorkspaceTrusted: () => false });

    const res = await request(app).get('/workspace/tools/catalog');

    expect(res.status).toBe(200);
    expect(loadSettings).toHaveBeenCalledWith('/workspace', {
      skipLoadEnvironment: true,
      skipWorkspaceSettings: true,
      workspaceTrusted: false,
    });
  });

  it('returns 500 internal_error when settings cannot be loaded', async () => {
    vi.mocked(loadSettings).mockImplementation(() => {
      throw new Error('boom');
    });
    const { app } = makeApp();

    const res = await request(app).get('/workspace/tools/catalog');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
  });
});

describe('POST /workspace/tools/:name/enable', () => {
  it('rejects an unknown tool name with 400 unknown_tool and no settings write', async () => {
    const { app, setWorkspaceToolEnabled } = makeApp();

    const res = await request(app)
      .post('/workspace/tools/definitely_not_a_tool/enable')
      .send({ enabled: false });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_tool');
    expect(setWorkspaceToolEnabled).not.toHaveBeenCalled();
  });

  it('validates the name before the enabled flag', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/workspace/tools/definitely_not_a_tool/enable')
      .send({ enabled: 'no' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_tool');
  });

  it('rejects the bare mcp__ prefix as an unknown tool', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/workspace/tools/mcp__/enable')
      .send({ enabled: false });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_tool');
  });

  it('accepts an mcp__-prefixed name and forwards it to the service', async () => {
    const { app, setWorkspaceToolEnabled } = makeApp();

    const res = await request(app)
      .post('/workspace/tools/mcp__search__lookup/enable')
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      toolName: 'mcp__search__lookup',
      enabled: false,
    });
    expect(setWorkspaceToolEnabled).toHaveBeenCalledWith(
      expect.anything(),
      'mcp__search__lookup',
      false,
    );
  });

  it('accepts a legacy alias name', async () => {
    const { app, setWorkspaceToolEnabled } = makeApp();

    const res = await request(app)
      .post('/workspace/tools/replace/enable')
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(setWorkspaceToolEnabled).toHaveBeenCalledWith(
      expect.anything(),
      'replace',
      true,
    );
  });

  it('rejects a non-boolean enabled flag', async () => {
    const { app, setWorkspaceToolEnabled } = makeApp();

    const res = await request(app)
      .post(`/workspace/tools/${ToolNames.SHELL}/enable`)
      .send({ enabled: 'no' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_enabled_flag');
    expect(setWorkspaceToolEnabled).not.toHaveBeenCalled();
  });

  it('rejects an untrusted workspace before touching the name or the service', async () => {
    const { app, setWorkspaceToolEnabled } = makeApp({
      isWorkspaceTrusted: () => false,
    });

    const res = await request(app)
      .post(`/workspace/tools/${ToolNames.SHELL}/enable`)
      .send({ enabled: false });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('untrusted_workspace');
    expect(setWorkspaceToolEnabled).not.toHaveBeenCalled();
  });
});
