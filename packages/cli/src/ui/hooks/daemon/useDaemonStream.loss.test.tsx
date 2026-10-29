/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { HistoryItemWithoutId } from '../../types.js';
import {
  useDaemonStream,
  type DaemonLossHandling,
  type DaemonSessionDriver,
} from './useDaemonStream.js';
import { DAEMON_GONE_MESSAGE } from './daemon-loss.js';
import type { DaemonFrame } from './projectDaemonEvent.js';

type Step =
  | { throws: unknown }
  | { frames: DaemonFrame[]; then: 'end' | 'hang' };

/** A driver whose Nth `events()` call plays the Nth scripted step. */
function scriptedDriver(
  steps: Step[],
  prompt?: () => Promise<unknown>,
): DaemonSessionDriver & { eventsCalls: () => number } {
  let calls = 0;
  return {
    clientId: 'me',
    eventsCalls: () => calls,
    async *events({ signal } = {}) {
      const step = steps[Math.min(calls, steps.length - 1)]!;
      calls += 1;
      if ('throws' in step) throw step.throws;
      for (const f of step.frames) yield f;
      if (step.then === 'end') return;
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    prompt: prompt ?? (async () => ({ stopReason: 'end_turn' })),
    async cancel() {},
    async respondToSessionPermission() {
      return true;
    },
  } as DaemonSessionDriver & { eventsCalls: () => number };
}

const refused = () =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
      code: 'ECONNREFUSED',
    }),
  });

const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), {
    name: 'DaemonHttpError',
    status,
  });

function setup(driver: DaemonSessionDriver, probe: () => Promise<unknown>) {
  const added: HistoryItemWithoutId[] = [];
  const order: string[] = [];
  const addItem = vi.fn((item: HistoryItemWithoutId) => {
    added.push(item);
    order.push(`add:${item.type}`);
    return added.length;
  });
  const exitDaemonGone = vi.fn(() => {
    order.push('exit');
  });
  const probeHealth = vi.fn(probe);
  const loss: DaemonLossHandling = {
    probeHealth,
    exitDaemonGone,
    sleep: async () => {},
  };
  const hook = renderHook(() => useDaemonStream(driver, addItem, loss));
  return { ...hook, added, order, exitDaemonGone, probeHealth };
}

const down = async () => {
  throw refused();
};
const up = async () => ({ status: 'ok' });

