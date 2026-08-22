/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from '../auditLog.js';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import { PromptQueue } from '../routes/promptQueue.js';
import { SessionWal } from '../wal.js';
import type { PushNotifier } from '../webpush/notifier.js';
import {
  RecoveryOrchestrator,
  createReportOutcome,
  type RecoveryPool,
  type SessionRecoveryOutcome,
} from './orchestrator.js';

/** The 404 contract the daemon answers when a session's transcript is gone
 * (`code: 'session_not_found'`, no `toolCallId`). */
const sessionNotFound = () =>
  new DaemonHttpError(
    404,
    { code: 'session_not_found', sessionId: 's1' },
    'resume session: 404 session not found',
  );

const deathExit = (
  code: number | null = 1,
  signal: NodeJS.Signals | null = null,
) => ({ code, signal, atMs: 1000 });

function makeOrchestrator(
  pool: RecoveryPool,
  opts: {
    promptQueue?: PromptQueue;
    reportOutcome?: (
      sessionId: string,
      outcome: SessionRecoveryOutcome,
    ) => void;
    now?: () => number;
  } = {},
): RecoveryOrchestrator {
  return new RecoveryOrchestrator({
    pool,
    promptQueue: opts.promptQueue ?? new PromptQueue(),
    reportOutcome: opts.reportOutcome,
    now: opts.now,
  });
}

