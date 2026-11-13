/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a freshly cloned repo's own `.qwen/settings.json` would make the host
 * run (InfiniteInsight/Qwen-Code-Remote#257). Folder trust is off on this host,
 * so a repo's hooks, MCP servers and command settings take effect the moment a
 * session starts in it; the page lists these findings and asks the owner
 * before that happens.
 *
 * The file is read as data only: nothing from the repo is executed, imported
 * or resolved. A symlinked `.qwen` or `settings.json` is not followed and a
 * file over 1 MiB is not read; both come back as `unreadable`, which the page
 * still asks about, so a file this module cannot inspect is never treated as
 * a clean one.
 */

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

export const REPO_SETTINGS_MAX_BYTES = 1024 * 1024;

export interface RepoSettingsFindings {
  /** True when something is at `.qwen/settings.json`, read or not. */
  file: boolean;
  /** Why the file could not be inspected; set only when `file` is true. */
  unreadable?: string;
  hooks: Array<{ event: string; command: string }>;
  mcpServers: Array<{ name: string; command?: string; url?: string }>;
  commands: Array<{ key: string; value: string }>;
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
 * - The v1 flat keys the CLI migrates onto those paths when it loads a file
 *   (`migration/versions/v1-to-v2-shared.ts`), so the old spelling still
 *   takes effect: `toolDiscoveryCommand`, `toolCallCommand`,
 *   `mcpServerCommand`, `shellPager`.
 * `hooks`, `mcpServers` and `env` are walked separately below.
 */
const COMMAND_SETTINGS: readonly string[] = [
  'tools.discoveryCommand',
  'tools.callCommand',
  'ui.statusLine.command',
  'mcp.serverCommand',
  'artifact.host.uploadCommand',
  'tools.shell.pager',
  'toolDiscoveryCommand',
  'toolCallCommand',
  'mcpServerCommand',
  'shellPager',
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

async function readSettingsFile(dir: string): Promise<ReadResult> {
  const qwenDir = join(dir, '.qwen');
  let dirStat;
  try {
    dirStat = await lstat(qwenDir);
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'none' };
    return { kind: 'unreadable', reason: `.qwen cannot be read (${code})` };
  }
  if (dirStat.isSymbolicLink()) {
    return {
      kind: 'unreadable',
      reason: '.qwen is a symbolic link, not followed',
    };
  }
  if (!dirStat.isDirectory()) return { kind: 'none' };

  const file = join(qwenDir, 'settings.json');
  let fileStat;
  try {
    fileStat = await lstat(file);
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT') return { kind: 'none' };
    return { kind: 'unreadable', reason: `it cannot be read (${code})` };
  }
  if (fileStat.isSymbolicLink()) {
    return {
      kind: 'unreadable',
      reason: 'it is a symbolic link, not followed',
    };
  }
  if (!fileStat.isFile()) {
    return { kind: 'unreadable', reason: 'it is not a regular file' };
  }
  if (fileStat.size > REPO_SETTINGS_MAX_BYTES) {
    return {
      kind: 'unreadable',
      reason: `it is ${fileStat.size} bytes, over the 1 MiB read limit`,
    };
  }

  // O_NOFOLLOW closes the gap between the lstat above and the open: a file
  // swapped for a symlink in between fails to open instead of being followed.
  let handle;
  try {
    handle = await open(
      file,
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
    if (
      !opened.isFile() ||
      opened.dev !== fileStat.dev ||
      opened.ino !== fileStat.ino
    ) {
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
  return text.startsWith('﻿') ? text.slice(1) : text;
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
 * The comment step of the CLI's settings loader
 * (`packages/cli/src/config/settings.ts` runs
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

function isHidden(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    code === 0x061c ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

/**
 * Control, bidi and zero-width characters written as escapes, so a value
 * shown to the owner cannot push its tail out of sight with newlines or
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

function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
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

function describeHook(hook: Record<string, unknown>): string {
  if (hook['type'] === 'http') return `http ${valueText(hook['url'])}`;
  if (hook['type'] === 'prompt') return `prompt ${valueText(hook['prompt'])}`;
  if (hook['type'] === 'command' && typeof hook['command'] === 'string') {
    return hook['command'];
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
      if (!isRecord(definition) || !Array.isArray(definition['hooks']))
        continue;
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
 * `mcpServers.<name>`, per MCPServerConfig: a stdio server runs `command` with
 * `args`; an http, sse or websocket server connects to `httpUrl`, `url` or
 * `tcp`.
 */
function mcpServersOf(
  settings: Record<string, unknown>,
): RepoSettingsFindings['mcpServers'] {
  const servers = settings['mcpServers'];
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, config]) => {
    const entry: RepoSettingsFindings['mcpServers'][number] = {
      name: visible(name),
    };
    if (!isRecord(config)) return entry;
    if (present(config['command'])) {
      const args = Array.isArray(config['args']) ? config['args'] : [];
      entry.command = visible(
        [config['command'], ...args]
          .map((part) => quoteArg(valueText(part)))
          .join(' '),
      );
    }
    const url = [config['httpUrl'], config['url'], config['tcp']].find(present);
    if (url !== undefined) entry.url = visible(valueText(url));
    return entry;
  });
}

/**
 * COMMAND_SETTINGS, then every `env` entry. The CLI copies a workspace's
 * `env` map into its own environment for any variable not already set, and
 * every child it starts inherits it; names such as LD_PRELOAD, BASH_ENV,
 * NODE_OPTIONS or GIT_SSH_COMMAND make a value run, and no list of such names
 * is complete, so each entry is listed.
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

function unreadable(reason: string): RepoSettingsFindings {
  return {
    file: true,
    unreadable: visible(reason),
    hooks: [],
    mcpServers: [],
    commands: [],
  };
}

/**
 * Reads `<dir>/.qwen/settings.json` and lists its hooks, MCP servers and
 * command-running settings. Never throws: a file it cannot read, parse or walk
 * comes back with `unreadable` set and empty lists.
 */
export async function inspectRepoSettings(
  dir: string,
): Promise<RepoSettingsFindings> {
  try {
    const read = await readSettingsFile(dir);
    if (read.kind === 'none') {
      return { file: false, hooks: [], mcpServers: [], commands: [] };
    }
    if (read.kind === 'unreadable') return unreadable(read.reason);
    let settings: unknown;
    try {
      settings = JSON.parse(stripJsonComments(stripUtf8Bom(read.text)));
    } catch (e) {
      return unreadable(`not valid JSON: ${(e as Error).message}`);
    }
    if (!isRecord(settings)) return unreadable('it is not a JSON object');
    return {
      file: true,
      hooks: hooksOf(settings),
      mcpServers: mcpServersOf(settings),
      commands: commandsOf(settings),
    };
  } catch (e) {
    return unreadable(
      `it could not be inspected: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
