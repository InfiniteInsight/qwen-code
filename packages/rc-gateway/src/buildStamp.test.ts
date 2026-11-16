/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitsMatch,
  detectLauncherBuildDrift,
  formatLauncherBuildLine,
  formatLauncherDriftWarning,
  readGatewayBuildStamp,
} from './buildStamp.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('buildStamp (#210)', () => {
  it('reads a stamped build-stamp.json and falls back to unknown when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-build-stamp-'));
    dirs.push(dir);
    const stampFile = join(dir, 'build-stamp.json');
    expect(readGatewayBuildStamp(stampFile)).toEqual({
      commit: 'unknown',
      builtAt: 'unknown',
    });

    writeFileSync(
      stampFile,
      JSON.stringify({
        commit: 'cff0c1d61f',
        builtAt: '2026-11-16T14:00:00.000Z',
      }),
    );
    expect(readGatewayBuildStamp(stampFile)).toEqual({
      commit: 'cff0c1d61f',
      builtAt: '2026-11-16T14:00:00.000Z',
    });
  });

  it('matches short and full git commits by hex prefix', () => {
    expect(commitsMatch('cff0c1d', 'cff0c1d61f001122')).toBe(true);
    expect(commitsMatch('cff0c1d61f', 'd9b3efa230')).toBe(false);
    expect(commitsMatch('unknown', 'unknown')).toBe(false);
  });

  it('stays quiet when no launcher has polled or when commits match, and warns on unstamped or older launcher builds', () => {
    const gw = {
      commit: 'cff0c1d61f',
      builtAt: '2026-11-16T14:00:00.000Z',
    };

    expect(
      detectLauncherBuildDrift(gw, { state: 'never', seenMsAgo: null }),
    ).toBeUndefined();
    expect(
      formatLauncherBuildLine(gw, { state: 'never', seenMsAgo: null }),
    ).toContain('launcher = none recorded');

    expect(
      detectLauncherBuildDrift(gw, {
        state: 'live',
        seenMsAgo: 1_000,
        launcherCommit: 'cff0c1d',
        launcherBuiltAt: '2026-11-16T13:55:00.000Z',
      }),
    ).toBeUndefined();

    const unstamped = detectLauncherBuildDrift(gw, {
      state: 'live',
      seenMsAgo: 1_000,
    });
    expect(unstamped?.reason).toBe('unstamped_launcher');
    expect(formatLauncherDriftWarning(unstamped!)).toContain('predates #210');

    const older = detectLauncherBuildDrift(gw, {
      state: 'live',
      seenMsAgo: 2_000,
      launcherCommit: 'aa288fc16a',
      launcherBuiltAt: '2026-10-30T12:24:00.000Z',
    });
    expect(older?.reason).toBe('older_than_gateway');
    const warn = formatLauncherDriftWarning(older!);
    expect(warn).toContain('aa288fc16a');
    expect(warn).toContain('is older than the gateway build cff0c1d61f');
    expect(warn).toContain('npm --prefix packages/launcher-app run install:win');
  });
});
