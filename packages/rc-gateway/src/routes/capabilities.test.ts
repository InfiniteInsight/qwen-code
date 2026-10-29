/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { DaemonCapabilities } from '@qwen-code/sdk';
import { createCapabilityRoute } from './capabilities.js';
import { RC_PROTOCOL_VERSION } from '../mdns/advert.js';
import { KNOWN_SCOPES } from '../scopes.js';

async function mount(
  deps: Parameters<typeof createCapabilityRoute>[0],
  authed = true,
  // An owner by default: the pre-#165 tests describe the full shape.
  client: Record<string, unknown> = { id: 't', scopes: ['owner'] },
) {
  const app = express();
  app.use((req, _res, next) => {
    if (authed) {
      (req as { rcClient?: unknown }).rcClient = client;
    }
    next();
  });
  app.get('/rc/capabilities', createCapabilityRoute(deps));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

describe('the daemon block (#96)', () => {
  it('relays the daemon list verbatim under a distinct key', async () => {
    const { base, close } = await mount({
      daemonStatus: async () => ({
        v: 1,
        mode: 'http-bridge',
        features: ['session_btw', 'realtime_voice'],
        modelServices: [],
        qwenCodeVersion: '0.25.3',
      }),
    });
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.daemon).toMatchObject({
        available: true,
        features: ['session_btw', 'realtime_voice'],
        qwenCodeVersion: '0.25.3',
      });
      // A distinct key: the daemon answer never overwrites the gateway claims.
      expect(body.remoteControl.version).toBe(RC_PROTOCOL_VERSION);
      expect(body.remoteControl.pairingEnabled).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('the daemon read degrades', () => {
  it('still answers with the gateway block when the daemon read throws', async () => {
    const { base, close } = await mount({
      daemonStatus: async () => {
        throw new Error('daemon unreachable');
      },
    });
    try {
      const r = await fetch(`${base}/rc/capabilities`);
      const body = await r.json();
      // The marker, not a 5xx: a dead daemon must cost the daemon list only.
      expect(r.status).toBe(200);
      expect(body.remoteControl.daemon).toEqual({ available: false });
      expect(body.remoteControl.workspaceControl.permissions).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('the daemon read budget', () => {
  it('answers within its budget when the read hangs', async () => {
    const hang = new Promise<never>(() => {});
    const { base, close } = await mount({
      daemonBudgetMs: 50,
      daemonStatus: () => hang,
    });
    try {
      const t0 = Date.now();
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(body.remoteControl.daemon).toEqual({ available: false });
    } finally {
      await close();
    }
  });
});

describe('an unwired daemon', () => {
  it('omits the key rather than claiming an empty list', async () => {
    const { base, close } = await mount({});
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.daemon).toBeUndefined();
    } finally {
      await close();
    }
  });
});

describe('the marker cannot be shadowed', () => {
  it('keeps available:true when the daemon sends its own available field', async () => {
    const { base, close } = await mount({
      daemonStatus: async () =>
        ({
          v: 1,
          mode: 'http-bridge',
          features: ['session_btw'],
          modelServices: [],
          available: false,
        }) as unknown as DaemonCapabilities,
    });
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.daemon.available).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('GET /rc/capabilities', () => {
  it('401s without an authenticated client', async () => {
    const { base, close } = await mount({}, false);
    try {
      const r = await fetch(`${base}/rc/capabilities`);
      expect(r.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('always reports the protocol version', async () => {
    const { base, close } = await mount({});
    try {
      const r = await fetch(`${base}/rc/capabilities`);
      const body = await r.json();
      expect(body.remoteControl.version).toBe(RC_PROTOCOL_VERSION);
      expect(body.remoteControl.costTracking).toBeUndefined();
      expect(body.remoteControl.mdns).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('always includes the required remoteControl fields', async () => {
    const { base, close } = await mount({});
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      const rc = body.remoteControl;
      // Only what is actually served: nothing speaks WebSocket, and minting
      // takes `session:read`, not `read`.
      expect(rc.supportedTransports).toEqual(['sse']);
      expect(rc.supportedScopes).toEqual([
        'owner',
        'write',
        'approve',
        'session:read',
      ]);
      for (const scope of rc.supportedScopes) {
        expect(KNOWN_SCOPES).toContain(scope);
      }
      expect(rc.pairingEnabled).toBe(true);
      expect(rc.auditEnabled).toBe(true);
      expect(rc.walHorizonSec).toBe(86400);
      expect(rc.walMaxEvents).toBe(10000);
      // #190: the page reads other folders' live state only when told the
      // route honours spawn=0.
      expect(rc.liveStateNoSpawn).toBe(true);
      // #194: one host tab per session.
      expect(rc.hostTerminalAlreadyMirrored).toBe(true);
      // #130: the resumable attachment-uploads routes are mounted.
      expect(rc.resumableAttachmentUploads).toBe(true);
      // #131: the current-turn route is mounted.
      expect(rc.currentTurn).toBe(true);
    } finally {
      await close();
    }
  });

  // #194 slice D: `qwen-rc attach` on the host. The flag says the loopback
  // route is mounted, so it is only true when the gateway wired it.
  it('reports hostAttach true only when the route is wired', async () => {
    const wired = await mount({ hostAttach: true });
    try {
      const body = await (await fetch(`${wired.base}/rc/capabilities`)).json();
      expect(body.remoteControl.hostAttach).toBe(true);
    } finally {
      await wired.close();
    }
    const bare = await mount({});
    try {
      const body = await (await fetch(`${bare.base}/rc/capabilities`)).json();
      expect(body.remoteControl.hostAttach).toBe(false);
    } finally {
      await bare.close();
    }
  });

  it('always reports the static workspaceControl block', async () => {
    const { base, close } = await mount({});
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.workspaceControl).toEqual({
        permissions: true,
        trust: true,
        tools: true,
        mcp: true,
      });
    } finally {
      await close();
    }
  });

  it('includes costTracking only when wired', async () => {
    const { base, close } = await mount({
      costTracking: { currencyLabel: () => 'EUR' },
    });
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.costTracking).toMatchObject({
        enabled: true,
        currencyLabel: 'EUR',
      });
    } finally {
      await close();
    }
  });

  it('reflects mDNS advertising state with instanceName', async () => {
    const { base, close } = await mount({
      mdnsStatus: () => ({ advertising: true, instanceName: 'kitchen-app' }),
    });
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.mdns).toEqual({
        advertising: true,
        instanceName: 'kitchen-app',
      });
    } finally {
      await close();
    }
  });

  it('includes the nativeShells block when wired', async () => {
    const { base, close } = await mount({
      nativeShells: () => ({
        bridgeVersion: 1,
        apnsEnabled: false,
        supportedPlatforms: ['android-twa', 'ios-wkwebview'],
        minShellVersion: { android: '1.0.0', ios: '1.0.0' },
      }),
    });
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.nativeShells).toMatchObject({
        bridgeVersion: 1,
        apnsEnabled: false,
        supportedPlatforms: ['android-twa', 'ios-wkwebview'],
      });
    } finally {
      await close();
    }
  });

  it('omits instanceName when not advertising', async () => {
    const { base, close } = await mount({
      mdnsStatus: () => ({ advertising: false }),
    });
    try {
      const body = await (await fetch(`${base}/rc/capabilities`)).json();
      expect(body.remoteControl.mdns).toEqual({ advertising: false });
      expect(body.remoteControl.mdns.instanceName).toBeUndefined();
    } finally {
      await close();
    }
  });
});

describe('daemonQwenBinHealthy (#191)', () => {
  it('reports false for an inconsistent build, and true for a good one', async () => {
    for (const healthy of [false, true]) {
      const m = await mount({
        daemonQwenBin: '/opt/qwen/dist/cli.js',
        daemonQwenBinHealthy: healthy,
      });
      try {
        const body = await (await fetch(`${m.base}/rc/capabilities`)).json();
        expect(body.remoteControl.daemonQwenBinHealthy).toBe(healthy);
      } finally {
        await m.close();
      }
    }
  });

  it('leaves it out when the probe could not tell, and from a non-owner view', async () => {
    const m = await mount({ daemonQwenBin: '/opt/qwen/dist/cli.js' });
    const guest = await mount({ daemonQwenBinHealthy: false }, true, {
      id: 'r',
      scopes: ['session:read'],
    });
    try {
      const body = await (await fetch(`${m.base}/rc/capabilities`)).json();
      expect('daemonQwenBinHealthy' in body.remoteControl).toBe(false);
      const g = await (await fetch(`${guest.base}/rc/capabilities`)).json();
      expect('daemonQwenBinHealthy' in g.remoteControl).toBe(false);
    } finally {
      await m.close();
      await guest.close();
    }
  });
});

describe('daemonQwenBin', () => {
  it('reports the resolved path of the binary the daemons run', async () => {
    const m = await mount({ daemonQwenBin: '/opt/qwen/dist/cli.js' });
    try {
      const body = await (await fetch(`${m.base}/rc/capabilities`)).json();
      expect(body.remoteControl.daemonQwenBin).toBe('/opt/qwen/dist/cli.js');
    } finally {
      await m.close();
    }
  });

  it('leaves it out when not wired', async () => {
    const m = await mount({});
    try {
      const body = await (await fetch(`${m.base}/rc/capabilities`)).json();
      expect('daemonQwenBin' in body.remoteControl).toBe(false);
    } finally {
      await m.close();
    }
  });
});

describe('maxAttachmentBytes (#196)', () => {
  it('reports the limit the upload route enforces', async () => {
    const m = await mount({ maxAttachmentBytes: 12345 });
    try {
      const body = await (await fetch(`${m.base}/rc/capabilities`)).json();
      expect(body.remoteControl.maxAttachmentBytes).toBe(12345);
    } finally {
      await m.close();
    }
  });

  it('leaves it out when the route has no limit wired, so the page falls back', async () => {
    const m = await mount({});
    try {
      const body = await (await fetch(`${m.base}/rc/capabilities`)).json();
      expect('maxAttachmentBytes' in body.remoteControl).toBe(false);
    } finally {
      await m.close();
    }
  });

  it('reports the resolved number when the limit follows the daemon', async () => {
    const m = await mount({ maxAttachmentBytes: async () => 31 * 1024 * 1024 });
    try {
      const body = await (await fetch(`${m.base}/rc/capabilities`)).json();
      expect(body.remoteControl.maxAttachmentBytes).toBe(31 * 1024 * 1024);
    } finally {
      await m.close();
    }
  });
});

describe('#165 the response is scoped by token', () => {
  const SSH = { host: 'build.internal', port: 2222, directory: '/srv/repo' };
  const DAEMON: DaemonCapabilities = {
    v: 1,
    mode: 'http-bridge',
    features: ['session_btw', 'workspace_file_reads'],
    modelServices: ['openai'],
    qwenCodeVersion: '0.25.3',
    limits: { maxSessionAttachmentItemBytes: 1024 },
    workspaceCwd: '/home/evan/projects/secret-repo',
    workspaces: [
      {
        id: 'w1',
        cwd: '/home/evan/projects/secret-repo',
        displayName: 'secret-repo',
        primary: true,
        trusted: true,
      },
      {
        id: 'w2',
        cwd: '/remote/x',
        ssh: SSH,
        primary: false,
        trusted: false,
      },
    ],
  };
  const DEPS: Parameters<typeof createCapabilityRoute>[0] = {
    daemonStatus: async () => DAEMON,
    daemonQwenBin: '/opt/qwen/dist/cli.js',
    costTracking: { currencyLabel: () => 'USD' },
    mdnsStatus: () => ({ advertising: true, instanceName: 'evan-laptop' }),
    maxAttachmentBytes: 4096,
  };

  async function capsAs(client: Record<string, unknown>) {
    const m = await mount(DEPS, true, client);
    try {
      const res = await fetch(`${m.base}/rc/capabilities`);
      const text = await res.text();
      return {
        text,
        rc: (JSON.parse(text) as { remoteControl: Record<string, unknown> })
          .remoteControl,
      };
    } finally {
      await m.close();
    }
  }

  /** Every field public/index.html reads from this route (read-only check). */
  function expectPageFields(rc: Record<string, unknown>) {
    const daemon = rc.daemon as Record<string, unknown>;
    expect(daemon.available).toBe(true);
    expect(daemon.features).toEqual(DAEMON.features);
    expect(rc.workspaceControl).toBeDefined();
    expect(rc.maxAttachmentBytes).toBe(4096);
    expect(rc.liveStateNoSpawn).toBe(true);
  }

  it.each([
    ['owner', { id: 'o', scopes: ['owner'] }],
    ['write', { id: 'w', scopes: ['write', 'session:read'] }],
    [
      'bridge',
      { id: 'b', scopes: ['bridge', 'session:read', 'approve', 'write'] },
    ],
  ])('%s keeps the full shape', async (_name, client) => {
    const { rc } = await capsAs(client);
    const daemon = rc.daemon as Record<string, unknown>;
    expect(daemon.workspaceCwd).toBe(DAEMON.workspaceCwd);
    expect(daemon.workspaces).toEqual(DAEMON.workspaces);
    expect(rc.daemonQwenBin).toBe('/opt/qwen/dist/cli.js');
    expect(rc.costTracking).toMatchObject({
      rateTablePath: '~/.qwen/rc/model-rates.yaml',
    });
    expect(rc.mdns).toEqual({ advertising: true, instanceName: 'evan-laptop' });
    expectPageFields(rc);
  });

  it.each([
    ['read-only', { id: 'r', scopes: ['session:read'] }],
    ['approve-only', { id: 'a', scopes: ['approve'] }],
  ])('%s gets no paths and no ssh details', async (_name, client) => {
    const { rc, text } = await capsAs(client);
    expect(text).not.toContain('/home/evan');
    expect(text).not.toContain('/remote/x');
    expect(text).not.toContain('build.internal');
    expect(text).not.toContain('/srv/repo');
    expect(text).not.toContain('/opt/qwen');
    expect(text).not.toContain('model-rates.yaml');
    const daemon = rc.daemon as Record<string, unknown>;
    expect('workspaceCwd' in daemon).toBe(false);
    expect(daemon.workspaces).toEqual([
      { id: 'w1', displayName: 'secret-repo', primary: true, trusted: true },
      { id: 'w2', primary: false, trusted: false },
    ]);
    expect('daemonQwenBin' in rc).toBe(false);
    expectPageFields(rc);
  });

  it('a share guest gets only what the page needs for its one session', async () => {
    const { rc, text } = await capsAs({
      id: 's',
      scopes: ['session:read', 'share'],
      sessionLockId: 'sess-1',
    });
    for (const leak of [
      '/home/evan',
      'secret-repo',
      'build.internal',
      '/opt/qwen',
      'evan-laptop',
      '0.25.3',
      'model-rates.yaml',
    ]) {
      expect(text).not.toContain(leak);
    }
    const daemon = rc.daemon as Record<string, unknown>;
    expect('workspaces' in daemon).toBe(false);
    expect('workspaceCwd' in daemon).toBe(false);
    expect(rc.mdns).toEqual({ advertising: true });
    expectPageFields(rc);
  });

  it('a share with write in its scopes is still a guest (the lock decides)', async () => {
    const { text } = await capsAs({
      id: 's2',
      scopes: ['session:read', 'write', 'share'],
      sessionLockId: 'sess-1',
    });
    expect(text).not.toContain('/home/evan');
    expect(text).not.toContain('build.internal');
  });

  // #190: the list's folder line names the host and reads $HOME as ~, which
  // are host facts, so only a token that already sees host paths gets them.
  it('names the host and its home directory to owner and write tokens only', async () => {
    const m = await mount({ ...DEPS, hostName: 'lovelace.tail.ts.net', homeDir: '/srv/me' }, true, {
      id: 'o',
      scopes: ['owner'],
    });
    try {
      const rc = ((await (await fetch(`${m.base}/rc/capabilities`)).json()) as {
        remoteControl: Record<string, unknown>;
      }).remoteControl;
      expect(rc.hostName).toBe('lovelace.tail.ts.net');
      expect(rc.homeDir).toBe('/srv/me');
    } finally {
      await m.close();
    }
    for (const client of [
      { id: 'r', scopes: ['session:read'] },
      { id: 's', scopes: ['session:read', 'share'], sessionLockId: 'sess-1' },
    ]) {
      const { rc } = await capsAs(client);
      expect('hostName' in rc).toBe(false);
      expect('homeDir' in rc).toBe(false);
    }
  });

  // #150: the page resumes a conversation whose watch fell past the WAL
  // horizon only when the token may call resume.
  it.each([
    ['owner', { id: 'o', scopes: ['owner'] }, true],
    ['write', { id: 'w', scopes: ['write', 'session:read'] }, true],
    ['read-only', { id: 'r', scopes: ['session:read'] }, false],
    ['approve-only', { id: 'a', scopes: ['approve'] }, false],
    ['no scopes', { id: 'x' }, false],
  ])('says whether a %s token holds write', async (_name, client, want) => {
    const { rc } = await capsAs(client);
    expect(rc.writeScope).toBe(want);
  });

  it('fails closed for a client with no scopes array', async () => {
    const { text } = await capsAs({ id: 'x' });
    expect(text).not.toContain('/home/evan');
    expect(text).not.toContain('build.internal');
  });

  it('a future daemon field does not reach a guest or a reader', async () => {
    const m = await mount(
      {
        daemonStatus: async () =>
          ({ ...DAEMON, hostHome: '/home/evan' }) as DaemonCapabilities,
      },
      true,
      { id: 'r', scopes: ['session:read'] },
    );
    try {
      const text = await (await fetch(`${m.base}/rc/capabilities`)).text();
      expect(text).not.toContain('hostHome');
    } finally {
      await m.close();
    }
  });
});
