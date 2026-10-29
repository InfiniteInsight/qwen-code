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

async function mount(
  deps: Parameters<typeof createCapabilityRoute>[0],
  authed = true,
) {
  const app = express();
  app.use((req, _res, next) => {
    if (authed) {
      (req as { rcClient?: unknown }).rcClient = { tokenId: 't' };
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
      expect(rc.supportedTransports).toEqual(['sse', 'ws']);
      expect(rc.supportedScopes).toEqual(['owner', 'write', 'approve', 'read']);
      expect(rc.pairingEnabled).toBe(true);
      expect(rc.auditEnabled).toBe(true);
      expect(rc.walHorizonSec).toBe(86400);
      expect(rc.walMaxEvents).toBe(10000);
      // #190: the page reads other folders' live state only when told the
      // route honours spawn=0.
      expect(rc.liveStateNoSpawn).toBe(true);
      // #194: one host tab per session.
      expect(rc.hostTerminalAlreadyMirrored).toBe(true);
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
