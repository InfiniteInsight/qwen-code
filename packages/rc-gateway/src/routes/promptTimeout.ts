/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one per-turn budget shared by every route that posts a prompt:
 * `routes/prompt.ts`, `routes/commands.ts`, `routes/supportedCommands.ts`.
 *
 * Each of the three carried its own literal before #237, so the knob the CLI
 * documents as "the" turn timeout disagreed with two of them by default, and
 * raising one route's bound left the others cutting turns off earlier.
 *
 * This bound is an absolute ceiling, deliberately not a silence window. The
 * gateway cannot measure turn silence: the daemon's frames reach it through the
 * watched-session relay (`routes/sessionEvents.ts`), which exists only while a
 * client is watching, and `daemon.prompt()` waits on one promise that reports
 * nothing while it runs. And a turn that stops emitting is not a turn that
 * stopped working - one tool call (a build, a test run) can hold the bus quiet
 * for tens of minutes, so any window short enough to catch a wedged turn also
 * aborts a progressing one, which is the failure this issue is about removing,
 * not re-introducing. So the bound is "this turn will never answer", which the
 * ceiling catches and no observation gap defeats.
 */
export const DEFAULT_PROMPT_TIMEOUT_SEC = 7200;

/** `DEFAULT_PROMPT_TIMEOUT_SEC` in the ms the routes and server deps carry. */
export const DEFAULT_PROMPT_TIMEOUT_MS = DEFAULT_PROMPT_TIMEOUT_SEC * 1000;

/**
 * The effective per-turn budget in ms, from the seconds the CLI carries.
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
