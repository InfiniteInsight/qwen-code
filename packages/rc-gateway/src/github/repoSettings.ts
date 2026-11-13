/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a freshly cloned repo brings that the CLI would act on when a session
 * starts in it (InfiniteInsight/Qwen-Code-Remote#257). Folder trust is off on
 * this host, so `isWorkspaceTrusted` answers trusted for every folder and the
 * repo's `.qwen/settings.json`, `.mcp.json`, `.qwen/.env` and `.env` take
 * effect at once; the page lists these findings and asks the owner before
 * that happens, and an empty list starts the conversation straight away.
 *
 * Every file is read as data only: nothing from the repo is executed,
 * imported or resolved, and `$VAR` references are shown as written, not
 * expanded. A symlinked file or directory on the way is not followed and a
 * file over 1 MiB is not read; both come back as unreadable, which counts as
 * a finding, so a file this module cannot inspect is never treated as a
 * clean one.
 */

import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isInternalSecretEnvVar } from '@qwen-code/qwen-code-core';

export const REPO_SETTINGS_MAX_BYTES = 1024 * 1024;

/**
 * `command` (hooks and MCP servers) and `url` (MCP servers) are display
 * strings: the hook's or server's own env, cwd, headers and trust are written
 * after it in `[label: ...]` parts, so they are never run or linked as is.
 * A value from `.qwen/settings.json` that names `$VAR` or `${VAR}` ends with
 * ` (expands $VAR from your environment)`, because the CLI fills those in
 * from the owner's environment before it uses the value.
 */
export interface RepoSettingsFindings {
  /** True when something is at `.qwen/settings.json`, read or not. */
  file: boolean;
  /** Why `.qwen/settings.json` could not be inspected; only with `file`. */
  unreadable?: string;
  hooks: Array<{ event: string; command: string }>;
  /**
   * `.qwen/settings.json` servers by name, then `.mcp.json` servers named
   * `.mcp.json: <name>`.
   */
  mcpServers: Array<{ name: string; command?: string; url?: string }>;
  /** Settings whose value is a command the host runs, by dotted path. */
  commands: Array<{ key: string; value: string }>;
  /** Settings that switch off or loosen the approval of what the model runs. */
  approval: Array<{ key: string; value: string }>;
  /** Settings that choose where the owner's model key or traffic is sent. */
  credentials: Array<{ key: string; value: string }>;
  /** Settings that send the owner's prompts, events or logs to a URL or path. */
  dataSinks: Array<{ key: string; value: string }>;
  /** Why `.mcp.json` could not be inspected, when it is there. */
  mcpJsonUnreadable?: string;
  /**
   * `.qwen/.env` and `.env` when present, with the variable names each sets
   * (never the values).
   */
  envFiles: Array<{ file: string; keys: string[]; unreadable?: string }>;
  /**
   * Every other `.qwen/settings.json` leaf the categories above do not
   * report and OTHER_SETTINGS_HARMLESS does not name, by dotted path, so a
   * setting this module does not know is asked about rather than passed.
   */
  otherSettings: Array<{ key: string; value: string }>;
  /**
   * Agent, skill, command and saved-workflow files the CLI loads from the
   * project, by path relative to the repo, presence only: their contents are
   * not read. `note` says why one was not looked into.
   */
  projectExtensions: Array<{ file: string; note?: string }>;
}

/**
 * Settings whose value is a command the host runs, by dotted path, read from
 * `packages/cli/src/config/settingsSchema.ts`:
 * - `tools.discoveryCommand`, `tools.callCommand`: run by the tool registry
 *   to discover and call project tools.
 * - `ui.statusLine.command`: the status line's `type: "command"` shell
 *   command, re-run on a timer.
 * - `mcp.serverCommand`: starts an MCP server.
 * - `artifact.host.uploadCommand`: run with execFile to publish an artifact.
 * - `tools.shell.pager`: exported as PAGER and GIT_PAGER to every shell
 *   command, and git runs it through a shell.
 * - `tools.sandbox`, `tools.sandboxImage`: the container command the CLI
 *   relaunches itself under and the image it runs, with the workspace
 *   mounted.
 * - The v1 flat keys the CLI migrates onto those paths when it loads a file
 *   (`migration/versions/v1-to-v2-shared.ts`), so the old spelling still
 *   takes effect: `toolDiscoveryCommand`, `toolCallCommand`,
 *   `mcpServerCommand`, `shellPager`, `sandbox`.
 * `hooks`, `mcpServers` and `env` are walked separately below.
 */
const COMMAND_SETTINGS: readonly string[] = [
  'tools.discoveryCommand',
  'tools.callCommand',
  'ui.statusLine.command',
  'mcp.serverCommand',
  'artifact.host.uploadCommand',
  'tools.shell.pager',
  'tools.sandbox',
  'tools.sandboxImage',
  'toolDiscoveryCommand',
  'toolCallCommand',
  'mcpServerCommand',
  'shellPager',
  'sandbox',
];

/**
 * Listed whenever the file sets them, `false` and `""` included: the CLI
 * reads `argv.sandbox ?? settings.tools.sandbox` from the merged settings
 * (`sandboxConfig.ts` loadSandboxConfig) and treats a falsy value as off, so
 * a repo's `false` turns off a sandbox the owner set in their own settings.
 */
const LISTED_WHEN_SET: readonly string[] = ['tools.sandbox', 'sandbox'];

/**
 * Approval modes, v2 and v1 spelling. The CLI uses a workspace's mode as is
 * (`cli/src/config/config.ts` loadCliConfig) and resets it only for an
 * untrusted folder; YOLO also removes the approval gate on workspace and
 * `.mcp.json` MCP servers. `default` and `plan` are the only modes that do
 * not run anything without asking.
 */
const APPROVAL_MODE_SETTINGS: readonly string[] = [
  'tools.approvalMode',
  'approvalMode',
];
const ASKING_APPROVAL_MODES: readonly string[] = ['default', 'plan'];

