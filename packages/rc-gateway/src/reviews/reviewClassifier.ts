/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';

/**
 * Security-critical, escalate-by-default classifier for remote reviews.
 *
 * A remote `/review` runs on the workstation under a per-review permission
 * policy. On each ACP `permission_request` the bridge (C.2) asks this pure
 * function whether the call may auto-approve or must be escalated to a human
 * vote. A false "approve" on the wrong call is a workstation-compromise path
 * (a prompt-injected diff can steer the reviewing agent), so the ONLY rule
 * that matters is: **when in any doubt, escalate.** It is always safe to
 * escalate a call; it is never safe to approve one we cannot prove safe.
 *
 * The permission frame carries the ACP `ToolCall` shape
 * `{ kind, title, rawInput }` and NO tool-name — so we key on `kind` plus
 * `rawInput`. See docs/superpowers/specs/2026-07-20-remote-review-design.md
 * "The permission bridge".
 *
 * Shell handling uses a PER-COMMAND FLAG ALLOWLIST, not a denylist: a denylist
 * cannot prove a flag safe, so any unrecognized flag ESCALATES. This closes
 * attacker-pointed OUT-OF-tree code loads (`--config`, `--manifest-path`,
 * `-f <makefile>`, `--init-script`, `-exec`, `--prefix`, …) which a denylist
 * would miss. `node:path` is used only for pure path math (no fs I/O), and
 * `node:os` only to name this process's home directory.
 */

export interface ReviewToolCall {
  kind?: string;
  title?: string;
  rawInput?: Record<string, unknown>;
}

export interface ReviewPolicy {
  /** false = vote mode: escalate everything. */
  autoApprove: boolean;
  autofix: boolean;
  /**
   * The review was asked to post to the PR. NOT an auto-approval input
   * (#169): the skill posts only through `qwen review submit`, which is not
   * on the allowlist, and every `gh` call escalates, so a PR write always
   * reaches a human whatever this says.
   */
  comment: boolean;
  /**
   * Absolute path of the review worktree. An `edit`/`write` under `autofix`
   * auto-approves ONLY if its target path resolves inside this root. `null`
   * (or a non-string) forces every edit to escalate. Wired by the bridge (C.2)
   * / saga (D.2).
   */
  worktreeRoot: string | null;
}

export type ReviewDecision = 'approve' | 'escalate';

/**
 * Only these characters may appear in an auto-approvable shell command.
 * Anything else forces escalation. The class is a LITERAL-space whitelist
 * (note: not `\s`, so tab and newline are excluded). It rejects every shell
 * metacharacter — `; & | $ \` < > ( ) { } ' " \ * ? ! ~ # % ^ + [ ] newline
 * tab` — which defeats substitution/redirection/chaining/globbing smuggling
 * like `git diff; rm -rf /`, `echo $(cat secret)`, or `` git diff `id` ``.
 */
const SAFE_SHELL_CHARS = /^[A-Za-z0-9 _\-./=:@,]+$/;

// ---------------------------------------------------------------------------
// Per-command flag allowlists. A command approves ONLY when every argument is
// either an allowed flag, an in-tree path value for a known path-flag, or an
// in-tree positional. Any unrecognized flag → escalate (fail-safe).
// ---------------------------------------------------------------------------

const GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'cat-file',
]);
// Small curated set of read-only git presentation flags. Anything unusual
// (e.g. --ext-diff/--output/-c/--pager/--exec-path/--upload-pack) escalates.
const GIT_FLAGS: ReadonlySet<string> = new Set([
  '--stat',
  '--numstat',
  '--shortstat',
  '--name-only',
  '--name-status',
  '--oneline',
  '--summary',
  '--patch',
  '-p',
  '--no-patch',
  '-s',
  '--short',
  '--no-color',
  '--cached',
  '--staged',
  '-w',
  '--unified',
  '-U',
]);

const NPM_SUBCOMMANDS: ReadonlySet<string> = new Set(['run', 'test']);
const NPM_FLAGS: ReadonlySet<string> = new Set();

const CARGO_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'build',
  'test',
  'check',
  'clippy',
]);
const CARGO_FLAGS: ReadonlySet<string> = new Set([
  '--release',
  '--all',
  '--workspace',
  '--all-features',
  '--no-default-features',
  '--locked',
  '--offline',
  '--frozen',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
]);

