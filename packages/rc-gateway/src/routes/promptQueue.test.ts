/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { PromptQueue, QueueTimeoutError } from './promptQueue.js';

describe('PromptQueue.isInFlight', () => {
  it('is false before acquire and true while the slot is held', async () => {
    const q = new PromptQueue();
    expect(q.isInFlight('s1')).toBe(false);

    const release = await q.acquire('s1', 1000);
    expect(q.isInFlight('s1')).toBe(true);

    release();
    expect(q.isInFlight('s1')).toBe(false);
  });

  it('counts concurrent holders per session independently', async () => {
    const q = new PromptQueue();
    const first = await q.acquire('s1', 1000);
    expect(q.isInFlight('s2')).toBe(false);

    // s2 acquires in parallel (different session, different slot).
    const second = await q.acquire('s2', 1000);
    expect(q.isInFlight('s1')).toBe(true);
    expect(q.isInFlight('s2')).toBe(true);

    second();
    expect(q.isInFlight('s2')).toBe(false);
    expect(q.isInFlight('s1')).toBe(true);

    first();
    expect(q.isInFlight('s1')).toBe(false);
  });

  it('a timed-out waiter does not count as in flight', async () => {
    const q = new PromptQueue();
    const holder = await q.acquire('s1', 10_000);

    await expect(q.acquire('s1', 50)).rejects.toBeInstanceOf(QueueTimeoutError);
    // The timed-out waiter released without ever holding the slot.
    expect(q.isInFlight('s1')).toBe(true); // the ORIGINAL holder still holds

    holder();
    expect(q.isInFlight('s1')).toBe(false);
  });

  it('the FIFO order is preserved around in-flight tracking', async () => {
    const q = new PromptQueue();
    const order: string[] = [];
    const first = await q.acquire('s1', 1000);
    const second = q.acquire('s1', 1000).then(async (release) => {
      order.push('second');
      release();
    });
    const firstDone = (async () => {
      order.push('first');
      first();
    })();

    await Promise.all([second, firstDone]);
    expect(order).toEqual(['first', 'second']);
  });
});