/**
 * Lists whose every entry loosens approval: allow rules (`permissions.allow`,
 * `tools.allowed`, v1 `allowedTools`, merged into one allow list by
 * loadCliConfig) and the AUTO classifier's allow hints and environment lines
 * (`permissions.autoMode`, read by core's classifier system prompt). Also
 * `dualOutput.inputFile`: the CLI watches that file for JSONL commands that
 * submit prompts and answer tool approvals (`config.ts` loadCliConfig,
 * docs/users/features/dual-output.md).
 */
const APPROVAL_LIST_SETTINGS: readonly string[] = [
  'permissions.allow',
  'tools.allowed',
  'allowedTools',
  'permissions.autoMode.hints.allow',
  'permissions.autoMode.environment',
  'dualOutput.inputFile',
];

/**
 * Settings that widen what the model may touch without asking, listed under
 * approval with their values:
 * - `context.includeDirectories` (v1 `includeDirectories`): added to the
 *   workspace with `~` expanded (`cli/src/config/config.ts` loadCliConfig),
 *   and read_file, grep and glob ask only outside the workspace. Not a
 *   workspace-restricted setting (`settingsUtils.ts`
 *   WORKSPACE_RESTRICTED_SETTINGS).
 * - `context.loadFromIncludeDirectories` (v1
 *   `loadMemoryFromIncludeDirectories`): loads memory files from those
 *   directories into the prompt.
 * - `skills.directories`: more directories scanned for skills, which can
 *   define hooks and commands (settingsSchema.ts).
 */
const WIDENING_SETTINGS: readonly string[] = [
  'context.includeDirectories',
  'includeDirectories',
  'context.loadFromIncludeDirectories',
  'loadMemoryFromIncludeDirectories',
  'skills.directories',
];

/**
 * Settings that send the owner's data to a URL or path the repo chooses. All
 * are read from the merged settings with no workspace restriction
 * (`settingsUtils.ts` restriction lists), so a repo's value applies when no
 * flag or env var sets one:
 * - `telemetry.*`: the OTLP endpoints, the per-signal endpoints, the outfile
 *   and the target, resolved in core `telemetry/config.ts`
 *   resolveTelemetrySettings (flag, then QWEN_TELEMETRY_* and
 *   OTEL_EXPORTER_OTLP_* env, then settings). With `logPrompts` the prompts
 *   go along.
 * - `dualOutput.jsonFile`: the session's structured event stream.
 * - `model.openAILoggingDir`: OpenAI API request and response logs.
 */
const DATA_SINK_SETTINGS: readonly string[] = [
  'telemetry.otlpEndpoint',
  'telemetry.otlpTracesEndpoint',
  'telemetry.otlpLogsEndpoint',
  'telemetry.otlpMetricsEndpoint',
  'telemetry.outfile',
  'telemetry.target',
  'dualOutput.jsonFile',
  'model.openAILoggingDir',
];

type ReadResult =
  | { kind: 'none' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'text'; text: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

/**
 * Reads `<dir>/<parts...>` without following a symlink anywhere below `dir`
 * and without reading more than 1 MiB. A missing file, or a directory on the
 * way that is missing or a plain file, is `none` (the CLI finds nothing
 * there either).
 */
async function readRepoFile(dir: string, parts: string[]): Promise<ReadResult> {
  let path = dir;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const last = index === parts.length - 1;
    let st;
    try {
      st = await lstat(path);
    } catch (e) {
      const code = errCode(e);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'none' };
      return {
        kind: 'unreadable',
        reason: last
          ? `it cannot be read (${code})`
          : `${parts.slice(0, index + 1).join('/')} cannot be read (${code})`,
      };
    }
    if (st.isSymbolicLink()) {
      return {
        kind: 'unreadable',
        reason: last
          ? 'it is a symbolic link, not followed'
          : `${parts.slice(0, index + 1).join('/')} is a symbolic link, not followed`,
      };
    }
    if (!last) {
      if (!st.isDirectory()) return { kind: 'none' };
      continue;
    }
    if (!st.isFile()) {
      return { kind: 'unreadable', reason: 'it is not a regular file' };
    }
    if (st.size > REPO_SETTINGS_MAX_BYTES) {
      return {
        kind: 'unreadable',
        reason: `it is ${st.size} bytes, over the 1 MiB read limit`,
      };
    }
    return readCapped(path, st.dev, st.ino);
  }
  return { kind: 'none' };
}

