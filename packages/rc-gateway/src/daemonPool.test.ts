/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DaemonPool,
  UnknownSessionError,
  WorkspacePoolFullError,
  type DaemonExitInfo,
  type PooledDaemonSpawn,
} from './daemonPool.js';
import type { AuditEntry } from './auditLog.js';
import { RecoveryOrchestrator } from './recovery/orchestrator.js';
import type { DaemonClient, DaemonEvent } from '@qwen-code/sdk';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';

/** Default no-op event stream: yields nothing. */
async function* noEvents(): AsyncGenerator<DaemonEvent> {
  /* empty */
}

function fakeClient(
  tag: string,
  sid?: string,
  events: () => AsyncGenerator<DaemonEvent> = noEvents,
  /** When set, `createOrAttachSession` awaits this before resolving —
   * lets tests hold a create call open mid-flight to reproduce races. */
  createGate?: Promise<void>,
) {
  return {
    tag,
    async createOrAttachSession() {
      if (createGate) await createGate;
      return {
        sessionId: sid ?? `${tag}-s`,
        workspaceCwd: tag,
        attached: false,
      };
    },
    async sessionContext(id: string) {
      return { calledOn: tag, id };
    },
    async closeSession(id: string) {
      return { ended: true, id };
    },
    async prompt(id: string) {
      return { calledOn: tag, id };
    },
    async respondToSessionPermission() {
      return true;
    },
    async rewindSession(id: string, promptId: string) {
      return { calledOn: tag, id, promptId };
    },
    async getRewindSnapshots(id: string) {
      return { calledOn: tag, id, snapshots: [] };
    },
    async sessionSupportedCommands(id: string) {
      return { calledOn: tag, id };
    },
    async setSessionApprovalMode(id: string) {
      return { calledOn: tag, id };
    },
    async loadSession(id: string) {
      // Same restored shape as resumeSession: pool.resumeSession restores
      // through THIS method (no-history bug, #37), so resume tests assert on
      // sessionId here too.
      return {
        calledOn: tag,
        sessionId: id,
        workspaceCwd: tag,
        attached: true,
      };
    },
    async resumeSession(id: string) {
      return { sessionId: id, workspaceCwd: tag, attached: true };
    },
    async health() {
      return { calledOn: tag };
    },
    async capabilities() {
      return { calledOn: tag };
    },
    async listWorkspaceSessions() {
      return [{ calledOn: tag }];
    },
    subscribeEvents: events,
  } as unknown as DaemonClient;
}

function makePool(spawnLog: string[]) {
  return new DaemonPool({
    defaultDaemon: fakeClient('default'),
    defaultWorkspaceCwd: '/home/evan',
    spawn: async (cwd) => {
      spawnLog.push(cwd);
      return {
        client: fakeClient(cwd),
        stop: async () => {},
        workspaceCwd: cwd,
      };
    },
  });
}

