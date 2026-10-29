/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath, lstat, readFile, stat } from 'node:fs/promises';
import {
  resolve,
  dirname,
  basename,
  join,
  relative,
  isAbsolute,
  sep,
} from 'node:path';
import { selectAllowOnceOptionId } from '../permissionOptions.js';
import {
  classifyReviewToolCall,
  EDIT_PATH_FIELDS,
  hasGitSegment,
  type ReviewPolicy,
  type ReviewToolCall,
} from './reviewClassifier.js';

/**
 * SECURITY-CRITICAL: the enforcement point for a remote review's permission
 * policy. For each opened review session the bridge owns a DEDICATED
 * `subscribeEvents(sessionId, { lastEventId: 0 })` subscription — seeded at 0 to
 * force a full ring replay so no early `permission_request` is missed — and, on
 * each frame, either VOTES (auto-approve, one-time only) or ESCALATES (leaves the
 * permission pending for the owner). It NEVER sends a `cancelled` (deny) outcome:
 * a human decides deny. Escalate-by-default — anything we cannot prove safe is
 * escalated, never approved.
 *
 * Two enforcement layers sit in front of a vote:
 *
 *   1. The classifier (`classifyReviewToolCall`, C.1) — the first filter. It is a
 *      pure function keyed on `toolCall.kind` + `rawInput`, string-level path math
 *      only (no fs).
 *
 *   2. Guard 2 (below) — a SECOND gate layered only on `edit` approvals. After the
 *      classifier approves an `edit`, the bridge `fs.realpath`-verifies every
 *      target path field actually lands inside the worktree, defeating an in-tree
 *      symlink that points outside (which the string-level classifier cannot see).
 *      Guard 2b then refuses a real target in git metadata (`.git/`, a git dir
 *      under another name, a `.git` file's `gitdir:`), since writing it is code
 *      execution on the next auto-approved `git` command (#169).
 *
 * GUARD 3 — `kind` INTEGRITY (trust boundary, documented, no code needed):
 * The classifier auto-approves `read`/`search` on `toolCall.kind` ALONE. That is
 * sound ONLY because `kind` is assigned by the daemon from each tool's registered
 * `Kind` enum, NOT from the model or the reviewed diff. The `permission_request`
 * frames this bridge consumes originate from the daemon's ACP HTTP bridge
 * (`httpAcpBridge.ts`) over the same authenticated gateway↔daemon boundary as
 * every other daemon read — they are not model-controlled JSON. So a
 * prompt-injected diff cannot forge a benign `kind` to smuggle a dangerous call
 * past the on-kind-alone shortcut. If a future change ever let untrusted input set
 * `kind`, this assumption — and the read/search shortcut — would break; it holds
 * within the current trust model.
 */

/** Minimal structural view of DaemonClient the bridge needs. */
export interface ReviewBridgeDaemon {
  subscribeEvents(
    sessionId: string,
    opts?: { lastEventId?: number; signal?: AbortSignal },
  ): AsyncIterable<{ id?: number; type: string; data: unknown }>;
  respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: {
      outcome:
        | { outcome: 'selected'; optionId: string }
        | { outcome: 'cancelled' };
    },
  ): Promise<boolean>;
}

