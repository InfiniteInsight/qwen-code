/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import {
  BackgroundAgentResumeService,
  BackgroundTaskRegistry,
  type AgentTaskRegistration,
  type Config,
} from '@qwen-code/qwen-code-core';
import { BackgroundTasksDialog } from './BackgroundTasksDialog.js';
import { BackgroundTasksPill } from './BackgroundTasksPill.js';
import { LiveAgentPanel } from './LiveAgentPanel.js';
import {
  BackgroundTaskViewProvider,
  useBackgroundTaskViewActions,
  useBackgroundTaskViewState,
} from '../../contexts/BackgroundTaskViewContext.js';
import { ConfigContext } from '../../contexts/ConfigContext.js';
import { SettingsContext } from '../../contexts/SettingsContext.js';
import type { LoadedSettings } from '../../../config/settings.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import {
  useDaemonSubagentSync,
  type DaemonSubagentSyncDriver,
  type DaemonSubagentTaskSnapshot,
} from '../../hooks/daemon/use-daemon-subagent-sync.js';
import type { DaemonFrame } from '../../hooks/daemon/projectDaemonEvent.js';

vi.mock('../../hooks/useKeypress.js', () => ({ useKeypress: vi.fn() }));

const mockedUseKeypress = vi.mocked(useKeypress);

/**
 * #259: the subagent controls in the background dialog, end to end through
 * the real registry, the real `useBackgroundTaskView` and the real dialog.
 * In a daemon-attached tab every control reaches the daemon; standalone, an
 * abandoned agent leaves the dialog, the pill and the live panel.
 */

interface LocalService {
  resume: ReturnType<typeof vi.fn>;
  resumeWithOutcome: ReturnType<typeof vi.fn>;
  revive: ReturnType<typeof vi.fn>;
  abandon: ReturnType<typeof vi.fn>;
}

function makeConfig(
  registry: BackgroundTaskRegistry,
  local: LocalService,
): Config {
  const processRegistry = () => ({
    getAll: () => [],
    get: () => undefined,
    setStatusChangeCallback: vi.fn(),
    cancel: vi.fn(),
    requestCancel: vi.fn(),
  });
  const shellRegistry = processRegistry();
  const monitorRegistry = processRegistry();
  const workflowRegistry = {
    list: () => [],
    get: () => undefined,
    setStatusChangeCallback: vi.fn(),
    setApprovalChangeCallback: vi.fn(),
    resolvePendingApproval: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
  };
  const memoryManager = {
    listTasksByType: () => [],
    subscribe: () => () => {},
    cancelTask: vi.fn(),
  };
  return {
    getBackgroundTaskRegistry: () => registry,
    getBackgroundShellRegistry: () => shellRegistry,
    getMonitorRegistry: () => monitorRegistry,
    getWorkflowRunRegistry: () => workflowRegistry,
    getMemoryManager: () => memoryManager,
    getProjectRoot: () => '/tmp/project',
    getMaxSubagentDepth: () => 5,
    getIdeMode: () => false,
    isTrustedFolder: () => true,
    resumeBackgroundAgent: local.resume,
    resumeBackgroundAgentWithOutcome: local.resumeWithOutcome,
    reviveCompletedBackgroundAgent: local.revive,
    abandonBackgroundAgent: local.abandon,
  } as unknown as Config;
}

function makeLocal(): LocalService {
  return {
    resume: vi.fn(),
    resumeWithOutcome: vi.fn(),
    revive: vi.fn(),
    abandon: vi.fn().mockReturnValue(false),
  };
}

interface Probe {
  actions: ReturnType<typeof useBackgroundTaskViewActions>;
  state: ReturnType<typeof useBackgroundTaskViewState>;
}

