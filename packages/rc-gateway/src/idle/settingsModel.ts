/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createChatTransport,
  type ChatTransport,
  type SuggestConfig,
} from './chatTransport.js';

/**
 * Resolves a suggestion endpoint from the user's OWN `settings.json` rather than
 * from the gateway's process environment.
 *
 * Why: `resolveSuggestConfig()` reads process env, but the gateway runs as a
 * systemd user unit whose environment carries only `QWEN_RC_TERMINAL_QWEN`. The
 * provider keys live in `settings.json`'s `env` map, which is where qwen itself
 * reads them — so reading the same file gives the gateway the same view the
 * watched conversation has. That is what per-session model selection needs.
 *
 * SECURITY POSTURE (same rule as `chatTransport.ts`): the
 * `(apiKey, baseUrl, model)` triple is a COHERENT SET from ONE file. The host
 * ALWAYS comes from the provider entry; only the secret is looked up, and only
 * under the `envKey` that same entry names — so a key can never be paired with a
 * host its owner did not choose for it. Anything missing → `null`, and the
 * caller stays on its existing fallback rather than guessing a host.
 */

/**
 * The settings home: `QWEN_HOME` → `~/.qwen`.
 *
 * Deliberately NOT `sessions/chatsPath.runtimeBaseDir()`, which also honours
 * `QWEN_RUNTIME_DIR`. That variable redirects the RUNTIME dir (projects/,
 * chats/); it does not move the dir qwen reads `settings.json` from, so reusing
 * it would look for settings in the wrong place on any host that sets it.
 */
export function settingsHomeDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const home = (env['QWEN_HOME'] ?? '').trim();
  if (!home) return join(homedir(), '.qwen');
  if (home === '~') return homedir();
  if (home.startsWith('~/') || home.startsWith('~\\')) {
    return join(homedir(), home.slice(2));
  }
  return home;
}

/** The settings file the gateway mirrors qwen's view from. */
export function settingsFilePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(settingsHomeDir(env), 'settings.json');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** `modelProviders` groups entries by authType (`modelProviders.openai[]`). */
function findProvider(
  settings: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> | undefined {
  const groups = settings['modelProviders'];
  if (!isRecord(groups)) return undefined;
  for (const group of Object.values(groups)) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (isRecord(entry) && text(entry['id']) === modelId) return entry;
    }
  }
  return undefined;
}

/** The model the user configured as their own default (`model.name`). */
function defaultModelName(settings: Record<string, unknown>): string {
  const model = settings['model'];
  return isRecord(model) ? text(model['name']) : '';
}

/**
 * Pure mapping: a parsed settings object plus a model id → a coherent endpoint,
 * or `null`. `modelId` empty falls back to the user's default model. Returns
 * `null` when the id has no provider entry, the entry carries no host or no
 * `envKey`, or no value exists for that key in either the settings `env` map or
 * the environment. Never throws, never guesses a host.
 *
 * The secret may come from the settings `env` map (where this user stores it) or
 * from the process environment (where a unit drop-in would put it). Reading the
 * environment is NOT the forbidden pairing: the envKey NAME is fixed by the same
 * entry that supplied the host, so the (host, key-name) binding is the user's
 * own declaration — only the value's location varies.
 */
export function suggestConfigFromSettings(
  settings: unknown,
  modelId = '',
  env: Record<string, string | undefined> = process.env,
): SuggestConfig | null {
  if (!isRecord(settings)) return null;
  const wanted = modelId.trim() || defaultModelName(settings);
  if (!wanted) return null;

  const entry = findProvider(settings, wanted);
  if (!entry) return null;

  const baseUrl = text(entry['baseUrl']);
  const envKey = text(entry['envKey']);
  if (!baseUrl || !envKey) return null;

  const envMap = settings['env'];
  const fromFile = isRecord(envMap) ? text(envMap[envKey]) : '';
  const apiKey = fromFile || text(env[envKey]);
  if (!apiKey) return null;

  return { apiKey, baseUrl: trimSlash(baseUrl), model: wanted };
}

/**
 * Reads `settings.json` and resolves it for `modelId` (empty → the user's
 * default model). Any failure — missing file, unreadable, malformed JSON —
 * yields `null` so the caller keeps its existing env-resolved endpoint. This is
 * enrichment, so it never throws and never logs the file's contents (it holds
 * secrets).
 */
export async function resolveSettingsSuggestConfig(
  modelId = '',
  deps: {
    path?: string;
    env?: Record<string, string | undefined>;
    readFileImpl?: (path: string) => Promise<string>;
  } = {},
): Promise<SuggestConfig | null> {
  const read = deps.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  let raw: string;
  try {
    raw = await read(deps.path ?? settingsFilePath(deps.env));
  } catch {
    return null;
  }
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    return null;
  }
  return suggestConfigFromSettings(settings, modelId, deps.env ?? process.env);
}

/**
 * Builds the per-session transport selector: given the model a watched
 * conversation runs, return the transport for THAT model, or `undefined` to use
 * the caller's fixed one.
 *
 * `undefined` is returned, so the caller keeps its env-resolved endpoint, when
 * the conversation names no model, when settings cannot map it to a coherent
 * (key, host) pair, or when it maps to exactly the endpoint already in use. The
 * last case matters: it stops a single-endpoint workstation from rebuilding an
 * identical transport on every idle edge.
 *
 * Deliberately NOT cached. The file is small and this runs at most once per idle
 * edge behind the per-session hourly cap, so re-reading is cheaper than an
 * invalidation rule, and it means editing a provider entry takes effect on the
 * next idle edge, the way `idle.yaml` is already read live at fire time.
 */
export function createSuggestChatSelector(
  base: SuggestConfig,
  deps: {
    path?: string;
    env?: Record<string, string | undefined>;
    readFileImpl?: (path: string) => Promise<string>;
  } = {},
): (modelId: string) => Promise<ChatTransport | undefined> {
  return async (modelId: string) => {
    const wanted = modelId.trim();
    if (!wanted || wanted === base.model) return undefined;
    const cfg = await resolveSettingsSuggestConfig(wanted, deps);
    if (!cfg) return undefined;
    if (
      cfg.apiKey === base.apiKey &&
      cfg.baseUrl === base.baseUrl &&
      cfg.model === base.model
    ) {
      return undefined;
    }
    return createChatTransport(cfg);
  };
}
