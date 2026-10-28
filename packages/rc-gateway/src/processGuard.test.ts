/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  describeRejection,
  installUnhandledRejectionGuard,
} from './processGuard.js';

describe('describeRejection', () => {
  it('names the error, its message and the first stack frame only', () => {
    const err = new TypeError('store write failed');
    err.stack = [
      'TypeError: store write failed',
      '    at persist (/srv/rc/tokenStore.ts:698:11)',
      '    at removeOrigin (/srv/rc/tokenStore.ts:683:5)',
    ].join('\n');
    const line = describeRejection(err);
    expect(line).toBe(
      'TypeError: store write failed (at persist (/srv/rc/tokenStore.ts:698:11))',
    );
    expect(line).not.toContain('removeOrigin');
  });

  it('copes with errors that have no stack', () => {
    const err = new Error('bare');
    err.stack = undefined;
    expect(describeRejection(err)).toBe('Error: bare');
  });

  it('describes non-Error reasons without throwing', () => {
    expect(describeRejection('just a string')).toBe('just a string');
    expect(describeRejection(undefined)).toBe('undefined');
    expect(describeRejection(Object.create(null))).toBe('[object]');
  });
});

describe('installUnhandledRejectionGuard', () => {
  it('logs a rejection and lets the process carry on', () => {
    const target = new EventEmitter();
    const lines: string[] = [];
    installUnhandledRejectionGuard('qwen-rc serve', target, (m) =>
      lines.push(m),
    );

    expect(() =>
      target.emit('unhandledRejection', new RangeError('boom')),
    ).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('qwen-rc serve');
    expect(lines[0]).toContain('RangeError: boom');
  });

  it('registers only unhandledRejection, never an uncaughtException swallow', () => {
    const target = new EventEmitter();
    installUnhandledRejectionGuard('qwen-rc serve', target, () => {});
    expect(target.listenerCount('unhandledRejection')).toBe(1);
    expect(target.listenerCount('uncaughtException')).toBe(0);
  });

  it('is idempotent per target', () => {
    const target = new EventEmitter();
    installUnhandledRejectionGuard('a', target, () => {});
    installUnhandledRejectionGuard('a', target, () => {});
    expect(target.listenerCount('unhandledRejection')).toBe(1);
  });

  it('survives a log sink that throws', () => {
    const target = new EventEmitter();
    installUnhandledRejectionGuard('a', target, () => {
      throw new Error('stderr closed');
    });
    expect(() =>
      target.emit('unhandledRejection', new Error('x')),
    ).not.toThrow();
  });

  it('keeps a real Node process alive after a stray rejection', () => {
    // Node 22 exits on an unhandled rejection unless a listener is present.
    // Run the guard in a child process so the parent's own handlers (vitest's)
    // do not mask the default behaviour. processGuard.ts is erasable-only TS,
    // so Node's built-in type stripping can load it directly.
    const guardUrl = new URL('./processGuard.ts', import.meta.url).href;
    const script = [
      `const { installUnhandledRejectionGuard } = await import(${JSON.stringify(guardUrl)});`,
      `installUnhandledRejectionGuard('child', process, (m) => console.error(m));`,
      `Promise.reject(new Error('stray'));`,
      `setTimeout(() => { console.log('still alive'); }, 50);`,
    ].join('\n');
    const run = spawnSync(
      process.execPath,
      ['--no-warnings', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('still alive');
    expect(run.stderr).toContain('Error: stray');
  });
});

describe('process entrypoints', () => {
  // Booting either entrypoint needs a daemon or a chat network, so the wiring is
  // pinned at the source: each one must call the guard, not merely import it.
  it.each(['cli.ts', 'bridge-sidecar.ts'])('%s installs the guard', (file) => {
    const src = readFileSync(
      fileURLToPath(new URL(`./${file}`, import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/installUnhandledRejectionGuard\(/);
  });
});
