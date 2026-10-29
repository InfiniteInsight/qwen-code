/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #155: the adapter's SDK event handlers fired `void` dispatches, so a
 * rejected onMessage/onReaction (BridgeClient rejects when its fetch fails)
 * was an unhandled rejection that exited the process. The optional SDK is not
 * installed on Node 22, so both modules are mocked: the test drives the
 * handlers the adapter registers on the (fake) MatrixClient.
 */

import { describe, it, expect, vi } from 'vitest';
import type { EventEmitter } from 'node:events';

// vi.mock factories are hoisted above the imports, so shared state comes from
// vi.hoisted and the factory imports what it needs itself.
const { clients } = vi.hoisted(() => ({
  clients: [] as Array<EventEmitter & { joined: string[] }>,
}));

vi.mock('@vector-im/matrix-bot-sdk', async () => {
  const { EventEmitter } = await import('node:events');
  class MatrixClient extends EventEmitter {
    crypto = { isReady: true, prepare: async () => {} };
    joined: string[] = [];
    constructor() {
      super();
      clients.push(this);
    }
    async getRoomStateEvent() {
      return { users: {}, users_default: 0 };
    }
    async joinRoom(roomId: string) {
      this.joined.push(roomId);
      return roomId;
    }
  }
  return {
    MatrixClient,
    RustSdkCryptoStorageProvider: class {},
    SimpleFsStorageProvider: class {},
    AutojoinRoomsMixin: { setupOnClient: () => {} },
  };
});
vi.mock('@matrix-org/matrix-sdk-crypto-nodejs', () => ({
  StoreType: { Sqlite: 0 },
}));

const { createMatrixCryptoAdapter } = await import('./cryptoAdapter.js');
const { MATRIX_INVITE_AUTOJOIN_CAP } = await import('./runner.js');

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function trackUnhandledRejections() {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onRejection);
  return { seen, stop: () => process.off('unhandledRejection', onRejection) };
}

describe('createMatrixCryptoAdapter, which messages become prompts (#168)', () => {
  it('forwards m.text only: notices, images and m.replace edits are dropped', async () => {
    const bodies: string[] = [];
    const adapter = await createMatrixCryptoAdapter({
      homeserverUrl: 'https://hs.example.com',
      accessToken: 'tok',
      stateDir: '/nonexistent-state-dir',
      onMessage: (m) => {
        bodies.push(m.body);
      },
    });
    expect(adapter).not.toBeNull();
    const client = clients.at(-1)!;
    const send = (content: Record<string, unknown>) =>
      client.emit('room.message', '!r:h', { sender: '@alice:h', content });
    send({ msgtype: 'm.notice', body: 'another bot says hi' });
    send({ msgtype: 'm.image', body: 'rm -rf ~.png' });
    send({
      msgtype: 'm.text',
      body: '* run the tests',
      'm.new_content': { msgtype: 'm.text', body: 'run the tests' },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
    });
    send({ msgtype: 'm.text', body: 'run the tests' });
    await waitFor(() => bodies.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(bodies).toEqual(['run the tests']);
  });
});

describe('createMatrixCryptoAdapter, invite auto-join (#168)', () => {
  it('applies the same auto-join cap as the fetch path', async () => {
    const logs: string[] = [];
    const adapter = await createMatrixCryptoAdapter({
      homeserverUrl: 'https://hs.example.com',
      accessToken: 'tok',
      stateDir: '/nonexistent-state-dir',
      onMessage: () => {},
      log: (m) => logs.push(m),
    });
    expect(adapter).not.toBeNull();
    const client = clients.at(-1)!;
    const burst = MATRIX_INVITE_AUTOJOIN_CAP + 5;
    for (let i = 0; i < burst; i++)
      client.emit('room.invite', `!flood${i}:evil.example`, {});
    await waitFor(() => client.joined.length === MATRIX_INVITE_AUTOJOIN_CAP);
    await new Promise((r) => setTimeout(r, 20));
    expect(client.joined).toHaveLength(MATRIX_INVITE_AUTOJOIN_CAP);
    expect(logs.filter((l) => l.includes('declined invite'))).toHaveLength(5);
  });
});

describe('createMatrixCryptoAdapter, a failed dispatch', () => {
  it('logs a rejected message and reaction dispatch instead of crashing', async () => {
    const logs: string[] = [];
    const adapter = await createMatrixCryptoAdapter({
      homeserverUrl: 'https://hs.example.com',
      accessToken: 'tok',
      stateDir: '/nonexistent-state-dir',
      onMessage: async () => {
        throw new TypeError('fetch failed');
      },
      onReaction: async () => {
        throw new TypeError('fetch failed');
      },
      log: (m) => logs.push(m),
    });
    expect(adapter).not.toBeNull();
    const client = clients.at(-1)!;
    const tracker = trackUnhandledRejections();
    try {
      client.emit('room.message', '!r:h', {
        sender: '@alice:h',
        content: { msgtype: 'm.text', body: 'run the tests' },
      });
      client.emit('room.event', '!r:h', {
        type: 'm.reaction',
        sender: '@alice:h',
        content: { 'm.relates_to': { event_id: '$e1', key: '👍' } },
      });
      await waitFor(
        () => logs.filter((l) => l.includes('fetch failed')).length === 2,
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(tracker.seen).toEqual([]);
      expect(logs.join('\n')).toMatch(/message dispatch failed/);
      expect(logs.join('\n')).toMatch(/reaction dispatch failed/);
    } finally {
      tracker.stop();
    }
  });
});
