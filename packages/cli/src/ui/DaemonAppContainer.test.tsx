/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { DAEMON_GONE_MESSAGE } from './hooks/daemon/daemon-loss.js';

const sdk = vi.hoisted(() => ({
  load: vi.fn(),
  health: vi.fn(),
}));

vi.mock('@qwen-code/sdk', () => ({
  DaemonClient: class {
    health = sdk.health;
  },
  DaemonSessionClient: {
    load: sdk.load,
    createOrAttach: sdk.load,
  },
}));

vi.mock('./AppContainer.js', () => ({
  AppContainer: () => null,
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
    sdk.health.mockReset();
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
});