/** Renders the provider, dialog, pill and live panel over `config`. */
function renderView(config: Config, extra?: ReactNode) {
  const handlers: Array<(key: Record<string, unknown>) => void> = [];
  mockedUseKeypress.mockImplementation((cb, opts) => {
    if (opts?.isActive !== false) handlers.push(cb as never);
  });
  const probe: { current: Probe | null } = { current: null };
  function ProbeView() {
    probe.current = {
      actions: useBackgroundTaskViewActions(),
      state: useBackgroundTaskViewState(),
    };
    return null;
  }
  const view = render(
    <SettingsContext.Provider
      value={{ merged: { general: {} } } as LoadedSettings}
    >
      <ConfigContext.Provider value={config}>
        <BackgroundTaskViewProvider config={config}>
          {extra}
          <ProbeView />
          <LiveAgentPanel width={80} />
          <BackgroundTasksPill />
          <BackgroundTasksDialog
            availableTerminalHeight={30}
            terminalWidth={80}
          />
        </BackgroundTaskViewProvider>
      </ConfigContext.Provider>
    </SettingsContext.Provider>,
  );
  return {
    probe,
    lastFrame: view.lastFrame,
    unmount: view.unmount,
    // Only the most recent closure is current (see BackgroundTasksDialog.test).
    pressKey(key: Record<string, unknown>) {
      act(() => {
        handlers.at(-1)?.(key);
      });
    },
    type(text: string) {
      for (const sequence of text) {
        act(() => {
          handlers.at(-1)?.({ sequence, name: sequence });
        });
      }
    },
    call(fn: () => void) {
      act(() => fn());
    },
  };
}

function daemonAgent(
  overrides: Partial<DaemonSubagentTaskSnapshot>,
): DaemonSubagentTaskSnapshot {
  return {
    kind: 'agent',
    id: 'agent-paused',
    description: 'Paused researcher',
    subagentType: 'researcher',
    status: 'paused',
    startTime: 1_000,
    isBackgrounded: true,
    ...overrides,
  };
}

