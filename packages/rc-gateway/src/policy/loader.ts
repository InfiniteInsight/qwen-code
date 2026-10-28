/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

export type PolicyAction = 'allow' | 'deny' | 'prompt';

export interface PolicyRuleMatch {
  tool?: string;
  argsGlob?: string | string[];
  pathGlob?: string | string[];
  operation?: string | string[];
  originScope?: string;
  sessionTag?: string;
  // Deferred (parsed, not evaluated this cycle):
  timeOfDay?: unknown;
}

export interface PolicyRule {
  id?: string;
  match: PolicyRuleMatch;
  action: PolicyAction;
  requireScope?: string;
  reason?: string;
  priority?: number;
  /** Per-rule rolling-window rate limit (cycle 43): at most `count` per `windowSec`. */
  maxPerWindow?: { count: number; windowSec: number };
  /**
   * Set ONLY when `match.tool` was written as a tool NAME (e.g.
   * `run_shell_command`) and normalized at load to its ACP kind (e.g.
   * `execute`). Absent when `match.tool` was already a kind, a wildcard, or
   * omitted. Lets `policy lint` warn precisely about ALLOW rules
   * whose tool-name alias widens beyond what was written, without
   * substring-searching the source text.
   */
  aliasedTool?: string;
  /**
   * `'workspace'` on a rule that came from `<cwd>/.qwen/policy.yaml`. Set ONLY
   * by {@link mergePolicies}, never parsed from YAML ({@link loadPolicy} builds
   * each rule field by field, so a `layer:` key in a file is ignored). The
   * evaluator decides each layer separately and lets a workspace decision win
   * only when it is STRICTER than the user one (issue #156).
   */
  layer?: 'workspace';
  // Deferred (parsed, not evaluated this cycle):
  expiresAt?: unknown;
}

export interface Policy {
  version?: number;
  defaults: { action: PolicyAction; requireScope?: string };
  rules: PolicyRule[];
}

/** Thrown when a policy document fails schema validation. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

const ACTIONS: readonly PolicyAction[] = ['allow', 'deny', 'prompt'];

/** ACP kinds a rule's `tool` may name. */
export const POLICY_KINDS = [
  'read',
  'search',
  'edit',
  'execute',
  'fetch',
  'other',
] as const;

/**
 * Tool-name → ACP kind. The permission frame carries only a kind, so a rule
 * naming a tool is normalized to that tool's kind at load.
 *
 * The mapping is LOSSY and widening: `write_file` and `edit` share `edit`, so a
 * rule naming one also matches the other. For `deny` that is safe; for `allow`
 * it grants more than written — `policy lint` warns about it.
 */
export const TOOL_ALIAS_TO_KIND: Record<string, string> = {
  read_file: 'read',
  grep_search: 'search',
  glob: 'search',
  list_directory: 'search',
  ripGrep: 'search',
  write_file: 'edit',
  edit: 'edit',
  run_shell_command: 'execute',
  web_fetch: 'fetch',
  agent: 'other',
  task: 'other',
  lsp: 'other',
};

export const POLICY_OPERATIONS = ['read', 'write', 'execute'] as const;

/**
 * Normalize a rule's `match.tool` (kind, wildcard glob, or known tool NAME)
 * to the form the evaluator matches against; throws {@link PolicyError} on
 * an unknown value. Exported so the permission-overlay route (issue #33)
 * validates operator-supplied tools with the SAME fail-closed rules the
 * YAML loader applies.
 */
export function normalizeTool(raw: string, ruleRef: string): string {
  if (raw === '*' || raw.includes('*')) return raw; // globs pass through
  if ((POLICY_KINDS as readonly string[]).includes(raw)) return raw;
  const mapped = TOOL_ALIAS_TO_KIND[raw];
  if (mapped) return mapped;
  throw new PolicyError(
    `${ruleRef}: unknown tool '${raw}'. The permission frame carries only an ` +
      `ACP kind, so use one of ${POLICY_KINDS.join(' | ')} (or a known tool ` +
      `name, which is mapped to its kind).`,
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAction(v: unknown): v is PolicyAction {
  return typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);
}

/**
 * Validate a rule's `maxPerWindow` into a typed `{ count, windowSec }`
 * (FAIL-CLOSED — a malformed quota blocks boot, like every other policy schema
 * error): `count` a non-negative integer, `windowSec` a positive integer. Unknown
 * sub-keys are ignored (forward-compat).
 */
function parseMaxPerWindow(
  raw: unknown,
  i: number,
): { count: number; windowSec: number } {
  if (!isPlainObject(raw)) {
    throw new PolicyError(
      `rule[${i}].maxPerWindow must be a mapping { count, windowSec }`,
    );
  }
  const count = raw['count'];
  const windowSec = raw['windowSec'];
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new PolicyError(
      `rule[${i}].maxPerWindow.count must be a non-negative integer`,
    );
  }
  if (
    typeof windowSec !== 'number' ||
    !Number.isInteger(windowSec) ||
    windowSec <= 0
  ) {
    throw new PolicyError(
      `rule[${i}].maxPerWindow.windowSec must be a positive integer`,
    );
  }
  return { count, windowSec };
}

