/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSidechannelFollowupSuggestion,
  getSidechannelFollowupSuggestion,
  publishSidechannelFollowupSuggestion,
} from './followupSidechannel.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot = {
    lastFollowupSuggestion: undefined as
      | undefined
      | { sessionId: string; promptId: string; suggestion: string },
  };
  return {
    connection: {
      sessionId: 'sess-1' as string | undefined,
    },
    setLastFollowupSuggestion(
      next:
        | undefined
        | { sessionId: string; promptId: string; suggestion: string },
    ) {
      snapshot = { lastFollowupSuggestion: next };
      for (const listener of listeners) listener();
    },
    store: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
      clearFollowupSuggestion: vi.fn(() => {
        snapshot = { lastFollowupSuggestion: undefined };
        for (const listener of listeners) listener();
      }),
    },
  };
});

vi.mock('./session/DaemonSessionProvider.js', () => ({
  useDaemonConnection: () => mocks.connection,
  useDaemonTranscriptStore: () => mocks.store,
}));

const { useDaemonFollowupSuggestion } = await import(
  './useDaemonFollowupSuggestion.js'
);

describe('useDaemonFollowupSuggestion (#455)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let result: ReturnType<typeof useDaemonFollowupSuggestion> | undefined;

  function HookHost(props: { enabled?: boolean }) {
    result = useDaemonFollowupSuggestion({ enabled: props.enabled });
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    result = undefined;
    mocks.connection.sessionId = 'sess-1';
    mocks.setLastFollowupSuggestion(undefined);
    clearSidechannelFollowupSuggestion();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    clearSidechannelFollowupSuggestion();
    vi.useRealTimers();
  });

  it('pushes the active suggestion when enabled toggles from false to true', async () => {
    mocks.setLastFollowupSuggestion({
      sessionId: 'sess-1',
      promptId: 'p-1',
      suggestion: 'Run the test suite',
    });

    await act(async () => {
      root.render(<HookHost enabled={false} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(result?.followupState.isVisible).toBe(false);

    await act(async () => {
      root.render(<HookHost enabled={true} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(result?.followupState).toMatchObject({
      suggestion: 'Run the test suite',
      isVisible: true,
    });
  });

  it('clears state and sidechannel when sessionId transitions through undefined (clearSession)', async () => {
    publishSidechannelFollowupSuggestion({
      sessionId: 'sess-1',
      promptId: 'p-1',
      suggestion: 'Check git status',
    });

    await act(async () => {
      root.render(<HookHost enabled={true} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(result?.followupState.suggestion).toBe('Check git status');

    mocks.connection.sessionId = undefined;
    await act(async () => {
      root.render(<HookHost enabled={true} />);
    });
    expect(result?.followupState.suggestion).toBeNull();
    expect(getSidechannelFollowupSuggestion()).toBeUndefined();

    // Re-entering the same session with the same promptId should still display a new suggestion.
    mocks.connection.sessionId = 'sess-1';
    await act(async () => {
      publishSidechannelFollowupSuggestion({
        sessionId: 'sess-1',
        promptId: 'p-1',
        suggestion: 'Check git status',
      });
      root.render(<HookHost enabled={true} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(result?.followupState.suggestion).toBe('Check git status');
  });
});
