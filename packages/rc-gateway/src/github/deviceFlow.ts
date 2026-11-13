/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Connect a GitHub account from the phone by OAuth device flow
 * (InfiniteInsight/Qwen-Code-Remote#257). The gateway asks GitHub for a
 * device code, shows the owner the user code, and polls until the owner
 * approves it at github.com/login/device. The token goes straight into
 * {@link OAuthTokenStore}; the device code and the token never leave this
 * module: not in `status()`, not in an error, not in the `onEnd` event. The
 * user code is handed back by `start()` once, because showing it on the phone
 * is its purpose, and is never kept anywhere else or logged.
 *
 * Device flow only (no client secret). Each flow stops polling on success,
 * denial, expiry, an unrecoverable error, a hard deadline at `expires_in`, or
 * `stopAll()`. Every timer is unref-ed, so a flow never keeps the process
 * alive. At most {@link MAX_LIVE_FLOWS} flows run at once, and an ended flow
 * is kept for {@link DEVICE_FLOW_KEEP_MS} so the page can read how it ended.
 */

import { randomBytes } from 'node:crypto';
import { GITHUB_LOGIN, type OAuthTokenStore } from './credentials.js';

export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const USER_URL = 'https://api.github.com/user';
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export const DEVICE_FLOW_SCOPE = 'repo';

/** A client ID as the plan's config accepts it. */
export const CLIENT_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

/** Flows polling at once; a looping caller gets `too_many_flows` beyond it. */
export const MAX_LIVE_FLOWS = 4;
/** How long an ended flow's status stays readable. */
export const DEVICE_FLOW_KEEP_MS = 60 * 60 * 1000;
/** Ended flows kept at most, oldest dropped first. */
export const MAX_KEPT_FLOWS = 32;
/** One HTTP request's time cap. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Longest wait between polls after transient failures. */
export const MAX_BACKOFF_MS = 60_000;
/** Waits before retrying the user lookup after a transient failure. */
export const USER_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000];

const MAX_EXPIRES_S = 3600;
const MAX_INTERVAL_S = 300;
const SLOW_DOWN_STEP_MS = 5_000;
const MAX_BODY_CHARS = 64 * 1024;

const DEVICE_CODE_SHAPE = /^[\x21-\x7e]{1,512}$/;
const USER_CODE_SHAPE = /^[A-Za-z0-9-]{4,32}$/;
const TOKEN_SHAPE = /^[\x21-\x7e]{1,4096}$/;
const SCOPE_SHAPE = /^[A-Za-z0-9:_.-]{1,100}$/;
const ERROR_CODE_SHAPE = /^[a-z0-9_]{1,64}$/;
const FLOW_ID_SHAPE = /^[0-9a-f]{32}$/;
const USER_AGENT = 'qwen-code-rc-gateway';

/** Error codes GitHub documents for the device flow's token poll. */
const KNOWN_POLL_ERRORS = new Set([
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
  'unsupported_grant_type',
  'incorrect_client_credentials',
  'incorrect_device_code',
  'device_flow_disabled',
]);

export type DeviceFlowState =
  | 'pending'
  | 'connected'
  | 'denied'
  | 'expired'
  | 'failed';

/**
 * What the page may see of a flow. `login` once connected; `code` when
 * failed: GitHub's error code, or one of `invalid_response`,
 * `user_lookup_failed`, `invalid_login`, `store_failed`, `stopped`.
 */
export interface DeviceFlowStatus {
  state: DeviceFlowState;
  login?: string;
  code?: string;
}

/** Raised once per flow when it ends; for the audit log. No secrets. */
export interface DeviceFlowEnd extends DeviceFlowStatus {
  flowId: string;
}

export interface DeviceFlowStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

/** The part of the token store a flow writes to. */
export type DeviceFlowStore = Pick<OAuthTokenStore, 'put'>;

export type TimerSet = (fn: () => void, ms: number) => unknown;
export type TimerClear = (handle: unknown) => void;

/** A failure of `start()` with a stable code; the message holds no secret. */
export class DeviceFlowError extends Error {
  constructor(
    readonly code:
      | 'oauth_not_configured'
      | 'too_many_flows'
      | 'github_failed'
      | 'stopped',
    message: string = code,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

interface Flow {
  id: string;
  /** Private: sent to GitHub only, never copied into a status or error. */
  deviceCode: string;
  state: DeviceFlowState;
  login?: string;
  code?: string;
  intervalMs: number;
  failures: number;
  pollTimer?: unknown;
  deadlineTimer?: unknown;
  inFlight?: AbortController;
  endedAt?: number;
}

/** One answer read off the wire; `json` is undefined when it was not JSON. */
interface Answer {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | undefined;
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** An https URL on github.com itself, with no credentials or port. */
function githubHttpsUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 512) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    return undefined;
  }
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    return undefined;
  }
  return url.href;
}

