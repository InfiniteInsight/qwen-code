/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modelCommand } from './modelCommand.js';
import type {
  CommandContext,
  MessageActionReturn,
  OpenDialogActionReturn,
} from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

/**
 * `/model` in a tab attached to a daemon session. The tab's own Config is not
 * what the session runs on, so the command must go to the daemon and leave the
 * local Config (and settings) alone.
 */
describe('modelCommand attached to a daemon session', () => {
  let setModel: ReturnType<typeof vi.fn>;
  let switchModel: ReturnType<typeof vi.fn>;
  let setValue: ReturnType<typeof vi.fn>;
  let ctx: CommandContext;

  beforeEach(() => {
    setModel = vi.fn().mockResolvedValue({});
    switchModel = vi.fn();
    setValue = vi.fn();
    ctx = createMockCommandContext({
      services: {
        config: {
          getContentGeneratorConfig: () => ({ authType: 'openai' }),
          getAvailableModelsForAuthType: () => [],
          getModel: () => 'local-default',
          switchModel,
        },
        settings: { merged: {}, setValue, isTrusted: true },
        daemon: {
          state: {
            models: {
              currentModelId: 'flint(openai)',
              availableModels: [
                { modelId: 'flint(openai)', name: 'flint' },
                { modelId: 'qwen3-coder(openai)', name: 'qwen3-coder' },
                { modelId: 'qwen3-coder(qwen-oauth)', name: 'qwen3-coder' },
              ],
            },
          },
          setModel,
        },
      },
    } as never);
  });

  it('switches through the daemon, not the local config', async () => {
    const r = (await modelCommand.action!(
      ctx,
      'qwen3-coder(openai)',
    )) as MessageActionReturn;
    expect(setModel).toHaveBeenCalledWith('qwen3-coder(openai)');
    expect(switchModel).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(r.messageType).toBe('info');
    expect(r.content).toContain('qwen3-coder(openai)');
  });

  it('accepts a bare name that is unique in the daemon list', async () => {
    await modelCommand.action!(ctx, 'flint');
    expect(setModel).toHaveBeenCalledWith('flint(openai)');
  });

  it('refuses an ambiguous bare name and names the candidates', async () => {
    const r = (await modelCommand.action!(
      ctx,
      'qwen3-coder',
    )) as MessageActionReturn;
    expect(setModel).not.toHaveBeenCalled();
    expect(r.messageType).toBe('error');
    expect(r.content).toContain('qwen3-coder(openai)');
    expect(r.content).toContain('qwen3-coder(qwen-oauth)');
  });

  it('refuses a model the daemon does not offer', async () => {
    const r = (await modelCommand.action!(ctx, 'ghost')) as MessageActionReturn;
    expect(setModel).not.toHaveBeenCalled();
    expect(switchModel).not.toHaveBeenCalled();
    expect(r.messageType).toBe('error');
    expect(r.content).toContain('flint(openai)');
  });

  it('reports a daemon refusal instead of claiming success', async () => {
    setModel.mockRejectedValue(new Error('model not configured'));
    const r = (await modelCommand.action!(ctx, 'flint')) as MessageActionReturn;
    expect(r.messageType).toBe('error');
    expect(r.content).toContain('model not configured');
  });

  it('rejects scope flags, which have no meaning for a session switch', async () => {
    const r = (await modelCommand.action!(
      ctx,
      '--global flint',
    )) as MessageActionReturn;
    expect(setModel).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(r.messageType).toBe('error');
  });

  it('rejects the inline one-shot form', async () => {
    const r = (await modelCommand.action!(
      ctx,
      'flint say hi',
    )) as MessageActionReturn;
    expect(setModel).not.toHaveBeenCalled();
    expect(r.messageType).toBe('error');
  });

  it('opens the picker with no argument', async () => {
    const r = (await modelCommand.action!(ctx, '')) as OpenDialogActionReturn;
    expect(r.type).toBe('dialog');
    expect(r.dialog).toBe('model');
  });

  it('says so when the daemon exposes no model switching', async () => {
    (ctx.services.daemon as { setModel?: unknown }).setModel = undefined;
    const r = (await modelCommand.action!(ctx, 'flint')) as MessageActionReturn;
    expect(switchModel).not.toHaveBeenCalled();
    expect(r.messageType).toBe('error');
  });
});
