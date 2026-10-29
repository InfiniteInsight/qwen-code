/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostAttachedWorkspaces,
  defaultHostAttachedWorkspacesPath,
  noteRecentWorkspace,
  parseRecentWorkspaces,
} from './hostAttachedWorkspaces.js';
import {
  RECENT_WORKSPACES_CAP,
  TerminalRequestLog,
  mergeRecentWorkspaces,
} from './terminals.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-attached-ws-'));
  file = join(dir, 'rc', 'host-attached-workspaces.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('defaultHostAttachedWorkspacesPath', () => {
  it('sits beside the terminal request log', () => {
    expect(defaultHostAttachedWorkspacesPath('/home/evan')).toBe(
      '/home/evan/.qwen/rc/host-attached-workspaces.json',
    );
  });
});

describe('noteRecentWorkspace', () => {
  it('puts a new workspace first', () => {
    expect(noteRecentWorkspace([{ cwd: '/a', at: 1 }], '/b', 2, 16)).toEqual([
      { cwd: '/b', at: 2 },
      { cwd: '/a', at: 1 },
    ]);
  });

  it('moves a known workspace to the front with the new time, once', () => {
    expect(
      noteRecentWorkspace(
        [
          { cwd: '/a', at: 3 },
          { cwd: '/b', at: 2 },
        ],
        '/b',
        9,
        16,
      ),
    ).toEqual([
      { cwd: '/b', at: 9 },
      { cwd: '/a', at: 3 },
    ]);
  });

  it('drops the oldest past the cap', () => {
    const list = [
      { cwd: '/a', at: 3 },
      { cwd: '/b', at: 2 },
      { cwd: '/c', at: 1 },
    ];
    expect(noteRecentWorkspace(list, '/d', 4, 3).map((e) => e.cwd)).toEqual([
      '/d',
      '/a',
      '/b',
    ]);
  });
});

describe('parseRecentWorkspaces', () => {
  it('reads the stored shape', () => {
    expect(
      parseRecentWorkspaces(
        JSON.stringify({ workspaces: [{ cwd: '/a', at: 5 }] }),
      ),
    ).toEqual([{ cwd: '/a', at: 5 }]);
  });

  it('reads garbage, the wrong shape and bad entries as nothing', () => {
    expect(parseRecentWorkspaces('not json')).toEqual([]);
    expect(parseRecentWorkspaces('[]')).toEqual([]);
    expect(parseRecentWorkspaces('{"workspaces": 3}')).toEqual([]);
    expect(
      parseRecentWorkspaces(
        JSON.stringify({
          workspaces: [
            { cwd: '', at: 1 },
            { cwd: 'relative', at: 1 },
            { cwd: '/ok', at: 'x' },
            { cwd: '/good', at: 2 },
            null,
          ],
        }),
      ),
    ).toEqual([{ cwd: '/good', at: 2 }]);
  });
});