/**
 * Parse and validate a policy YAML document. Throws {@link PolicyError} when
 * the doc is not a plain object, when `defaults.action` (if present) is not an
 * allowed action, or when any rule is not an object / lacks an object `match` /
 * has an action not in {allow,deny,prompt}. Unknown fields are ignored
 * (forward-compat). The returned `defaults` is filled with
 * `{ action:'prompt', requireScope:'approve' }` when omitted.
 */
export function loadPolicy(text: string): Policy {
  return parsePolicyDocument(text).policy;
}

/**
 * {@link loadPolicy}'s validator, also reporting whether the document declared
 * a `defaults` block (the returned policy always has one, filled in when
 * omitted), so the workspace bounds check can report an ignored block.
 */
function parsePolicyDocument(text: string): {
  policy: Policy;
  declaresDefaults: boolean;
} {
  const doc = parse(text) ?? {};
  if (!isPlainObject(doc)) {
    throw new PolicyError('policy document must be a mapping');
  }

  const defaultsRaw = doc['defaults'];
  let defaultsObj: Record<string, unknown> = {};
  if (defaultsRaw !== undefined) {
    if (!isPlainObject(defaultsRaw)) {
      throw new PolicyError('defaults must be a mapping');
    }
    defaultsObj = defaultsRaw;
  }
  const defaultAction = defaultsObj['action'] ?? 'prompt';
  if (!isAction(defaultAction)) {
    throw new PolicyError(
      `defaults.action must be allow/deny/prompt (got ${String(defaultAction)})`,
    );
  }
  const defaultScope =
    defaultsObj['requireScope'] === undefined
      ? 'approve'
      : String(defaultsObj['requireScope']);

  const rulesRaw = doc['rules'] ?? [];
  if (!Array.isArray(rulesRaw)) {
    throw new PolicyError('rules must be a sequence');
  }

  const rules: PolicyRule[] = rulesRaw.map((raw, i) => {
    if (!isPlainObject(raw)) {
      throw new PolicyError(`rule[${i}] must be a mapping`);
    }
    if (!isPlainObject(raw['match'])) {
      throw new PolicyError(`rule[${i}].match must be a mapping`);
    }
    if (!isAction(raw['action'])) {
      throw new PolicyError(
        `rule[${i}].action must be allow/deny/prompt (got ${String(raw['action'])})`,
      );
    }
    const match = raw['match'] as Record<string, unknown>;

    // Normalize a tool NAME (e.g. `run_shell_command`) to its ACP kind (e.g.
    // `execute`) — the permission frame carries only a kind, never a tool
    // name. Wildcards pass through untouched. Fail-closed on an unknown value.
    let originalTool: string | undefined;
    let normalizedTool: string | undefined;
    if (typeof match['tool'] === 'string') {
      originalTool = match['tool'];
      normalizedTool = normalizeTool(originalTool, `rule[${i}]`);
      match['tool'] = normalizedTool;
    }

    // match.operation: a single op or a list, each one of POLICY_OPERATIONS.
    const operationRaw = match['operation'];
    if (operationRaw !== undefined) {
      const list = Array.isArray(operationRaw) ? operationRaw : [operationRaw];
      for (const o of list) {
        if (
          typeof o !== 'string' ||
          !(POLICY_OPERATIONS as readonly string[]).includes(o)
        ) {
          throw new PolicyError(
            `rule[${i}].match.operation must be one of ` +
              `${POLICY_OPERATIONS.join(' | ')} (or a list of them)`,
          );
        }
      }
    }

    const rule: PolicyRule = {
      match: match as PolicyRuleMatch,
      action: raw['action'],
    };
    // Remember that this rule was WRITTEN as a tool-name alias (not a kind),
    // so lint can warn precisely instead of substring-searching the source
    // text.
    if (
      originalTool !== undefined &&
      normalizedTool !== undefined &&
      normalizedTool !== originalTool
    ) {
      rule.aliasedTool = originalTool;
    }
    if (raw['id'] !== undefined) rule.id = String(raw['id']);
    if (raw['requireScope'] !== undefined) {
      rule.requireScope = String(raw['requireScope']);
    }
    if (raw['reason'] !== undefined) rule.reason = String(raw['reason']);
    if (typeof raw['priority'] === 'number') rule.priority = raw['priority'];
    // maxPerWindow: validated into a typed { count, windowSec } (fail-closed).
    // It is now HONORED at runtime by the enforcer's quota store (cycle 43), so it
    // is no longer a "deferred" field. expiresAt is evaluated (cycle 22).
    if (raw['maxPerWindow'] !== undefined) {
      rule.maxPerWindow = parseMaxPerWindow(raw['maxPerWindow'], i);
    }
    if (raw['expiresAt'] !== undefined) rule.expiresAt = raw['expiresAt'];

    return rule;
  });

  // Reject duplicate rule ids (fail-closed): ids key the audit trail AND the quota
  // store, so a collision would make `ruleId`/quota ambiguous — almost certainly a
  // config mistake. (cycle 43)
  const seenIds = new Set<string>();
  for (const r of rules) {
    if (r.id === undefined) continue;
    if (seenIds.has(r.id)) {
      throw new PolicyError(`duplicate rule id: ${r.id}`);
    }
    seenIds.add(r.id);
  }

  const policy: Policy = {
    defaults: { action: defaultAction, requireScope: defaultScope },
    rules,
  };
  if (typeof doc['version'] === 'number') policy.version = doc['version'];
  return { policy, declaresDefaults: defaultsRaw !== undefined };
}

