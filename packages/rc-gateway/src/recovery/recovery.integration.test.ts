/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { SessionWal, decodeSegment } from '../wal.js';
import {
  DaemonPool,
  type DaemonExitInfo,
  type PooledDaemonSpawn,
} from '../daemonPool.js';
import { RecoveryOrchestrator, createReportOutcome } from './orchestrator.js';
import type { OwnerEvent } from '../ownerEvents.js';

/** One parsed SSE frame from GET /session/:id/events. Presence/synthetic
 * frames (client_joined/client_left) carry no `id`; relayed, replayed, and
 * marker frames do. */
interface SseFrame {
  id?: number;
  type: string;
  data: unknown;
}

/** Poll `cond` every 10ms until true or the deadline — the only async
 * synchronization primitive this test uses (audit rows are fire-and-forget,
 * so they can only be observed by polling). */
function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`waitFor: condition not met within ${timeoutMs}ms`));
      }
    }, 10);
  });
}

/** Read an SSE response body to completion (or until `signal` aborts it) and
 * append every `data:` frame's JSON to `out`. The gateway's `writeFrame`
 * emits `id: N\ndata: <json>\n\n`; the data JSON itself carries `id` for
 * id-bearing frames, so the `id !== undefined` filter isolates them. */
async function drainSse(
  res: Response,
  out: SseFrame[],
  signal?: AbortSignal,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ value, done } = await reader.read());
      } catch {
        // Abort cancels the body read (undici rejects the in-flight read);
        // any other error is a real stream failure.
        if (signal?.aborted) return;
        throw new Error('SSE stream read failed');
      }
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let dataLine: string | undefined;
        for (const line of block.split('\n')) {
          if (line.startsWith('data: ')) dataLine = line.slice(6);
        }
        if (dataLine === undefined) continue;
        const parsed = JSON.parse(dataLine) as {
          id?: number;
          type?: string;
          data?: unknown;
        };
        out.push({
          id: parsed.id,
          type: parsed.type ?? 'unknown',
          data: parsed.data,
        });
      }
    }
  } finally {
    reader.releaseLock();
  }
}