async function readCapped(
  path: string,
  dev: number,
  ino: number,
): Promise<ReadResult> {
  // O_NOFOLLOW closes the gap between the lstat and the open: a file swapped
  // for a symlink in between fails to open instead of being followed.
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (e) {
    const code = errCode(e);
    return {
      kind: 'unreadable',
      reason:
        code === 'ELOOP'
          ? 'it is a symbolic link, not followed'
          : `it cannot be opened (${code})`,
    };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== dev || opened.ino !== ino) {
      return { kind: 'unreadable', reason: 'it changed while being read' };
    }
    const buf = Buffer.alloc(REPO_SETTINGS_MAX_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await handle.read(
        buf,
        total,
        buf.length - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > REPO_SETTINGS_MAX_BYTES) {
      return { kind: 'unreadable', reason: 'it is over the 1 MiB read limit' };
    }
    return { kind: 'text', text: buf.subarray(0, total).toString('utf8') };
  } catch (e) {
    return { kind: 'unreadable', reason: `it cannot be read (${errCode(e)})` };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isEscaped(json: string, quote: number): boolean {
  let i = quote - 1;
  let backslashes = 0;
  while (json[i] === '\\') {
    i -= 1;
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * The comment step the CLI runs before parsing settings and `.mcp.json`
 * (`packages/cli/src/config/settings.ts` and `mcpJson.ts` both run
 * `JSON.parse(stripJsonComments(stripUtf8Bom(content)))`), ported from
 * strip-json-comments 3.1.1 because this package does not declare that
 * dependency. `//` to the end of the line and block comments outside strings
 * become spaces, so JSON.parse error positions still match the file; trailing
 * commas stay an error, as they are for the CLI.
 */
function stripJsonComments(json: string): string {
  const blank = (s: string): string => s.replace(/\S/g, ' ');
  let insideString = false;
  let comment: 'none' | 'line' | 'block' = 'none';
  let offset = 0;
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    const next = json[i + 1];
    if (comment === 'none' && c === '"' && !isEscaped(json, i)) {
      insideString = !insideString;
    }
    if (insideString) continue;
    if (comment === 'none' && c === '/' && next === '/') {
      out += json.slice(offset, i);
      offset = i;
      comment = 'line';
      i++;
    } else if (comment === 'line' && c === '\r' && next === '\n') {
      i++;
      comment = 'none';
      out += blank(json.slice(offset, i));
      offset = i;
    } else if (comment === 'line' && c === '\n') {
      comment = 'none';
      out += blank(json.slice(offset, i));
      offset = i;
    } else if (comment === 'none' && c === '/' && next === '*') {
      out += json.slice(offset, i);
      offset = i;
      comment = 'block';
      i++;
    } else if (comment === 'block' && c === '*' && next === '/') {
      i++;
      comment = 'none';
      out += blank(json.slice(offset, i + 1));
      offset = i + 1;
    }
  }
  return (
    out + (comment === 'none' ? json.slice(offset) : blank(json.slice(offset)))
  );
}

/**
 * The line pattern of dotenv 17 (`lib/main.js` LINE), the parser the CLI
 * loads `.env` files with, used here for the variable names only. One change
 * keeps it linear: the leading `\s*` is horizontal whitespace only. dotenv's
 * `\s*` also crosses line breaks, so every line start rescans all the blank
 * lines after it (quadratic: about 14 minutes on a 1 MiB file of newlines).
 * The keys found are the same: a match dotenv starts at a blank line, the
 * engine here starts at the first non-blank line instead, at the same place.
 */
const DOTENV_LINE =
  /(?:^|^)[^\S\n\r\u2028\u2029]*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

function dotenvKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.replace(/\r\n?/g, '\n').matchAll(DOTENV_LINE)) {
    if (match[1] !== undefined) keys.add(match[1]);
  }
  return [...keys];
}

function isHidden(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    code === 0x061c ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

/**
 * Control, bidi, zero-width and format characters written as escapes, so a
 * value shown to the owner cannot push its tail out of sight with newlines or
 * reorder itself with a direction override.
 */
function visible(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (!isHidden(code)) {
      out += ch;
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (code > 0xffff) {
      out += `\\u{${code.toString(16)}}`;
    } else {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    }
  }
  return out;
}

function isWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

/**
 * The names the CLI's expansion pattern `/\$(?:(\w+)|{([^}]+)})/g` (core
 * `utils/envVarResolver.ts` resolveEnvVarsInString, run over every string
 * value of a settings file) matches in `s`, leftmost and non-overlapping like
 * the regex. Scanned by hand because the regex is quadratic on a run of `${`
 * with no `}` (each `$` rescans to the end): the next `}` is found once and
 * reused until the scan passes it.
 */
function referenceNames(s: string): string[] {
  const names: string[] = [];
  let close = -2; // index of the next `}`; -2 not looked up yet, -1 none
  let i = s.indexOf('$');
  while (i !== -1) {
    const next = s.charCodeAt(i + 1);
    if (isWordChar(next)) {
      let end = i + 2;
      while (end < s.length && isWordChar(s.charCodeAt(end))) end++;
      names.push(s.slice(i + 1, end));
      i = s.indexOf('$', end);
      continue;
    }
    if (next === 0x7b) {
      if (close !== -1 && close < i + 2) close = s.indexOf('}', i + 2);
      if (close > i + 2) {
        names.push(s.slice(i + 2, close));
        i = s.indexOf('$', close + 1);
        continue;
      }
    }
    i = s.indexOf('$', i + 1);
  }
  return names;
}

function collectReferences(v: unknown, names: Set<string>): void {
  if (typeof v === 'string') {
    for (const name of referenceNames(v)) {
      // Left unexpanded by the CLI, exactly as resolveEnvVarsInString does.
      const upper = name.toUpperCase();
      if (upper === 'SESSION_ID' || upper === 'QWEN_CODE_SESSION_ID') continue;
      if (isInternalSecretEnvVar(name)) continue;
      names.add(name);
    }
  } else if (Array.isArray(v)) {
    for (const item of v) collectReferences(item, names);
  } else if (isRecord(v)) {
    // Values only: the CLI does not expand object keys.
    for (const item of Object.values(v)) collectReferences(item, names);
  }
}

/**
 * The display text, then a note naming every `$VAR` the CLI would fill in
 * from the owner's environment in the raw values it was built from, made
 * visible as a whole.
 */
function shown(
  text: string,
  raw: unknown[],
  expands = true,
  nameFilter: (name: string) => boolean = () => true,
): string {
  const found = new Set<string>();
  if (expands) collectReferences(raw, found);
  const names = [...found].filter(nameFilter);
  const note =
    names.length > 0
      ? ` (expands ${names.map((n) => `$${n}`).join(', ')} from your environment)`
      : '';
  return visible(text + note);
}

/** A string as is; anything else as JSON, so an odd value is shown, not dropped. */
function valueText(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? String(v);
}

function quoteArg(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : JSON.stringify(s);
}

/** A value as text, with a blank string shown quoted so it is not empty. */
function setText(v: unknown): string {
  return typeof v === 'string' && v.trim() === ''
    ? JSON.stringify(v)
    : valueText(v);
}

function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Top-level key names of an object; another value as JSON. */
function keysText(v: unknown): string | undefined {
  if (!present(v)) return undefined;
  if (!isRecord(v)) return valueText(v);
  const keys = Object.keys(v);
  return keys.length > 0 ? keys.join(', ') : undefined;
}

/** Set to something that can take effect: not absent, `false` or blank. */
function present(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  return typeof v !== 'string' || v.trim() !== '';
}

function at(settings: Record<string, unknown>, path: string): unknown {
  let v: unknown = settings;
  for (const part of path.split('.')) {
    if (!isRecord(v) || !Object.hasOwn(v, part)) return undefined;
    v = v[part];
  }
  return v;
}

/** `NAME=value` pairs of an env or headers map; another value as JSON. */
function pairsText(v: unknown): string | undefined {
  if (!present(v)) return undefined;
  if (!isRecord(v)) return valueText(v);
  const pairs = Object.entries(v).map(([k, val]) => `${k}=${valueText(val)}`);
  return pairs.length > 0 ? pairs.join(' ') : undefined;
}

function listText(v: unknown): string | undefined {
  if (!present(v)) return undefined;
  if (!Array.isArray(v)) return valueText(v);
  return v.length > 0 ? v.map(valueText).join(', ') : undefined;
}

/** `base [label: text]...` for each detail that is set. */
function withDetails(
  base: string,
  details: Array<[string, string | undefined]>,
): string {
  let out = base;
  for (const [label, text] of details) {
    if (text !== undefined) out += ` [${label}: ${text}]`;
  }
  return out;
}

function describeHook(hook: Record<string, unknown>): string {
  if (hook['type'] === 'http') {
    const text = withDetails(`http ${valueText(hook['url'])}`, [
      ['headers', pairsText(hook['headers'])],
      ['env vars', listText(hook['allowedEnvVars'])],
    ]);
    return shown(text, [hook['url'], hook['headers'], hook['allowedEnvVars']]);
  }
  if (hook['type'] === 'prompt') {
    return shown(`prompt ${valueText(hook['prompt'])}`, [hook['prompt']]);
  }
  if (hook['type'] === 'command' && typeof hook['command'] === 'string') {
    // The hook runner spreads a hook's own env over the session's, unfiltered.
    const text = withDetails(hook['command'], [
      ['env', pairsText(hook['env'])],
    ]);
    return shown(text, [hook['command'], hook['env']]);
  }
  // An entry the CLI would discard (no or unknown type, a non-string command)
  // is still shown whole rather than guessed at.
  return shown(valueText(hook), [hook]);
}

/**
 * `hooks.<Event>[].hooks[]`, per HOOK_DEFINITION_ITEMS in settingsSchema.ts.
 * Every entry is listed, whatever its event name: the hooks config fields
 * (`enabled`, `disabled`, `notifications`) hold no definition objects, so the
 * walk passes over them on its own.
 */
function hooksOf(
  settings: Record<string, unknown>,
): RepoSettingsFindings['hooks'] {
  const hooks = settings['hooks'];
  if (!isRecord(hooks)) return [];
  const out: RepoSettingsFindings['hooks'] = [];
  for (const [event, definitions] of Object.entries(hooks)) {
    if (!Array.isArray(definitions)) continue;
    for (const definition of definitions) {
      if (!isRecord(definition) || !Array.isArray(definition['hooks'])) {
        continue;
      }
      for (const hook of definition['hooks']) {
        if (!isRecord(hook)) continue;
        out.push({ event: visible(event), command: describeHook(hook) });
      }
    }
  }
  return out;
}

/**
 * Servers of an `mcpServers` map, per MCPServerConfig: a stdio server runs
 * `command` with `args` in `cwd` with its own `env` (exempt from the
 * session's env filtering); an http, sse or websocket server connects to
 * `httpUrl`, `url` or `tcp` with its `headers`. `trust: true` skips every
 * tool confirmation for the server.
 */
function serversOf(
  servers: unknown,
  prefix: string,
  expands: boolean,
): RepoSettingsFindings['mcpServers'] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, config]) => {
    const entry: RepoSettingsFindings['mcpServers'][number] = {
      name: visible(`${prefix}${name}`),
    };
    if (!isRecord(config)) return entry;
    const trust = present(config['trust'])
      ? valueText(config['trust'])
      : undefined;
    if (present(config['command'])) {
      const args = Array.isArray(config['args']) ? config['args'] : [];
      const command = [config['command'], ...args]
        .map((part) => quoteArg(valueText(part)))
        .join(' ');
      entry.command = shown(
        withDetails(command, [
          [
            'cwd',
            present(config['cwd']) ? valueText(config['cwd']) : undefined,
          ],
          ['env', pairsText(config['env'])],
          ['trust', trust],
        ]),
        [config['command'], args, config['cwd'], config['env']],
        expands,
      );
    }
    const url = [config['httpUrl'], config['url'], config['tcp']].find(present);
    if (url !== undefined) {
      entry.url = shown(
        withDetails(valueText(url), [
          ['headers', pairsText(config['headers'])],
          ['trust', trust],
        ]),
        [url, config['headers']],
        expands,
      );
    }
    return entry;
  });
}