/** A policy file's text, or `null` when it is absent (ENOENT). */
async function readPolicyText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Load and validate a policy file. Returns `null` when the file is absent
 * (ENOENT) so callers can fall back to pure default-prompt behavior; otherwise
 * delegates to {@link loadPolicy} (which may throw {@link PolicyError}).
 */
export async function loadPolicyFile(path: string): Promise<Policy | null> {
  const text = await readPolicyText(path);
  return text === null ? null : loadPolicy(text);
}

/**
 * The workspace layer's bounds (issue #156). The workspace file can arrive
 * with a cloned repo, or the model can write it with its own edit tool and the
 * gateway hot-reloads it, so it is untrusted: it may only NARROW the user
 * policy. It may add `deny` and `prompt` rules; it may not `allow` (that could
 * only widen) and may not set `defaults` (only the user file sets the fallback).
 * Priority is not a bound: the evaluator orders rules by priority only within
 * a layer, so a workspace priority cannot outrank a user rule.
 */
function isWithinWorkspaceBounds(rule: PolicyRule): boolean {
  return rule.action !== 'allow';
}

/** Result of {@link loadWorkspacePolicy}. */
export interface WorkspacePolicyLoad {
  /** The file as written (validated, not yet narrowed). */
  policy: Policy;
  /**
   * One line per part of the file that exceeds the workspace bounds and is
   * ignored at load. Empty when the file is within bounds.
   */
  violations: string[];
}

/**
 * Parse a workspace policy file with the SAME validator as {@link loadPolicy}
 * (throws {@link PolicyError} on a malformed file) and report every part that
 * exceeds the workspace bounds. {@link mergePolicies} drops those parts; this
 * function only names them, so the load path can log them and `policy lint`
 * can fail on them, rather than clamping silently.
 */
export function loadWorkspacePolicy(text: string): WorkspacePolicyLoad {
  const { policy, declaresDefaults } = parsePolicyDocument(text);
  const violations: string[] = [];
  if (declaresDefaults) {
    violations.push(
      `'defaults': only the user policy sets the fallback action`,
    );
  }
  policy.rules.forEach((rule, i) => {
    if (isWithinWorkspaceBounds(rule)) return;
    violations.push(
      `rule '${rule.id ?? `[${i}]`}' (${rule.action}): a workspace policy ` +
        `may only add deny or prompt rules`,
    );
  });
  return { policy, violations };
}

