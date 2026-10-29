/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { NON_OWNER_WRITE_MASK } from './policy/permissions.js';

/**
 * Host actions (InfiniteInsight/Qwen-Code-Remote#192): a small, owner-written
 * list of programs on the gateway's host that the page can probe and start.
 *
 * The case that asked for it is the Windows tray launcher: when it is not
 * running, a conversation started from the phone never gets its terminal tab,
 * and nothing on the phone says why. The facility is generic rather than a
 * Windows special case, because what makes it work is only "run this argv and
 * read its exit code", and the WSL interop that lets the gateway reach
 * `powershell.exe` is the config's business, not this module's.
 *
 * The file maps a name to `{ label, status, start }`, where `status` and
 * `start` are argv arrays run through `execFile`, never a shell. A status argv
 * that exits 0 means running; anything else, a timeout included, means not.
 * The argv is taken from the file verbatim: the page only ever names an
 * action, it never supplies a program or an argument.
 */

/** What an action may be called: short, lowercase, URL-safe without escaping. */
export const HOST_ACTION_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The cap on a status probe. The list read waits on every probe, so this is
 * also how long the page can wait for the list.
 */
export const STATUS_TIMEOUT_MS = 10_000;

/**
 * The cap on a start. Longer than a probe because a start may bring something
 * up (the laptop's boot script also keeps the WSL distro alive) before it
 * returns, and the re-probe after it is a separate {@link STATUS_TIMEOUT_MS}.
 */
export const START_TIMEOUT_MS = 20_000;

/** Longest label accepted; it is drawn in a 390px row beside a button. */
const MAX_LABEL_LENGTH = 80;

export interface HostAction {
  readonly name: string;
  readonly label: string;
  readonly status: readonly string[];
  readonly start: readonly string[];
}

/**
 * Runs one argv with a time cap and reports how it exited. `code` is the exit
 * status, or null when there is none to report: killed on the cap, killed by
 * a signal, or never started at all. `error` is set only for that last case,
 * a program the OS could not spawn, and is the errno code (`ENOENT`,
 * `EACCES`): it is how a missing program differs from one that ran and failed
 * (#198). Injected so tests and the page harness never run a real program.
 */
export type HostActionRunner = (
  argv: readonly string[],
  timeoutMs: number,
) => Promise<{ code: number | null; error?: string }>;

/**
 * What a status probe found. `error` is present only when the probe program
 * could not be spawned, as `<errno>: <program basename>`: never the argv and
 * never a path, because the page and the audit log both show it.
 */
export interface HostActionProbe {
  running: boolean;
  error?: string;
}

export type HostActionStartOutcome =
  | { ok: true; running: boolean }
  | {
      ok: false;
      code: number | null;
      /** Set when the start program could not be spawned at all. */
      spawn?: { code: string; error: string };
    };

/**
 * Whether a bare program name resolves to an executable on `pathEnv`, the way
 * `execFile` would look it up. The gateway usually runs as a systemd user unit
 * whose PATH is not the login shell's, so a name that works at a prompt (a
 * WSL interop `powershell.exe`) can be missing here (#198).
 */
export async function findOnPath(
  program: string,
  pathEnv: string | undefined,
): Promise<boolean> {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    try {
      await access(join(dir, program), constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

/** The file is present but cannot be used; the message says why, in one line. */
export class HostActionsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostActionsConfigError';
  }
}

function argvOf(name: string, field: string, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HostActionsConfigError(
      `${name}.${field} must be a non-empty array of strings`,
    );
  }
  for (const part of raw) {
    if (typeof part !== 'string') {
      throw new HostActionsConfigError(
        `${name}.${field} must be a non-empty array of strings`,
      );
    }
  }
  if ((raw[0] as string).length === 0) {
    throw new HostActionsConfigError(`${name}.${field}[0] names no program`);
  }
  return [...(raw as string[])];
}

/**
 * Validate a parsed file. Strict on purpose: these argv are run on the host,
 * so a file that is not exactly the documented shape is refused whole rather
 * than half-loaded, and the error names the first thing wrong with it.
 */