function setupAttached(roster: DaemonSubagentTaskSnapshot[]) {
  const registry = new BackgroundTaskRegistry();
  const local = makeLocal();
  const config = makeConfig(registry, local);
  let current = roster;
  const client = {
    cancelSubagentSession: vi.fn().mockResolvedValue({ cancelled: true }),
    messageSubagentSession: vi.fn().mockResolvedValue({ delivered: true }),
    resumeSubagentSession: vi
      .fn()
      .mockResolvedValue({ outcome: 'resumed', status: 'running' }),
    abandonSubagentSession: vi
      .fn()
      .mockResolvedValue({ outcome: 'abandoned', status: 'cancelled' }),
  };
  const driver: DaemonSubagentSyncDriver = {
    session: { sessionId: 'sess-1' },
    client,
    agents: vi.fn(async () => ({ tasks: current })),
  };
  const frame: { current: ((f: DaemonFrame) => void) | null } = {
    current: null,
  };
  function Sync() {
    frame.current = useDaemonSubagentSync(config, driver);
    return null;
  }
  const view = renderView(config, <Sync />);
  return {
    ...view,
    registry,
    local,
    client,
    driver,
    setRoster(next: DaemonSubagentTaskSnapshot[]) {
      current = next;
    },
    taskChanged() {
      act(() => frame.current?.({ type: 'task_changed', data: {} }));
    },
    selectAgent(agentId: string) {
      const index = view.probe.current!.state.entries.findIndex(
        (entry) => entry.kind === 'agent' && entry.agentId === agentId,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      view.call(() => view.probe.current!.actions.setSelectedIndex(index));
    },
  };
}

const agentIds = (probe: { current: Probe | null }) =>
  probe.current!.state.entries.flatMap((entry) =>
    entry.kind === 'agent' ? [entry.agentId] : [],
  );

function expectLocalServiceUntouched(local: LocalService) {
  expect(local.resume).not.toHaveBeenCalled();
  expect(local.resumeWithOutcome).not.toHaveBeenCalled();
  expect(local.revive).not.toHaveBeenCalled();
  expect(local.abandon).not.toHaveBeenCalled();
}

describe('subagent controls in a daemon-attached tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function attachedWithPaused(extra: DaemonSubagentTaskSnapshot[] = []) {
    const h = setupAttached([daemonAgent({}), ...extra]);
    await vi.waitFor(() =>
      expect(h.registry.get('agent-paused')?.status).toBe('paused'),
    );
    h.call(() => h.probe.current!.actions.openDialog());
    h.selectAgent('agent-paused');
    return h;
  }

  it('r resumes a mirrored paused agent on the daemon, never locally', async () => {
    const h = await attachedWithPaused();

    h.pressKey({ sequence: 'r' });

    await vi.waitFor(() =>
      expect(h.client.resumeSubagentSession).toHaveBeenCalledWith(
        'sess-1',
        'agent-paused',
        undefined,
      ),
    );
    expectLocalServiceUntouched(h.local);
  });

  it('x abandons a mirrored paused agent on the daemon and drops it from the dialog', async () => {
    const h = await attachedWithPaused();
    expect(agentIds(h.probe)).toEqual(['agent-paused']);

    h.pressKey({ sequence: 'x' });

    await vi.waitFor(() =>
      expect(h.client.abandonSubagentSession).toHaveBeenCalledWith(
        'sess-1',
        'agent-paused',
      ),
    );
    await vi.waitFor(() => expect(agentIds(h.probe)).toEqual([]));
    expect(h.registry.get('agent-paused')).toBeUndefined();
    expectLocalServiceUntouched(h.local);

    // A roster fetched before the daemon applied the abandon cannot bring it
    // back.
    h.taskChanged();
    await vi.waitFor(() => expect(h.driver.agents).toHaveBeenCalledTimes(2));
    expect(agentIds(h.probe)).toEqual([]);
  });

  it('a message to a mirrored paused agent resumes it on the daemon with that message', async () => {
    const h = await attachedWithPaused();

    h.pressKey({ sequence: 'm' });
    h.type('keep going');
    h.pressKey({ name: 'return' });

    await vi.waitFor(() =>
      expect(h.client.resumeSubagentSession).toHaveBeenCalledWith(
        'sess-1',
        'agent-paused',
        'keep going',
      ),
    );
    expect(h.client.messageSubagentSession).not.toHaveBeenCalled();
    expectLocalServiceUntouched(h.local);
    await vi.waitFor(() =>
      expect(h.lastFrame()).toContain('Message sent to agent.'),
    );
  });

  it('a message to a mirrored running agent still goes to the daemon message route', async () => {
    const h = setupAttached([
      daemonAgent({
        id: 'agent-running',
        description: 'Running researcher',
        status: 'running',
      }),
    ]);
    await vi.waitFor(() =>
      expect(h.registry.get('agent-running')?.status).toBe('running'),
    );
    h.call(() => h.probe.current!.actions.openDialog());
    h.selectAgent('agent-running');

    h.pressKey({ sequence: 'm' });
    h.type('check refresh tokens');
    h.pressKey({ name: 'return' });

    await vi.waitFor(() =>
      expect(h.client.messageSubagentSession).toHaveBeenCalledWith(
        'sess-1',
        'agent-running',
        'check refresh tokens',
      ),
    );
    expect(h.client.resumeSubagentSession).not.toHaveBeenCalled();
    expectLocalServiceUntouched(h.local);
  });

  it('shows the reason the daemon refused a resume', async () => {
    const h = await attachedWithPaused();
    h.client.resumeSubagentSession.mockResolvedValueOnce({
      outcome: 'refused',
      code: 'capacity_full',
      reason: 'capacity is full',
      status: 'paused',
    });

    h.pressKey({ sequence: 'r' });

    await vi.waitFor(() =>
      expect(h.lastFrame()).toContain(
        'Could not resume agent: capacity is full',
      ),
    );
    expect(agentIds(h.probe)).toEqual(['agent-paused']);
  });

  it('shows the reason the daemon refused an abandon, and keeps the agent', async () => {
    const h = await attachedWithPaused();
    h.client.abandonSubagentSession.mockResolvedValueOnce({
      outcome: 'refused',
      code: 'not_paused',
      reason: 'it is running now',
      status: 'running',
    });

    h.pressKey({ sequence: 'x' });

    await vi.waitFor(() =>
      expect(h.lastFrame()).toContain(
        'Could not abandon agent: it is running now',
      ),
    );
    expect(h.registry.get('agent-paused')).toBeDefined();
  });

  it('shows a transport failure on resume instead of swallowing it', async () => {
    const h = await attachedWithPaused();
    h.client.resumeSubagentSession.mockRejectedValueOnce(
      new Error('daemon unreachable'),
    );

    h.pressKey({ sequence: 'r' });

    await vi.waitFor(() =>
      expect(h.lastFrame()).toContain(
        'Could not resume agent: daemon unreachable',
      ),
    );
  });

  it('drops a mirrored paused agent the daemon roster no longer lists', async () => {
    const running = daemonAgent({
      id: 'agent-running',
      description: 'Running researcher',
      status: 'running',
    });
    const h = setupAttached([daemonAgent({}), running]);
    await vi.waitFor(() =>
      expect(h.registry.get('agent-paused')?.status).toBe('paused'),
    );

    // Abandoned elsewhere (the phone, or task_stop on the daemon).
    h.setRoster([running]);
    h.taskChanged();

    await vi.waitFor(() =>
      expect(h.registry.get('agent-paused')).toBeUndefined(),
    );
    expect(h.registry.get('agent-running')?.status).toBe('running');
  });
});