/**
 * `true` when `path` is where the gateway looks for a workspace policy
 * (`<cwd>/.qwen/policy.yaml`). The user file lives at `~/.qwen/rc/policy.yaml`,
 * so it never matches.
 */
function isWorkspacePolicyPath(path: string): boolean {
  const abs = resolve(path);
  return basename(abs) === 'policy.yaml' && basename(dirname(abs)) === '.qwen';
}

/** The fail-closed fallback when no user policy.yaml exists: prompt everything. */
const DEFAULT_PROMPT_POLICY: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [],
};

/**
 * Merge a workspace policy over a user policy. The workspace layer can only
 * NARROW (issue #156; it is untrusted, see {@link isWithinWorkspaceBounds}):
 *
 * - Workspace `allow` rules are DROPPED. The rest are tagged
 *   `layer: 'workspace'` and prepended (D1: earlier index still breaks ties
 *   between workspace rules).
 * - The evaluator decides the two layers SEPARATELY and the workspace decision
 *   wins only when it is stricter (deny > prompt > allow), so no workspace
 *   `priority` can outrank a user rule, a workspace `prompt` cannot soften a
 *   user `deny`, and a workspace `deny`/`prompt` still tightens a user `allow`
 *   or the user default.
 * - The user `defaults` are kept; a workspace `defaults` block is IGNORED (D3),
 *   so a workspace file cannot flip the fallback action.
 *
 * `workspace === null` returns `user` UNCHANGED, so a workspace-less boot is
 * byte-identical. Pure: callers that read the file use
 * {@link loadWorkspacePolicy} to name what this drops, and log it.
 */
export function mergePolicies(workspace: Policy | null, user: Policy): Policy {
  if (!workspace) return user;
  const workspaceRules = workspace.rules
    .filter(isWithinWorkspaceBounds)
    .map((rule): PolicyRule => ({ ...rule, layer: 'workspace' }));
  return {
    defaults: user.defaults,
    rules: [...workspaceRules, ...user.rules],
  };
}

/**
 * Log keyword emitted when the user-scope policy file is group- or
 * world-readable (mode bits 0o044). Workspace policy files never trigger this
 * warning — only the file that holds the operator's personal tool-permission
 * rules is flagged.
 */
export const POLICY_PERMISSIONS_WARNING_KEYWORD = 'policy_permissions_warning';

/**
 * Group-read (0o040) | world-read (0o004). A group/world-readable policy file
 * leaks the operator's personal tool-permission rules (which tools are allowed,
 * denied, or rate-limited) to any account in the file's group or to any user on
 * the system. We warn once per load so the operator can tighten the permissions.
 */
const NON_OWNER_READ_MASK = 0o044;

/**
 * Best-effort check: is the user-scope policy file group- or world-readable?
 * Returns the mode (permission bits only) when yes, `null` when no or on any
 * stat error (missing file is normal, non-fatal).
 */
async function checkUserPolicyReadable(
  userPath: string,
): Promise<number | null> {
  try {
    const { mode } = await stat(userPath);
    return (mode & NON_OWNER_READ_MASK) !== 0 ? mode & 0o7777 : null;
  } catch {
    return null;
  }
}

/**
 * Load the user policy and, when a workspace cwd is given, the workspace override
 * `<workspaceCwd>/.qwen/policy.yaml`, then merge via {@link mergePolicies} (the
 * workspace layer can only narrow). Every part of the workspace file that
 * exceeds its bounds (an `allow` rule, a `defaults` block) is logged via `warn`
 * on every load, boot and hot-reload alike, and dropped. The user
 * file is loaded with cycle-14 semantics UNCHANGED: absent (ENOENT) → the
 * default-prompt policy; malformed → THROWS {@link PolicyError} (boot fails — a
 * malformed user policy must not be silently downgraded). The WORKSPACE layer is
 * fail-CLOSED: by default a malformed or unreadable workspace file is logged via
 * `warn` and IGNORED (keep the user policy — never apply unparseable `allow`s,
 * never crash boot). So at boot this function throws ONLY on a malformed user
 * file. `warn` defaults to a no-op (the CLI passes a `console.warn` wrapper).
 *
 * Readability warning (spec-alignment): emits a `policy_permissions_warning` log
 * line (via `warn`) when the user-scope file is group- or world-readable.
 * Workspace policy files DO NOT trigger this warning — only the user-scope file
 * holds personal tool-permission data. The check is best-effort and never throws.
 *
 * **`strictWorkspace` (cycle 45, for HOT-RELOAD):** when true, a malformed/
 * unreadable workspace file THROWS instead of being silently dropped. At boot,
 * dropping a bad workspace layer is right (no previous ruleset to keep, must not
 * crash). At RELOAD, silently dropping it would WIDEN permissions (workspace
 * rules that shadowed user `allow`s vanish) and mis-report success — so the
 * caller wants the error to propagate, retain the previous ruleset, and audit a
 * failure. A workspace file that is merely ABSENT (ENOENT) still resolves to
 * `null` (no throw) in both modes — a deleted workspace file is an intended
 * removal of the layer, not a parse error.
 */
