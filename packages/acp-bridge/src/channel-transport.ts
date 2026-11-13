/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpChannel } from './channel.js';
import { BridgeChannelClosedError } from './status.js';
import { withTimeout } from './with-timeout.js';

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
  return unavailable.then(reject, reject);
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
  work: Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (fanout.closed) {
      reject(fanout.closed.error);
    } else {
      fanout.waiters.add(reject);
    }
    // Always observe `work`, so a rejection after the close is handled here
    // rather than reported as unhandled.
    work.then(
      (value) => {
        fanout.waiters.delete(reject);
        resolve(value);
      },
      (error: unknown) => {
        fanout.waiters.delete(reject);
        reject(error);
      },
    );
  });
}

const channelUnavailableFanouts = new WeakMap<
  AcpChannel,
  Map<string, ClosedFanout>
>();

/**
 * Settle with `work`, or reject with `BridgeChannelClosedError(context)` if
 * the channel becomes unavailable first. Each channel and context share one
 * `channelUnavailableReject`, so a settled call leaves nothing on
 * `channel.exited`. `context` must come from a small fixed set of literals:
 * a context carrying an id would arm a new `channelUnavailableReject` on
 * `channel.exited` per value and bring the per-call leak back.
 */
export function raceChannelUnavailable<T>(
  channel: AcpChannel,
  context: string,
  work: Promise<T>,
): Promise<T> {
  let byContext = channelUnavailableFanouts.get(channel);
  if (!byContext) {
    byContext = new Map();
    channelUnavailableFanouts.set(channel, byContext);
  }
  let fanout = byContext.get(context);
  if (!fanout) {
    fanout = armClosedFanout(channelUnavailableReject(channel, context));
    byContext.set(context, fanout);
  }
  return raceClosedFanout(fanout, work);
}

/** Test seam: calls still waiting on `channel`'s unavailable fan-outs. */
export function _channelUnavailableWaiterCountForTest(
  channel: AcpChannel,
): number {
  let count = 0;
  for (const fanout of channelUnavailableFanouts.get(channel)?.values() ?? []) {
    count += fanout.waiters.size;
  }
  return count;
}