describe('abandoning a paused agent in the standalone TUI', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abandon-standalone-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('removes it from the dialog entries, the pill and the live panel', async () => {
    const registry = new BackgroundTaskRegistry();
    const local = makeLocal();
    const config = makeConfig(registry, local);
    // The real resume service: it marks the sidecar and the registry drops
    // the entry.
    const service = new BackgroundAgentResumeService(config);
    local.abandon.mockImplementation((agentId: string) =>
      service.abandonBackgroundAgent(agentId),
    );
    const sessionDir = path.join(projectDir, 'subagents', 'session-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const metaPath = path.join(sessionDir, 'agent-agent-local.meta.json');
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        agentId: 'agent-local',
        agentType: 'researcher',
        description: 'Interrupted local research',
        parentSessionId: 'session-1',
        parentAgentId: null,
        createdAt: '2026-11-12T00:00:00.000Z',
        status: 'running',
        isBackgrounded: true,
      }),
    );
    registry.register({
      agentId: 'agent-local',
      description: 'Interrupted local research',
      subagentType: 'researcher',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: path.join(sessionDir, 'agent-agent-local.jsonl'),
      metaPath,
    } as AgentTaskRegistration);

    const h = renderView(config);
    await vi.waitFor(() => {
      expect(agentIds(h.probe)).toEqual(['agent-local']);
      expect(h.lastFrame()).toContain('1 local agent paused');
      expect(h.lastFrame()).toContain('Interrupted local research');
    });

    h.call(() => h.probe.current!.actions.openDialog());
    h.pressKey({ sequence: 'x' });
    h.call(() => h.probe.current!.actions.closeDialog());

    await vi.waitFor(() => expect(agentIds(h.probe)).toEqual([]));
    expect(local.abandon).toHaveBeenCalledWith('agent-local');
    expect(registry.get('agent-local')).toBeUndefined();
    const frame = h.lastFrame() ?? '';
    expect(frame).not.toContain('paused');
    expect(frame).not.toContain('Interrupted local research');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.status).toBe('cancelled');
    expect(typeof meta.abandonedAt).toBe('string');
  });

  it('shows an abandon that throws instead of dropping the error', async () => {
    const registry = new BackgroundTaskRegistry();
    const local = makeLocal();
    local.abandon.mockImplementation(() => {
      throw new Error('disk is read-only');
    });
    const config = makeConfig(registry, local);
    registry.register({
      agentId: 'agent-local',
      description: 'Interrupted local research',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: '/tmp/agent-local.jsonl',
    } as AgentTaskRegistration);
    const h = renderView(config);
    await vi.waitFor(() => expect(agentIds(h.probe)).toEqual(['agent-local']));

    h.call(() => h.probe.current!.actions.openDialog());
    h.pressKey({ sequence: 'x' });

    await vi.waitFor(() =>
      expect(h.lastFrame()).toContain(
        'Could not abandon agent: disk is read-only',
      ),
    );
    expect(registry.get('agent-local')?.status).toBe('paused');
  });

  it('shows why a local resume failed', async () => {
    const registry = new BackgroundTaskRegistry();
    const local = makeLocal();
    local.resumeWithOutcome.mockResolvedValue({
      resumed: false,
      code: 'capacity_full',
      reason: 'all slots are busy',
    });
    const config = makeConfig(registry, local);
    registry.register({
      agentId: 'agent-local',
      description: 'Interrupted local research',
      isBackgrounded: true,
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      outputFile: '/tmp/agent-local.jsonl',
    } as AgentTaskRegistration);
    const h = renderView(config);
    await vi.waitFor(() => expect(agentIds(h.probe)).toEqual(['agent-local']));

    h.call(() => h.probe.current!.actions.openDialog());
    h.pressKey({ sequence: 'r' });

    await vi.waitFor(() =>
      expect(h.lastFrame()).toContain(
        'Could not resume agent: all slots are busy',
      ),
    );
    expect(local.resumeWithOutcome).toHaveBeenCalledWith(
      'agent-local',
      undefined,
    );
  });
});