/**
 * COMMAND_SETTINGS, then every `env` entry. The CLI copies a workspace's
 * `env` map into its own environment for any variable not already set, and
 * every child it starts inherits it. It drops loader names (LD_PRELOAD,
 * BASH_ENV, NODE_OPTIONS and the rest of INHERITED_LOADER_ENV_KEYS), its
 * hardcoded project exclusions such as GIT_SSH_COMMAND, and PATH, HOME and
 * LD_LIBRARY_PATH (`environment.ts` loadEnvironment), but what it keeps can
 * still carry provider keys and base URLs or change what a tool runs, and no
 * denylist is complete, so each entry is listed.
 */
function commandsOf(
  settings: Record<string, unknown>,
): RepoSettingsFindings['commands'] {
  const out: RepoSettingsFindings['commands'] = [];
  for (const key of COMMAND_SETTINGS) {
    const value = at(settings, key);
    const listed = LISTED_WHEN_SET.includes(key)
      ? value !== undefined && value !== null
      : present(value);
    if (listed) out.push({ key, value: shown(setText(value), [value]) });
  }
  const env = settings['env'];
  if (isRecord(env)) {
    for (const [name, value] of Object.entries(env)) {
      if (present(value)) {
        out.push({
          key: visible(`env.${name}`),
          value: shown(valueText(value), [value]),
        });
      }
    }
  }
  return out;
}

