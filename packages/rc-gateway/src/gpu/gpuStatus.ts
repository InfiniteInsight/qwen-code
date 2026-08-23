/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readlinkSync } from 'node:fs';

const execFile = promisify(execFileCb);

export interface GpuStatusResponse {
  available: boolean;
  gpus: GpuInfo[];
}

export interface GpuInfo {
  index: number;
  name: string;
  uuid: string;
  memoryUsedMiB: number;
  memoryTotalMiB: number;
  utilizationPct: number;
  temperatureC: number;
  processes: GpuProcess[];
}

export interface GpuProcess {
  pid: number;
  name: string;
  gpuMemoryMiB: number;
  workspace: string | null;
}

/**
 * Resolve the working directory of a GPU-owning process, e.g. by looking up
 * a live rc-gateway daemon/agent registry keyed by pid. Returns `null` when
 * the pid is unknown to the resolver (the caller falls back to `/proc`).
 */
export type PidResolver = (pid: number) => string | null;

const NVIDIA_SMI = 'nvidia-smi';
const GPU_QUERY =
  'index,name,uuid.short,memory.used,memory.total,utilization.gpu,temperature.gpu';
const PROC_QUERY = 'pid,gpu_uuid,used_gpu_memory,process_name';
const CSV_FORMAT = '--format=csv,noheader,nounits';
const CACHE_TTL_MS = 2000;

interface RawProcess {
  pid: number;
  gpuUuid: string;
  gpuMemoryMiB: number;
  name: string;
}

let cached: { data: GpuStatusResponse; expiresAt: number } | null = null;

/**
 * Probe `nvidia-smi` for current GPU status and running compute processes,
 * caching the result for `CACHE_TTL_MS` to avoid shelling out on every poll.
 * Resolves `{ available: false, gpus: [] }` (never rejects) when
 * `nvidia-smi` is missing or exits non-zero.
 */
export async function probeGpuStatus(
  pidResolver?: PidResolver,
  now?: () => number,
): Promise<GpuStatusResponse> {
  const nowMs = (now ?? Date.now)();
  if (cached && nowMs < cached.expiresAt) return cached.data;

  try {
    const [gpuOut, procOut] = await Promise.all([
      runNvidiaSmi('--query-gpu=' + GPU_QUERY),
      runNvidiaSmi('--query-compute-apps=' + PROC_QUERY),
    ]);

    const gpus = parseGpuCsv(gpuOut);
    const procs = parseProcCsv(procOut);

    for (const gpu of gpus) {
      gpu.processes = procs
        .filter((p) => p.gpuUuid === gpu.uuid)
        .map((p) => ({
          pid: p.pid,
          name: p.name,
          gpuMemoryMiB: p.gpuMemoryMiB,
          workspace: resolveWorkspace(p.pid, pidResolver),
        }));
    }

    const data: GpuStatusResponse = { available: true, gpus };
    cached = { data, expiresAt: nowMs + CACHE_TTL_MS };
    return data;
  } catch {
    const data: GpuStatusResponse = { available: false, gpus: [] };
    cached = { data, expiresAt: nowMs + CACHE_TTL_MS };
    return data;
  }
}

/** Test-only: clear the TTL cache so each test starts from a clean slate. */
export function resetCache(): void {
  cached = null;
}

async function runNvidiaSmi(query: string): Promise<string> {
  const { stdout } = await execFile(NVIDIA_SMI, [query, CSV_FORMAT], {
    timeout: 5000,
  });
  return stdout;
}

function splitCsvLine(line: string): string[] {
  return line.split(',').map((field) => field.trim());
}

function nonEmptyLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseGpuCsv(stdout: string): GpuInfo[] {
  return nonEmptyLines(stdout).map((line) => {
    const [index, name, uuid, memoryUsed, memoryTotal, utilization, temperature] =
      splitCsvLine(line);
    return {
      index: Number(index),
      name,
      uuid,
      memoryUsedMiB: Number(memoryUsed),
      memoryTotalMiB: Number(memoryTotal),
      utilizationPct: Number(utilization),
      temperatureC: Number(temperature),
      processes: [],
    };
  });
}

function parseProcCsv(stdout: string): RawProcess[] {
  return nonEmptyLines(stdout).map((line) => {
    const [pid, gpuUuid, gpuMemory, name] = splitCsvLine(line);
    return {
      pid: Number(pid),
      gpuUuid,
      gpuMemoryMiB: Number(gpuMemory),
      name,
    };
  });
}

function resolveWorkspace(pid: number, resolver?: PidResolver): string | null {
  if (resolver) {
    const resolved = resolver(pid);
    if (resolved !== null) return resolved;
  }
  try {
    return readlinkSync('/proc/' + pid + '/cwd');
  } catch {
    return null;
  }
}
