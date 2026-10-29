/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Host-local credentials: secrets the gateway mints for processes on its own
 * machine, running as the same user, that reach it over loopback. They are NOT
 * TokenStore tokens (a phone never holds one, and one never grants a phone
 * scope), so the routes they open mount BEFORE bearerResolve and check them
 * here instead. Two exist today: the hook ingest token (POST /rc/hooks/ingest)
 * and the host-attach token (POST /rc/host/attach, the `qwen-rc attach` CLI).
 *
 * One owner for the file handling and the request gate, so a third such
 * credential does not grow a third copy of either.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Load (or mint exactly once) a persistent host-local token. Minted on first
 * startup and kept across restarts, because a client that read it (a hook
 * config that interpolates it, a CLI that reads the file per call) must not
 * be invalidated by a gateway restart. Written 0600 inside a 0700 directory.
 */
export async function loadOrCreateLocalToken(
  filePath: string,
): Promise<string> {
  const existing = await readLocalToken(filePath);
  if (existing !== undefined) return existing;
  const token = randomBytes(32).toString('base64url');
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, token + '\n', { mode: 0o600 });
  return token;
}

/**
 * The client side: read a token the gateway minted, never minting one. A
 * missing, unreadable or empty file is `undefined`, so a caller can say "start
 * the gateway" instead of inventing a token the gateway would refuse.
 */
export async function readLocalToken(
  filePath: string,
): Promise<string | undefined> {
  try {
    const value = (await readFile(filePath, 'utf8')).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a peer address is loopback. Callers pass `forwardedPeer(req)`, not
 * `req.socket.remoteAddress`: behind the HTTP/2 front every request arrives
 * over a loopback hop, so the socket alone would read loopback for remote
 * browsers too (see tls/http2Front.ts). An unresolvable peer is not loopback.
 */
export function isLoopbackRemote(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/**
 * Constant-time comparison of an `Authorization: Bearer` header against a
 * host-local token. An empty expected token never matches, so a credential
 * that failed to load cannot turn into "any empty bearer gets in".
 */
export function bearerMatches(
  header: string | undefined,
  expected: string,
): boolean {
  if (expected.length === 0) return false;
  if (!header || !header.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7).trim(), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return got.length === want.length && timingSafeEqual(got, want);
}
