/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_ATTACHMENT_MAX_ITEM_BYTES,
  SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV,
  SESSION_ATTACHMENT_MAX_STAGED_BYTES,
  getSessionAttachmentMaxItemBytes,
  resolveSessionAttachmentMaxItemBytes,
} from './sessionAttachmentLimits.js';
import { SessionAttachmentStore } from './sessionAttachments.js';

const MIB = 1024 * 1024;

describe('resolveSessionAttachmentMaxItemBytes', () => {
  it('defaults to 32 MiB when the variable is unset or blank', () => {
    expect(DEFAULT_SESSION_ATTACHMENT_MAX_ITEM_BYTES).toBe(32 * MIB);
    expect(resolveSessionAttachmentMaxItemBytes({})).toBe(32 * MIB);
    expect(
      resolveSessionAttachmentMaxItemBytes({
        [SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV]: '  ',
      }),
    ).toBe(32 * MIB);
  });

  it('reads a positive integer from QWEN_SESSION_ATTACHMENT_MAX_ITEM_BYTES', () => {
    expect(SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV).toBe(
      'QWEN_SESSION_ATTACHMENT_MAX_ITEM_BYTES',
    );
    expect(
      resolveSessionAttachmentMaxItemBytes({
        QWEN_SESSION_ATTACHMENT_MAX_ITEM_BYTES: String(64 * MIB),
      }),
    ).toBe(64 * MIB);
  });

  it('accepts exactly the staged budget', () => {
    expect(SESSION_ATTACHMENT_MAX_STAGED_BYTES).toBe(128 * MIB);
    expect(
      resolveSessionAttachmentMaxItemBytes({
        QWEN_SESSION_ATTACHMENT_MAX_ITEM_BYTES: String(128 * MIB),
      }),
    ).toBe(128 * MIB);
  });

  it.each(['0', '-1', '1.5', 'abc', '1e3', String(128 * MIB + 1)])(
    'rejects %j',
    (value) => {
      expect(() =>
        resolveSessionAttachmentMaxItemBytes({
          QWEN_SESSION_ATTACHMENT_MAX_ITEM_BYTES: value,
        }),
      ).toThrow(/QWEN_SESSION_ATTACHMENT_MAX_ITEM_BYTES/);
    },
  );
});

describe('session attachment checks follow the configured cap', () => {
  const original = process.env[SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV];
  afterEach(() => {
    if (original === undefined) {
      delete process.env[SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV];
    } else {
      process.env[SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV] = original;
    }
  });

  it('getSessionAttachmentMaxItemBytes reads process.env', () => {
    delete process.env[SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV];
    expect(getSessionAttachmentMaxItemBytes()).toBe(32 * MIB);
    process.env[SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV] = String(10 * MIB);
    expect(getSessionAttachmentMaxItemBytes()).toBe(10 * MIB);
  });

  it('createUpload accepts 32 MiB by default and rejects one byte more', () => {
    delete process.env[SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV];
    const store = new SessionAttachmentStore();
    try {
      const upload = store.createUpload({
        name: 'ok.bin',
        mimeType: 'application/octet-stream',
        size: 32 * MIB,
      });
      expect(upload).toBeDefined();
      expect(() =>
        store.createUpload({
          name: 'big.bin',
          mimeType: 'application/octet-stream',
          size: 32 * MIB + 1,
        }),
      ).toThrow(/32 MiB/);
    } finally {
      void store.close();
    }
  });

  it('createUpload honors a lowered cap and names it', () => {
    process.env[SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV] = String(2 * MIB);
    const store = new SessionAttachmentStore();
    try {
      expect(() =>
        store.createUpload({
          name: 'big.bin',
          mimeType: 'application/octet-stream',
          size: 2 * MIB + 1,
        }),
      ).toThrow(/at most 2 MiB/);
    } finally {
      void store.close();
    }
  });

  it('putAttachment accepts exactly the cap and rejects one byte more', async () => {
    process.env[SESSION_ATTACHMENT_MAX_ITEM_BYTES_ENV] = String(1 * MIB);
    const store = new SessionAttachmentStore();
    try {
      await expect(
        store.putAttachment(
          new Uint8Array(1 * MIB + 1),
          'application/octet-stream',
          'big.bin',
        ),
      ).rejects.toThrow(RangeError);
      await expect(
        store.putAttachment(
          new Uint8Array(1 * MIB),
          'application/octet-stream',
          'ok.bin',
        ),
      ).resolves.toMatchObject({ size: 1 * MIB });
    } finally {
      await store.close();
    }
  });
});
