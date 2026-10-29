/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { TelegramBotApi } from './botApi.js';

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** A fetch mock that records calls and returns a scripted JSON body/status. */
function mockFetch(
  responder: (call: Call) => { status: number; json: unknown },
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    const call = { url: String(url), body };
    calls.push(call);
    const { status, json } = responder(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function api(fetchImpl: typeof fetch) {
  return new TelegramBotApi({
    botToken: 'BOT:TOKEN',
    apiBase: 'https://tg.test',
    fetchImpl,
  });
}

describe('TelegramBotApi', () => {
  it('sendMessage POSTs chat_id + text + reply_markup to the bot method URL', async () => {
    const { calls, fetchImpl } = mockFetch(() => ({
      status: 200,
      json: { ok: true, result: { message_id: 9 } },
    }));
    const r = await api(fetchImpl).sendMessage(123, 'hello', {
      inlineKeyboard: [[{ text: 'Approve', callback_data: 'vote:approve:r1' }]],
    });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('https://tg.test/botBOT:TOKEN/sendMessage');
    expect(calls[0].body).toMatchObject({
      chat_id: 123,
      text: 'hello',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Approve', callback_data: 'vote:approve:r1' }],
        ],
      },
    });
  });

  it('omits reply_markup when there is no keyboard', async () => {
    const { calls, fetchImpl } = mockFetch(() => ({
      status: 200,
      json: { ok: true },
    }));
    await api(fetchImpl).sendMessage(1, 'hi');
    expect(calls[0].body.reply_markup).toBeUndefined();
  });

  it('surfaces a Telegram 429 retry_after', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 429,
      json: { ok: false, parameters: { retry_after: 12 } },
    }));
    const r = await api(fetchImpl).sendMessage(1, 'spam');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.retryAfterSec).toBe(12);
  });

  it('editMessageText POSTs chat_id + message_id + text + cleared reply_markup', async () => {
    const { calls, fetchImpl } = mockFetch(() => ({
      status: 200,
      json: { ok: true, result: { message_id: 9 } },
    }));
    const r = await api(fetchImpl).editMessageText(123, 9, 'updated text', {
      inlineKeyboard: [],
    });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain('/editMessageText');
    expect(calls[0].body).toMatchObject({
      chat_id: 123,
      message_id: 9,
      text: 'updated text',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('answerCallbackQuery posts the query id', async () => {
    const { calls, fetchImpl } = mockFetch(() => ({
      status: 200,
      json: { ok: true, result: true },
    }));
    await api(fetchImpl).answerCallbackQuery('cbq1', 'Approved');
    expect(calls[0].url).toContain('/answerCallbackQuery');
    expect(calls[0].body).toMatchObject({
      callback_query_id: 'cbq1',
      text: 'Approved',
    });
  });

  it('getUpdates long-polls with offset/timeout/allowed_updates and parses results', async () => {
    const updates = [
      { update_id: 5, message: { message_id: 1, chat: { id: 2 } } },
    ];
    const { calls, fetchImpl } = mockFetch(() => ({
      status: 200,
      json: { ok: true, result: updates },
    }));
    const got = await api(fetchImpl).getUpdates(5, 25);
    expect(got).toEqual({ ok: true, status: 200, updates });
    expect(calls[0].body).toMatchObject({
      offset: 5,
      timeout: 25,
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('getUpdates reports an error response as not ok, so the caller can back off (#168)', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 401,
      json: { ok: false, description: 'Unauthorized' },
    }));
    expect(await api(fetchImpl).getUpdates(0)).toEqual({
      ok: false,
      status: 401,
      updates: [],
    });
  });

  it('getUpdates carries a 429 retry_after and a network failure as status 0', async () => {
    const limited = mockFetch(() => ({
      status: 429,
      json: { ok: false, parameters: { retry_after: 7 } },
    }));
    expect(await api(limited.fetchImpl).getUpdates(0)).toEqual({
      ok: false,
      status: 429,
      retryAfterSec: 7,
      updates: [],
    });
    const down = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    expect(await api(down).getUpdates(0)).toEqual({
      ok: false,
      status: 0,
      updates: [],
    });
  });

  it('a network throw degrades to a non-ok result, not an exception', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const r = await api(fetchImpl).sendMessage(1, 'x');
    expect(r).toEqual({ ok: false, status: 0 });
  });
});
