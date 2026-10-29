/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #171. sw.js read the daemon registry from `self.localStorage`, which a
// service worker does not have, so the "[workstation]" prefix on push titles
// never appeared. It now asks the gateway for the manifest the way the page
// does, with the bearer the viewer mirrored into IndexedDB.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SW = readFileSync(join(here, '..', 'public', 'sw.js'), 'utf8');

type Handler = (e: unknown) => void;

function fakeIdb(token: string | undefined) {
  return {
    open() {
      const req: {
        result?: unknown;
        onsuccess?: () => void;
        onerror?: () => void;
        onupgradeneeded?: () => void;
      } = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const g: { result?: unknown; onsuccess?: () => void } = {};
                queueMicrotask(() => {
                  g.result = token;
                  g.onsuccess?.();
                });
                return g;
              },
            }),
          }),
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
}

// Runs sw.js against a stand-in global with NO localStorage, as in a worker.
async function push(opts: {
  token?: string;
  fetchImpl?: (
    url: string,
    init: { headers: Record<string, string>; signal?: AbortSignal },
  ) => Promise<unknown>;
}): Promise<{ title: string; fetched: string[] }> {
  const handlers: Record<string, Handler> = {};
  const shown: string[] = [];
  const fetched: string[] = [];
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
    clients: {},
    indexedDB: true,
  };
  const fetchFn = (url: string, init: never) => {
    fetched.push(url);
    return (
      opts.fetchImpl ??
      (() => Promise.reject(new Error('no network in this test')))
    )(url, init);
  };
  new Function('self', 'indexedDB', 'fetch', SW)(
    self,
    fakeIdb(opts.token),
    fetchFn,
  );
  const waits: Array<Promise<unknown>> = [];
  handlers['push']!({
    data: {
      json: () => ({ v: 1, kind: 'permission.required', summary: 's' }),
    },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  return { title: shown[0]!, fetched };
}

const manifest = (daemons: unknown) => () =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ daemons }) });

afterEach(() => {
  vi.useRealTimers();
});

describe('the daemon name on a push title (#171)', () => {
  it('prefixes the title with the registry name of this origin', async () => {
    const r = await push({
      token: 'tok',
      fetchImpl: manifest([
        { name: 'other', url: 'https://ws2.example.test/' },
        { name: 'workstation-1', url: 'https://ws1.example.test/ui/' },
      ]),
    });
    expect(r.title).toBe('[workstation-1] Permission needed');
    expect(r.fetched).toEqual(['/ui/clients-manifest.json']);
  });

  it('sends the bearer the viewer mirrored, and none if it mirrored none', async () => {
    let auth = '';
    await push({
      token: 'tok',
      fetchImpl: (_u, init) => {
        auth = init.headers['Authorization'] ?? '';
        return manifest([])();
      },
    });
    expect(auth).toBe('Bearer tok');
    const r = await push({ fetchImpl: manifest([]) });
    expect(r.title).toBe('Permission needed');
    expect(r.fetched).toEqual([]);
  });

  it('shows the plain title when the manifest is refused, malformed or unreachable', async () => {
    for (const fetchImpl of [
      () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
      () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error('x')),
        }),
      manifest('nope'),
      manifest([{ name: 'x', url: 'not a url' }]),
    ]) {
      const r = await push({ token: 'tok', fetchImpl });
      expect(r.title).toBe('Permission needed');
    }
    expect((await push({ token: 'tok' })).title).toBe('Permission needed');
  });

  it('does not hold the notification for a manifest that never answers', async () => {
    vi.useFakeTimers();
    const p = push({
      token: 'tok',
      fetchImpl: (_u, init) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new Error('abort')));
        }),
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).title).toBe('Permission needed');
  });
});
