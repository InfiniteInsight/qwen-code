/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  suggestConfigFromSettings,
  resolveSettingsSuggestConfig,
  createSuggestChatSelector,
  settingsHomeDir,
  settingsFilePath,
} from './settingsModel.js';
import type { SuggestConfig } from './chatTransport.js';

/**
 * A fixture shaped like the real file: providers grouped by authType, the secret
 * in the top-level `env` map, a default model in `model`. Never reads the
 * operator's actual settings.json.
 */
function settings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: { name: 'session-model', baseUrl: 'http://h.example:9091/v1' },
    modelProviders: {
      openai: [
        {
          id: 'other-model',
          name: 'Other',
          baseUrl: 'http://ollama.example:11435/v1',
          envKey: 'OLLAMA_API_KEY',
        },
        {
          id: 'session-model',
          name: 'Session',
          baseUrl: 'http://h.example:9091/v1/',
          envKey: 'LLAMA_SERVER_API_KEY',
        },
      ],
    },
    env: { LLAMA_SERVER_API_KEY: 'sk-from-file', OLLAMA_API_KEY: 'sk-ollama' },
    ...over,
  };
}

const NO_ENV: Record<string, string | undefined> = {};

describe('settingsHomeDir / settingsFilePath', () => {
  it('defaults to ~/.qwen and honours QWEN_HOME (with ~ expansion)', () => {
    expect(settingsHomeDir(NO_ENV)).toMatch(/\.qwen$/);
    expect(settingsHomeDir({ QWEN_HOME: '/tmp/other-home' })).toBe(
      '/tmp/other-home',
    );
    expect(settingsHomeDir({ QWEN_HOME: '~/alt' })).toMatch(/\/alt$/);
    expect(settingsFilePath(NO_ENV)).toMatch(/\.qwen\/settings\.json$/);
  });

  it('ignores QWEN_RUNTIME_DIR, which moves the runtime dir, not settings', () => {
    expect(settingsHomeDir({ QWEN_RUNTIME_DIR: '/runtime/only' })).toMatch(
      /\.qwen$/,
    );
  });
});

describe('suggestConfigFromSettings — one coherent (key, host, model) set', () => {
  it('maps a model id to its entry host and the secret named by that entry', () => {
    expect(
      suggestConfigFromSettings(settings(), 'session-model', NO_ENV),
    ).toEqual({
      apiKey: 'sk-from-file',
      baseUrl: 'http://h.example:9091/v1', // trailing slash trimmed
      model: 'session-model',
    });
  });

  it('finds the entry in whichever authType group holds it', () => {
    const s = settings({
      modelProviders: {
        api_key: [],
        oauth: [{ id: 'm-oauth', baseUrl: 'http://o.example/v1', envKey: 'K' }],
      },
      env: { K: 'sk-oauth' },
    });
    expect(suggestConfigFromSettings(s, 'm-oauth', NO_ENV)).toEqual({
      apiKey: 'sk-oauth',
      baseUrl: 'http://o.example/v1',
      model: 'm-oauth',
    });
  });

  it('falls back to the user default model when no id is given', () => {
    const cfg = suggestConfigFromSettings(settings(), '', NO_ENV);
    expect(cfg?.model).toBe('session-model');
    expect(cfg?.apiKey).toBe('sk-from-file');
  });

  it('resolves the secret from the environment when settings env lacks it', () => {
    const s = settings({ env: {} });
    const cfg = suggestConfigFromSettings(s, 'session-model', {
      LLAMA_SERVER_API_KEY: 'sk-from-env',
    });
    // The host still comes from the entry that NAMED this key, so the pairing is
    // the user's own declaration rather than a cross-source guess.
    expect(cfg).toEqual({
      apiKey: 'sk-from-env',
      baseUrl: 'http://h.example:9091/v1',
      model: 'session-model',
    });
  });

  it('prefers the settings env value over the environment', () => {
    const cfg = suggestConfigFromSettings(settings(), 'session-model', {
      LLAMA_SERVER_API_KEY: 'sk-from-env',
    });
    expect(cfg?.apiKey).toBe('sk-from-file');
  });

  it('returns null when the model has no provider entry', () => {
    expect(suggestConfigFromSettings(settings(), 'nope', NO_ENV)).toBeNull();
  });

  it('returns null when the entry has no host, so no key is sent anywhere', () => {
    const s = settings({
      modelProviders: {
        openai: [{ id: 'session-model', envKey: 'LLAMA_SERVER_API_KEY' }],
      },
    });
    expect(suggestConfigFromSettings(s, 'session-model', NO_ENV)).toBeNull();
  });

  it('returns null when the entry names no envKey, so no key is guessed', () => {
    const s = settings({
      modelProviders: {
        openai: [{ id: 'session-model', baseUrl: 'http://h.example/v1' }],
      },
    });
    expect(suggestConfigFromSettings(s, 'session-model', NO_ENV)).toBeNull();
  });

  it('returns null when no value exists for the named key anywhere', () => {
    const s = settings({ env: {} });
    expect(suggestConfigFromSettings(s, 'session-model', NO_ENV)).toBeNull();
  });

  it('returns null for a non-object settings value or an empty default', () => {
    expect(suggestConfigFromSettings(null, 'x', NO_ENV)).toBeNull();
    expect(suggestConfigFromSettings([], 'x', NO_ENV)).toBeNull();
    expect(suggestConfigFromSettings('nope', 'x', NO_ENV)).toBeNull();
    expect(
      suggestConfigFromSettings({ modelProviders: {} }, '', NO_ENV),
    ).toBeNull();
  });

  it('ignores a blank secret rather than sending an empty bearer', () => {
    const s = settings({ env: { LLAMA_SERVER_API_KEY: '   ' } });
    expect(suggestConfigFromSettings(s, 'session-model', NO_ENV)).toBeNull();
  });
});