const GO_SUBCOMMANDS: ReadonlySet<string> = new Set(['build', 'test', 'vet']);
// NOTE: `-exec` deliberately absent (`go test -exec /evil` is arbitrary exec).
const GO_FLAGS: ReadonlySet<string> = new Set([
  '-v',
  '-race',
  '-short',
  '-cover',
  '-count',
  '-run',
  '-tags',
]);

const MAKE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'build',
  'test',
  'check',
]);
// NOTE: `-f`/`--file`/`--makefile` deliberately absent (points make at an
// arbitrary out-of-tree Makefile).
const MAKE_FLAGS: ReadonlySet<string> = new Set([
  '-j',
  '--jobs',
  '-s',
  '--silent',
  '-k',
]);

// mvn/gradle have no fixed subcommand set (they take goals/tasks). Reject
// out-of-tree-load flags (--init-script/-I/-b/-s/--settings/-c/-D/-P) by
// omission, and reject `group:artifact:goal` plugin coordinates via the
// colon-positional guard.
const MVN_GRADLE_FLAGS: ReadonlySet<string> = new Set([
  '--offline',
  '-o',
  '--quiet',
  '-q',
  '--no-daemon',
  '--batch-mode',
  '-B',
  '--stacktrace',
  '--info',
  '--console',
]);

// tsc is pinned: typecheck/emit-control flags plus `-p/--project <in-tree>`.
// Emit-path flags (--outFile/--outDir/--out/--declarationDir/…) are absent.
const TSC_FLAGS: ReadonlySet<string> = new Set([
  '--noEmit',
  '--noEmitOnError',
  '--pretty',
  '--strict',
  '--incremental',
  '--skipLibCheck',
  '--build',
  '-b',
]);
const TSC_PATH_FLAGS: ReadonlySet<string> = new Set(['-p', '--project']);

// The fork's review CLI subcommands the skill actually invokes.
const QWEN_REVIEW_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'fetch-pr',
  'cleanup',
]);
const QWEN_FLAGS: ReadonlySet<string> = new Set(['--remote']);

/** Split `--flag=value` into `[name, value]`; `[token, undefined]` if no `=`. */
function splitEq(t: string): [string, string | undefined] {
  const i = t.indexOf('=');
  return i === -1 ? [t, undefined] : [t.slice(0, i), t.slice(i + 1)];
}

/**
 * A path token that stays inside the (worktree-relative) tree: relative, with
 * no `..` path segment. Absolute paths and `..` traversal escalate.
 */
function isInTreePathToken(t: string): boolean {
  if (t.length === 0) return false;
  if (t.startsWith('/')) return false; // absolute
  if (t.split('/').includes('..')) return false; // traversal
  return true;
}

/**
 * Where an auto-approvable shell command runs. The shell tool executes in
 * `rawInput.directory` when one is given and in the workspace otherwise, so a
 * relative path token is read from `cwdAbs`, not necessarily from the root.
 * Both are null when the policy carries no worktree root (then nothing can be
 * resolved, and every check that needs a real location escalates).
 */
interface ShellContext {
  rootAbs: string | null;
  cwdAbs: string | null;
}

/**
 * Build the {@link ShellContext} for one call, or null (escalate) when the
 * call names a `directory` that cannot be proven to sit inside the worktree:
 * a non-string, any directory with no root to confine it against, one that
 * resolves outside the root, or one under a home directory's dotfiles. An
 * empty string means "the default", exactly as the shell tool reads it.
 */
function shellContext(
  directory: unknown,
  worktreeRoot: string | null,
): ShellContext | null {
  const rootAbs =
    typeof worktreeRoot === 'string' && worktreeRoot.length > 0
      ? resolve(worktreeRoot)
      : null;
  if (directory === undefined || directory === null || directory === '') {
    return { rootAbs, cwdAbs: rootAbs };
  }
  if (typeof directory !== 'string' || rootAbs === null) return null;
  const cwdAbs = resolve(rootAbs, directory);
  if (!isInsideRoot(rootAbs, cwdAbs)) return null;
  if (reachesHomeDotfile(rootAbs, cwdAbs)) return null;
  return { rootAbs, cwdAbs };
}

/**
 * The home directory's dot entry `abs` sits under (`/home/u/.ssh` for
 * `/home/u/.ssh/id_rsa`), or null when it is not under one. Homes are
 * `/home/<user>`, `/Users/<user>`, `/root` and this process's own home.
 */