export function parseHostActions(raw: unknown): HostAction[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HostActionsConfigError(
      'expected an object mapping action names to { label, status, start }',
    );
  }
  const out: HostAction[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!HOST_ACTION_NAME.test(name)) {
      throw new HostActionsConfigError(
        `action name ${JSON.stringify(name)} must match ${HOST_ACTION_NAME.source}`,
      );
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HostActionsConfigError(
        `${name} must be an object with label, status and start`,
      );
    }
    const v = value as Record<string, unknown>;
    const label = v['label'];
    if (
      typeof label !== 'string' ||
      label.trim().length === 0 ||
      label.length > MAX_LABEL_LENGTH
    ) {
      throw new HostActionsConfigError(
        `${name}.label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`,
      );
    }
    out.push({
      name,
      label,
      status: argvOf(name, 'status', v['status']),
      start: argvOf(name, 'start', v['start']),
    });
  }
  return out;
}

/**
 * The real runner, over `execFile`. It never rejects: a program that is
 * missing, refused or killed resolves with `code: null`, and one the OS could
 * not spawn also carries the errno as `error`.
 *
 * It settles on the child's `exit` rather than on `execFile`'s callback,
 * because the callback waits for the child's output pipes to close, and a
 * start argv exists to leave something running. If that program inherits the
 * pipes, the callback would not come until the cap killed the child, and a
 * start that worked would report as one that timed out. Our ends of the pipes
 * are dropped at exit for the same reason, which also lets `execFile` clear
 * its own timer instead of holding it until the inheritor exits.
 */
export const execFileRunner: HostActionRunner = (argv, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      resolve(error === undefined ? { code } : { code, error });
    };
    try {
      const child = execFile(
        argv[0]!,
        argv.slice(1),
        { timeout: timeoutMs, windowsHide: true },
        // Errors are read from the events below; the callback is required so
        // execFile collects (and bounds) output nobody reads.
        () => {},
      );
      child.once('error', (err) =>
        settle(null, (err as NodeJS.ErrnoException).code ?? 'ERROR'),
      );
      child.once('exit', (code) => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(typeof code === 'number' ? code : null);
      });
    } catch {
      // execFile throws synchronously on an argument it cannot pass (a NUL
      // byte, say); that is a program that never started.
      settle(null, 'ERR_SPAWN');
    }
  });

/**
 * The loaded actions plus the runner they go through. Read once at boot: an
 * edit to the file takes a gateway restart, the same as the other stores
 * under `~/.qwen/rc`.
 */
export class HostActions {
  /**
   * A start that has not finished, per action. A second press (a double tap,
   * or the phone and the laptop at once) joins the first rather than running
   * the start argv twice side by side.
   */
  private readonly starting = new Map<string, Promise<HostActionStartOutcome>>();

  private constructor(
    private readonly byName: ReadonlyMap<string, HostAction>,
    private readonly run: HostActionRunner,
  ) {}

  /** From an already-parsed file body. Throws {@link HostActionsConfigError}. */
  static fromConfig(
    raw: unknown,
    run: HostActionRunner = execFileRunner,
  ): HostActions {
    const actions = parseHostActions(raw);
    return new HostActions(new Map(actions.map((a) => [a.name, a])), run);
  }

