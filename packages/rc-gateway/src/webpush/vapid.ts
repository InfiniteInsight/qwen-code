/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createECDH, createPrivateKey, type JsonWebKey } from 'node:crypto';
import webpush from 'web-push';
import { readFile, rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { writeFileAtomic } from '../atomicWrite.js';

export interface VapidKeys {
  /** Base64url-encoded uncompressed P-256 public key (65 bytes). For browsers. */
  publicKey: string;
  /** Base64url-encoded raw P-256 private key scalar (32 bytes). For web-push. */
  privateKey: string;
}

/**
 * Convert a PEM EC private key string to a raw base64url private scalar and
 * the corresponding uncompressed public key (base64url). Accepts any PEM that
 * Node.js `createPrivateKey` can parse (SEC1 / PKCS8 / raw).
 */
function pemToVapidKeys(pem: string): VapidKeys {
  const privKey = createPrivateKey({ key: pem, format: 'pem' });
  const privJwk = privKey.export({ format: 'jwk' }) as {
    d?: string;
    x?: string;
    y?: string;
  };
  if (!privJwk.d || !privJwk.x || !privJwk.y) {
    throw new Error('PEM key missing JWK d/x/y components');
  }
  // Private key scalar (base64url, 32 bytes)
  const privateKey = privJwk.d;
  // Public key: uncompressed ECDH point (04 || x || y = 65 bytes), base64url
  const ecdh = createECDH('prime256v1');
  const dBytes = Buffer.from(privJwk.d, 'base64url');
  ecdh.setPrivateKey(dBytes);
  const publicKey = ecdh
    .getPublicKey(null, 'uncompressed')
    .toString('base64url');
  return { publicKey, privateKey };
}

/**
 * Generate a new VAPID keypair and return { pem, publicKey, privateKey }.
 * The PEM is the private key in SEC1 format (-----BEGIN EC PRIVATE KEY-----).
 */
function generateVapidPem(): { pem: string } & VapidKeys {
  const keys = webpush.generateVAPIDKeys();
  // webpush gives us base64url raw key material; convert to PEM via JWK
  const ecdh = createECDH('prime256v1');
  const dBytes = Buffer.from(keys.privateKey, 'base64url');
  ecdh.setPrivateKey(dBytes);
  const privJwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: keys.privateKey,
    x: Buffer.from(
      ecdh.getPublicKey(null, 'uncompressed').subarray(1, 33),
    ).toString('base64url'),
    y: Buffer.from(
      ecdh.getPublicKey(null, 'uncompressed').subarray(33, 65),
    ).toString('base64url'),
  };
  const privKey = createPrivateKey({ key: privJwk, format: 'jwk' });
  const pem = privKey.export({ type: 'sec1', format: 'pem' }) as string;
  return { pem, publicKey: keys.publicKey, privateKey: keys.privateKey };
}

/**
 * Credential-key redaction pattern. It lives with the payload builder, which
 * applies it to every push (#169); re-exported here for existing importers.
 */
export { CREDENTIAL_REDACT_RE } from './payload.js';

/**
 * Gateway-owned VAPID keypair. Stored as a PEM private key file at mode 0600
 * (the private key is a secret). The public key is derived from the private key
 * at load time, so no public key file needs to be persisted.
 *
 * Rotation: call `rotate()` to generate a new keypair and purge all push
 * subscriptions (they are bound to the public key). The `vapid_rotated` event
 * is emitted on the provided audit bus after a successful rotation.
 */
export class VapidStore {
  private constructor(
    private keys: VapidKeys,
    private readonly subject: string,
    private readonly filePath: string,
  ) {}

