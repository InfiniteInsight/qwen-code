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
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_TAB_CAP,
  HOST_TAB_MAX_AGE_MS,
  HostTabRegistry,
  classifyTabExit,
  deriveTabState,
  deriveTabStates,
  isTabPidLive,
  isValidTabId,
  parseTabRecords,
  procTabProbe,
  pruneTabs,
  type HostTabRecord,
  type HostTabState,
  type TabProcProbe,
} from './hostTabs.js';

const S1 = 'a9a5ddef-edc9-472e-8c52-ea6da2609e80';
const S2 = 'b9a5ddef-edc9-472e-8c52-ea6da2609e81';
const GRACE = 12_000;

function tabId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function rec(n: number, over: Partial<HostTabRecord> = {}): HostTabRecord {
  return {
    tabId: tabId(n),
    sessionId: S1,
    cwd: '/srv/w',
    startedAt: 1_000 * n,
    pid: 4000 + n,
    ...over,
  };
}

describe('classifyTabExit', () => {
  it('names each code the wrapper exits with', () => {
    expect(classifyTabExit(0)).toBe('quit');
    expect(classifyTabExit(75)).toBe('daemon_gone');
    expect(classifyTabExit(129)).toBe('terminal_closed');
    expect(classifyTabExit(130)).toBe('interrupted');
    expect(classifyTabExit(143)).toBe('killed');
    expect(classifyTabExit(1)).toBe('crashed');
    expect(classifyTabExit(137)).toBe('crashed');
  });
});

describe('deriveTabState', () => {
  const now = 100_000;
  it('is quit after 0 and closed after 129, whatever the scan says', () => {
    expect(deriveTabState({ endedAt: 1, exitCode: 0 }, true, now, GRACE)).toBe(
      'quit',
    );
    expect(
      deriveTabState({ endedAt: 1, exitCode: 129 }, false, now, GRACE),
    ).toBe('closed');
  });
  it('is crashed after any other code', () => {
    for (const code of [1, 75, 130, 137, 143]) {
      expect(
        deriveTabState({ endedAt: 1, exitCode: code }, false, now, GRACE),
      ).toBe('crashed');
    }
  });
  it('is live while open with the pid on a live terminal', () => {
    expect(deriveTabState({}, true, now, GRACE)).toBe('live');
    expect(deriveTabState({ lostAt: 1 }, true, now, GRACE)).toBe('live');
  });
  it('is a ghost while open with no such pid, and crashed once the grace window has passed', () => {
    expect(deriveTabState({}, false, now, GRACE)).toBe('ghost');
    expect(deriveTabState({ lostAt: now - GRACE + 1 }, false, now, GRACE)).toBe(
      'ghost',
    );
    expect(deriveTabState({ lostAt: now - GRACE }, false, now, GRACE)).toBe(
      'crashed',
    );
  });
});

describe('deriveTabStates', () => {
  it('lays replaced over a crashed or ghost record whose conversation has a newer record or a live one', () => {
    const a = rec(1, { endedAt: 1_500, exitCode: 137 });
    const b = rec(2); // newer, live
    const c = rec(3, { sessionId: S2, endedAt: 3_500, exitCode: 137 });
    const d = rec(4, { sessionId: S2, lostAt: 0 }); // a ghost turned crashed, newest of S2
    const live = new Set([b.tabId]);
    const states = deriveTabStates(
      [a, b, c, d],
      (r) => live.has(r.tabId),
      100_000,
      GRACE,
    );
    expect(Object.fromEntries(states)).toEqual({
      [a.tabId]: 'replaced',
      [b.tabId]: 'live',
      [c.tabId]: 'replaced',
      [d.tabId]: 'crashed',
    });
  });
  it('replaces an older crashed record when an older live one shows the same conversation', () => {
    const old = rec(1);
    const crashed = rec(2, { endedAt: 2_500, exitCode: 1 });
    const states = deriveTabStates(
      [old, crashed],
      (r) => r === old,
      10_000,
      GRACE,
    );
    expect(states.get(crashed.tabId)).toBe('replaced');
  });
  it('leaves quit and closed alone', () => {
    const a = rec(1, { endedAt: 1_500, exitCode: 0 });
    const b = rec(2, { endedAt: 2_500, exitCode: 129 });
    const states = deriveTabStates([a, b], () => false, 10_000, GRACE);
    expect([states.get(a.tabId), states.get(b.tabId)]).toEqual([
      'quit',
      'closed',
    ]);
  });
});