describe('RecoveryOrchestrator', () => {
  it('recovers every session in place, sequentially, and reports recovered outcomes', async () => {
    const getOrSpawn = vi.fn(async () => ({}));
    const order: string[] = [];
    const resumeSession = vi.fn(async (id: string) => {
      order.push(id);
      return {};
    });
    const reportOutcome = vi.fn();
    const orch = makeOrchestrator(
      { getOrSpawn, resumeSession },
      {
        reportOutcome,
        now: () => 5000,
      },
    );

    await orch.recover('/proj/a', ['b', 'a', 'c'], deathExit(0, 'SIGTERM'));

    expect(getOrSpawn).toHaveBeenCalledTimes(1);
    expect(getOrSpawn).toHaveBeenCalledWith('/proj/a');
    // Sequential, in the order given (design §2.4).
    expect(order).toEqual(['b', 'a', 'c']);
    expect(resumeSession).toHaveBeenNthCalledWith(1, 'b', {
      workspaceCwd: '/proj/a',
    });
    expect(orch.recoveryState('b')).toBe('recovered');
    expect(orch.recoveryState('a')).toBe('recovered');
    expect(orch.recoveryState('c')).toBe('recovered');

    expect(reportOutcome).toHaveBeenCalledTimes(3);
    expect(reportOutcome).toHaveBeenCalledWith(
      'b',
      expect.objectContaining({
        recovered: true,
        hadInFlightTurn: false,
        exitCode: 0,
      }),
    );
    const took = orch.lastOutcome('a')?.tookMs;
    expect(took).toBeGreaterThanOrEqual(0);
  });

  it('404 session_not_found: that session is unrecoverable with no retry; the rest are still tried', async () => {
    const getOrSpawn = vi.fn(async () => ({}));
    const resumeSession = vi.fn(async (id: string) => {
      if (id === 's1') throw sessionNotFound();
      return {};
    });
    const reportOutcome = vi.fn();
    const orch = makeOrchestrator(
      { getOrSpawn, resumeSession },
      {
        reportOutcome,
      },
    );

    await orch.recover('/proj/a', ['s1', 's2'], deathExit(1));

    expect(orch.recoveryState('s1')).toBe('unrecoverable');
    expect(orch.recoveryState('s2')).toBe('recovered');
    // No retry of the gone transcript.
    expect(resumeSession.mock.calls.filter(([id]) => id === 's1')).toHaveLength(
      1,
    );
    expect(reportOutcome).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ recovered: false }),
    );
    expect(reportOutcome).toHaveBeenCalledWith(
      's2',
      expect.objectContaining({ recovered: true }),
    );
  });

  it('any other resume error: this and all remaining sessions are unrecoverable; the saga ends', async () => {
    const getOrSpawn = vi.fn(async () => ({}));
    const resumeSession = vi.fn(async (id: string) => {
      if (id === 's1') throw new Error('ECONNRESET');
      return {};
    });
    const reportOutcome = vi.fn();
    const orch = makeOrchestrator(
      { getOrSpawn, resumeSession },
      {
        reportOutcome,
      },
    );

    await orch.recover('/proj/a', ['s1', 's2', 's3'], deathExit(1));

    expect(orch.recoveryState('s1')).toBe('unrecoverable');
    expect(orch.recoveryState('s2')).toBe('unrecoverable');
    expect(orch.recoveryState('s3')).toBe('unrecoverable');
    // The saga ended at s1 — s2/s3 were never attempted.
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(resumeSession.mock.calls[0][0]).toBe('s1');
  });

  it('respawn failure: every affected session is unrecoverable; no resume is attempted', async () => {
    const getOrSpawn = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const resumeSession = vi.fn(async () => ({}));
    const reportOutcome = vi.fn();
    const orch = makeOrchestrator(
      { getOrSpawn, resumeSession },
      {
        reportOutcome,
        now: () => 9000,
      },
    );

    await orch.recover('/proj/a', ['s1', 's2'], deathExit(null, 'SIGKILL'));

    expect(resumeSession).not.toHaveBeenCalled();
    expect(orch.recoveryState('s1')).toBe('unrecoverable');
    expect(orch.recoveryState('s2')).toBe('unrecoverable');
    expect(reportOutcome).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        recovered: false,
        exitCode: null,
        tookMs: 0,
      }),
    );
  });

  it('a second death while recovering queues behind the saga; a third coalesces (latest exit wins)', async () => {
    const getOrSpawn = vi.fn(async () => ({}));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resumeSession = vi.fn(async () => {
      await gate; // the just-respawned daemon is slow — the saga is in flight
      return {};
    });
    const reportOutcome = vi.fn();
    const orch = makeOrchestrator(
      { getOrSpawn, resumeSession },
      {
        reportOutcome,
      },
    );

    const first = orch.recover('/proj/a', ['s1'], deathExit(1));
    expect(orch.recoveryState('s1')).toBe('recovering');

    // Second death of the same workspace mid-recovery (the respawned daemon
    // died again), then a third — both must land in ONE queued run.
    const second = orch.recover(
      '/proj/a',
      ['s1', 's2'],
      deathExit(null, 'SIGKILL'),
    );
    const third = orch.recover('/proj/a', ['s2'], deathExit(3));

    release();
    await first;
    await second;
    await third;

    // One initial saga + one coalesced follow-up run — not one run per death.
    expect(getOrSpawn).toHaveBeenCalledTimes(2);
    const coalesced = resumeSession.mock.calls.slice(1).map(([id]) => id);
    expect([...coalesced].sort()).toEqual(['s1', 's2']);
    // Latest exit wins for the queued run.
    const s2Outcome = reportOutcome.mock.calls
      .filter(([id]) => id === 's2')
      .at(-1)?.[1];
    expect(s2Outcome).toMatchObject({ recovered: true, exitCode: 3 });
    expect(orch.recoveryState('s1')).toBe('recovered');
    expect(orch.recoveryState('s2')).toBe('recovered');
  });

  it('snapshots hadInFlightTurn from the prompt queue before respawning', async () => {
    const getOrSpawn = vi.fn(async () => ({}));
    const resumeSession = vi.fn(async () => ({}));
    const queue = new PromptQueue();
    const hold = await queue.acquire('s1', 60_000);
    const orch = makeOrchestrator(
      { getOrSpawn, resumeSession },
      {
        promptQueue: queue,
      },
    );

    await orch.recover('/proj/a', ['s1', 's2'], deathExit(1));

    expect(orch.lastOutcome('s1')?.hadInFlightTurn).toBe(true);
    expect(orch.lastOutcome('s2')?.hadInFlightTurn).toBe(false);
    hold();
    expect(queue.isInFlight('s1')).toBe(false);
  });

  it('sessionLive clears a stale outcome; unknown sessions are idle', async () => {
    const getOrSpawn = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const resumeSession = vi.fn(async () => ({}));
    const orch = makeOrchestrator({ getOrSpawn, resumeSession });

    await orch.recover('/proj/a', ['s1'], deathExit(1));
    expect(orch.recoveryState('s1')).toBe('unrecoverable');
    expect(orch.recoveryState('never-seen')).toBe('idle');

    // A manual resume out-of-band brings the session back to normal attach.
    orch.sessionLive('s1');
    expect(orch.recoveryState('s1')).toBe('idle');
    expect(orch.lastOutcome('s1')).toBeUndefined();
  });

  it('a throwing reportOutcome sink does not break the saga', async () => {
    const getOrSpawn = vi.fn(async () => ({}));
    const resumeSession = vi.fn(async () => ({}));
    const reportOutcome = vi.fn(() => {
      throw new Error('sink down');
    });
    const orch = makeOrchestrator(
      { getOrSpawn, resumeSession },
      {
        reportOutcome,
      },
    );

    await orch.recover('/proj/a', ['s1', 's2'], deathExit(1));

    expect(reportOutcome).toHaveBeenCalledTimes(2);
    expect(orch.recoveryState('s1')).toBe('recovered');
    expect(orch.recoveryState('s2')).toBe('recovered');
  });

  it('dedupes repeated session ids in one death', async () => {
    const getOrSpawn = vi.fn(async () => ({}));
    const resumeSession = vi.fn(async () => ({}));
    const reportOutcome = vi.fn();
    const orch = makeOrchestrator(
      { getOrSpawn, resumeSession },
      {
        reportOutcome,
      },
    );

    await orch.recover('/proj/a', ['s1', 's1'], deathExit(1));

    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(reportOutcome).toHaveBeenCalledTimes(1);
  });
});

