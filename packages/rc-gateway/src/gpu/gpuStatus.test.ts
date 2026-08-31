/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { probeGpuStatus, resetCache } from './gpuStatus.js';

// Shared mock state, controlled per-test.
let gpuStdout = '';
let procStdout = '';
let rejectWith: Error | null = null;

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// The real `/proc/<pid>/cwd` is host-dependent (whether a given pid happens
// to be a live process on the test machine). Mock it so the `/proc` fallback
// branch of resolveWorkspace is deterministic and independently testable,
// while leaving the rest of node:fs untouched.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readlinkSync: vi.fn() };
});

const mockExecFile = vi.mocked(execFile);
const mockReadlinkSync = vi.mocked(readlinkSync);

function installExecFileBehavior() {
  mockExecFile.mockImplementation(((...callArgs: unknown[]) => {
    const args = callArgs[1] as string[];
    const cb = callArgs[callArgs.length - 1] as (
      err: Error | null,
      result?: { stdout: string; stderr: string },
    ) => void;
    if (rejectWith) {
      cb(rejectWith);
      return undefined as never;
    }
    const query = args[0] ?? '';
    if (query.startsWith('--query-gpu=')) {
      cb(null, { stdout: gpuStdout, stderr: '' });
    } else {
      cb(null, { stdout: procStdout, stderr: '' });
    }
    return undefined as never;
  }) as typeof execFile);
}

describe('probeGpuStatus', () => {
  beforeEach(() => {
    gpuStdout = '';
    procStdout = '';
    rejectWith = null;
    mockExecFile.mockClear();
    installExecFileBehavior();
    mockReadlinkSync.mockReset();
    mockReadlinkSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    resetCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses single GPU with no processes', async () => {
    gpuStdout = '0, NVIDIA RTX 4090, GPU-84ccface-663f-f5fd-8e8e-109d0f78bd2f, 1024, 24576, 45, 38\n';
    procStdout = '';

    const result = await probeGpuStatus();

    expect(result.available).toBe(true);
    expect(result.gpus).toHaveLength(1);
    expect(result.gpus[0]).toEqual({
      index: 0,
      name: 'NVIDIA RTX 4090',
      uuid: 'GPU-84ccface-663f-f5fd-8e8e-109d0f78bd2f',
      memoryUsedMiB: 1024,
      memoryTotalMiB: 24576,
      utilizationPct: 45,
      temperatureC: 38,
      processes: [],
    });
  });

  it('parses multi-GPU with processes attributed to correct GPUs', async () => {
    gpuStdout =
      '0, NVIDIA RTX 4090, GPU-84ccface-663f-f5fd-8e8e-109d0f78bd2f, 18432, 24576, 95, 72\n' +
      '1, NVIDIA RTX 4090, GPU-b2a04f12-0da1-4c67-a6e0-7a2d53eb15c4, 512, 24576, 5, 35\n';
    procStdout =
      '12345, GPU-84ccface-663f-f5fd-8e8e-109d0f78bd2f, 16384, python3\n' +
      '12346, GPU-84ccface-663f-f5fd-8e8e-109d0f78bd2f, 2048, qwen\n' +
      '99999, GPU-b2a04f12-0da1-4c67-a6e0-7a2d53eb15c4, 512, other-proc\n';

    const pidResolver = (pid: number) =>
      pid === 12345 ? '/home/evan/projects/foo' : null;

    const result = await probeGpuStatus(pidResolver);

    expect(result.available).toBe(true);
    expect(result.gpus).toHaveLength(2);

    const gpu0 = result.gpus.find((g) => g.index === 0)!;
    const gpu1 = result.gpus.find((g) => g.index === 1)!;

    expect(gpu0.processes).toHaveLength(2);
    expect(gpu1.processes).toHaveLength(1);

    const proc12345 = gpu0.processes.find((p) => p.pid === 12345)!;
    const proc12346 = gpu0.processes.find((p) => p.pid === 12346)!;
    expect(proc12345).toEqual({
      pid: 12345,
      name: 'python3',
      gpuMemoryMiB: 16384,
      workspace: '/home/evan/projects/foo',
    });
    expect(proc12346.workspace).toBeNull();

    expect(gpu1.processes[0]).toMatchObject({
      pid: 99999,
      name: 'other-proc',
      gpuMemoryMiB: 512,
      workspace: null,
    });
  });

  it('falls back to /proc/<pid>/cwd when no resolver is given (or it returns null)', async () => {
    gpuStdout = '0, NVIDIA RTX 4090, GPU-84ccface-663f-f5fd-8e8e-109d0f78bd2f, 1024, 24576, 45, 38\n';
    procStdout = '12345, GPU-84ccface-663f-f5fd-8e8e-109d0f78bd2f, 1024, python3\n';
    mockReadlinkSync.mockReturnValue('/home/evan/projects/from-proc');

    const result = await probeGpuStatus();

    expect(mockReadlinkSync).toHaveBeenCalledWith('/proc/12345/cwd');
    expect(result.gpus[0].processes[0].workspace).toBe(
      '/home/evan/projects/from-proc',
    );
  });

  it('returns available:false when nvidia-smi is not found (ENOENT)', async () => {
    const err = new Error('spawn nvidia-smi ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    rejectWith = err;

    const result = await probeGpuStatus();

    expect(result).toEqual({ available: false, gpus: [] });
  });

  it('returns available:false on non-zero exit code', async () => {
    rejectWith = new Error('Command failed with exit code 1');

    const result = await probeGpuStatus();

    expect(result).toEqual({ available: false, gpus: [] });
  });

  it('handles empty GPU list (nvidia-smi present but no GPUs)', async () => {
    gpuStdout = '';
    procStdout = '';

    const result = await probeGpuStatus();

    expect(result).toEqual({ available: true, gpus: [] });
  });

  it('TTL cache returns cached result within window', async () => {
    gpuStdout = '0, NVIDIA RTX 4090, GPU-84ccface-663f-f5fd-8e8e-109d0f78bd2f, 1024, 24576, 45, 38\n';
    procStdout = '';

    const first = await probeGpuStatus();
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    const second = await probeGpuStatus();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });

  it('cache expires after TTL', async () => {
    vi.useFakeTimers();
    gpuStdout = '0, NVIDIA RTX 4090, GPU-84ccface-663f-f5fd-8e8e-109d0f78bd2f, 1024, 24576, 45, 38\n';
    procStdout = '';

    await probeGpuStatus();
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2001);

    await probeGpuStatus();
    expect(mockExecFile).toHaveBeenCalledTimes(4);
  });
});