describe('pruneTabs', () => {
  const now = HOST_TAB_MAX_AGE_MS + 1_000_000;
  it('drops what is older than seven days, measured from its newest moment, and never a live record', () => {
    const old = rec(1, { endedAt: 2_000, exitCode: 137 });
    const oldButDismissedLately = rec(2, {
      endedAt: 3_000,
      exitCode: 137,
      dismissedAt: now - 1_000,
    });
    const oldLive = rec(3);
    const states = new Map<string, HostTabState>([
      [old.tabId, 'crashed'],
      [oldButDismissedLately.tabId, 'crashed'],
      [oldLive.tabId, 'live'],
    ]);
    expect(
      pruneTabs([old, oldButDismissedLately, oldLive], states, now).map(
        (r) => r.tabId,
      ),
    ).toEqual([oldButDismissedLately.tabId, oldLive.tabId]);
  });
  it('past the cap drops the oldest terminal records first, then dismissed, then crashed, never live', () => {
    const t = now - 10_000;
    const crashedOld = rec(1, { startedAt: t, endedAt: t + 1, exitCode: 137 });
    const dismissed = rec(2, {
      startedAt: t + 10,
      endedAt: t + 11,
      exitCode: 137,
      dismissedAt: t + 12,
    });
    const quitNew = rec(3, { startedAt: t + 20, endedAt: t + 21, exitCode: 0 });
    const closedNew = rec(4, {
      startedAt: t + 30,
      endedAt: t + 31,
      exitCode: 129,
    });
    const live = rec(5, { startedAt: t - 5 });
    const all = [crashedOld, dismissed, quitNew, closedNew, live];
    const states = new Map<string, HostTabState>([
      [crashedOld.tabId, 'crashed'],
      [dismissed.tabId, 'crashed'],
      [quitNew.tabId, 'quit'],
      [closedNew.tabId, 'closed'],
      [live.tabId, 'live'],
    ]);
    const ids = (n: number) =>
      pruneTabs(all, states, now, { cap: n }).map((r) => r.tabId);
    expect(ids(4)).toEqual([
      crashedOld.tabId,
      dismissed.tabId,
      closedNew.tabId,
      live.tabId,
    ]);
    expect(ids(3)).toEqual([crashedOld.tabId, dismissed.tabId, live.tabId]);
    expect(ids(2)).toEqual([crashedOld.tabId, live.tabId]);
    expect(ids(1)).toEqual([live.tabId]);
    expect(ids(0)).toEqual([live.tabId]);
  });
  it('keeps everything under the cap', () => {
    const list = Array.from({ length: 5 }, (_, i) =>
      rec(i + 1, { startedAt: now - 10 }),
    );
    expect(pruneTabs(list, new Map(), now)).toHaveLength(5);
    expect(HOST_TAB_CAP).toBe(200);
  });
});

describe('parseTabRecords', () => {
  it('keeps well-formed records once each and drops the rest', () => {
    const good = rec(1, { endedAt: 5, exitCode: 137, reason: 'crashed' });
    const parsed = parseTabRecords({
      v: 1,
      tabs: [
        good,
        good,
        { ...rec(2), tabId: '../x' },
        { ...rec(3), sessionId: 'not a session' },
        { ...rec(4), cwd: 'relative' },
        { ...rec(5), pid: -1 },
        null,
      ],
    });
    expect(parsed).toEqual([good]);
    expect(parseTabRecords('nonsense')).toEqual([]);
    expect(parseTabRecords({ tabs: 'x' })).toEqual([]);
  });
});

