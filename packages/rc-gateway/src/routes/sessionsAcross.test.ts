/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { resolveChatsDir } from '../sessions/chatsPath.js';
import { createSessionListRoute } from './sessions.js';

const BOOT = '/across-test/boot';
const OTHER = '/across-test/other';
const BOOT_SESSION = '55555555555555555555555555555555';
const OTHER_SESSION = '66666666666666666666666666666666';

function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}

async function writeTranscript(dir: string, id: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({ sessionId: id, type: 'user' })}\n`,
  );
}

// Mirrors the `/rc/sessions` mount in server.ts: an explicit `?cwd` wins and
// confines, and the extras provider is what widens the boot fallback.
async function mount(
  bootCwd: string | undefined,
  extras: () => Promise<string[]>,
  audit: AuditRecorder,
): Promise<string> {
  const app = express();
  app.get(
    '/rc/sessions',
    createSessionListRoute(
      async (req) => {
        const q = req.query.cwd;
        if (typeof q === 'string' && q.length > 0) return pathResolve(q);
        return bootCwd;
      },
      audit,
      async (req) => {
        const q = req.query.cwd;
        if (typeof q === 'string' && q.length > 0) return [];
        return extras();
      },
    ),
  );
  await new Promise<void>((resolveDone) => {
    server = app.listen(0, resolveDone);
  });
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function idsAt(url: string): Promise<string[]> {
  const res = await fetch(url);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
  return body.sessions.map((s) => s.sessionId);
}

let server: Server | undefined;
let runtimeBase: string;

beforeEach(async () => {
  runtimeBase = await mkdtemp(join(tmpdir(), 'rc-across-'));
  process.env['QWEN_RUNTIME_DIR'] = runtimeBase;
});

afterEach(async () => {
  await new Promise<void>((resolveDone) => {
    if (server) server.close(() => resolveDone());
    else resolveDone();
  });
  server = undefined;
  delete process.env['QWEN_RUNTIME_DIR'];
  await rm(runtimeBase, { recursive: true, force: true });
});

describe('GET /rc/sessions across workspaces (#82)', () => {
  // The bug: a conversation started in another workspace is stored under that
  // workspace, so the boot-only scan never listed it and the phone's
  // conversation was unselectable on the laptop.
  it('lists a conversation started in another workspace', async () => {
    await writeTranscript(resolveChatsDir(BOOT), BOOT_SESSION);
    await writeTranscript(resolveChatsDir(OTHER), OTHER_SESSION);
    const base = await mount(BOOT, async () => [OTHER], fakeAudit());
    const ids = await idsAt(`${base}/rc/sessions`);
    expect(ids).toContain(BOOT_SESSION);
    expect(ids).toContain(OTHER_SESSION);
  });
});

describe('GET /rc/sessions across workspaces (#82) — confinement', () => {
  // The other half of the contract: a named `?cwd` means "that workspace only",
  // which is what the per-workspace views in the UI rely on. Without this the
  // union would silently widen every scoped fetch.
  it('a named ?cwd stays confined to that workspace', async () => {
    await writeTranscript(resolveChatsDir(BOOT), BOOT_SESSION);
    await writeTranscript(resolveChatsDir(OTHER), OTHER_SESSION);
    const base = await mount(BOOT, async () => [OTHER], fakeAudit());
    const ids = await idsAt(
      `${base}/rc/sessions?cwd=${encodeURIComponent(BOOT)}`,
    );
    expect(ids).toContain(BOOT_SESSION);
    expect(ids).not.toContain(OTHER_SESSION);
  });
});

describe('GET /rc/sessions across workspaces (#82) — set semantics', () => {
  // A workspace this gateway worked in but that holds no transcripts must not
  // become a phantom row.
  it('a workspace with no transcripts contributes nothing', async () => {
    await writeTranscript(resolveChatsDir(BOOT), BOOT_SESSION);
    const base = await mount(BOOT, async () => [OTHER], fakeAudit());
    expect(await idsAt(`${base}/rc/sessions`)).toEqual([BOOT_SESSION]);
  });

  // Session ids are globally unique, so an id seen in two dirs lists once.
  it('lists one id once when two workspaces both hold it', async () => {
    await writeTranscript(resolveChatsDir(BOOT), OTHER_SESSION);
    await writeTranscript(resolveChatsDir(OTHER), OTHER_SESSION);
    const base = await mount(BOOT, async () => [OTHER], fakeAudit());
    expect(await idsAt(`${base}/rc/sessions`)).toEqual([OTHER_SESSION]);
  });
});