function approvalOf(
  settings: Record<string, unknown>,
): RepoSettingsFindings['approval'] {
  const out: RepoSettingsFindings['approval'] = [];
  for (const key of APPROVAL_MODE_SETTINGS) {
    const value = at(settings, key);
    if (!present(value)) continue;
    if (
      typeof value === 'string' &&
      ASKING_APPROVAL_MODES.includes(value.trim().toLowerCase())
    ) {
      continue;
    }
    out.push({ key, value: shown(valueText(value), [value]) });
  }
  for (const key of APPROVAL_LIST_SETTINGS) {
    const value = at(settings, key);
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (present(item))
        out.push({ key, value: shown(valueText(item), [item]) });
    }
  }
  // Only `true` routes every shell command through the AUTO classifier
  // (core `permissions/autoMode.ts` shouldClassifyAllShellForAutoMode), and
  // the repo's value overrides the owner's in the merge.
  const classifyAllShell = at(
    settings,
    'permissions.autoMode.classifyAllShell',
  );
  if (
    classifyAllShell !== undefined &&
    classifyAllShell !== null &&
    classifyAllShell !== true
  ) {
    out.push({
      key: 'permissions.autoMode.classifyAllShell',
      value: shown(setText(classifyAllShell), [classifyAllShell]),
    });
  }
  for (const key of WIDENING_SETTINGS) {
    const value = at(settings, key);
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (present(item))
        out.push({ key, value: shown(valueText(item), [item]) });
    }
  }
  return out;
}

/**
 * The env vars a provider protocol reads its API key from when an entry has
 * no `envKey` (core `models/constants.ts` AUTH_ENV_MAPPINGS, not exported
 * from the core root).
 */
const PROVIDER_KEY_ENV: Record<string, readonly string[]> = {
  openai: ['OPENAI_API_KEY'],
  'openai-responses': ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  'vertex-ai': ['GOOGLE_API_KEY'],
};

function ownerKeyText(
  provider: string,
  protocols: Record<string, unknown>,
): string {
  const mapped = protocols[provider];
  const protocol = typeof mapped === 'string' ? mapped : provider;
  const names = Object.hasOwn(PROVIDER_KEY_ENV, protocol)
    ? (PROVIDER_KEY_ENV[protocol] ?? [])
    : [];
  return names.length > 0
    ? `the owner's ${names.map((n) => `$${n}`).join(' or ')} is sent there`
    : "the owner's key for this provider is sent there";
}

/**
 * Settings that choose where the owner's model key or traffic goes:
 * - `modelProviders` merges with REPLACE and is honored from a trusted
 *   workspace, so a repo's map replaces the owner's. Each entry's `baseUrl`
 *   comes first among baseUrl sources and its `envKey` names the variable
 *   the API key is read from (core `modelConfigResolver.ts` resolveModelConfig,
 *   `modelsConfig.ts`), so an entry the session selects (by `model.name`)
 *   sends the owner's key to the URL the repo chose.
 * - `security.auth.baseUrl`: the base URL when no provider entry, flag or
 *   env var sets one, used with the owner's env API key.
 * - `security.auth.apiKey`: the lowest API key layer
 *   (`modelConfigUtils.ts` resolveCliGenerationConfig into
 *   resolveModelConfig). A workspace value outranks the user's settings file,
 *   so it replaces a key the owner keeps there, and serves whenever no
 *   provider envKey, flag or env var supplies one: the owner's prompts then
 *   go out on the repo owner's account. Only its presence is shown.
 * - `omni.delivery.upload.baseUrl` with `apiKeyEnv`: the media upload
 *   endpoint and the variable whose key is sent to it.
 * - `proxy`: every CLI HTTP request goes through it, which exposes a plain
 *   http provider's key.
 */
function credentialsOf(
  settings: Record<string, unknown>,
): RepoSettingsFindings['credentials'] {
  const out: RepoSettingsFindings['credentials'] = [];
  const providers = settings['modelProviders'];
  const protocols = isRecord(settings['providerProtocol'])
    ? settings['providerProtocol']
    : {};
  if (isRecord(providers)) {
    for (const [provider, models] of Object.entries(providers)) {
      const base = `modelProviders.${provider}`;
      if (!Array.isArray(models)) {
        if (present(models)) {
          out.push({
            key: visible(base),
            value: shown(valueText(models), [models]),
          });
        }
        continue;
      }
      models.forEach((model, index) => {
        const key = visible(`${base}[${index}]`);
        if (!isRecord(model)) {
          out.push({ key, value: shown(valueText(model), [model]) });
          return;
        }
        const parts: string[] = [];
        if (present(model['id'])) parts.push(`id ${valueText(model['id'])}`);
        if (present(model['baseUrl'])) {
          parts.push(`baseUrl ${valueText(model['baseUrl'])}`);
        }
        if (present(model['envKey'])) {
          parts.push(`key from $${valueText(model['envKey'])}`);
        } else if (present(model['baseUrl'])) {
          // No envKey: the protocol's own key variable, or the inherited
          // key, goes to this baseUrl (modelConfigResolver.ts, modelsConfig.ts).
          parts.push(ownerKeyText(provider, protocols));
        }
        // customHeaders and extra_body are expanded and sent with every
        // request to the entry's baseUrl (core `models/types.ts`
        // ModelGenerationConfig).
        const generation = isRecord(model['generationConfig'])
          ? model['generationConfig']
          : {};
        out.push({
          key,
          value:
            parts.length > 0
              ? shown(
                  withDetails(parts.join(', '), [
                    ['headers', pairsText(generation['customHeaders'])],
                    ['extra_body', keysText(generation['extra_body'])],
                  ]),
                  [
                    model['id'],
                    model['baseUrl'],
                    model['envKey'],
                    generation['customHeaders'],
                    generation['extra_body'],
                  ],
                )
              : shown(valueText(model), [model]),
        });
      });
    }
  }
  const authBaseUrl = at(settings, 'security.auth.baseUrl');
  if (present(authBaseUrl)) {
    out.push({
      key: 'security.auth.baseUrl',
      value: shown(valueText(authBaseUrl), [authBaseUrl]),
    });
  }
  const apiKey = at(settings, 'security.auth.apiKey');
  if (present(apiKey)) {
    // Names only, and only names shaped like a variable, so no part of the
    // key itself is ever shown.
    out.push({
      key: 'security.auth.apiKey',
      value: shown('a key is set (value not shown)', [apiKey], true, isEnvName),
    });
  }
  const uploadBaseUrl = at(settings, 'omni.delivery.upload.baseUrl');
  if (present(uploadBaseUrl)) {
    const keyEnv = at(settings, 'omni.delivery.upload.apiKeyEnv');
    out.push({
      key: 'omni.delivery.upload.baseUrl',
      value: shown(
        present(keyEnv)
          ? `${valueText(uploadBaseUrl)}, key from $${valueText(keyEnv)}`
          : valueText(uploadBaseUrl),
        [uploadBaseUrl, keyEnv],
      ),
    });
  }
  const proxy = settings['proxy'];
  if (present(proxy)) {
    out.push({ key: 'proxy', value: shown(valueText(proxy), [proxy]) });
  }
  return out;
}

