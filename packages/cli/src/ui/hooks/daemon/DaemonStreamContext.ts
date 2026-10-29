/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext } from 'react';
import type { useLlmStream } from '../use-llm-stream.js';
import type { DaemonSessionDriver } from './useDaemonStream.js';

/**
 * Provides the attached daemon session driver to `useDaemonStreamAdapter`.
 * `DaemonAppContainer` sets it after `createOrAttach` resolves; it is `null` in
 * the normal in-process path (where the adapter is never used).
 */
export const DaemonStreamContext = createContext<DaemonSessionDriver | null>(
  null,
);

/**
 * The stream hook `AppContainer` is driven by: `useLlmStream` in process, or the
 * daemon adapter in an attached tab. The daemon variant also reports the
 * session's model and approval mode as the daemon sees them; the in-process hook
 * has no such notion, so the extras are optional.
 */
export type DaemonAwareStreamHook = (
  ...args: Parameters<typeof useLlmStream>
) => ReturnType<typeof useLlmStream> & {
  daemonModelId?: string;
  daemonApprovalMode?: string;
};