export interface ReviewBridgeDeps {
  daemon: ReviewBridgeDaemon;
  /** Called when a call is escalated (leave pending for a human vote). */
  onEscalate?: (sessionId: string, data: PermissionRequestData) => void;
  /** Called when tool output flows again (unblock). */
  onResume?: (sessionId: string) => void;
  /**
   * Observability hook for a swallowed error — a per-frame handler throw (e.g.
   * `respondToSessionPermission` rejecting on a daemon non-2xx) or a mid-stream
   * subscription throw before reconnect. Best-effort; a throwing `onError` is
   * itself ignored. The loop NEVER dies on either error class.
   */
  onError?: (sessionId: string, err: unknown) => void;
  /** Backoff between subscription reconnect attempts. Default 1000ms. */
  reconnectMs?: number;
  /** Injectable sleep so tests don't wait real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PermissionRequestData {
  requestId: string;
  sessionId: string;
  toolCall: ReviewToolCall;
  options: Array<{ optionId: string; kind: string }>;
}

export class ReviewPermissionBridge {
  private readonly loops = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  private readonly reconnectMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly deps: ReviewBridgeDeps) {
    this.reconnectMs = deps.reconnectMs ?? 1000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async open(sessionId: string, policy: ReviewPolicy): Promise<void> {
    if (this.loops.has(sessionId)) return;
    const abort = new AbortController();
    const done = this.run(sessionId, policy, abort.signal).catch(() => {});
    this.loops.set(sessionId, { abort, done });
  }

  /**
   * The dedicated per-review subscription loop. Its entire reason to exist is
   * RELIABLE escalation delivery (the owner is told a call is pending even when
   * not attached), so it must SELF-HEAL rather than die on the first hiccup:
   *
   *  - Per-frame isolation: a `handlePermission` throw (a vote HTTP rejecting on
   *    a daemon non-2xx/restart, etc.) is caught PER FRAME and logged — the loop
   *    continues, so a failed vote never silences a LATER frame's escalation.
   *  - Reconnect: a mid-stream throw from the subscription iterator itself
   *    (network blip / daemon restart) is caught and, after a bounded backoff,
   *    re-subscribed — resuming from the last-seen event id so already-processed
   *    frames are not re-delivered (no duplicate escalation notifications).
   *
   * Both loops terminate ONLY on `signal.aborted` (via `close()`/`closeAll()`) or
   * a clean end of the stream (session over). Modeled on
   * `packages/rc-gateway/src/webpush/pump.ts`'s `runLoop`.
   */
  private async run(
    sessionId: string,
    policy: ReviewPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    // 1-based event ids; seed 0 forces a FULL ring replay on the first subscribe
    // (closes the poll-latency gap). On reconnect we resume from the last id we
    // actually processed so we never re-deliver — and never re-notify — a frame.
    let lastSeenId = 0;
    while (!signal.aborted) {
      try {
        const it = this.deps.daemon.subscribeEvents(sessionId, {
          lastEventId: lastSeenId,
          signal,
        });
        for await (const ev of it) {
          if (signal.aborted) return;
          // Advance the resume cursor BEFORE handling, so a reconnect mid-handle
          // never re-processes this frame.
          if (typeof ev.id === 'number') lastSeenId = ev.id;
          if (ev.type === 'permission_request') {
            try {
              await this.handlePermission(
                sessionId,
                policy,
                ev.data as PermissionRequestData,
              );
            } catch (err) {
              // A vote/escalate handler throw must NEVER kill the loop: a later
              // frame that should escalate still must. Log and continue.
              this.reportError(sessionId, err);
            }
          } else {
            // Any tool-output / session_update frame → the tool proceeded.
            this.deps.onResume?.(sessionId);
          }
        }
        // Stream ended cleanly (session over / server closed the SSE). Done — we
        // only reconnect on an ERROR, never busy-loop a resubscribe on a clean
        // end.
        return;
      } catch (err) {
        if (signal.aborted) return;
        // Mid-stream subscription throw → backoff and reconnect from lastSeenId.
        this.reportError(sessionId, err);
      }
      if (signal.aborted) return;
      await this.sleep(this.reconnectMs);
    }
  }

  private reportError(sessionId: string, err: unknown): void {
    try {
      this.deps.onError?.(sessionId, err);
    } catch {
      // A throwing observability hook must never break the loop.
    }
  }

