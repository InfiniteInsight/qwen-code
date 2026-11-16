/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isInternalSecretEnvVar } from './sanitize-child-env.js';

export interface ResolveEnvVarsOptions {
  /**
   * Whether a variable that `customEnv` does not define is taken from
   * `process.env`. Defaults to true.
   */
  readonly processEnvFallback?: boolean;
}

/**
 * Resolves environment variables in a string.
 * Replaces $VAR_NAME and ${VAR_NAME} with their corresponding environment variable values.
 * If the environment variable is not defined, the original placeholder is preserved.
 *
 * Qwen-internal secrets (see `INTERNAL_SECRET_ENV_VARS`) are never
 * substituted, from `process.env` or from `customEnv`: the settings and
 * extension files this resolves can come from a repository, and a resolved
 * value is baked into hook commands, URLs or MCP configs before child-env
 * sanitization ever applies. Their placeholders are preserved exactly like
 * an unset variable's.
 * Session-ID placeholders are also reserved for per-request custom header
 * expansion, including bare, braced, and case-insensitive spellings.
 *
 * @param value - The string that may contain environment variable placeholders
 * @param customEnv - Variables consulted before `process.env`
 * @param options - Whether `process.env` is consulted at all
 * @returns The string with environment variables resolved
 *
 * @example
 * resolveEnvVarsInString("Token: $API_KEY") // Returns "Token: secret-123"
 * resolveEnvVarsInString("URL: ${BASE_URL}/api") // Returns "URL: https://api.example.com/api"
 * resolveEnvVarsInString("Missing: $UNDEFINED_VAR") // Returns "Missing: $UNDEFINED_VAR"
 */
function isWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

function isDotenvKeyChar(code: number): boolean {
  return isWordChar(code) || code === 0x2e || code === 0x2d;
}

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x2028 || code === 0x2029;
}

function isDotenvSpace(code: number): boolean {
  if (code <= 0x20) {
    return (
      code === 0x20 ||
      code === 0x0a ||
      code === 0x09 ||
      code === 0x0d ||
      code === 0x0b ||
      code === 0x0c
    );
  }
  return (
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function skipHorizontalSpaces(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (isLineTerminator(c) || !isDotenvSpace(c)) break;
    i++;
  }
  return i;
}

function skipSpacesTrackingNewline(
  text: string,
  from: number,
): { pos: number; crossedNewline: boolean } {
  let i = from;
  let crossedNewline = false;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (!isDotenvSpace(c)) break;
    if (isLineTerminator(c)) crossedNewline = true;
    i++;
  }
  return { pos: i, crossedNewline };
}

function advancePastLine(text: string, from: number): number {
  let i = from;
  while (i < text.length && !isLineTerminator(text.charCodeAt(i))) {
    i++;
  }
  return i < text.length ? i + 1 : i;
}

function hasValidQuoteTail(text: string, afterClose: number): boolean {
  const h = skipHorizontalSpaces(text, afterClose);
  if (h === text.length) return true;
  const c = text.charCodeAt(h);
  return isLineTerminator(c) || c === 0x23;
}

function advancePastQuoteTail(text: string, afterClose: number): number {
  const h = skipHorizontalSpaces(text, afterClose);
  if (h === text.length) return h;
  if (text.charCodeAt(h) === 0x23) {
    return advancePastLine(text, h + 1);
  }
  return h + 1;
}

interface QuoteScanState {
  cursor: number;
  firstUnescaped: number;
  validCloses: number[];
  head: number;
}