describe('useDaemonStream daemon loss', () => {
  it('ECONNREFUSED on subscribe with a failing health probe: notice, then exit', async () => {
    const driver = scriptedDriver([{ throws: refused() }]);
    const t = setup(driver, down);
    await waitFor(() => expect(t.exitDaemonGone).toHaveBeenCalledTimes(1));
    expect(t.probeHealth).toHaveBeenCalledTimes(1);
    expect(t.added).toContainEqual({ type: 'info', text: DAEMON_GONE_MESSAGE });
    // The line is added before the exit, never after.
    expect(t.order.indexOf('add:info')).toBeLessThan(t.order.indexOf('exit'));
    expect(t.result.current.initError).toBeNull();
    // It stops subscribing once the tab is leaving.
    expect(driver.eventsCalls()).toBe(1);
  });

  it('two ECONNREFUSED in a row with a failing probe: exits once', async () => {
    const driver = scriptedDriver([
      { throws: refused() },
      { throws: refused() },
    ]);
    const t = setup(driver, down);
    await waitFor(() => expect(t.exitDaemonGone).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(t.exitDaemonGone).toHaveBeenCalledTimes(1);
    expect(t.added.filter((i) => i.type === 'info')).toHaveLength(1);
  });

  it('a blip the daemon recovers from (probe answers) re-subscribes, no exit', async () => {
    const driver = scriptedDriver([
      { throws: refused() },
      { frames: [], then: 'hang' },
    ]);
    const t = setup(driver, up);
    await waitFor(() => expect(driver.eventsCalls()).toBe(2));
    expect(t.probeHealth).toHaveBeenCalledTimes(1);
    expect(t.exitDaemonGone).not.toHaveBeenCalled();
    expect(t.result.current.initError).toBeNull();
  });

  it('a live daemon whose stream keeps failing shows the error, no exit', async () => {
    const driver = scriptedDriver([{ throws: refused() }]);
    const t = setup(driver, up);
    await waitFor(() =>
      expect(t.result.current.initError).toMatch(/fetch failed/),
    );
    expect(t.exitDaemonGone).not.toHaveBeenCalled();
    expect(driver.eventsCalls()).toBe(5);
  });

  it('an idle close re-subscribes and does not exit', async () => {
    const driver = scriptedDriver([
      { frames: [], then: 'end' },
      { frames: [], then: 'hang' },
    ]);
    const t = setup(driver, down);
    await waitFor(() => expect(driver.eventsCalls()).toBe(2), {
      timeout: 3000,
    });
    expect(t.exitDaemonGone).not.toHaveBeenCalled();
    expect(t.probeHealth).not.toHaveBeenCalled();
    expect(t.added.filter((i) => i.type === 'info')).toHaveLength(0);
  });

  it('a session_died frame exits without any probe', async () => {
    const driver = scriptedDriver([
      {
        frames: [
          { type: 'session_died', data: { sessionId: 's1', reason: 'crash' } },
        ],
        then: 'hang',
      },
    ]);
    const t = setup(driver, up);
    await waitFor(() => expect(t.exitDaemonGone).toHaveBeenCalledTimes(1));
    expect(t.probeHealth).not.toHaveBeenCalled();
    expect(t.added).toContainEqual({ type: 'info', text: DAEMON_GONE_MESSAGE });
  });

  it('a 404 on re-subscribe exits without any probe', async () => {
    const driver = scriptedDriver([
      { frames: [], then: 'end' },
      { throws: httpError(404) },
    ]);
    const t = setup(driver, up);
    await waitFor(() => expect(t.exitDaemonGone).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    expect(t.probeHealth).not.toHaveBeenCalled();
  });

  it.each([401, 403])('%i is fatal: error shown, no exit', async (status) => {
    const driver = scriptedDriver([{ throws: httpError(status) }]);
    const t = setup(driver, down);
    await waitFor(() =>
      expect(t.result.current.initError).toBe(`HTTP ${status}`),
    );
    expect(t.exitDaemonGone).not.toHaveBeenCalled();
    expect(t.probeHealth).not.toHaveBeenCalled();
    expect(driver.eventsCalls()).toBe(1);
  });

  it('"already active" still backs off and retries', async () => {
    const driver = scriptedDriver([
      { throws: new Error('Another event subscription is already active.') },
      { frames: [], then: 'hang' },
    ]);
    const t = setup(driver, down);
    await waitFor(() => expect(driver.eventsCalls()).toBe(2));
    expect(t.exitDaemonGone).not.toHaveBeenCalled();
    expect(t.result.current.initError).toBeNull();
  });

  it('without loss handling, a transport error keeps the old behaviour', async () => {
    const driver = scriptedDriver([{ throws: refused() }]);
    const added: HistoryItemWithoutId[] = [];
    const { result } = renderHook(() =>
      useDaemonStream(driver, (item) => added.push(item)),
    );
    await waitFor(() =>
      expect(result.current.initError).toMatch(/fetch failed/),
    );
    expect(added).toEqual([]);
  });

  describe('prompt in flight', () => {
    it('prompt() ECONNREFUSED with the daemon down: exits', async () => {
      const driver = scriptedDriver(
        [{ frames: [], then: 'hang' }],
        async () => {
          throw refused();
        },
      );
      const t = setup(driver, down);
      await act(async () => {
        await t.result.current.submitQuery('hi');
      });
      expect(t.exitDaemonGone).toHaveBeenCalledTimes(1);
    });

    it('prompt() error the daemon recovers from: rethrown, no exit', async () => {
      const driver = scriptedDriver(
        [{ frames: [], then: 'hang' }],
        async () => {
          throw refused();
        },
      );
      const t = setup(driver, up);
      await expect(
        act(async () => {
          await t.result.current.submitQuery('hi');
        }),
      ).rejects.toThrow(/fetch failed/);
      expect(t.exitDaemonGone).not.toHaveBeenCalled();
    });

    it('a prompt 401 is rethrown, no probe, no exit', async () => {
      const driver = scriptedDriver(
        [{ frames: [], then: 'hang' }],
        async () => {
          throw httpError(401);
        },
      );
      const t = setup(driver, down);
      await expect(
        act(async () => {
          await t.result.current.submitQuery('hi');
        }),
      ).rejects.toThrow('HTTP 401');
      expect(t.probeHealth).not.toHaveBeenCalled();
      expect(t.exitDaemonGone).not.toHaveBeenCalled();
    });

    it('SSE death and prompt death together exit once', async () => {
      const driver = scriptedDriver([{ throws: refused() }], async () => {
        throw refused();
      });
      const t = setup(driver, down);
      await act(async () => {
        await t.result.current.submitQuery('hi');
      });
      await waitFor(() => expect(t.exitDaemonGone).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 30));
      expect(t.exitDaemonGone).toHaveBeenCalledTimes(1);
    });
  });
});
