/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #190. The service worker tells every open page about a push, so a page left
// in the background (whose 5 s status poll is paused) can ask for the request
// before the reader returns. A worker without a clients API still shows the
// notification.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SW = readFileSync(join(here, '..', 'public', 'sw.js'), 'utf8');

type Handler = (e: unknown) => void;

async function push(
  payload: Record<string, unknown>,
  clients: unknown,
): Promise<{ shown: string[] }> {
  const handlers: Record<string, Handler> = {};
  const shown: string[] = [];
  const self = {
    location: { origin: 'https://ws1.example.test' },
    addEventListener: (type: string, h: Handler) => {
      handlers[type] = h;
    },
    registration: {
      showNotification: (title: string) => {
        shown.push(title);
        return Promise.resolve();
      },
    },
    clients,
  };
  // No indexedDB: the title lookup bails out without a token, as in a worker
  // the viewer never mirrored one into.
  new Function('self', 'indexedDB', 'fetch', SW)(self, undefined, () =>
    Promise.reject(new Error('no network in this test')),
  );
  const waits: Array<Promise<unknown>> = [];
  handlers['push']!({
    data: { json: () => payload },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  return { shown };
}

describe('a push tells the open pages (#190)', () => {
  it('posts the kind, session and request to every window, controlled or not', async () => {
    const posted: unknown[][] = [];
    let asked: unknown = null;
    const clients = {
      matchAll: (opts: unknown) => {
        asked = opts;
        return Promise.resolve([
          { postMessage: (m: unknown) => posted.push(['a', m]) },
          { postMessage: (m: unknown) => posted.push(['b', m]) },
        ]);
      },
    };
    const r = await push(
      {
        v: 1,
        kind: 'permission.required',
        sessionId: 'sess-1',
        requestId: 'req-1',
        summary: 's',
      },
      clients,
    );
    expect(asked).toEqual({ type: 'window', includeUncontrolled: true });
    const msg = {
      type: 'rc-push',
      kind: 'permission.required',
      sessionId: 'sess-1',
      requestId: 'req-1',
    };
    expect(posted).toEqual([
      ['a', msg],
      ['b', msg],
    ]);
    expect(r.shown).toEqual(['Permission needed']);
  });

  it('still shows the notification with no clients API or a failing one', async () => {
    const payload = { v: 1, kind: 'session.turn_complete', sessionId: 's' };
    expect((await push(payload, {})).shown).toEqual(['Reply ready']);
    const failing = { matchAll: () => Promise.reject(new Error('gone')) };
    expect((await push(payload, failing)).shown).toEqual(['Reply ready']);
  });
});