  private async handlePermission(
    sessionId: string,
    policy: ReviewPolicy,
    data: PermissionRequestData,
  ): Promise<void> {
    const toolCall = data.toolCall ?? ({} as ReviewToolCall);
    const decision = classifyReviewToolCall(toolCall, policy);
    if (decision === 'approve') {
      // GUARD 2 — symlink realpath confinement for `edit` approvals only.
      // The classifier confined the path at the STRING level (path.resolve, no
      // symlinks). Before honoring an edit approval we additionally realpath the
      // target to defeat an in-tree symlink pointing OUTSIDE the worktree (e.g. a
      // PR commits `evil -> ~/.ssh/authorized_keys`). If confinement cannot be
      // proven, escalate.
      const confined =
        toolCall.kind === 'edit'
          ? await this.confineEditRealpath(policy, toolCall)
          : true;
      if (confined) {
        // One-time approval ONLY. If no `allow_once` option is offered we refuse
        // to vote (never escalate a single call into a standing grant) and fall
        // through to escalation.
        const optionId = selectAllowOnceOptionId(data.options);
        if (optionId !== undefined) {
          await this.deps.daemon.respondToSessionPermission(
            sessionId,
            data.requestId,
            { outcome: { outcome: 'selected', optionId } },
          );
          return;
        }
      }
      // confined === false OR no allow_once → fall through to escalate.
    }
    // Escalate: leave the permission pending for the human; NEVER send cancelled.
    this.deps.onEscalate?.(sessionId, data);
  }

  /**
   * GUARD 2: realpath-verify EVERY present edit path field lands inside the
   * worktree. Returns true only if every field is provably in-tree; any
   * ambiguity (missing root, no path field, non-string field, fs error other
   * than a clean not-yet-existing file, a symlink escaping the tree) → false
   * (escalate). Reuses the SAME `EDIT_PATH_FIELDS` the classifier confines so the
   * two layers can never drift.
   */
  private async confineEditRealpath(
    policy: ReviewPolicy,
    toolCall: ReviewToolCall,
  ): Promise<boolean> {
    const worktreeRoot = policy.worktreeRoot;
    if (typeof worktreeRoot !== 'string' || worktreeRoot.length === 0) {
      return false;
    }
    // Realpath the ROOT too: mkdtemp/`/tmp` are often themselves symlinks, so
    // comparing against the raw root would false-positive (or false-negative).
    let realRoot: string;
    try {
      realRoot = await realpath(worktreeRoot);
    } catch {
      return false; // cannot verify the root → escalate
    }

    const rawInput = toolCall.rawInput;
    let sawPath = false;
    for (const key of EDIT_PATH_FIELDS) {
      const v = rawInput?.[key];
      if (v === undefined || v === null) continue; // field absent
      sawPath = true;
      if (typeof v !== 'string' || v.length === 0) return false;

      const target = resolve(worktreeRoot, v);
      // The real path the write lands on: the target's realpath, or for a new
      // file its realpath'd parent joined with the new name.
      let real: string;
      try {
        real = await realpath(target);
      } catch (err) {
        // ONLY a clean ENOENT may fall through to the parent dir (a genuinely
        // new file for write_file). EACCES / ELOOP / anything else is ambiguous
        // → escalate.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        // ENOENT is ALSO what a DANGLING symlink throws (final component is a
        // link whose destination does not exist yet). Trusting it as "new file"
        // would let write_file create the destination OUTSIDE the tree via the
        // link (e.g. create `~/.ssh/authorized_keys`). Distinguish with lstat:
        // if the path itself exists (as a link) it is NOT a plain new file →
        // escalate. Only when the final component truly does not exist do we
        // confine via its parent directory.
        const existsAsLink = await lstat(target).then(
          () => true,
          () => false,
        );
        if (existsAsLink) return false; // dangling symlink → escalate
        try {
          real = join(await realpath(dirname(target)), basename(target));
        } catch {
          return false; // parent unresolvable → escalate
        }
      }
      if (!isInside(realRoot, real)) return false;
      // GUARD 2b (#169): in tree is not enough when the real target is git
      // metadata. Judged on the REAL path, so an in-tree symlink alias of
      // `.git/config` or `.git/hooks` escalates like the plain path does.
      if (await touchesGitMetadata(realRoot, real)) return false;
    }
    if (!sawPath) return false; // no path field to confine → escalate
    return true;
  }

  close(sessionId: string): void {
    const loop = this.loops.get(sessionId);
    if (!loop) return;
    loop.abort.abort();
    this.loops.delete(sessionId);
  }

  closeAll(): void {
    for (const sid of [...this.loops.keys()]) this.close(sid);
  }

