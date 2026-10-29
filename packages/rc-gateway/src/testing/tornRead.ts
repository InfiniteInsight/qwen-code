/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';

/**
 * Read `path` on every event-loop turn while `start()`'s write is in flight
 * and report what a crash at that moment would have left behind (#165).
 *
 * An in-place `writeFile` truncates the target first and writes it in
 * chunks, one event-loop turn per chunk, so a reader between turns sees an
 * empty or partial file: exactly what `open()` would load after a crash
 * there. A temp-and-rename write never touches the target until the rename,
 * so every read sees a whole old or whole new file.
 *
 * `accept(text)` says whether one observation is a complete file. The target
 * must already exist before `start()` is called (a missing file counts as a
 * torn observation).
 */
export async function observeDuringWrite(
  path: string,
  start: () => Promise<unknown>,
  accept: (text: string) => boolean,
): Promise<{ reads: number; torn: number }> {
  let done = false;
  let failure: unknown;
  const running = start().then(
    () => {
      done = true;
    },
    (err) => {
      done = true;
      failure = err;
    },
  );
  let reads = 0;
  let torn = 0;
  while (!done) {
    reads++;
    try {
      if (!accept(readFileSync(path, 'utf8'))) torn++;
    } catch {
      torn++;
    }
    await new Promise((r) => setImmediate(r));
  }
  await running;
  if (failure) throw failure;
  return { reads, torn };
}

/** `accept` for a JSON store: the file parses. */
export function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** A payload big enough that an in-place write spans many event-loop turns. */
export const BIG = 'x'.repeat(8 * 1024 * 1024);