function dataSinksOf(
  settings: Record<string, unknown>,
): RepoSettingsFindings['dataSinks'] {
  const out: RepoSettingsFindings['dataSinks'] = [];
  for (const key of DATA_SINK_SETTINGS) {
    const value = at(settings, key);
    if (present(value))
      out.push({ key, value: shown(valueText(value), [value]) });
  }
  return out;
}

/**
 * The few settings known to change nothing but how the terminal UI looks,
 * each with the values that keep it that way. Kept small on purpose: a key
 * not named here is listed under otherSettings, which costs the owner one
 * tap, where a missed key would cost the guarantee that nothing takes effect
 * unseen.
 * - `$schema`: an editor hint; the CLI never reads it.
 * - `ui.theme`: a built-in theme name only. A value the theme manager treats
 *   as a path (ends in `.json`, starts with `.`, or is absolute;
 *   `cli/src/ui/themes/theme-manager.ts` isPath) makes it read a file.
 * - `ui.hideTips`, `ui.hideBanner`, `ui.hideWindowTitle`,
 *   `ui.showLineNumbers`, `ui.showCitations`, `general.vimMode`: display and
 *   keybinding switches, `true` or `false`.
 */
const isBool = (v: unknown): boolean => typeof v === 'boolean';
const OTHER_SETTINGS_HARMLESS: Readonly<
  Record<string, (v: unknown) => boolean>
> = {
  $schema: (v) => typeof v === 'string',
  'ui.theme': (v) =>
    typeof v === 'string' &&
    !v.endsWith('.json') &&
    !v.startsWith('.') &&
    !v.startsWith('/') &&
    !v.startsWith('\\') &&
    !/^[A-Za-z]:/.test(v),
  'ui.hideTips': isBool,
  'ui.hideBanner': isBool,
  'ui.hideWindowTitle': isBool,
  'ui.showLineNumbers': isBool,
  'ui.showCitations': isBool,
  'general.vimMode': isBool,
};

export const OTHER_SETTINGS_MAX = 100;
export const OTHER_SETTINGS_VALUE_MAX = 300;
/** Deeper than this, a whole object is one leaf shown as JSON. */
const OTHER_SETTINGS_DEPTH = 32;

/**
 * Whether a category above reports the leaf at `path` (or decides on its own
 * that the value there asks nothing): the `mcpServers`, `env` and
 * `modelProviders` maps whole, every `hooks.<event>` list, and each setting
 * the category lists name, with everything below it.
 */
function reportedByCategory(
  settings: Record<string, unknown>,
  path: string[],
): boolean {
  const [top, second] = path;
  if (top === 'mcpServers' || top === 'env' || top === 'modelProviders') {
    return true;
  }
  if (top === 'hooks' && second !== undefined) {
    // Only a list hooksOf shows whole: every entry a definition whose
    // `hooks` are all objects. Anything else there (the config fields
    // `enabled` and `disabled`, an empty or odd list) is listed as it is.
    const hooks = settings['hooks'];
    const definitions = isRecord(hooks) ? hooks[second] : undefined;
    return (
      Array.isArray(definitions) &&
      definitions.length > 0 &&
      definitions.every(
        (d) =>
          isRecord(d) &&
          Array.isArray(d['hooks']) &&
          d['hooks'].length > 0 &&
          d['hooks'].every(isRecord),
      )
    );
  }
  const owned = [
    ...COMMAND_SETTINGS,
    ...APPROVAL_MODE_SETTINGS,
    ...APPROVAL_LIST_SETTINGS,
    'permissions.autoMode.classifyAllShell',
    ...WIDENING_SETTINGS,
    'security.auth.baseUrl',
    'security.auth.apiKey',
    'omni.delivery.upload.baseUrl',
    ...(present(at(settings, 'omni.delivery.upload.baseUrl'))
      ? ['omni.delivery.upload.apiKeyEnv']
      : []),
    'proxy',
    ...DATA_SINK_SETTINGS,
  ];
  // By segment, so a literal key such as `"tools.sandbox"` (which `at` does
  // not read either) is not taken for the nested one.
  return owned.some((key) => {
    const parts = key.split('.');
    return parts.length <= path.length && parts.every((p, i) => p === path[i]);
  });
}

