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
} from './daemonHttpError.js';

describe('who sees the daemon\'s words (#211)', () => {
  it('write and owner do; a share guest, a reader and a request with no client do not', () => {
    expect(canSeeDaemonDetail({ rcClient: { scopes: ['owner'] } })).toBe(true);
    expect(canSeeDaemonDetail({ rcClient: { scopes: ['write'] } })).toBe(true);
    expect(canSeeDaemonDetail({ rcClient: { scopes: ['session:read'] } })).toBe(false);
    expect(canSeeDaemonDetail({ rcClient: { scopes: ['approve'] } })).toBe(false);
    expect(canSeeDaemonDetail({})).toBe(false);
    // Even a share that somehow carries write.
    expect(
      canSeeDaemonDetail({ rcClient: { scopes: ['write', 'share'], shareId: 's1' } }),
    ).toBe(false);
  });
});

describe('daemonFailureDetail (#211)', () => {
  it('reads status, code and message from the daemon body, flat or in the validation envelope', () => {
    expect(
      daemonFailureDetail(new DaemonHttpError(412, { error: 'gone', code: 'x' }, 'r')),
    ).toEqual({ status: 412, code: 'x', message: 'gone' });
    expect(
      daemonFailureDetail(
        new DaemonHttpError(
          400,
          { error: { code: 'VALIDATION_FAILED', message: 'title is empty', field: 'title' } },
          'r',
        ),
      ),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED', message: 'title is empty' });
  });

  it('names a thrown error that is not an HTTP answer', () => {
    expect(daemonFailureDetail(new TypeError('fetch failed'))).toEqual({
      errorName: 'TypeError',
      message: 'fetch failed',
    });
  });
});

describe('daemonUnavailableBody (#211)', () => {
  const err = new DaemonHttpError(500, { error: 'boom', code: 'load_failed' }, 'r');
  it('adds `daemon` for write and leaves the sentence and code alone', () => {
    expect(daemonUnavailableBody({ rcClient: { scopes: ['write'] } }, err)).toEqual({
      error: 'Daemon unavailable',
      code: 'daemon_unavailable',
      daemon: { status: 500, code: 'load_failed', message: 'boom' },
    });
  });
  it('is the old body for a reader', () => {
    expect(daemonUnavailableBody({ rcClient: { scopes: ['session:read'] } }, err)).toEqual({
      error: 'Daemon unavailable',
      code: 'daemon_unavailable',
    });
  });
});