function findQuotedClose(
  text: string,
  qPos: number,
  quoteCode: number,
  state: QuoteScanState,
): number {
  const len = text.length;
  while (state.head < state.validCloses.length && state.validCloses[state.head]! <= qPos) {
    state.head++;
  }
  while (state.firstUnescaped <= qPos && state.cursor < len) {
    if (state.cursor <= qPos) {
      state.cursor = qPos + 1;
    }
    while (state.cursor < len) {
      if (text.charCodeAt(state.cursor) === quoteCode) {
        if (hasValidQuoteTail(text, state.cursor + 1)) {
          state.validCloses.push(state.cursor);
        }
        if (text.charCodeAt(state.cursor - 1) !== 0x5c) {
          state.firstUnescaped = state.cursor;
          state.cursor++;
          break;
        }
      }
      state.cursor++;
    }
  }
  return state.head < state.validCloses.length
    ? state.validCloses[state.validCloses.length - 1]!
    : -1;
}

function tryMatchKeyAndSep(
  text: string,
  start: number,
):
  | { matched: true; key: string; valStart: number }
  | { matched: false; nextPos: number } {
  const len = text.length;
  if (start >= len || !isDotenvKeyChar(text.charCodeAt(start))) {
    return { matched: false, nextPos: advancePastLine(text, start) };
  }
  let keyEnd = start + 1;
  while (keyEnd < len && isDotenvKeyChar(text.charCodeAt(keyEnd))) {
    keyEnd++;
  }
  if (
    keyEnd + 1 < len &&
    text.charCodeAt(keyEnd) === 0x3a &&
    isDotenvSpace(text.charCodeAt(keyEnd + 1))
  ) {
    return {
      matched: true,
      key: text.slice(start, keyEnd),
      valStart: keyEnd + 2,
    };
  }
  const ws = skipSpacesTrackingNewline(text, keyEnd);
  if (ws.pos < len && text.charCodeAt(ws.pos) === 0x3d) {
    return {
      matched: true,
      key: text.slice(start, keyEnd),
      valStart: ws.pos + 1,
    };
  }
  return {
    matched: false,
    nextPos: ws.crossedNewline ? ws.pos : advancePastLine(text, ws.pos),
  };
}

function finalizeDotenvValue(rawTrimmed: string): string {
  let value = rawTrimmed;
  const maybeQuote = value[0];
  if (
    value.length >= 2 &&
    (maybeQuote === "'" || maybeQuote === '"' || maybeQuote === '`') &&
    value[value.length - 1] === maybeQuote
  ) {
    value = value.slice(1, -1);
  } else if (
    value.indexOf('\u2028') !== -1 ||
    value.indexOf('\u2029') !== -1
  ) {
    // Match dotenv's multiline quote-stripping pass on unquoted lines that
    // embed U+2028/U+2029 line separators without backtracking across lines.
    value = value
      .split(/([\u2028\u2029])/)
      .map((seg) => {
        const q = seg[0];
        if (
          seg.length >= 2 &&
          (q === "'" || q === '"' || q === '`') &&
          seg[seg.length - 1] === q
        ) {
          return seg.slice(1, -1);
        }
        return seg;
      })
      .join('');
  }
  if (maybeQuote === '"') {
    value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  }
  return value;
}

/**
 * Linear-time `.env` parser matching `dotenv.parse` semantics without regex
 * backtracking. `dotenv`'s multiline `LINE` regex lets its leading `\s*` cross
 * newlines, causing quadratic rescans on blank-line runs (minutes on a 1 MiB
 * `.env`). This scanner visits each character a bounded constant number of
 * times (`O(n)`).
 */
