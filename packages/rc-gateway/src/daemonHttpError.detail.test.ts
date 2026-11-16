/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import {
  canSeeDaemonDetail,
  daemonFailureDetail,
  daemonUnavailableBody,
  isSessionLevelGone,
  workspacePoolFullBody,
} from './daemonHttpError.js';
import { WorkspacePoolFullError } from './daemonPool.js';

describe('isSessionLevelGone (#474)', () => {
  it('returns true only when session_not_found has neither subagentRef nor toolCallId', () => {
    expect(
      isSessionLevelGone(
        new DaemonHttpError(
          404,
          { code: 'session_not_found', sessionId: 's1' },
          'r',
        ),
      ),
    ).toBe(true);
    expect(
      isSessionLevelGone(
        new DaemonHttpError(
          404,
          {
            code: 'session_not_found',
            sessionId: 's1',
            subagentRef: null,
            toolCallId: null,
          },
          'r',
        ),
      ),
    ).toBe(true);
    expect(
      isSessionLevelGone(
        new DaemonHttpError(
          404,
          { code: 'session_not_found', sessionId: 's1', subagentRef: 'tc-1' },
          'r',
        ),
      ),
    ).toBe(false);
    expect(
      isSessionLevelGone(
        new DaemonHttpError(
          404,
          { code: 'session_not_found', sessionId: 's1', toolCallId: 'tc-1' },
          'r',
        ),
      ),
    ).toBe(false);
  });
});

describe("who sees the daemon's words (#211)", () => {
  it('write and owner do; a share guest, a reader and a request with no client do not', () => {
    expect(canSeeDaemonDetail({ rcClient: { scopes: ['owner'] } })).toBe(true);
    expect(canSeeDaemonDetail({ rcClient: { scopes: ['write'] } })).toBe(true);
    expect(canSeeDaemonDetail({ rcClient: { scopes: ['session:read'] } })).toBe(
      false,
    );
    expect(canSeeDaemonDetail({ rcClient: { scopes: ['approve'] } })).toBe(
      false,
    );
    expect(canSeeDaemonDetail({})).toBe(false);
    // Even a share that somehow carries write.
    expect(
      canSeeDaemonDetail({
        rcClient: { scopes: ['write', 'share'], shareId: 's1' },
      }),
    ).toBe(false);
  });
});

describe('daemonFailureDetail (#211)', () => {
  it('reads status, code and message from the daemon body, flat or in the validation envelope', () => {
    expect(
      daemonFailureDetail(
        new DaemonHttpError(412, { error: 'gone', code: 'x' }, 'r'),
      ),
    ).toEqual({ status: 412, code: 'x', message: 'gone' });
    expect(
      daemonFailureDetail(
        new DaemonHttpError(
          400,
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'title is empty',
              field: 'title',
            },
          },
          'r',
        ),
      ),
    ).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'title is empty',
    });
  });

  it('names a thrown error that is not an HTTP answer', () => {
    expect(daemonFailureDetail(new TypeError('fetch failed'))).toEqual({
      errorName: 'TypeError',
      message: 'fetch failed',
    });
  });
});

describe('daemonUnavailableBody (#211)', () => {
  const err = new DaemonHttpError(
    500,
    { error: 'boom', code: 'load_failed' },
    'r',
  );
  it('adds `daemon` for write and leaves the sentence and code alone', () => {
    expect(
      daemonUnavailableBody({ rcClient: { scopes: ['write'] } }, err),
    ).toEqual({
      error: 'Daemon unavailable',
      code: 'daemon_unavailable',
      daemon: { status: 500, code: 'load_failed', message: 'boom' },
    });
  });
  it('is the old body for a reader', () => {
    expect(
      daemonUnavailableBody({ rcClient: { scopes: ['session:read'] } }, err),
    ).toEqual({
      error: 'Daemon unavailable',
      code: 'daemon_unavailable',
    });
  });
});

describe('workspacePoolFullBody (#219, #211)', () => {
  const err = new WorkspacePoolFullError(2, {
    requestedWorkspaceCwd: '/home/evan/projects/new-app',
    idleReapMs: 15 * 60_000,
    slots: [
      {
        workspaceCwd: '/home/evan/projects/alpha',
        idle: false,
        state: 'busy',
        sessionCount: 2,
        inFlightCount: 0,
        idleForMs: 120_000,
      },
      {
        workspaceCwd: '/home/evan/projects/beta',
        idle: false,
        state: 'spawning',
        sessionCount: 0,
        inFlightCount: 0,
        idleForMs: 0,
      },
    ],
  });

  it('gives write and owner callers the occupied slots and idleReapMs next step', () => {
    const body = workspacePoolFullBody({ rcClient: { scopes: ['write'] } }, err);
    expect(body).toMatchObject({
      code: 'workspace_pool_full',
      activeWorkspaces: 2,
      maxDaemons: 2,
      idleReapMs: 900_000,
      requestedWorkspaceCwd: '/home/evan/projects/new-app',
      slots: [
        {
          workspaceCwd: '/home/evan/projects/alpha',
          idle: false,
          state: 'busy',
          sessionCount: 2,
          inFlightCount: 0,
          idleForMs: 120_000,
        },
        {
          workspaceCwd: '/home/evan/projects/beta',
          idle: false,
          state: 'spawning',
          sessionCount: 0,
          inFlightCount: 0,
          idleForMs: 0,
        },
      ],
    });
    expect(body.error).toContain('/home/evan/projects/alpha (busy: 2 sessions, last used 2 min ago)');
    expect(body.error).toContain('/home/evan/projects/beta (spawning)');
    expect(body.next).toContain('idleReapMs: 900000 ms / 15 min');
    expect(body.next).toContain('--max-daemons / QWEN_RC_MAX_DAEMONS');
  });

  it('reduces the body for readers, shares, and unauthenticated callers so no host paths leak', () => {
    for (const req of [
      { rcClient: { scopes: ['session:read'] } },
      { rcClient: { scopes: ['write', 'share'], shareId: 'share-1' } },
      {},
      undefined,
    ]) {
      const body = workspacePoolFullBody(req, err);
      expect(body).toEqual({
        error: 'Workspace daemon pool is full (max 2)',
        code: 'workspace_pool_full',
        activeWorkspaces: 2,
      });
      expect(JSON.stringify(body)).not.toContain('/home/evan');
    }
  });
});
