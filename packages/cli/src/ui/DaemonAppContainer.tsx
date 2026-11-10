/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-client entry for the TUI (terminal↔mobile handoff). Attaches to an
 * already-running `qwen serve` daemon and renders the SAME rich `<AppContainer>`
 * shell, but driven by `useDaemonStreamAdapter` instead of the in-process
 * `useGeminiStream` (B-prime). The normal `qwen` path is untouched.
 *
 * The render is gated on attach: `useDaemonStream` needs `driver.clientId` set
 * at mount, so we hold a placeholder until `createOrAttach` resolves.
 */
import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { DaemonClient, DaemonSessionClient } from '@qwen-code/sdk';
import { AppContainer } from './AppContainer.js';
import {
  DaemonLossContext,
  DaemonStreamContext,
} from './hooks/daemon/DaemonStreamContext.js';
import {
  DAEMON_GONE_MESSAGE,
  classifyDaemonFailure,
  confirmDaemonGone,
  isTransportError,
} from './hooks/daemon/daemon-loss.js';
import { exitForDaemonLoss } from './hooks/daemon/exit-daemon-gone.js';
import type { DaemonLossHandling } from './hooks/daemon/useDaemonStream.js';
import { useDaemonStreamAdapter } from './hooks/daemon/useDaemonStreamAdapter.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import type { ExtensionRefreshState } from '../config/extension-refresh-state.js';
import type { InitializationResult } from '../core/initializer.js';

export interface DaemonAppContainerProps {
  config: Config;
  settings: LoadedSettings;
  startupWarnings?: string[];
  version: string;
  initializationResult: InitializationResult;
  initialUseVirtualViewport?: boolean;
  extensionRefreshState?: ExtensionRefreshState;
  repaintViewport?: () => void;
  daemonUrl: string;
  daemonToken: string;
  /**
   * Ends the process for a lost daemon. Defaults to cleanup + exit 75 (what
   * `qwen-rc attach` reads as "re-attach me"); injectable so tests never call
   * `process.exit`.
   */
  exitDaemonGone?: () => void | Promise<void>;
  /** Wait before the health re-check (ms); default 1000. */
  recheckDelayMs?: number;
  /** Time for the notice to paint before exiting (ms); default 250. */
  flushMs?: number;
  /**
   * Which session to show. Omitted → the daemon's bound-workspace session.
   * Needed to mirror ONE conversation when the workspace holds several (the
   * web UI opens them with `scope:'thread'`), since `createOrAttach` with an
   * empty request always resolves the workspace default, not a given thread.
   */
  sessionId?: string;
}

export const DaemonAppContainer = (props: DaemonAppContainerProps) => {
  const {
    daemonUrl,
    daemonToken,
    sessionId,
    exitDaemonGone = exitForDaemonLoss,
    recheckDelayMs,
    flushMs = 250,
    ...appProps
  } = props;
  const [driver, setDriver] = useState<DaemonSessionClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [daemonGone, setDaemonGone] = useState(false);
  const client = useMemo(
    () => new DaemonClient({ baseUrl: daemonUrl, token: daemonToken }),
    [daemonUrl, daemonToken],
  );
  // The stream hook's way out when the daemon dies under a running tab.
  const loss = useMemo<DaemonLossHandling>(
    () => ({
      probeHealth: () => client.health(),
      exitDaemonGone,
      recheckDelayMs,
      flushMs,
    }),
    [client, exitDaemonGone, recheckDelayMs, flushMs],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // With an id, load THAT session. The SDK retains the load response's
        // transcript on `replaySnapshot` (the live stream resumes after it);
        // `useDaemonStream` commits it to history before subscribing. Without
        // an id, omit workspaceCwd and get the daemon's bound workspace session.
        const session = sessionId
          ? await DaemonSessionClient.load(client, sessionId)
          : await DaemonSessionClient.createOrAttach(client, {});
        if (!cancelled) setDriver(session);
      } catch (e) {
        if (cancelled) return;
        // A tab relaunched a moment too early finds no daemon yet. That is not
        // an error to sit on: leave with 75 and `qwen-rc attach` tries again.
        // A transport failure is confirmed with one health re-check first; a
        // 404 for the session is the daemon's own word.
        if (
          classifyDaemonFailure({ kind: 'error', error: e }) === 'daemon_gone'
        ) {
          const gone =
            !isTransportError(e) ||
            (await confirmDaemonGone({
              probe: () => client.health(),
              sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
              delayMs: recheckDelayMs,
            }));
          if (cancelled) return;
          if (gone) {
            setDaemonGone(true);
            return;
          }
        }
        setError((e as Error)?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, recheckDelayMs]);

  // Initial attach failed because the daemon is gone: show the one line, give
  // Ink a moment to paint it, then exit.
  useEffect(() => {
    if (!daemonGone) return;
    const timer = setTimeout(() => void exitDaemonGone(), flushMs);
    return () => clearTimeout(timer);
  }, [daemonGone, exitDaemonGone, flushMs]);

  if (daemonGone) {
    return (
      <Box marginX={1}>
        <Text>{DAEMON_GONE_MESSAGE}</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" marginX={1}>
        <Text color="red">Failed to attach to daemon at {daemonUrl}:</Text>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  if (!driver) {
    return (
      <Box marginX={1}>
        <Text>Attaching to daemon at {daemonUrl}…</Text>
      </Box>
    );
  }

  return (
    <DaemonStreamContext.Provider value={driver}>
      <DaemonLossContext.Provider value={loss}>
        <AppContainer {...appProps} useStream={useDaemonStreamAdapter} />
      </DaemonLossContext.Provider>
    </DaemonStreamContext.Provider>
  );
};
