/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_FLOW_KEEP_MS,
  DeviceFlowError,
  DeviceFlows,
  MAX_LIVE_FLOWS,
  STORE_TIMEOUT_MS,
  type DeviceFlowEnd,
  type DeviceFlowStore,
} from './deviceFlow.js';

const DEVICE_CODE = '3584d83530557fdd1f46af8289938c8ef79f9dc5';
const USER_CODE = 'WDJB-MJHT';
const TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';
const CLIENT_ID = 'Iv1.abc123def456';

const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';

/** One scripted answer: a JSON body (status 200), a status + body, or a network error. */
type Answer =
  | Record<string, unknown>
  | { status: number; body: string | Record<string, unknown> }
  | 'network';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function isStatusAnswer(
  a: Answer,
): a is { status: number; body: string | Record<string, unknown> } {
  return (
    typeof a === 'object' &&
    typeof (a as { status?: unknown }).status === 'number' &&
    'body' in a
  );
}

function toResponse(a: Answer): Response {
  if (a === 'network') throw new TypeError('fetch failed');
  if (isStatusAnswer(a)) {
    const body = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
    return new Response(body, { status: a.status });
  }
  return new Response(JSON.stringify(a), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A GitHub that answers each URL from its own script, in order. A URL whose
 * script ran out answers 500 so a test sees the extra call.
 */
function fakeGitHub(script: {
  device?: Answer[];
  polls?: Answer[];
  user?: Answer[];
}) {
  const calls: Call[] = [];
  const queues: Record<string, Answer[]> = {
    [DEVICE_URL]: [
      ...(script.device ?? [
        {
          device_code: DEVICE_CODE,
          user_code: USER_CODE,
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        },
      ]),
    ],
    [TOKEN_URL]: [...(script.polls ?? [])],
    [USER_URL]: [...(script.user ?? [{ login: 'octocat', id: 1 }])],
  };
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body:
        typeof init?.body === 'string' ? init.body : String(init?.body ?? ''),
    });
    const q = queues[url];
    if (!q) throw new Error(`unexpected url ${url}`);
    const next = q.shift();
    if (next === undefined) return new Response('no more', { status: 500 });
    return toResponse(next);
  }) as typeof globalThis.fetch;
  const polls = () => calls.filter((c) => c.url === TOKEN_URL);
  return { fetch, calls, polls };
}

function fakeStore() {
  const puts: Array<{ login: string; token: string; scopes: string[] }> = [];
  const store: DeviceFlowStore = {
    put: async (login, token, scopes) => {
      puts.push({ login, token, scopes });
    },
  };
  return { store, puts };
}

const PENDING = { error: 'authorization_pending' };
const GRANTED = { access_token: TOKEN, token_type: 'bearer', scope: 'repo' };

