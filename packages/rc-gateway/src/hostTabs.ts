/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The host tab registry (InfiniteInsight/Qwen-Code-Remote#212): one record
 * per terminal tab that ran `qwen-rc attach`, so a tab that ended without
 * `/quit` is remembered as crashed and can be reopened from the phone.
 *
 * The model is Claude-Remote-Rescue's: a journal of sessions, each with a
 * state derived at read time (live, ghost, crashed), and three verbs (reopen,
 * dismiss, remove). Copied as a model, not as code.
 *
 * Where the facts come from:
 * - Start: the wrapper's first `POST /rc/host/attach[/:id]` carries its pid;
 *   the gateway opens a record and answers its `tabId` (routes/hostAttach.ts).
 * - End: the wrapper's exit path posts its exit code to
 *   `POST /rc/host/tabs/:tabId/end` (routes/hostTabs.ts). Best effort, with a
 *   short timeout. When that post gets no answer (the gateway is down, which
 *   is exactly when a tab is likeliest to be closed while it waits to
 *   re-attach) the wrapper leaves the end in a small file under
 *   `host-tab-ends/`, and the registry takes it in on its next read.
 * - Everything else: a scan of the record's pid, read straight from /proc.
 *
 * States, derived, never stored:
 * - `live`: open (no end), and the pid is the same process that started (its
 *   start time and the boot match) with a live terminal on fd 0.
 * - `ghost`: open, and the scan finds no such process. Usually a tab whose
 *   end report is a second away (the terminal guard is ending the TUI), so it
 *   is given a grace window before it counts as crashed.
 * - `crashed`: ended with any code but 0 and 129, or a ghost for longer than
 *   the grace window (one launcher stale window, see routes/terminals.ts).
 * - `quit` (ended 0, `/quit`) and `closed` (ended 129, the tab was closed):
 *   the user's own act, shown nowhere.
 * - `replaced`: a ghost or crashed record of a conversation that has a newer
 *   record, or a live one: the conversation is back on screen, so the old
 *   record has nothing left to say. Shown nowhere.
 *
 * Storage: `~/.qwen/rc/host-tabs.json`, `{ v: 1, tabs: [...] }`, 0600. The
 * gateway is its only writer and holds the records in memory, so a read never
 * touches the file; every change is written whole through `writeFileAtomic`
 * (temp file and rename). A gateway restart reads the file back and derives
 * every state again from the records and a fresh scan.
 *
 * Pruning: a record whose newest moment is older than seven days goes, and
 * past 200 records the oldest go, terminal states first (quit, closed,
 * replaced), then dismissed ones, then crashed and ghost ones. A live record
 * is never pruned.
 */

import { randomUUID } from 'node:crypto';
import { readdir, readFile, readlink, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { readJsonStore, writeFileAtomic } from './atomicWrite.js';
import { isLiveTerminalTarget } from './hostMirrors.js';
import {
  INTERRUPTED_EXIT,
  TERMINAL_GONE_EXIT,
  TUI_DAEMON_GONE_EXIT,
} from './reattachLoop.js';
import { isValidSessionId } from './sessions/chatsPath.js';

/** Base name of the registry, beside `host-attached-workspaces.json`. */
export const HOST_TABS_BASENAME = 'host-tabs.json';

/** Directory, beside the registry, where a wrapper leaves an end it could not post. */
export const HOST_TAB_ENDS_DIRNAME = 'host-tab-ends';

/** Default registry path, mirroring the other `~/.qwen/rc` stores. */
export function defaultHostTabsPath(homeDir: string): string {
  return join(homeDir, '.qwen', 'rc', HOST_TABS_BASENAME);
}

/** Where ends left by wrappers wait for the gateway, under `rcDir`. */
export function hostTabEndsDir(rcDir: string): string {
  return join(rcDir, HOST_TAB_ENDS_DIRNAME);
}

/** A record whose newest moment is older than this is pruned. */
export const HOST_TAB_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** At most this many records are kept. */
export const HOST_TAB_CAP = 200;

/** The wrapper's exit code after a SIGTERM: 128 + 15, as a shell reports it. */
export const SIGTERM_EXIT = 143;

/** A tab id is a v4-shaped uuid the gateway minted; nothing else is accepted. */
const TAB_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidTabId(id: unknown): id is string {
  return typeof id === 'string' && TAB_ID_RE.test(id);
}

/** Why a tab ended, read from the wrapper's exit code. */
export type HostTabReason =
  | 'quit'
  | 'daemon_gone'
  | 'terminal_closed'
  | 'interrupted'
  | 'killed'
  | 'crashed';

/** A record's state, derived at read time. */
export type HostTabState =
  | 'live'
  | 'ghost'
  | 'crashed'
  | 'quit'
  | 'closed'
  | 'replaced';

/** How a tab came to be, when the gateway asked for it. */
export type HostTabOrigin = 'reopen' | 'auto_reopen';

export interface HostTabRecord {
  tabId: string;
  sessionId: string;
  /** The daemon's workspace, where a reopened tab runs. */
  cwd: string;
  startedAt: number;
  /** The `qwen-rc attach` wrapper's pid. */
  pid: number;
  /** Field 22 of `/proc/<pid>/stat` when the record opened, so a reused pid never reads as this tab. */
  pidStart?: string;
  /** The kernel boot id when the record opened, so a pid from before a reboot never reads as this tab. */
  bootId?: string;
  /** Set when this tab answered a reopen of an earlier record of the same conversation. */
  origin?: HostTabOrigin;
  endedAt?: number;
  exitCode?: number;
  reason?: HostTabReason;
  /** The first read that found the pid gone while the record was open. */
  lostAt?: number;
  dismissedAt?: number;
  /** The last reopen asked for this record (from the phone or automatic). */
  reopenedAt?: number;
  /** Set once, by the automatic reopen, so it never reopens this record again. */
  autoReopenedAt?: number;
  /** The record that answered a reopen of this one. */
  reopenedBy?: string;
}

/** A record with its derived state, as the routes answer it. */
export interface HostTabView extends HostTabRecord {
  state: HostTabState;
  dismissed: boolean;
}

/**
 * The reason class of an exit code: 0 `/quit`, 75 the daemon went (the
 * re-attach loop normally absorbs this one), 129 the terminal went (the tab
 * was closed), 130 Ctrl-C during the re-attach wait, 143 SIGTERM, anything
 * else (1 for a refused re-attach, 128 + n for a signal) a crash.
 */
export function classifyTabExit(code: number): HostTabReason {
  if (code === 0) return 'quit';
  if (code === TUI_DAEMON_GONE_EXIT) return 'daemon_gone';
  if (code === TERMINAL_GONE_EXIT) return 'terminal_closed';
  if (code === INTERRUPTED_EXIT) return 'interrupted';
  if (code === SIGTERM_EXIT) return 'killed';
  return 'crashed';
}

/**
 * The state of one record on its own. `pidLive` is the scan's answer for the
 * record's pid; `ghostGraceMs` is how long an open record whose pid is gone
 * stays a ghost before it counts as crashed, measured from `lostAt`.
 */
export function deriveTabState(
  rec: Pick<HostTabRecord, 'endedAt' | 'exitCode' | 'lostAt'>,
  pidLive: boolean,
  now: number,
  ghostGraceMs: number,
): Exclude<HostTabState, 'replaced'> {
  if (rec.endedAt !== undefined) {
    if (rec.exitCode === 0) return 'quit';
    if (rec.exitCode === TERMINAL_GONE_EXIT) return 'closed';
    return 'crashed';
  }
  if (pidLive) return 'live';
  if (rec.lostAt !== undefined && now - rec.lostAt >= ghostGraceMs) {
    return 'crashed';
  }
  return 'ghost';
}

/**
 * Every record's state, with `replaced` laid over a ghost or crashed record
 * whose conversation has a newer record or a live one.
 */
export function deriveTabStates(
  records: readonly HostTabRecord[],
  pidLive: (rec: HostTabRecord) => boolean,
  now: number,
  ghostGraceMs: number,
): Map<string, HostTabState> {
  const own = new Map<string, Exclude<HostTabState, 'replaced'>>();
  for (const r of records) {
    own.set(r.tabId, deriveTabState(r, pidLive(r), now, ghostGraceMs));
  }
  const out = new Map<string, HostTabState>();
  records.forEach((r, i) => {
    const s = own.get(r.tabId)!;
    if (s === 'ghost' || s === 'crashed') {
      // Newer: started later, or in the same millisecond and recorded later.
      const superseded = records.some(
        (o, j) =>
          j !== i &&
          o.sessionId === r.sessionId &&
          (o.startedAt > r.startedAt ||
            (o.startedAt === r.startedAt && j > i) ||
            own.get(o.tabId) === 'live'),
      );
      out.set(r.tabId, superseded ? 'replaced' : s);
    } else {
      out.set(r.tabId, s);
    }
  });
  return out;
}

/** A record's newest moment, the age pruning is measured from. */
export function tabLastAt(r: HostTabRecord): number {
  return Math.max(
    r.startedAt,
    r.endedAt ?? 0,
    r.lostAt ?? 0,
    r.dismissedAt ?? 0,
    r.reopenedAt ?? 0,
    r.autoReopenedAt ?? 0,
  );
}

/**
 * The records to keep, in their order. Drops what is older than `maxAgeMs`,
 * then, past `cap`, the oldest by removal rank: quit, closed and replaced
 * first, dismissed next, then crashed and ghost. Live records are never
 * dropped, whatever their age.
 */
export function pruneTabs(
  records: readonly HostTabRecord[],
  states: ReadonlyMap<string, HostTabState>,
  now: number,
  opts: { maxAgeMs?: number; cap?: number } = {},
): HostTabRecord[] {
  const maxAge = opts.maxAgeMs ?? HOST_TAB_MAX_AGE_MS;
  const cap = opts.cap ?? HOST_TAB_CAP;
  const live = (r: HostTabRecord) => states.get(r.tabId) === 'live';
  let kept = records.filter((r) => live(r) || now - tabLastAt(r) <= maxAge);
  if (kept.length <= cap) return kept;
  const rank = (r: HostTabRecord): number => {
    const s = states.get(r.tabId);
    if (s === 'quit' || s === 'closed' || s === 'replaced') return 0;
    if (r.dismissedAt !== undefined) return 1;
    return 2;
  };
  const order = kept
    .filter((r) => !live(r))
    .sort((a, b) => rank(a) - rank(b) || tabLastAt(a) - tabLastAt(b));
  const drop = new Set(order.slice(0, kept.length - cap).map((r) => r.tabId));
  kept = kept.filter((r) => !drop.has(r.tabId));
  return kept;
}

// ---- The scan --------------------------------------------------------------

/** What the registry reads about a pid; a test seam over /proc. */
export interface TabProcProbe {
  /** Field 22 of the pid's stat (its start time), or undefined when there is no such process or it is a zombie. */
  startTime(pid: number): Promise<string | undefined>;
  /** Where the pid's fd 0 points, or undefined when it cannot be read. */
  stdinTarget(pid: number): Promise<string | undefined>;
  /** This boot's id, or undefined where the kernel does not say. */
  bootId(): Promise<string | undefined>;
}

/** The default probe: a /proc-shaped directory. */
export function procTabProbe(procDir = '/proc'): TabProcProbe {
  return {
    startTime: async (pid) => {
      try {
        const stat = await readFile(join(procDir, String(pid), 'stat'), 'utf8');
        // The command name sits in parentheses and may hold spaces, so the
        // fields are counted from the last `)`: state is field 3, start time
        // field 22.
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (f[0] === 'Z' || f[0] === 'X') return undefined;
        return f[19];
      } catch {
        return undefined;
      }
    },
    stdinTarget: async (pid) => {
      try {
        return await readlink(join(procDir, String(pid), 'fd', '0'));
      } catch {
        return undefined;
      }
    },
    bootId: async () => {
      try {
        const id = (
          await readFile(
            join(procDir, 'sys', 'kernel', 'random', 'boot_id'),
            'utf8',
          )
        ).trim();
        return id || undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Whether a record's tab is on screen: its pid is the process that opened the
 * record (same boot, same start time, when those were known) and its fd 0 is
 * a terminal that still exists (#207: a closed tab can leave the wrapper
 * running on `/dev/pts/N (deleted)`).
 */
export async function isTabPidLive(
  rec: Pick<HostTabRecord, 'pid' | 'pidStart' | 'bootId'>,
  probe: TabProcProbe,
  bootId: string | undefined,
): Promise<boolean> {
  if (
    rec.bootId !== undefined &&
    bootId !== undefined &&
    rec.bootId !== bootId
  ) {
    return false;
  }
  const start = await probe.startTime(rec.pid);
  if (start === undefined) return false;
  if (rec.pidStart !== undefined && start !== rec.pidStart) return false;
  return isLiveTerminalTarget(await probe.stdinTarget(rec.pid));
}

// ---- Parsing ---------------------------------------------------------------

const REASONS: readonly HostTabReason[] = [
  'quit',
  'daemon_gone',
  'terminal_closed',
  'interrupted',
  'killed',
  'crashed',
];

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** One stored record, or undefined for anything that is not the stored shape. */
export function parseTabRecord(raw: unknown): HostTabRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isValidTabId(r.tabId)) return undefined;
  if (typeof r.sessionId !== 'string' || !isValidSessionId(r.sessionId)) {
    return undefined;
  }
  if (typeof r.cwd !== 'string' || !isAbsolute(r.cwd)) return undefined;
  if (!finite(r.startedAt)) return undefined;
  if (!Number.isSafeInteger(r.pid) || (r.pid as number) <= 0) return undefined;
  const out: HostTabRecord = {
    tabId: r.tabId,
    sessionId: r.sessionId,
    cwd: r.cwd,
    startedAt: r.startedAt,
    pid: r.pid as number,
  };
  if (typeof r.pidStart === 'string' && r.pidStart) out.pidStart = r.pidStart;
  if (typeof r.bootId === 'string' && r.bootId) out.bootId = r.bootId;
  if (r.origin === 'reopen' || r.origin === 'auto_reopen')
    out.origin = r.origin;
  if (finite(r.endedAt) && Number.isSafeInteger(r.exitCode)) {
    out.endedAt = r.endedAt;
    out.exitCode = r.exitCode as number;
    out.reason = REASONS.includes(r.reason as HostTabReason)
      ? (r.reason as HostTabReason)
      : classifyTabExit(out.exitCode);
  }
  for (const k of [
    'lostAt',
    'dismissedAt',
    'reopenedAt',
    'autoReopenedAt',
  ] as const) {
    if (finite(r[k])) out[k] = r[k] as number;
  }
  if (isValidTabId(r.reopenedBy)) out.reopenedBy = r.reopenedBy;
  return out;
}

/** The stored records, or `[]` for anything that is not the stored shape. */
export function parseTabRecords(raw: unknown): HostTabRecord[] {
  const list =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { tabs?: unknown }).tabs
      : undefined;
  if (!Array.isArray(list)) return [];
  const out: HostTabRecord[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    const rec = parseTabRecord(e);
    if (!rec || seen.has(rec.tabId)) continue;
    seen.add(rec.tabId);
    out.push(rec);
  }
  return out;
}

/** An end a wrapper left on disk: `host-tab-ends/<tabId>.json`. */
export interface LeftTabEnd {
  tabId: string;
  exitCode: number;
  endedAt: number;
}

export function parseLeftTabEnd(raw: unknown): LeftTabEnd | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isValidTabId(r.tabId)) return undefined;
  if (!Number.isSafeInteger(r.exitCode) || !finite(r.endedAt)) return undefined;
  return { tabId: r.tabId, exitCode: r.exitCode as number, endedAt: r.endedAt };
}

// ---- The registry ----------------------------------------------------------

export interface HostTabRegistryOptions {
  now?: () => number;
  newId?: () => string;
  probe?: TabProcProbe;
  /** How long an open record whose pid is gone stays a ghost. */
  ghostGraceMs: number;
  /** Where wrappers leave ends they could not post; unset, none are read. */
  endsDir?: string;
  maxAgeMs?: number;
  cap?: number;
}

export interface StartTabInput {
  sessionId: string;
  cwd: string;
  pid: number;
}

export class HostTabRegistry {
  /** Serializes every read-modify-write, so concurrent calls all land. */
  private chain: Promise<unknown> = Promise.resolve();
  /** The registry's clock, which every time it stores is read from. */
  readonly now: () => number;
  private readonly newId: () => string;
  private readonly probe: TabProcProbe;

  private constructor(
    private readonly filePath: string,
    private records: HostTabRecord[],
    private readonly opts: HostTabRegistryOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
    this.probe = opts.probe ?? procTabProbe();
  }

  /** Read the registry back (a missing or unreadable file is empty) and take in any ends left on disk. */
  static async open(
    filePath: string,
    opts: HostTabRegistryOptions,
  ): Promise<HostTabRegistry> {
    const reg = new HostTabRegistry(
      filePath,
      parseTabRecords(await readJsonStore(filePath)),
      opts,
    );
    await reg.serial(() => reg.ingestLeftEnds());
    return reg;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private persist(): Promise<void> {
    return writeFileAtomic(
      this.filePath,
      () => JSON.stringify({ v: 1, tabs: this.records }),
      { mode: 0o600 },
    );
  }

  private find(tabId: string): HostTabRecord | undefined {
    return this.records.find((r) => r.tabId === tabId);
  }

  /** A copy of one record as stored, without a scan. */
  get(tabId: string): HostTabRecord | undefined {
    const r = this.find(tabId);
    return r ? { ...r } : undefined;
  }

  /** Apply one end to an open record. True when it changed something. */
  private applyEnd(tabId: string, exitCode: number, endedAt: number): boolean {
    const r = this.find(tabId);
    if (!r || r.endedAt !== undefined) return false;
    r.endedAt = endedAt;
    r.exitCode = exitCode;
    r.reason = classifyTabExit(exitCode);
    delete r.lostAt;
    return true;
  }

  /**
   * Take in the ends wrappers left on disk because their post got no answer.
   * Each file is removed once read, whether it named a record or not, so the
   * directory never grows. True when a record changed (the caller persists).
   */
  private async ingestLeftEnds(): Promise<boolean> {
    const dir = this.opts.endsDir;
    if (!dir) return false;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return false;
    }
    let changed = false;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      let parsed: LeftTabEnd | undefined;
      try {
        parsed = parseLeftTabEnd(JSON.parse(await readFile(path, 'utf8')));
      } catch {
        parsed = undefined;
      }
      try {
        await unlink(path);
      } catch {
        // Gone already, or not ours to remove: the next read tries again.
      }
      if (parsed && name === `${parsed.tabId}.json`) {
        changed =
          this.applyEnd(parsed.tabId, parsed.exitCode, parsed.endedAt) ||
          changed;
      }
    }
    if (changed) await this.persist();
    return changed;
  }

  /**
   * Scan every open record's pid, derive each state, note when an open
   * record's pid was first found gone, and prune. Persists when that changed
   * something, or always with `force` (a caller that changed a record itself).
   */
  private async scan(force = false): Promise<Map<string, HostTabState>> {
    const now = this.now();
    const bootId = await this.probe.bootId();
    const liveIds = new Set<string>();
    let changed = force;
    for (const r of this.records) {
      if (r.endedAt !== undefined) continue;
      let live = false;
      try {
        live = await isTabPidLive(r, this.probe, bootId);
      } catch {
        live = false;
      }
      if (live) {
        liveIds.add(r.tabId);
        if (r.lostAt !== undefined) {
          delete r.lostAt;
          changed = true;
        }
      } else if (r.lostAt === undefined) {
        r.lostAt = now;
        changed = true;
      }
    }
    const states = deriveTabStates(
      this.records,
      (r) => liveIds.has(r.tabId),
      now,
      this.opts.ghostGraceMs,
    );
    const kept = pruneTabs(this.records, states, now, {
      maxAgeMs: this.opts.maxAgeMs,
      cap: this.opts.cap,
    });
    if (kept.length !== this.records.length) {
      this.records = kept;
      changed = true;
    }
    if (changed) await this.persist();
    return states;
  }

  private views(states: Map<string, HostTabState>): HostTabView[] {
    return this.records.map((r) => ({
      ...r,
      state: states.get(r.tabId) ?? 'ghost',
      dismissed: r.dismissedAt !== undefined,
    }));
  }

  /** Every record with its state, newest first. */
  list(): Promise<HostTabView[]> {
    return this.serial(async () => {
      await this.ingestLeftEnds();
      const v = this.views(await this.scan());
      return v.sort((a, b) => b.startedAt - a.startedAt);
    });
  }

  /** One record with its state, or undefined. */
  async view(tabId: string): Promise<HostTabView | undefined> {
    return (await this.list()).find((v) => v.tabId === tabId);
  }

  /**
   * Open a record for a tab that just attached. A reopen asked of an earlier
   * record of the same conversation, not yet answered, is answered by this
   * one: it is linked both ways and this record notes how it came to be, so
   * the automatic reopen never reopens a tab it opened itself.
   */
  start(input: StartTabInput): Promise<HostTabRecord> {
    return this.serial(async () => {
      const now = this.now();
      const rec: HostTabRecord = {
        tabId: this.newId(),
        sessionId: input.sessionId,
        cwd: input.cwd,
        startedAt: now,
        pid: input.pid,
      };
      const [pidStart, bootId] = await Promise.all([
        this.probe.startTime(input.pid).catch(() => undefined),
        this.probe.bootId().catch(() => undefined),
      ]);
      if (pidStart !== undefined) rec.pidStart = pidStart;
      if (bootId !== undefined) rec.bootId = bootId;
      const asked = this.records
        .filter(
          (r) =>
            r.sessionId === input.sessionId &&
            r.reopenedAt !== undefined &&
            r.reopenedBy === undefined,
        )
        .sort((a, b) => (b.reopenedAt ?? 0) - (a.reopenedAt ?? 0))[0];
      if (asked) {
        asked.reopenedBy = rec.tabId;
        rec.origin =
          asked.autoReopenedAt !== undefined &&
          asked.autoReopenedAt === asked.reopenedAt
            ? 'auto_reopen'
            : 'reopen';
      }
      this.records.push(rec);
      await this.scan(true);
      // The scan may have pruned it only if the cap is full of live records.
      return { ...(this.find(rec.tabId) ?? rec) };
    });
  }

  /** Close a record with the wrapper's exit code. Undefined when there is no such record. */
  end(tabId: string, exitCode: number): Promise<HostTabView | undefined> {
    return this.serial(async () => {
      if (!this.find(tabId)) return undefined;
      const changed = this.applyEnd(tabId, exitCode, this.now());
      return this.views(await this.scan(changed)).find(
        (v) => v.tabId === tabId,
      );
    });
  }

  /** Keep the record, drop its badge. */
  dismiss(tabId: string): Promise<HostTabRecord | undefined> {
    return this.serial(async () => {
      const r = this.find(tabId);
      if (!r) return undefined;
      r.dismissedAt = this.now();
      await this.persist();
      return { ...r };
    });
  }

  /** Delete the record. True when there was one. */
  remove(tabId: string): Promise<boolean> {
    return this.serial(async () => {
      const before = this.records.length;
      this.records = this.records.filter((r) => r.tabId !== tabId);
      if (this.records.length === before) return false;
      await this.persist();
      return true;
    });
  }

  /** Note that a reopen was queued for this record; `auto` marks it as the automatic one. */
  noteReopen(tabId: string, auto: boolean): Promise<HostTabRecord | undefined> {
    return this.serial(async () => {
      const r = this.find(tabId);
      if (!r) return undefined;
      const now = this.now();
      r.reopenedAt = now;
      if (auto) r.autoReopenedAt = now;
      delete r.reopenedBy;
      await this.persist();
      return { ...r };
    });
  }
}
