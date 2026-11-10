/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import vm from 'node:vm';

const GUARD_INSTALLED = Symbol.for('qwen.cli.reactDevMemoryGuardInstalled');

interface GuardedPerformance {
  measure?: (
    name: string,
    startOrMeasureOptions?: unknown,
    endMark?: string,
  ) => unknown;
  [GUARD_INSTALLED]?: boolean;
}

/**
 * Prevents React 19 dev-mode UserTiming memory leaks in long-lived Node.js TUI
 * processes (`qwen`, `qwen --attach-daemon`).
 *
 * When the CLI runs unbundled from workspace `dist/` (where `NODE_ENV` is
 * unset or set to `"development"` by a project's `.env` file), Node resolves
 * `react-reconciler.development.js` and `react.development.js`.
 *
 * In React 19:
 * 1. `react-reconciler.development.js` sets `supportsUserTiming = true`
 *    whenever `typeof console.timeStamp === 'function'` and
 *    `typeof performance.measure === 'function'`. On every component render and
 *    commit, it diffs props (`addObjectDiffToProperties`) and calls
 *    `performance.measure("\u200b" + name, { detail: { devtools: ... } })`.
 * 2. In Node.js (`node:internal/perf/usertiming`), `performance.measure()`
 *    `structuredClone`s the `detail` payload and appends the `PerformanceMeasure`
 *    entry to the global `PerformanceEntry` buffer, which has no size cap and
 *    never evicts entries unless `performance.clearMeasures()` is called.
 *    During active TUI streaming/timer ticks this leaks ~60-120 MB/minute and
 *    crashes long-lived sessions with a V8 heap OOM
 *    (`Ineffective mark-compacts near heap limit Allocation failed`).
 * 3. `console.createTask` allocates a V8 async task on every React element and
 *    fiber in development builds.
 *
 * This guard:
 * - Removes `console.timeStamp` and `console.createTask` before
 *   `react-reconciler` loads so `supportsUserTiming` is `false` from startup
 *   (without mutating `process.env.NODE_ENV`, which child shell commands
 *   inherit).
 * - Wraps `performance.measure` as a fallback (in case `react-reconciler` was
 *   already imported before the guard ran, e.g. in tests) to drop React
 *   devtools UserTiming measures before they `structuredClone` or enter Node's
 *   global `PerformanceEntry` buffer.
 */
export function installReactDevMemoryGuard(): void {
  if (typeof globalThis.gc !== 'function' && !process.versions['bun']) {
    try {
      v8.setFlagsFromString('--expose-gc');
      globalThis.gc ??= vm.runInNewContext('gc');
    } catch {
      // Ignore when V8 runtime flags are locked.
    }
  }

  const consoleWithInspectorHooks = console as {
    timeStamp?: unknown;
    createTask?: unknown;
  };
  if (typeof consoleWithInspectorHooks.timeStamp === 'function') {
    delete consoleWithInspectorHooks.timeStamp;
  }
  if (typeof consoleWithInspectorHooks.createTask === 'function') {
    delete consoleWithInspectorHooks.createTask;
  }

  for (const perf of [
    globalThis.performance as unknown as GuardedPerformance | undefined,
    performance as unknown as GuardedPerformance | undefined,
  ]) {
    if (!perf || typeof perf.measure !== 'function' || perf[GUARD_INSTALLED]) {
      continue;
    }

    const originalMeasure = perf.measure.bind(perf);
    perf[GUARD_INSTALLED] = true;
    perf.measure = function guardedMeasure(
      name: string,
      startOrMeasureOptions?: unknown,
      endMark?: string,
    ): unknown {
      if (
        startOrMeasureOptions !== null &&
        typeof startOrMeasureOptions === 'object'
      ) {
        const detail = (
          startOrMeasureOptions as { detail?: { devtools?: unknown } }
        ).detail;
        if (
          detail !== null &&
          typeof detail === 'object' &&
          'devtools' in detail
        ) {
          return undefined;
        }
      }
      return originalMeasure(name, startOrMeasureOptions, endMark);
    };
  }
}
