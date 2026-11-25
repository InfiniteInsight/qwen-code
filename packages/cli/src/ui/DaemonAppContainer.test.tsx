/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useContext } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import { DAEMON_GONE_MESSAGE } from './hooks/daemon/daemon-loss.js';
import {
  DaemonSessionSwitchContext,
  DaemonStreamContext,
} from './hooks/daemon/DaemonStreamContext.js';
import type { DaemonSessionDriver } from './hooks/daemon/useDaemonStream.js';

const sdk = vi.hoisted(() => ({
  load: vi.fn(),
  resume: vi.fn(),
  health: vi.fn(),
}));

let latestDriver: DaemonSessionDriver | null = null;
let latestSwitchDaemonSession: ((sessionId: string) => Promise<void>) | null =
  null;

vi.mock('@qwen-code/sdk', () => ({
  DaemonClient: class {
    health = sdk.health;
  },
  DaemonSessionClient: {
    load: sdk.load,
    createOrAttach: sdk.load,
    resume: sdk.resume,
  },
}));

vi.mock('./AppContainer.js', () => ({
  AppContainer: () => {
    latestDriver = useContext(DaemonStreamContext);
    latestSwitchDaemonSession = useContext(DaemonSessionSwitchContext);
    return null;
  },
}));

import {
  DaemonAppContainer,
  type DaemonAppContainerProps,
} from './DaemonAppContainer.js';

const refused = () =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    }),
  });
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), {
    name: 'DaemonHttpError',
    status,
  });

const baseProps = {
  config: {},
  settings: {},
  version: 'x',
  initializationResult: {},
} as unknown as Omit<
  DaemonAppContainerProps,
  'daemonUrl' | 'daemonToken' | 'sessionId'
>;

function mount(exitDaemonGone: () => void) {
  return render(
    <DaemonAppContainer
      {...baseProps}
      daemonUrl="http://127.0.0.1:9"
      daemonToken="t"
      sessionId="s1"
      exitDaemonGone={exitDaemonGone}
      recheckDelayMs={1}
      flushMs={5}
    />,
  );
}

