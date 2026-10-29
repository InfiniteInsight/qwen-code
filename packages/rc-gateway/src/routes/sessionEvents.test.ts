/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { UnknownSessionError, type RecoveryState } from '../daemonPool.js';
import { createSessionEventsRoute } from './sessionEvents.js';
import { UsageTickBroadcaster } from '../cost/usageTickBroadcaster.js';
import { ConnectionRegistry } from '../connectionRegistry.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { TokenStore } from '../tokenStore.js';
import { bearerResolve } from '../auth.js';
import { SHARE, SESSION_READ, BRIDGE } from '../scopes.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSharedWal, SessionWal } from '../wal.js';
import { loadEpochState, saveEpochState } from '../walEpoch.js';
import { WatchPresence } from '../webpush/watchPresence.js';

// Valid session-id shapes (isValidSessionId: 32-36 hex/dash chars) — these
// fixtures previously used arbitrary strings like 'sess-1', which the route's
// new session-id validation now rejects before any WAL/daemon access.
// Distinct per test group to avoid walRegistry singleton collisions.
const SESS = '11111111111111111111111111111111';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function mountGateway(
  daemon: DaemonClient,
  audit?: AuditRecorder,
  walDir?: string,
  idleAttachMs?: number,
  recoveryAttachMs?: number,
): Promise<string> {
  const app = express();
  app.get(
    '/session/:id/events',
    createSessionEventsRoute(
      daemon,
      new ConnectionRegistry(),
      audit,
      undefined,
      walDir,
      undefined,
      undefined, // watchPresence (7th param since #40 — no presence in these tests)
      idleAttachMs,
      recoveryAttachMs,
    ),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Read an SSE response body into discrete {id, data} frames. */
async function readFrames(
  res: Response,
): Promise<Array<{ id?: string; data: string }>> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((block) => {
      const lines = block.split('\n');
      const id = lines
        .find((l) => l.startsWith('id:'))
        ?.slice(3)
        .trim();
      const data = lines
        .find((l) => l.startsWith('data:'))!
        .slice(5)
        .trim();
      return { id, data };
    });
}

describe('session-events proxy', () => {
  it('relays daemon frames downstream preserving ids', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/session/${SESS}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readFrames(res);
    // Filter to daemon frames only (presence frames have no id).
    const daemonFrames = frames.filter((f) => f.id !== undefined);
    expect(daemonFrames.map((f) => f.id)).toEqual(['1', '2']);
    expect(daemonFrames[0].data).toContain('"text":"one"');
  });

  it('injects a usage_tick frame to the session subscriber', async () => {
    const broadcaster = new UsageTickBroadcaster();
    stub = await startStubDaemon({
      frames: [{ id: 1, type: 'session_update', data: { text: 'one' } }],
      holdOpenMs: 500,
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const app = express();
    app.get(
      '/session/:id/events',
      createSessionEventsRoute(
        daemon,
        new ConnectionRegistry(),
        undefined,
        broadcaster,
      ),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    gateway = server;
    const { port } = server.address() as AddressInfo;

    const resP = fetch(`http://127.0.0.1:${port}/session/${SESS}/events`);
    // Wait for the relay to register its tick listener, then emit one.
    const start = Date.now();
    while (broadcaster.listenerCount(SESS) === 0) {
      if (Date.now() - start > 2000) throw new Error('relay never registered');
      await new Promise((r) => setTimeout(r, 10));
    }
    broadcaster.emit({
      sessionId: SESS,
      costMicrocentsSesTotal: 15,
      costMicrocentsPromptTotal: 3,
      tokensInTotal: 100,
      tokensOutTotal: 50,
    });
    const res = await resP;
    const frames = await readFrames(res);
    const tick = frames.find((f) => f.data.includes('usage_tick'));
    expect(tick).toBeDefined();
    expect(tick!.id).toBeUndefined(); // synthetic — must not advance the cursor
    expect(tick!.data).toContain('"costMicrocentsSesTotal":15');
  });

  it('enriches a permission_request frame with bridgeHints; leaves others untouched', async () => {
    stub = await startStubDaemon({
      frames: [
        { id: 1, type: 'session_update', data: { text: 'one' } },
        {
          id: 2,
          type: 'permission_request',
          data: {
            requestId: 'r1',
            toolCall: { name: 'run_shell', args: { cmd: 'ls' } },
          },
        },
        {
          id: 3,
          type: 'permission_request',
          data: {
            requestId: 'r2',
            toolCall: { name: 'set_env', args: { apiKey: 'sk-secret' } },
          },
        },
      ],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/session/${SESS}/events`);
    const frames = await readFrames(res);
    // Filter to daemon frames only (presence frames have no id).
    const parsed = frames
      .filter((f) => f.id !== undefined)
      .map((f) => JSON.parse(f.data));
    // Non-permission frame: no bridgeHints added.
    expect(parsed[0].data.bridgeHints).toBeUndefined();
    // Clean tool-call → inline surface (run_shell is a mutating tool → medium).
    expect(parsed[1].data.bridgeHints.recommendedSurface).toBe('inline');
    expect(parsed[1].data.bridgeHints.sensitivity).toBe('medium');
    // Secret-looking args → high sensitivity → deeplink.
    expect(parsed[2].data.bridgeHints.sensitivity).toBe('high');
    expect(parsed[2].data.bridgeHints.recommendedSurface).toBe('deeplink');
    // Original fields are preserved.
    expect(parsed[2].data.requestId).toBe('r2');
  });

  it('tags attach/detach presence with kind:bridge for a bridge token, kind:client otherwise', async () => {
    // Mount with an injected rcClient so the route sees a bridge's scopes.
    async function mountWithClient(
      daemon: DaemonClient,
      scopes: string[],
      audit: AuditRecorder,
    ): Promise<string> {
      const app = express();
      app.use((req, _res, next) => {
        (req as { rcClient?: unknown }).rcClient = { id: 'tkn', scopes };
        next();
      });
      app.get(
        '/session/:id/events',
        createSessionEventsRoute(daemon, new ConnectionRegistry(), audit),
      );
      const s: Server = await new Promise((resolve) => {
        const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
      });
      gateway = s;
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    }

    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mountWithClient(daemon, [BRIDGE, SESSION_READ], audit);
    await readFrames(await fetch(`${url}/session/${SESS}/events`));
    const attached = audit.calls.find((c) => c.action === 'session_attached');
    const detached = audit.calls.find((c) => c.action === 'session_detached');
    expect(attached?.detail).toEqual({ kind: 'bridge' });
    expect(detached?.detail).toEqual({ kind: 'bridge' });
  });

  it('forwards Last-Event-ID upstream to the daemon', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    await fetch(`${url}/session/${SESS}/events`, {
      headers: { 'Last-Event-ID': '5' },
    });
    expect(stub.lastEventIdHeader).toBe('5');
  });

  // #83. An idle watched session used to emit zero bytes, so a half-open socket
  // was indistinguishable from a healthy one and the browser reader parked on
  // read() forever, which is the reported "the chat froze until I refreshed".
  // The heartbeat is the only detector of that state, so this asserts the bytes
  // actually arrive and that they cannot corrupt replay.
  it('pings an idle watched stream so a dead socket is detectable', async () => {
    // No frames + a held-open upstream = exactly the idle state that used to
    // produce zero bytes. The short hold ends the stream so text() resolves.
    const HB_SID = '33333333333333333333333333333333';
    stub = await startStubDaemon({ frames: [], holdOpenMs: 400 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const app = express();
    app.get(
      '/session/:id/events',
      createSessionEventsRoute(
        daemon,
        new ConnectionRegistry(),
        undefined, // audit
        undefined, // usageBroadcaster
        undefined, // walDir
        undefined, // promptEventBroadcaster
        undefined, // watchPresence
        50, // idleAttachMs: send headers without waiting for a frame
        undefined, // recoveryAttachMs
        40, // heartbeatMs
      ),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    gateway = server;
    const { port } = server.address() as AddressInfo;

    const res = await fetch(
      `http://127.0.0.1:${port}/session/${HB_SID}/events`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();

    // It repeats rather than firing once, so a long idle stretch stays covered.
    const pings = body.split('\n\n').filter((b) => b.startsWith(': ping'));
    expect(pings.length).toBeGreaterThanOrEqual(2);

    // A comment line, never a frame: carrying data: or id: would hand the client
    // a phantom event or advance its Last-Event-ID cursor, so a later reconnect
    // would silently skip real frames.
    for (const block of pings) {
      expect(block).not.toContain('data:');
      expect(block).not.toContain('id:');
    }
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ eventsStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/session/${SESS}/events`);
    expect(res.status).toBe(502);
  });

  it('maps a daemon 404 to session_not_found, not the retryable 502', async () => {
    // #59: a gone session surfaced as 502, which the watcher treats as
    // recoverable — so clients re-subscribed to a dead id indefinitely
    // (9.4k 404s/hour on the live gateway after a restart).
    stub = await startStubDaemon({ eventsStatus: 404 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/session/${SESS}/events`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'session_not_found' });
  });

  it('maps UnknownSessionError (pool has no record of the id) to 404 too', async () => {
    // The pool rejects before any daemon call, and its error text is
    // "Unknown session: <id>" — no 404 status and no "not found" substring,
    // so only the class check catches it.
    const gone = {
      subscribeEvents: () => ({
        next: () => Promise.reject(new UnknownSessionError(SESS)),
      }),
    };
    const app = express();
    app.get(
      '/session/:id/events',
      createSessionEventsRoute(
        gone as unknown as DaemonClient,
        new ConnectionRegistry(),
      ),
    );
    const s: Server = await new Promise((resolve) => {
      const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
    });
    gateway = s;
    const port = (s.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/session/${SESS}/events`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'session_not_found' });
  });

  it('sends headers + client_joined promptly for a reachable-but-idle session', async () => {
    // Regression: a freshly-created session (e.g. via "New conversation") emits
    // no frame — the daemon holds the stream open with only `retry:`. The
    // watcher must NOT hang at "connecting"; headers arrive after the idle
    // grace, so the composer opens. (Old code gated 200 on the first frame and
    // hung until the daemon stream ended.)
    stub = await startStubDaemon({ frames: [], holdOpenMs: 2000 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon, undefined, undefined, 100);

    const started = Date.now();
    const res = await fetch(`${url}/session/${SESS}/events`);
    expect(res.status).toBe(200);
    // Arrived on the idle grace (~100ms), NOT after the 2s hold-open.
    expect(Date.now() - started).toBeLessThan(1000);

    // First frame out is the synthetic client_joined, so the UI has something.
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value!)).toContain('client_joined');
    await reader.cancel();
  });

  it('aborts the upstream subscription when the client disconnects', async () => {
    stub = await startStubDaemon({ holdOpenMs: 5000 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);

    const ac = new AbortController();
    const res = await fetch(`${url}/session/${SESS}/events`, {
      signal: ac.signal,
    });
    // Read the first chunk so the stream is established, then disconnect.
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => {});

    // Poll until the stub observes its upstream request socket close.
    // Propagation is sub-50ms in practice; the generous deadline is pure
    // anti-flake margin.
    const deadline = Date.now() + 5000;
    while (!stub.eventsAbortedByClient && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stub.eventsAbortedByClient).toBe(true);
  });

  it('records session_attached then session_detached', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mountGateway(daemon, audit);
    const res = await fetch(`${url}/session/${SESS}/events`);
    await res.text();
    const deadline = Date.now() + 2000;
    while (
      !audit.calls.some((c) => c.action === 'session_detached') &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const actions = audit.calls.map((c) => c.action);
    expect(actions).toContain('session_attached');
    expect(actions).toContain('session_detached');
    expect(actions.indexOf('session_attached')).toBeLessThan(
      actions.indexOf('session_detached'),
    );
    // Both entries carry the session id (target) per the spec.
    for (const c of audit.calls) {
      expect(c.target).toBe(SESS);
    }
  });

  it('tags attach/detach rows with shareId+shareLabel for a guest', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const store = await TokenStore.open(
      join(mkdtempSync(join(tmpdir(), 'rc-se-')), 'tokens.json'),
    );
    const share = await store.issueShare({
      scopes: [SHARE, SESSION_READ],
      label: 'review for Sam',
      sessionLockId: SESS,
      ttlSec: 3600,
      parentId: 'owner-1',
    });
    const app = express();
    app.use(bearerResolve(store, audit));
    app.get(
      '/session/:id/events',
      createSessionEventsRoute(daemon, new ConnectionRegistry(), audit),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    gateway = server;
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/session/${SESS}/events`, {
      headers: { Authorization: `Bearer ${share.token}` },
    });
    await res.text();
    const deadline = Date.now() + 2000;
    while (
      !audit.calls.some((c) => c.action === 'session_detached') &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const action of ['session_attached', 'session_detached']) {
      const row = audit.calls.find((c) => c.action === action);
      expect(row!.shareId).toBe(share.id);
      expect(row!.shareLabel).toBe('review for Sam');
    }
  });
});

describe('session-events presence frames', () => {
  it('emits a synthetic client_joined frame as the first SSE frame on attach', async () => {
    stub = await startStubDaemon({
      frames: [{ id: 1, type: 'session_update', data: { text: 'hello' } }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/session/${SESS}/events`);
    expect(res.status).toBe(200);
    const frames = await readFrames(res);
    // First frame must be the synthetic client_joined (no id: line).
    const first = frames[0];
    expect(first).toBeDefined();
    const parsed = JSON.parse(first!.data);
    expect(parsed.type).toBe('client_joined');
    expect(first!.id).toBeUndefined(); // synthetic — no id
    expect(typeof parsed.data.attachedAt).toBe('string');
  });

  it('emits a synthetic client_left frame after the connection closes', async () => {
    stub = await startStubDaemon({
      frames: [{ id: 1, type: 'session_update', data: { text: 'bye' } }],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const audit = fakeAudit();
    const url = await mountGateway(daemon, audit);

    // We can verify client_left indirectly via the writable SSE response: the
    // stub ends the stream, so the gateway's finally block runs synchronously
    // and the audit record for 'session_detached' fires. The SSE client_left
    // frame goes to the client BEFORE the stream closes (written in finally).
    // Since the stream already ended, the response body is all we have;
    // verify that the frames include client_left at the end.
    const res = await fetch(`${url}/session/${SESS}/events`);
    const frames = await readFrames(res);
    const lastFrame = frames[frames.length - 1];
    expect(lastFrame).toBeDefined();
    const parsed = JSON.parse(lastFrame!.data);
    expect(parsed.type).toBe('client_left');
    expect(parsed.data.reason).toBe('disconnect');
    expect(lastFrame!.id).toBeUndefined();
  });
});

describe('session-events WAL integration', () => {
  it('appends daemon frames to WAL and replays them on reconnect', async () => {
    // Use a unique session id to avoid collisions with walRegistry singleton.
    const sessionId = '22222222222222222222222222222222';
    stub = await startStubDaemon({
      frames: [
        { id: 1, type: 'session_update', data: { text: 'one' } },
        { id: 2, type: 'session_update', data: { text: 'two' } },
      ],
    });
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-wal-'));
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon, undefined, walDir);

    // First connection: consume all frames (writes to WAL).
    const res1 = await fetch(`${url}/session/${sessionId}/events`);
    expect(res1.status).toBe(200);
    const frames1 = await readFrames(res1);
    // Filter to daemon frames only (presence frames have no id).
    const daemonFrames1 = frames1.filter((f) => f.id !== undefined);
    expect(daemonFrames1.map((f) => f.id)).toEqual(['1', '2']);

    // Verify WAL has the events.
    const wal = new SessionWal({ dir: walDir, sessionId });
    expect(wal.count()).toBe(2);
    wal.close();

    // Second connection with Last-Event-ID=1: should replay frame 2 from WAL.
    // Stub now has no frames to emit (daemon stream ends immediately).
    await stub.close();
    stub = await startStubDaemon({ frames: [] });
    const daemon2 = new DaemonClient({ baseUrl: stub.baseUrl });
    const url2 = await mountGateway(daemon2, undefined, walDir);

    const res2 = await fetch(`${url2}/session/${sessionId}/events`, {
      headers: { 'Last-Event-ID': '1' },
    });
    expect(res2.status).toBe(200);
    const frames2 = await readFrames(res2);
    // Filter to daemon frames only (presence frames have no id).
    const daemonFrames2 = frames2.filter((f) => f.id !== undefined);
    expect(daemonFrames2.map((f) => f.id)).toEqual(['2']);
    expect(daemonFrames2[0]!.data).toContain('"text":"two"');
  });

  it('carries the daemon send time through live relay and WAL replay', async () => {
    // The stamp a viewer draws on a message must be the moment the event was
    // published, and it must be the SAME value whether the row arrived live or
    // was replayed from a cursor. A replay that re-stamps with Date.now() gives
    // every older message the moment the page was opened, which is worse than
    // no time at all, so both legs are asserted.
    const sessionId = '88888888888888888888888888888888';
    const stamp = 1_700_000_000_000;
    stub = await startStubDaemon({
      frames: [
        {
          id: 1,
          type: 'session_update',
          data: { text: 'one' },
          _meta: { serverTimestamp: stamp, usage: { inputTokens: 7 } },
        },
      ],
    });
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-meta-'));
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon, undefined, walDir);

    type Stamped = { _meta?: { serverTimestamp?: number } };

    const res1 = await fetch(`${url}/session/${sessionId}/events`);
    expect(res1.status).toBe(200);
    const live = (await readFrames(res1)).filter((f) => f.id !== undefined);
    expect(live.map((f) => f.id)).toEqual(['1']);
    expect((JSON.parse(live[0]!.data) as Stamped)._meta?.serverTimestamp).toBe(
      stamp,
    );

    // Reconnect from the genesis cursor: the replayed row must report the
    // original publish time, not a fresh one.
    await stub.close();
    stub = await startStubDaemon({ frames: [] });
    const daemon2 = new DaemonClient({ baseUrl: stub.baseUrl });
    const url2 = await mountGateway(daemon2, undefined, walDir);
    const res2 = await fetch(`${url2}/session/${sessionId}/events`, {
      headers: { 'Last-Event-ID': '0' },
    });
    expect(res2.status).toBe(200);
    const replayed = (await readFrames(res2)).filter((f) => f.id !== undefined);
    expect(replayed.map((f) => f.id)).toEqual(['1']);
    expect(
      (JSON.parse(replayed[0]!.data) as Stamped)._meta?.serverTimestamp,
    ).toBe(stamp);
  });

  it('returns 412 with replay_truncated when Last-Event-ID is before WAL horizon', async () => {
    const sessionId = '33333333333333333333333333333333';
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-wal-'));

    // Seed the WAL with events starting at id=10 so that a resume from id=5
    // is clearly before the WAL's earliest event. The route creates its own
    // SessionWal with default options, so we use the same defaults here.
    const wal = new SessionWal({ dir: walDir, sessionId });
    wal.append({ id: 10, v: 1, type: 'session_update', data: {} });
    wal.append({ id: 11, v: 1, type: 'session_update', data: {} });
    wal.close();

    stub = await startStubDaemon({ frames: [] });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    // Mount with a fresh app so the walRegistry picks up the pre-seeded dir.
    const app = express();
    app.get(
      '/session/:id/events',
      createSessionEventsRoute(
        daemon,
        new ConnectionRegistry(),
        undefined,
        undefined,
        walDir,
      ),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    gateway = server;
    const { port } = server.address() as AddressInfo;

    // Resume from id=5 which is before the earliest retained (10) by > 1.
    const res = await fetch(
      `http://127.0.0.1:${port}/session/${sessionId}/events`,
      {
        headers: { 'Last-Event-ID': '5' },
      },
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as {
      type: string;
      data: { earliestAvailableId: number | null; reason: string };
    };
    expect(body.type).toBe('replay_truncated');
    expect(body.data.reason).toBe('older_than_wal_horizon');
    expect(body.data.earliestAvailableId).toBe(10);
  });
});

describe('session-events id validation', () => {
  // Defense-in-depth (latent hardening, not a live exploit): the prod mount
  // always passes walDir: undefined today, so this path is currently
  // unreachable, but getWal/SessionWal join req.params.id straight into a
  // file path with no isValidSessionId() check — the same guard every
  // sibling session route (fork.ts, rewind.ts, lineage.ts, idleToggle.ts)
  // applies. Wiring walDir in a future deploy would otherwise reopen a path
  // traversal at that join.
  it('rejects a traversal-shaped session id (400/404) before touching the WAL, even with walDir wired', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-wal-'));
    const url = await mountGateway(daemon, undefined, walDir);

    const res = await fetch(
      `${url}/session/${encodeURIComponent('../../etc')}/events`,
      { headers: { 'Last-Event-ID': '1' } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
    // The daemon was never reached — rejected before any subscribeEvents call.
    expect(stub.lastEventIdHeader).toBeUndefined();
  });

  it('still proceeds normally for a validly-shaped session id with walDir wired', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-wal-'));
    const url = await mountGateway(daemon, undefined, walDir);

    const res = await fetch(`${url}/session/${SESS}/events`);
    expect(res.status).toBe(200);
  });
});

describe('session-events recovery-pending attach (add-mid-turn-recovery §3)', () => {
  // The fakes attach a `recoveryState` probe to a real DaemonClient (Object
  //.assign keeps the prototype methods the route delegates to). Without the
  // probe the route must behave exactly as before — covered by every test
  // above (plain DaemonClient, no recoveryState).

  it('holds a recovering session until the saga settles, then attaches normally', async () => {
    stub = await startStubDaemon({
      frames: [{ id: 1, type: 'session_update', data: { text: 'post' } }],
    });
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const state = { current: 'recovering' as RecoveryState };
    const daemon = Object.assign(client, {
      recoveryState: () => state.current,
    });
    const url = await mountGateway(
      daemon,
      undefined,
      undefined,
      undefined,
      2000,
    );
    // The saga settles ~50ms into the hold.
    setTimeout(() => {
      state.current = 'recovered';
    }, 50);

    const res = await fetch(`${url}/session/${SESS}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readFrames(res);
    const daemonFrames = frames.filter((f) => f.id !== undefined);
    expect(daemonFrames.map((f) => f.id)).toEqual(['1']);
    expect(daemonFrames[0]!.data).toContain('"text":"post"');
  });

  it('502s daemon_unavailable when the recovery hold times out', async () => {
    // The stub is fully healthy — if the hold ever lapsed into a live attach
    // this would 200. It must not.
    stub = await startStubDaemon({ frames: [], holdOpenMs: 5000 });
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const daemon = Object.assign(client, {
      recoveryState: () => 'recovering' as RecoveryState,
    });
    const url = await mountGateway(
      daemon,
      undefined,
      undefined,
      undefined,
      150,
    );

    const res = await fetch(`${url}/session/${SESS}/events`, {
      headers: { 'Last-Event-ID': '7' },
    });
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('daemon_unavailable');
    // Pre-header 502: the upstream subscription was never attempted.
    expect(stub.lastEventIdHeader).toBeUndefined();
  });

  it('serves an unrecoverable session as 200 + WAL replay + close, without subscribing', async () => {
    const sessionId = '44444444444444444444444444444444';
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-wal-'));
    const wal = new SessionWal({ dir: walDir, sessionId });
    wal.append({ id: 1, v: 1, type: 'session_update', data: { text: 'one' } });
    wal.append({ id: 2, v: 1, type: 'session_update', data: { text: 'two' } });
    wal.close();
    stub = await startStubDaemon({ frames: [], holdOpenMs: 5000 });
    const client = new DaemonClient({ baseUrl: stub.baseUrl });
    const daemon = Object.assign(client, {
      recoveryState: () => 'unrecoverable' as RecoveryState,
    });
    const url = await mountGateway(daemon, undefined, walDir);

    const res = await fetch(`${url}/session/${sessionId}/events`, {
      headers: { 'Last-Event-ID': '1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readFrames(res);
    // Only the WAL-replayed frame after the cursor; the stream then closed.
    const daemonFrames = frames.filter((f) => f.id !== undefined);
    expect(daemonFrames.map((f) => f.id)).toEqual(['2']);
    expect(daemonFrames[0]!.data).toContain('"text":"two"');
    // The terminal branch never touches the live daemon.
    expect(stub.lastEventIdHeader).toBeUndefined();
    // client_left marks the close; no client_joined was sent (no attach).
    const parsed = frames.map((f) => JSON.parse(f.data));
    expect(parsed.some((e) => e.type === 'client_left')).toBe(true);
    expect(parsed.some((e) => e.type === 'client_joined')).toBe(false);
  });
});

describe('session-events id continuity / epoch renumbering (add-mid-turn-recovery §4)', () => {
  it('renumbers a new daemon epoch onto the WAL sequence (gapless)', async () => {
    const sessionId = '55555555555555555555555555555555';
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-epoch-'));

    // Epoch 1: a daemon whose bus ids run 1..3.
    stub = await startStubDaemon({
      frames: [
        { id: 1, type: 'session_update', data: { text: 'a' } },
        { id: 2, type: 'session_update', data: { text: 'b' } },
        { id: 3, type: 'session_update', data: { text: 'c' } },
      ],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon, undefined, walDir);
    const res1 = await fetch(`${url}/session/${sessionId}/events`);
    expect(res1.status).toBe(200);
    const frames1 = await readFrames(res1);
    const epoch1 = frames1.filter((f) => f.id !== undefined);
    // No boundary in this lifetime: raw ids pass through unchanged.
    expect(epoch1.map((f) => f.id)).toEqual(['1', '2', '3']);

    // The daemon dies and is respawned: the new bus epoch restarts at id 1.
    await stub.close();
    stub = await startStubDaemon({
      frames: [
        { id: 1, type: 'session_update', data: { text: 'd' } },
        { id: 2, type: 'session_update', data: { text: 'e' } },
      ],
    });
    const daemon2 = new DaemonClient({ baseUrl: stub.baseUrl });
    const url2 = await mountGateway(daemon2, undefined, walDir);
    // A fresh attach (no Last-Event-ID) sees the renumbered live stream.
    const res2 = await fetch(`${url2}/session/${sessionId}/events`);
    expect(res2.status).toBe(200);
    const frames2 = await readFrames(res2);
    const epoch2 = frames2.filter((f) => f.id !== undefined);
    // offset = wal.latestId() + 1 - 1 = 3 + 1 - 1 = 3 → raw 1→4, raw 2→5.
    expect(epoch2.map((f) => f.id)).toEqual(['4', '5']);

    // The WAL sequence is gapless across the epoch boundary.
    const wal = new SessionWal({ dir: walDir, sessionId });
    expect(wal.replayFrom(0).events.map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
    expect(wal.count()).toBe(5);
    wal.close();
  });

  it('leaves no WAL gap when a marker frame is appended out-of-band', async () => {
    const sessionId = '66666666666666666666666666666666';
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-epoch-'));

    stub = await startStubDaemon({
      frames: [
        { id: 1, type: 'session_update', data: { text: 'a' } },
        { id: 2, type: 'session_update', data: { text: 'b' } },
      ],
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon, undefined, walDir);
    const res1 = await fetch(`${url}/session/${sessionId}/events`);
    expect(res1.status).toBe(200);
    await readFrames(res1); // WAL now holds ids 1,2.

    // A recovery marker lands out-of-band through the shared WAL instance —
    // the same one the relay anchors to (Phase 3.2's reportOutcome seam).
    const shared = getSharedWal(walDir, sessionId);
    shared.append({
      id: 3,
      v: 1,
      type: 'session_interrupted',
      data: { sessionId, recovered: true, hadInFlightTurn: true },
    });

    // Respawned daemon: bus ids restart at 1 again.
    await stub.close();
    stub = await startStubDaemon({
      frames: [
        { id: 1, type: 'session_update', data: { text: 'c' } },
        { id: 2, type: 'session_update', data: { text: 'd' } },
      ],
    });
    const daemon2 = new DaemonClient({ baseUrl: stub.baseUrl });
    const url2 = await mountGateway(daemon2, undefined, walDir);
    const res2 = await fetch(`${url2}/session/${sessionId}/events`);
    expect(res2.status).toBe(200);
    const frames2 = await readFrames(res2);
    const epoch2 = frames2.filter((f) => f.id !== undefined);
    // offset = 3 (marker) + 1 - 1 = 3 → raw 1→4, raw 2→5: the marker's id is
    // skipped over, not collided with.
    expect(epoch2.map((f) => f.id)).toEqual(['4', '5']);

    const wal = new SessionWal({ dir: walDir, sessionId });
    expect(wal.replayFrom(0).events.map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
    wal.close();
  });
});

describe('walEpoch sidecar (add-mid-turn-recovery §4)', () => {
  const SID = '77777777777777777777777777777777';
  const CONSERVATIVE = {
    epochOffset: 0,
    lastOutId: Number.MAX_SAFE_INTEGER,
  };

  it('round-trips {epochOffset, lastOutId}', () => {
    const walDir = mkdtempSync(join(tmpdir(), 'rc-epoch-'));
    mkdirSync(join(walDir, 'wal'), { recursive: true });
    saveEpochState(walDir, SID, { epochOffset: 7, lastOutId: 42 });
    expect(loadEpochState(walDir, SID)).toEqual({
      epochOffset: 7,
      lastOutId: 42,
    });
  });

  it('falls back to the conservative state when the sidecar is missing', () => {
    const walDir = mkdtempSync(join(tmpdir(), 'rc-epoch-'));
    expect(loadEpochState(walDir, SID)).toEqual(CONSERVATIVE);
  });

  it('falls back for a torn/corrupt sidecar', () => {
    const walDir = mkdtempSync(join(tmpdir(), 'rc-epoch-'));
    mkdirSync(join(walDir, 'wal'), { recursive: true });
    writeFileSync(join(walDir, 'wal', `${SID}.epoch.json`), '{"epochOffset":');
    expect(loadEpochState(walDir, SID)).toEqual(CONSERVATIVE);
  });

  it('falls back when a field is not a finite number', () => {
    const walDir = mkdtempSync(join(tmpdir(), 'rc-epoch-'));
    mkdirSync(join(walDir, 'wal'), { recursive: true });
    writeFileSync(
      join(walDir, 'wal', `${SID}.epoch.json`),
      '{"epochOffset":"x","lastOutId":3}',
    );
    expect(loadEpochState(walDir, SID)).toEqual(CONSERVATIVE);
  });
});

// ---------------------------------------------------------------------------
// #174: one daemon subscription per session, shared by every watcher
// ---------------------------------------------------------------------------

type BusFrame = {
  id?: number;
  v: number;
  type: string;
  data: unknown;
};

type SubscribeOpts = {
  lastEventId?: number;
  epoch?: string;
  onEpoch?: (epoch: string) => void;
  signal?: AbortSignal;
};

/**
 * A daemon whose session bus behaves like acp-bridge's EventBus where it
 * matters here: every subscriber receives every published frame under the SAME
 * raw id, a cursor replays the ring past it and closes with an id-less
 * `replay_complete`, a cursor this epoch never produced (or a mismatched epoch
 * token) gets an id-less `state_resync_required` and the whole ring, and a
 * restart starts a new epoch whose ids begin at 1 again. The stub daemon used
 * above streams a fixed script per request and ignores cursors, so it cannot
 * show two watchers sharing one bus.
 */
class FakeBusDaemon {
  epoch = 'epoch-1';
  /** When false the bus does not report its epoch token (an old daemon). */
  sendEpoch = true;
  private nextId = 1;
  private ring: BusFrame[] = [];
  private readonly subs = new Set<{
    push: (f: BusFrame | 'end' | Error) => void;
  }>();
  /** What every subscribeEvents call asked for, in order. */
  readonly subscriptions: Array<{ lastEventId?: number; epoch?: string }> = [];

  get liveSubscribers(): number {
    return this.subs.size;
  }

  publish(text: string): number {
    const frame: BusFrame = {
      id: this.nextId++,
      v: 1,
      type: 'session_update',
      data: { text },
    };
    this.ring.push(frame);
    for (const s of this.subs) s.push(frame);
    return frame.id!;
  }

  /** Burn ids the way a load's seeded replay does: consumed, never streamed. */
  burnIds(n: number): void {
    this.nextId += n;
    this.ring.length = 0;
  }

  /** Daemon restart: every stream drops, the next epoch's ids restart at 1. */
  restart(epoch: string): void {
    for (const s of this.subs) s.push(new Error('daemon restarted'));
    this.subs.clear();
    this.epoch = epoch;
    this.nextId = 1;
    this.ring = [];
  }

  subscribeEvents(
    _sessionId: string,
    opts: SubscribeOpts = {},
  ): AsyncGenerator<BusFrame> {
    return this.stream(opts);
  }

  private async *stream(opts: SubscribeOpts): AsyncGenerator<BusFrame> {
    const queue: Array<BusFrame | 'end' | Error> = [];
    let wake: (() => void) | undefined;
    const sub = {
      push(f: BusFrame | 'end' | Error) {
        queue.push(f);
        wake?.();
      },
    };
    this.subs.add(sub);
    this.subscriptions.push({
      lastEventId: opts.lastEventId,
      epoch: opts.epoch,
    });
    if (this.sendEpoch) opts.onEpoch?.(this.epoch);
    if (opts.lastEventId !== undefined) {
      const reset =
        (opts.epoch !== undefined && opts.epoch !== this.epoch) ||
        opts.lastEventId >= this.nextId;
      if (reset) {
        queue.push({
          v: 1,
          type: 'state_resync_required',
          data: { reason: 'epoch_reset' },
        });
      }
      const from = reset ? 0 : opts.lastEventId;
      let n = 0;
      for (const f of this.ring) {
        if (f.id! > from) {
          queue.push(f);
          n++;
        }
      }
      queue.push({ v: 1, type: 'replay_complete', data: { replayedCount: n } });
    }
    const onAbort = () => sub.push('end');
    opts.signal?.addEventListener('abort', onAbort);
    try {
      for (;;) {
        while (queue.length === 0) {
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
        const next = queue.shift()!;
        if (next === 'end') return;
        if (next instanceof Error) throw next;
        yield next;
      }
    } finally {
      this.subs.delete(sub);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

type SseFrame = { id?: number; ev: { type?: string; data?: unknown } };

/** A watcher held open, its frames collected as they arrive. */
interface SseClient {
  status: number;
  frames: SseFrame[];
  ids(): number[];
  waitFor(pred: (frames: SseFrame[]) => boolean, ms?: number): Promise<void>;
  close(): void;
}

async function openWatcher(
  url: string,
  headers: Record<string, string> = {},
): Promise<SseClient> {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const frames: SseFrame[] = [];
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += decoder.decode(value, { stream: true });
          const blocks = buf.split('\n\n');
          buf = blocks.pop() ?? '';
          for (const block of blocks) {
            const lines = block.split('\n');
            const data = lines.find((l) => l.startsWith('data:'));
            if (!data) continue;
            const idLine = lines.find((l) => l.startsWith('id:'));
            frames.push({
              id: idLine ? Number(idLine.slice(3).trim()) : undefined,
              ev: JSON.parse(data.slice(5).trim()),
            });
          }
        }
      } catch {
        // aborted by close()
      }
    })();
  }
  return {
    status: res.status,
    frames,
    ids: () =>
      frames.filter((f) => f.id !== undefined).map((f) => f.id as number),
    async waitFor(pred, ms = 3000) {
      const deadline = Date.now() + ms;
      while (!pred(frames)) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out; frames so far: ${JSON.stringify(frames.map((f) => [f.id, f.ev.type]))}`,
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close: () => ac.abort(),
  };
}

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const joined = (fs: SseFrame[]) =>
  fs.some((f) => f.ev.type === 'client_joined');

async function mountFanout(
  bus: FakeBusDaemon,
  walDir: string,
  hubGraceMs = 100,
): Promise<string> {
  const app = express();
  app.get(
    '/session/:id/events',
    createSessionEventsRoute(
      bus as unknown as DaemonClient,
      new ConnectionRegistry(),
      undefined,
      undefined,
      walDir,
      undefined,
      undefined,
      50, // idleAttachMs: the fake bus is silent until a test publishes
      undefined,
      undefined,
      hubGraceMs,
    ),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('session-events fan-out: one daemon subscription per session (#174)', () => {
  const clients: SseClient[] = [];
  afterEach(() => {
    for (const c of clients.splice(0)) c.close();
    // A watcher closed mid-test leaves the client's spare keep-alive sockets
    // behind, which would hold the gateway's close() for the 5s keep-alive.
    gateway?.closeAllConnections();
  });
  const watch = async (url: string, headers?: Record<string, string>) => {
    const c = await openWatcher(url, headers);
    clients.push(c);
    return c;
  };

  it('two concurrent watchers see the same ids and the WAL holds each frame once', async () => {
    // The probe from the audit: phone saw 1,3,5, laptop 2,4,6, and the WAL held
    // every frame twice, because each watcher ran its own daemon subscription
    // against one shared epoch and one WAL.
    const sid = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
    const bus = new FakeBusDaemon();
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-fan-'));
    const url = `${await mountFanout(bus, walDir)}/session/${sid}/events`;

    const phone = await watch(url);
    const laptop = await watch(url);
    await phone.waitFor(joined);
    await laptop.waitFor(joined);

    bus.publish('one');
    bus.publish('two');
    bus.publish('three');
    await phone.waitFor(() => phone.ids().length >= 3);
    await laptop.waitFor(() => laptop.ids().length >= 3);

    expect(phone.ids()).toEqual([1, 2, 3]);
    expect(laptop.ids()).toEqual([1, 2, 3]);
    expect(bus.subscriptions).toHaveLength(1);
    const wal = new SessionWal({ dir: walDir, sessionId: sid });
    expect(wal.replayFrom(0).events.map((f) => f.id)).toEqual([1, 2, 3]);
    wal.close();
  });

  it('a watcher joining late resumes from its own Last-Event-ID on the shared subscription', async () => {
    const sid = 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
    const bus = new FakeBusDaemon();
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-fan-'));
    const url = `${await mountFanout(bus, walDir)}/session/${sid}/events`;

    const first = await watch(url);
    await first.waitFor(joined);
    bus.publish('one');
    bus.publish('two');
    await first.waitFor(() => first.ids().length >= 2);

    // Saw 1 before it dropped: the WAL hands it 2, then the live stream.
    const late = await watch(url, { 'Last-Event-ID': '1' });
    await late.waitFor((fs) => fs.some((f) => f.ev.type === 'replay_complete'));
    // A watcher with no cursor asked for no history, as with the daemon.
    const live = await watch(url);
    await live.waitFor(joined);

    bus.publish('three');
    for (const c of [first, late, live]) {
      await c.waitFor(() => c.ids().includes(3));
    }

    expect(first.ids()).toEqual([1, 2, 3]);
    expect(late.ids()).toEqual([2, 3]);
    expect(live.ids()).toEqual([3]);
    // Its own replay is closed by its own sentinel, after the replayed frame
    // and before the live one.
    const order = late.frames
      .filter((f) => f.id !== undefined || f.ev.type === 'replay_complete')
      .map((f) => f.id ?? 'replay_complete');
    expect(order).toEqual([2, 'replay_complete', 3]);
    expect(bus.subscriptions).toHaveLength(1);
    const wal = new SessionWal({ dir: walDir, sessionId: sid });
    expect(wal.replayFrom(0).events.map((f) => f.id)).toEqual([1, 2, 3]);
    wal.close();
  });

  it('a watcher leaving keeps the others fed; the last one leaving closes the upstream after the grace', async () => {
    const sid = 'a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3';
    const bus = new FakeBusDaemon();
    const walDir = mkdtempSync(join(tmpdir(), 'rc-se-fan-'));
    const url = `${await mountFanout(bus, walDir, 150)}/session/${sid}/events`;

    const stay = await watch(url);
    const leave = await watch(url);
    await stay.waitFor(joined);
    await leave.waitFor(joined);
    bus.publish('one');
    await leave.waitFor(() => leave.ids().includes(1));

    leave.close();
    bus.publish('two');
    await stay.waitFor(() => stay.ids().includes(2));
    expect(stay.ids()).toEqual([1, 2]);
    expect(bus.liveSubscribers).toBe(1);

    // The last watcher leaves and comes back inside the grace: same upstream.
    stay.close();
    await new Promise((r) => setTimeout(r, 30));
    const back = await watch(url, { 'Last-Event-ID': '2' });
    await back.waitFor(joined);
    bus.publish('three');
    await back.waitFor(() => back.ids().includes(3));
    expect(bus.subscriptions).toHaveLength(1);

    // Gone for longer than the grace: the upstream subscription is closed.
    back.close();
    await until(() => bus.liveSubscribers === 0, 2000);
    expect(bus.subscriptions).toHaveLength(1);

    const wal = new SessionWal({ dir: walDir, sessionId: sid });
    expect(wal.replayFrom(0).events.map((f) => f.id)).toEqual([1, 2, 3]);
    wal.close();
  });
});

describe('watch presence join/leave (#40)', () => {
  // Distinct valid 32-hex id so it can't collide with SESS fixtures.
  const WP_SID = '22222222222222222222222222222222';

  it('joins on attach and leaves when the stream ends', async () => {
    stub = await startStubDaemon({
      frames: [{ id: 1, type: 'session_update', data: { text: 'one' } }],
      holdOpenMs: 100,
    });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const wp = new WatchPresence();
    const app = express();
    app.get(
      '/session/:id/events',
      createSessionEventsRoute(
        daemon,
        new ConnectionRegistry(),
        undefined,
        undefined,
        undefined,
        undefined,
        wp,
      ),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    gateway = server;
    const { port } = server.address() as AddressInfo;
    const res = await fetch(
      `http://127.0.0.1:${port}/session/${WP_SID}/events`,
    );
    expect(res.status).toBe(200);
    // fetch resolved once 200 headers flushed; the route joins presence
    // before headers are written, so the mid-stream state is already set.
    expect(wp.isWatched(WP_SID)).toBe(true);
    await res.text(); // stream ends when the stub's holdOpenMs lapses
    const deadline = Date.now() + 2000;
    while (wp.isWatched(WP_SID) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(wp.isWatched(WP_SID)).toBe(false); // leave ran in the route finally
  });
});