  /** Test helper: await the subscription loop draining a finite fake stream. */
  async drain(sessionId: string): Promise<void> {
    await this.loops.get(sessionId)?.done;
  }
}

/**
 * GUARD 2b (#169): true when the real write target `real` lands in git
 * metadata, so the edit must go to a human. Writing git metadata is code
 * execution, not an edit: `.git/config` (`core.fsmonitor`, `diff.external`)
 * or `.git/hooks/*` runs on the next auto-approved `git status` / `git diff`,
 * and a `.git` file decides which git dir a worktree uses. True when:
 *
 *  - the real path has a `.git` segment (the classifier's own rule, on the
 *    path the write actually reaches); or
 *  - a directory between the target and the root is one git would accept as
 *    a git dir (a `HEAD` plus `objects` or `commondir`), whatever it is named,
 *    e.g. a `--separate-git-dir` store inside the workspace; or
 *  - a `.git` file on that path points (`gitdir: ...`) at a directory the
 *    target is inside, even one not complete enough to pass the test above; or
 *  - anything on the way cannot be inspected (an unreadable `.git` file, an fs
 *    error other than "not there"): escalate rather than guess.
 */
async function touchesGitMetadata(
  realRoot: string,
  real: string,
): Promise<boolean> {
  if (hasGitSegment(real)) return true;
  try {
    for (let dir = dirname(real); isInside(realRoot, dir); dir = dirname(dir)) {
      if (await looksLikeGitDir(dir)) return true;
      const pointed = await gitdirOf(dir);
      if (pointed === 'unreadable') return true;
      if (pointed !== null && isInside(pointed, real)) return true;
      if (dir === realRoot) break;
    }
  } catch {
    return true;
  }
  return false;
}

/** git's own git-dir test (setup.c): a `HEAD` plus `objects` or `commondir`. */
async function looksLikeGitDir(dir: string): Promise<boolean> {
  if (!(await exists(join(dir, 'HEAD')))) return false;
  return (
    (await exists(join(dir, 'objects'))) ||
    (await exists(join(dir, 'commondir')))
  );
}

/**
 * The real git dir that `dir/.git` designates: the `.git` directory itself, or
 * the `gitdir:` target of a `.git` file, resolved relative to `dir` as git
 * does. null when there is no `.git` entry; `unreadable` when one exists but
 * cannot be resolved to a git dir (a dangling link, a file with no `gitdir:`
 * line), which the caller escalates.
 */
async function gitdirOf(dir: string): Promise<string | null | 'unreadable'> {
  const dotGit = join(dir, '.git');
  if (!(await exists(dotGit, { follow: false }))) return null;
  let st;
  try {
    st = await stat(dotGit);
  } catch {
    return 'unreadable'; // a dangling `.git` symlink
  }
  if (st.isDirectory()) return realpath(dotGit);
  if (!st.isFile()) return 'unreadable';
  const firstLine = (await readFile(dotGit, 'utf8')).split('\n', 1)[0];
  const m = /^gitdir:\s*(.+?)\s*$/.exec(firstLine);
  if (!m) return 'unreadable';
  const target = resolve(dir, m[1]);
  try {
    return await realpath(target);
  } catch (err) {
    // A pointer to a git dir that does not exist yet still claims the path.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return target;
    throw err;
  }
}

/**
 * Whether `p` exists. "Not there" (ENOENT, ENOTDIR) is false; any other error
 * throws, so the caller escalates instead of reading it as absent.
 */
async function exists(
  p: string,
  opts: { follow: boolean } = { follow: true },
): Promise<boolean> {
  try {
    await (opts.follow ? stat(p) : lstat(p));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

/** True iff realpath'd `p` is the root itself or a descendant of it. */
function isInside(realRoot: string, p: string): boolean {
  const rel = relative(realRoot, p);
  if (rel.length === 0) return true; // p === root (degenerate, inside)
  if (isAbsolute(rel)) return false; // different filesystem root
  if (rel === '..' || rel.startsWith('..' + sep)) return false; // escapes
  return true;
}