export async function loadLayeredPolicy(
  userPath: string,
  workspaceCwd: string | undefined,
  warn: (msg: string) => void = () => {},
  opts: { strictWorkspace?: boolean } = {},
): Promise<Policy> {
  const user = (await loadPolicyFile(userPath)) ?? DEFAULT_PROMPT_POLICY;
  // Readability warning: emitted once per load for the user-scope file only.
  const readableMode = await checkUserPolicyReadable(userPath);
  if (readableMode !== null) {
    const octal = readableMode.toString(8).padStart(3, '0');
    warn(
      `${POLICY_PERMISSIONS_WARNING_KEYWORD}: ${userPath} is group/world-readable (mode 0${octal}) — ` +
        `anyone who can read this file can see which tools are allowed or denied; ` +
        `run: chmod go-r ${userPath}`,
    );
  }
  let workspace: Policy | null = null;
  let violations: string[] = [];
  if (workspaceCwd) {
    try {
      // readPolicyText returns null for ENOENT (absent); loadWorkspacePolicy
      // throws only for a malformed file.
      const text = await readPolicyText(
        join(workspaceCwd, '.qwen', 'policy.yaml'),
      );
      if (text !== null) {
        ({ policy: workspace, violations } = loadWorkspacePolicy(text));
      }
    } catch (err) {
      if (opts.strictWorkspace) throw err; // reload: retain the previous ruleset
      warn(
        `[policy] ignoring workspace policy.yaml: ${(err as Error).message}`,
      );
      workspace = null;
    }
  }
  // An out-of-bounds part is dropped, never applied, so even at reload it is
  // logged rather than thrown: narrowing is already the safe outcome.
  for (const v of violations) {
    warn(`[policy] workspace policy.yaml: ignoring ${v}`);
  }
  return mergePolicies(workspace, user);
}

/** Result of {@link lintPolicyFile}: a daemon-free schema check of one file. */
export interface PolicyLintResult {
  ok: boolean;
  /** Number of rules (valid files only). */
  ruleCount?: number;
  /**
   * Rule id (or `[index]`) of each rule that uses a NOT-YET-EVALUATED field
   * (would downgrade to prompt at runtime). As of cycle 43 every policy field is
   * honored (maxPerWindow joined timeOfDay/expiresAt), so this is currently always
   * empty — kept as a forward-compat hook for any field a future cycle defers.
   */
  deferred?: string[];
  /**
   * Advisory-only messages from {@link policyAdvisories} (valid files only):
   * ALLOW rules whose tool-name alias widens beyond what was written, plus a
   * once-per-load note that every ALLOW rule is newly effective this release.
   * Never affects `ok`/load outcome — advisory, not validation.
   */
  warnings?: string[];
  /**
   * Workspace files only: each part that exceeds the workspace bounds and that
   * the gateway ignores at load (see {@link loadWorkspacePolicy}). Non-empty
   * makes `ok` false: the file would not take effect as written.
   */
  violations?: string[];
  /** Human-readable reason (invalid files only). */
  error?: string;
}

/** Kinds reachable from more than one tool name — aliasing to them widens. */
function kindsWithMultipleTools(): Set<string> {
  const counts = new Map<string, number>();
  for (const kind of Object.values(TOOL_ALIAS_TO_KIND)) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k));
}

