#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- Global Entry Point ---

// Disable V8 inspector console.timeStamp / console.createTask before any React
// or Ink module is loaded so React 19 dev mode does not accumulate unbounded
// PerformanceMeasure entries in Node's global PerformanceEntry buffer.
delete (console as { timeStamp?: unknown }).timeStamp;
delete (console as { createTask?: unknown }).createTask;
import('./src/utils/react-dev-memory-guard.js')
  .then(({ installReactDevMemoryGuard }) => installReactDevMemoryGuard())
  .catch(() => {});

// Java's private stdio worker bypasses the normal CLI module graph.
const startup =
  process.argv.length === 3 && process.argv[2] === 'managed-runtime-bootstrap'
    ? import('./src/serve/managed-runtime-bootstrap.js').then(
        ({ runManagedRuntimeBootstrap }) => runManagedRuntimeBootstrap(),
      )
    : process.argv.length === 4 &&
        process.argv[2] === 'managed-runtime-bootstrap-worker'
      ? import('./src/serve/managed-runtime-ssh-worker.js').then(
          ({ runManagedRuntimeBootstrapWorker }) =>
            runManagedRuntimeBootstrapWorker(process.argv[3]!),
        )
      : process.argv.length === 3 &&
          process.argv[2] === '--workspace-recovery-worker'
        ? import('./src/serve/workspace-recovery-worker.js').then(
            ({ runWorkspaceRecoveryWorker }) => runWorkspaceRecoveryWorker(),
          )
        : import('./src/cli.js').then(({ runCliEntryPoint }) =>
            runCliEntryPoint(),
          );

void startup.catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'CLI startup failed.'}\n`,
    () => process.exit(1),
  );
});