function homeDotEntry(abs: string): string | null {
  const m =
    /^(\/(?:home|Users)\/[^/]+\/\.[^/]*)(?:\/|$)/.exec(abs) ??
    /^(\/root\/\.[^/]*)(?:\/|$)/.exec(abs);
  if (m) return m[1];
  const home = homedir();
  if (isAbsolute(home) && home !== '/' && abs.startsWith(home + '/')) {
    const first = abs.slice(home.length + 1).split('/')[0];
    if (first.startsWith('.')) return `${home}/${first}`;
  }
  return null;
}

/**
 * True when `abs` reaches into a home directory's dotfiles (`~/.ssh`, `~/.aws`,
 * `~/.qwen`, ...) from the workspace: that is, it sits under a home dot entry
 * that is NOT itself an ancestor of the root. A workspace that is the home
 * directory makes `~/.ssh` "in tree" by path math alone; this refuses it. A
 * clone that lives under `~/.local/src/repo` keeps its own files approvable.
 */
function reachesHomeDotfile(rootAbs: string, abs: string): boolean {
  const entry = homeDotEntry(abs);
  if (entry === null) return false;
  return !isInsideRoot(entry, rootAbs);
}

/**
 * A path token (positional or path-flag value) the command may read. A leading
 * `@` is a response file to tsc (which echoes each line back in a TS6231 error)
 * and to any script `npm run` passes it to, so it is a FILE READ: it needs a
 * known root and the path after the `@` must be in tree like any other. Every
 * path with a known location must also resolve inside the root and must not
 * reach a home directory's dotfiles.
 */
function isSafePathToken(t: string, ctx: ShellContext): boolean {
  let p = t;
  if (p.startsWith('@')) {
    if (ctx.rootAbs === null || ctx.cwdAbs === null) return false;
    p = p.slice(1);
  }
  if (!isInTreePathToken(p)) return false;
  if (ctx.rootAbs !== null && ctx.cwdAbs !== null) {
    const abs = resolve(ctx.cwdAbs, p);
    if (!isInsideRoot(ctx.rootAbs, abs)) return false;
    if (reachesHomeDotfile(ctx.rootAbs, abs)) return false;
  }
  return true;
}

interface ArgSpec {
  flags: ReadonlySet<string>;
  pathFlags?: ReadonlySet<string>;
  rejectColonPositional?: boolean;
}

/**
 * Validate the argument tail of an allowlisted command: allowed flags only,
 * in-tree path-flag values, in-tree positionals. Escalate on anything else.
 */
function validateShellArgs(
  tokens: string[],
  spec: ArgSpec,
  ctx: ShellContext,
): ReviewDecision {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      const [name, attached] = splitEq(t);
      if (spec.pathFlags?.has(name)) {
        const val = attached ?? tokens[++i];
        if (val === undefined || !isSafePathToken(val, ctx)) return 'escalate';
        continue;
      }
      if (spec.flags.has(name)) continue;
      return 'escalate';
    }
    // positional
    if (spec.rejectColonPositional && t.includes(':')) return 'escalate';
    if (!isSafePathToken(t, ctx)) return 'escalate';
  }
  return 'approve';
}

/**
 * A `mkdir` (the review skill's `mkdir -p <cwd>/.qwen/reviews`) auto-approves
 * ONLY when every target path resolves INSIDE the review worktree — the SAME
 * string-level confinement `classifyEdit` applies, so an empty-dir mutation can
 * no longer land out-of-tree (`mkdir -p /home/victim/.qwen/x` used to approve on
 * the mere presence of a `.qwen` segment). `worktreeRoot` null/empty → escalate
 * (cannot confine). The legitimate absolute (`<worktree>/.qwen/reviews`) and
 * relative (`.qwen/reviews`) forms both still approve.
 */
function classifyMkdir(argv: string[], ctx: ShellContext): ReviewDecision {
  const { rootAbs, cwdAbs } = ctx;
  if (rootAbs === null || cwdAbs === null) return 'escalate';
  const paths = argv.slice(1).filter((t) => !t.startsWith('-'));
  if (paths.length === 0) return 'escalate';
  for (const p of paths) {
    const segs = p.split('/');
    if (segs.includes('..')) return 'escalate'; // traversal escapes .qwen
    if (!segs.includes('.qwen')) return 'escalate'; // must be under a real .qwen
    // out-of-tree target (a relative path resolves from the shell directory)
    const abs = resolve(cwdAbs, p);
    if (!isInsideRoot(rootAbs, abs)) return 'escalate';
    if (hasGitSegment(abs)) return 'escalate'; // never under git metadata
  }
  return 'approve';
}