describe('HostAttachedWorkspaces', () => {
  it('reads a missing file as empty without creating it', async () => {
    expect(await HostAttachedWorkspaces.open(file).read()).toEqual([]);
    await expect(stat(file)).rejects.toThrow();
  });

  it('reads an unreadable or corrupt file as empty', async () => {
    await mkdir(file, { recursive: true }); // a directory where the file goes
    expect(await HostAttachedWorkspaces.open(file).read()).toEqual([]);
    await rm(file, { recursive: true });
    await writeFile(file, '{"workspaces": [tor');
    expect(await HostAttachedWorkspaces.open(file).read()).toEqual([]);
  });

  it('records most recent first, deduped, at 0600', async () => {
    const t = { at: 100 };
    const store = HostAttachedWorkspaces.open(file, { now: () => t.at });
    await store.record('/a');
    t.at = 200;
    await store.record('/b');
    t.at = 300;
    await store.record('/a');
    expect(await store.read()).toEqual([
      { cwd: '/a', at: 300 },
      { cwd: '/b', at: 200 },
    ]);
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
    // Another instance over the same path sees the same record.
    expect(await HostAttachedWorkspaces.open(file).read()).toEqual([
      { cwd: '/a', at: 300 },
      { cwd: '/b', at: 200 },
    ]);
  });

  it(`caps at RECENT_WORKSPACES_CAP (${RECENT_WORKSPACES_CAP}) by default`, async () => {
    let at = 0;
    const store = HostAttachedWorkspaces.open(file, { now: () => ++at });
    for (let i = 0; i < RECENT_WORKSPACES_CAP + 3; i++) {
      await store.record(`/w${i}`);
    }
    const got = await store.read();
    expect(got).toHaveLength(RECENT_WORKSPACES_CAP);
    expect(got[0]?.cwd).toBe(`/w${RECENT_WORKSPACES_CAP + 2}`);
  });

  it('starts over from a corrupt file rather than failing', async () => {
    await mkdir(join(dir, 'rc'), { recursive: true });
    await writeFile(file, 'garbage');
    const store = HostAttachedWorkspaces.open(file, { now: () => 7 });
    await store.record('/a');
    expect(await store.read()).toEqual([{ cwd: '/a', at: 7 }]);
  });

  it('keeps every one of several records made at once', async () => {
    let at = 0;
    const store = HostAttachedWorkspaces.open(file, { now: () => ++at });
    await Promise.all(['/a', '/b', '/c', '/d'].map((c) => store.record(c)));
    expect((await store.read()).map((e) => e.cwd).sort()).toEqual([
      '/a',
      '/b',
      '/c',
      '/d',
    ]);
    // Only the record itself is on disk: no temp file left behind.
    expect(await readdir(join(dir, 'rc'))).toEqual([
      'host-attached-workspaces.json',
    ]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveProperty(
      'workspaces',
    );
  });
});

describe('mergeRecentWorkspaces', () => {
  it('merges the lists newest first', () => {
    expect(
      mergeRecentWorkspaces(
        [
          [
            { cwd: '/term-new', at: 50 },
            { cwd: '/term-old', at: 10 },
          ],
          [{ cwd: '/attach', at: 30 }],
        ],
        16,
      ),
    ).toEqual(['/term-new', '/attach', '/term-old']);
  });

  it('lists a workspace in both once, at its newest time', () => {
    expect(
      mergeRecentWorkspaces(
        [
          [
            { cwd: '/x', at: 40 },
            { cwd: '/both', at: 5 },
          ],
          [{ cwd: '/both', at: 60 }],
        ],
        16,
      ),
    ).toEqual(['/both', '/x']);
  });

  it('caps the union, not each list', () => {
    const a = [
      { cwd: '/a1', at: 6 },
      { cwd: '/a2', at: 4 },
    ];
    const b = [
      { cwd: '/b1', at: 5 },
      { cwd: '/b2', at: 3 },
    ];
    expect(mergeRecentWorkspaces([a, b], 3)).toEqual(['/a1', '/b1', '/a2']);
    expect(mergeRecentWorkspaces([a, b], 0)).toEqual([]);
  });
});

describe('TerminalRequestLog.recentWorkspaceEntries', () => {
  it('carries each workspace with the time of its newest request', async () => {
    const t = { at: 10 };
    const log = TerminalRequestLog.open(join(dir, 'terminal-requests.jsonl'), {
      now: () => t.at,
    });
    const base = {
      sessionId: 's',
      daemonUrl: 'http://127.0.0.1:1',
      daemonToken: 'tok',
      linuxArgv: ['qwen'],
      title: 't',
    };
    await log.enqueue({ ...base, workspaceCwd: '/a' });
    t.at = 20;
    await log.enqueue({ ...base, workspaceCwd: '/b' });
    t.at = 30;
    await log.enqueue({ ...base, workspaceCwd: '/a' });
    expect(await log.recentWorkspaceEntries(16)).toEqual([
      { cwd: '/a', at: 30 },
      { cwd: '/b', at: 20 },
    ]);
    // The string form the listing used before is unchanged.
    expect(await log.recentWorkspaces(16)).toEqual(['/a', '/b']);
  });
});