  /**
   * Open the file at `path`. Resolves undefined when there is no file, which
   * is how a host without host actions says so. Throws
   * {@link HostActionsConfigError} when the file is there and unusable:
   * unreadable, not JSON, the wrong shape, or writable by group or world.
   *
   * The permission check refuses rather than warns (unlike the policy file's
   * advisory one) because this file is a list of programs the gateway runs on
   * a remote press: anyone who can write it can choose what the owner's phone
   * button executes.
   */
  static async open(
    path: string,
    run: HostActionRunner = execFileRunner,
  ): Promise<HostActions | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new HostActionsConfigError(
        `cannot read: ${(err as Error).message}`,
      );
    }
    let mode: number;
    try {
      mode = (await stat(path)).mode;
    } catch (err) {
      throw new HostActionsConfigError(
        `cannot stat: ${(err as Error).message}`,
      );
    }
    if ((mode & NON_OWNER_WRITE_MASK) !== 0) {
      const octal = (mode & 0o777).toString(8).padStart(3, '0');
      throw new HostActionsConfigError(
        `group/world-writable (mode 0${octal}); run: chmod go-w ${path}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new HostActionsConfigError(
        `not valid JSON: ${(err as Error).message}`,
      );
    }
    return HostActions.fromConfig(parsed, run);
  }

  /**
   * The boot path: {@link open}, with an unusable file reported as one log
   * line and treated as absent. A bad file must not stop the gateway, which
   * has nothing to do with the launcher being down, but the operator has to be
   * told why the row is missing from the page.
   */
  static async load(
    path: string,
    log: (line: string) => void,
    run: HostActionRunner = execFileRunner,
    pathEnv: string | undefined = process.env['PATH'],
  ): Promise<HostActions | undefined> {
    try {
      const store = await HostActions.open(path, run);
      if (store) {
        const names = store.list().map((a) => a.name);
        log(
          `host-actions: ${names.length} from ${path}` +
            (names.length ? ` (${names.join(', ')})` : ''),
        );
        await store.warnUnresolvable(path, log, pathEnv);
      }
      return store;
    } catch (err) {
      log(
        `host-actions: ${path} not loaded, the routes stay unmounted: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * One warning line per action whose status or start names a bare program
   * (no `/`) that is not on `pathEnv`. It does not resolve anything: the
   * operator fixes the file (an absolute path), the gateway never searches
   * for the program itself.
   */
  private async warnUnresolvable(
    file: string,
    log: (line: string) => void,
    pathEnv: string | undefined,
  ): Promise<void> {
    for (const a of this.byName.values()) {
      const missing: string[] = [];
      for (const prog of [a.status[0]!, a.start[0]!]) {
        if (prog.includes('/') || missing.includes(prog)) continue;
        if (!(await findOnPath(prog, pathEnv))) missing.push(prog);
      }
      if (missing.length === 0) continue;
      log(
        `host-actions: WARNING ${a.name}: ${missing.join(', ')} is not on the gateway's PATH ` +
          `(the unit's PATH does not include it), so this action will fail to spawn; ` +
          `use an absolute path in ${file}`,
      );
    }
  }

  /** Name and label of each action, in file order. */
  list(): Array<{ name: string; label: string }> {
    return [...this.byName.values()].map((a) => ({
      name: a.name,
      label: a.label,
    }));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Whether the action's program is running: its status argv exited 0. */
  async probe(name: string): Promise<boolean> {
    return (await this.check(name)).running;
  }

  /**
   * {@link probe} with the reason when the status program could not be
   * spawned, so a missing program reads as a failed probe rather than as
   * "not running".
   */
  async check(name: string): Promise<HostActionProbe> {
    const { code, error } = await this.runCapped(
      this.get(name).status,
      STATUS_TIMEOUT_MS,
    );
    return error === undefined
      ? { running: code === 0 }
      : { running: false, error: error.error };
  }

  /**
   * Run the start argv, then probe. A start that does not exit 0 is a failure
   * carrying its code, and is not probed: the program said it did not work.
   * A start that exits 0 reports what the probe then finds, so the caller
   * learns whether the thing is up rather than only that the script returned.
   */
  start(name: string): Promise<HostActionStartOutcome> {
    const action = this.get(name);
    const pending = this.starting.get(name);
    if (pending) return pending;
    const p = (async (): Promise<HostActionStartOutcome> => {
      const { code, error } = await this.runCapped(
        action.start,
        START_TIMEOUT_MS,
      );
      if (error !== undefined) {
        return { ok: false, code: null, spawn: error };
      }
      if (code !== 0) return { ok: false, code };
      return { ok: true, running: await this.probe(name) };
    })().finally(() => this.starting.delete(name));
    this.starting.set(name, p);
    return p;
  }

  private get(name: string): HostAction {
    const action = this.byName.get(name);
    if (!action) throw new RangeError(`unknown host action ${name}`);
    return action;
  }

  /**
   * The injected runner, held to its contract: a throw or a malformed answer
   * reads as "no exit code", so neither a probe nor a start can reject past
   * this point.
   */
  private async runCapped(
    argv: readonly string[],
    timeoutMs: number,
  ): Promise<{
    code: number | null;
    error?: { code: string; error: string };
  }> {
    try {
      const out = await this.run(argv, timeoutMs);
      const code = typeof out?.code === 'number' ? out.code : null;
      if (code === null && typeof out?.error === 'string') {
        // The errno code is cut to a plain token and the program to its
        // basename, so nothing from the argv's arguments or directories
        // reaches the page or the audit log.
        const errno =
          out.error.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'ERROR';
        const base = (argv[0] ?? '').split(/[\\/]/).pop()!.slice(0, 80);
        return { code, error: { code: errno, error: `${errno}: ${base}` } };
      }
      return { code };
    } catch {
      return { code: null };
    }
  }
}