describe('procTabProbe and isTabPidLive', () => {
  let proc: string;
  beforeEach(async () => {
    proc = await mkdtemp(join(tmpdir(), 'rc-tabs-proc-'));
    await mkdir(join(proc, 'sys', 'kernel', 'random'), { recursive: true });
    await writeFile(
      join(proc, 'sys', 'kernel', 'random', 'boot_id'),
      'boot-1\n',
    );
  });
  afterEach(async () => {
    await rm(proc, { recursive: true, force: true });
  });
  async function fakeProc(
    pid: number,
    state: string,
    start: string,
    fd0: string,
  ): Promise<void> {
    await mkdir(join(proc, String(pid), 'fd'), { recursive: true });
    // A command name with a space and a paren, which is why fields count from the last `)`.
    const fields = [
      state,
      '1',
      ...Array.from({ length: 17 }, () => '0'),
      start,
      '0',
    ];
    await writeFile(
      join(proc, String(pid), 'stat'),
      `${pid} (node (x) y) ${fields.join(' ')}\n`,
    );
    await symlink(fd0, join(proc, String(pid), 'fd', '0'));
  }

  it('reads the start time, fd 0 and the boot id', async () => {
    await fakeProc(10, 'S', '777', '/dev/pts/4');
    const p = procTabProbe(proc);
    expect(await p.startTime(10)).toBe('777');
    expect(await p.stdinTarget(10)).toBe('/dev/pts/4');
    expect(await p.bootId()).toBe('boot-1');
    expect(await p.startTime(11)).toBeUndefined();
  });

  it('is live only for the same process, same boot, on a live terminal', async () => {
    await fakeProc(10, 'S', '777', '/dev/pts/4');
    await fakeProc(12, 'S', '777', '/dev/pts/5 (deleted)');
    await fakeProc(13, 'Z', '777', '/dev/pts/6');
    const p = procTabProbe(proc);
    expect(
      await isTabPidLive(
        { pid: 10, pidStart: '777', bootId: 'boot-1' },
        p,
        'boot-1',
      ),
    ).toBe(true);
    expect(await isTabPidLive({ pid: 10 }, p, 'boot-1')).toBe(true);
    // A reused pid: the process at 10 started at another time.
    expect(await isTabPidLive({ pid: 10, pidStart: '700' }, p, 'boot-1')).toBe(
      false,
    );
    // A record from before a reboot.
    expect(await isTabPidLive({ pid: 10, bootId: 'boot-0' }, p, 'boot-1')).toBe(
      false,
    );
    // A closed tab's orphan (#207), a zombie, and nothing at all.
    expect(await isTabPidLive({ pid: 12 }, p, 'boot-1')).toBe(false);
    expect(await isTabPidLive({ pid: 13 }, p, 'boot-1')).toBe(false);
    expect(await isTabPidLive({ pid: 99 }, p, 'boot-1')).toBe(false);
  });
});

/** A probe over a table the test edits: pid -> start time and fd 0. */
function tableProbe(): TabProcProbe & {
  procs: Map<number, { start: string; fd0: string }>;
  boot: string;
} {
  const procs = new Map<number, { start: string; fd0: string }>();
  const probe = {
    procs,
    boot: 'boot-1',
    startTime: async (pid: number) => procs.get(pid)?.start,
    stdinTarget: async (pid: number) => procs.get(pid)?.fd0,
    bootId: async () => probe.boot,
  };
  return probe;
}

