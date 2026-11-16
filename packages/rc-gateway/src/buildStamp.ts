/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LauncherLiveness } from './terminals.js';

export interface GatewayBuildStamp {
  commit: string;
  builtAt: string;
}

export interface LauncherBuildDrift {
  reason: 'unstamped_launcher' | 'older_than_gateway' | 'commit_mismatch';
  gatewayCommit: string;
  gatewayBuiltAt: string;
  launcherCommit: string | null;
  launcherBuiltAt: string | null;
}

const HEX_COMMIT_RE = /^[0-9a-f]{7,40}$/i;

export function commitsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const la = a.trim().toLowerCase();
  const lb = b.trim().toLowerCase();
  if (!HEX_COMMIT_RE.test(la) || !HEX_COMMIT_RE.test(lb)) return false;
  return la.startsWith(lb) || lb.startsWith(la);
}

export function readGatewayBuildStamp(stampPath?: string): GatewayBuildStamp {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = stampPath
    ? [stampPath]
    : [
        join(here, 'build-stamp.json'),
        join(here, '..', 'dist', 'build-stamp.json'),
      ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      const rec = parsed as Record<string, unknown>;
      const commit =
        typeof rec['commit'] === 'string' && rec['commit'].trim()
          ? rec['commit'].trim()
          : 'unknown';
      const builtAt =
        typeof rec['builtAt'] === 'string' && rec['builtAt'].trim()
          ? rec['builtAt'].trim()
          : 'unknown';
      return { commit, builtAt };
    } catch {
      // Try next candidate or degrade to unknown.
    }
  }
  return { commit: 'unknown', builtAt: 'unknown' };
}

export function formatLauncherBuildLine(
  gateway: GatewayBuildStamp,
  liveness: LauncherLiveness,
): string {
  const gwPart = `gateway build = ${gateway.commit} (built ${gateway.builtAt})`;
  if (liveness.state === 'never') {
    return `qwen-rc serve: ${gwPart}; launcher = none recorded`;
  }
  if (liveness.state === 'unreadable') {
    return `qwen-rc serve: ${gwPart}; launcher = heartbeat unreadable`;
  }
  const commit = liveness.launcherCommit ?? 'unstamped';
  const built = liveness.launcherBuiltAt
    ? `, built ${liveness.launcherBuiltAt}`
    : '';
  return `qwen-rc serve: ${gwPart}; launcher = ${commit} (${liveness.state}${built})`;
}

export function detectLauncherBuildDrift(
  gateway: GatewayBuildStamp,
  liveness: LauncherLiveness,
): LauncherBuildDrift | undefined {
  if (liveness.state === 'never' || liveness.state === 'unreadable') {
    return undefined;
  }
  if (!HEX_COMMIT_RE.test(gateway.commit)) {
    return undefined;
  }
  const lc = liveness.launcherCommit ?? null;
  const lb = liveness.launcherBuiltAt ?? null;
  if (!lc || lc === 'unknown') {
    return {
      reason: 'unstamped_launcher',
      gatewayCommit: gateway.commit,
      gatewayBuiltAt: gateway.builtAt,
      launcherCommit: null,
      launcherBuiltAt: lb,
    };
  }
  if (commitsMatch(gateway.commit, lc)) {
    return undefined;
  }
  const gwMs = Date.parse(gateway.builtAt);
  const lcMs = lb ? Date.parse(lb) : Number.NaN;
  const older =
    Number.isFinite(gwMs) && (!Number.isFinite(lcMs) || lcMs < gwMs);
  return {
    reason: older ? 'older_than_gateway' : 'commit_mismatch',
    gatewayCommit: gateway.commit,
    gatewayBuiltAt: gateway.builtAt,
    launcherCommit: lc,
    launcherBuiltAt: lb,
  };
}

export function formatLauncherDriftWarning(drift: LauncherBuildDrift): string {
  const fix =
    'Fix: run `npm --prefix packages/launcher-app run install:win` from WSL.';
  if (drift.reason === 'unstamped_launcher') {
    return (
      `qwen-rc serve: WARNING: the Windows launcher heartbeat carries no build stamp ` +
      `(predates #210) while the gateway runs ${drift.gatewayCommit} (built ${drift.gatewayBuiltAt}). ${fix}`
    );
  }
  const relation =
    drift.reason === 'older_than_gateway'
      ? 'is older than the gateway build'
      : 'runs a different commit than the gateway build';
  return (
    `qwen-rc serve: WARNING: Windows launcher ${drift.launcherCommit}` +
    (drift.launcherBuiltAt ? ` (built ${drift.launcherBuiltAt})` : '') +
    ` ${relation} ${drift.gatewayCommit} (built ${drift.gatewayBuiltAt}). ${fix}`
  );
}
