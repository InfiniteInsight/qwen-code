/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createIdleSuggestionHandler,
  resolveIdleEnabled,
} from './idleSuggestions.js';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import { PushRateLimiter } from '../webpush/rateLimiter.js';
import type { ChatTransport } from './chatTransport.js';
import type { IdleConfig } from './config.js';
import type { TurnText } from './suggester.js';
import type { AuditEntry } from '../auditLog.js';

const TURNS: TurnText[] = [
  { role: 'user', text: 'fix the login bug' },
  { role: 'assistant', text: 'done' },
];

/** Let the handler's fire-and-forget async body (readTurns → chat → publish) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function harness(
  opts: {
    config?: Partial<IdleConfig>;
    over?: Partial<Parameters<typeof createIdleSuggestionHandler>[0]>;
  } = {},
) {
  const events: OwnerEvent[] = [];
  const bus = new OwnerEventBus();
  bus.subscribe((e) => events.push(e));
  const audited: AuditEntry[] = [];
  const audit = { record: async (e: AuditEntry) => void audited.push(e) };
  const chat: ChatTransport = async () => '["Run the tests","Commit the fix"]';
  const config: IdleConfig = {
    enabled: true,
    maxSuggestionsPerHour: 5,
    maxSuggestions: 3,
    ...opts.config,
  };
  const { onSessionIdle: handler, cancelForSession } =
    createIdleSuggestionHandler({
      chat,
      bus,
      audit,
      getConfig: () => config,
      resolveDir: (cwd) => `/chats/${cwd}`,
      readTurns: async () => TURNS,
      ...opts.over,
    });
  return { handler, cancelForSession, events, audited, config };
}

describe('resolveIdleEnabled', () => {
  it('is OFF by default and for falsey/absent values', () => {
    expect(resolveIdleEnabled({})).toBe(false);
    expect(resolveIdleEnabled({ QWEN_RC_IDLE_SUGGESTIONS: '0' })).toBe(false);
    expect(resolveIdleEnabled({ QWEN_RC_IDLE_SUGGESTIONS: 'off' })).toBe(false);
  });
  it('is ON for 1/true/yes/on (case-insensitive)', () => {
    for (const v of ['1', 'true', 'YES', 'On']) {
      expect(resolveIdleEnabled({ QWEN_RC_IDLE_SUGGESTIONS: v })).toBe(true);
    }
  });
});

describe('createIdleSuggestionHandler', () => {
  it('publishes an idle_suggestions frame with expiresAt and rateLimitState on the happy path', async () => {
    const nowMs = 1_700_000_000_000;
    const { handler, events, audited } = harness({
      over: { now: () => nowMs, suggestionsTtlSec: 1800 },
    });
    handler('sess-1', '/w');
    await flush();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.type).toBe('idle_suggestions');
    if (ev.type !== 'idle_suggestions') return;
    expect(ev.sessionId).toBe('sess-1');
    expect(ev.suggestions).toEqual(['Run the tests', 'Commit the fix']);
    // expiresAt: now + 1800s
    expect(ev.expiresAt).toBe(new Date(nowMs + 1800 * 1000).toISOString());
    // rateLimitState: no limiter wired → remaining = maxSuggestionsPerHour (5)
    expect(ev.rateLimitState).toEqual({ remaining: 5, max: 5 });
    expect(audited).toEqual([
      { action: 'idle_suggested', target: 'sess-1', detail: { count: 2 } },
    ]);
  });

  it('rateLimitState.remaining decrements after consuming a slot (limiter wired)', async () => {
    const limiter = new PushRateLimiter();
    const clock = 1_000_000;
    const { handler, events } = harness({
      config: { maxSuggestionsPerHour: 5 },
      over: { limiter, now: () => clock },
    });
    handler('sess-1', '/w');
    await flush();
    // After first fire, 4 remain
    const ev = events[0];
    if (ev.type !== 'idle_suggestions') throw new Error('wrong type');
    expect(ev.rateLimitState).toEqual({ remaining: 4, max: 5 });
  });

  it('DISABLED config → zero side effects: no tail read, no model call, no frame, no audit', async () => {
    const readTurns = vi.fn(async () => TURNS);
    const chat = vi.fn(async () => '["x"]') as unknown as ChatTransport;
    const { handler, events, audited } = harness({
      config: { enabled: false },
      over: { readTurns, chat },
    });
    handler('sess-1', '/w');
    await flush();
    expect(readTurns).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(audited).toEqual([]);
  });

  it('per-session override false → no fire even when globally enabled (no tail read, no frame)', async () => {
    const readTurns = vi.fn(async () => TURNS);
    const chat = vi.fn(async () => '["x"]') as unknown as ChatTransport;
    const { handler, events, audited } = harness({
      config: { enabled: true },
      over: { readTurns, chat, getSessionEnabled: () => false },
    });
    handler('sess-1', '/w');
    await flush();
    expect(readTurns).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(audited).toEqual([]);
  });

  it('per-session override true CANNOT widen past a global-off (egress stays operator-gated)', async () => {
    const readTurns = vi.fn(async () => TURNS);
    const chat = vi.fn(async () => '["x"]') as unknown as ChatTransport;
    const { handler, events } = harness({
      config: { enabled: false },
      over: { readTurns, chat, getSessionEnabled: () => true },
    });
    handler('sess-1', '/w');
    await flush();
    expect(readTurns).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('per-session override undefined → follows the global default (fires when enabled)', async () => {
    const { handler, events } = harness({
      config: { enabled: true },
      over: { getSessionEnabled: () => undefined },
    });
    handler('sess-1', '/w');
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('idle_suggestions');
  });

  it('does nothing (no frame, no audit, no model call) when there are no turns', async () => {
    const chat = vi.fn(async () => '["x"]') as unknown as ChatTransport;
    const { handler, events, audited } = harness({
      over: { chat, readTurns: async () => [] },
    });
    handler('sess-1', '/w');
    await flush();
    expect(events).toEqual([]);
    expect(audited).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('emits no frame when the model reply parses to zero suggestions', async () => {
    const { handler, events, audited } = harness({
      over: { chat: async () => 'sorry, I cannot help' },
    });
    handler('sess-1', '/w');
    await flush();
    expect(events).toEqual([]);
    expect(audited).toEqual([]);
  });

  it('does nothing and never reads turns when workspaceCwd is empty', async () => {
    const readTurns = vi.fn(async () => TURNS);
    const { handler, events } = harness({ over: { readTurns } });
    handler('sess-1', '');
    await flush();
    expect(events).toEqual([]);
    expect(readTurns).not.toHaveBeenCalled();
  });

  it('degrades to silence (no throw, no frame) when the tail reader throws', async () => {
    const { handler, events } = harness({
      over: {
        readTurns: async () => {
          throw new Error('disk error');
        },
      },
    });
    expect(() => handler('sess-1', '/w')).not.toThrow();
    await flush();
    expect(events).toEqual([]);
  });

  it('degrades to silence when the model transport throws', async () => {
    const { handler, events } = harness({
      over: {
        chat: async () => {
          throw new Error('model down');
        },
      },
    });
    handler('sess-1', '/w');
    await flush();
    expect(events).toEqual([]);
  });

  it('uses maxSuggestions from config (passed through to the suggester/parser)', async () => {
    const { handler, events } = harness({
      config: { maxSuggestions: 1 },
      over: { chat: async () => '["a","b","c"]' },
    });
    handler('sess-1', '/w');
    await flush();
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev.type !== 'idle_suggestions') throw new Error('wrong type');
    expect(ev.suggestions).toEqual(['a']);
  });

  it('rate-limits per session: over the hourly cap → skip generation + ONE deduped audit', async () => {
    const limiter = new PushRateLimiter();
    let clock = 1_000_000;
    const chat = vi.fn(async () => '["a"]') as unknown as ChatTransport;
    const { handler, events, audited } = harness({
      config: { maxSuggestionsPerHour: 1 },
      over: { limiter, now: () => clock, chat },
    });

    // First edge: under cap → fires.
    handler('s', '/w');
    await flush();
    // Two more edges within the hour: over cap → skipped, generation not called again.
    clock += 1000;
    handler('s', '/w');
    await flush();
    clock += 1000;
    handler('s', '/w');
    await flush();

    expect(events).toHaveLength(1); // only the first fired
    expect(chat).toHaveBeenCalledTimes(1); // budget protected the model call
    // One idle_suggested (the success) + exactly ONE rate-limited (firstDrop dedup).
    expect(audited.filter((a) => a.action === 'idle_suggested')).toHaveLength(
      1,
    );
    const limited = audited.filter(
      (a) => a.action === 'idle_suggest_rate_limited',
    );
    expect(limited).toEqual([
      { action: 'idle_suggest_rate_limited', target: 's' },
    ]);
  });

  describe('hourly slot refund on failure (#169)', () => {
    it('refunds the slot when the model call fails, so the next idle edge still runs', async () => {
      const limiter = new PushRateLimiter();
      let calls = 0;
      const chat: ChatTransport = async () => {
        calls++;
        if (calls === 1) throw new Error('model down');
        return '["Run the tests"]';
      };
      const { handler, events, audited } = harness({
        config: { maxSuggestionsPerHour: 1 },
        over: { limiter, now: () => 1_000_000, chat },
      });
      handler('s', '/w');
      await flush();
      expect(events).toEqual([]);
      // The failed call did not spend the only slot of the hour.
      expect(limiter.remaining('s', 1, 1_000_000)).toBe(1);
      handler('s', '/w');
      await flush();
      expect(calls).toBe(2);
      expect(events).toHaveLength(1);
      expect(
        audited.filter((a) => a.action === 'idle_suggest_rate_limited'),
      ).toEqual([]);
    });

    it('refunds the slot when the round is cancelled mid-call', async () => {
      const limiter = new PushRateLimiter();
      const chat: ChatTransport = (_m, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        });
      const { handler, cancelForSession } = harness({
        config: { maxSuggestionsPerHour: 1 },
        over: { limiter, now: () => 1_000_000, chat },
      });
      handler('s', '/w');
      await flush();
      expect(limiter.remaining('s', 1, 1_000_000)).toBe(0); // in flight
      cancelForSession('s');
      await flush();
      expect(limiter.remaining('s', 1, 1_000_000)).toBe(1);
    });

    it('refunds the slot when a step before the model call throws', async () => {
      const limiter = new PushRateLimiter();
      const { handler } = harness({
        config: { maxSuggestionsPerHour: 1 },
        over: {
          limiter,
          now: () => 1_000_000,
          readModel: async () => 'some-model',
          getChat: async () => {
            throw new Error('selector broke');
          },
        },
      });
      handler('s', '/w');
      await flush();
      expect(limiter.remaining('s', 1, 1_000_000)).toBe(1);
    });

    it('keeps the slot spent when the model answered, even with nothing usable', async () => {
      const limiter = new PushRateLimiter();
      const { handler, events } = harness({
        config: { maxSuggestionsPerHour: 1 },
        over: { limiter, now: () => 1_000_000, chat: async () => 'no json' },
      });
      handler('s', '/w');
      await flush();
      expect(events).toEqual([]);
      expect(limiter.remaining('s', 1, 1_000_000)).toBe(0); // the call cost a slot
    });
  });

  describe('AbortController cancellation', () => {
    it('cancelForSession aborts in-flight generation so no frame is published', async () => {
      // The chat transport resolves only after cancelForSession is called,
      // so the AbortSignal will be aborted before generateSuggestions completes.
      let resolveChatFn: ((v: string) => void) | undefined;
      const chat: ChatTransport = () =>
        new Promise((resolve) => {
          resolveChatFn = resolve;
        });
      const { handler, cancelForSession, events } = harness({
        over: { chat },
      });
      handler('sess-1', '/w');
      // Let the async body reach the chat call.
      await flush();
      // Cancel BEFORE the chat resolves.
      cancelForSession('sess-1');
      // Now let chat settle (even though cancelled, resolve so it doesn't hang).
      resolveChatFn?.('["x"]');
      await flush();
      expect(events).toEqual([]);
    });

    it('cancelForSession is a no-op for an unknown session (never throws)', () => {
      const { cancelForSession } = harness();
      expect(() => cancelForSession('unknown')).not.toThrow();
    });

    it('a second onSessionIdle call cancels the previous in-flight and starts fresh', async () => {
      // Fire twice rapidly — second call should cancel the first (abort its signal),
      // so only the second round publishes.
      let firstResolve: ((v: string) => void) | undefined;
      let secondResolve: ((v: string) => void) | undefined;
      let chatCallN = 0;
      const chat: ChatTransport = () =>
        new Promise((resolve) => {
          chatCallN++;
          if (chatCallN === 1) firstResolve = resolve;
          else secondResolve = resolve;
        });
      const { handler, events } = harness({ over: { chat } });
      handler('sess-1', '/w');
      // Let the first async body reach the chat call.
      await flush();
      // Fire the second call (cancels first).
      handler('sess-1', '/w');
      // Let the second async body reach the chat call.
      await flush();
      // Now resolve both; the first's signal is aborted so its suggestions are
      // dropped, only the second publishes.
      firstResolve?.('["stale"]');
      secondResolve?.('["fresh"]');
      await flush();
      // Exactly one event from the second round.
      const idle = events.filter((e) => e.type === 'idle_suggestions');
      expect(idle).toHaveLength(1);
      const ev = idle[0];
      if (ev?.type !== 'idle_suggestions') throw new Error('wrong type');
      expect(ev.suggestions).toEqual(['fresh']);
    });
  });
});

describe('per-session model selection', () => {
  it('asks the model the watched conversation runs, not the fixed endpoint', async () => {
    const asked: string[] = [];
    const readModel = vi.fn(async (chatsDir: string, sessionId: string) => {
      asked.push(`${chatsDir}|${sessionId}`);
      return 'session-model';
    });
    const { handler, events } = harness({
      over: {
        chat: async () => '["from the fixed endpoint"]',
        readModel,
        getChat: async (modelId: string) =>
          modelId === 'session-model'
            ? async () => '["from the session model"]'
            : undefined,
      },
    });
    handler('sess-9', 'proj-w');
    await flush();
    const ev = events[0];
    if (ev.type !== 'idle_suggestions') throw new Error('no frame');
    expect(ev.suggestions).toEqual(['from the session model']);
    // The reader is scoped to THIS session's own transcript.
    expect(readModel).toHaveBeenCalledTimes(1);
    expect(asked).toEqual(['/chats/proj-w|sess-9']);
  });

  it('keeps the fixed endpoint when the selector cannot map the model', async () => {
    const { handler, events } = harness({
      over: {
        chat: async () => '["from the fixed endpoint"]',
        readModel: async () => 'unmapped-model',
        getChat: async () => undefined,
      },
    });
    handler('sess-1', '/w');
    await flush();
    const ev = events[0];
    if (ev.type !== 'idle_suggestions') throw new Error('no frame');
    expect(ev.suggestions).toEqual(['from the fixed endpoint']);
  });

  it('does not consult the selector when the transcript names no model', async () => {
    const getChat = vi.fn(async () => async () => '["should not be used"]');
    const { handler, events } = harness({
      over: {
        chat: async () => '["from the fixed endpoint"]',
        readModel: async () => null,
        getChat,
      },
    });
    handler('sess-1', '/w');
    await flush();
    expect(getChat).not.toHaveBeenCalled();
    const ev = events[0];
    if (ev.type !== 'idle_suggestions') throw new Error('no frame');
    expect(ev.suggestions).toEqual(['from the fixed endpoint']);
  });

  it('a failed model read costs the session nothing', async () => {
    const { handler, events } = harness({
      over: {
        chat: async () => '["from the fixed endpoint"]',
        readModel: async () => {
          throw new Error('transcript unreadable');
        },
        getChat: async () => async () => '["should not be used"]',
      },
    });
    handler('sess-1', '/w');
    await flush();
    // Selection is enrichment: a read failure must not land in the outer catch
    // and silently drop suggestions the fallback endpoint could still make.
    const ev = events[0];
    if (ev.type !== 'idle_suggestions') throw new Error('no frame');
    expect(ev.suggestions).toEqual(['from the fixed endpoint']);
  });

  it('selection cannot turn egress on: a DISABLED config never reads the model', async () => {
    const readModel = vi.fn(async () => 'session-model');
    const { handler, events } = harness({
      config: { enabled: false },
      over: { readModel, getChat: async () => async () => '["a"]' },
    });
    handler('sess-1', '/w');
    await flush();
    expect(readModel).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});