export class DeviceFlows {
  private readonly clientId: string | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private readonly store: DeviceFlowStore;
  private readonly now: () => number;
  private readonly setTimer: TimerSet;
  private readonly clearTimer: TimerClear;
  private readonly onEnd: ((e: DeviceFlowEnd) => void) | undefined;
  private readonly flows = new Map<string, Flow>();
  /** Starts waiting on GitHub's device code answer; they hold a slot. */
  private starting = 0;
  /** Bumped by stopAll so a start in progress cannot add a flow after it. */
  private epoch = 0;

  constructor(deps: {
    clientId: string | undefined;
    fetch: typeof globalThis.fetch;
    store: DeviceFlowStore;
    now?: () => number;
    setTimeout?: TimerSet;
    clearTimeout?: TimerClear;
    onEnd?: (e: DeviceFlowEnd) => void;
  }) {
    this.clientId =
      typeof deps.clientId === 'string' && CLIENT_ID_SHAPE.test(deps.clientId)
        ? deps.clientId
        : undefined;
    this.fetch = deps.fetch;
    this.store = deps.store;
    this.now = deps.now ?? (() => Date.now());
    // Looked up at call time, so fake timers installed later still apply.
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimeout ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onEnd = deps.onEnd;
  }

  configured(): boolean {
    return this.clientId !== undefined;
  }

  /**
   * Ask GitHub for a device code and start polling. Throws
   * `oauth_not_configured`, `too_many_flows`, or `github_failed` (the message
   * names the HTTP status and GitHub's error code, never a code or token).
   */
  async start(): Promise<DeviceFlowStart> {
    const clientId = this.clientId;
    if (clientId === undefined) {
      throw new DeviceFlowError('oauth_not_configured');
    }
    this.prune();
    if (this.liveCount() + this.starting >= MAX_LIVE_FLOWS) {
      throw new DeviceFlowError(
        'too_many_flows',
        `at most ${MAX_LIVE_FLOWS} GitHub connections can be in progress at once`,
      );
    }
    const epoch = this.epoch;
    this.starting++;
    let answer: Answer | undefined;
    try {
      answer = await this.request(
        DEVICE_CODE_URL,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: new URLSearchParams({
            client_id: clientId,
            scope: DEVICE_FLOW_SCOPE,
          }).toString(),
        },
        undefined,
      );
    } finally {
      this.starting--;
    }
    if (epoch !== this.epoch) {
      throw new DeviceFlowError('stopped', 'the gateway is shutting down');
    }
    const fail = (why: string, status?: number): never => {
      throw new DeviceFlowError(
        'github_failed',
        `GitHub device code request failed: ${why}`,
        status,
      );
    };
    if (!answer) return fail('network error or timeout');
    const errCode = answer.json?.['error'];
    if (typeof errCode === 'string') {
      return fail(
        ERROR_CODE_SHAPE.test(errCode) ? errCode : 'unexpected error',
        answer.status,
      );
    }
    if (!answer.ok) return fail(`HTTP ${answer.status}`, answer.status);
    const j = answer.json;
    if (!j) return fail('answer was not JSON', answer.status);
    const deviceCode = j['device_code'];
    const userCode = j['user_code'];
    const verificationUri = githubHttpsUrl(j['verification_uri']);
    const expiresIn = j['expires_in'];
    const interval = j['interval'];
    if (
      typeof deviceCode !== 'string' ||
      !DEVICE_CODE_SHAPE.test(deviceCode) ||
      typeof userCode !== 'string' ||
      !USER_CODE_SHAPE.test(userCode) ||
      verificationUri === undefined ||
      !isInt(expiresIn, 1, MAX_EXPIRES_S) ||
      !isInt(interval, 1, MAX_INTERVAL_S)
    ) {
      return fail('unexpected answer');
    }

