/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #110: the pool's organization and sources methods, and the client id the
 * daemon's source mutations require. The id sent is the one the daemon
 * stamped on this gateway's own attachment, and only while the daemon that
 * stamped it still owns the session.
 */

import { describe, expect, it } from 'vitest';
import type { DaemonClient } from '@qwen-code/sdk';
import {
  DaemonPool,
  UnknownSessionError,
  type PooledDaemonSpawn,
} from './daemonPool.js';

interface Seen {
  upserts: Array<string | undefined>;
  removes: Array<string | undefined>;
  lists: Array<string | undefined>;
  organizations: Array<{ sessionId: string; update: unknown }>;
  groups: Array<{ workspaceCwd: string; input: unknown }>;
}

/** A daemon for `cwd` that stamps `stamp()` on each create and load. */
function fakeClient(cwd: string, seen: Seen, stamp: () => string | undefined) {
  return {
    async createOrAttachSession(req: { workspaceCwd?: string }) {
      const clientId = stamp();
      return {
        sessionId: 'sid-' + (req.workspaceCwd ?? cwd),
        workspaceCwd: cwd,
        attached: false,
        ...(clientId ? { clientId } : {}),
      };
    },
    async loadSession(sessionId: string) {
      const clientId = stamp();
      return {
        sessionId,
        workspaceCwd: cwd,
        attached: true,
        state: {},
        ...(clientId ? { clientId } : {}),
      };
    },
    async closeSession() {},
    async upsertSessionSource(_s: string, _src: unknown, clientId?: string) {
      seen.upserts.push(clientId);
      return { revision: 1, source: {}, change: 'created' };
    },
    async removeSessionSource(_s: string, _id: string, clientId?: string) {
      seen.removes.push(clientId);
      return { revision: 2, removed: true };
    },
    async listSessionSources(_s: string, clientId?: string) {
      seen.lists.push(clientId);
      return { revision: 0, sources: [] };
    },
    async updateSessionOrganization(sessionId: string, update: unknown) {
      seen.organizations.push({ sessionId, update });
      return {
        sessionId,
        groupId: null,
        isPinned: false,
        color: null,
        updatedAt: 'now',
      };
    },
    async createSessionGroup(workspaceCwd: string, input: unknown) {
      seen.groups.push({ workspaceCwd, input });
      return { id: 'g1', name: 'n', color: 'red', order: 0 };
    },
    async capabilities() {
      return { workspaceCwd: cwd };
    },
    async health() {
      return { status: 'ok' };
    },
  } as unknown as DaemonClient;
}

function newSeen(): Seen {
  return { upserts: [], removes: [], lists: [], organizations: [], groups: [] };
}

function makePool(stamps: Array<string | undefined>) {
  const seen = newSeen();
  const spawned: PooledDaemonSpawn[] = [];
  const next = () => stamps.shift();
  const pool = new DaemonPool({
    defaultDaemon: fakeClient('/home', seen, next),
    defaultWorkspaceCwd: '/home',
    deathProbeDelayMs: 0,
    spawn: async (cwd) => {
      const s: PooledDaemonSpawn = {
        client: fakeClient(cwd, seen, next),
        stop: async () => {},
        workspaceCwd: cwd,
      };
      spawned.push(s);
      return s;
    },
  });
  return { pool, seen, spawned };
}

const SRC = { title: 't', locator: { type: 'url' as const, url: 'https://x.test/' } };

