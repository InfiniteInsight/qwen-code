/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpChannel } from './channel.js';
import { raceLongLived } from './race-long-lived.js';
import { BridgeChannelClosedError } from './status.js';
import { withTimeout } from './with-timeout.js';

const CHANNEL_UNAVAILABLE: unique symbol = Symbol('channel unavailable');

const unavailableSignals = new WeakMap<
  AcpChannel,
  Promise<typeof CHANNEL_UNAVAILABLE>
>();

// Built once per channel: every reaction on `channel.exited` stays queued
// until the channel exits, so deriving a fresh promise from it per call would
// keep each call's race alive for the channel's lifetime.
function channelUnavailable(
  channel: AcpChannel,
): Promise<typeof CHANNEL_UNAVAILABLE> {
  const existing = unavailableSignals.get(channel);
  if (existing) return existing;
  const unavailable = channel.transportFailed
    ? Promise.race([channel.exited, channel.transportFailed])
    : channel.exited;
  const mark = (): typeof CHANNEL_UNAVAILABLE => CHANNEL_UNAVAILABLE;
  const signal = unavailable.then(mark, mark);
  unavailableSignals.set(channel, signal);
  return signal;
}

export async function terminateChannel(
  channel: AcpChannel,
  timeoutMs: number,
  context: string,
): Promise<void> {
  try {
    await withTimeout(channel.kill(), timeoutMs, `${context} teardown`);
  } catch (error) {
    try {
      channel.killSync();
    } catch (forceError) {
      throw new AggregateError(
        [error, forceError],
        `ACP channel teardown failed (${context})`,
      );
    }
    throw error;
  }
}

export function channelUnavailableReject(
  channel: AcpChannel,
  context: string,
): Promise<never> {
  const unavailable = channel.transportFailed
    ? Promise.race([channel.exited, channel.transportFailed])
    : channel.exited;
  const reject = () => {
    throw new BridgeChannelClosedError(context);
  };
  const rejected = unavailable.then(reject, reject);
  void rejected.catch(() => {});
  return rejected;
}

/**
 * One rejection fanned out to the requests still waiting on it. A request
 * must never race a promise that outlives it directly: each race leaves a
 * reaction that is never removed and keeps that request's result reachable.
 */
export interface ClosedFanout {
  /** Reject callbacks of requests still pending; each removes its own. */
  readonly waiters: Set<(error: unknown) => void>;
  /** Set once `closed` rejected; later requests reject at once. */
  closed?: { error: unknown };
}

/**
 * Attach the fan-out's one reaction to `closed`. Module-level on purpose: the
 * handler lives as long as `closed`, so it must close over the fan-out only,
 * never a caller's request or session state.
 */
export function armClosedFanout(closed: Promise<never>): ClosedFanout {
  const fanout: ClosedFanout = { waiters: new Set() };
  void closed.then(undefined, (error: unknown) => {
    fanout.closed = { error };
    const pending = [...fanout.waiters];
    fanout.waiters.clear();
    for (const reject of pending) reject(error);
  });
  return fanout;
}

/**
 * Settle with `work`, or reject with the fan-out's error if it fires first.
 * Pass freshly dispatched work: unlike `Promise.race`, an already-recorded
 * close wins even over a `work` that has already settled.
 */
export function raceClosedFanout<T>(
  fanout: ClosedFanout,
  work: PromiseLike<T>,
): Promise<T>;
export function raceClosedFanout<W extends readonly unknown[]>(
  fanout: ClosedFanout,
  works: W,
): Promise<Awaited<W[number]>>;
export function raceClosedFanout(
  fanout: ClosedFanout,
  work: PromiseLike<unknown> | readonly unknown[],
): Promise<unknown> {
  const works: readonly unknown[] = Array.isArray(work) ? work : [work];
  return new Promise<unknown>((resolve, reject) => {
    if (fanout.closed) {
      reject(fanout.closed.error);
    } else {
      fanout.waiters.add(reject);
    }
    const release = () => fanout.waiters.delete(reject);
    // Always observe each `work`, so a rejection after the close is handled
    // here rather than reported as unhandled.
    for (const each of works) {
      Promise.resolve(each).then(
        (value) => {
          release();
          resolve(value);
        },
        (error: unknown) => {
          release();
          reject(error);
        },
      );
    }
  });
}

const channelUnavailableWaiterCounts = new WeakMap<AcpChannel, number>();

/**
 * Settles like `work` unless the channel exits or its transport fails first,
 * in which case it rejects with `BridgeChannelClosedError(context)`. For
 * per-operation races: unlike racing `channelUnavailableReject(...)`, it
 * leaves nothing on the channel once the operation settles.
 */
export async function raceChannelUnavailable<T>(
  channel: AcpChannel,
  work: PromiseLike<T>,
  context: string,
): Promise<T> {
  const signal = channelUnavailable(channel);
  channelUnavailableWaiterCounts.set(
    channel,
    (channelUnavailableWaiterCounts.get(channel) ?? 0) + 1,
  );
  try {
    const result = await raceLongLived(work, signal);
    if (result === CHANNEL_UNAVAILABLE) {
      throw new BridgeChannelClosedError(context);
    }
    return result as T;
  } finally {
    const remaining = (channelUnavailableWaiterCounts.get(channel) ?? 1) - 1;
    if (remaining <= 0) {
      channelUnavailableWaiterCounts.delete(channel);
    } else {
      channelUnavailableWaiterCounts.set(channel, remaining);
    }
  }
}

/** Test seam: calls still waiting on `channel`'s unavailable signal. */
export function _channelUnavailableWaiterCountForTest(
  channel: AcpChannel,
): number {
  return channelUnavailableWaiterCounts.get(channel) ?? 0;
}
