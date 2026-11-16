/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The shared per-turn bounds enforced by every route that posts a prompt:
 * `routes/prompt.ts`, `routes/commands.ts`, `routes/supportedCommands.ts`.
 *
 * Each of the three carried its own literal before #237, so the knob the CLI
 * documents as "the" turn timeout disagreed with two of them by default, and
 * raising one route's bound left the others cutting turns off earlier.
 *
 * Two bounds cooperate (#237, #243, #244):
 *  1. `DEFAULT_PROMPT_TIMEOUT_SEC` (7 200 s / 2 h): an absolute ceiling
 *     measured from turn start and never reset by activity. Bounds turns that
 *     stream forever without pausing and turns on the legacy blocking 200 path
 *     that open no event subscription.
 *  2. `DEFAULT_PROMPT_SILENCE_SEC` (2 700 s / 45 min): a quiet-period silence
 *     window chosen from 126 recorded live turns (`2026-11-03` through
 *     `2026-11-16`: `p50 = 33.3 s`, `p90 = 5.79 min`, `p95 = 7.89 min`,
 *     `p99 = 15.28 min`, `max = 34.17 min`, alongside 21 firings of the
 *     7 200 s ceiling). It arms only when `DaemonClient.prompt()` enters the
 *     202 subscription wait, resets on each parsed frame observed there (never
 *     on SSE comment keepalives), and only ever shortens the ceiling.
 */
export const DEFAULT_PROMPT_TIMEOUT_SEC = 7200;

/** `DEFAULT_PROMPT_TIMEOUT_SEC` in the ms the routes and server deps carry. */
export const DEFAULT_PROMPT_TIMEOUT_MS = DEFAULT_PROMPT_TIMEOUT_SEC * 1000;

/**
 * Default quiet-period silence window in seconds (45 minutes), sized above the
 * empirical 34.17-minute maximum inter-frame gap across 126 recorded live
 * turns (#244). `0` disables the silence window and leaves the ceiling alone.
 */
export const DEFAULT_PROMPT_SILENCE_SEC = 2700;

/** `DEFAULT_PROMPT_SILENCE_SEC` in the ms the routes and server deps carry. */
export const DEFAULT_PROMPT_SILENCE_MS = DEFAULT_PROMPT_SILENCE_SEC * 1000;

/**
 * The effective per-turn ceiling in ms, from the seconds the CLI carries.
 *
 * One function because the CLI speaks seconds (`--prompt-timeout-sec`, matching
 * the spec's `promptTimeoutSec`) while every route speaks ms, and because the
 * verifier has to derive the number the running gateway actually runs on rather
 * than re-multiply it and hope the two agree.
 */
export function promptTimeoutMsFromSec(promptTimeoutSec?: number): number {
  return promptTimeoutSec !== undefined
    ? promptTimeoutSec * 1000
    : DEFAULT_PROMPT_TIMEOUT_MS;
}

/**
 * The effective per-turn silence window in ms, from the seconds the CLI
 * carries (`--prompt-silence-sec` / `QWEN_RC_PROMPT_SILENCE_SEC`). `0` disables
 * the silence window.
 */
export function promptSilenceMsFromSec(promptSilenceSec?: number): number {
  return promptSilenceSec !== undefined
    ? promptSilenceSec * 1000
    : DEFAULT_PROMPT_SILENCE_MS;
}

export type TurnDeadlineReason = 'ceiling' | 'silence';

export interface TurnDeadlineFiring {
  reason: TurnDeadlineReason;
  timeoutMs: number;
}

export interface TurnDeadline {
  readonly signal: AbortSignal;
  readonly fired: TurnDeadlineFiring | null;
  /**
   * Arm the quiet-period timer when the prompt enters the 202 subscription
   * wait. No-op when `silenceMs <= 0` or `silenceMs >= ceilingMs`, so the
   * silence window can only ever shorten the ceiling and never runs on a
   * synchronous 200 turn.
   */
  armSilence(): void;
  /** Reset the quiet-period timer on each parsed event frame. */
  onFrame(): void;
  /** Clear both timers once the turn settles. */
  clear(): void;
}

export function createTurnDeadline(opts: {
  ceilingMs: number;
  silenceMs?: number;
}): TurnDeadline {
  const ceilingMs = opts.ceilingMs;
  const silenceMs = opts.silenceMs ?? DEFAULT_PROMPT_SILENCE_MS;
  const silenceShortens = silenceMs > 0 && silenceMs < ceilingMs;

  const abort = new AbortController();
  let firing: TurnDeadlineFiring | null = null;
  let silenceArmed = false;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;

  const clearSilence = () => {
    if (silenceTimer !== undefined) {
      clearTimeout(silenceTimer);
      silenceTimer = undefined;
    }
  };

  const scheduleSilence = () => {
    clearSilence();
    if (!silenceShortens || firing !== null || abort.signal.aborted) return;
    silenceTimer = setTimeout(() => {
      if (firing !== null) return;
      firing = { reason: 'silence', timeoutMs: silenceMs };
      clearTimeout(ceilingTimer);
      abort.abort();
    }, silenceMs);
  };

  const ceilingTimer = setTimeout(() => {
    if (firing !== null) return;
    firing = { reason: 'ceiling', timeoutMs: ceilingMs };
    clearSilence();
    abort.abort();
  }, ceilingMs);

  return {
    get signal() {
      return abort.signal;
    },
    get fired() {
      return firing;
    },
    armSilence() {
      if (!silenceShortens || firing !== null || abort.signal.aborted) return;
      silenceArmed = true;
      scheduleSilence();
    },
    onFrame() {
      if (!silenceArmed) return;
      scheduleSilence();
    },
    clear() {
      clearTimeout(ceilingTimer);
      clearSilence();
    },
  };
}