function classifyShell(
  rawInput: Record<string, unknown> | undefined,
  policy: ReviewPolicy,
): ReviewDecision {
  const command = rawInput?.['command'];
  if (typeof command !== 'string') return 'escalate';
  const trimmed = command.trim();
  if (trimmed.length === 0) return 'escalate';
  // Metacharacter gate on the raw string (before any tokenization).
  if (!SAFE_SHELL_CHARS.test(command)) return 'escalate';

  const argv = trimmed.split(/\s+/);
  const cmd = argv[0];
  if (cmd === undefined || cmd.length === 0) return 'escalate';

  // Every in-tree check below is relative to where the command runs.
  const ctx = shellContext(rawInput?.['directory'], policy.worktreeRoot);
  if (ctx === null) return 'escalate';

  switch (cmd) {
    // `gh` is never auto-approved (#169). Its one sanctioned use was posting
    // a PR review comment, and the shape of that call could not prove it
    // landed on the PR under review (`repos/attacker/x/pulls/1/comments`
    // approved). The bundled skill writes to the PR only through
    // `qwen review submit`, which is not on the allowlist either, so every
    // PR write reaches a human.
    case 'gh':
      return 'escalate';
    case 'mkdir':
      return classifyMkdir(argv, ctx);
    case 'git':
      if (!GIT_SUBCOMMANDS.has(argv[1])) return 'escalate';
      return validateShellArgs(argv.slice(2), { flags: GIT_FLAGS }, ctx);
    case 'npm':
    case 'pnpm':
    case 'yarn':
      if (!NPM_SUBCOMMANDS.has(argv[1])) return 'escalate';
      return validateShellArgs(argv.slice(2), { flags: NPM_FLAGS }, ctx);
    case 'cargo':
      if (!CARGO_SUBCOMMANDS.has(argv[1])) return 'escalate';
      return validateShellArgs(argv.slice(2), { flags: CARGO_FLAGS }, ctx);
    case 'go':
      if (!GO_SUBCOMMANDS.has(argv[1])) return 'escalate';
      return validateShellArgs(argv.slice(2), { flags: GO_FLAGS }, ctx);
    case 'make':
      if (!MAKE_SUBCOMMANDS.has(argv[1])) return 'escalate';
      return validateShellArgs(argv.slice(2), { flags: MAKE_FLAGS }, ctx);
    case 'mvn':
    case 'mvnw':
    case './mvnw':
    case 'gradle':
    case 'gradlew':
    case './gradlew':
      return validateShellArgs(
        argv.slice(1),
        { flags: MVN_GRADLE_FLAGS, rejectColonPositional: true },
        ctx,
      );
    case 'tsc':
      return validateShellArgs(
        argv.slice(1),
        { flags: TSC_FLAGS, pathFlags: TSC_PATH_FLAGS },
        ctx,
      );
    case 'qwen':
      if (argv[1] !== 'review') return 'escalate';
      if (!QWEN_REVIEW_SUBCOMMANDS.has(argv[2])) return 'escalate';
      return validateShellArgs(argv.slice(3), { flags: QWEN_FLAGS }, ctx);
    default:
      return 'escalate';
  }
}

// Every path-like field an `edit`/`write` (Kind.Edit) tool can carry:
// `edit`/`write_file` use `file_path`, `notebook_edit` uses `notebook_path`.
// `path`/`filePath`/`absolute_path` are included defensively so a divergent
// decoy field can never slip an out-of-tree write past confinement.
//
// Exported so the permission bridge (C.2) confines the SAME field set with its
// `fs.realpath` symlink check — the two layers must never drift (a field the
// classifier string-confines but the bridge does not realpath-verify would be a
// hole). See reviewPermissionBridge.ts Guard 2.
export const EDIT_PATH_FIELDS = [
  'file_path',
  'notebook_path',
  'path',
  'filePath',
  'absolute_path',
] as const;

/**
 * True when any segment of the absolute path `abs` is `.git` (compared
 * case-insensitively, for case-insensitive filesystems) (#169). Git metadata
 * is code, not content: an edit to `.git/config` (`core.fsmonitor`,
 * `diff.external`), to `.git/hooks/*`, or to a linked worktree's `.git`
 * pointer turns the next auto-approved `git status` / `git diff` into
 * arbitrary execution. Exported so the permission bridge applies the SAME rule
 * to the realpath'd target (an in-tree symlink alias hides the segment from
 * this string-level check).
 */
