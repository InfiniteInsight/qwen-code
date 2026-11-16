/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { planCommand } from './planCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core';

describe('planCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext({
      services: {
        config: {
          getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
          getPrePlanMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
          setApprovalMode: vi.fn(),
        } as unknown as import('@qwen-code/qwen-code-core').Config,
      },
    });
  });

  it('should switch to plan mode if not in plan mode', async () => {
    if (!planCommand.action) {
      throw new Error('The plan command must have an action.');
    }

    const result = await planCommand.action(mockContext, '');

    expect(mockContext.services.config?.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.PLAN,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Enabled plan mode. The agent will analyze and plan without executing tools.',
    });
  });

  it('should return submit prompt if arguments are provided when switching to plan mode', async () => {
    if (!planCommand.action) {
      throw new Error('The plan command must have an action.');
    }

    const result = await planCommand.action(mockContext, 'refactor the code');

    expect(mockContext.services.config?.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.PLAN,
    );
    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: 'refactor the code' }],
    });
  });

  it('should return already in plan mode if mode is already plan', async () => {
    if (!planCommand.action) {
      throw new Error('The plan command must have an action.');
    }

    (mockContext.services.config?.getApprovalMode as Mock).mockReturnValue(
      ApprovalMode.PLAN,
    );

    const result = await planCommand.action(mockContext, '');

    expect(mockContext.services.config?.setApprovalMode).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Already in plan mode. Use "/plan exit" to exit plan mode.',
    });
  });

  it('should return submit prompt if arguments are provided and already in plan mode', async () => {
    if (!planCommand.action) {
      throw new Error('The plan command must have an action.');
    }

    (mockContext.services.config?.getApprovalMode as Mock).mockReturnValue(
      ApprovalMode.PLAN,
    );

    const result = await planCommand.action(mockContext, 'keep planning');

    expect(mockContext.services.config?.setApprovalMode).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: 'keep planning' }],
    });
  });

  it('should exit plan mode when exit argument is passed', async () => {
    if (!planCommand.action) {
      throw new Error('The plan command must have an action.');
    }

    (mockContext.services.config?.getApprovalMode as Mock).mockReturnValue(
      ApprovalMode.PLAN,
    );

    const result = await planCommand.action(mockContext, 'exit');

    expect(mockContext.services.config?.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.DEFAULT,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Exited plan mode. Previous approval mode restored.',
    });
  });

  it('should restore pre-plan mode when executing from plan mode', async () => {
    if (!planCommand.action) {
      throw new Error('The plan command must have an action.');
    }

    (mockContext.services.config?.getApprovalMode as Mock).mockReturnValue(
      ApprovalMode.PLAN,
    );
    (mockContext.services.config?.getPrePlanMode as Mock).mockReturnValue(
      ApprovalMode.AUTO_EDIT,
    );

    const result = await planCommand.action(mockContext, 'exit');

    expect(mockContext.services.config?.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.AUTO_EDIT,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Exited plan mode. Previous approval mode restored.',
    });
  });

  it('should return error when execute is used but not in plan mode', async () => {
    if (!planCommand.action) {
      throw new Error('The plan command must have an action.');
    }

    // Default mock returns ApprovalMode.DEFAULT (not PLAN)
    const result = await planCommand.action(mockContext, 'exit');

    expect(mockContext.services.config?.setApprovalMode).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Not in plan mode. Use "/plan" to enter plan mode first.',
    });
  });

  it('delegates to daemon.setApprovalMode and ignores local untrusted-folder throws when daemon succeeds', async () => {
    if (!planCommand.action) {
      throw new Error('The plan command must have an action.');
    }

    const daemonSetApprovalMode = vi.fn().mockResolvedValue(undefined);
    mockContext.services.daemon = {
      setApprovalMode: daemonSetApprovalMode,
    };
    (mockContext.services.config?.setApprovalMode as Mock).mockImplementation(
      () => {
        throw new Error('Cannot enable plan mode in an untrusted folder.');
      },
    );

    const enterResult = await planCommand.action(mockContext, '');
    expect(daemonSetApprovalMode).toHaveBeenCalledWith(ApprovalMode.PLAN, {
      planMode: true,
    });
    expect(enterResult).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Enabled plan mode. The agent will analyze and plan without executing tools.',
    });

    (mockContext.services.config?.getApprovalMode as Mock).mockReturnValue(
      ApprovalMode.PLAN,
    );
    (mockContext.services.config?.getPrePlanMode as Mock).mockReturnValue(
      ApprovalMode.AUTO_EDIT,
    );

    const exitResult = await planCommand.action(mockContext, 'exit');
    expect(daemonSetApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.AUTO_EDIT,
      {
        planMode: false,
      },
    );
    expect(exitResult).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Exited plan mode. Previous approval mode restored.',
    });
  });

  it('still surfaces local config.setApprovalMode errors when daemon is not attached', async () => {
    if (!planCommand.action) {
      throw new Error('The plan command must have an action.');
    }

    (mockContext.services.config?.setApprovalMode as Mock).mockImplementation(
      () => {
        throw new Error('Untrusted folder restriction');
      },
    );

    const result = await planCommand.action(mockContext, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Untrusted folder restriction',
    });
  });

  it('surfaces daemon.setApprovalMode rejection without updating local config', async () => {
    if (!planCommand.action) {
      throw new Error('The plan command must have an action.');
    }

    mockContext.services.daemon = {
      setApprovalMode: vi.fn().mockRejectedValue(new Error('Daemon rejected')),
    };

    const result = await planCommand.action(mockContext, '');
    expect(mockContext.services.config?.setApprovalMode).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Daemon rejected',
    });
  });
});
