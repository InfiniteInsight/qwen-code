/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Read a JSON store file for `open()`. A missing file is the normal first
 * run and returns undefined quietly. A file that exists but does not parse
 * is not: the store is about to start empty and its next save would replace
 * the evidence. So it is logged and renamed aside to
 * `<file>.corrupt-<epoch ms>` before undefined is returned (#165).
 */
export async function readJsonStore(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.warn(`store: could not read ${filePath}, starting empty:`, err);
    }
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const aside = `${filePath}.corrupt-${Date.now()}`;
    let moved = false;
    try {
      await rename(filePath, aside);
      moved = true;
    } catch {
      // keep going: starting empty is still better than not starting
    }
    // eslint-disable-next-line no-console
    console.warn(
      `store: ${filePath} is not valid JSON, starting empty` +
        (moved ? `; the unreadable file was kept as ${aside}` : ''),
    );
    return undefined;
  }
}

/**
 * Crash-safe whole-file replacement for the gateway's JSON stores (#165).
 *
 * The stores used to `writeFile` in place: the file is truncated first and
 * then written, so a crash (or ENOSPC) part way through left a partial file,
 * `open()` failed to parse it and started empty, and every paired device was
 * gone. This follows `walEpoch.ts`: write a sibling temp file, then rename it
 * over the target. A rename within one directory is atomic, so the target
 * always holds either the old bytes or the new ones. The temp file is fsynced
 * before the rename so the new bytes are on disk before the name points at
 * them.
 *
 * Writes to one path are serialized in call order, and coalesced: while one
 * write is running, later calls for the same path collapse into a single
 * follow-up write carrying the newest data. A burst of N persists therefore
 * costs at most two file writes, and the file always ends with the last
 * call's content. Every caller's promise settles when a write that includes
 * its data has landed (or failed).
 */

/** Data to write, or a thunk producing it when the write actually starts. */
export type AtomicData = string | Buffer | (() => string | Buffer);

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface PathState {
  running: boolean;
  pending: { data: AtomicData; mode: number; waiters: Waiter[] } | null;
}

const states = new Map<string, PathState>();

export async function writeFileAtomic(
  filePath: string,
  data: AtomicData,
  opts: { mode?: number } = {},
): Promise<void> {
  const mode = opts.mode ?? 0o600;
  let state = states.get(filePath);
  if (!state) {
    state = { running: false, pending: null };
    states.set(filePath, state);
  }
  return new Promise<void>((resolve, reject) => {
    const s = state!;
    if (s.pending) {
      // Newer data supersedes the queued write; everyone waits on it.
      s.pending.data = data;
      s.pending.mode = mode;
      s.pending.waiters.push({ resolve, reject });
    } else {
      s.pending = { data, mode, waiters: [{ resolve, reject }] };
    }
    if (!s.running) void drain(filePath, s);
  });
}

async function drain(filePath: string, state: PathState): Promise<void> {
  state.running = true;
  while (state.pending) {
    const job = state.pending;
    state.pending = null;
    try {
      const bytes = typeof job.data === 'function' ? job.data() : job.data;
      await replaceFile(filePath, bytes, job.mode);
      for (const w of job.waiters) w.resolve();
    } catch (err) {
      for (const w of job.waiters) w.reject(err);
    }
  }
  state.running = false;
  if (states.get(filePath) === state) states.delete(filePath);
}

async function replaceFile(
  filePath: string,
  bytes: string | Buffer,
  mode: number,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  // 'wx': never follow or reuse something already at the temp name.
  const fh = await open(tmp, 'wx', mode);
  try {
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
