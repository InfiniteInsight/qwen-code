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
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

export const REPO_SETTINGS_MAX_BYTES = 1024 * 1024;

/**
 * `command` (hooks and MCP servers) and `url` (MCP servers) are display
 * strings: the hook's or server's own env, cwd, headers and trust are written
 * after it in `[label: ...]` parts, so they are never run or linked as is.
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
  /** Why `.mcp.json` could not be inspected, when it is there. */
  mcpJsonUnreadable?: string;
  /**
   * `.qwen/.env` and `.env` when present, with the variable names each sets
   * (never the values).
   */
  envFiles: Array<{ file: string; keys: string[]; unreadable?: string }>;
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
 * (`permissions.autoMode`, read by core's classifier system prompt).
 */
const APPROVAL_LIST_SETTINGS: readonly string[] = [
  'permissions.allow',
  'tools.allowed',
  'allowedTools',
  'permissions.autoMode.hints.allow',
  'permissions.autoMode.environment',
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
 * loads `.env` files with, used here for the variable names only.
 */
const DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

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

/** A string as is; anything else as JSON, so an odd value is shown, not dropped. */
function valueText(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? String(v);
}

function quoteArg(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : JSON.stringify(s);
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
    return withDetails(`http ${valueText(hook['url'])}`, [
      ['headers', pairsText(hook['headers'])],
      ['env vars', listText(hook['allowedEnvVars'])],
    ]);
  }
  if (hook['type'] === 'prompt') return `prompt ${valueText(hook['prompt'])}`;
  if (hook['type'] === 'command' && typeof hook['command'] === 'string') {
    // The hook runner spreads a hook's own env over the session's, unfiltered.
    return withDetails(hook['command'], [['env', pairsText(hook['env'])]]);
  }
  // An entry the CLI would discard (no or unknown type, a non-string command)
  // is still shown whole rather than guessed at.
  return valueText(hook);
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
        out.push({
          event: visible(event),
          command: visible(describeHook(hook)),
        });
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
      entry.command = visible(
        withDetails(command, [
          [
            'cwd',
            present(config['cwd']) ? valueText(config['cwd']) : undefined,
          ],
          ['env', pairsText(config['env'])],
          ['trust', trust],
        ]),
      );
    }
    const url = [config['httpUrl'], config['url'], config['tcp']].find(present);
    if (url !== undefined) {
      entry.url = visible(
        withDetails(valueText(url), [
          ['headers', pairsText(config['headers'])],
          ['trust', trust],
        ]),
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
    if (present(value)) out.push({ key, value: visible(valueText(value)) });
  }
  const env = settings['env'];
  if (isRecord(env)) {
    for (const [name, value] of Object.entries(env)) {
      if (present(value)) {
        out.push({
          key: visible(`env.${name}`),
          value: visible(valueText(value)),
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
    out.push({ key, value: visible(valueText(value)) });
  }
  for (const key of APPROVAL_LIST_SETTINGS) {
    const value = at(settings, key);
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (present(item)) out.push({ key, value: visible(valueText(item)) });
    }
  }
  return out;
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
  if (isRecord(providers)) {
    for (const [provider, models] of Object.entries(providers)) {
      const base = `modelProviders.${provider}`;
      if (!Array.isArray(models)) {
        if (present(models)) {
          out.push({ key: visible(base), value: visible(valueText(models)) });
        }
        continue;
      }
      models.forEach((model, index) => {
        const key = visible(`${base}[${index}]`);
        if (!isRecord(model)) {
          out.push({ key, value: visible(valueText(model)) });
          return;
        }
        const parts: string[] = [];
        if (present(model['id'])) parts.push(`id ${valueText(model['id'])}`);
        if (present(model['baseUrl'])) {
          parts.push(`baseUrl ${valueText(model['baseUrl'])}`);
        }
        if (present(model['envKey'])) {
          parts.push(`key from $${valueText(model['envKey'])}`);
        }
        out.push({
          key,
          value: visible(
            parts.length > 0 ? parts.join(', ') : valueText(model),
          ),
        });
      });
    }
  }
  const authBaseUrl = at(settings, 'security.auth.baseUrl');
  if (present(authBaseUrl)) {
    out.push({
      key: 'security.auth.baseUrl',
      value: visible(valueText(authBaseUrl)),
    });
  }
  const uploadBaseUrl = at(settings, 'omni.delivery.upload.baseUrl');
  if (present(uploadBaseUrl)) {
    const keyEnv = at(settings, 'omni.delivery.upload.apiKeyEnv');
    out.push({
      key: 'omni.delivery.upload.baseUrl',
      value: visible(
        present(keyEnv)
          ? `${valueText(uploadBaseUrl)}, key from $${valueText(keyEnv)}`
          : valueText(uploadBaseUrl),
      ),
    });
  }
  const proxy = settings['proxy'];
  if (present(proxy)) {
    out.push({ key: 'proxy', value: visible(valueText(proxy)) });
  }
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
      mcpServers: serversOf(settings['mcpServers'], ''),
      commands: commandsOf(settings),
      approval: approvalOf(settings),
      credentials: credentialsOf(settings),
    };
  } catch (e) {
    return unreadableSettings(`it could not be inspected: ${errorText(e)}`);
  }
}

/**
 * `<dir>/.mcp.json`, which the CLI reads from the session folder with no
 * trust check (`mcpJson.ts` loadProjectMcpServers, Claude Code's
 * `{ "mcpServers": {...} }` shape). A file without an `mcpServers` object
 * is ignored by the CLI and so here.
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
    return { servers: serversOf(parsed['mcpServers'], '.mcp.json: ') };
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
 * Reads what `<dir>` brings: `.qwen/settings.json` (hooks, MCP servers,
 * command, approval and credential settings), `.mcp.json` servers, and the
 * variable names of `.qwen/.env` and `.env`. Never throws: a file it cannot
 * read, parse or walk is reported as unreadable.
 */
export async function inspectRepoSettings(
  dir: string,
): Promise<RepoSettingsFindings> {
  const settings = await inspectSettingsFile(dir);
  const mcpJson = await inspectMcpJson(dir);
  const envFiles = await inspectEnvFiles(dir);
  return {
    ...settings,
    mcpServers: [...settings.mcpServers, ...mcpJson.servers],
    ...(mcpJson.unreadable !== undefined
      ? { mcpJsonUnreadable: mcpJson.unreadable }
      : {}),
    envFiles,
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
    findings.envFiles.some(
      (e) => e.unreadable !== undefined || e.keys.length > 0,
    )
  );
}
