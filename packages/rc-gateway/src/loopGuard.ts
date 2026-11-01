/**
 * Event-loop lag guard (#217).
 *
 * The gateway can wedge: the process stays alive and keeps servicing its own
 * outbound work while incoming sockets go unread, so every client times out and
 * the unit stays green. `Restart=on-failure` cannot see that, because the
 * process never fails, and a wedged loop cannot run its own SIGTERM handler
 * either (the 2026-10-31 stop ran 94s before systemd killed it). This watches
 * the delay between loop iterations and, when it is sustained, records what the
 * process is holding and exits so systemd brings up a fresh one.
 *
 * Delay is the signal, not CPU. A profile taken minutes after a wedge recovered
 * showed the main thread 98% idle, so "busy" is not a reliable tell, while a
 * loop that cannot complete a timer tick is exactly the state where sockets go
 * unread.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Sustained loop delay that counts as one bad tick. */
export const DEFAULT_LOOP_LAG_MS = 10_000;
/** Consecutive bad ticks before the process gives itself up. */
export const DEFAULT_LAG_STRIKES = 3;
/** How often the delay is read. */
export const DEFAULT_LAG_SAMPLE_MS = 1_000;

interface AuditLike {
  record(entry: {
    action: string;
    detail?: Record<string, unknown>;
  }): unknown | Promise<unknown>;
}

export interface LoopGuardDeps {
  /** Sustained loop delay that counts as wedged. 0 or NaN turns the guard off. */
  thresholdMs?: number;
  strikeLimit?: number;
  sampleMs?: number;
  /** Loop delay in ms. Defaults to the perf-hooks histogram of loop lag. */
  readLagMs?: () => number;
  audit?: AuditLike;
  log?: (line: string) => void;
  /** Replaced in tests; the default ends the process for systemd to replace. */
  exit?: (code: number) => void;
  /** Live handles, for the line that names what is piled up. */
  resources?: () => readonly string[];
}

/** Counts of live handles by type, most held first. */
export function countResources(
  resources: readonly string[],
  limit = 6,
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const kind of resources) counts.set(kind, (counts.get(kind) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function formatResources(
  counts: ReadonlyArray<readonly [string, number]>,
): string {
  if (counts.length === 0) return 'none';
  return counts.map(([kind, n]) => `${kind}=${n}`).join(' ');
}

/**
 * Watch the event loop and return the stop. Each bad tick is logged and audited
 * once (`event_loop_lag`) with the delay and the held-handle breakdown, which is
 * the evidence a restart would otherwise destroy. After `strikeLimit`
 * consecutive bad ticks the guard records `event_loop_wedge_exit` and exits 1,
 * which `Restart=on-failure` picks up after `RestartSec`.
 *
 * A tick that comes in under the threshold clears the strikes, so one long
 * synchronous job is not enough to end the process.
 */
export function startLoopGuard(deps: LoopGuardDeps = {}): () => void {
  const thresholdMs = deps.thresholdMs ?? DEFAULT_LOOP_LAG_MS;
  if (!(thresholdMs > 0)) return () => {};
  const strikeLimit = deps.strikeLimit ?? DEFAULT_LAG_STRIKES;
  const sampleMs = deps.sampleMs ?? DEFAULT_LAG_SAMPLE_MS;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const resources = deps.resources ?? (() => process.getActiveResourcesInfo());

  // Only pay for the histogram when nothing else is measuring the loop.
  const histogram = deps.readLagMs
    ? undefined
    : monitorEventLoopDelay({ resolution: 20 });
  histogram?.enable();
  const readLagMs =
    deps.readLagMs ??
    (() => {
      // The histogram reports nanoseconds.
      const ms =
        (histogram as ReturnType<typeof monitorEventLoopDelay>).max / 1e6;
      histogram?.reset();
      return ms;
    });

  let strikes = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    histogram?.disable();
  };

  const tick = (): void => {
    const lagMs = readLagMs();
    if (!(lagMs >= thresholdMs)) {
      strikes = 0;
      return;
    }
    strikes += 1;
    const held = countResources(resources());
    const detail = {
      lagMs: Math.round(lagMs),
      thresholdMs,
      strikes,
      strikeLimit,
      held: Object.fromEntries(held),
    };
    deps.log?.(
      `loop guard: event loop delayed ${Math.round(lagMs)}ms (threshold ${thresholdMs}ms), strike ${strikes}/${strikeLimit}; ${formatResources(held)}`,
    );
    void deps.audit?.record({ action: 'event_loop_lag', detail });
    if (strikes < strikeLimit) return;
    deps.log?.(
      `loop guard: event loop delayed ${Math.round(lagMs)}ms for ${strikes} ticks in a row, exiting so systemd can replace this process`,
    );
    void deps.audit?.record({ action: 'event_loop_wedge_exit', detail });
    stop();
    exit(1);
  };

  timer = setInterval(tick, sampleMs);
  // The guard must never be what keeps the process alive.
  timer.unref();
  return stop;
}
