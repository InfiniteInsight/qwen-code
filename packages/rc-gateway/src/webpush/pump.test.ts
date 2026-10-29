/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { DaemonClient, type DaemonEvent } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { SessionEventPump } from './pump.js';
import { PolicyEnforcer } from '../policy/enforcer.js';
import type { Policy } from '../policy/loader.js';

interface Dispatched {
  e: { type: string; data: unknown };
  ctx: { sessionId: string; sessionName?: string };
}

/** Fake notifier matching the PushNotifier.notify shape; collects calls. */
function fakeNotifier(collected: Dispatched[]) {
  return {
    notify: async (
      e: { type: string; data: unknown },
      ctx: { sessionId: string; sessionName?: string },
    ): Promise<void> => {
      collected.push({ e, ctx });
    },
  };
}

/** Poll a collected array until predicate holds or a deadline elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

let stub: StubDaemon | undefined;
let pump: SessionEventPump | undefined;

afterEach(async () => {
  // Stop the pump BEFORE closing the stub: a live pump with reconnectMs:0 would
  // hot-loop failed connects against a closed stub.
  if (pump) await pump.stop();
  if (stub) await stub.close();
  pump = undefined;
  stub = undefined;
});

describe('SessionEventPump', () => {
  it('dispatches a permission_request for a listed session', async () => {
    const collected: Dispatched[] = [];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      // holdOpenMs parks the loop in `for await` after the single frame so it
      // does not hot-reconnect and re-dispatch.
      holdOpenMs: 2000,
      frames: [
        { id: 7, type: 'permission_request', data: { requestId: 'r1' } },
      ],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
    });
    await pump.start();

    const got = await waitFor(() =>
      collected.some((d) => d.e.type === 'permission_request'),
    );
    expect(got).toBe(true);
    const hit = collected.find((d) => d.e.type === 'permission_request')!;
    expect(hit.ctx.sessionId).toBe('s1');
  });

  it('aborts the loop when a session is removed from the list', async () => {
    const collected: Dispatched[] = [];
    const sessions = [{ sessionId: 's1', workspaceCwd: '/w' }];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions,
      holdOpenMs: 2000,
      frames: [{ id: 1, type: 'permission_request', data: {} }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
    });
    await pump.start();

    expect(await waitFor(() => collected.length >= 1)).toBe(true);

    // Remove the session; the next poll tick must abort its loop.
    sessions.length = 0;
    const aborted = await waitFor(
      () => stub!.eventsAbortedByClient === true,
      2000,
    );
    expect(aborted).toBe(true);

    // No additional dispatch after removal/abort (the parked loop emitted once).
    const countAfter = collected.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(collected.length).toBe(countAfter);
  });

  it('start() resolves and dispatches nothing when capabilities fails', async () => {
    const collected: Dispatched[] = [];
    stub = await startStubDaemon({
      capabilitiesStatus: 500,
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      frames: [{ id: 1, type: 'permission_request', data: {} }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
    });
    await pump.start(); // must not throw

    await new Promise((r) => setTimeout(r, 150));
    expect(collected.length).toBe(0);
  });

  it('dispatches nothing for an empty session list and stops cleanly', async () => {
    const collected: Dispatched[] = [];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
    });
    await pump.start();

    await new Promise((r) => setTimeout(r, 150));
    expect(collected.length).toBe(0);
    await pump.stop();
  });

  it('stop() aborts loops: no dispatches after stop', async () => {
    const collected: Dispatched[] = [];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      holdOpenMs: 2000,
      frames: [{ id: 1, type: 'permission_request', data: {} }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
    });
    await pump.start();
    expect(await waitFor(() => collected.length >= 1)).toBe(true);

    await pump.stop();
    const countAfter = collected.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(collected.length).toBe(countAfter);
  });

  it('enforcer auto-handles a denied permission_request: notifier NOT called', async () => {
    const collected: Dispatched[] = [];
    const denyBash: Policy = {
      defaults: { action: 'prompt', requireScope: 'approve' },
      rules: [{ id: 'deny-bash', match: { tool: 'execute' }, action: 'deny' }],
    };
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      holdOpenMs: 2000,
      permissionStatus: 200, // vote accepted → auto-handled
      frames: [
        {
          id: 7,
          type: 'permission_request',
          data: {
            requestId: 'r1',
            toolCall: {
              toolCallId: 'tc1',
              title: 'humanized',
              kind: 'execute',
              rawInput: {},
            },
            options: [{ optionId: 'ok' }],
          },
        },
      ],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const enforcer = new PolicyEnforcer(daemon, denyBash);
    const dispatched: string[] = [];
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
      enforcer,
      onDispatch: (id) => dispatched.push(id),
    });
    await pump.start();

    // The event is auto-handled → onDispatch fires but notifier.notify does NOT.
    expect(await waitFor(() => dispatched.length >= 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(collected).toHaveLength(0);
  });

  it('empty-policy enforcer falls through: notifier IS called', async () => {
    const collected: Dispatched[] = [];
    const emptyPolicy: Policy = {
      defaults: { action: 'prompt', requireScope: 'approve' },
      rules: [],
    };
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      holdOpenMs: 2000,
      frames: [
        {
          id: 7,
          type: 'permission_request',
          data: {
            requestId: 'r1',
            toolCall: {
              toolCallId: 'tc1',
              title: 'humanized',
              kind: 'execute',
              rawInput: {},
            },
            options: [{ optionId: 'ok' }],
          },
        },
      ],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const enforcer = new PolicyEnforcer(daemon, emptyPolicy);
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
      enforcer,
    });
    await pump.start();

    const got = await waitFor(() =>
      collected.some((d) => d.e.type === 'permission_request'),
    );
    expect(got).toBe(true);
  });

  describe('onEvent and permission_request (issue #166)', () => {
    const permFrame = {
      id: 7,
      type: 'permission_request',
      data: {
        requestId: 'r1',
        toolCall: {
          toolCallId: 'tc1',
          title: 'humanized',
          kind: 'execute',
          rawInput: {},
        },
        options: [{ optionId: 'ok', kind: 'allow_once' }],
      },
    };

    async function runWith(
      policy: Policy | undefined,
    ): Promise<{ seen: string[]; collected: Dispatched[] }> {
      const collected: Dispatched[] = [];
      const seen: string[] = [];
      stub = await startStubDaemon({
        workspaceCwd: '/w',
        sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
        holdOpenMs: 2000,
        permissionStatus: 200,
        frames: [permFrame],
      });
      const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
      const dispatched: string[] = [];
      pump = new SessionEventPump(daemon, fakeNotifier(collected), {
        pollMs: 20,
        reconnectMs: 0,
        sleep: async () => {},
        ...(policy ? { enforcer: new PolicyEnforcer(daemon, policy) } : {}),
        onEvent: (_id, ev) => seen.push(ev.type),
        onDispatch: (id) => dispatched.push(id),
      });
      await pump.start();
      expect(await waitFor(() => dispatched.length >= 1)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      return { seen, collected };
    }

    it('does not deliver a policy-auto-approved permission_request to onEvent', async () => {
      const { seen, collected } = await runWith({
        defaults: { action: 'prompt', requireScope: 'approve' },
        rules: [{ id: 'ok', match: { tool: 'execute' }, action: 'allow' }],
      });
      expect(seen).not.toContain('permission_request');
      expect(collected).toHaveLength(0);
    });

    it('does not deliver a policy-auto-denied permission_request to onEvent', async () => {
      const { seen } = await runWith({
        defaults: { action: 'prompt', requireScope: 'approve' },
        rules: [{ id: 'no', match: { tool: 'execute' }, action: 'deny' }],
      });
      expect(seen).not.toContain('permission_request');
    });

    it('delivers a prompt-decision permission_request to onEvent exactly once', async () => {
      const { seen } = await runWith({
        defaults: { action: 'prompt', requireScope: 'approve' },
        rules: [],
      });
      expect(seen.filter((t) => t === 'permission_request')).toHaveLength(1);
    });

    it('delivers permission_request to onEvent immediately when no enforcer is wired', async () => {
      const { seen } = await runWith(undefined);
      expect(seen.filter((t) => t === 'permission_request')).toHaveLength(1);
    });
  });

  it('updates lastEventId from numeric event ids', async () => {
    const collected: Dispatched[] = [];
    const onDispatchSeen: Array<{ id: string; event: DaemonEvent }> = [];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      holdOpenMs: 2000,
      frames: [{ id: 42, type: 'permission_request', data: {} }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(daemon, fakeNotifier(collected), {
      pollMs: 20,
      reconnectMs: 0,
      sleep: async () => {},
      onDispatch: (id, event) => onDispatchSeen.push({ id, event }),
    });
    await pump.start();
    expect(await waitFor(() => onDispatchSeen.length >= 1)).toBe(true);
    expect(onDispatchSeen[0].event.id).toBe(42);
    expect(onDispatchSeen[0].id).toBe('s1');
  });

  describe('idle-edge detection (onSessionIdle)', () => {
    it('fires once with (sessionId, workspaceCwd) on a hasActivePrompt true→false transition', async () => {
      const idle: Array<{ id: string; cwd: string }> = [];
      const sessions = [
        { sessionId: 's1', workspaceCwd: '/w', hasActivePrompt: true },
      ];
      stub = await startStubDaemon({ workspaceCwd: '/w', sessions });
      const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
      pump = new SessionEventPump(daemon, fakeNotifier([]), {
        pollMs: 20,
        reconnectMs: 0,
        sleep: async () => {},
        onSessionIdle: (id, cwd) => idle.push({ id, cwd }),
      });
      await pump.start();

      // Seeded as active across at least one tick, no edge yet.
      await new Promise((r) => setTimeout(r, 80));
      expect(idle.length).toBe(0);

      // The prompt finishes → next poll sees the falling edge → fire ONCE.
      sessions[0].hasActivePrompt = false;
      expect(await waitFor(() => idle.length >= 1)).toBe(true);
      expect(idle[0]).toEqual({ id: 's1', cwd: '/w' });

      // Stays idle across further ticks → no repeat fire.
      await new Promise((r) => setTimeout(r, 80));
      expect(idle.length).toBe(1);
    });

    it('does NOT fire for a session first observed already idle (no false startup storm)', async () => {
      const idle: string[] = [];
      stub = await startStubDaemon({
        workspaceCwd: '/w',
        sessions: [
          { sessionId: 's1', workspaceCwd: '/w', hasActivePrompt: false },
        ],
      });
      const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
      pump = new SessionEventPump(daemon, fakeNotifier([]), {
        pollMs: 20,
        reconnectMs: 0,
        sleep: async () => {},
        onSessionIdle: (id) => idle.push(id),
      });
      await pump.start();
      await new Promise((r) => setTimeout(r, 120));
      expect(idle).toEqual([]);
    });

    it('a throwing idle handler never breaks reconcile (loops still tracked)', async () => {
      const sessions = [
        { sessionId: 's1', workspaceCwd: '/w', hasActivePrompt: true },
      ];
      stub = await startStubDaemon({ workspaceCwd: '/w', sessions });
      const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
      pump = new SessionEventPump(daemon, fakeNotifier([]), {
        pollMs: 20,
        reconnectMs: 0,
        sleep: async () => {},
        onSessionIdle: () => {
          throw new Error('handler boom');
        },
      });
      await pump.start();
      await new Promise((r) => setTimeout(r, 60));
      sessions[0].hasActivePrompt = false;
      // The throw is swallowed; the pump keeps polling and stops cleanly.
      await new Promise((r) => setTimeout(r, 80));
      await pump.stop(); // must not throw
    });
  });

  describe('a session the daemon refuses to stream (#59)', () => {
    /**
     * A `DaemonClient` stand-in that counts subscription attempts per session.
     * Unlike the stub daemon, this one keeps LISTING a session it refuses to
     * stream — the exact shape of the live incident: `GET /sessions` returns the
     * dead id, `GET /events` answers 404, so every reconcile re-spawns a loop
     * that only earns another refused request.
     */
    function countingDaemon(opts: {
      sessions: () => Array<{ sessionId: string }>;
      refuse?: (sessionId: string, attempt: number) => Error | undefined;
      frames?: DaemonEvent[];
    }): { client: DaemonClient; attempts: (id: string) => number } {
      const counts = new Map<string, number>();
      const client = {
        capabilities: async () => ({ workspaceCwd: '/w' }),
        listWorkspaceSessions: async () =>
          opts.sessions().map((s) => ({ ...s, workspaceCwd: '/w' })),
        subscribeEvents: (
          sessionId: string,
          sub?: { signal?: AbortSignal },
        ) => {
          const attempt = (counts.get(sessionId) ?? 0) + 1;
          counts.set(sessionId, attempt);
          const err = opts.refuse?.(sessionId, attempt);
          if (err) throw err;
          return heldStream(
            opts.frames ?? [{ type: 'session_update' }],
            sub?.signal,
          );
        },
      } as unknown as DaemonClient;
      return {
        client,
        attempts: (id) => counts.get(id) ?? 0,
      };
    }

    /** The daemon's own 404 for an id it has no record of (see daemonPool). */
    const goneError = (id: string): Error =>
      Object.assign(new Error(`Unknown session: ${id}`), { status: 404 });

    /**
     * Emits `frames`, then stays subscribed until the subscription is aborted —
     * what a real SSE connection does. Returning after the last frame instead
     * would send the loop straight into a backoff-free reconnect (these tests
     * inject `reconnectMs: 0` and a no-op sleep), spinning without real I/O.
     */
    async function* heldStream(
      frames: DaemonEvent[],
      signal?: AbortSignal,
    ): AsyncIterable<DaemonEvent> {
      for (const f of frames) yield f;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }

    it('refuses once and stops re-subscribing while the id stays listed', async () => {
      const dispatched: string[] = [];
      const { client, attempts } = countingDaemon({
        sessions: () => [{ sessionId: 's1' }, { sessionId: 's2' }],
        // s1 is a dead id the daemon still lists; s2 is healthy.
        refuse: (id) => (id === 's1' ? goneError(id) : undefined),
      });
      pump = new SessionEventPump(client, fakeNotifier([]), {
        pollMs: 20,
        reconnectMs: 0,
        sleep: async () => {},
        onDispatch: (id) => dispatched.push(id),
      });
      await pump.start();
      // Many poll ticks: without the refused set, s1 gets one attempt each.
      await new Promise((r) => setTimeout(r, 150));
      expect(attempts('s1')).toBe(1);
      // The healthy session is unaffected — its loop still streams.
      expect(attempts('s2')).toBeGreaterThanOrEqual(1);
      expect(dispatched).toContain('s2');
    });

    it('drops a refused subscription without scheduling a reconnect', async () => {
      // The live incident was ~1 refused request per second per dead session:
      // the loop's own backoff reconnect. A gone id must exit the loop instead
      // of entering it, so no backoff sleep is ever scheduled for it.
      const sleeps: number[] = [];
      const { client, attempts } = countingDaemon({
        sessions: () => [{ sessionId: 's1' }],
        refuse: () => goneError('s1'),
      });
      pump = new SessionEventPump(client, undefined, {
        pollMs: 5,
        reconnectMs: 1,
        sleep: async (ms) => {
          sleeps.push(ms);
          await new Promise((r) => setTimeout(r, ms));
        },
      });
      await pump.start();
      await new Promise((r) => setTimeout(r, 60));
      expect(attempts('s1')).toBe(1);
      expect(sleeps).toEqual([]);
    });

    it('tries a refused session again after it leaves and re-enters the list', async () => {
      let listed = true;
      const { client, attempts } = countingDaemon({
        sessions: () => (listed ? [{ sessionId: 's1' }] : []),
        refuse: (id) => goneError(id),
      });
      pump = new SessionEventPump(client, undefined, {
        pollMs: 20,
        reconnectMs: 0,
        sleep: async () => {},
      });
      await pump.start();
      await new Promise((r) => setTimeout(r, 80));
      expect(attempts('s1')).toBe(1);
      // The id leaves the list (daemon forgot it), then comes back (a real
      // new session reusing the id): the refusal must not be permanent.
      listed = false;
      await new Promise((r) => setTimeout(r, 60));
      expect(attempts('s1')).toBe(1); // forgotten, not retried while unlisted
      listed = true;
      await new Promise((r) => setTimeout(r, 60));
      expect(attempts('s1')).toBe(2);
    });

    it('reconnects after a non-gone subscription error', async () => {
      const { client, attempts } = countingDaemon({
        sessions: () => [{ sessionId: 's1' }],
        // A dropped connection, not a gone session: self-heal must still work.
        refuse: (_id, attempt) =>
          attempt < 3 ? new Error('socket hang up') : undefined,
      });
      pump = new SessionEventPump(client, undefined, {
        pollMs: 20,
        reconnectMs: 0,
        sleep: async () => {},
      });
      await pump.start();
      await waitFor(() => attempts('s1') >= 3);
      expect(attempts('s1')).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('SessionEventPump routing context and session name (issue #166)', () => {
  const frame = (rawInput: Record<string, unknown> = {}) => ({
    id: 7,
    type: 'permission_request',
    data: {
      requestId: 'r1',
      toolCall: {
        toolCallId: 'tc1',
        title: 'humanized',
        kind: 'execute',
        rawInput,
      },
      options: [{ optionId: 'ok', kind: 'allow_once' }],
    },
  });

  it('stamps a fall-through prompt with policy.action=prompt, decisionSource=fallthrough', async () => {
    const calls: Array<{ ctx: unknown }> = [];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      holdOpenMs: 2000,
      frames: [frame()],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(
      daemon,
      {
        notify: async (_e, ctx) => {
          calls.push({ ctx });
        },
      },
      {
        pollMs: 20,
        reconnectMs: 0,
        sleep: async () => {},
        enforcer: new PolicyEnforcer(daemon, {
          defaults: { action: 'prompt', requireScope: 'approve' },
          rules: [],
        }),
      },
    );
    await pump.start();
    expect(await waitFor(() => calls.length >= 1)).toBe(true);
    expect(calls[0].ctx).toMatchObject({
      sessionId: 's1',
      routing: { policyAction: 'prompt', policyDecisionSource: 'fallthrough' },
    });
  });

  it('stamps a rule-caused prompt with decisionSource=rule', async () => {
    const calls: Array<{ ctx: unknown }> = [];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      holdOpenMs: 2000,
      frames: [frame()],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(
      daemon,
      {
        notify: async (_e, ctx) => {
          calls.push({ ctx });
        },
      },
      {
        pollMs: 20,
        reconnectMs: 0,
        sleep: async () => {},
        enforcer: new PolicyEnforcer(daemon, {
          defaults: { action: 'prompt', requireScope: 'approve' },
          rules: [{ id: 'p', match: { tool: 'execute' }, action: 'prompt' }],
        }),
      },
    );
    await pump.start();
    expect(await waitFor(() => calls.length >= 1)).toBe(true);
    expect(calls[0].ctx).toMatchObject({
      routing: { policyAction: 'prompt', policyDecisionSource: 'rule' },
    });
  });

  it('carries no routing context without an enforcer or on a non-permission event', async () => {
    const calls: Array<{ ctx: Record<string, unknown> }> = [];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions: [{ sessionId: 's1', workspaceCwd: '/w' }],
      holdOpenMs: 2000,
      frames: [frame(), { id: 8, type: 'session_update', data: {} }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    pump = new SessionEventPump(
      daemon,
      {
        notify: async (_e, ctx) => {
          calls.push({ ctx: ctx as Record<string, unknown> });
        },
      },
      { pollMs: 20, reconnectMs: 0, sleep: async () => {} },
    );
    await pump.start();
    expect(await waitFor(() => calls.length >= 2)).toBe(true);
    expect(calls.every((c) => !('routing' in c.ctx))).toBe(true);
  });

  it('resolves the session name per event, so a title set after the loop started is used', async () => {
    const names: Array<string | undefined> = [];
    const sessions: Array<{
      sessionId: string;
      workspaceCwd: string;
      displayName?: string;
    }> = [{ sessionId: 's1', workspaceCwd: '/w' }];
    stub = await startStubDaemon({
      workspaceCwd: '/w',
      sessions,
      holdOpenMs: 600,
      frames: [{ id: 1, type: 'session_update', data: {} }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    let delivered = 0;
    pump = new SessionEventPump(
      daemon,
      {
        notify: async (_e, ctx) => {
          names.push(ctx.sessionName);
        },
      },
      {
        pollMs: 20,
        reconnectMs: 0,
        sleep: async () => {},
        sessionName: (s) => s.displayName,
        onDispatch: () => void delivered++,
      },
    );
    await pump.start();
    expect(await waitFor(() => delivered >= 1)).toBe(true);
    expect(names[0]).toBeUndefined(); // not titled yet
    // The daemon auto-titles the session; the next poll sees it. The stream
    // reconnects (holdOpenMs elapses) and replays a frame.
    sessions[0].displayName = 'my-session';
    expect(await waitFor(() => names.includes('my-session'), 4000)).toBe(true);
  });
});
