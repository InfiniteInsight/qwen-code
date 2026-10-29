/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';

const MIB = 1024 * 1024;
const ID = '12345678-1234-4234-8234-123456789abc';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function setup(capabilities: unknown) {
  const urls: string[] = [];
  let size = 0;
  const fetch = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/capabilities')) return json(capabilities);
      if (url.endsWith('/attachment-uploads')) {
        size = (JSON.parse(String(init.body)) as { size: number }).size;
        return json({ uploadId: ID }, 201);
      }
      if (url.includes('/chunks?'))
        return json({
          offset:
            Number(new URL(url).searchParams.get('offset')) +
            (init.body as Blob).size,
        });
      return json({
        type: 'resource',
        attachmentId: 'file.bin',
        mimeType: 'application/octet-stream',
        size,
      });
    },
  );
  const client = new DaemonClient({
    baseUrl: 'http://daemon',
    token: 'secret',
    fetch: fetch as typeof globalThis.fetch,
  });
  const upload = (data: Blob) =>
    client.uploadSessionAttachment(
      'session-1',
      data,
      'file.bin',
      'application/octet-stream',
    );
  return { upload, urls };
}

const blobOf = (bytes: number) => new Blob([new Uint8Array(bytes)]);
const withCap = (cap?: number) => ({
  features: ['session_attachment_chunk_upload', 'session_attachments'],
  ...(cap === undefined
    ? {}
    : { limits: { maxSessionAttachmentItemBytes: cap } }),
});

describe('DaemonClient.uploadSessionAttachment per-item cap', () => {
  it('rejects above the daemon-advertised cap and names it', async () => {
    const { upload, urls } = setup(withCap(1 * MIB));
    await expect(upload(blobOf(1 * MIB + 1))).rejects.toThrow(
      new RangeError('Session attachments must not exceed 1 MiB'),
    );
    expect(urls.every((u) => u.endsWith('/capabilities'))).toBe(true);
  });

  it('names a cap that is not a whole number of MiB in bytes', async () => {
    const { upload } = setup(withCap(1_500_000));
    await expect(upload(blobOf(1_500_001))).rejects.toThrow(
      'Session attachments must not exceed 1500000 bytes',
    );
  });

  it('accepts an upload above 8 MiB when the daemon advertises a larger cap', async () => {
    const { upload, urls } = setup(withCap(32 * MIB));
    await expect(upload(blobOf(9 * MIB))).resolves.toMatchObject({
      attachmentId: 'file.bin',
    });
    expect(urls.some((u) => u.endsWith('/attachment-uploads'))).toBe(true);
  });

  it('does not refuse locally when the daemon advertises nothing', async () => {
    const { upload, urls } = setup(withCap());
    await expect(upload(blobOf(9 * MIB))).resolves.toMatchObject({
      attachmentId: 'file.bin',
    });
    expect(urls.some((u) => u.endsWith('/attachment-uploads'))).toBe(true);
  });

  it('refuses above the 128 MiB staged budget without asking the daemon', async () => {
    const { upload, urls } = setup(withCap(128 * MIB));
    await expect(
      upload({ size: 128 * MIB + 1 } as unknown as Blob),
    ).rejects.toThrow('Session attachments must not exceed 128 MiB');
    expect(urls).toEqual([]);
  });

  it('uses the cached cap on later uploads without another capabilities call', async () => {
    const { upload, urls } = setup(withCap(2 * MIB));
    await upload(blobOf(1 * MIB));
    const before = urls.filter((u) => u.endsWith('/capabilities')).length;
    await expect(upload(blobOf(2 * MIB + 1))).rejects.toThrow(
      'Session attachments must not exceed 2 MiB',
    );
    expect(urls.filter((u) => u.endsWith('/capabilities')).length).toBe(before);
  });
});