  static async open(filePath: string, subject?: string): Promise<VapidStore> {
    // Only a MISSING file means "first run, generate a key" (#169). Any other
    // read error (EACCES, EIO, EMFILE, ...) says nothing about the key on disk,
    // and regenerating would overwrite it and orphan every browser
    // subscription bound to it, so the open fails loudly instead.
    let raw: string | undefined;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          `VAPID key: could not read ${filePath} (${(err as Error).message}); ` +
            'refusing to replace the key',
        );
      }
    }

    let keys: VapidKeys | undefined;
    if (raw !== undefined) {
      try {
        // Support both formats:
        // 1. PEM (new format): starts with -----BEGIN
        // 2. JSON (legacy format): { publicKey, privateKey } base64url
        if (raw.trim().startsWith('-----BEGIN')) {
          keys = pemToVapidKeys(raw);
        } else {
          // Legacy JSON format: still readable for migration
          const parsed = JSON.parse(raw) as Partial<VapidKeys>;
          if (
            typeof parsed.publicKey === 'string' &&
            parsed.publicKey.length > 0 &&
            typeof parsed.privateKey === 'string' &&
            parsed.privateKey.length > 0
          ) {
            keys = {
              publicKey: parsed.publicKey,
              privateKey: parsed.privateKey,
            };
          }
        }
      } catch {
        // Unparseable: regenerated below.
      }
      if (keys && !raw.trim().startsWith('-----BEGIN')) {
        // Migrate the legacy JSON key to PEM. Best effort: the legacy file
        // still holds the same key if this write fails.
        await VapidStore.writePem(filePath, keys).catch(() => {});
      }
      if (!keys) {
        // The file exists and holds no usable key. Keep it aside rather than
        // overwrite it below, as the JSON stores do (#165).
        const aside = `${filePath}.corrupt-${Date.now()}`;
        const moved = await rename(filePath, aside).then(
          () => true,
          () => false,
        );
        // eslint-disable-next-line no-console
        console.warn(
          `VAPID key: ${filePath} holds no usable key, generating a new one` +
            (moved ? `; the unreadable file was kept as ${aside}` : ''),
        );
      }
    }

    if (!keys) {
      const generated = generateVapidPem();
      keys = {
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
      };
      await VapidStore.writePem(filePath, keys);
    }

    const resolvedSubject =
      subject ??
      process.env.QWEN_RC_WEBPUSH_SUBJECT ??
      `mailto:noreply@${hostname()}`;
    return new VapidStore(keys, resolvedSubject, filePath);
  }

  /**
   * Write the PEM private key for the given keys to filePath at mode 0600.
   * Crash-safe (temp file + rename, #169): an in-place write cut short left a
   * partial file, which the next open could only treat as corrupt and replace.
   */
  private static async writePem(
    filePath: string,
    keys: VapidKeys,
  ): Promise<void> {
    // Convert base64url private key to PEM for storage
    const ecdh = createECDH('prime256v1');
    const dBytes = Buffer.from(keys.privateKey, 'base64url');
    ecdh.setPrivateKey(dBytes);
    const pubBytes = ecdh.getPublicKey(null, 'uncompressed');
    const privJwk: JsonWebKey = {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: pubBytes.subarray(1, 33).toString('base64url'),
      y: pubBytes.subarray(33, 65).toString('base64url'),
    };
    const privKey = createPrivateKey({ key: privJwk, format: 'jwk' });
    const pem = privKey.export({ type: 'sec1', format: 'pem' }) as string;
    await writeFileAtomic(filePath, pem, { mode: 0o600 });
  }

  /**
   * Rotate the VAPID keypair: generate a new keypair, persist it, and return
   * the new public key. Callers MUST purge all push subscriptions after this
   * (they are bound to the old public key). Emits audit events via `onRotated`.
   */
  async rotate(opts?: {
    onRotated?: (newPublicKey: string, oldPublicKey: string) => void;
  }): Promise<string> {
    const oldPublicKey = this.keys.publicKey;
    const generated = generateVapidPem();
    const newKeys: VapidKeys = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    };
    await VapidStore.writePem(this.filePath, newKeys);
    this.keys = newKeys;
    opts?.onRotated?.(newKeys.publicKey, oldPublicKey);
    return newKeys.publicKey;
  }

  /** Base64url public key handed to clients for pushManager.subscribe(). */
  getApplicationServerKey(): string {
    return this.keys.publicKey;
  }

  /** Full keypair, including the private key (for the cycle-9 sender only). */
  getKeys(): VapidKeys {
    return this.keys;
  }

  /** mailto:/https: subject used by the sender (cycle 9). */
  getSubject(): string {
    return this.subject;
  }
}