describe('DeviceFlows', () => {
  let flows: DeviceFlows | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    flows?.stopAll();
    flows = undefined;
    vi.useRealTimers();
  });

  function make(
    gh: ReturnType<typeof fakeGitHub>,
    extra: Partial<ConstructorParameters<typeof DeviceFlows>[0]> = {},
  ) {
    const s = fakeStore();
    flows = new DeviceFlows({
      clientId: CLIENT_ID,
      fetch: gh.fetch,
      store: s.store,
      ...extra,
    });
    return { flows, puts: s.puts };
  }

  it('a flow polls until a token, stores it and reports connected with the login', async () => {
    const gh = fakeGitHub({ polls: [PENDING, PENDING, GRANTED] });
    const { flows, puts } = make(gh);
    const started = await flows.start();
    expect(started).toEqual({
      flowId: expect.stringMatching(/^[0-9a-f]{32}$/),
      userCode: USER_CODE,
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
    });
    const device = gh.calls[0]!;
    expect(device.url).toBe(DEVICE_URL);
    expect(device.method).toBe('POST');
    expect(device.headers['accept']).toBe('application/json');
    const deviceBody = new URLSearchParams(device.body);
    expect(deviceBody.get('client_id')).toBe(CLIENT_ID);
    expect(deviceBody.get('scope')).toBe('repo');
    expect(deviceBody.has('client_secret')).toBe(false);
    expect(flows.status(started.flowId)).toEqual({ state: 'pending' });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(gh.polls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(gh.polls()).toHaveLength(1);
    const poll = new URLSearchParams(gh.polls()[0]!.body);
    expect(poll.get('client_id')).toBe(CLIENT_ID);
    expect(poll.get('device_code')).toBe(DEVICE_CODE);
    expect(poll.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    expect(poll.has('client_secret')).toBe(false);
    expect(gh.polls()[0]!.headers['accept']).toBe('application/json');
    expect(flows.status(started.flowId)).toEqual({ state: 'pending' });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(gh.polls()).toHaveLength(3);
    const user = gh.calls.find((c) => c.url === USER_URL)!;
    expect(user.method).toBe('GET');
    expect(user.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(puts).toEqual([
      { login: 'octocat', token: TOKEN, scopes: ['repo'] },
    ]);
    expect(flows.status(started.flowId)).toEqual({
      state: 'connected',
      login: 'octocat',
    });

    // Nothing polls after the flow ended.
    const before = gh.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gh.calls).toHaveLength(before);
  });

  it('slow_down adds five seconds to the interval', async () => {
    const gh = fakeGitHub({
      polls: [{ error: 'slow_down' }, PENDING, PENDING],
    });
    const { flows } = make(gh);
    await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gh.polls()).toHaveLength(1);
    // The next poll is scheduled at interval + 5 s = 10 s, and stays there.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(gh.polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(gh.polls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(gh.polls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(gh.polls()).toHaveLength(3);
  });

  it('slow_down honours a larger interval GitHub sends with it', async () => {
    const gh = fakeGitHub({
      polls: [{ error: 'slow_down', interval: 20 }, PENDING],
    });
    const { flows } = make(gh);
    await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(gh.polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(gh.polls()).toHaveLength(2);
  });

  it('expired_token ends expired and access_denied ends denied, and neither stores anything', async () => {
    const ghExpired = fakeGitHub({
      polls: [PENDING, { error: 'expired_token' }],
    });
    const a = make(ghExpired);
    const one = await a.flows.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.flows.status(one.flowId)).toEqual({ state: 'expired' });
    expect(a.puts).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ghExpired.polls()).toHaveLength(2);
    a.flows.stopAll();

    const ghDenied = fakeGitHub({ polls: [{ error: 'access_denied' }] });
    const b = make(ghDenied);
    const two = await b.flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.flows.status(two.flowId)).toEqual({ state: 'denied' });
    expect(b.puts).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ghDenied.polls()).toHaveLength(1);
    expect(ghDenied.calls.some((c) => c.url === USER_URL)).toBe(false);
  });

  it('status never exposes the device code or the token', async () => {
    const ends: DeviceFlowEnd[] = [];
    const gh = fakeGitHub({ polls: [PENDING, GRANTED] });
    const { flows } = make(gh, { onEnd: (e) => ends.push(e) });
    const { flowId } = await flows.start();
    const seen = [JSON.stringify(flows.status(flowId))];
    await vi.advanceTimersByTimeAsync(5_000);
    seen.push(JSON.stringify(flows.status(flowId)));
    await vi.advanceTimersByTimeAsync(5_000);
    seen.push(JSON.stringify(flows.status(flowId)));
    expect(flows.status(flowId)?.state).toBe('connected');
    seen.push(JSON.stringify(ends));
    for (const text of seen) {
      expect(text).not.toContain(DEVICE_CODE);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(USER_CODE);
    }
    expect(ends).toEqual([{ flowId, state: 'connected', login: 'octocat' }]);
  });

  it('start without a client id throws oauth_not_configured', async () => {
    const gh = fakeGitHub({});
    for (const clientId of [undefined, '', 'has space', 'x'.repeat(65)]) {
      const s = fakeStore();
      const f = new DeviceFlows({ clientId, fetch: gh.fetch, store: s.store });
      expect(f.configured()).toBe(false);
      const err = await f.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeviceFlowError);
      expect((err as DeviceFlowError).code).toBe('oauth_not_configured');
    }
    expect(gh.calls).toEqual([]);
    expect(make(gh).flows.configured()).toBe(true);
  });

  it('status of an unknown or malformed id is null', async () => {
    const { flows } = make(fakeGitHub({}));
    expect(flows.status('0'.repeat(32))).toBeNull();
    expect(flows.status('not-an-id')).toBeNull();
    expect(flows.status(undefined as unknown as string)).toBeNull();
  });

  it('any other GitHub error ends failed with its code, even on a 4xx', async () => {
    const gh = fakeGitHub({
      polls: [{ status: 400, body: { error: 'device_flow_disabled' } }],
    });
    const { flows, puts } = make(gh);
    const { flowId } = await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flows.status(flowId)).toEqual({
      state: 'failed',
      code: 'device_flow_disabled',
    });
    expect(puts).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gh.polls()).toHaveLength(1);

    const gh2 = fakeGitHub({ polls: [{ error: 'some_new_error' }] });
    const b = make(gh2);
    const two = await b.flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.flows.status(two.flowId)).toEqual({
      state: 'failed',
      code: 'some_new_error',
    });
  });

  it('a network error, a non-JSON answer and a 5xx are retried with backoff, not fatal', async () => {
    const gh = fakeGitHub({
      polls: [
        'network',
        { status: 200, body: '<html>busy</html>' },
        { status: 502, body: 'bad gateway' },
        GRANTED,
      ],
    });
    const { flows, puts } = make(gh);
    const { flowId } = await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gh.polls()).toHaveLength(1);
    expect(flows.status(flowId)).toEqual({ state: 'pending' });
    // Backoff doubles from the interval: 10 s, then 20 s, then 40 s.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(gh.polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(gh.polls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(gh.polls()).toHaveLength(3);
    expect(flows.status(flowId)).toEqual({ state: 'pending' });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(gh.polls()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(gh.polls()).toHaveLength(4);
    expect(flows.status(flowId)).toEqual({
      state: 'connected',
      login: 'octocat',
    });
    expect(puts).toHaveLength(1);
  });

  it('the hard deadline at expires_in ends the flow expired and stops polling', async () => {
    const pending = Array.from({ length: 100 }, () => PENDING);
    const gh = fakeGitHub({
      device: [
        {
          device_code: DEVICE_CODE,
          user_code: USER_CODE,
          verification_uri: 'https://github.com/login/device',
          expires_in: 30,
          interval: 5,
        },
      ],
      polls: pending,
    });
    const ends: DeviceFlowEnd[] = [];
    const { flows } = make(gh, { onEnd: (e) => ends.push(e) });
    const { flowId } = await flows.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(flows.status(flowId)).toEqual({ state: 'pending' });
    await vi.advanceTimersByTimeAsync(1);
    expect(flows.status(flowId)).toEqual({ state: 'expired' });
    const n = gh.polls().length;
    expect(n).toBeLessThanOrEqual(6);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(gh.polls()).toHaveLength(n);
    expect(ends).toEqual([{ flowId, state: 'expired' }]);
  });

  it('a token that arrives after the flow ended is discarded', async () => {
    let release: (() => void) | undefined;
    const base = fakeGitHub({ polls: [GRANTED] });
    const slow = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === TOKEN_URL) {
        await new Promise<void>((r) => (release = r));
      }
      return base.fetch(input as string, init);
    }) as typeof globalThis.fetch;
    const s = fakeStore();
    flows = new DeviceFlows({
      clientId: CLIENT_ID,
      fetch: slow,
      store: s.store,
    });
    const { flowId } = await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(release).toBeDefined();
    flows.stopAll();
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.puts).toEqual([]);
    expect(flows.status(flowId)).toEqual({ state: 'failed', code: 'stopped' });
    expect(base.calls.some((c) => c.url === USER_URL)).toBe(false);
  });

  it('a start still waiting on GitHub when stopAll runs adds no flow', async () => {
    let release: (() => void) | undefined;
    const base = fakeGitHub({ polls: [PENDING] });
    const slow = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === DEVICE_URL) {
        await new Promise<void>((r) => (release = r));
      }
      return base.fetch(input as string, init);
    }) as typeof globalThis.fetch;
    const s = fakeStore();
    flows = new DeviceFlows({
      clientId: CLIENT_ID,
      fetch: slow,
      store: s.store,
    });
    const pending = flows.start().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    flows.stopAll();
    release!();
    const err = (await pending) as DeviceFlowError;
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect(err.code).toBe('stopped');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(base.polls()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stopAll ends every live flow and nothing polls afterwards', async () => {
    const gh = fakeGitHub({
      device: [
        {
          device_code: DEVICE_CODE,
          user_code: USER_CODE,
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        },
        {
          device_code: 'second-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        },
      ],
      polls: Array.from({ length: 10 }, () => PENDING),
    });
    const { flows } = make(gh);
    const a = await flows.start();
    const b = await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gh.polls()).toHaveLength(2);
    flows.stopAll();
    expect(flows.status(a.flowId)).toEqual({
      state: 'failed',
      code: 'stopped',
    });
    expect(flows.status(b.flowId)).toEqual({
      state: 'failed',
      code: 'stopped',
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(gh.polls()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps live flows and frees a slot when one ends', async () => {
    const device = (i: number) => ({
      device_code: `device-code-${i}`,
      user_code: `CODE-000${i}`,
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    });
    const gh = fakeGitHub({
      device: Array.from({ length: MAX_LIVE_FLOWS + 2 }, (_, i) => device(i)),
      polls: [{ error: 'access_denied' }],
    });
    const { flows } = make(gh);
    const started = [];
    for (let i = 0; i < MAX_LIVE_FLOWS; i++) started.push(await flows.start());
    const err = await flows.start().catch((e: unknown) => e);
    expect((err as DeviceFlowError).code).toBe('too_many_flows');
    expect(gh.calls.filter((c) => c.url === DEVICE_URL)).toHaveLength(
      MAX_LIVE_FLOWS,
    );
    // The first flow's poll is denied: its slot is free again.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flows.status(started[0]!.flowId)?.state).toBe('denied');
    await expect(flows.start()).resolves.toMatchObject({
      userCode: 'CODE-0004',
    });
  });

  it('concurrent starts cannot overshoot the cap', async () => {
    const gh = fakeGitHub({
      device: Array.from({ length: 10 }, (_, i) => ({
        device_code: `device-code-${i}`,
        user_code: `CODE-000${i}`,
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      })),
    });
    const { flows } = make(gh);
    const results = await Promise.allSettled(
      Array.from({ length: MAX_LIVE_FLOWS + 3 }, () => flows.start()),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
      MAX_LIVE_FLOWS,
    );
    expect(gh.calls.filter((c) => c.url === DEVICE_URL)).toHaveLength(
      MAX_LIVE_FLOWS,
    );
  });

  it('a finished flow is kept for one hour, then dropped', async () => {
    const gh = fakeGitHub({ polls: [{ error: 'access_denied' }] });
    const { flows } = make(gh);
    const { flowId } = await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flows.status(flowId)?.state).toBe('denied');
    await vi.advanceTimersByTimeAsync(DEVICE_FLOW_KEEP_MS - 1);
    expect(flows.status(flowId)?.state).toBe('denied');
    await vi.advanceTimersByTimeAsync(1);
    expect(flows.status(flowId)).toBeNull();
  });

  it('refuses a device answer whose fields are not what GitHub documents', async () => {
    const good = {
      device_code: DEVICE_CODE,
      user_code: USER_CODE,
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    };
    const bad: Array<Record<string, unknown>> = [
      { ...good, verification_uri: 'http://github.com/login/device' },
      { ...good, verification_uri: 'https://evil.example/login/device' },
      { ...good, verification_uri: 'https://github.com.evil.example/x' },
      { ...good, verification_uri: 'https://user@github.com/login/device' },
      { ...good, verification_uri: 'javascript:alert(1)' },
      { ...good, device_code: 42 },
      { ...good, user_code: '<script>' },
      { ...good, expires_in: -1 },
      { ...good, expires_in: '900' },
      { ...good, interval: 0 },
      { ...good, interval: 1e9 },
    ];
    for (const answer of bad) {
      const gh = fakeGitHub({ device: [answer] });
      const { flows } = make(gh);
      const err = await flows.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeviceFlowError);
      expect((err as DeviceFlowError).code).toBe('github_failed');
      expect(String((err as Error).message)).not.toContain(DEVICE_CODE);
      expect(String((err as Error).message)).not.toContain(USER_CODE);
      flows.stopAll();
    }
  });

  it('a device code request GitHub refuses throws github_failed naming its error code', async () => {
    const gh = fakeGitHub({
      device: [{ status: 400, body: { error: 'device_flow_disabled' } }],
    });
    const { flows } = make(gh);
    const err = (await flows
      .start()
      .catch((e: unknown) => e)) as DeviceFlowError;
    expect(err.code).toBe('github_failed');
    expect(err.message).toContain('device_flow_disabled');

    const gh2 = fakeGitHub({ device: ['network'] });
    const err2 = (await make(gh2)
      .flows.start()
      .catch((e: unknown) => e)) as DeviceFlowError;
    expect(err2.code).toBe('github_failed');
    // A failed start holds no slot.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a login GitHub returns that is not a valid login stores nothing', async () => {
    const gh = fakeGitHub({
      polls: [GRANTED],
      user: [{ login: '--upload-pack=evil' }],
    });
    const { flows, puts } = make(gh);
    const { flowId } = await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flows.status(flowId)).toEqual({
      state: 'failed',
      code: 'invalid_login',
    });
    expect(puts).toEqual([]);
  });

  it('a malformed token answer or a token the user lookup rejects ends failed', async () => {
    const gh = fakeGitHub({
      polls: [
        { access_token: 'has space', token_type: 'bearer', scope: 'repo' },
      ],
    });
    const a = make(gh);
    const one = await a.flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.flows.status(one.flowId)).toEqual({
      state: 'failed',
      code: 'invalid_response',
    });
    a.flows.stopAll();

    const gh2 = fakeGitHub({
      polls: [GRANTED],
      user: [{ status: 401, body: { message: 'Bad credentials' } }],
    });
    const b = make(gh2);
    const two = await b.flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.flows.status(two.flowId)).toEqual({
      state: 'failed',
      code: 'user_lookup_failed',
    });
    expect(b.puts).toEqual([]);
  });

  it('a user lookup network error is retried before connecting', async () => {
    const gh = fakeGitHub({
      polls: [GRANTED],
      user: ['network', { login: 'octocat' }],
    });
    const { flows, puts } = make(gh);
    const { flowId } = await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flows.status(flowId)).toEqual({ state: 'pending' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(flows.status(flowId)).toEqual({
      state: 'connected',
      login: 'octocat',
    });
    expect(puts).toEqual([
      { login: 'octocat', token: TOKEN, scopes: ['repo'] },
    ]);
  });

  it('a store that cannot save ends failed with store_failed', async () => {
    const gh = fakeGitHub({ polls: [GRANTED] });
    flows = new DeviceFlows({
      clientId: CLIENT_ID,
      fetch: gh.fetch,
      store: {
        put: async () => {
          throw new Error(`disk full while writing ${TOKEN}`);
        },
      },
    });
    const { flowId } = await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const st = flows.status(flowId);
    expect(st).toEqual({ state: 'failed', code: 'store_failed' });
    expect(JSON.stringify(st)).not.toContain(TOKEN);
  });

  it('splits comma-separated scopes', async () => {
    const gh = fakeGitHub({
      polls: [
        { access_token: TOKEN, token_type: 'bearer', scope: 'repo,read:org' },
      ],
    });
    const { flows, puts } = make(gh);
    await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(puts[0]?.scopes).toEqual(['repo', 'read:org']);
  });

  it('every timer it sets is unref-ed', async () => {
    const unref = vi.fn();
    const handles: unknown[] = [];
    const setT = (fn: () => void, ms: number) => {
      const h = setTimeout(fn, ms);
      handles.push(h);
      return { unref, h };
    };
    const clearT = (h: unknown) =>
      clearTimeout((h as { h: ReturnType<typeof setTimeout> }).h);
    const gh = fakeGitHub({ polls: [PENDING, GRANTED] });
    const { flows } = make(gh, { setTimeout: setT, clearTimeout: clearT });
    await flows.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handles.length).toBeGreaterThan(0);
    expect(unref).toHaveBeenCalledTimes(handles.length);
  });

  it('an expiring token (GitHub App style) ends expiring_token_unsupported and stores nothing', async () => {
    for (const extra of [
      { refresh_token: 'ghr_1B4a2e77838347a7E420ce178F2E7c6912E169246c34E1' },
      { expires_in: 28800 },
      { refresh_token_expires_in: 15811200 },
    ]) {
      const ends: DeviceFlowEnd[] = [];
      const gh = fakeGitHub({ polls: [{ ...GRANTED, ...extra }] });
      const { flows, puts } = make(gh, { onEnd: (e) => ends.push(e) });
      const { flowId } = await flows.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(flows.status(flowId)).toEqual({
        state: 'failed',
        code: 'expiring_token_unsupported',
      });
      expect(puts).toEqual([]);
      expect(gh.calls.some((c) => c.url === USER_URL)).toBe(false);
      expect(JSON.stringify(ends)).not.toContain('ghr_');
      flows.stopAll();
    }
  });

  it('a grant without the repo scope ends scope_missing and stores nothing', async () => {
    for (const scope of ['', 'gist', 'read:org,gist']) {
      const gh = fakeGitHub({
        polls: [{ access_token: TOKEN, token_type: 'bearer', scope }],
      });
      const { flows, puts } = make(gh);
      const { flowId } = await flows.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(flows.status(flowId)).toEqual({
        state: 'failed',
        code: 'scope_missing',
      });
      expect(puts).toEqual([]);
      flows.stopAll();
    }
  });

  it('stopAll during the store write lets it finish, so status and onEnd match what was stored', async () => {
    let release: (() => void) | undefined;
    const puts: string[] = [];
    const ends: DeviceFlowEnd[] = [];
    const gh = fakeGitHub({ polls: [GRANTED] });
    flows = new DeviceFlows({
      clientId: CLIENT_ID,
      fetch: gh.fetch,
      store: {
        put: async (login) => {
          await new Promise<void>((r) => (release = r));
          puts.push(login);
        },
      },
      onEnd: (e) => ends.push(e),
    });
    const { flowId } = await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(release).toBeDefined();
    flows.stopAll();
    expect(flows.status(flowId)).toEqual({ state: 'pending' });
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts).toEqual(['octocat']);
    expect(flows.status(flowId)).toEqual({
      state: 'connected',
      login: 'octocat',
    });
    expect(ends).toEqual([{ flowId, state: 'connected', login: 'octocat' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a store write that hangs ends store_failed after its timeout and frees the slot', async () => {
    const gh = fakeGitHub({
      device: Array.from({ length: MAX_LIVE_FLOWS + 1 }, (_, i) => ({
        device_code: `device-code-${i}`,
        user_code: `CODE-000${i}`,
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      })),
      polls: [GRANTED],
    });
    flows = new DeviceFlows({
      clientId: CLIENT_ID,
      fetch: gh.fetch,
      store: { put: () => new Promise<void>(() => {}) },
    });
    const started = [];
    for (let i = 0; i < MAX_LIVE_FLOWS; i++) started.push(await flows.start());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flows.status(started[0]!.flowId)).toEqual({ state: 'pending' });
    await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS);
    expect(flows.status(started[0]!.flowId)).toEqual({
      state: 'failed',
      code: 'store_failed',
    });
    await expect(flows.start()).resolves.toMatchObject({
      userCode: `CODE-000${MAX_LIVE_FLOWS}`,
    });
  });

  it('token_expired ends expired like expired_token', async () => {
    const gh = fakeGitHub({ polls: [{ error: 'token_expired' }] });
    const { flows, puts } = make(gh);
    const { flowId } = await flows.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flows.status(flowId)).toEqual({ state: 'expired' });
    expect(puts).toEqual([]);
  });

  it('a device answer without an interval polls every 5 s', async () => {
    const gh = fakeGitHub({
      device: [
        {
          device_code: DEVICE_CODE,
          user_code: USER_CODE,
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
        },
      ],
      polls: [PENDING, PENDING],
    });
    const { flows } = make(gh);
    await flows.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(gh.polls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(gh.polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gh.polls()).toHaveLength(2);
  });
});
