/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { parseLauncherArgs } from './args.js';

describe('parseLauncherArgs', () => {
  it('defaults: no json, no explicit port', () => {
    expect(parseLauncherArgs([])).toEqual({ json: false });
  });

  it('reads --json', () => {
    expect(parseLauncherArgs(['--json'])).toEqual({ json: true });
  });

  it('reads --port <n> and --port=<n>', () => {
    expect(parseLauncherArgs(['--port', '9000'])).toEqual({
      json: false,
      port: 9000,
    });
    expect(parseLauncherArgs(['--port=9000', '--json'])).toEqual({
      json: true,
      port: 9000,
    });
  });

  it.each([
    ['--port'],
    ['--port='],
    ['--port', 'abc'],
    ['--port=abc'],
    ['--port=0'],
    ['--port=65536'],
    ['--port=80.5'],
    ['--port', '--json'],
  ])('rejects a bad port (%s) instead of silently using 8443', (...argv) => {
    expect(() => parseLauncherArgs(argv)).toThrow(/--port/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseLauncherArgs(['--prot=9000'])).toThrow(/unexpected/);
  });
});