describe('DaemonPool: the client id for source mutations (#110)', () => {
  it('sends the id the daemon stamped on the create, on add and on remove', async () => {
    const { pool, seen } = makePool(['client_a']);
    const s = await pool.createOrAttachSession({ workspaceCwd: '/w' });
    await pool.upsertSessionSource(s.sessionId, SRC);
    await pool.removeSessionSource(s.sessionId, 'abc');
    expect(seen.upserts).toEqual(['client_a']);
    expect(seen.removes).toEqual(['client_a']);
    await pool.stopAll();
  });

  it('sends no id on the list, which the daemon serves unbound', async () => {
    const { pool, seen } = makePool(['client_a']);
    const s = await pool.createOrAttachSession({ workspaceCwd: '/w' });
    await pool.listSessionSources(s.sessionId);
    expect(seen.lists).toEqual([undefined]);
    await pool.stopAll();
  });

  it("a caller's own id wins over the bound one", async () => {
    const { pool, seen } = makePool(['client_a']);
    const s = await pool.createOrAttachSession({ workspaceCwd: '/w' });
    await pool.upsertSessionSource(s.sessionId, SRC, 'mine');
    expect(seen.upserts).toEqual(['mine']);
    await pool.stopAll();
  });

  it('a resume that stamps a new id moves the binding to it', async () => {
    const { pool, seen } = makePool(['client_a', 'client_b']);
    const s = await pool.createOrAttachSession({ workspaceCwd: '/w' });
    await pool.resumeSession(s.sessionId, { workspaceCwd: '/w' });
    await pool.upsertSessionSource(s.sessionId, SRC);
    expect(seen.upserts).toEqual(['client_b']);
    await pool.stopAll();
  });

  it('a resume on the same daemon that stamps none keeps the earlier id, still registered there', async () => {
    const { pool, seen } = makePool(['client_a', undefined]);
    const s = await pool.createOrAttachSession({ workspaceCwd: '/w' });
    await pool.resumeSession(s.sessionId, { workspaceCwd: '/w' });
    await pool.upsertSessionSource(s.sessionId, SRC);
    expect(seen.upserts).toEqual(['client_a']);
    await pool.stopAll();
  });

  it('after its daemon dies the id is not sent to the daemon that replaces it', async () => {
    const { pool, seen, spawned } = makePool(['client_a', undefined]);
    const s = await pool.createOrAttachSession({ workspaceCwd: '/w' });
    // The first daemon for /w exits; recovery restores the session on a new
    // one that stamps nothing, so the only id held is the dead daemon's.
    spawned[0]!.onExit?.({ code: 1, signal: null });
    await expect(pool.upsertSessionSource(s.sessionId, SRC)).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
    await pool.resumeSession(s.sessionId, { workspaceCwd: '/w' });
    expect(spawned.length).toBe(2);
    await pool.upsertSessionSource(s.sessionId, SRC);
    expect(seen.upserts).toEqual([undefined]);
    await pool.stopAll();
  });

  it('a closed session forgets its id', async () => {
    const { pool, seen } = makePool(['client_a', undefined]);
    const s = await pool.createOrAttachSession({ workspaceCwd: '/w' });
    await pool.closeSession(s.sessionId);
    await pool.resumeSession(s.sessionId, { workspaceCwd: '/w' });
    await pool.upsertSessionSource(s.sessionId, SRC);
    // Same daemon, but the close released the attachment the id named.
    expect(seen.upserts).toEqual([undefined]);
    await pool.stopAll();
  });
});

describe('DaemonPool: organization and groups (#110)', () => {
  it('files a session on the daemon that owns it', async () => {
    const { pool, seen } = makePool([]);
    const s = await pool.createOrAttachSession({ workspaceCwd: '/w' });
    const out = await pool.updateSessionOrganization(s.sessionId, {
      groupId: 'g1',
      color: null,
    });
    expect(out.sessionId).toBe(s.sessionId);
    expect(seen.organizations).toEqual([
      { sessionId: s.sessionId, update: { groupId: 'g1', color: null } },
    ]);
    await pool.stopAll();
  });

  it('a session the pool does not hold is refused before any daemon is asked', async () => {
    const { pool, seen } = makePool([]);
    await expect(
      pool.updateSessionOrganization('nobody', { color: 'red' }),
    ).rejects.toBeInstanceOf(UnknownSessionError);
    expect(seen.organizations).toEqual([]);
    await pool.stopAll();
  });

  it("a group is made on the workspace's daemon, addressed by the pool's own key for it", async () => {
    const { pool, seen, spawned } = makePool([]);
    await pool.createSessionGroup('/w/', { name: 'Work', color: 'blue' });
    expect(spawned.map((s) => s.workspaceCwd)).toEqual(['/w']);
    expect(seen.groups).toEqual([
      { workspaceCwd: '/w', input: { name: 'Work', color: 'blue' } },
    ]);
    await pool.stopAll();
  });
});