export function parseDotenv(
  src: string | { toString(encoding?: BufferEncoding): string },
): Record<string, string> {
  const obj: Record<string, string> = {};
  const raw = typeof src === 'string' ? src : src.toString('utf8');
  const text = raw.replace(/\r\n?/g, '\n');
  const len = text.length;

  const quoteStates: Record<number, QuoteScanState> = {
    0x27: { cursor: 0, firstUnescaped: -1, validCloses: [], head: 0 },
    0x22: { cursor: 0, firstUnescaped: -1, validCloses: [], head: 0 },
    0x60: { cursor: 0, firstUnescaped: -1, validCloses: [], head: 0 },
  };

  let pos = 0;
  while (pos < len) {
    pos = skipSpacesTrackingNewline(text, pos).pos;
    if (pos >= len) break;

    let key: string | undefined;
    let valStart = -1;

    if (
      pos + 6 < len &&
      text.startsWith('export', pos) &&
      isDotenvSpace(text.charCodeAt(pos + 6))
    ) {
      const afterExport = skipSpacesTrackingNewline(text, pos + 6);
      const exported = tryMatchKeyAndSep(text, afterExport.pos);
      if (exported.matched) {
        key = exported.key;
        valStart = exported.valStart;
      } else if (
        afterExport.pos < len &&
        text.charCodeAt(afterExport.pos) === 0x3d
      ) {
        key = 'export';
        valStart = afterExport.pos + 1;
      } else {
        pos = afterExport.crossedNewline
          ? afterExport.pos
          : advancePastLine(text, afterExport.pos);
        continue;
      }
    } else {
      const direct = tryMatchKeyAndSep(text, pos);
      if (!direct.matched) {
        pos = direct.nextPos;
        continue;
      }
      key = direct.key;
      valStart = direct.valStart;
    }

    const qWs = skipSpacesTrackingNewline(text, valStart);
    if (qWs.pos < len) {
      const qCode = text.charCodeAt(qWs.pos);
      const qState = quoteStates[qCode];
      if (qState !== undefined) {
        const closeIdx = findQuotedClose(text, qWs.pos, qCode, qState);
        if (closeIdx !== -1) {
          obj[key] = finalizeDotenvValue(text.slice(qWs.pos, closeIdx + 1));
          pos = advancePastQuoteTail(text, closeIdx + 1);
          continue;
        }
      }
    }

    if (valStart < len) {
      const first = text.charCodeAt(valStart);
      if (first !== 0x23 && first !== 0x0a) {
        let valEnd = valStart + 1;
        while (valEnd < len) {
          const c = text.charCodeAt(valEnd);
          if (c === 0x23 || c === 0x0a) break;
          valEnd++;
        }
        obj[key] = finalizeDotenvValue(text.slice(valStart, valEnd).trim());
        if (valEnd < len && text.charCodeAt(valEnd) === 0x23) {
          pos = advancePastLine(text, valEnd + 1);
        } else {
          pos = valEnd < len ? valEnd + 1 : len;
        }
        continue;
      }
      if (first === 0x23) {
        obj[key] = '';
        pos = advancePastLine(text, valStart + 1);
        continue;
      }
    }

    obj[key] = '';
    pos = valStart < len ? valStart + 1 : len;
  }

  return obj;
}

function lookupEnvVarReplacement(
  varName: string,
  customEnv: Record<string, string> | undefined,
  options: ResolveEnvVarsOptions,
): string | undefined {
  const normalizedVarName = varName.toUpperCase();
  if (
    normalizedVarName === 'SESSION_ID' ||
    normalizedVarName === 'QWEN_CODE_SESSION_ID' ||
    isInternalSecretEnvVar(varName)
  ) {
    return undefined;
  }
  if (customEnv && typeof customEnv[varName] === 'string') {
    return customEnv[varName];
  }
  if (
    options.processEnvFallback !== false &&
    process &&
    process.env &&
    typeof process.env[varName] === 'string'
  ) {
    return process.env[varName];
  }
  return undefined;
}

