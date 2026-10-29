/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Total bytes of chunk uploads that may be staged at once, daemon-wide. */
export const SESSION_ATTACHMENT_MAX_STAGED_BYTES = 128 * 1024 * 1024;

/** Per-attachment cap when `QWEN_SESSION_ATTACHMENT_MAX_ITEM_BYTES` is unset. */
export const DEFAULT_SESSION_ATTACHMENT_MAX_ITEM_BYTES = 32 * 1024 * 1024;

/** Environment variable that sets the per-attachment cap at daemon start. */
export const SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV =
  'QWEN_SESSION_ATTACHMENT_MAX_ITEM_BYTES';

/**
 * Resolve the per-attachment byte cap from an environment. Unset or blank
 * gives the default. Anything else must be a positive safe integer written in
 * plain decimal digits and no larger than the staged-upload budget, because a
 * single chunked upload has to fit in that budget.
 */
export function resolveSessionAttachmentMaxItemBytes(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env[SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV]?.trim();
  if (raw === undefined || raw === '') {
    return DEFAULT_SESSION_ATTACHMENT_MAX_ITEM_BYTES;
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > SESSION_ATTACHMENT_MAX_STAGED_BYTES
  ) {
    throw new TypeError(
      `Invalid ${SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV}: ${raw}. ` +
        `Must be a positive integer of at most ${SESSION_ATTACHMENT_MAX_STAGED_BYTES} bytes (the staged upload budget).`,
    );
  }
  return value;
}

/** The daemon's current per-attachment cap, read from `process.env`. */
export function getSessionAttachmentMaxItemBytes(): number {
  return resolveSessionAttachmentMaxItemBytes(process.env);
}

/** "32 MiB" for whole mebibytes, otherwise "<n> bytes". */
export function formatSessionAttachmentLimit(bytes: number): string {
  const mib = 1024 * 1024;
  return bytes % mib === 0 ? `${bytes / mib} MiB` : `${bytes} bytes`;
}
