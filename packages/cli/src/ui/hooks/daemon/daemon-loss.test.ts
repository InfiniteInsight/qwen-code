/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyDaemonFailure,
  confirmDaemonGone,
  isTransportError,
} from './daemon-loss.js';

const withCode = (code: string, message = 'boom'): Error =>
  Object.assign(new Error(message), { code });

const fetchFailed = (code: string): TypeError =>
  Object.assign(new TypeError('fetch failed'), { cause: withCode(code) });

const httpError = (status: number): Error =>
  Object.assign(new Error(`HTTP ${status}`), {
    name: 'DaemonHttpError',
    status,
  });

const err = (error: unknown) => ({ kind: 'error' as const, error });
const frame = (type: string) => ({
  kind: 'frame' as const,
  frame: { type, data: {} },
});

describe('classifyDaemonFailure', () => {
  describe('transport errors mean the daemon process is not there', () => {
    it.each([
      ['ECONNREFUSED on the error', withCode('ECONNREFUSED')],
      ['ECONNRESET on the error', withCode('ECONNRESET')],
      ['EPIPE on the error', withCode('EPIPE')],
      ['undici socket error', withCode('UND_ERR_SOCKET')],
      ['fetch failed caused by ECONNREFUSED', fetchFailed('ECONNREFUSED')],
      ['fetch failed caused by ECONNRESET', fetchFailed('ECONNRESET')],
      ['socket hang up', new Error('socket hang up')],
      ['bare fetch failed', new TypeError('fetch failed')],
      ['body terminated mid-stream', new TypeError('terminated')],
      ['other side closed', new Error('other side closed')],
      [
        'message-only ECONNREFUSED',
        new Error('connect ECONNREFUSED 127.0.0.1:9'),
      ],
    ])('%s -> daemon_gone', (_name, error) => {
      expect(classifyDaemonFailure(err(error))).toBe('daemon_gone');
      expect(isTransportError(error)).toBe(true);
    });

    it('finds the code several causes deep', () => {
      const deep = Object.assign(new Error('wrapped'), {
        cause: Object.assign(new Error('mid'), {
          cause: withCode('ECONNRESET'),
        }),
      });
      expect(classifyDaemonFailure(err(deep))).toBe('daemon_gone');
    });

    it('survives a cyclic cause chain', () => {
      const a: Error & { cause?: unknown } = new Error('a');
      const b: Error & { cause?: unknown } = new Error('b');
      a.cause = b;
      b.cause = a;
      expect(classifyDaemonFailure(err(a))).toBe('fatal');
    });
  });

  describe('HTTP answers', () => {
    it('401 is a bad token: fatal', () => {
      expect(classifyDaemonFailure(err(httpError(401)))).toBe('fatal');
    });
    it('403 is a bad token: fatal', () => {
      expect(classifyDaemonFailure(err(httpError(403)))).toBe('fatal');
    });
    it('404 means the daemon does not have the session: daemon_gone', () => {
      expect(classifyDaemonFailure(err(httpError(404)))).toBe('daemon_gone');
    });
    it('404 is definitive, not a transport error', () => {
      expect(isTransportError(httpError(404))).toBe(false);
    });
    it.each([400, 409, 429, 500, 502, 503])('%i stays fatal as today', (s) => {
      expect(classifyDaemonFailure(err(httpError(s)))).toBe('fatal');
    });
    it('reads status from a duplicate-bundled class (shape, not instanceof)', () => {
      const other = Object.assign(new Error('x'), { status: 404 });
      expect(classifyDaemonFailure(err(other))).toBe('daemon_gone');
    });
    it('a transport failure with an HTTP status 401 is still fatal', () => {
      const e = Object.assign(fetchFailed('ECONNRESET'), { status: 401 });
      expect(classifyDaemonFailure(err(e))).toBe('fatal');
    });
  });

  describe('retry', () => {
    it('already active is a retry', () => {
      expect(
        classifyDaemonFailure(
          err(
            new Error(
              'Another event subscription is already active on this session.',
            ),
          ),
        ),
      ).toBe('retry');
    });
    it('subscription active (SDK local guard) is a retry', () => {
      expect(classifyDaemonFailure(err(new Error('subscription active')))).toBe(
        'retry',
      );
    });
  });

  describe('unknown errors', () => {
    it.each([new Error('something odd'), 'a string', undefined, null, 42, {}])(
      '%j -> fatal',
      (e) => {
        expect(classifyDaemonFailure(err(e))).toBe('fatal');
      },
    );
    it('an abort is not a daemon loss', () => {
      const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
      expect(classifyDaemonFailure(err(abort))).toBe('fatal');
    });
  });

  describe('frames', () => {
    it('session_died -> daemon_gone', () => {
      expect(classifyDaemonFailure(frame('session_died'))).toBe('daemon_gone');
    });
    it.each([
      'session_update',
      'turn_complete',
      'replay_complete',
      'session_closed',
      'client_evicted',
      'stream_error',
      'permission_request',
    ])('%s -> retry (not a daemon loss)', (type) => {
      expect(classifyDaemonFailure(frame(type))).toBe('retry');
    });
    it('a frame without a type is not a loss', () => {
      expect(classifyDaemonFailure({ kind: 'frame', frame: {} as never })).toBe(
        'retry',
      );
    });
  });
});

describe('confirmDaemonGone', () => {
  it('waits, probes, and confirms when the probe fails', async () => {
    const order: string[] = [];
    const gone = await confirmDaemonGone({
      probe: async () => {
        order.push('probe');
        throw withCode('ECONNREFUSED');
      },
      sleep: async (ms) => {
        order.push(`sleep ${ms}`);
      },
      delayMs: 700,
    });
    expect(gone).toBe(true);
    expect(order).toEqual(['sleep 700', 'probe']);
  });

  it('is not confirmed when the daemon answers', async () => {
    const gone = await confirmDaemonGone({
      probe: async () => ({ status: 'ok' }),
      sleep: async () => {},
      delayMs: 1,
    });
    expect(gone).toBe(false);
  });

  it('treats a probe that hangs as failed after the probe timeout', async () => {
    vi.useFakeTimers();
    try {
      const p = confirmDaemonGone({
        probe: () => new Promise(() => {}),
        sleep: async () => {},
        delayMs: 0,
        probeTimeoutMs: 3000,
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await p).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 401 from the probe means the daemon is up: not gone', async () => {
    const gone = await confirmDaemonGone({
      probe: async () => {
        throw httpError(401);
      },
      sleep: async () => {},
      delayMs: 0,
    });
    expect(gone).toBe(false);
  });
});