describe('DaemonAppContainer initial attach failure', () => {
  beforeEach(() => {
    sdk.load.mockReset();
    sdk.resume.mockReset();
    sdk.health.mockReset();
    latestDriver = null;
    latestSwitchDaemonSession = null;
  });

  it('a transport failure with the daemon down prints one line and exits', async () => {
    sdk.load.mockRejectedValue(refused());
    sdk.health.mockRejectedValue(refused());
    const exit = vi.fn();
    const { lastFrame } = mount(exit);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(lastFrame()).toContain(DAEMON_GONE_MESSAGE);
    expect(lastFrame()).not.toContain('Failed to attach');
  });

  it('a 404 for the session exits without a health probe', async () => {
    sdk.load.mockRejectedValue(httpError(404));
    const exit = vi.fn();
    mount(exit);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(sdk.health).not.toHaveBeenCalled();
  });

  it('a 401 keeps the red box and does not exit', async () => {
    sdk.load.mockRejectedValue(httpError(401));
    const exit = vi.fn();
    const { lastFrame } = mount(exit);
    await vi.waitFor(() =>
      expect(lastFrame()).toContain('Failed to attach to daemon'),
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(exit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('HTTP 401');
  });

  it('a transport failure while the daemon answers the re-check keeps the red box', async () => {
    sdk.load.mockRejectedValue(refused());
    sdk.health.mockResolvedValue({ status: 'ok' });
    const exit = vi.fn();
    const { lastFrame } = mount(exit);
    await vi.waitFor(() =>
      expect(lastFrame()).toContain('Failed to attach to daemon'),
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(exit).not.toHaveBeenCalled();
  });

  it('loads the session without liveReplayMode: summary so subagent tool calls are preserved on attach (#526)', async () => {
    sdk.load.mockResolvedValue({ clientId: 'c1' });
    const exit = vi.fn();
    mount(exit);
    await vi.waitFor(() => expect(sdk.load).toHaveBeenCalledTimes(1));
    expect(sdk.load).toHaveBeenCalledWith(expect.anything(), 's1');
  });

  it('falls back to historyPageSize: 500 when unpaged attach hits 413 transcript_page_too_large', async () => {
    const pagedDriver = { clientId: 'c-paged', session: { sessionId: 's1' } };
    sdk.load
      .mockRejectedValueOnce(
        Object.assign(new Error('Transcript page is too large'), {
          name: 'DaemonHttpError',
          status: 413,
          code: 'transcript_page_too_large',
        }),
      )
      .mockResolvedValueOnce(pagedDriver);

    mount(vi.fn());
    await vi.waitFor(() => expect(latestDriver).toBe(pagedDriver));
    expect(sdk.load).toHaveBeenCalledTimes(2);
    expect(sdk.load).toHaveBeenNthCalledWith(1, expect.anything(), 's1');
    expect(sdk.load).toHaveBeenNthCalledWith(2, expect.anything(), 's1', {
      historyPageSize: 500,
    });
  });

  it('aligns config.startNewSession with the attached daemon sessionId on initial attach', async () => {
    const sessionData = { conversation: { messages: [] } };
    const loadSession = vi.fn().mockResolvedValue(sessionData);
    const startNewSession = vi.fn();
    const configWithSession = {
      getSessionId: vi.fn().mockReturnValue('local-ephemeral-id'),
      getSessionService: () => ({ loadSession }),
      startNewSession,
    };
    const attachedDriver = {
      clientId: 'c1',
      session: { sessionId: 'daemon-attached-s1' },
    };
    sdk.load.mockResolvedValue(attachedDriver);

    render(
      <DaemonAppContainer
        {...baseProps}
        config={configWithSession as never}
        daemonUrl="http://127.0.0.1:9"
        daemonToken="t"
        sessionId="daemon-attached-s1"
        exitDaemonGone={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(latestDriver).toBe(attachedDriver));
    expect(loadSession).toHaveBeenCalledWith('daemon-attached-s1');
    expect(startNewSession).toHaveBeenCalledWith(
      'daemon-attached-s1',
      sessionData,
    );
  });

  it('provides DaemonSessionSwitchContext to resume a new session, consume its replay, and detach the previous driver', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-tab-sess-'));
    const sessionFile = join(dir, 'tab.session');
    const prevEnv = process.env['QWEN_RC_TAB_SESSION_FILE'];
    process.env['QWEN_RC_TAB_SESSION_FILE'] = sessionFile;
    try {
      const prevDetach = vi.fn().mockResolvedValue(undefined);
      const initialDriver = {
        clientId: 'c1',
        session: { sessionId: 's1' },
        detach: prevDetach,
      };
      const consumeReplaySnapshot = vi.fn();
      const nextDriver = {
        clientId: 'c2',
        session: { sessionId: 's2' },
        consumeReplaySnapshot,
      };
      sdk.load.mockResolvedValue(initialDriver);
      sdk.resume.mockResolvedValue(nextDriver);

      mount(vi.fn());
      await vi.waitFor(() => expect(latestDriver).toBe(initialDriver));
      await vi.waitFor(async () =>
        expect((await readFile(sessionFile, 'utf8')).trim()).toBe('s1'),
      );
      expect(typeof latestSwitchDaemonSession).toBe('function');

      await act(async () => {
        await latestSwitchDaemonSession!('s2');
      });

      expect(sdk.resume).toHaveBeenCalledWith(expect.anything(), 's2');
      expect(consumeReplaySnapshot).toHaveBeenCalledTimes(1);
      expect(prevDetach).toHaveBeenCalledTimes(1);
      expect(latestDriver).toBe(nextDriver);
      await vi.waitFor(async () =>
        expect((await readFile(sessionFile, 'utf8')).trim()).toBe('s2'),
      );
    } finally {
      if (prevEnv === undefined) {
        delete process.env['QWEN_RC_TAB_SESSION_FILE'];
      } else {
        process.env['QWEN_RC_TAB_SESSION_FILE'] = prevEnv;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