function leavesOf(
  v: unknown,
  path: string[],
  out: Array<[string[], unknown]>,
): void {
  if (
    isRecord(v) &&
    path.length < OTHER_SETTINGS_DEPTH &&
    (path.length === 0 || Object.keys(v).length > 0)
  ) {
    for (const [key, value] of Object.entries(v)) {
      leavesOf(value, [...path, key], out);
    }
    return;
  }
  out.push([path, v]);
}

function capped(text: string): string {
  return text.length > OTHER_SETTINGS_VALUE_MAX
    ? `${text.slice(0, OTHER_SETTINGS_VALUE_MAX)}... [cut]`
    : text;
}

/**
 * Fail closed: every leaf of the file that no category reports and that is
 * not a harmless cosmetic setting, so a key this module does not know still
 * makes the page ask. An array or an empty object is one leaf, shown as JSON.
 */
function otherSettingsOf(
  settings: Record<string, unknown>,
): RepoSettingsFindings['otherSettings'] {
  const leaves: Array<[string[], unknown]> = [];
  leavesOf(settings, [], leaves);
  const out: RepoSettingsFindings['otherSettings'] = [];
  let more = 0;
  for (const [path, value] of leaves) {
    if (reportedByCategory(settings, path)) continue;
    const key = path.join('.');
    const harmless =
      path.every((part) => !part.includes('.')) &&
      Object.hasOwn(OTHER_SETTINGS_HARMLESS, key)
        ? OTHER_SETTINGS_HARMLESS[key]
        : undefined;
    if (harmless?.(value)) continue;
    if (out.length >= OTHER_SETTINGS_MAX) {
      more += 1;
      continue;
    }
    out.push({
      key: visible(capped(key)),
      value: shown(capped(setText(value)), [value]),
    });
  }
  if (more > 0) out.push({ key: `and ${more} more settings`, value: '' });
  return out;
}

type SettingsPart = Pick<
  RepoSettingsFindings,
  | 'file'
  | 'unreadable'
  | 'hooks'
  | 'mcpServers'
  | 'commands'
  | 'approval'
  | 'credentials'
  | 'dataSinks'
  | 'otherSettings'
>;

function unreadableSettings(reason: string): SettingsPart {
  return {
    file: true,
    unreadable: visible(reason),
    hooks: [],
    mcpServers: [],
    commands: [],
    approval: [],
    credentials: [],
    dataSinks: [],
    otherSettings: [],
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function inspectSettingsFile(dir: string): Promise<SettingsPart> {
  try {
    const read = await readRepoFile(dir, ['.qwen', 'settings.json']);
    if (read.kind === 'none') {
      return {
        file: false,
        hooks: [],
        mcpServers: [],
        commands: [],
        approval: [],
        credentials: [],
        dataSinks: [],
        otherSettings: [],
      };
    }
    if (read.kind === 'unreadable') return unreadableSettings(read.reason);
    let settings: unknown;
    try {
      settings = JSON.parse(stripJsonComments(stripUtf8Bom(read.text)));
    } catch (e) {
      return unreadableSettings(`not valid JSON: ${errorText(e)}`);
    }
    if (!isRecord(settings)) {
      return unreadableSettings('it is not a JSON object');
    }
    return {
      file: true,
      hooks: hooksOf(settings),
      mcpServers: serversOf(settings['mcpServers'], '', true),
      commands: commandsOf(settings),
      approval: approvalOf(settings),
      credentials: credentialsOf(settings),
      dataSinks: dataSinksOf(settings),
      otherSettings: otherSettingsOf(settings),
    };
  } catch (e) {
    return unreadableSettings(`it could not be inspected: ${errorText(e)}`);
  }
}

/**
 * `<dir>/.mcp.json`, which the CLI reads from the session folder with no
 * trust check (`mcpJson.ts` loadProjectMcpServers, Claude Code's
 * `{ "mcpServers": {...} }` shape). A file without an `mcpServers` object
 * is ignored by the CLI and so here. The CLI does not expand `$VAR` in it,
 * so its values carry no expansion note.
 */
async function inspectMcpJson(dir: string): Promise<{
  servers: RepoSettingsFindings['mcpServers'];
  unreadable?: string;
}> {
  try {
    const read = await readRepoFile(dir, ['.mcp.json']);
    if (read.kind === 'none') return { servers: [] };
    if (read.kind === 'unreadable') {
      return { servers: [], unreadable: visible(read.reason) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(stripUtf8Bom(read.text)));
    } catch (e) {
      return {
        servers: [],
        unreadable: visible(`not valid JSON: ${errorText(e)}`),
      };
    }
    if (!isRecord(parsed)) return { servers: [] };
    return { servers: serversOf(parsed['mcpServers'], '.mcp.json: ', false) };
  } catch (e) {
    return {
      servers: [],
      unreadable: visible(`it could not be inspected: ${errorText(e)}`),
    };
  }
}

/**
 * `<dir>/.qwen/.env` and `<dir>/.env`. The CLI loads the first of these that
 * exists (`environment.ts` findEnvFiles) at a higher priority than
 * settings.env; both are reported, by variable name only.
 */
async function inspectEnvFiles(
  dir: string,
): Promise<RepoSettingsFindings['envFiles']> {
  const out: RepoSettingsFindings['envFiles'] = [];
  for (const parts of [['.qwen', '.env'], ['.env']]) {
    const file = parts.join('/');
    try {
      const read = await readRepoFile(dir, parts);
      if (read.kind === 'none') continue;
      if (read.kind === 'unreadable') {
        out.push({ file, keys: [], unreadable: visible(read.reason) });
        continue;
      }
      out.push({ file, keys: dotenvKeys(read.text).map(visible) });
    } catch (e) {
      out.push({
        file,
        keys: [],
        unreadable: visible(`it could not be inspected: ${errorText(e)}`),
      });
    }
  }
  return out;
}

/**
 * The project directories the CLI loads agents, skills, commands and saved
 * workflows from, relative to the session folder:
 * - `.qwen/agents`: project subagents (core `subagents/subagent-manager.ts`
 *   listSubagentsAtLevel). Their frontmatter can set an approval mode
 *   (yolo included), MCP servers and hooks.
 * - `.qwen/skills`, `.agents/skills`: project skills, one per directory
 *   (core `skills/skill-manager.ts` getSkillsBaseDirs over
 *   `config/storage.ts` SKILL_PROVIDER_CONFIG_DIRS).
 * - `.qwen/commands`: project slash commands (cli
 *   `services/FileCommandLoader.ts` getCommandDirectories via
 *   `Storage.getProjectCommandsDir`).
 * - `.qwen/workflows`: saved workflow scripts, surfaced as slash commands
 *   (core `agents/runtime/workflow-saved.ts` getSavedWorkflowDirs).
 * Agents and skills from `.claude/...` are read from the owner's home only,
 * and extensions from the owner's extensions directory only, so neither is
 * looked for in the repo.
 */
const PROJECT_EXTENSION_DIRS: ReadonlyArray<readonly string[]> = [
  ['.qwen', 'agents'],
  ['.qwen', 'skills'],
  ['.agents', 'skills'],
  ['.qwen', 'commands'],
  ['.qwen', 'workflows'],
];
export const PROJECT_EXTENSIONS_MAX = 100;
/** Entries looked at in all, so a huge tree cannot stall the clone. */
const PROJECT_EXTENSIONS_VISIT_MAX = 10_000;
const PROJECT_EXTENSIONS_DEPTH = 8;

/**
 * Names every file under PROJECT_EXTENSION_DIRS, sorted, without reading one
 * and without following a symlink: a symlink, a directory that cannot be
 * read or one too deep to walk is named with a note, so it still counts. A
 * missing directory, or a plain file where one is expected, holds nothing
 * the CLI loads. After PROJECT_EXTENSIONS_MAX names the rest are counted.
 */
async function inspectProjectExtensions(
  dir: string,
): Promise<RepoSettingsFindings['projectExtensions']> {
  const out: RepoSettingsFindings['projectExtensions'] = [];
  const seen = new Set<string>();
  let more = 0;
  let visited = 0;
  let stopped = false;
  const add = (file: string, note?: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    if (out.length >= PROJECT_EXTENSIONS_MAX) {
      more += 1;
      return;
    }
    out.push(
      note !== undefined
        ? { file: visible(file), note }
        : { file: visible(file) },
    );
  };
  const walk = async (abs: string, rel: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (e) {
      add(rel, `cannot be read (${errCode(e)})`);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (visited >= PROJECT_EXTENSIONS_VISIT_MAX) {
        stopped = true;
        return;
      }
      visited += 1;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        add(childRel, 'a symbolic link, not followed');
      } else if (entry.isDirectory()) {
        if (depth + 1 >= PROJECT_EXTENSIONS_DEPTH) {
          add(childRel, 'a directory too deep to list');
        } else {
          await walk(join(abs, entry.name), childRel, depth + 1);
        }
      } else {
        add(childRel);
      }
    }
  };
  for (const parts of PROJECT_EXTENSION_DIRS) {
    if (stopped) break;
    let path = dir;
    let found = true;
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      const rel = parts.slice(0, index + 1).join('/');
      try {
        const st = await lstat(path);
        if (st.isSymbolicLink()) {
          add(rel, 'a symbolic link, not followed');
          found = false;
        } else if (!st.isDirectory()) {
          found = false;
        }
      } catch (e) {
        const code = errCode(e);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          add(rel, `cannot be read (${code})`);
        }
        found = false;
      }
      if (!found) break;
    }
    if (found) await walk(path, parts.join('/'), 0);
  }
  if (stopped) {
    out.push({
      file: `and more not listed: stopped after ${PROJECT_EXTENSIONS_VISIT_MAX} entries`,
    });
  } else if (more > 0) {
    out.push({ file: `and ${more} more` });
  }
  return out;
}

