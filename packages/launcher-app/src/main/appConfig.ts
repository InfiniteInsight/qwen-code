/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

/**
 * Persisted app config. This MUST NEVER contain secrets (no pairing code, no
 * OPENAI_API_KEY) — those live only in the WSL-side `.env` file that
 * `envConfig.ts` manages. This file only remembers UI/session preferences.
 */
export interface AppConfig {
  distro?: string;
  windowBounds?: WindowBounds;
  /**
   * How many host-terminal requests (issue #49) this launcher has already
   * handled. A plain counter, not a secret — the requests themselves (which do
   * carry a daemon token) stay in the WSL-side log and are never persisted
   * here.
   */
  terminalCursor?: number;
}

/** `<userData>/launcher-app.json` — Electron's per-user app data directory. */
export function configPath(): string {
  return join(app.getPath('userData'), 'launcher-app.json');
}

function isWindowBounds(v: unknown): v is WindowBounds {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return typeof b['width'] === 'number' && typeof b['height'] === 'number';
}

/** Read the persisted config. Missing/corrupt file → empty config (never throws). */
export function readAppConfig(): AppConfig {
  try {
    const raw = readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: AppConfig = {};
    if (typeof parsed['distro'] === 'string') out.distro = parsed['distro'];
    if (isWindowBounds(parsed['windowBounds'])) {
      out.windowBounds = parsed['windowBounds'];
    }
    const cursor = parsed['terminalCursor'];
    if (typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0) {
      out.terminalCursor = cursor;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the config (UI/session preferences only — never secrets). */
export function writeAppConfig(config: AppConfig): void {
  try {
    const p = configPath();
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const safe: AppConfig = {};
    if (typeof config.distro === 'string') safe.distro = config.distro;
    if (config.windowBounds) safe.windowBounds = config.windowBounds;
    if (
      typeof config.terminalCursor === 'number' &&
      Number.isFinite(config.terminalCursor) &&
      config.terminalCursor >= 0
    ) {
      safe.terminalCursor = Math.floor(config.terminalCursor);
    }
    writeFileSync(p, JSON.stringify(safe, null, 2), 'utf8');
  } catch {
    // Best-effort persistence; a failed write just falls back to defaults
    // next launch.
  }
}
