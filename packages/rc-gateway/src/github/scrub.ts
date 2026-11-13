/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Child-process output passes through here before the gateway keeps it
 * (InfiniteInsight/Qwen-Code-Remote#257): a clone's progress lines and its
 * error must never carry the token it was handed.
 */

const MASK = '***';

// `x-access-token:<anything>@` up to the end of the line, the form git prints
// when it echoes a credentialled URL; then the same credential cut off before
// its `@` (a truncated line), so neither form survives.
const ACCESS_TOKEN_IN_URL = /x-access-token:[^@\r\n]*@/gi;
const ACCESS_TOKEN_CUT = /x-access-token:[^@\s]*/gi;

/**
 * Replaces every occurrence of each secret, and any `x-access-token:...@`
 * credential, with `***`. Secrets are matched as plain text, longest first, so
 * a secret that is a prefix of another cannot leave the other's tail behind.
 * Empty secrets are ignored.
 */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  const ordered = secrets
    .filter((s) => typeof s === 'string' && s.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of ordered) out = out.split(secret).join(MASK);
  return out.replace(ACCESS_TOKEN_IN_URL, MASK).replace(ACCESS_TOKEN_CUT, MASK);
}
