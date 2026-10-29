/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runExitCleanup } from '../../../utils/cleanup.js';
import { exitCleanly } from '../../../utils/processUtils.js';
import { DAEMON_GONE_EXIT_CODE } from './daemon-loss.js';

/**
 * End the attached TUI because its daemon is gone, with the exit code
 * `qwen-rc attach` reads as "re-attach me". Goes through the same path as
 * `/quit`: `runExitCleanup` first (it unmounts Ink, which restores the
 * terminal, pops the keyboard protocol and runs every registered cleanup),
 * then `exitCleanly` to exit with the code.
 */
export async function exitForDaemonLoss(): Promise<never> {
  await runExitCleanup();
  return exitCleanly(DAEMON_GONE_EXIT_CODE);
}
