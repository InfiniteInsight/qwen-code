/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { promptFailureNotice, voteFailureNotice } from './gatewayReplies.js';

describe('promptFailureNotice (#168)', () => {
  it('stays quiet on success, a ban and a 429 (handled by the dispatcher)', () => {
    expect(promptFailureNotice({ ok: true, status: 200 })).toBeUndefined();
    expect(
      promptFailureNotice({
        ok: false,
        status: 403,
        body: { code: 'sub_actor_banned' },
      }),
    ).toBeUndefined();
    expect(promptFailureNotice({ ok: false, status: 429 })).toBeUndefined();
  });

  it('names the gateway code for the three timeouts and outages', () => {
    const say = (status: number, code: string) =>
      promptFailureNotice({ ok: false, status, body: { code } });
    expect(say(503, 'queue_timeout')).toContain('(503 queue_timeout)');
    expect(say(503, 'queue_timeout')).toContain('busy');
    expect(say(504, 'prompt_timeout')).toContain('timed out');
    expect(say(502, 'daemon_unavailable')).toContain('daemon is unavailable');
    expect(say(409, 'session_not_loaded')).toContain('not open');
  });

  it('falls back to the bare status for an answer it does not know', () => {
    expect(promptFailureNotice({ ok: false, status: 500 })).toBe(
      'Prompt not run: the gateway answered 500.',
    );
  });
});

describe('a 403 that is not a ban (#168)', () => {
  it('is reported like any other refusal, for prompts and votes', () => {
    const scope = {
      ok: false,
      status: 403,
      body: { code: 'scope_required' },
    } as const;
    expect(promptFailureNotice(scope)).toContain('403 scope_required');
    expect(voteFailureNotice(scope)).toContain('403 scope_required');
  });
});

describe('voteFailureNotice (#168)', () => {
  it('is undefined for a counted vote and for a 403 (the caller says blocked)', () => {
    expect(voteFailureNotice({ ok: true, status: 200 })).toBeUndefined();
    expect(
      voteFailureNotice({
        ok: false,
        status: 403,
        body: { code: 'sub_actor_banned' },
      }),
    ).toBeUndefined();
  });

  it('explains 404/409, 429 and anything else', () => {
    expect(voteFailureNotice({ ok: false, status: 404 })).toContain(
      'no longer pending',
    );
    expect(voteFailureNotice({ ok: false, status: 409 })).toContain(
      'no longer pending',
    );
    expect(
      voteFailureNotice({ ok: false, status: 429, retryAfterSec: 5 }),
    ).toContain('5 seconds');
    expect(voteFailureNotice({ ok: false, status: 503 })).toContain('503');
  });
});
