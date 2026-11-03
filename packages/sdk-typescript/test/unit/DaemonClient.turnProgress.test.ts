/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';

/**
 * Tests for the turn-frame observer on `DaemonClient.prompt()`
 * (openspec change `add-turn-progress-signal`, task 1.1).
 *
 * The claim under test is that a caller holding a turn can learn it is alive
 * without opening a second subscription, and that learning it confers no power
 * over the turn. The harness is the same recording-fetch shape the main
 * DaemonClient suite uses, kept local so this file cannot drift with it.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(body: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface CapturedRequest {
  url: string;
}

function recordingFetch(reply: (req: CapturedRequest) => Response): {
  fetch: typeof globalThis.fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const captured = { url };
    calls.push(captured);
    return reply(captured);
  });
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

/** One SSE frame. `promptId` lands in the payload the way the daemon stamps it. */
function frame(id: number, type: string, payload: unknown): string {
  return (
    `id: ${id}\nevent: ${type}\ndata: ` +
    `${JSON.stringify({ id, v: 1, type, data: payload })}\n\n`
  );
}

/** Two progress frames, then this turn's terminal frame. */
const TURN_STREAM =
  frame(1, 'session_update', { update: 'one' }) +
  frame(2, 'session_update', { update: 'two' }) +
  frame(3, 'turn_complete', { promptId: 'p-1', stopReason: 'end_turn' });

/**
 * The same turn as heard through a connection that keeps itself warm. A proxy
 * or the daemon's own heartbeat writes `:` comment lines to stop an idle socket
 * being reaped; they carry no data, so the parser returns undefined for them
 * and they never reach the loop the observer hangs off.
 */
const KEEPALIVE_STREAM =
  ': keepalive\n\n' +
  ': keepalive\n\n' +
  frame(1, 'session_update', { update: 'one' }) +
  (': keepalive\n\n: keepalive\n\n: keepalive\n\n' +
    frame(2, 'session_update', { update: 'two' }) +
    ': keepalive\n\n' +
    frame(3, 'turn_complete', { promptId: 'p-1', stopReason: 'end_turn' }));

function daemonReply(req: CapturedRequest): Response {
  if (req.url.endsWith('/session/s-1/prompt')) {
    return jsonResponse(202, { promptId: 'p-1', lastEventId: 0 });
  }
  if (req.url.endsWith('/session/s-1/events')) {
    return sseResponse(TURN_STREAM);
  }
  return jsonResponse(500, { error: `unexpected ${req.url}` });
}

describe('DaemonClient.prompt turn-frame observer', () => {
  it('reports every frame of a turn nobody is watching, in order', async () => {
    const { fetch, calls } = recordingFetch(daemonReply);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const seen: string[] = [];

    const result = await client.prompt(
      's-1',
      { prompt: [{ type: 'text', text: 'hi' }] },
      undefined,
      undefined,
      (frameType) => seen.push(frameType),
    );

    // The terminal frame is reported too: it is a frame the wait observed, and
    // the interval before it is the silence of interest for a turn that thought
    // for a long time before answering.
    expect(seen).toEqual(['session_update', 'session_update', 'turn_complete']);
    expect(result).toEqual({ stopReason: 'end_turn' });
    // Every one of those frames came from the subscription the wait already
    // had. Nobody opened a second one to get them, which is the constraint the
    // callback exists instead of a gateway-side watcher.
    expect(calls.filter((c) => c.url.endsWith('/events'))).toHaveLength(1);
  });

  it('observes without opening a second subscription', async () => {
    // The whole reason the callback exists rather than a gateway-side watcher:
    // the session bus caps subscribers per bus and this wait is already a
    // second subscriber beside the gateway's own relay. A third per prompt
    // halves the headroom again for everyone watching that session.
    const { fetch, calls } = recordingFetch(daemonReply);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await client.prompt(
      's-1',
      { prompt: [{ type: 'text', text: 'hi' }] },
      undefined,
      undefined,
      () => {},
    );

    expect(calls.filter((c) => c.url.endsWith('/events'))).toHaveLength(1);
  });

  it('hands the observer the frame type and nothing else', async () => {
    // Content is deliberately unreachable from the callback. The recorded
    // numbers land in a hash-chained audit file an operator reads; a payload
    // handed to the observer would make an accidental content dependency
    // possible for whoever extends this next.
    const { fetch } = recordingFetch(daemonReply);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const received: unknown[] = [];

    await client.prompt(
      's-1',
      { prompt: [{ type: 'text', text: 'hi' }] },
      undefined,
      undefined,
      (...args: unknown[]) => received.push(args[0]),
    );

    expect(received).toEqual([
      'session_update',
      'session_update',
      'turn_complete',
    ]);
    expect(received.every((arg) => typeof arg === 'string')).toBe(true);
  });

  it('changes nothing for a caller that asks for nothing', async () => {
    // Every one of the existing call sites stays on this path. The 202 wait is
    // a measurement-adjacent code path, so "additive" has to be asserted, not
    // assumed from an optional parameter.
    const { fetch, calls } = recordingFetch(daemonReply);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const result = await client.prompt('s-1', {
      prompt: [{ type: 'text', text: 'hi' }],
    });

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(calls.filter((c) => c.url.endsWith('/events'))).toHaveLength(1);
  });

  it('cannot have its outcome changed by an observer that throws', async () => {
    const { fetch } = recordingFetch(daemonReply);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const result = await client.prompt(
      's-1',
      { prompt: [{ type: 'text', text: 'hi' }] },
      undefined,
      undefined,
      () => {
        throw new Error('observer exploded');
      },
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('does not count a keepalive burst as progress', async () => {
    // The failure this guards is a window sized off the wrong signal: if a
    // heartbeat counted as a frame, a wedged turn whose connection was merely
    // kept warm would look alive forever and the silence would never be seen.
    // Injecting the keepalives is the point: asserting the tree contains none
    // would pass just as happily if the observer started counting them.
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/prompt')) {
        return jsonResponse(202, { promptId: 'p-1', lastEventId: 0 });
      }
      if (req.url.endsWith('/session/s-1/events')) {
        return sseResponse(KEEPALIVE_STREAM);
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const seen: string[] = [];

    const result = await client.prompt(
      's-1',
      { prompt: [{ type: 'text', text: 'hi' }] },
      undefined,
      undefined,
      (frameType) => seen.push(frameType),
    );

    // Six heartbeats arrived across the turn; three frames did.
    expect(seen).toEqual(['session_update', 'session_update', 'turn_complete']);
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('reports no frame at all on the 200 path, which opens no subscription', async () => {
    // The path a silence window can never see: the daemon answered with a
    // parsed result, so there is nothing to be quiet about. This is why the
    // absolute ceiling stays whatever a window eventually becomes.
    const { fetch, calls } = recordingFetch((req) =>
      req.url.endsWith('/session/s-1/prompt')
        ? jsonResponse(200, { stopReason: 'end_turn' })
        : jsonResponse(500, { error: `unexpected ${req.url}` }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const seen: string[] = [];

    const result = await client.prompt(
      's-1',
      { prompt: [{ type: 'text', text: 'hi' }] },
      undefined,
      undefined,
      (frameType) => seen.push(frameType),
    );

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(seen).toEqual([]);
    expect(calls.filter((c) => c.url.endsWith('/events'))).toHaveLength(0);
  });
});