describe('HostTabRegistry', () => {
  let dir: string;
  let file: string;
  let ends: string;
  let clock: number;
  let ids: number;
  let probe: ReturnType<typeof tableProbe>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-tabs-'));
    file = join(dir, 'host-tabs.json');
    ends = join(dir, 'host-tab-ends');
    clock = 1_000_000;
    ids = 0;
    probe = tableProbe();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const open = () =>
    HostTabRegistry.open(file, {
      now: () => clock,
      newId: () => tabId(++ids),
      probe,
      ghostGraceMs: GRACE,
      endsDir: ends,
    });
  const stateOf = async (reg: HostTabRegistry, id: string) =>
    (await reg.view(id))?.state;

  it('opens a record with the pid, its start time and the boot, and lists it live', async () => {
    probe.procs.set(4242, { start: '9001', fd0: '/dev/pts/2' });
    const reg = await open();
    const r = await reg.start({ sessionId: S1, cwd: '/srv/w', pid: 4242 });
    expect(isValidTabId(r.tabId)).toBe(true);
    expect(r).toMatchObject({
      sessionId: S1,
      cwd: '/srv/w',
      pid: 4242,
      pidStart: '9001',
      bootId: 'boot-1',
      startedAt: clock,
    });
    expect(await reg.list()).toEqual([
      { ...r, state: 'live', dismissed: false },
    ]);
    // 0600, written whole, read back by a second instance.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(file, 'utf8')) as {
      v: number;
      tabs: unknown[];
    };
    expect(stored.v).toBe(1);
    expect(stored.tabs).toHaveLength(1);
  });

  it('classifies each end: quit and closed are terminal, anything else is crashed', async () => {
    const reg = await open();
    const codes = [0, 129, 137, 143, 75, 1, 130];
    const want = [
      'quit',
      'closed',
      'crashed',
      'crashed',
      'crashed',
      'crashed',
      'crashed',
    ];
    const got: unknown[] = [];
    for (const [i, code] of codes.entries()) {
      const sid = `c0000000-0000-4000-8000-00000000000${i}`;
      probe.procs.set(100 + i, { start: '1', fd0: '/dev/pts/1' });
      const r = await reg.start({
        sessionId: sid,
        cwd: '/srv/w',
        pid: 100 + i,
      });
      const ended = await reg.end(r.tabId, code);
      got.push([ended?.state, ended?.reason, ended?.exitCode]);
    }
    expect(got).toEqual(codes.map((c, i) => [want[i], classifyTabExit(c), c]));
    expect(await reg.end(tabId(999), 0)).toBeUndefined();
  });

  it('a second end does not overwrite the first', async () => {
    probe.procs.set(1, { start: '1', fd0: '/dev/pts/1' });
    const reg = await open();
    const r = await reg.start({ sessionId: S1, cwd: '/srv/w', pid: 1 });
    await reg.end(r.tabId, 137);
    const again = await reg.end(r.tabId, 0);
    expect([again?.exitCode, again?.state]).toEqual([137, 'crashed']);
  });

  it('turns an open record whose pid went into a ghost, then crashed after the grace window', async () => {
    probe.procs.set(7, { start: '1', fd0: '/dev/pts/1' });
    const reg = await open();
    const r = await reg.start({ sessionId: S1, cwd: '/srv/w', pid: 7 });
    probe.procs.delete(7); // SIGKILL: no end report
    clock += 1_000;
    expect(await stateOf(reg, r.tabId)).toBe('ghost');
    clock += GRACE - 1;
    expect(await stateOf(reg, r.tabId)).toBe('ghost');
    clock += 1;
    expect(await stateOf(reg, r.tabId)).toBe('crashed');
  });

  it('a pty deleted under a live pid is a ghost (#207) and a live terminal again clears it', async () => {
    probe.procs.set(7, { start: '1', fd0: '/dev/pts/1' });
    const reg = await open();
    const r = await reg.start({ sessionId: S1, cwd: '/srv/w', pid: 7 });
    probe.procs.set(7, { start: '1', fd0: '/dev/pts/1 (deleted)' });
    expect(await stateOf(reg, r.tabId)).toBe('ghost');
    probe.procs.set(7, { start: '1', fd0: '/dev/pts/1' });
    expect(await stateOf(reg, r.tabId)).toBe('live');
    expect(reg.get(r.tabId)?.lostAt).toBeUndefined();
  });

  it('a gateway restart derives every state again from the file and a fresh scan', async () => {
    probe.procs.set(1, { start: '1', fd0: '/dev/pts/1' });
    probe.procs.set(2, { start: '2', fd0: '/dev/pts/2' });
    const first = await open();
    const live = await first.start({ sessionId: S1, cwd: '/srv/w', pid: 1 });
    const lost = await first.start({ sessionId: S2, cwd: '/srv/w', pid: 2 });
    // The gateway goes; while it is down tab 2 dies with no end report.
    probe.procs.delete(2);
    clock += 60_000;
    const second = await open();
    expect(await stateOf(second, live.tabId)).toBe('live');
    expect(await stateOf(second, lost.tabId)).toBe('ghost');
    clock += GRACE;
    expect(await stateOf(second, lost.tabId)).toBe('crashed');
    // A reboot: the boot id changes, so even a pid that exists again is not the tab.
    probe.boot = 'boot-2';
    clock += 1;
    expect(await stateOf(second, live.tabId)).toBe('ghost');
  });

  it('takes in an end a wrapper left on disk, once, and removes the file', async () => {
    probe.procs.set(3, { start: '1', fd0: '/dev/pts/1' });
    const first = await open();
    const r = await first.start({ sessionId: S1, cwd: '/srv/w', pid: 3 });
    probe.procs.delete(3);
    await mkdir(ends, { recursive: true });
    await writeFile(
      join(ends, `${r.tabId}.json`),
      JSON.stringify({ tabId: r.tabId, exitCode: 129, endedAt: clock + 5 }),
    );
    // A file under a name that is not its tab is dropped, not applied.
    await writeFile(
      join(ends, `${tabId(77)}.json`),
      JSON.stringify({ tabId: r.tabId, exitCode: 137, endedAt: clock }),
    );
    const second = await open();
    const v = await second.view(r.tabId);
    expect([v?.state, v?.exitCode, v?.endedAt]).toEqual([
      'closed',
      129,
      clock + 5,
    ]);
    expect(await readdir(ends)).toEqual([]);
  });

  it('dismiss keeps the record and marks it, remove deletes it', async () => {
    const reg = await open();
    const r = await reg.start({ sessionId: S1, cwd: '/srv/w', pid: 9 });
    await reg.end(r.tabId, 137);
    expect((await reg.dismiss(r.tabId))?.dismissedAt).toBe(clock);
    const v = await reg.view(r.tabId);
    expect([v?.state, v?.dismissed]).toEqual(['crashed', true]);
    expect(await reg.remove(r.tabId)).toBe(true);
    expect(await reg.remove(r.tabId)).toBe(false);
    expect(await reg.list()).toEqual([]);
    expect(await reg.dismiss(r.tabId)).toBeUndefined();
  });

  it('links a reopened tab to the record it answers and replaces that record', async () => {
    probe.procs.set(11, { start: '1', fd0: '/dev/pts/1' });
    const reg = await open();
    const a = await reg.start({ sessionId: S1, cwd: '/srv/w', pid: 11 });
    await reg.end(a.tabId, 137);
    await reg.noteReopen(a.tabId, true);
    clock += 2_000;
    probe.procs.set(12, { start: '2', fd0: '/dev/pts/2' });
    const b = await reg.start({ sessionId: S1, cwd: '/srv/w', pid: 12 });
    expect(b.origin).toBe('auto_reopen');
    expect(reg.get(a.tabId)?.reopenedBy).toBe(b.tabId);
    expect(await stateOf(reg, a.tabId)).toBe('replaced');
    // A manual reopen of b is answered by c, which is marked as a reopen.
    await reg.end(b.tabId, 137);
    await reg.noteReopen(b.tabId, false);
    probe.procs.set(13, { start: '3', fd0: '/dev/pts/3' });
    clock += 2_000;
    const c = await reg.start({ sessionId: S1, cwd: '/srv/w', pid: 13 });
    expect(c.origin).toBe('reopen');
    // A tab nobody asked for is not linked.
    probe.procs.set(14, { start: '4', fd0: '/dev/pts/4' });
    const d = await reg.start({ sessionId: S2, cwd: '/srv/w', pid: 14 });
    expect(d.origin).toBeUndefined();
  });

  it('prunes at the cap on write, terminal records first', async () => {
    const reg = await HostTabRegistry.open(file, {
      now: () => clock,
      newId: () => tabId(++ids),
      probe,
      ghostGraceMs: GRACE,
      cap: 3,
    });
    const quit = await reg.start({ sessionId: S1, cwd: '/srv/w', pid: 1 });
    await reg.end(quit.tabId, 0);
    clock += 1;
    const crashed = await reg.start({ sessionId: S2, cwd: '/srv/w', pid: 2 });
    await reg.end(crashed.tabId, 137);
    clock += 1;
    probe.procs.set(3, { start: '1', fd0: '/dev/pts/1' });
    const live = await reg.start({
      sessionId: 'd0000000-0000-4000-8000-000000000001',
      cwd: '/srv/w',
      pid: 3,
    });
    clock += 1;
    probe.procs.set(4, { start: '1', fd0: '/dev/pts/2' });
    const newest = await reg.start({
      sessionId: 'd0000000-0000-4000-8000-000000000002',
      cwd: '/srv/w',
      pid: 4,
    });
    const left = (await reg.list()).map((v) => v.tabId).sort();
    expect(left).toEqual([crashed.tabId, live.tabId, newest.tabId].sort());
  });

  it('starts empty on a file that is not the stored shape', async () => {
    await writeFile(file, JSON.stringify({ tabs: [{ nope: true }] }));
    const reg = await open();
    expect(await reg.list()).toEqual([]);
  });
});