describe('createReportOutcome', () => {
  /** Read back the frames a test appended under its unique tmp walDir. */
  function readWalFrames(walDir: string, sessionId: string) {
    const wal = new SessionWal({ dir: walDir, sessionId });
    const result = wal.replayFrom(0);
    wal.close();
    expect(result.truncated).toBe(false);
    return result.events;
  }

  function fakeAudit() {
    const entries: AuditEntry[] = [];
    return {
      entries,
      audit: {
        record: async (entry: AuditEntry) => {
          entries.push(entry);
        },
      },
    };
  }

  function fakeNotifier() {
    const calls: Array<{
      event: { type: string; data: unknown };
      ctx: { sessionId: string; sessionName?: string };
    }> = [];
    const notifier = {
      notify: (
        event: { type: string; data: unknown },
        ctx: { sessionId: string; sessionName?: string },
      ) => {
        calls.push({ event, ctx });
        return Promise.resolve();
      },
    };
    return { calls, notifier: notifier as unknown as PushNotifier };
  }

  it('recovered: appends both marker frames gapless, publishes both on the owner stream, audits both, pushes session.recovered', () => {
    const walDir = mkdtempSync(join(tmpdir(), 'rc-report-out-'));
    const owner = new OwnerEventBus();
    const ownerEvents: OwnerEvent[] = [];
    const unsub = owner.subscribe((ev) => ownerEvents.push(ev));
    const { entries, audit } = fakeAudit();
    const { calls, notifier } = fakeNotifier();
    const sid = 'r0c4ov3r3d-sess-0000000000000001';

    const report = createReportOutcome({
      walDir,
      ownerEvents: owner,
      audit,
      notifier,
    });
    report(sid, {
      recovered: true,
      hadInFlightTurn: true,
      exitCode: 1,
      tookMs: 42,
    });

    // WAL: exactly the two marker frames, ids 1 and 2 (gapless from empty).
    const frames = readWalFrames(walDir, sid);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      id: 1,
      v: 1,
      type: 'session_interrupted',
      data: {
        sessionId: sid,
        recovered: true,
        hadInFlightTurn: true,
        exitCode: 1,
      },
    });
    expect(frames[1]).toMatchObject({
      id: 2,
      v: 1,
      type: 'session_recovered',
      data: { sessionId: sid, tookMs: 42 },
    });

    // Owner stream: both frames as session_event (design §4).
    expect(ownerEvents).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      const ev = ownerEvents[i];
      expect(ev.type).toBe('session_event');
      if (ev.type !== 'session_event') return;
      expect(ev.sessionId).toBe(sid);
      expect(ev.event).toEqual(frames[i]);
    }

    // Audit rows match the registry delta (design §6).
    expect(entries).toEqual([
      {
        action: 'session_interrupted',
        target: sid,
        outcome: 'ok',
        detail: { recovered: true, hadInFlightTurn: true, exitCode: 1 },
      },
      { action: 'session_recovered', target: sid, detail: { tookMs: 42 } },
    ]);

    // Push: success pushes session.recovered (the notify event carries the
    // WAL frame type; buildPayload maps it to the push kind).
    expect(calls).toEqual([
      {
        event: {
          type: 'session_recovered',
          data: { sessionId: sid, tookMs: 42 },
        },
        ctx: { sessionId: sid },
      },
    ]);
    unsub();
  });

  it('unrecoverable: only session_interrupted is appended/audited/pushed (outcome failed); no session_recovered anywhere', () => {
    const walDir = mkdtempSync(join(tmpdir(), 'rc-report-out-'));
    const owner = new OwnerEventBus();
    const ownerEvents: OwnerEvent[] = [];
    const unsub = owner.subscribe((ev) => ownerEvents.push(ev));
    const { entries, audit } = fakeAudit();
    const { calls, notifier } = fakeNotifier();
    const sid = 'r0c4ov3r3d-sess-0000000000000002';

    const report = createReportOutcome({
      walDir,
      ownerEvents: owner,
      audit,
      notifier,
    });
    report(sid, {
      recovered: false,
      hadInFlightTurn: true,
      exitCode: null,
      tookMs: 7,
    });

    const frames = readWalFrames(walDir, sid);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      id: 1,
      type: 'session_interrupted',
      // exitCode null (signal kill) is omitted from the frame (design §4).
      data: { sessionId: sid, recovered: false, hadInFlightTurn: true },
    });
    expect('exitCode' in (frames[0].data as object)).toBe(false);

    expect(ownerEvents).toHaveLength(1);
    expect(entries).toEqual([
      {
        action: 'session_interrupted',
        target: sid,
        outcome: 'failed',
        detail: { recovered: false, hadInFlightTurn: true },
      },
    ]);
    expect(calls).toEqual([
      {
        event: {
          type: 'session_interrupted',
          data: { sessionId: sid, recovered: false, hadInFlightTurn: true },
        },
        ctx: { sessionId: sid },
      },
    ]);
    unsub();
  });

  it('WAL dark (no walDir): no durable frames and no owner session_event, but audit + push still happen', () => {
    const owner = new OwnerEventBus();
    const ownerEvents: OwnerEvent[] = [];
    const unsub = owner.subscribe((ev) => ownerEvents.push(ev));
    const { entries, audit } = fakeAudit();
    const { calls, notifier } = fakeNotifier();
    const sid = 'r0c4ov3r3d-sess-0000000000000003';

    const report = createReportOutcome({ ownerEvents: owner, audit, notifier });
    report(sid, {
      recovered: true,
      hadInFlightTurn: false,
      exitCode: 0,
      tookMs: 3,
    });

    expect(ownerEvents).toHaveLength(0);
    expect(entries).toEqual([
      {
        action: 'session_interrupted',
        target: sid,
        outcome: 'ok',
        detail: { recovered: true, hadInFlightTurn: false, exitCode: 0 },
      },
      { action: 'session_recovered', target: sid, detail: { tookMs: 3 } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].event.type).toBe('session_recovered');
    unsub();
  });

  it('marker ids continue the WAL sequence (a relay frame already at id 5 → markers at 6 and 7)', () => {
    const walDir = mkdtempSync(join(tmpdir(), 'rc-report-out-'));
    const sid = 'r0c4ov3r3d-sess-0000000000000004';
    const seed = new SessionWal({ dir: walDir, sessionId: sid });
    for (let id = 1; id <= 5; id++) {
      seed.append({ id, v: 1, type: 'message', data: { n: id } });
    }

    const { audit } = fakeAudit();
    const { notifier } = fakeNotifier();
    const report = createReportOutcome({ walDir, audit, notifier });
    report(sid, {
      recovered: true,
      hadInFlightTurn: false,
      exitCode: 1,
      tookMs: 1,
    });

    const frames = readWalFrames(walDir, sid);
    expect(frames.map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(frames[5].type).toBe('session_interrupted');
    expect(frames[6].type).toBe('session_recovered');
    seed.close();
  });
});