    const flow: Flow = {
      id: randomBytes(16).toString('hex'),
      deviceCode,
      state: 'pending',
      intervalMs: interval * 1000,
      failures: 0,
    };
    this.flows.set(flow.id, flow);
    flow.deadlineTimer = this.timer(
      () => this.end(flow, 'expired'),
      expiresIn * 1000,
    );
    this.schedule(flow, flow.intervalMs);
    return { flowId: flow.id, userCode, verificationUri, expiresIn };
  }

  /** A flow's state; null for an unknown, malformed or dropped id. */
  status(flowId: string): DeviceFlowStatus | null {
    this.prune();
    if (typeof flowId !== 'string' || !FLOW_ID_SHAPE.test(flowId)) return null;
    const flow = this.flows.get(flowId);
    if (!flow) return null;
    return publicStatus(flow);
  }

  /** End every live flow as `failed: stopped` and stop all their timers. */
  stopAll(): void {
    this.epoch++;
    for (const flow of this.flows.values()) {
      if (flow.state === 'pending') this.end(flow, 'failed', 'stopped');
    }
  }

  private liveCount(): number {
    let n = 0;
    for (const f of this.flows.values()) if (f.state === 'pending') n++;
    return n;
  }

  /** Drop ended flows older than the keep time, then beyond the keep cap. */
  private prune(): void {
    const now = this.now();
    const ended: Flow[] = [];
    for (const f of this.flows.values()) {
      if (f.endedAt === undefined) continue;
      if (now - f.endedAt >= DEVICE_FLOW_KEEP_MS) this.flows.delete(f.id);
      else ended.push(f);
    }
    ended.sort((a, b) => a.endedAt! - b.endedAt!);
    for (const f of ended.slice(
      0,
      Math.max(0, ended.length - MAX_KEPT_FLOWS),
    )) {
      this.flows.delete(f.id);
    }
  }

  private timer(fn: () => void, ms: number): unknown {
    const handle = this.setTimer(fn, ms);
    const h = handle as { unref?: () => unknown } | null;
    if (h && typeof h.unref === 'function') h.unref();
    return handle;
  }

  private schedule(flow: Flow, ms: number): void {
    if (flow.state !== 'pending') return;
    flow.pollTimer = this.timer(() => {
      flow.pollTimer = undefined;
      void this.poll(flow).catch(() => this.transient(flow));
    }, ms);
  }

  /** Retry after a failure that may pass: doubling from the interval. */
  private transient(flow: Flow): void {
    if (flow.state !== 'pending') return;
    flow.failures++;
    const delay = Math.max(
      flow.intervalMs,
      Math.min(flow.intervalMs * 2 ** flow.failures, MAX_BACKOFF_MS),
    );
    this.schedule(flow, delay);
  }

  private end(flow: Flow, state: DeviceFlowState, code?: string): void {
    if (flow.state !== 'pending') return;
    flow.state = state;
    if (code !== undefined) flow.code = code;
    flow.endedAt = this.now();
    flow.deviceCode = '';
    if (flow.pollTimer !== undefined) this.clearTimer(flow.pollTimer);
    if (flow.deadlineTimer !== undefined) this.clearTimer(flow.deadlineTimer);
    flow.pollTimer = undefined;
    flow.deadlineTimer = undefined;
    flow.inFlight?.abort();
    flow.inFlight = undefined;
    if (this.onEnd) {
      try {
        this.onEnd({ flowId: flow.id, ...publicStatus(flow) });
      } catch {
        // An audit hook that throws must not break the flow.
      }
    }
  }

  private async poll(flow: Flow): Promise<void> {
    if (flow.state !== 'pending') return;
    const answer = await this.request(
      ACCESS_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: this.clientId ?? '',
          device_code: flow.deviceCode,
          grant_type: DEVICE_GRANT_TYPE,
        }).toString(),
      },
      flow,
    );
    if (flow.state !== 'pending') return;
    if (!answer || !answer.json) {
      this.transient(flow);
      return;
    }
    const j = answer.json;
    const error = j['error'];
    if (typeof error === 'string') {
      if (KNOWN_POLL_ERRORS.has(error)) {
        this.onPollError(flow, error, j['interval']);
        return;
      }
      if (!answer.ok) {
        // An error GitHub does not document, on a non-2xx: may pass.
        this.transient(flow);
        return;
      }
      this.end(
        flow,
        'failed',
        ERROR_CODE_SHAPE.test(error) ? error : 'invalid_response',
      );
      return;
    }
    if (!answer.ok) {
      this.transient(flow);
      return;
    }
    const token = j['access_token'];
    const tokenType = j['token_type'];
    const scope = j['scope'];
    if (
      typeof token !== 'string' ||
      !TOKEN_SHAPE.test(token) ||
      typeof tokenType !== 'string' ||
      tokenType.toLowerCase() !== 'bearer' ||
      typeof scope !== 'string'
    ) {
      this.end(flow, 'failed', 'invalid_response');
      return;
    }
    const scopes = scope.split(/[,\s]+/).filter((s) => s.length > 0);
    if (!scopes.every((s) => SCOPE_SHAPE.test(s))) {
      this.end(flow, 'failed', 'invalid_response');
      return;
    }
    // The device code is spent: the expiry no longer applies, and nothing
    // may poll again.
    if (flow.deadlineTimer !== undefined) this.clearTimer(flow.deadlineTimer);
    flow.deadlineTimer = undefined;
    flow.deviceCode = '';
    await this.finish(flow, token, scopes);
  }

  private onPollError(flow: Flow, error: string, interval: unknown): void {
    switch (error) {
      case 'authorization_pending':
        flow.failures = 0;
        this.schedule(flow, flow.intervalMs);
        return;
      case 'slow_down': {
        flow.failures = 0;
        const stepped = flow.intervalMs + SLOW_DOWN_STEP_MS;
        const given = isInt(interval, 1, MAX_INTERVAL_S) ? interval * 1000 : 0;
        flow.intervalMs = Math.min(
          Math.max(stepped, given),
          MAX_INTERVAL_S * 1000,
        );
        this.schedule(flow, flow.intervalMs);
        return;
      }
      case 'expired_token':
        this.end(flow, 'expired');
        return;
      case 'access_denied':
        this.end(flow, 'denied');
        return;
      default:
        this.end(flow, 'failed', error);
    }
  }

  /** Look up the login, store the token, and end connected. */
  private async finish(
    flow: Flow,
    token: string,
    scopes: string[],
  ): Promise<void> {
    let login: unknown;
    for (let attempt = 0; ; attempt++) {
      const answer = await this.request(
        USER_URL,
        {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': USER_AGENT,
          },
        },
        flow,
      );
      if (flow.state !== 'pending') return;
      if (answer && answer.ok && answer.json) {
        login = answer.json['login'];
        break;
      }
      if (answer && answer.status >= 400 && answer.status < 500) {
        this.end(flow, 'failed', 'user_lookup_failed');
        return;
      }
      const delay = USER_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        this.end(flow, 'failed', 'user_lookup_failed');
        return;
      }
      await new Promise<void>((resolve) => {
        flow.pollTimer = this.timer(() => {
          flow.pollTimer = undefined;
          resolve();
        }, delay);
      });
      // stopAll clears the timer above, so the wait never resolves for a
      // stopped flow: nothing below runs for it.
    }
    if (typeof login !== 'string' || !GITHUB_LOGIN.test(login)) {
      this.end(flow, 'failed', 'invalid_login');
      return;
    }
    try {
      await this.store.put(login, token, scopes);
    } catch {
      this.end(flow, 'failed', 'store_failed');
      return;
    }
    if (flow.state !== 'pending') return;
    flow.login = login;
    this.end(flow, 'connected');
  }

  /**
   * One request with a time cap. Undefined on a network error, an abort or a
   * timeout. The body is parsed as a JSON object when it is one.
   */
  private async request(
    url: string,
    init: RequestInit,
    flow: Flow | undefined,
  ): Promise<Answer | undefined> {
    const ctl = new AbortController();
    if (flow) flow.inFlight = ctl;
    const timeout = this.timer(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetch(url, {
        ...init,
        signal: ctl.signal,
        redirect: 'error',
      });
      const text = await res.text();
      let json: Record<string, unknown> | undefined;
      if (text.length <= MAX_BODY_CHARS) {
        try {
          const parsed = JSON.parse(text) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            json = parsed as Record<string, unknown>;
          }
        } catch {
          // not JSON
        }
      }
      return { ok: res.ok, status: res.status, json };
    } catch {
      return undefined;
    } finally {
      this.clearTimer(timeout);
      if (flow && flow.inFlight === ctl) flow.inFlight = undefined;
    }
  }
}

function publicStatus(flow: Flow): DeviceFlowStatus {
  const out: DeviceFlowStatus = { state: flow.state };
  if (flow.login !== undefined) out.login = flow.login;
  if (flow.code !== undefined) out.code = flow.code;
  return out;
}