describe('resolveSettingsSuggestConfig', () => {
  it('reads the file at the given path and resolves it', async () => {
    const seen: string[] = [];
    const cfg = await resolveSettingsSuggestConfig('other-model', {
      path: '/fake/settings.json',
      env: NO_ENV,
      readFileImpl: async (p) => {
        seen.push(p);
        return JSON.stringify(settings());
      },
    });
    expect(seen).toEqual(['/fake/settings.json']);
    expect(cfg).toEqual({
      apiKey: 'sk-ollama',
      baseUrl: 'http://ollama.example:11435/v1',
      model: 'other-model',
    });
  });

  it('yields null on a missing file, malformed JSON, or a non-object root', async () => {
    const none = await resolveSettingsSuggestConfig('m', {
      env: NO_ENV,
      readFileImpl: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(none).toBeNull();
    const bad = await resolveSettingsSuggestConfig('m', {
      env: NO_ENV,
      readFileImpl: async () => '{not json',
    });
    expect(bad).toBeNull();
    const scalar = await resolveSettingsSuggestConfig('m', {
      env: NO_ENV,
      readFileImpl: async () => '7',
    });
    expect(scalar).toBeNull();
  });
});

describe('createSuggestChatSelector', () => {
  afterEach(() => vi.unstubAllGlobals());

  const base: SuggestConfig = {
    apiKey: 'sk-base',
    baseUrl: 'https://base.example/v1',
    model: 'fixed-model',
  };

  function stubFetch(): {
    calls: Array<{ url: string; body: Record<string, unknown> }>;
  } {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '[]' } }] }),
      } as unknown as Response;
    });
    return { calls };
  }

  it('uses the watched conversation model, not the fixed one', async () => {
    const { calls } = stubFetch();
    const get = createSuggestChatSelector(base, {
      env: NO_ENV,
      readFileImpl: async () => JSON.stringify(settings()),
    });
    const chat = await get('session-model');
    expect(chat).toBeTypeOf('function');
    await chat?.([]);
    expect(calls[0]?.url).toBe('http://h.example:9091/v1/chat/completions');
    expect(calls[0]?.body.model).toBe('session-model');
  });

  it('returns undefined when the conversation names no model', async () => {
    const get = createSuggestChatSelector(base, {
      env: NO_ENV,
      readFileImpl: async () => JSON.stringify(settings()),
    });
    expect(await get('')).toBeUndefined();
    expect(await get('   ')).toBeUndefined();
  });

  it('returns undefined when settings cannot map the model', async () => {
    const get = createSuggestChatSelector(base, {
      env: NO_ENV,
      readFileImpl: async () => JSON.stringify(settings()),
    });
    expect(await get('unmapped-model')).toBeUndefined();
  });

  it('returns undefined when the model already IS the fixed endpoint', async () => {
    const s = settings({
      modelProviders: {
        openai: [
          {
            id: 'fixed-model',
            baseUrl: 'https://base.example/v1',
            envKey: 'BASE_KEY',
          },
        ],
      },
      env: { BASE_KEY: 'sk-base' },
    });
    const get = createSuggestChatSelector(base, {
      env: NO_ENV,
      readFileImpl: async () => JSON.stringify(s),
    });
    // Same host and key: rebuilding an identical transport per idle edge is waste.
    expect(await get('fixed-model')).toBeUndefined();
  });

  it('never throws when the settings file is unreadable', async () => {
    const get = createSuggestChatSelector(base, {
      env: NO_ENV,
      readFileImpl: async () => {
        throw new Error('EACCES');
      },
    });
    expect(await get('session-model')).toBeUndefined();
  });
});