export function resolveEnvVarsInString(
  value: string,
  customEnv?: Record<string, string>,
  options: ResolveEnvVarsOptions = {},
): string {
  // Single-pass scan matching /\$(?:(\w+)|{([^}]+)})/g without quadratic
  // rescanning on runs of unclosed `${` (next `}` is found once and reused).
  let i = value.indexOf('$');
  if (i === -1) return value;

  let out = '';
  let lastIndex = 0;
  let nextCloseBrace = -2; // -2 = not searched yet, -1 = none remaining

  while (i !== -1) {
    const next = value.charCodeAt(i + 1);
    if (isWordChar(next)) {
      let end = i + 2;
      while (end < value.length && isWordChar(value.charCodeAt(end))) {
        end++;
      }
      const replacement = lookupEnvVarReplacement(
        value.slice(i + 1, end),
        customEnv,
        options,
      );
      if (replacement !== undefined) {
        out += value.slice(lastIndex, i) + replacement;
        lastIndex = end;
      }
      i = value.indexOf('$', end);
      continue;
    }

    if (next === 0x7b) {
      if (nextCloseBrace !== -1 && nextCloseBrace < i + 2) {
        nextCloseBrace = value.indexOf('}', i + 2);
      }
      if (nextCloseBrace > i + 2) {
        const end = nextCloseBrace + 1;
        const replacement = lookupEnvVarReplacement(
          value.slice(i + 2, nextCloseBrace),
          customEnv,
          options,
        );
        if (replacement !== undefined) {
          out += value.slice(lastIndex, i) + replacement;
          lastIndex = end;
        }
        i = value.indexOf('$', end);
        continue;
      }
    }

    i = value.indexOf('$', i + 1);
  }

  if (lastIndex === 0) return value;
  return out + value.slice(lastIndex);
}

/**
 * Recursively resolves environment variables in an object of any type.
 * Handles strings, arrays, nested objects, and preserves other primitive types.
 * Protected against circular references using a WeakSet to track visited objects.
 *
 * @param obj - The object to process for environment variable resolution
 * @returns A new object with environment variables resolved
 *
 * @example
 * const config = {
 *   server: {
 *     host: "$HOST",
 *     port: "${PORT}",
 *     enabled: true,
 *     tags: ["$ENV", "api"]
 *   }
 * };
 * const resolved = resolveEnvVarsInObject(config);
 */
export function resolveEnvVarsInObject<T>(
  obj: T,
  customEnv?: Record<string, string>,
  options: ResolveEnvVarsOptions = {},
): T {
  return resolveEnvVarsInObjectInternal(obj, new WeakSet(), customEnv, options);
}

/**
 * Internal implementation of resolveEnvVarsInObject with circular reference protection.
 *
 * @param obj - The object to process
 * @param visited - WeakSet to track visited objects and prevent circular references
 * @returns A new object with environment variables resolved
 */
function resolveEnvVarsInObjectInternal<T>(
  obj: T,
  visited: WeakSet<object>,
  customEnv: Record<string, string> | undefined,
  options: ResolveEnvVarsOptions,
): T {
  if (
    obj === null ||
    obj === undefined ||
    typeof obj === 'boolean' ||
    typeof obj === 'number'
  ) {
    return obj;
  }

  if (typeof obj === 'string') {
    return resolveEnvVarsInString(obj, customEnv, options) as unknown as T;
  }

  if (Array.isArray(obj)) {
    // Check for circular reference
    if (visited.has(obj)) {
      // Return a shallow copy to break the cycle
      return [...obj] as unknown as T;
    }

    visited.add(obj);
    const result = obj.map((item) =>
      resolveEnvVarsInObjectInternal(item, visited, customEnv, options),
    ) as unknown as T;
    visited.delete(obj);
    return result;
  }

  if (typeof obj === 'object') {
    // Check for circular reference
    if (visited.has(obj as object)) {
      // Return a shallow copy to break the cycle
      return { ...obj } as T;
    }

    visited.add(obj as object);
    const newObj = { ...obj } as T;
    for (const key in newObj) {
      if (Object.prototype.hasOwnProperty.call(newObj, key)) {
        newObj[key] = resolveEnvVarsInObjectInternal(
          newObj[key],
          visited,
          customEnv,
          options,
        );
      }
    }
    visited.delete(obj as object);
    return newObj;
  }

  return obj;
}
