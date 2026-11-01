import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startLoopGuard,
  countResources,
  DEFAULT_LOOP_LAG_MS,
  DEFAULT_LAG_STRIKES,
} from './loopGuard.js';

interface Harness {
  logs: string[];
  audits: Array<{ action: string; detail?: Record<string, unknown> }>;
  exits: number[];
  /** Drives the loop delay the guard sees on each tick. */
  lags: number[];
  stop: () => void;
}

function harness(
  lags: number[],
  deps: Parameters<typeof startLoopGuard>[0] = {},
) {
  const logs: string[] = [];
  const audits: Harness['audits'] = [];
  const exits: number[] = [];
  const queue = [...lags];
  const stop = startLoopGuard({
    thresholdMs: 10_000,
    strikeLimit: 3,
    sampleMs: 1_000,
    readLagMs: () => (queue.length > 1 ? (queue.shift() as number) : queue[0]),
    audit: { record: (e) => void audits.push(e) },
    log: (line) => void logs.push(line),
    exit: (code) => void exits.push(code),
    resources: () => ['TCPSocketWrap', 'TCPSocketWrap', 'TLSWrap', 'Timeout'],
    ...deps,
  });
  return { logs, audits, exits, lags, stop };
}

function tick(ms = 1_000): void {
  vi.advanceTimersByTime(ms);
}

describe('loopGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('countResources', () => {
    it('counts by type, most held first', () => {
      expect(countResources(['a', 'b', 'a', 'c', 'a', 'b'])).toEqual([
        ['a', 3],
        ['b', 2],
        ['c', 1],
      ]);
    });

    it('keeps only the top kinds', () => {
      const kinds = ['1', '2', '3', '4', '5', '6', '7'].flatMap((k) => [k, k]);
      expect(countResources(kinds)).toHaveLength(6);
      expect(countResources(kinds).map(([k]) => k)).toContain('1');
    });

    it('is empty for no handles', () => {
      expect(countResources([])).toEqual([]);
    });
  });

  describe('a loop that keeps up', () => {
    it('does nothing', () => {
      vi.useFakeTimers();
      const h = harness([50, 50, 50, 50, 50]);
      tick(6_000);
      expect(h.exits).toEqual([]);
      expect(h.audits).toEqual([]);
      expect(h.logs).toEqual([]);
    });

    it('clears strikes, so one slow tick cannot end the process', () => {
      vi.useFakeTimers();
      // Two bad, one good, two bad: never three in a row.
      const h = harness([12_000, 12_000, 10, 12_000, 12_000, 12_000]);
      tick(5_000);
      expect(h.exits).toEqual([]);
      expect(h.audits.map((a) => a.action)).toEqual([
        'event_loop_lag',
        'event_loop_lag',
        'event_loop_lag',
        'event_loop_lag',
      ]);
    });
  });

  describe('a wedged loop', () => {
    it('records each bad tick with the delay and what is held', () => {
      vi.useFakeTimers();
      const h = harness([40_000, 40_000]);
      tick(1_000);
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0].action).toBe('event_loop_lag');
      expect(h.audits[0].detail).toMatchObject({
        lagMs: 40_000,
        thresholdMs: 10_000,
        strikes: 1,
        strikeLimit: 3,
        held: { TCPSocketWrap: 2, TLSWrap: 1, Timeout: 1 },
      });
      expect(h.logs[0]).toContain('event loop delayed 40000ms');
      expect(h.logs[0]).toContain('TCPSocketWrap=2');
    });

    it('exits only after the strikes line up, once', () => {
      vi.useFakeTimers();
      const h = harness([30_000]);
      tick(2_000);
      expect(h.exits).toEqual([]);
      tick(1_000);
      expect(h.exits).toEqual([1]);
      expect(h.audits.map((a) => a.action)).toEqual([
        'event_loop_lag',
        'event_loop_lag',
        'event_loop_lag',
        'event_loop_wedge_exit',
      ]);
      expect(h.logs.at(-1)).toContain('exiting so systemd can replace');
      // The guard stops watching: it does not exit twice.
      tick(5_000);
      expect(h.exits).toEqual([1]);
    });

    it('names the wedge in the audit record it leaves behind', () => {
      vi.useFakeTimers();
      const h = harness([90_000]);
      tick(3_000);
      const last = h.audits.at(-1);
      expect(last?.action).toBe('event_loop_wedge_exit');
      expect(last?.detail).toMatchObject({ lagMs: 90_000, strikes: 3 });
    });
  });

  describe('configuration', () => {
    it('is off when the threshold is zero', () => {
      vi.useFakeTimers();
      const h = harness([90_000], { thresholdMs: 0 });
      tick(10_000);
      expect(h.exits).toEqual([]);
      expect(h.audits).toEqual([]);
    });

    it('is off when the threshold is not a number', () => {
      vi.useFakeTimers();
      const h = harness([90_000], { thresholdMs: Number('nope') });
      tick(10_000);
      expect(h.exits).toEqual([]);
    });

    it('uses the documented defaults', () => {
      expect(DEFAULT_LOOP_LAG_MS).toBe(10_000);
      expect(DEFAULT_LAG_STRIKES).toBe(3);
    });

    it('stops watching once stopped', () => {
      vi.useFakeTimers();
      const h = harness([90_000]);
      h.stop();
      tick(10_000);
      expect(h.exits).toEqual([]);
      expect(h.audits).toEqual([]);
    });
  });
});