describe('DaemonPool', () => {
  it('spawns one daemon per workspace and reuses it', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const a1 = await pool.getOrSpawn('/proj/a');
    const a2 = await pool.getOrSpawn('/proj/a');
    const b1 = await pool.getOrSpawn('/proj/b');
    expect(a1).toBe(a2); // reused
    expect(a1).not.toBe(b1);
    expect(log).toEqual(['/proj/a', '/proj/b']); // spawned once each
    expect(pool.size()).toBe(2);
  });

  it('returns the default daemon when cwd is omitted or the default workspace', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const d1 = await pool.getOrSpawn();
    const d2 = await pool.getOrSpawn('/home/evan');
    expect((d1 as unknown as { tag: string }).tag).toBe('default');
    expect((d2 as unknown as { tag: string }).tag).toBe('default');
    expect(log).toEqual([]); // never spawned
  });

  it('dedupes concurrent spawns for the same new workspace', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const [c1, c2] = await Promise.all([
      pool.getOrSpawn('/proj/c'),
      pool.getOrSpawn('/proj/c'),
    ]);
    expect(c1).toBe(c2);
    expect(log).toEqual(['/proj/c']);
    expect(pool.size()).toBe(1);
    expect(pool.workspaces()).toEqual(['/proj/c']);
  });

  it('lets a failed spawn be retried on the next getOrSpawn (no stuck entry)', async () => {
    const log: string[] = [];
    let attempt = 0;
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => {
        log.push(cwd);
        attempt++;
        if (attempt === 1) throw new Error('boom: spawn failed');
        return {
          client: fakeClient(cwd),
          stop: async () => {},
          workspaceCwd: cwd,
        };
      },
    });
    await expect(pool.getOrSpawn('/proj/flaky')).rejects.toThrow(/boom/);
    // Retry should actually re-invoke spawn, not hang or return a stale rejection.
    const client = await pool.getOrSpawn('/proj/flaky');
    expect((client as unknown as { tag: string }).tag).toBe('/proj/flaky');
    expect(log).toEqual(['/proj/flaky', '/proj/flaky']);
    expect(pool.size()).toBe(1);
  });

  it('routes a session-keyed call to the daemon that created the session', async () => {
    const pool = makePool([]); // spawn returns fakeClient(cwd)
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    const ctx = (await pool.sessionContext(s.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/proj/a');
  });

  it('resumeSession routes to the workspace daemon and records ownership', async () => {
    const pool = makePool([]); // fake spawn returns fakeClient(cwd) with resumeSession + sessionContext
    const r = await pool.resumeSession('sess-old', { workspaceCwd: '/proj/a' });
    expect(r.sessionId).toBe('sess-old');
    expect(pool.size()).toBe(1); // spawned /proj/a
    const ctx = (await pool.sessionContext('sess-old')) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/proj/a'); // now routes to /proj/a
  });

  it('resumeSession on the default workspace cwd routes to the default daemon (no spawn)', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const r = await pool.resumeSession('sess-old', {
      workspaceCwd: '/home/evan/',
    });
    expect(r.sessionId).toBe('sess-old');
    expect(log).toEqual([]); // never spawned
    const ctx = (await pool.sessionContext('sess-old')) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('default');
  });

  it('resumeSession restores via loadSession, not resumeSession (no-history bug, #37)', async () => {
    const loadCalls: Array<[string, unknown]> = [];
    const resumeCalls: Array<[string, unknown]> = [];
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: {
          ...fakeClient(cwd),
          async loadSession(id: string, req?: unknown) {
            loadCalls.push([id, req]);
            return { sessionId: id, workspaceCwd: cwd, attached: true };
          },
          async resumeSession(id: string, req?: unknown) {
            resumeCalls.push([id, req]);
            return { sessionId: id, workspaceCwd: cwd, attached: true };
          },
        } as unknown as DaemonClient,
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    const r = await pool.resumeSession('sess-old', {
      workspaceCwd: '/proj/a',
    });
    expect(r.sessionId).toBe('sess-old');
    // The daemon's load action seeds the session's event bus with the full
    // transcript before responding; ACP's resume action never replays
    // history, so a cursor-0 watcher after resume would see an empty stream.
    expect(resumeCalls).toEqual([]);
    expect(loadCalls).toEqual([['sess-old', { workspaceCwd: '/proj/a' }]]);
  });

  it('does not evict an entry mid-resumeSession; the pending reservation protects it from a concurrent cap eviction', async () => {
    const t = 0;
    const stopped: string[] = [];
    let releaseResume: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const pool = new DaemonPool({
      now: () => t,
      maxDaemons: 1,
      idleReapMs: 999_999_999,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: {
          ...fakeClient(cwd, `${cwd}-s`),
          // pool.resumeSession restores via loadSession (#37) -- gate THAT.
          async loadSession(id: string) {
            if (cwd === '/proj/a') await gate;
            return { sessionId: id, workspaceCwd: cwd, attached: true };
          },
        } as unknown as DaemonClient,
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });

    await pool.getOrSpawn('/proj/a'); // spawns an idle entry (sessions.size === 0)
    // Kick off a resume against /proj/a; its client.loadSession hangs on
    // `gate`, so this call is stuck mid-registration.
    const resumePromise = pool.resumeSession('sess-old', {
      workspaceCwd: '/proj/a',
    });

    // At cap (maxDaemons=1). /proj/a still LOOKS idle by session count
    // alone, but it's mid-resume (pending > 0) -- must be treated as busy
    // and NOT evicted to make room for a new workspace.
    await expect(pool.getOrSpawn('/proj/b')).rejects.toBeInstanceOf(
      WorkspacePoolFullError,
    );
    expect(stopped).toEqual([]); // never stopped
    expect(pool.workspaces()).toEqual(['/proj/a']); // still present

    releaseResume!();
    const restored = await resumePromise;
    expect(restored.sessionId).toBe('sess-old');
    expect(pool.workspaces()).toEqual(['/proj/a']); // untouched throughout
  });

  it('routes every session-keyed method to the owning daemon', async () => {
    const pool = makePool([]);
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    const id = s.sessionId;

    const prompt = (await pool.prompt(id, { prompt: [] })) as unknown as {
      calledOn: string;
    };
    expect(prompt.calledOn).toBe('/proj/a');

    const ok = await pool.respondToSessionPermission(id, 'req-1', {
      outcome: 'selected',
      optionId: 'allow',
    } as never);
    expect(ok).toBe(true);

    const rewind = (await pool.rewindSession(id, 'prompt-0')) as unknown as {
      calledOn: string;
      promptId: string;
    };
    expect(rewind.calledOn).toBe('/proj/a');
    expect(rewind.promptId).toBe('prompt-0');

    const snapshots = (await pool.getRewindSnapshots(id)) as unknown as {
      calledOn: string;
    };
    expect(snapshots.calledOn).toBe('/proj/a');

    const cmds = (await pool.sessionSupportedCommands(id)) as unknown as {
      calledOn: string;
    };
    expect(cmds.calledOn).toBe('/proj/a');

    const mode = (await pool.setSessionApprovalMode(
      id,
      'default' as never,
    )) as unknown as { calledOn: string };
    expect(mode.calledOn).toBe('/proj/a');

    const loaded = (await pool.loadSession(id)) as unknown as {
      calledOn: string;
    };
    expect(loaded.calledOn).toBe('/proj/a');
  });

  it('routes daemon-global calls to the default daemon', async () => {
    const pool = makePool([]);
    const h = (await pool.health()) as unknown as { calledOn: string };
    expect(h.calledOn).toBe('default');
    const c = (await pool.capabilities()) as unknown as { calledOn: string };
    expect(c.calledOn).toBe('default');
    const list = (await pool.listWorkspaceSessions(
      '/proj/a',
    )) as unknown as Array<{ calledOn: string }>;
    expect(list[0].calledOn).toBe('default');
  });

  it('resolves session ids created on the default daemon (never reaped)', async () => {
    const pool = makePool([]);
    const s = await pool.createOrAttachSession({});
    const ctx = (await pool.sessionContext(s.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('default');
  });

  it('throws UnknownSessionError for an unrecorded id', async () => {
    const pool = makePool([]);
    await expect(pool.sessionContext('nope')).rejects.toThrow(
      /unknown session/i,
    );
    await expect(pool.sessionContext('nope')).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('throws UnknownSessionError once the owning daemon has been reaped', async () => {
    let t = 0;
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`),
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await pool.closeSession(s.sessionId);
    t = 10_000;
    pool.reapIdle();
    expect(pool.size()).toBe(0);
    await expect(pool.sessionContext(s.sessionId)).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('removes the session id from its entry on endSession success', async () => {
    let t = 0;
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`),
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await pool.closeSession(s.sessionId);
    // The entry itself should still exist (not reaped yet) but be idle.
    expect(pool.size()).toBe(1);
    t = 10_000;
    pool.reapIdle();
    expect(pool.size()).toBe(0);
  });

  it('reaps an idle daemon after idleReapMs; never one with live sessions', async () => {
    let t = 0;
    const stopped: string[] = [];
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    t = 5000;
    pool.reapIdle(); // has a live session -> kept
    expect(pool.size()).toBe(1);
    expect(stopped).toEqual([]);
    await pool.closeSession(s.sessionId);
    t = 10_000;
    pool.reapIdle(); // now idle -> reaped
    expect(pool.size()).toBe(0);
    expect(stopped).toEqual(['/proj/a']); // stop() was actually invoked
  });

  it('at cap, evicts the LRU idle daemon; throws when all are busy', async () => {
    let t = 0;
    const stopped: string[] = [];
    const pool = new DaemonPool({
      now: () => t,
      maxDaemons: 2,
      idleReapMs: 999_999_999,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });

    t = 1000;
    await pool.getOrSpawn('/proj/a'); // idle, lastUsed=1000
    t = 2000;
    await pool.getOrSpawn('/proj/b'); // idle, lastUsed=2000
    expect(pool.size()).toBe(2);

    // At cap (2). /proj/a is the LRU idle entry -> should be evicted to
    // make room for /proj/c.
    t = 3000;
    await pool.getOrSpawn('/proj/c');
    expect(pool.size()).toBe(2);
    expect(pool.workspaces().sort()).toEqual(['/proj/b', '/proj/c']);
    expect(stopped).toEqual(['/proj/a']);

    // Now occupy both remaining entries with live sessions so neither is
    // idle; a third new workspace must fail with WorkspacePoolFullError.
    const sb = await pool.createOrAttachSession({ workspaceCwd: '/proj/b' });
    const sc = await pool.createOrAttachSession({ workspaceCwd: '/proj/c' });
    expect(sb.sessionId).toBeTruthy();
    expect(sc.sessionId).toBeTruthy();

    await expect(pool.getOrSpawn('/proj/d')).rejects.toBeInstanceOf(
      WorkspacePoolFullError,
    );
  });

  it('prunes a session on a session_died frame observed via subscribeEvents, letting the entry become reapable', async () => {
    let t = 0;
    const stopped: string[] = [];
    async function* diedEvents(): AsyncGenerator<DaemonEvent> {
      yield {
        v: 1,
        type: 'session_died',
        data: { sessionId: 'ignored-by-pool', reason: 'crashed' },
      } as DaemonEvent;
    }
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`, diedEvents),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    expect(pool.size()).toBe(1);

    // Drain the wrapped subscription; the session_died frame passing
    // through should prune the session from the entry's live-sessions set.
    const seenTypes: string[] = [];
    for await (const ev of pool.subscribeEvents(s.sessionId)) {
      seenTypes.push(ev.type);
    }
    expect(seenTypes).toEqual(['session_died']);

    // Entry still exists (only idle-timeout reaps it), but is now idle.
    expect(pool.size()).toBe(1);
    expect(stopped).toEqual([]);
    t = 5000;
    pool.reapIdle();
    expect(pool.size()).toBe(0);
    expect(stopped).toEqual(['/proj/a']);

    // The pruned id no longer resolves at all -- confirms it's out of
    // `ownerOf`, not just out of the (now-deleted) entry's `sessions`.
    await expect(pool.sessionContext(s.sessionId)).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('prunes on a session_closed frame (the other SDK-defined session-lifecycle terminal)', async () => {
    let t = 0;
    const stopped: string[] = [];
    async function* closedEvents(): AsyncGenerator<DaemonEvent> {
      yield {
        v: 1,
        type: 'session_closed',
        data: { sessionId: 'ignored-by-pool', reason: 'client_close' },
      } as DaemonEvent;
    }
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`, closedEvents),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    for await (const _ev of pool.subscribeEvents(s.sessionId)) {
      /* drain */
    }
    t = 5000;
    pool.reapIdle();
    expect(pool.size()).toBe(0);
    expect(stopped).toEqual(['/proj/a']);
    await expect(pool.sessionContext(s.sessionId)).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('does NOT prune on a client_evicted frame -- it describes stream liveness, not session liveness', async () => {
    let t = 0;
    async function* evictedEvents(): AsyncGenerator<DaemonEvent> {
      yield {
        v: 1,
        type: 'client_evicted',
        data: { reason: 'slow_client' },
      } as DaemonEvent;
    }
    const pool = new DaemonPool({
      now: () => t,
      idleReapMs: 1000,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd, `${cwd}-s`, evictedEvents),
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    for await (const _ev of pool.subscribeEvents(s.sessionId)) {
      /* drain */
    }
    // The session should still be considered live -- client_evicted only
    // means THIS stream got dropped, not that the daemon session ended --
    // so reapIdle must NOT reclaim the entry even past idleReapMs, and the
    // session id must still resolve.
    t = 5000;
    pool.reapIdle();
    expect(pool.size()).toBe(1);
    const ctx = (await pool.sessionContext(s.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/proj/a');
  });

  it('does not evict an entry mid-createOrAttachSession; the pending reservation protects it from a concurrent cap eviction', async () => {
    const t = 0;
    const stopped: string[] = [];
    let releaseCreate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const pool = new DaemonPool({
      now: () => t,
      maxDaemons: 1,
      idleReapMs: 999_999_999,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(
          cwd,
          `${cwd}-s`,
          noEvents,
          cwd === '/proj/a' ? gate : undefined,
        ),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });

    await pool.getOrSpawn('/proj/a'); // spawns an idle entry (sessions.size === 0)
    // Kick off a create against /proj/a; its client.createOrAttachSession
    // hangs on `gate`, so this call is stuck mid-registration.
    const createPromise = pool.createOrAttachSession({
      workspaceCwd: '/proj/a',
    });

    // At cap (maxDaemons=1). /proj/a still LOOKS idle by session count
    // alone, but it's mid-create (pending > 0) -- must be treated as busy
    // and NOT evicted to make room for a new workspace.
    await expect(pool.getOrSpawn('/proj/b')).rejects.toBeInstanceOf(
      WorkspacePoolFullError,
    );
    expect(stopped).toEqual([]); // never stopped
    expect(pool.workspaces()).toEqual(['/proj/a']); // still present

    releaseCreate!();
    const session = await createPromise;
    expect(session.sessionId).toBe('/proj/a-s');
    expect(pool.workspaces()).toEqual(['/proj/a']); // untouched throughout
  });

  it('stopAll() stops every pooled daemon and empties the pool', async () => {
    const stopped: string[] = [];
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });

    await pool.getOrSpawn('/proj/a');
    await pool.getOrSpawn('/proj/b');
    expect(pool.size()).toBe(2);

    await pool.stopAll();

    expect(stopped.sort()).toEqual(['/proj/a', '/proj/b']);
    expect(pool.size()).toBe(0);
    expect(pool.workspaces()).toEqual([]);
  });

  it('stopAll() tolerates an individual entry stop() rejecting', async () => {
    const stopped: string[] = [];
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: fakeClient(cwd),
        stop: async () => {
          if (cwd === '/proj/flaky') throw new Error('stop failed');
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });

    await pool.getOrSpawn('/proj/flaky');
    await pool.getOrSpawn('/proj/ok');

    // One entry's stop() rejects; the other must still be asked to stop, and
    // stopAll() itself must not reject.
    await expect(pool.stopAll()).resolves.toBeUndefined();
    expect(stopped).toEqual(['/proj/ok']);
    expect(pool.size()).toBe(0);
  });

  it('normalizes the workspace cwd: /proj/a and /proj/a/ share one entry (no duplicate spawn)', async () => {
    const log: string[] = [];
    const pool = makePool(log);
    const a1 = await pool.getOrSpawn('/proj/a');
    const a2 = await pool.getOrSpawn('/proj/a/');
    expect(a1).toBe(a2);
    expect(log).toEqual(['/proj/a']); // spawned exactly once
    expect(pool.size()).toBe(1);
    expect(pool.workspaces()).toEqual(['/proj/a']);
  });

  it('routes a create with a trailing-slash default workspace cwd to the default daemon (no spawn)', async () => {
    const log: string[] = [];
    const pool = makePool(log); // defaultWorkspaceCwd: '/home/evan'
    const session = await pool.createOrAttachSession({
      workspaceCwd: '/home/evan/',
    });
    expect(log).toEqual([]); // never spawned -- routed straight to default
    const ctx = (await pool.sessionContext(session.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('default');
  });

  it('counts in-flight spawns against the cap: concurrent distinct-cwd creates cannot exceed maxDaemons', async () => {
    const gates = new Map<string, () => void>();
    const spawnLog: string[] = [];
    const pool = new DaemonPool({
      maxDaemons: 2,
      idleReapMs: 999_999_999,
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => {
        spawnLog.push(cwd);
        if (cwd === '/proj/new1' || cwd === '/proj/new2') {
          // Hang this spawn open so it stays "in flight" long enough for
          // the second concurrent getOrSpawn's cap check to observe it.
          await new Promise<void>((resolve) => gates.set(cwd, resolve));
        }
        return {
          client: fakeClient(cwd, `${cwd}-s`),
          stop: async () => {},
          workspaceCwd: cwd,
        };
      },
    });

    // Occupy one of the two cap slots with a BUSY entry (has a live
    // session, so it can never be the LRU-idle eviction victim).
    await pool.createOrAttachSession({ workspaceCwd: '/proj/busy' });
    expect(pool.size()).toBe(1);

    // Two concurrent getOrSpawn calls for two DISTINCT NEW cwds. Without
    // counting in-flight spawns, byWorkspace.size() alone (1, still below
    // maxDaemons=2) would let both pass the cap check and both spawn --
    // landing 3 pooled daemons against a cap of 2.
    const p1 = pool.getOrSpawn('/proj/new1');
    await expect(pool.getOrSpawn('/proj/new2')).rejects.toBeInstanceOf(
      WorkspacePoolFullError,
    );
    // The rejected call must never have reached spawn() for /proj/new2.
    expect(spawnLog).toEqual(['/proj/busy', '/proj/new1']);

    gates.get('/proj/new1')!();
    const client1 = await p1;
    expect((client1 as unknown as { tag: string }).tag).toBe('/proj/new1');
    expect(pool.size()).toBe(2); // /proj/busy + /proj/new1 only
  });

  it('stopAll(): a spawn that resolves after stopAll() does not leak into the pool', async () => {
    let releaseSpawn: (() => void) | undefined;
    const stopped: string[] = [];
    const gate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      // stopAll() now waits on the in-flight spawn, and this test only lets it
      // settle after stopAll has returned, so the drain runs out its bound here.
      // Kept short; the bound itself is the next test's business.
      probeTimeoutMs: 40,
      spawn: async (cwd) => {
        await gate;
        return {
          client: fakeClient(cwd),
          stop: async () => {
            stopped.push(cwd);
          },
          workspaceCwd: cwd,
        };
      },
    });

    const spawnPromise = pool.getOrSpawn('/proj/late');
    // Shut the pool down WHILE the spawn above is still in flight.
    await pool.stopAll();
    // Now let the spawn resolve, after shutdown already ran.
    releaseSpawn!();
    const client = await spawnPromise;

    expect((client as unknown as { tag: string }).tag).toBe('/proj/late');
    expect(stopped).toEqual(['/proj/late']); // stop() was invoked on it
    expect(pool.size()).toBe(0); // never registered into the cleared pool
    expect(pool.workspaces()).toEqual([]);
  });

  // The gateway's shutdown is `await daemonPool.stopAll()` and then
  // `process.exit(0)`, with nothing between them, so a self-stop that lands
  // after stopAll resolves is a stop that never runs. The daemon it belongs to
  // was spawned detached and keeps its port and its token.
  it('stopAll() waits for an in-flight spawn, so its self-stop runs before the exit', async () => {
    let releaseSpawn: (() => void) | undefined;
    const stopped: string[] = [];
    const gate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      // Long on purpose: the only way this resolves early is by genuinely
      // waiting for the spawn rather than running out a bound.
      probeTimeoutMs: 5_000,
      spawn: async (cwd) => {
        await gate;
        // A later macrotask, so stopAll cannot reach the self-stop by draining
        // the microtask queue on its way out.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          client: fakeClient(cwd),
          stop: async () => {
            stopped.push(cwd);
          },
          workspaceCwd: cwd,
        };
      },
    });

    const spawnPromise = pool.getOrSpawn('/proj/draining');
    const stopping = pool.stopAll();
    releaseSpawn!();
    await stopping;

    expect(stopped).toEqual(['/proj/draining']);
    await spawnPromise;
  });

  it('stopAll() gives up on a spawn that never settles instead of hanging shutdown', async () => {
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      probeTimeoutMs: 40,
      spawn: async (cwd) => {
        await new Promise<void>(() => {});
        return {
          client: fakeClient(cwd),
          stop: async () => {},
          workspaceCwd: cwd,
        };
      },
    });

    pool.getOrSpawn('/proj/wedged').catch(() => {});
    const started = Date.now();
    await pool.stopAll();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

// -- Death detection (add-mid-turn-recovery) ---------------------------

interface ExitHandle {
  cwd: string;
  fire: (info?: DaemonExitInfo) => void;
}

interface DeathHarness {
  pool: DaemonPool;
  /** One handle per SPAWN, in spawn order (index 0 = first spawn). */
  exits: ExitHandle[];
  auditRows: AuditEntry[];
  deaths: Array<{
    key: string;
    sessions: string[];
    exit: { code: number | null; signal: NodeJS.Signals | null; atMs: number };
  }>;
  /** Fire the LATEST spawn's exit for `cwd` (the common case). */
  fireExit: (cwd: string, info?: DaemonExitInfo) => void;
  /** Fire a SPECIFIC spawn's exit (e.g. a stale one, by spawn index). */
  fireExitAt: (index: number, info?: DaemonExitInfo) => void;
}

const DEFAULT_EXIT: DaemonExitInfo = { code: null, signal: 'SIGKILL' };

/** A pool whose spawn captures the pool-filled `onExit` callback (late-
 * bound, so the pool can set it after `spawn()` resolves), an audit
 * recorder that captures rows, and an `onDaemonDeath` hook that captures
 * invocations. */
function makeDeathHarness(
  opts: {
    now?: () => number;
    maxDaemons?: number;
    idleReapMs?: number;
    client?: (cwd: string) => unknown;
    /** The boot daemon (default: a plain fake tagged 'default'). */
    defaultClient?: unknown;
    /** Records every pooled daemon `stop()` by cwd. */
    stopped?: string[];
  } = {},
): DeathHarness {
  const exits: ExitHandle[] = [];
  const auditRows: AuditEntry[] = [];
  const deaths: DeathHarness['deaths'] = [];
  const pool = new DaemonPool({
    defaultDaemon: (opts.defaultClient ??
      fakeClient('default')) as DaemonClient,
    defaultWorkspaceCwd: '/home/evan',
    maxDaemons: opts.maxDaemons,
    idleReapMs: opts.idleReapMs ?? 999_999_999,
    now: opts.now,
    spawn: async (cwd) => {
      const out: PooledDaemonSpawn = {
        client: (opts.client
          ? opts.client(cwd)
          : fakeClient(cwd, `${cwd}-s`)) as DaemonClient,
        stop: async () => {
          opts.stopped?.push(cwd);
        },
        workspaceCwd: cwd,
        endpoint: {
          url: `http://127.0.0.1:5${exits.length}00`,
          token: `tok-${cwd}-${exits.length}`,
          workspaceCwd: cwd,
        },
      };
      exits.push({
        cwd,
        fire: (info = DEFAULT_EXIT) => out.onExit?.(info),
      });
      return out;
    },
    onDaemonDeath: (key, sessions, exit) => {
      deaths.push({ key, sessions, exit });
    },
  });
  pool.setAudit({
    record: async (e) => {
      auditRows.push(e);
    },
  });
  return {
    pool,
    exits,
    auditRows,
    deaths,
    fireExit: (cwd, info) => {
      const idx = exits.map((e) => e.cwd).lastIndexOf(cwd);
      if (idx >= 0) exits[idx].fire(info);
    },
    fireExitAt: (index, info) => exits[index]?.fire(info),
  };
}

describe('DaemonPool death detection', () => {
  it('removes a dead entry immediately, freeing the cap slot for a new workspace', async () => {
    const h = makeDeathHarness({ maxDaemons: 1 });
    const s = await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    expect(h.pool.size()).toBe(1);
    // At cap with the sole entry BUSY (a live session) → a new workspace
    // would 503 while the daemon is alive.
    await expect(h.pool.getOrSpawn('/proj/b')).rejects.toBeInstanceOf(
      WorkspacePoolFullError,
    );
    h.fireExit('/proj/a', { code: 1, signal: null });
    expect(h.pool.size()).toBe(0); // entry removed immediately
    // The freed slot lets a new workspace spawn.
    const b = await h.pool.getOrSpawn('/proj/b');
    expect((b as unknown as { tag: string }).tag).toBe('/proj/b');
    // The death hook received the affected session; the audit row is there.
    expect(h.deaths).toHaveLength(1);
    expect(h.deaths[0].key).toBe('/proj/a');
    expect(h.deaths[0].sessions).toEqual([s.sessionId]);
    expect(h.auditRows).toHaveLength(1);
  });

  it('is idempotent under a double trigger (exit + duplicate exit): one hook, one audit row', async () => {
    const h = makeDeathHarness();
    await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    h.fireExit('/proj/a', { code: null, signal: 'SIGKILL' });
    h.fireExit('/proj/a', { code: null, signal: 'SIGKILL' }); // late duplicate
    expect(h.deaths).toHaveLength(1);
    expect(h.auditRows).toHaveLength(1);
    expect(h.pool.size()).toBe(0);
  });

  it('collects affected sessions as entry.sessions ∪ ownerOf (the union guards one-sided ids)', async () => {
    const h = makeDeathHarness();
    const s = await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    // An id `ownerOf` knows but the entry's `sessions` set no longer holds
    // (one-sided recording). Reach into the private map via a cast.
    const ownerOf = (h.pool as unknown as { ownerOf: Map<string, string> })
      .ownerOf;
    ownerOf.set('orphan-sess', '/proj/a');
    h.fireExit('/proj/a', { code: null, signal: 'SIGKILL' });
    expect(h.deaths).toHaveLength(1);
    expect(h.deaths[0].sessions.sort()).toEqual([
      s.sessionId, // '/proj/a-s' — '/' sorts before letters
      'orphan-sess',
    ]);
    expect(h.auditRows[0].detail).toEqual({
      exitCode: null,
      signal: 'SIGKILL',
      sessionCount: 2,
    });
    // Both ids are scrubbed: they 404 until recovery re-registers them.
    await expect(h.pool.sessionContext(s.sessionId)).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
    await expect(h.pool.sessionContext('orphan-sess')).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('writes ONE daemon_died audit row: detail { exitCode, signal, sessionCount }, no workspace path', async () => {
    const h = makeDeathHarness();
    await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    h.fireExit('/proj/a', { code: null, signal: 'SIGKILL' });
    expect(h.auditRows).toHaveLength(1);
    const row = h.auditRows[0];
    expect(row.action).toBe('daemon_died');
    expect(row.detail).toEqual({
      exitCode: null,
      signal: 'SIGKILL',
      sessionCount: 1,
    });
    expect(row.target).toBeUndefined();
    expect(row.actorTokenId).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('/proj/a'); // no path leak
  });

  it('transport trigger: ECONNREFUSED from a pooled call marks the daemon dead, and the later exit event is a no-op', async () => {
    const h = makeDeathHarness({
      client: (cwd) => ({
        ...fakeClient(cwd, `${cwd}-s`),
        async prompt() {
          // fetch wraps the socket error under a TypeError with `cause`.
          throw Object.assign(new TypeError('prompt: fetch failed'), {
            cause: Object.assign(
              new Error('connect ECONNREFUSED 127.0.0.1:4181'),
              { code: 'ECONNREFUSED' },
            ),
          });
        },
      }),
    });
    const s = await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await expect(h.pool.prompt(s.sessionId, { prompt: [] })).rejects.toThrow(
      /fetch failed/,
    );
    expect(h.pool.size()).toBe(0); // marked dead on the transport error
    expect(h.deaths).toHaveLength(1);
    expect(h.auditRows[0].detail).toEqual({
      exitCode: null, // transport errors carry no exit info
      signal: null,
      sessionCount: 1,
    });
    // The (late) exit event is a no-op on the same death.
    h.fireExit('/proj/a', { code: 137, signal: null });
    expect(h.deaths).toHaveLength(1);
    expect(h.auditRows).toHaveLength(1);
  });

  it('app-level (non-transport) errors do NOT mark the daemon dead', async () => {
    const h = makeDeathHarness({
      client: (cwd) => ({
        ...fakeClient(cwd, `${cwd}-s`),
        async prompt() {
          throw new Error('session_not_found: no such session');
        },
      }),
    });
    const s = await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await expect(h.pool.prompt(s.sessionId, { prompt: [] })).rejects.toThrow(
      /session_not_found/,
    );
    expect(h.pool.size()).toBe(1); // still alive
    expect(h.deaths).toHaveLength(0);
    expect(h.auditRows).toHaveLength(0);
  });

  // #163: the classifier used to regex every message in the cause chain, so a
  // daemon that ANSWERED with a 500 whose text echoed an upstream socket error
  // was read as a dead process. An HTTP status means a live process answered.
  it('a DaemonHttpError whose message echoes a socket error is an answer, not a death', async () => {
    const h = makeDeathHarness({
      client: (cwd) => ({
        ...fakeClient(cwd, `${cwd}-s`),
        async prompt() {
          throw new DaemonHttpError(
            500,
            { error: 'upstream: socket hang up' },
            'POST /session/x/prompt: upstream: socket hang up',
          );
        },
        async sessionContext() {
          throw new DaemonHttpError(
            502,
            { error: 'other side closed' },
            'GET /session/x/context: other side closed',
          );
        },
      }),
    });
    const s = await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await expect(h.pool.prompt(s.sessionId, { prompt: [] })).rejects.toThrow(
      /socket hang up/,
    );
    await expect(h.pool.sessionContext(s.sessionId)).rejects.toThrow(
      /other side closed/,
    );
    expect(h.pool.size()).toBe(1);
    expect(h.deaths).toHaveLength(0);
    expect(h.auditRows).toHaveLength(0);
  });

  it('a socket error message without a socket code is not a death; the code is', async () => {
    let withCode = false;
    const h = makeDeathHarness({
      client: (cwd) => ({
        ...fakeClient(cwd, `${cwd}-s`),
        async prompt() {
          throw withCode
            ? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
            : new Error('tool output: socket hang up');
        },
      }),
    });
    const s = await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await expect(h.pool.prompt(s.sessionId, { prompt: [] })).rejects.toThrow();
    expect(h.deaths).toHaveLength(0);
    withCode = true;
    await expect(h.pool.prompt(s.sessionId, { prompt: [] })).rejects.toThrow();
    expect(h.deaths).toHaveLength(1);
  });

  it('boot daemon death flows through the same path: handleDaemonExit scrubs its sessions and writes the row', async () => {
    const h = makeDeathHarness();
    const s = await h.pool.createOrAttachSession({}); // on the default daemon
    h.pool.handleDaemonExit('/home/evan/', { code: 1, signal: null });
    expect(h.deaths).toHaveLength(1);
    expect(h.deaths[0].key).toBe('/home/evan'); // normalized
    expect(h.deaths[0].sessions).toEqual([s.sessionId]);
    expect(h.auditRows[0].detail).toEqual({
      exitCode: 1,
      signal: null,
      sessionCount: 1,
    });
    // The session 404s until recovery re-registers it.
    await expect(h.pool.sessionContext(s.sessionId)).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('a late exit of a REAPED entry is a no-op (no audit, no hook)', async () => {
    let t = 0;
    const h = makeDeathHarness({ now: () => t, idleReapMs: 1000 });
    const s = await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await h.pool.closeSession(s.sessionId);
    t = 10_000;
    h.pool.reapIdle(); // graceful: stop() + entry removed
    expect(h.pool.size()).toBe(0);
    // The child's exit event arrives after the reap already cleaned up.
    h.fireExit('/proj/a', { code: 0, signal: null });
    expect(h.deaths).toHaveLength(0);
    expect(h.auditRows).toHaveLength(0);
  });

  it('a STALE exit of a superseded entry cannot kill the respawned daemon (identity guard)', async () => {
    const h = makeDeathHarness();
    await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    h.fireExitAt(0, { code: 137, signal: null }); // first spawn's daemon dies
    expect(h.pool.size()).toBe(0);
    // Recovery respawns the same workspace → a NEW entry under the key.
    const again = await h.pool.createOrAttachSession({
      workspaceCwd: '/proj/a',
    });
    expect(h.pool.size()).toBe(1);
    // The OLD entry's exit event finally lands (delayed delivery).
    h.fireExitAt(0, { code: 137, signal: null });
    // The NEW entry must survive: no second death, session still routed.
    expect(h.deaths).toHaveLength(1);
    expect(h.auditRows).toHaveLength(1);
    expect(h.pool.size()).toBe(1);
    const ctx = (await h.pool.sessionContext(again.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/proj/a');
  });

  it('stopAll() suppresses death handling: late exits and boot exits write nothing', async () => {
    const h = makeDeathHarness();
    await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await h.pool.createOrAttachSession({}); // default daemon session
    await h.pool.stopAll();
    h.fireExit('/proj/a', { code: 1, signal: null });
    h.pool.handleDaemonExit('/home/evan', { code: 1, signal: null });
    expect(h.deaths).toHaveLength(0);
    expect(h.auditRows).toHaveLength(0);
  });

  it('setOnDaemonDeath wires the hook post-construction (the cli.ts path): a later death invokes it with key/sessions/exit', async () => {
    // Constructed WITHOUT the onDaemonDeath option — the hook arrives via
    // the setter, as cli.ts wires the recovery orchestrator after the pool
    // and orchestrator both exist.
    const spawnOuts: PooledDaemonSpawn[] = [];
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      idleReapMs: 999_999_999,
      spawn: async (cwd) => {
        const out: PooledDaemonSpawn = {
          client: fakeClient(cwd, `${cwd}-s`) as DaemonClient,
          stop: async () => {},
          workspaceCwd: cwd,
        };
        spawnOuts.push(out);
        return out;
      },
    });
    const calls: Array<{
      key: string;
      sessions: string[];
      exit: {
        code: number | null;
        signal: NodeJS.Signals | null;
        atMs: number;
      };
    }> = [];
    pool.setOnDaemonDeath((key, sessions, exit) => {
      calls.push({ key, sessions, exit });
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    expect(calls).toHaveLength(0); // no death yet
    spawnOuts[0].onExit?.({ code: 137, signal: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe('/proj/a');
    expect(calls[0].sessions).toEqual([s.sessionId]);
    expect(calls[0].exit).toMatchObject({ code: 137, signal: null });
    expect(typeof calls[0].exit.atMs).toBe('number');
  });
});

// -- The boot daemon dies (#163) -----------------------------------------
// The boot daemon used to be handed back by `getOrSpawn(default)` forever,
// dead or not, and its death was a one-shot latch. These pin that the default
// workspace is respawned the way a pooled one is, and that every death of
// whatever daemon serves it is reported once.

/** A connection-refused error the way `fetch` wraps it. */
function refused(label: string): Error {
  return Object.assign(new TypeError(`${label}: fetch failed`), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4180'), {
      code: 'ECONNREFUSED',
    }),
  });
}

/** A boot daemon that refuses every call once `dead.value` is set. */
function bootClient(dead: { value: boolean }) {
  const live = fakeClient('default', 'boot-s');
  const gate =
    <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      if (dead.value) throw refused(name);
      return fn(...a);
    };
  const c = live as unknown as Record<string, (...a: unknown[]) => unknown>;
  return {
    ...live,
    health: gate('health', c['health'] as () => Promise<unknown>),
    capabilities: gate(
      'capabilities',
      c['capabilities'] as () => Promise<unknown>,
    ),
    createOrAttachSession: gate(
      'create',
      c['createOrAttachSession'] as () => Promise<unknown>,
    ),
    loadSession: gate('load', c['loadSession'] as () => Promise<unknown>),
    sessionContext: gate(
      'context',
      c['sessionContext'] as () => Promise<unknown>,
    ),
  } as unknown as DaemonClient;
}

describe('DaemonPool boot daemon death (#163)', () => {
  it('health, capabilities and a create without cwd recover on a respawned default daemon', async () => {
    const dead = { value: false };
    const log: string[] = [];
    const h = makeDeathHarness({
      defaultClient: bootClient(dead),
      client: (cwd) => {
        log.push(cwd);
        return fakeClient(`${cwd}#respawn`, 'respawned-s');
      },
    });
    await h.pool.createOrAttachSession({});
    dead.value = true;
    h.pool.handleDaemonExit('/home/evan', { code: 1, signal: null });
    expect(h.deaths).toHaveLength(1);

    const health = (await h.pool.health()) as unknown as { calledOn: string };
    expect(health.calledOn).toBe('/home/evan#respawn');
    const caps = (await h.pool.capabilities()) as unknown as {
      calledOn: string;
    };
    expect(caps.calledOn).toBe('/home/evan#respawn');
    const s = await h.pool.createOrAttachSession({});
    expect(s.sessionId).toBe('respawned-s');
    const ctx = (await h.pool.sessionContext(s.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/home/evan#respawn');
    // One replacement, spawned for the default workspace's own cwd, and it is
    // the default rather than a pooled workspace: no cap slot, not listed.
    expect(log).toEqual(['/home/evan']);
    expect(h.pool.size()).toBe(0);
    expect(h.pool.workspaces()).toEqual([]);
  });

  it('the recovery saga respawns the default workspace and resumes its sessions in place', async () => {
    const dead = { value: false };
    const h = makeDeathHarness({ defaultClient: bootClient(dead) });
    const outcomes: Array<{ id: string; recovered: boolean }> = [];
    const orchestrator = new RecoveryOrchestrator({
      pool: h.pool,
      promptQueue: { isInFlight: () => false },
      reportOutcome: (id, o) => outcomes.push({ id, recovered: o.recovered }),
    });
    h.pool.setRecoveryProvider(orchestrator);
    const sagas: Array<Promise<void>> = [];
    h.pool.setOnDaemonDeath((key, sessions, exit) => {
      sagas.push(orchestrator.recover(key, sessions, exit));
    });
    const s = await h.pool.createOrAttachSession({});
    dead.value = true;
    h.pool.handleDaemonExit('/home/evan', { code: null, signal: 'SIGKILL' });
    await Promise.all(sagas);

    expect(outcomes).toEqual([{ id: s.sessionId, recovered: true }]);
    expect(h.pool.recoveryState(s.sessionId)).toBe('recovered');
    const ctx = (await h.pool.sessionContext(s.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/home/evan');
  });

  it('every death of the daemon serving the default workspace is reported, not only the first', async () => {
    const dead = { value: false };
    const h = makeDeathHarness({ defaultClient: bootClient(dead) });
    await h.pool.createOrAttachSession({});
    dead.value = true;
    h.pool.handleDaemonExit('/home/evan', { code: 1, signal: null });

    // A session on the respawned default daemon, then that daemon dies too.
    const second = await h.pool.createOrAttachSession({});
    h.fireExit('/home/evan', { code: null, signal: 'SIGKILL' });

    expect(h.deaths).toHaveLength(2);
    expect(h.deaths[1].key).toBe('/home/evan');
    expect(h.deaths[1].sessions).toEqual([second.sessionId]);
    expect(h.auditRows.map((r) => r.action)).toEqual([
      'daemon_died',
      'daemon_died',
    ]);
    expect(h.auditRows[1].detail).toEqual({
      exitCode: null,
      signal: 'SIGKILL',
      sessionCount: 1,
    });
    await expect(
      h.pool.sessionContext(second.sessionId),
    ).rejects.toBeInstanceOf(UnknownSessionError);
    // And the default workspace comes back a second time.
    const again = (await h.pool.health()) as unknown as { calledOn: string };
    expect(again.calledOn).toBe('/home/evan');
    expect(h.exits.map((e) => e.cwd)).toEqual(['/home/evan', '/home/evan']);
  });

  it('a transport error marks the boot daemon dead; its exit arriving later cannot kill the replacement', async () => {
    const dead = { value: false };
    const h = makeDeathHarness({ defaultClient: bootClient(dead) });
    await h.pool.createOrAttachSession({});
    dead.value = true;
    await expect(h.pool.capabilities()).rejects.toThrow(/fetch failed/);
    expect(h.deaths).toHaveLength(1);

    const s = await h.pool.createOrAttachSession({}); // on the replacement
    // The boot child's own exit event finally lands.
    h.pool.handleDaemonExit('/home/evan', { code: 1, signal: null });
    expect(h.deaths).toHaveLength(1);
    expect(h.auditRows).toHaveLength(1);
    const ctx = (await h.pool.sessionContext(s.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/home/evan');
  });

  it('a host terminal for a session on the replacement gets the replacement endpoint', async () => {
    const dead = { value: false };
    const h = makeDeathHarness({ defaultClient: bootClient(dead) });
    dead.value = true;
    h.pool.handleDaemonExit('/home/evan', { code: 1, signal: null });
    const s = await h.pool.createOrAttachSession({});
    expect(h.pool.daemonEndpointForSession(s.sessionId)).toEqual({
      url: 'http://127.0.0.1:5000',
      token: 'tok-/home/evan-0',
      workspaceCwd: '/home/evan',
    });
  });

  it('stopAll stops a replacement the pool spawned, never the boot daemon it was handed', async () => {
    const dead = { value: false };
    const stopped: string[] = [];
    const h = makeDeathHarness({ defaultClient: bootClient(dead), stopped });
    await h.pool.getOrSpawn('/proj/a');
    dead.value = true;
    h.pool.handleDaemonExit('/home/evan', { code: 1, signal: null });
    await h.pool.health(); // respawns the default
    await h.pool.stopAll();
    expect(stopped.sort()).toEqual(['/home/evan', '/proj/a']);
  });

  it('a failed respawn of the default is retried on the next call', async () => {
    let attempts = 0;
    const h = makeDeathHarness({
      defaultClient: bootClient({ value: true }),
      client: (cwd) => {
        if (++attempts === 1) throw new Error('boom: spawn failed');
        return fakeClient(cwd, `${cwd}-s`);
      },
    });
    h.pool.handleDaemonExit('/home/evan', { code: 1, signal: null });
    await expect(h.pool.health()).rejects.toThrow(/boom/);
    const ok = (await h.pool.health()) as unknown as { calledOn: string };
    expect(ok.calledOn).toBe('/home/evan');
    expect(attempts).toBe(2);
  });
});

describe('DaemonPool workspace scoping (rc-workspace-scoping, #28)', () => {
  /** fakeClient plus the ten workspace methods, each recording itself. */
  function wsClient(tag: string) {
    const calls: string[] = [];
    return {
      ...fakeClient(tag, `${tag}-s`),
      tag,
      calls,
      async workspacePermissions() {
        calls.push('workspacePermissions');
        return { calledOn: tag };
      },
      async setWorkspacePermissionRules(
        _scope: string,
        _ruleType: string,
        rules: readonly string[],
      ) {
        calls.push('setWorkspacePermissionRules:' + rules.join(','));
        return { calledOn: tag };
      },
      async workspaceTrust() {
        calls.push('workspaceTrust');
        return { calledOn: tag };
      },
      async requestWorkspaceTrustChange(request: { desiredState: string }) {
        calls.push('requestWorkspaceTrustChange:' + request.desiredState);
        return { calledOn: tag };
      },
      async workspaceSettings() {
        calls.push('workspaceSettings');
        return { calledOn: tag };
      },
      async setWorkspaceSetting(_scope: string, key: string) {
        calls.push('setWorkspaceSetting:' + key);
        return { calledOn: tag };
      },
      async workspaceToolsCatalog() {
        calls.push('workspaceToolsCatalog');
        return { calledOn: tag };
      },
      async setWorkspaceToolEnabled(toolName: string) {
        calls.push('setWorkspaceToolEnabled:' + toolName);
        return { calledOn: tag };
      },
      async workspaceMcp() {
        calls.push('workspaceMcp');
        return { calledOn: tag };
      },
      async reloadWorkspaceMcp() {
        calls.push('reloadWorkspaceMcp');
        return { calledOn: tag };
      },
    } as unknown as DaemonClient & {
      calls: string[];
      tag: string;
      calledOn?: string;
    };
  }

  function makeWsHarness(opts: { maxDaemons?: number } = {}) {
    const log: string[] = [];
    const defaultClient = wsClient('default');
    const clients = new Map<string, ReturnType<typeof wsClient>>();
    const pool = new DaemonPool({
      defaultDaemon: defaultClient,
      defaultWorkspaceCwd: '/home/evan',
      maxDaemons: opts.maxDaemons,
      idleReapMs: 999_999_999,
      spawn: async (cwd) => {
        log.push(cwd);
        const client = wsClient(cwd);
        clients.set(cwd, client);
        return { client, stop: async () => {}, workspaceCwd: cwd };
      },
    });
    return { pool, log, clients, defaultClient };
  }

  it('routes every workspace method to the daemon spawned for a non-default cwd', async () => {
    const h = makeWsHarness();
    await h.pool.workspacePermissions(undefined, '/proj/a');
    await h.pool.setWorkspacePermissionRules(
      'workspace',
      'allow',
      ['Bash(git *)'],
      undefined,
      '/proj/a',
    );
    await h.pool.workspaceTrust(undefined, '/proj/a');
    await h.pool.workspaceTrust({ statusVersion: 2 }, '/proj/a');
    await h.pool.requestWorkspaceTrustChange(
      { desiredState: 'trusted' },
      undefined,
      '/proj/a',
    );
    await h.pool.workspaceSettings(undefined, '/proj/a');
    await h.pool.setWorkspaceSetting(
      'workspace',
      'mcpServers',
      {},
      undefined,
      '/proj/a',
    );
    await h.pool.workspaceToolsCatalog('/proj/a');
    await h.pool.setWorkspaceToolEnabled(
      'grep_search',
      true,
      undefined,
      '/proj/a',
    );
    await h.pool.workspaceMcp('/proj/a');
    await h.pool.reloadWorkspaceMcp(undefined, '/proj/a');
    // One spawn, shared by every method — and nothing hit the boot daemon.
    expect(h.log).toEqual(['/proj/a']);
    const spawned = h.clients.get('/proj/a');
    expect(spawned).toBeDefined();
    expect(spawned!.calls).toEqual([
      'workspacePermissions',
      'setWorkspacePermissionRules:Bash(git *)',
      'workspaceTrust',
      'workspaceTrust',
      'requestWorkspaceTrustChange:trusted',
      'workspaceSettings',
      'setWorkspaceSetting:mcpServers',
      'workspaceToolsCatalog',
      'setWorkspaceToolEnabled:grep_search',
      'workspaceMcp',
      'reloadWorkspaceMcp',
    ]);
    expect(h.defaultClient.calls).toEqual([]);
  });

  it('an omitted or default cwd targets the boot daemon and never spawns', async () => {
    const h = makeWsHarness();
    await h.pool.workspaceMcp();
    await h.pool.workspacePermissions();
    await h.pool.workspaceMcp('/home/evan/'); // normalized default
    expect(h.log).toEqual([]);
    expect(h.defaultClient.calls).toEqual([
      'workspaceMcp',
      'workspacePermissions',
      'workspaceMcp',
    ]);
  });

  it('transport death on a non-default target removes the entry; the next call respawns', async () => {
    let spawned = 0;
    const h = makeDeathHarness({
      client: (cwd) => {
        const c = { ...fakeClient(cwd, `${cwd}-s`) } as Record<string, unknown>;
        if (spawned++ > 0) {
          c.workspaceMcp = async () => ({ calledOn: cwd + '#2' });
        } else {
          c.workspaceMcp = async () => {
            // fetch wraps the socket error under a TypeError with `cause`.
            throw Object.assign(new TypeError('mcp: fetch failed'), {
              cause: Object.assign(
                new Error('connect ECONNREFUSED 127.0.0.1:4181'),
                { code: 'ECONNREFUSED' },
              ),
            });
          };
        }
        return c;
      },
    });
    await expect(h.pool.workspaceMcp('/proj/a')).rejects.toThrow(
      /fetch failed/,
    );
    expect(h.pool.size()).toBe(0); // marked dead on the transport error
    expect(h.deaths).toHaveLength(1);
    expect(h.auditRows[0].action).toBe('daemon_died');
    // The next call spawns a fresh daemon for the same cwd.
    const second = (await h.pool.workspaceMcp('/proj/a')) as unknown as {
      calledOn: string;
    };
    expect(second.calledOn).toBe('/proj/a#2');
    expect(spawned).toBe(2);
  });

  it('WorkspacePoolFullError from a workspace method propagates untouched (the route maps it to 503)', async () => {
    const h = makeWsHarness({ maxDaemons: 1 });
    await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await expect(
      h.pool.workspacePermissions(undefined, '/proj/b'),
    ).rejects.toBeInstanceOf(WorkspacePoolFullError);
    expect(h.log).toEqual(['/proj/a']); // /proj/b was never spawned
    // The pool-full rejection did not mark the held daemon dead.
    const alive = (await h.pool.workspaceMcp('/proj/a')) as unknown as {
      calledOn: string;
    };
    expect(alive.calledOn).toBe('/proj/a');
    expect(h.pool.size()).toBe(1);
  });

  it('workspaces() lists the non-default cwds the pool holds (default excluded)', async () => {
    const h = makeWsHarness();
    expect(h.pool.workspaces()).toEqual([]);
    await h.pool.workspaceToolsCatalog('/proj/a');
    await h.pool.workspaceMcp('/proj/b');
    await h.pool.workspaceSettings('/home/evan'); // default: no entry
    expect(h.pool.workspaces().sort()).toEqual(['/proj/a', '/proj/b']);
  });
});

describe('DaemonPool.daemonEndpointForSession', () => {
  /** Pool that records endpoint material on spawn, like the real spawner. */
  function makeEndpointPool(opts: {
    defaultEndpoint?: { url: string; token: string | undefined };
    withEndpoint?: boolean;
  }) {
    return new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      ...(opts.defaultEndpoint
        ? {
            defaultEndpoint: {
              workspaceCwd: '/home/evan',
              ...opts.defaultEndpoint,
            },
          }
        : {}),
      spawn: async (cwd) => ({
        client: fakeClient(cwd),
        stop: async () => {},
        workspaceCwd: cwd,
        ...(opts.withEndpoint === false
          ? {}
          : {
              endpoint: {
                url: `http://127.0.0.1:4${cwd.length}00`,
                token: 'tok-' + cwd,
                workspaceCwd: cwd,
              },
            }),
      }),
    });
  }

  it('resolves the boot daemon for a session on the default workspace', async () => {
    const pool = makeEndpointPool({
      defaultEndpoint: { url: 'http://127.0.0.1:4180', token: 'boot-tok' },
    });
    const s = await pool.createOrAttachSession({});
    expect(pool.daemonEndpointForSession(s.sessionId)).toEqual({
      url: 'http://127.0.0.1:4180',
      token: 'boot-tok',
      workspaceCwd: '/home/evan',
    });
  });

  it('resolves the owning pooled daemon, not the boot one', async () => {
    const pool = makeEndpointPool({
      defaultEndpoint: { url: 'http://127.0.0.1:4180', token: 'boot-tok' },
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    const ep = pool.daemonEndpointForSession(s.sessionId);
    expect(ep?.token).toBe('tok-/proj/a');
    expect(ep?.workspaceCwd).toBe('/proj/a');
  });

  it('reports the canonicalized cwd so the terminal cd matches the daemon', async () => {
    const pool = makeEndpointPool({ withEndpoint: true });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a/' });
    expect(pool.daemonEndpointForSession(s.sessionId)?.workspaceCwd).toBe(
      '/proj/a',
    );
  });

  it('is undefined when the boot daemon has no endpoint registered', async () => {
    const pool = makeEndpointPool({});
    const s = await pool.createOrAttachSession({});
    expect(pool.daemonEndpointForSession(s.sessionId)).toBeUndefined();
  });

  it('is undefined for a daemon spawned without endpoint material', async () => {
    const pool = makeEndpointPool({ withEndpoint: false });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    expect(pool.daemonEndpointForSession(s.sessionId)).toBeUndefined();
  });

  it('throws for a session the pool does not own', () => {
    const pool = makeEndpointPool({});
    expect(() => pool.daemonEndpointForSession('nope')).toThrow(
      UnknownSessionError,
    );
  });
});

// #134: a worktree handover returns a DIFFERENT session id from the one that
// was posted, and the pool routes by id. Every test below exists because of one
// consequence: `daemonForSession` raises `UnknownSessionError` for an id it has
// never recorded, so a pool that hands back a replacement without binding it
// leaves a conversation the gateway cannot address at all - and the first call
// to fail would be the very release that stops the replacement leaking.
describe('DaemonPool worktree handover rebind (#134)', () => {
  function makeResetPool(
    opts: { replacementId?: string; echoSameId?: boolean } = {},
  ) {
    const calls: Array<{
      method: string;
      on: string;
      sessionId: string;
      clientId?: string;
    }> = [];
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => {
        const record = (method: string, sessionId: string, clientId?: string) =>
          calls.push({ method, on: cwd, sessionId, clientId });
        const client = {
          tag: cwd,
          async createOrAttachSession() {
            return {
              sessionId: `${cwd}-s`,
              workspaceCwd: cwd,
              attached: false,
            };
          },
          async sessionContext(id: string) {
            record('sessionContext', id);
            return { calledOn: cwd, id };
          },
          async resetWorktreeSession(id: string) {
            record('resetWorktreeSession', id);
            return {
              // The replacement's create-shape response: a different id, and
              // an owner-style client id registered on it.
              sessionId: opts.echoSameId
                ? id
                : (opts.replacementId ?? 's-after-reset'),
              clientId: 'client-minted',
            };
          },
          async detachSession(id: string, clientId?: string) {
            record('detachSession', id, clientId);
          },
          subscribeEvents: noEvents,
        } as unknown as DaemonClient;
        const out: PooledDaemonSpawn = {
          client,
          stop: async () => {},
          workspaceCwd: cwd,
        };
        return out;
      },
    });
    return { pool, calls };
  }

  it('makes the replacement addressable on the daemon that owns the checkout', async () => {
    const { pool, calls } = makeResetPool();
    const created = await pool.createOrAttachSession({
      workspaceCwd: '/proj/a',
    });
    const after = await pool.resetWorktreeSession(created.sessionId, {});

    expect(after.sessionId).toBe('s-after-reset');
    // Addressable AND on the same daemon. The transfer moved the checkout
    // within one workspace, so a successor routed anywhere else would be
    // talking to a daemon that does not own the files.
    await expect(pool.sessionContext('s-after-reset')).resolves.toEqual({
      calledOn: '/proj/a',
      id: 's-after-reset',
    });
    expect(calls.filter((c) => c.method === 'sessionContext')).toEqual([
      { method: 'sessionContext', on: '/proj/a', sessionId: 's-after-reset' },
    ]);
  });

  it('lets the release that prevents the leak actually reach the daemon', async () => {
    // The specific trap this issue is about. The relay releases the owner-style
    // client id the transfer mints, and that release is a pool call aimed at
    // the REPLACEMENT id. Without the rebind it throws before the daemon is
    // contacted, so the leak survives through the code written to close it -
    // and survives quietly, because the route reports the transfer as done.
    const { pool, calls } = makeResetPool();
    const created = await pool.createOrAttachSession({
      workspaceCwd: '/proj/a',
    });
    const after = await pool.resetWorktreeSession(created.sessionId, {});

    await expect(
      pool.detachSession(after.sessionId, 'client-minted'),
    ).resolves.toBeUndefined();
    expect(calls).toContainEqual({
      method: 'detachSession',
      on: '/proj/a',
      sessionId: 's-after-reset',
      clientId: 'client-minted',
    });
  });

  it('names the replacement among the sessions its daemon death takes with it', async () => {
    // The workspace's session set is what a death report is built from, so a
    // replacement missing from it would be left out of the list of
    // conversations the crash took with it. That is a reader still looking for
    // a session that is already gone, and a recovery that never tries to bring
    // it back. Fired through the real exit handle rather than read off a
    // private map, because the collection is the thing under test.
    const h = makeDeathHarness({
      client: (cwd) => ({
        tag: cwd,
        async createOrAttachSession() {
          return {
            sessionId: `${cwd}-s`,
            workspaceCwd: cwd,
            attached: false,
          };
        },
        async resetWorktreeSession(_id: string) {
          // The replacement is what the transfer answers with, and it is the
          // same here whichever id was posted.
          return { sessionId: 's-after-reset', clientId: 'client-minted' };
        },
        subscribeEvents: noEvents,
      }),
    });
    const created = await h.pool.createOrAttachSession({
      workspaceCwd: '/proj/a',
    });
    await h.pool.resetWorktreeSession(created.sessionId, {});
    h.fireExit('/proj/a', { code: null, signal: 'SIGKILL' });

    expect(h.deaths).toHaveLength(1);
    expect(h.deaths[0].sessions.sort()).toEqual([
      '/proj/a-s', // the superseded conversation, still bound
      's-after-reset',
    ]);
  });

  it('leaves the superseded conversation addressable', async () => {
    // The original is not deleted by a handover; it records that it was
    // superseded and stays readable. Dropping its binding would turn a
    // historical conversation into a 404.
    const { pool } = makeResetPool();
    const created = await pool.createOrAttachSession({
      workspaceCwd: '/proj/a',
    });
    await pool.resetWorktreeSession(created.sessionId, {});

    await expect(pool.sessionContext(created.sessionId)).resolves.toMatchObject(
      {
        calledOn: '/proj/a',
      },
    );
  });

  it('binds nothing new for an idempotent resume that returns the same id', async () => {
    // The second half of the protocol: resuming an already committed transfer
    // answers with the id you posted. Rebinding that would be a no-op at best,
    // and a route that assumed a fresh id every time would be wrong here.
    const { pool } = makeResetPool({ echoSameId: true });
    const created = await pool.createOrAttachSession({
      workspaceCwd: '/proj/a',
    });
    const ownerOf = (pool as unknown as { ownerOf: Map<string, string> })
      .ownerOf;
    const before = ownerOf.size;

    const after = await pool.resetWorktreeSession(created.sessionId, {});
    expect(after.sessionId).toBe(created.sessionId);
    expect(ownerOf.size).toBe(before);
  });

  it('refuses a handover for a session the pool does not own', async () => {
    // Nothing was bound, so nothing may be claimed. A pool that answered here
    // would be reporting a transfer against a conversation it has never seen.
    const { pool } = makeResetPool();
    await expect(
      pool.resetWorktreeSession('never-seen', {}),
    ).rejects.toBeInstanceOf(UnknownSessionError);
  });
});

// -- Subscription loss is not daemon death (#153) ----------------------
// The real-socket cases (the daemon's own write-then-destroy eviction through
// the real SDK) live in daemonPool.realClient.test.ts. These pin what the pool
// does when its /health question gets an answer that is not a plain yes/no.

/** A stream that delivers one frame and then dies the way undici reports a
 * torn-down SSE body. */
function droppedStream(): () => AsyncGenerator<DaemonEvent> {
  return async function* () {
    yield { v: 1, type: 'agent_message_chunk', id: 1, data: {} } as DaemonEvent;
    throw Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), {
        name: 'SocketError',
        code: 'UND_ERR_SOCKET',
      }),
    });
  };
}

describe('DaemonPool subscription loss (#153)', () => {
  function lossPool(health: () => Promise<unknown>) {
    const h = makeDeathHarness({
      client: (cwd) => ({
        ...fakeClient(cwd, `${cwd}-s`, droppedStream()),
        health,
      }),
    });
    return h;
  }

  it('a daemon that answers /health with an HTTP error is still alive', async () => {
    const h = lossPool(async () => {
      throw new DaemonHttpError(503, { error: 'busy' }, 'GET /health: busy');
    });
    const s = await h.pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await expect(async () => {
      for await (const _ev of h.pool.subscribeEvents(s.sessionId)) {
        /* drain */
      }
    }).rejects.toThrow(/terminated/);
    expect(h.deaths).toEqual([]);
    expect(h.pool.size()).toBe(1);
  });

  it('stops waiting on a /health probe that never answers, and does not call that a death', async () => {
    // The child's exit event is the authoritative death signal; an unanswered
    // probe is not proof, and a wrong "dead" spawns a second daemon on a
    // workspace whose first one still holds the sessions.
    const exits: Array<() => void> = [];
    const deaths: string[][] = [];
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      idleReapMs: 999_999_999,
      probeTimeoutMs: 20,
      spawn: async (cwd) => {
        const out: PooledDaemonSpawn = {
          client: {
            ...fakeClient(cwd, `${cwd}-s`, droppedStream()),
            health: () => new Promise(() => {}),
          } as unknown as DaemonClient,
          stop: async () => {},
          workspaceCwd: cwd,
        };
        exits.push(() => out.onExit?.({ code: 137, signal: null }));
        return out;
      },
      onDaemonDeath: (_key, sessions) => deaths.push(sessions),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await expect(async () => {
      for await (const _ev of pool.subscribeEvents(s.sessionId)) {
        /* drain */
      }
    }).rejects.toThrow(/terminated/);
    expect(deaths).toEqual([]);
    expect(pool.size()).toBe(1);
    // If the process really is gone, its exit still reports it.
    exits[0]!();
    expect(deaths).toEqual([[s.sessionId]]);
  });
});

// -- Reconciling with the daemon's own sessions (#154) -------------------

/** What the SDK throws for an id the daemon no longer holds: its status route
 * answers 404 `session_not_found` (SessionNotFoundError via sendBridgeError). */
function sessionGone(id: string): DaemonHttpError {
  return new DaemonHttpError(
    404,
    {
      error: `No session with id "${id}"`,
      code: 'session_not_found',
      sessionId: id,
    },
    `GET /session/:id/status: No session with id "${id}"`,
  );
}

/** A pooled client whose daemon has reaped every id in `reaped` and holds
 * every other one. */
function reapingClient(cwd: string, reaped: Set<string>) {
  return {
    ...fakeClient(cwd, `${cwd}-s`),
    async sessionStatus(id: string) {
      if (reaped.has(id)) throw sessionGone(id);
      return { sessionId: id };
    },
  } as unknown as DaemonClient;
}

describe('DaemonPool reconciles with sessions the daemon reaped (#154)', () => {
  it('the audit probe: two workspaces whose sessions the daemon reaped no longer fill the pool', async () => {
    // The reviewer's probe, shape for shape: reapIdle() fired and NOT awaited
    // (what the background timer does), then a create for a third cwd.
    let t = 0;
    const stopped: string[] = [];
    const reaped = new Set<string>();
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      maxDaemons: 2,
      idleReapMs: 1000,
      now: () => t,
      spawn: async (cwd) => ({
        client: reapingClient(cwd, reaped),
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });
    const a = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    const b = await pool.createOrAttachSession({ workspaceCwd: '/proj/b' });
    // The daemon's reaper closes both after 30 minutes with no SSE subscriber.
    // Nobody is subscribed, so no session_closed frame reaches the pool.
    reaped.add(a.sessionId);
    reaped.add(b.sessionId);
    t = 10 * 60 * 60_000;
    void pool.reapIdle();

    const c = await pool.createOrAttachSession({ workspaceCwd: '/proj/c' });
    expect(c.sessionId).toBe('/proj/c-s');
    expect(pool.workspaces()).toEqual(['/proj/c']);
    expect(stopped.sort()).toEqual(['/proj/a', '/proj/b']);
    // Forgotten in routing too, not only in the entry.
    await expect(pool.sessionContext(a.sessionId)).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('keeps ids the daemon still holds and ids it gave no answer for, so the cap stays honest', async () => {
    let t = 0;
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      maxDaemons: 2,
      idleReapMs: 1000,
      now: () => t,
      spawn: async (cwd) => ({
        client: {
          ...fakeClient(cwd, `${cwd}-s`),
          async sessionStatus(id: string) {
            if (cwd === '/proj/a') return { sessionId: id };
            throw new DaemonHttpError(500, { error: 'boom' }, 'boom');
          },
        } as unknown as DaemonClient,
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await pool.createOrAttachSession({ workspaceCwd: '/proj/b' });
    t = 10 * 60 * 60_000;
    await pool.reapIdle();

    expect(pool.size()).toBe(2);
    await expect(pool.getOrSpawn('/proj/c')).rejects.toBeInstanceOf(
      WorkspacePoolFullError,
    );
    const ctx = (await pool.sessionContext('/proj/b-s')) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/proj/b');
  });

  it('does not drop an id that was registered again while its check was in flight', async () => {
    let t = 0;
    let answer: (() => void) | undefined;
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      idleReapMs: 1000,
      now: () => t,
      spawn: async (cwd) => ({
        client: {
          ...fakeClient(cwd, `${cwd}-s`),
          async sessionStatus(id: string) {
            // "Not held" was true when the daemon answered, before the resume
            // below loaded the session again.
            await new Promise<void>((resolve) => {
              answer = resolve;
            });
            throw sessionGone(id);
          },
        } as unknown as DaemonClient,
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    await pool.resumeSession('s-old', { workspaceCwd: '/proj/a' });
    t = 10 * 60 * 60_000;
    const reconciling = pool.reapIdle();
    // The phone reopens the conversation while the check is out.
    await pool.resumeSession('s-old', { workspaceCwd: '/proj/a' });
    answer!();
    await reconciling;

    expect(pool.size()).toBe(1);
    const ctx = (await pool.sessionContext('s-old')) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/proj/a');
  });

  it('a dropped id is not handed to recovery when the daemon later dies', async () => {
    let t = 0;
    const h = makeDeathHarness({
      now: () => t,
      idleReapMs: 1000,
      client: (cwd) => reapingClient(cwd, new Set(['stale'])),
    });
    await h.pool.resumeSession('stale', { workspaceCwd: '/proj/a' });
    const live = await h.pool.createOrAttachSession({
      workspaceCwd: '/proj/a',
    });
    t = 10 * 60 * 60_000;
    await h.pool.reapIdle();
    expect(h.pool.size()).toBe(1); // still serving `live`

    h.fireExit('/proj/a', { code: 137, signal: null });
    expect(h.deaths).toHaveLength(1);
    expect(h.deaths[0].sessions).toEqual([live.sessionId]);
  });

  it('at the cap, a create stops waiting on a daemon that does not answer and refuses', async () => {
    let t = 0;
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      maxDaemons: 1,
      idleReapMs: 1000,
      probeTimeoutMs: 20,
      now: () => t,
      spawn: async (cwd) => ({
        client: {
          ...fakeClient(cwd, `${cwd}-s`),
          sessionStatus: () => new Promise(() => {}),
        } as unknown as DaemonClient,
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    t = 10 * 60 * 60_000;
    await expect(pool.getOrSpawn('/proj/b')).rejects.toBeInstanceOf(
      WorkspacePoolFullError,
    );
    expect(pool.workspaces()).toEqual(['/proj/a']);
  });

  it('closeSession on an id the daemon already dropped releases it, as the SDK does for its own 404', async () => {
    let t = 0;
    const stopped: string[] = [];
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      idleReapMs: 1000,
      now: () => t,
      spawn: async (cwd) => ({
        client: {
          ...fakeClient(cwd, `${cwd}-s`),
          async closeSession(id: string) {
            throw sessionGone(id);
          },
        } as unknown as DaemonClient,
        stop: async () => {
          stopped.push(cwd);
        },
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await expect(pool.closeSession(s.sessionId)).resolves.toBeUndefined();
    t = 10_000;
    pool.reapIdle();
    expect(pool.size()).toBe(0);
    expect(stopped).toEqual(['/proj/a']);
  });

  it('closeSession keeps the id when the daemon refuses for any other reason', async () => {
    const pool = new DaemonPool({
      defaultDaemon: fakeClient('default'),
      defaultWorkspaceCwd: '/home/evan',
      spawn: async (cwd) => ({
        client: {
          ...fakeClient(cwd, `${cwd}-s`),
          async closeSession() {
            throw new DaemonHttpError(409, { code: 'busy' }, 'busy');
          },
        } as unknown as DaemonClient,
        stop: async () => {},
        workspaceCwd: cwd,
      }),
    });
    const s = await pool.createOrAttachSession({ workspaceCwd: '/proj/a' });
    await expect(pool.closeSession(s.sessionId)).rejects.toThrow(/busy/);
    const ctx = (await pool.sessionContext(s.sessionId)) as unknown as {
      calledOn: string;
    };
    expect(ctx.calledOn).toBe('/proj/a');
  });
});
