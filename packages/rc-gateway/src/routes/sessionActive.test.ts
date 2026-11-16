/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { WatchPresence } from '../webpush/watchPresence.js';
import { createSessionActiveRoute } from './sessionActive.js';
import type { HostTabRegistry, HostTabView } from '../hostTabs.js';

interface Captured {
  status?: number;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function fakeRes(): { res: Response; captured: Captured } {
  const captured: Captured = { headers: {} };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    set(name: string, val: string) {
      captured.headers[name.toLowerCase()] = val;
      return res;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, captured };
}

describe('GET /rc/sessions/active (#113)', () => {
  it('returns active: null when no session is watched or open in a host tab', async () => {
    const presence = new WatchPresence();
    const route = createSessionActiveRoute({ watchPresence: presence });
    const { res, captured } = fakeRes();
    await route({} as Request, res, () => {});
    expect(captured.status).toBe(200);
    expect(captured.headers['cache-control']).toBe('no-store');
    expect(captured.body).toEqual({ active: null });
  });

  it('tracks the most recently joined watched session and clears when watchers leave', async () => {
    let clock = 1000;
    const presence = new WatchPresence(() => clock);
    const route = createSessionActiveRoute({ watchPresence: presence });

    const leaveA = presence.join('aaaa1111-1111-1111-1111-111111111111');
    clock = 2000;
    const leaveB = presence.join('bbbb2222-2222-2222-2222-222222222222');

    const r1 = fakeRes();
    await route({} as Request, r1.res, () => {});
    expect(r1.captured.body).toEqual({
      active: {
        sessionId: 'bbbb2222-2222-2222-2222-222222222222',
        source: 'watch',
        watcherCount: 1,
      },
    });

    leaveB();
    const r2 = fakeRes();
    await route({} as Request, r2.res, () => {});
    expect(r2.captured.body).toEqual({
      active: {
        sessionId: 'aaaa1111-1111-1111-1111-111111111111',
        source: 'watch',
        watcherCount: 1,
      },
    });

    leaveA();
    const r3 = fakeRes();
    await route({} as Request, r3.res, () => {});
    expect(r3.captured.body).toEqual({ active: null });
  });

  it('prefers a newer live host terminal tab and includes its cwd', async () => {
    const presence = new WatchPresence(() => 1000);
    presence.join('aaaa1111-1111-1111-1111-111111111111');

    const fakeTabs = {
      list: async (): Promise<HostTabView[]> => [
        {
          tabId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          sessionId: 'dddd4444-4444-4444-4444-444444444444',
          cwd: '/home/evan/projects/qwen-code',
          startedAt: 5000,
          pid: 12345,
          state: 'live',
        },
      ],
    } as unknown as HostTabRegistry;

    const route = createSessionActiveRoute({
      watchPresence: presence,
      hostTabs: fakeTabs,
    });
    const { res, captured } = fakeRes();
    await route({} as Request, res, () => {});
    expect(captured.body).toEqual({
      active: {
        sessionId: 'dddd4444-4444-4444-4444-444444444444',
        cwd: '/home/evan/projects/qwen-code',
        source: 'host_tab',
        watcherCount: 0,
      },
    });
  });
});