/**
 * Reads what `<dir>` brings: `.qwen/settings.json` (hooks, MCP servers,
 * command, approval, credential and data-sink settings), `.mcp.json` servers, and the
 * variable names of `.qwen/.env` and `.env`, then every other settings leaf
 * and the names of the project's agent, skill, command and workflow files. Never throws: a file it cannot
 * read, parse or walk is reported as unreadable.
 */
export async function inspectRepoSettings(
  dir: string,
): Promise<RepoSettingsFindings> {
  const settings = await inspectSettingsFile(dir);
  const mcpJson = await inspectMcpJson(dir);
  const envFiles = await inspectEnvFiles(dir);
  let projectExtensions: RepoSettingsFindings['projectExtensions'];
  try {
    projectExtensions = await inspectProjectExtensions(dir);
  } catch (e) {
    projectExtensions = [
      {
        file: '.qwen',
        note: visible(`could not be inspected: ${errorText(e)}`),
      },
    ];
  }
  return {
    ...settings,
    mcpServers: [...settings.mcpServers, ...mcpJson.servers],
    ...(mcpJson.unreadable !== undefined
      ? { mcpJsonUnreadable: mcpJson.unreadable }
      : {}),
    envFiles,
    projectExtensions,
  };
}

/**
 * Whether the page must ask before starting a conversation in the repo:
 * anything listed, or any file that could not be inspected. An empty
 * `.env` sets nothing and does not count.
 */
export function hasRepoFindings(findings: RepoSettingsFindings): boolean {
  return (
    findings.unreadable !== undefined ||
    findings.mcpJsonUnreadable !== undefined ||
    findings.hooks.length > 0 ||
    findings.mcpServers.length > 0 ||
    findings.commands.length > 0 ||
    findings.approval.length > 0 ||
    findings.credentials.length > 0 ||
    findings.dataSinks.length > 0 ||
    findings.envFiles.some(
      (e) => e.unreadable !== undefined || e.keys.length > 0,
    ) ||
    findings.otherSettings.length > 0 ||
    findings.projectExtensions.length > 0
  );
}
