/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { createGatewayApp } from '../server.js';
import { AuditLog, type AuditEntry } from '../auditLog.js';
import { loadLayeredPolicy, type Policy } from './loader.js';
import { evaluate } from './evaluator.js';
import {
  createPolicyHotReload,
  createRoutingHotReload,
  type HotReload,
} from './hotReload.js';
import { loadLayeredRoutingMatcher } from '../routing/rules.js';
import {
  WorkspaceConfigApprovalStore,
  sha256Hex,
  type HeldWorkspaceConfig,
} from './workspaceConfigApprovals.js';

let tempDirs: string[] = [];
let servers: Server[] = [];
let stubs: StubDaemon[] = [];
let reloaders: HotReload[] = [];

afterEach(async () => {
  for (const r of reloaders) r.stop();
  reloaders = [];
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  servers = [];
  for (const st of stubs) await st.close();
  stubs = [];
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rc-ws-approvals-'));
  tempDirs.push(d);
  return d;
}

const VALID_WORKSPACE_POLICY = `version: 1
rules:
  - id: deny-shell
    match:
      tool: execute
    action: deny
`;

const SECOND_WORKSPACE_POLICY = `version: 1
rules:
  - id: deny-write
    match:
      tool: edit
    action: deny
`;

const VALID_WORKSPACE_ROUTING = `version: 1
rules:
  - id: quiet-completions
    match:
      kind: prompt_completed
    route:
      drop: true
`;

describe('WorkspaceConfigApprovalStore + boot/reload gate (#242)', () => {
  it('holds valid unapproved workspace policy and routing files at boot, then applies after owner approval and across restart', async () => {
    const dir = makeTempDir();
    const rcDir = join(dir, 'rc');
    const wsDir = join(dir, 'workspace');
    mkdirSync(join(wsDir, '.qwen'), { recursive: true });
    writeFileSync(join(wsDir, '.qwen', 'policy.yaml'), VALID_WORKSPACE_POLICY);
    writeFileSync(join(wsDir, '.qwen', 'routing.yaml'), VALID_WORKSPACE_ROUTING);

    const storePath = join(rcDir, 'workspace-config-approvals.json');
    const approvals = WorkspaceConfigApprovalStore.open(storePath);
    const warnings: string[] = [];
    const bootHeld: HeldWorkspaceConfig[] = [];

    // 1. At boot, both files parse cleanly and narrow within bounds, yet are
    //    HELD rather than applied because no operator approved their hashes.
    const bootPolicy = await loadLayeredPolicy(
      join(rcDir, 'policy.yaml'),
      wsDir,
      (m) => warnings.push(m),
      { approvals, onHeld: (h) => bootHeld.push(h) },
    );
    expect(
      evaluate(bootPolicy, { tool: 'execute', projectRoot: wsDir }).action,
    ).toBe('prompt');

    const bootRouting = await loadLayeredRoutingMatcher(
      join(rcDir, 'routing.yaml'),
      wsDir,
      (m) => warnings.push(m),
      { approvals, onHeld: (h) => bootHeld.push(h) },
    );
    expect(bootRouting.ruleCount).toBe(0);
    expect(bootHeld).toHaveLength(2);
    expect(bootHeld.map((h) => h.phase)).toEqual(['boot', 'boot']);

    // 2. Boot the gateway routes over the same store and verify owner-only
    //    inspection + exact-hash approval + immediate reload + audit trail.
    const stub = await startStubDaemon({ workspaceCwd: wsDir });
    stubs.push(stub);
    const tokenStore = await TokenStore.open(join(rcDir, 'tokens.json'));
    const { token: ownerToken, id: ownerId } = await tokenStore.issue(
      ['owner'],
      'owner-dev',
    );
    const { token: writeToken } = await tokenStore.issue(['write'], 'writer');
    const auditDir = join(rcDir, 'audit');

    let livePolicy: Policy = bootPolicy;
    let liveRoutingCount = bootRouting.ruleCount;

    const { app, audit } = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store: tokenStore,
      pairing: new PairingService(),
      auditPath: join(auditDir, 'audit.log'),
      workspaceConfigApprovals: {
        store: approvals,
        workspaceCwd: () => wsDir,
        onApproved: async (kind) => {
          if (kind === 'policy') {
            livePolicy = await loadLayeredPolicy(
              join(rcDir, 'policy.yaml'),
              wsDir,
              undefined,
              { approvals },
            );
          } else {
            const loaded = await loadLayeredRoutingMatcher(
              join(rcDir, 'routing.yaml'),
              wsDir,
              undefined,
              { approvals },
            );
            liveRoutingCount = loaded.ruleCount;
          }
        },
      },
    });
    // Record the boot holds in the real hash-chained audit log, mirroring cli.ts.
    for (const h of bootHeld) {
      await audit.record({
        action:
          h.kind === 'policy'
            ? 'policy_workspace_held'
            : 'routing_workspace_held',
        target: h.path,
        detail: { file: h.path, sha256: h.sha256, phase: h.phase },
      });
    }

    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Write token is refused with 403.
    const writeRes = await fetch(`${url}/rc/workspace-config-approvals`, {
      headers: { Authorization: `Bearer ${writeToken}` },
    });
    expect(writeRes.status).toBe(403);

    // Owner sees both files held at boot with previews and SHA-256 digests.
    const getRes = await fetch(`${url}/rc/workspace-config-approvals`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(getRes.status).toBe(200);
    const statusBody = (await getRes.json()) as {
      files: Array<{
        kind: string;
        status: string;
        heldPhase?: string;
        sha256?: string;
        preview?: string;
      }>;
    };
    expect(statusBody.files).toMatchObject([
      {
        kind: 'policy',
        status: 'held',
        heldPhase: 'boot',
        sha256: sha256Hex(VALID_WORKSPACE_POLICY),
      },
      {
        kind: 'routing',
        status: 'held',
        heldPhase: 'boot',
        sha256: sha256Hex(VALID_WORKSPACE_ROUTING),
      },
    ]);
    expect(statusBody.files[0]!.preview).toContain('deny-shell');

    // Stale/wrong sha256 is refused with 409 config_changed (TOCTOU guard).
    const staleRes = await fetch(
      `${url}/rc/workspace-config-approvals/approve`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ kind: 'policy', sha256: '0'.repeat(64) }),
      },
    );
    expect(staleRes.status).toBe(409);
    expect(((await staleRes.json()) as { code: string }).code).toBe(
      'config_changed',
    );

    // Approving exact SHA-256 applies immediately, persists mode 0600, and audits who approved it.
    for (const f of statusBody.files) {
      const okRes = await fetch(
        `${url}/rc/workspace-config-approvals/approve`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ kind: f.kind, sha256: f.sha256 }),
        },
      );
      expect(okRes.status).toBe(200);
    }

    expect(
      evaluate(livePolicy, { tool: 'execute', projectRoot: wsDir }).action,
    ).toBe('deny');
    expect(liveRoutingCount).toBe(1);
    expect(statSync(storePath).mode & 0o777).toBe(0o600);

    // 3. Simulated gateway restart: opening a fresh store from disk keeps the
    //    approval intact and applies at boot with zero hold.
    const reloadedStore = WorkspaceConfigApprovalStore.open(storePath);
    const postRestartHeld: HeldWorkspaceConfig[] = [];
    const postRestartPolicy = await loadLayeredPolicy(
      join(rcDir, 'policy.yaml'),
      wsDir,
      undefined,
      { approvals: reloadedStore, onHeld: (h) => postRestartHeld.push(h) },
    );
    expect(postRestartHeld).toHaveLength(0);
    expect(
      evaluate(postRestartPolicy, { tool: 'execute', projectRoot: wsDir })
        .action,
    ).toBe('deny');

    // Audit chain stays valid and records both holds + both approvals with actorTokenId.
    const chain = await AuditLog.verifyChain(auditDir);
    expect(chain.ok).toBe(true);
    const events = await audit.query({ limit: 50 });
    const approvedRows = events.filter(
      (e) => e.action === 'workspace_config_approved',
    );
    expect(approvedRows).toHaveLength(2);
    expect(approvedRows.every((r) => r.actorTokenId === ownerId)).toBe(
      true,
    );
  });

  it('holds an unapproved edit on hot-reload, keeps the previous approved ruleset active, and audits *_workspace_held instead of *_reload_failed', async () => {
    const dir = makeTempDir();
    const rcDir = join(dir, 'rc');
    const wsDir = join(dir, 'workspace');
    mkdirSync(join(wsDir, '.qwen'), { recursive: true });
    const policyPath = join(wsDir, '.qwen', 'policy.yaml');
    const routingPath = join(wsDir, '.qwen', 'routing.yaml');
    writeFileSync(policyPath, VALID_WORKSPACE_POLICY);
    writeFileSync(routingPath, VALID_WORKSPACE_ROUTING);

    const approvals = WorkspaceConfigApprovalStore.open(
      join(rcDir, 'workspace-config-approvals.json'),
    );
    approvals.approve({
      path: policyPath,
      kind: 'policy',
      sha256: sha256Hex(VALID_WORKSPACE_POLICY),
      approvedBy: 'tok-owner',
    });
    approvals.approve({
      path: routingPath,
      kind: 'routing',
      sha256: sha256Hex(VALID_WORKSPACE_ROUTING),
      approvedBy: 'tok-owner',
    });

    let activePolicy = await loadLayeredPolicy(
      join(rcDir, 'policy.yaml'),
      wsDir,
      undefined,
      { approvals },
    );
    expect(
      evaluate(activePolicy, { tool: 'execute', projectRoot: wsDir }).action,
    ).toBe('deny');

    const auditRows: AuditEntry[] = [];
    const policyReload = createPolicyHotReload({
      userPath: join(rcDir, 'policy.yaml'),
      workspaceCwd: wsDir,
      apply: (p) => {
        activePolicy = p;
      },
      audit: {
        record: async (e) => {
          auditRows.push(e);
        },
      },
      approvals,
      log: { info: () => {}, warn: () => {} },
    });
    const routingReload = createRoutingHotReload({
      userPath: join(rcDir, 'routing.yaml'),
      workspaceCwd: wsDir,
      apply: () => {},
      audit: {
        record: async (e) => {
          auditRows.push(e);
        },
      },
      approvals,
      log: { info: () => {}, warn: () => {} },
    });
    reloaders.push(policyReload, routingReload);

    // Model or git pull rewrites policy.yaml to new valid rules without approval.
    writeFileSync(policyPath, SECOND_WORKSPACE_POLICY);
    await policyReload.reloadNow!(policyPath);

    // Previous `deny-shell` ruleset remains in force; `deny-write` is NOT applied.
    expect(
      evaluate(activePolicy, { tool: 'execute', projectRoot: wsDir }).action,
    ).toBe('deny');
    expect(
      evaluate(activePolicy, { tool: 'edit', projectRoot: wsDir }).action,
    ).toBe('prompt');

    expect(auditRows.map((r) => r.action)).toEqual(['policy_workspace_held']);
    expect(auditRows[0]!.detail).toEqual({
      file: policyPath,
      sha256: sha256Hex(SECOND_WORKSPACE_POLICY),
      phase: 'reload',
    });
    expect(approvals.getHeld(policyPath)).toMatchObject({
      kind: 'policy',
      sha256: sha256Hex(SECOND_WORKSPACE_POLICY),
      phase: 'reload',
    });
  });

  it('refuses a workspace config symlink escaping the workspace directory', async () => {
    const dir = makeTempDir();
    const outsideSecret = join(dir, 'outside.yaml');
    writeFileSync(outsideSecret, VALID_WORKSPACE_POLICY);
    const wsDir = join(dir, 'workspace');
    mkdirSync(join(wsDir, '.qwen'), { recursive: true });
    symlinkSync(outsideSecret, join(wsDir, '.qwen', 'policy.yaml'));

    const approvals = WorkspaceConfigApprovalStore.open(
      join(dir, 'rc', 'workspace-config-approvals.json'),
    );
    const stub = await startStubDaemon({ workspaceCwd: wsDir });
    stubs.push(stub);
    const tokenStore = await TokenStore.open(join(dir, 'rc', 'tokens.json'));
    const { token } = await tokenStore.issue(['owner'], 'owner');
    const { app } = createGatewayApp({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      store: tokenStore,
      pairing: new PairingService(),
      auditPath: join(dir, 'rc', 'audit', 'audit.log'),
      workspaceConfigApprovals: {
        store: approvals,
        workspaceCwd: () => wsDir,
      },
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${url}/rc/workspace-config-approvals`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as {
      files: Array<{ kind: string; status: string; preview?: string }>;
    };
    expect(body.files[0]!.status).toBe('invalid');
    expect(body.files[0]!.preview).toBeUndefined();
  });
});