describe('mid-turn recovery integration', () => {
  let server: Server | undefined;
  let runtimeBase: string;
  let workspaceCwd: string;
  let walDir: string;
  let defaultWorkspaceCwd: string;
  /** The pool's default daemon (never routed to in this test). */
  let defaultStub: StubDaemon | undefined;
  /** Every pooled daemon spawned through the pool's `spawn` hook, in order. */
  let stubs: StubDaemon[] = [];
  /** Matching spawn outputs (the pool's `onExit` wiring lives here). */
  let spawnOuts: PooledDaemonSpawn[] = [];
  let spawnCount = 0;
  let pool: DaemonPool;
  let recovery: RecoveryOrchestrator;
  let gw: ReturnType<typeof createGatewayApp>;
  const ownerFrames: OwnerEvent[] = [];
  let ownerToken = '';
  let death:
    | {
        key: string;
        sessions: string[];
        exit: DaemonExitInfo & { atMs: number };
      }
    | undefined;
  let recoveryDone: Promise<void> | undefined;

  beforeEach(async () => {
    runtimeBase = await mkdtemp(join(tmpdir(), 'rc-recovery-integ-'));
    // The create route stats `cwd` — it must be a REAL directory.
    workspaceCwd = join(runtimeBase, 'ws');
    await mkdir(workspaceCwd);
    walDir = join(runtimeBase, 'wal-root');
    defaultWorkspaceCwd = join(runtimeBase, 'default-ws');

    defaultStub = await startStubDaemon({
      workspaceCwd: defaultWorkspaceCwd,
    });

    pool = new DaemonPool({
      defaultDaemon: new DaemonClient({ baseUrl: defaultStub.baseUrl }),
      defaultWorkspaceCwd,
      spawn: async (cwd) => {
        spawnCount += 1;
        // First spawn (the daemon that will crash) holds the prompt in
        // flight (5s) so the crash lands mid-turn; the RESPAWN gets no
        // delay so the post-recovery prompt resolves fast.
        const stub = await startStubDaemon({
          workspaceCwd: cwd,
          holdOpenMs: 10_000,
          // The events route enforces isValidSessionId (32-36 hex/dash),
          // so the minted id must be in that shape, not 'stub-agent-N'.
          createSessionId: (n) => `${'a'.repeat(31)}-${n}`,
          ...(spawnCount === 1 ? { promptDelayMs: 5_000 } : {}),
        });
        const out: PooledDaemonSpawn = {
          client: new DaemonClient({ baseUrl: stub.baseUrl }),
          stop: () => stub.close(),
          workspaceCwd: cwd,
        };
        spawnOuts.push(out);
        stubs.push(stub);
        return out;
      },
    });

    const store = await TokenStore.open(join(runtimeBase, 'tokens.json'));
    ownerToken = (await store.issue(['owner'], 'owner-1')).token;

    gw = createGatewayApp({
      daemon: pool,
      store,
      pairing: new PairingService(),
      auditPath: join(runtimeBase, 'audit.log'),
      walDir,
    });
    // Mirror the production boot wiring (cli.ts): the pool owns the
    // daemon_died audit + death hook; the orchestrator owns the saga +
    // the marker/audit/notify sink (with walDir, unlike production
    // today, so marker frames land in the same WAL the relay appends to).
    pool.setAudit(gw.audit);
    recovery = new RecoveryOrchestrator({
      pool,
      promptQueue: gw.promptQueue,
      reportOutcome: createReportOutcome({
        walDir,
        ownerEvents: gw.ownerEvents,
        audit: gw.audit,
      }),
    });
    pool.setRecoveryProvider(recovery);
    pool.setOnDaemonDeath((key, sessions, exit) => {
      death = { key, sessions, exit };
      recoveryDone = recovery.recover(key, sessions, exit);
    });
    gw.ownerEvents.subscribe((e) => ownerFrames.push(e));

    server = await new Promise((resolve) => {
      const s = gw.app.listen(0, '127.0.0.1', () => resolve(s));
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
    await pool.stopAll();
    for (const s of stubs) await s.close().catch(() => {});
    stubs = [];
    spawnOuts = [];
    spawnCount = 0;
    if (defaultStub) await defaultStub.close();
    defaultStub = undefined;
    ownerFrames.length = 0;
    death = undefined;
    recoveryDone = undefined;
    await rm(runtimeBase, { recursive: true, force: true });
  });

  it('crash mid-turn -> detect -> respawn -> resume in place -> gapless WAL replay -> recovered prompt', async () => {
    const { port } = server!.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const auth = { Authorization: `Bearer ${ownerToken}` };

    // 1. Create a session in a real (non-default) workspace: the pool
    //    spawns its first pooled daemon (stubB).
    const createRes = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: workspaceCwd }),
    });
    expect(createRes.status).toBe(200);
    const { sessionId: SID } = (await createRes.json()) as {
      sessionId: string;
    };
    expect(stubs.length).toBe(1);

    // 2. A watcher attaches live: the relay appends the daemon's frames
    //    1,2 to the WAL under downstream ids 1,2 (epoch offset 0).
    const attachFrames: SseFrame[] = [];
    const attachRes = await fetch(`${baseUrl}/session/${SID}/events`, {
      headers: { ...auth, Accept: 'text/event-stream' },
    });
    expect(attachRes.status).toBe(200);
    const attachDone = drainSse(attachRes, attachFrames);
    await waitFor(
      () => attachFrames.filter((f) => f.id !== undefined).length >= 2,
    );
    expect(
      attachFrames.filter((f) => f.id !== undefined).map((f) => f.id),
    ).toEqual([1, 2]);

    // 3. Fire a prompt (NOT awaited): the gateway holds the per-session
    //    queue slot for its whole flight, and the (crash-bound) stub
    //    holds it for 5s — the turn is in flight at the moment of death.
    const promptPromise = fetch(`${baseUrl}/session/${SID}/prompt`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    await waitFor(() => stubs[0]!.lastPromptBody !== undefined);

    // 4. Hard crash: closeAllConnections() destroys the SSE + prompt
    //    sockets, then the synthetic exit fires SYNCHRONOUSLY — before the
    //    prompt route's socket error can release the queue slot — so the
    //    saga's inFlight snapshot deterministically sees the turn in
    //    flight.
    const crashP = stubs[0]!.crash();
    spawnOuts[0]!.onExit?.({ code: 137, signal: null });
    await crashP;

    // 5. The observer's stream ends with the daemon; the in-flight prompt
    //    resolves 502 daemon_unavailable (the slot releases then).
    await attachDone;
    const promptRes = await promptPromise;
    expect(promptRes.status).toBe(502);
    expect(await promptRes.json()).toEqual({
      error: 'Daemon unavailable',
      code: 'daemon_unavailable',
    });

    // 6. The saga settles: one respawn (stubC), the SAME session id
    //    resumed on it, and a sticky recovered outcome with the
    //    mid-turn flag set.
    await recoveryDone!;
    expect(death!.sessions).toEqual([SID]);
    expect(death!.exit.code).toBe(137);
    expect(stubs.length).toBe(2);
    // pool.resumeSession restores through the daemon's load action (#37),
    // so the stub records the request on lastLoadSessionBody.
    expect(stubs[1]!.lastLoadSessionBody).toBeDefined();
    expect(recovery.recoveryState(SID)).toBe('recovered');
    const outcome = recovery.lastOutcome(SID)!;
    expect(outcome.recovered).toBe(true);
    expect(outcome.hadInFlightTurn).toBe(true);
    expect(outcome.exitCode).toBe(137);
    expect(outcome.tookMs).toBeGreaterThanOrEqual(0);

    // 7. The WAL holds the relayed frames plus both lifecycle markers,
    //    gapless: 1,2 (relay) -> 3 (interrupted) -> 4 (recovered).
    const walFrames = [...decodeSegment(join(walDir, 'wal', `${SID}.log`))];
    expect(walFrames.map((f) => f.id)).toEqual([1, 2, 3, 4]);
    expect(walFrames[2]).toMatchObject({
      id: 3,
      type: 'session_interrupted',
      data: {
        sessionId: SID,
        recovered: true,
        hadInFlightTurn: true,
        exitCode: 137,
      },
    });
    expect(walFrames[3]).toMatchObject({
      id: 4,
      type: 'session_recovered',
      data: { sessionId: SID },
    });
    expect(typeof (walFrames[3]!.data as { tookMs: unknown }).tookMs).toBe(
      'number',
    );
    const wal = new SessionWal({ dir: walDir, sessionId: SID });
    expect(wal.count()).toBe(4);
    wal.close();

    // 8. Owner stream: the death + both outcome rows landed in the audit
    //    (fire-and-forget, so poll), and the marker frames were published
    //    with their real WAL ids.
    const auditRecords = () =>
      ownerFrames
        .filter(
          (f): f is Extract<OwnerEvent, { type: 'audit' }> =>
            f.type === 'audit',
        )
        .map((f) => f.record);
    await waitFor(() =>
      auditRecords().some(
        (r) => r.action === 'session_interrupted' && r.target === SID,
      ),
    );
    await waitFor(() =>
      auditRecords().some((r) => r.action === 'session_recovered'),
    );
    await waitFor(() => auditRecords().some((r) => r.action === 'daemon_died'));
    const died = auditRecords().find((r) => r.action === 'daemon_died')!;
    expect(died.detail).toEqual({
      exitCode: 137,
      signal: null,
      sessionCount: 1,
    });
    const interrupted = auditRecords().find(
      (r) => r.action === 'session_interrupted',
    )!;
    expect(interrupted).toMatchObject({
      target: SID,
      outcome: 'ok',
      detail: { recovered: true, hadInFlightTurn: true, exitCode: 137 },
    });
    const recovered = auditRecords().find(
      (r) => r.action === 'session_recovered',
    )!;
    expect(recovered).toMatchObject({ target: SID });
    expect(typeof (recovered.detail as { tookMs: unknown }).tookMs).toBe(
      'number',
    );
    const markerEvents = ownerFrames.filter(
      (f): f is Extract<OwnerEvent, { type: 'session_event' }> =>
        f.type === 'session_event' && f.sessionId === SID,
    );
    expect(markerEvents.map((f) => f.event.id)).toEqual([3, 4]);
    expect(markerEvents.map((f) => f.event.type)).toEqual([
      'session_interrupted',
      'session_recovered',
    ]);

    // 9. Reconnect with Last-Event-ID 0: the WAL replays 1-4 UNrenumbered,
    //    then the respawned daemon's raw frames 1,2 re-anchor onto the
    //    shared WAL and stream as 5,6 — the observer sees 1..6 with no
    //    gaps or duplicates.
    const ac = new AbortController();
    const reconnectFrames: SseFrame[] = [];
    const reconnectRes = await fetch(`${baseUrl}/session/${SID}/events`, {
      headers: {
        ...auth,
        Accept: 'text/event-stream',
        'Last-Event-ID': '0',
      },
      signal: ac.signal,
    });
    expect(reconnectRes.status).toBe(200);
    const reconnectDone = drainSse(reconnectRes, reconnectFrames, ac.signal);
    await waitFor(
      () => reconnectFrames.filter((f) => f.id !== undefined).length >= 6,
    );
    ac.abort();
    await reconnectDone;
    const ids = reconnectFrames.filter((f) => f.id !== undefined);
    expect(ids.map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids.map((f) => f.type)).toEqual([
      'session_update',
      'session_update',
      'session_interrupted',
      'session_recovered',
      'session_update',
      'session_update',
    ]);
    // The live relay appended the renumbered frames (5,6) to the same WAL.
    const walAfter = new SessionWal({ dir: walDir, sessionId: SID });
    expect(walAfter.count()).toBe(6);
    walAfter.close();

    // 10. The session is live again: a fresh prompt routes to the
    //     respawned daemon and resolves normally.
    const postRes = await fetch(`${baseUrl}/session/${SID}/prompt`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'again' }),
    });
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ stopReason: 'end_turn' });
    expect(stubs[1]!.lastPromptBody).toBeDefined();
  }, 30_000);
});