/**
 * Advisory warnings, not errors:
 * 1. An `allow` rule written with a tool-name alias whose kind covers other
 *    tools grants MORE than it says (e.g. `allow write_file` also allows
 *    `edit`) — the one unsafe corner of accepting aliases.
 * 2. Matching is being fixed in this release, so every `allow` rule becomes
 *    effective for the first time. Say so once, with a count.
 *
 * Advisory only: never throws, never changes a load outcome, never alters an
 * evaluation decision. A file that loads today still loads.
 */
export function policyAdvisories(policy: Policy): string[] {
  const out: string[] = [];
  const shared = kindsWithMultipleTools();

  for (const rule of policy.rules) {
    if (rule.action !== 'allow') continue;
    // `aliasedTool` is set by the loader ONLY when this rule was written as a
    // tool name — precise, unlike scanning the raw file text.
    const written = rule.aliasedTool;
    if (written === undefined) continue;
    const kind = rule.match.tool;
    if (kind === undefined || !shared.has(kind)) continue;
    const siblings = Object.keys(TOOL_ALIAS_TO_KIND).filter(
      (n) => TOOL_ALIAS_TO_KIND[n] === kind && n !== written,
    );
    out.push(
      `rule '${rule.id ?? '(unnamed)'}': allow on '${written}' maps to kind ` +
        `'${kind}', which also matches ${siblings.join(', ')} — this allows ` +
        `more than written.`,
    );
  }

  const allowCount = policy.rules.filter((r) => r.action === 'allow').length;
  if (allowCount > 0) {
    out.push(
      `${allowCount} allow rule(s) are newly effective: rule matching was ` +
        `previously broken against real permission frames, so these have never ` +
        `auto-approved before. Verify them before relying on this policy.`,
    );
  }
  return out;
}

/**
 * Validate a policy file's schema WITHOUT loading it into a running gateway —
 * the `qwen-rc policy lint <file>` pre-flight check. Runs the SAME
 * {@link loadPolicy} validator the boot path uses (one schema, no drift). Never
 * throws: every failure is reported as `{ ok: false, error }`. A missing file is
 * a lint FAILURE (not the loader's "absent → default" pass) — an explicit
 * `lint <file>` target that does not exist is an error.
 *
 * A workspace file (`<dir>/.qwen/policy.yaml`, or any path with
 * `opts.workspace: true`) is also checked against the workspace bounds: each
 * `allow` rule and a `defaults` block is listed in `violations` and the result
 * is NOT ok, since the gateway would ignore those parts (issue #156).
 */
export async function lintPolicyFile(
  path: string,
  opts: { workspace?: boolean } = {},
): Promise<PolicyLintResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      error:
        code === 'ENOENT'
          ? `file not found: ${path}`
          : `cannot read ${path}: ${(err as Error).message}`,
    };
  }
  const workspace = opts.workspace ?? isWorkspacePolicyPath(path);
  let policy: Policy;
  let violations: string[] = [];
  try {
    if (workspace) {
      ({ policy, violations } = loadWorkspacePolicy(text));
    } else {
      policy = loadPolicy(text);
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (violations.length > 0) {
    return {
      ok: false,
      ruleCount: policy.rules.length,
      violations,
      error:
        `workspace policy exceeds its bounds: the gateway ignores ` +
        `${violations.length} part(s) of it at load`,
    };
  }
  // No policy field is currently deferred (maxPerWindow is honored as of cycle 43),
  // so a valid file lints clean. Left as a hook for any future deferred field.
  const deferred: string[] = [];
  const warnings = policyAdvisories(policy);
  return { ok: true, ruleCount: policy.rules.length, deferred, warnings };
}

/** Render a {@link PolicyLintResult} as a one/two-line human summary. */
export function formatPolicyLint(path: string, r: PolicyLintResult): string {
  if (!r.ok) {
    return [
      `✖ ${path}: ${r.error}`,
      ...(r.violations ?? []).map((v) => `  ignored: ${v}`),
    ].join('\n');
  }
  const lines = [`✓ ${path}: valid (${r.ruleCount} rule(s))`];
  if (r.deferred && r.deferred.length > 0) {
    lines.push(
      `  note: ${r.deferred.length} rule(s) use a not-yet-evaluated field ` +
        `(will downgrade to prompt): ${r.deferred.join(', ')}`,
    );
  }
  if (r.warnings && r.warnings.length > 0) {
    for (const w of r.warnings) {
      lines.push(`  warning: ${w}`);
    }
  }
  return lines.join('\n');
}
