#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rejects typographic dashes on lines a commit is adding.
 *
 * The rule is that the tree uses a hyphen, not U+2014 or U+2013. Most of the
 * existing tree predates it, so this reads only the added lines of a diff and
 * leaves the backlog alone; it is tracked in Qwen-Code-Remote#76.
 *
 * Code that has to name the character writes it as an escape, which is what
 * this file does for its own pattern. Generated and vendored files are exempt
 * because nobody is typing their contents.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Escapes, not literals: this file must pass its own check.
const DASH_PATTERN = /[\u2014\u2013]/;
const DASH_NAMES = new Map([
  ['\u2014', 'em dash'],
  ['\u2013', 'en dash'],
]);

// Contents nobody types by hand: resolved dependencies, committed snapshots,
// minified bundles, and build output.
const EXEMPT_PATTERNS = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /\.snap$/,
  /\.min\.(js|css|mjs|cjs)$/,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
];

export function isExempt(path) {
  return EXEMPT_PATTERNS.some((pattern) => pattern.test(path));
}

function unquote(rawPath) {
  if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
    try {
      return JSON.parse(rawPath);
    } catch {
      return rawPath.slice(1, -1);
    }
  }
  return rawPath;
}

/**
 * Reads the added lines out of a unified diff.
 *
 * Only `+` rows count, so a commit that touches a neighbouring line of a file
 * full of pre-existing dashes is not blamed for them. Line numbers come from
 * the hunk header and advance on every row that is not a deletion.
 */
export function findDashViolations(diffText) {
  const violations = [];
  let currentPath = null;
  let lineNumber = 0;

  for (const row of diffText.split('\n')) {
    if (row.startsWith('+++ ')) {
      const target = row.slice(4).trim();
      currentPath =
        target === '/dev/null' ? null : unquote(target.replace(/^b\//, ''));
      continue;
    }

    if (row.startsWith('@@')) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      lineNumber = header ? Number(header[1]) : 0;
      continue;
    }

    if (currentPath === null || row.startsWith('-')) {
      continue;
    }

    const isAdded = row.startsWith('+');
    if (!isAdded) {
      lineNumber += 1;
      continue;
    }

    const text = row.slice(1);
    if (!isExempt(currentPath)) {
      const found = [...text].filter((char) => DASH_PATTERN.test(char));
      if (found.length > 0) {
        violations.push({
          path: currentPath,
          line: lineNumber,
          kinds: [...new Set(found.map((char) => DASH_NAMES.get(char)))],
          text: text.trim().slice(0, 200),
        });
      }
    }
    lineNumber += 1;
  }

  return violations;
}

function readStagedDiff() {
  return execFileSync(
    'git',
    [
      'diff',
      '--cached',
      '--no-color',
      '--no-ext-diff',
      '-U0',
      '--diff-filter=ACMR',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

export function formatViolations(violations) {
  const lines = violations.map(
    (violation) =>
      `  ${violation.path}:${violation.line}: ${violation.kinds.join(', ')}\n    ${violation.text}`,
  );
  lines.push(
    '',
    'Use a hyphen instead. Where code has to name the character, write it as',
    'an escape (\\u2014, \\u2013) rather than the literal.',
  );
  return lines.join('\n');
}

export function main({ diff = readStagedDiff() } = {}) {
  const violations = findDashViolations(diff);
  if (violations.length === 0) {
    return 0;
  }
  console.error(
    `Found ${violations.length} added line(s) with a typographic dash:\n`,
  );
  console.error(formatViolations(violations));
  return 1;
}

/**
 * Proves this file holds no literal dash, so it can never trip the check it
 * enforces. Kept as a function rather than a top-level throw so importing the
 * checker for a test cannot abort the test run.
 */
export function selfIsClean() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  return !source
    .split('\n')
    .some((line) => line.includes('\u2014') || line.includes('\u2013'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
