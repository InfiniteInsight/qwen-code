/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundTaskRegistry,
  type Config,
} from '@qwen-code/qwen-code-core';
import {
  useDaemonSubagentSync,
  type DaemonSubagentSyncDriver,
  type DaemonSubagentTaskSnapshot,
} from './use-daemon-subagent-sync.js';

function makeConfig(registry: BackgroundTaskRegistry): Config {
  return {
    getBackgroundTaskRegistry: () => registry,
  } as unknown as Config;
}

describe('useDaemonSubagentSync', () => {
  it('clears error, resumeBlockedReason, and notified and refreshes an aborted AbortController on paused -> running transition', async () => {
    const registry = new BackgroundTaskRegistry();
    const config = makeConfig(registry);
    let roster: DaemonSubagentTaskSnapshot[] = [
      {
        kind: 'agent',
        id: 'agent-1',
        description: 'Investigate logs',
        subagentType: 'research',
        status: 'paused',
        startTime: 1000,
        isBackgrounded: true,
        error: 'Turn limit reached',
        resumeBlockedReason: 'worktree_missing',
      },
    ];

    const cancelSubagentSession = vi.fn().mockResolvedValue({ cancelled: true });
    const driver: DaemonSubagentSyncDriver = {
      session: { sessionId: 'sess-1' },
      client: { cancelSubagentSession },
      agents: vi.fn(async () => ({ tasks: roster })),
    };

    const { result, unmount } = renderHook(() =>
      useDaemonSubagentSync(config, driver),
    );

    await waitFor(() => {
      expect(registry.get('agent-1')?.status).toBe('paused');
    });

    const pausedEntry = registry.get('agent-1')!;
    expect(pausedEntry.error).toBe('Turn limit reached');
    expect(pausedEntry.resumeBlockedReason).toBe('worktree_missing');

    // Simulate a prior notification + aborted controller before the agent resumes
    pausedEntry.notified = true;
    pausedEntry.endTime = 2000;
    const oldController = pausedEntry.abortController;
    oldController.abort();
    expect(oldController.signal.aborted).toBe(true);
    cancelSubagentSession.mockClear();

    roster = [
      {
        kind: 'agent',
        id: 'agent-1',
        description: 'Investigate logs',
        subagentType: 'research',
        status: 'running',
        startTime: 1000,
        isBackgrounded: true,
      },
    ];

    act(() => {
      result.current({ type: 'task_changed', data: {} });
    });

    await waitFor(() => {
      expect(registry.get('agent-1')?.status).toBe('running');
    });

    const resumedEntry = registry.get('agent-1')!;
    expect(resumedEntry.error).toBeUndefined();
    expect(resumedEntry.resumeBlockedReason).toBeUndefined();
    expect(resumedEntry.notified).toBe(false);
    expect(resumedEntry.endTime).toBeUndefined();
    expect(resumedEntry.abortController).not.toBe(oldController);
    expect(resumedEntry.abortController.signal.aborted).toBe(false);

    // Aborting the refreshed controller forwards cancellation to the daemon
    act(() => {
      resumedEntry.abortController.abort();
    });
    expect(cancelSubagentSession).toHaveBeenCalledWith('sess-1', 'agent-1');

    unmount();
  });

  it('settles provisional backgrounded subagent entries on failed and cancelled tool_call_update', async () => {
    const registry = new BackgroundTaskRegistry();
    const config = makeConfig(registry);
    const driver: DaemonSubagentSyncDriver = {
      session: { sessionId: 'sess-1' },
      agents: vi.fn(async () => ({ tasks: [] })),
    };

    const { result, unmount } = renderHook(() =>
      useDaemonSubagentSync(config, driver),
    );

    // 1. Provisional backgrounded subagent that fails
    act(() => {
      result.current({
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-bg-fail',
            title: 'Agent',
            status: 'in_progress',
            rawInput: {
              subagent_type: 'general',
              description: 'Failing bg task',
              run_in_background: true,
            },
          },
        },
      });
    });

    const failProvisional = registry.get('daemon-fg-call-bg-fail');
    expect(failProvisional?.status).toBe('running');
    expect(failProvisional?.isBackgrounded).toBe(true);

    act(() => {
      result.current({
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-bg-fail',
            status: 'failed',
          },
        },
      });
    });

    expect(registry.get('daemon-fg-call-bg-fail')?.status).toBe('failed');
    expect(registry.get('daemon-fg-call-bg-fail')?.error).toBe(
      'Subagent failed',
    );

    // 2. Provisional backgrounded subagent that is cancelled
    act(() => {
      result.current({
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-bg-cancel',
            title: 'Agent',
            status: 'in_progress',
            rawInput: {
              subagent_type: 'general',
              description: 'Cancelled bg task',
              run_in_background: true,
            },
          },
        },
      });
    });

    const cancelProvisional = registry.get('daemon-fg-call-bg-cancel');
    expect(cancelProvisional?.status).toBe('running');
    expect(cancelProvisional?.isBackgrounded).toBe(true);

    act(() => {
      result.current({
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-bg-cancel',
            status: 'cancelled',
          },
        },
      });
    });

    expect(registry.get('daemon-fg-call-bg-cancel')?.status).toBe('cancelled');

    unmount();
  });
});
