/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import {
  createSessionRestRoute,
  type SessionRestAction,
  type SessionRestDaemon,
} from './sessionRest.js';
import type { AuditRecorder } from '../auditLog.js';

const SESS = '11111111111111111111111111111111';
const OTHER = '22222222222222222222222222222222';

interface Captured {
  status?: number;
  body?: Record<string, unknown>;
}

/** A Response that records the terminal call; the routes only ever end once. */
function fakeRes(): { res: Response; captured: Captured } {
  const captured: Captured = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, captured };
}

/**
 * A daemon double that records what it was asked for. Each method is a spy so
 * a test can prove a refusal happened BEFORE any daemon call, which is the
 * whole point of the confirm guard — a guard that runs after the destructive
 * call is not a guard.
 */
function fakeDaemon(behaviour: { fail?: boolean } = {}) {
  const calls: Array<{
    action: SessionRestAction;
    ids: string[];
    second: unknown;
    third: unknown;
  }> = [];
  const record =
    (action: SessionRestAction) =>
    async (ids: string[], second: unknown, third: unknown) => {
      calls.push({ action, ids, second, third });
      if (behaviour.fail) throw new Error('/sessions/delete refused');
      return action === 'delete'
        ? { removed: ids, notFound: [], errors: [] }
        : action === 'archive'
          ? { archived: ids, alreadyArchived: [], notFound: [], errors: [] }
          : { unarchived: ids, alreadyActive: [], notFound: [], errors: [] };
    };
  const daemon = {
    archiveSessionsData: record('archive'),
    unarchiveSessionsData: record('unarchive'),
    deleteSessionsData: record('delete'),
  } as unknown as SessionRestDaemon;
  return { daemon, calls };
}

function recorder() {
  const entries: Array<Record<string, unknown>> = [];
  const audit = {
    record: async (e: Record<string, unknown>) => {
      entries.push(e);
    },
  } as unknown as AuditRecorder;
  return { audit, entries };
}

async function call(
  daemon: SessionRestDaemon,
  action: SessionRestAction,
  body: unknown,
  audit?: AuditRecorder,
): Promise<Captured> {
  const { res, captured } = fakeRes();
  const req = { body, rcClient: { id: 'tok_test' } } as unknown as Request;
  await createSessionRestRoute(daemon, action, audit)(req, res, () => {});
  return captured;
}

describe('POST /rc/sessions/{archive,unarchive,delete} (#111)', () => {
  it('archives a batch and passes the daemon outcome through', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, 'archive', {
      sessionIds: [SESS, OTHER],
      cwd: '/proj',
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      action: 'archive',
      requested: 2,
      archived: [SESS, OTHER],
    });
    // The cwd must reach the pool as the workspace argument (3rd position),
    // not the clientId slot — swapping those two is the silent misroute this
    // signature exists to prevent.
    expect(calls[0]).toMatchObject({
      action: 'archive',
      ids: [SESS, OTHER],
      third: '/proj',
    });
  });

  it('refuses delete without confirm, and never reaches the daemon', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, 'delete', { sessionIds: [SESS] });
    expect(out.status).toBe(400);
    expect(out.body?.code).toBe('confirm_required');
    // The guard is only real if nothing was destroyed behind it.
    expect(calls).toHaveLength(0);
  });

  it('lets archive through WITHOUT confirm, since archiving is reversible', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, 'archive', { sessionIds: [SESS] });
    expect(out.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('deletes when confirm is set', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, 'delete', {
      sessionIds: [SESS],
      confirm: true,
    });
    expect(out.status).toBe(200);
    expect(out.body?.removed).toEqual([SESS]);
    expect(calls).toHaveLength(1);
  });

  it('treats a truthy-but-not-true confirm as no confirm', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, 'delete', {
      sessionIds: [SESS],
      confirm: 'yes',
    });
    expect(out.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed session id before any daemon call', async () => {
    const { daemon, calls } = fakeDaemon();
    const out = await call(daemon, 'delete', {
      sessionIds: ['../../etc/passwd'],
      confirm: true,
    });
    expect(out.status).toBe(400);
    expect(out.body?.code).toBe('sessionIds_invalid');
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty or missing batch', async () => {
    const { daemon } = fakeDaemon();
    for (const body of [{}, { sessionIds: [] }, { sessionIds: 'x' }]) {
      const out = await call(daemon, 'archive', body);
      expect(out.status).toBe(400);
      expect(out.body?.code).toBe('sessionIds_required');
    }
  });

  it('answers 502 on a daemon refusal, not a silently-empty 200', async () => {
    const { daemon } = fakeDaemon({ fail: true });
    const { audit, entries } = recorder();
    const out = await call(daemon, 'archive', { sessionIds: [SESS] }, audit);
    expect(out.status).toBe(502);
    expect(out.body?.code).toBe('daemon_unavailable');
    expect(entries[0]?.action).toBe('sessions_archive_failed');
  });

  it('audits the ids and never the cwd', async () => {
    const { daemon } = fakeDaemon();
    const { audit, entries } = recorder();
    await call(
      daemon,
      'archive',
      { sessionIds: [SESS, OTHER], cwd: '/home/evan/secret-project' },
      audit,
    );
    const entry = entries[0] as Record<string, unknown>;
    expect(entry.action).toBe('sessions_archived');
    expect(entry.target).toBe(`${SESS},${OTHER}`);
    expect(JSON.stringify(entry)).not.toContain('secret-project');
  });
});