export function hasGitSegment(abs: string): boolean {
  return abs.split(/[\\/]/).some((s) => s.toLowerCase() === '.git');
}

/** True iff `p` resolves (string-level only) inside `rootAbs`. */
function isInsideRoot(rootAbs: string, p: string): boolean {
  const targetAbs = resolve(rootAbs, p);
  const rel = relative(rootAbs, targetAbs);
  if (rel.length === 0) return true; // path === root (degenerate, inside)
  if (isAbsolute(rel)) return false; // different filesystem root
  if (rel === '..' || rel.startsWith('..' + sep)) return false; // escapes
  return true;
}

/**
 * An `edit`/`write` under `autofix` may auto-approve ONLY when its target path
 * resolves inside the review worktree. EVERY present path field is confined —
 * not first-wins — so a divergent decoy (`{file_path:'src/a.ts',
 * path:'/etc/passwd'}`) cannot slip through. Escalate if no path field is
 * present, or if any present one is non-string/empty, resolves outside, or
 * has a `.git` segment (see {@link hasGitSegment}).
 *
 * SECURITY CAVEAT — STRING-LEVEL ONLY: this uses `path.resolve` and does NOT
 * resolve symlinks. A symlink committed *inside* the worktree (e.g.
 * `evil -> /home/user/.ssh/authorized_keys`) resolves "inside" by path math yet
 * the write follows it OUTSIDE the worktree. A pure function has no fs and
 * cannot detect this. The caller (the permission bridge, C.2) MUST
 * `fs.realpath`-verify the edit target — or its parent dir, for a
 * not-yet-existing file — against the realpath'd worktree root before honoring
 * an `approve` for an `edit`/write. The classifier alone does NOT guarantee the
 * write lands inside the worktree.
 */
function classifyEdit(
  rawInput: Record<string, unknown> | undefined,
  worktreeRoot: string | null,
): ReviewDecision {
  if (typeof worktreeRoot !== 'string' || worktreeRoot.length === 0) {
    return 'escalate';
  }
  const rootAbs = resolve(worktreeRoot);
  let sawPath = false;
  for (const key of EDIT_PATH_FIELDS) {
    const v = rawInput?.[key];
    if (v === undefined || v === null) continue; // field absent
    sawPath = true;
    if (typeof v !== 'string' || v.length === 0) return 'escalate';
    if (!isInsideRoot(rootAbs, v)) return 'escalate';
    // In tree but git metadata: a human decides (#169).
    if (hasGitSegment(resolve(rootAbs, v))) return 'escalate';
  }
  if (!sawPath) return 'escalate'; // no path to confine
  return 'approve';
}

/**
 * Classify a single review tool call into `approve` (auto-approve) or
 * `escalate` (human vote).
 *
 * TRUST BOUNDARY — this classifier trusts the INTEGRITY of `toolCall.kind`: the
 * daemon assigns it from each tool's registered `Kind` enum, NOT from the model
 * or the reviewed diff, so keying auto-approval on `kind` is sound. C.2 must
 * confirm this assumption holds for the frames it feeds in (a spoofable `kind`
 * would break the `read`/`search`-approve-on-kind-alone shortcut below).
 *
 * SECURITY CAVEAT — an `edit` approval is STRING-LEVEL path confinement only and
 * does NOT resolve symlinks; the bridge (C.2) MUST `fs.realpath`-verify the edit
 * target against the worktree root before honoring it. See `classifyEdit`.
 */
export function classifyReviewToolCall(
  toolCall: ReviewToolCall,
  policy: ReviewPolicy,
): ReviewDecision {
  // Vote mode: escalate everything — nothing auto-approves.
  if (!policy.autoApprove) return 'escalate';
  switch (toolCall.kind) {
    // read/search approve on `kind` alone with no payload inspection — safe
    // ONLY because the daemon sets `kind` from the tool's registered Kind (see
    // the trust-boundary note above), not from attacker-influenced input.
    case 'read':
    case 'search':
      return 'approve';
    case 'edit':
      return policy.autofix
        ? classifyEdit(toolCall.rawInput, policy.worktreeRoot)
        : 'escalate';
    case 'execute':
      return classifyShell(toolCall.rawInput, policy);
    case 'fetch': // exfiltration vector
    case 'other': // agent fanout / lsp / MCP — indistinguishable, escalate
    default:
      return 'escalate';
  }
}
