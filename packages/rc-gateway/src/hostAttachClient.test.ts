/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import express from 'express';
import {
  classifyReattach,
  DEFAULT_GATEWAY_PORT,
  hostAttachTokenPath,
  parseAttachArgs,
  postHostAttach,
  resolveGatewayLoopback,
  runHostAttach,
  type GatewayLoopbackTarget,
  type HostAttachRunDeps,
} from './hostAttachClient.js';
import { loadOrCreateLocalToken } from './localCredential.js';
import { createHttp2Front, type FrontListener } from './tls/http2Front.js';
import { getFreePort } from './freePort.js';
import {
  GW_TEST_LEAF_CERT,
  GW_TEST_LEAF_KEY,
  OTHER_TEST_LEAF_CERT,
  TEST_INTERMEDIATE_CERT,
} from './testing/tlsChainFixture.js';
import {
  createHostAttachRoutes,
  type HostAttachDaemon,
} from './routes/hostAttach.js';
import { UnknownSessionError } from './daemonPool.js';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let rcDir: string;
let front: FrontListener | undefined;

beforeEach(async () => {
  rcDir = await mkdtemp(join(tmpdir(), 'rc-attach-cli-'));
});

afterEach(async () => {
  if (front) await front.close();
  front = undefined;
  await rm(rcDir, { recursive: true, force: true });
});

async function writeLauncherState(state: Record<string, unknown>) {
  await writeFile(join(rcDir, 'launcher-state.json'), JSON.stringify(state));
}

async function writeCert(name: string, pem: string, mtimeSec?: number) {
  await mkdir(join(rcDir, 'tls'), { recursive: true });
  const p = join(rcDir, 'tls', name);
  await writeFile(p, pem);
  if (mtimeSec !== undefined) await utimes(p, mtimeSec, mtimeSec);
  return p;
}

describe('resolveGatewayLoopback', () => {
  it('reads the port from launcher state and pins the cert named for its host', async () => {
    await writeLauncherState({
      unit: 'u',
      url: 'x',
      host: 'gw.test',
      port: 9443,
    });
    const pin = GW_TEST_LEAF_CERT + TEST_INTERMEDIATE_CERT;
    const certPath = await writeCert('gw.test.crt', pin);
    // A newer, unrelated cert must not win over the one launcher state names.
    await writeCert('other.test.crt', OTHER_TEST_LEAF_CERT, 4_000_000_000);
    expect(resolveGatewayLoopback(rcDir)).toEqual({
      host: '127.0.0.1',
      port: 9443,
      ca: pin,
      certPath,
      servername: 'gw.test',
    });
  });

  it(`falls back to port ${DEFAULT_GATEWAY_PORT} without launcher state`, async () => {
    const certPath = await writeCert('gw.test.crt', GW_TEST_LEAF_CERT);
    const t = resolveGatewayLoopback(rcDir);
    expect(t.port).toBe(DEFAULT_GATEWAY_PORT);
    // With no state to name the host, the cert's own SAN does.
    expect(t.servername).toBe('gw.test');
    expect(t.certPath).toBe(certPath);
  });

  it('falls back to the default port when the state port is unusable', async () => {
    for (const port of ['8443', 0, 70000, 1.5, null]) {
      await writeLauncherState({ host: 'gw.test', port });
      expect(resolveGatewayLoopback(rcDir).port).toBe(DEFAULT_GATEWAY_PORT);
    }
  });

  it('picks the newest cert when the state names none that exists', async () => {
    await writeLauncherState({ host: 'gone.test', port: 9443 });
    await writeCert('gw.test.crt', GW_TEST_LEAF_CERT, 1_000_000_000);
    const newer = await writeCert(
      'other.test.crt',
      OTHER_TEST_LEAF_CERT,
      2_000_000_000,
    );
    const t = resolveGatewayLoopback(rcDir);
    expect(t.certPath).toBe(newer);
    expect(t.servername).toBe('other.test');
  });

  it('answers no pin, only the state host, when there is no cert', async () => {
    await writeLauncherState({ host: 'gw.test', port: 9443 });
    expect(resolveGatewayLoopback(rcDir)).toEqual({
      host: '127.0.0.1',
      port: 9443,
      servername: 'gw.test',
    });
  });

  it('answers the bare default with nothing on disk', () => {
    expect(resolveGatewayLoopback(rcDir)).toEqual({
      host: '127.0.0.1',
      port: DEFAULT_GATEWAY_PORT,
    });
  });
});

describe('parseAttachArgs', () => {
  it('defaults the folder to the current directory', () => {
    expect(parseAttachArgs([], '/home/u/proj')).toEqual({
      ok: true,
      cwd: '/home/u/proj',
    });
  });

  it('resolves a relative folder against the current directory', () => {
    expect(parseAttachArgs(['../other'], '/home/u/proj')).toEqual({
      ok: true,
      cwd: '/home/u/other',
    });
  });

  it('reads --session in both spellings', () => {
    expect(parseAttachArgs(['--session', SESSION], '/p')).toEqual({
      ok: true,
      cwd: '/p',
      sessionId: SESSION,
    });
    expect(parseAttachArgs([`--session=${SESSION}`, '/q'], '/p')).toEqual({
      ok: true,
      cwd: '/q',
      sessionId: SESSION,
    });
  });

  it('refuses unknown flags, a missing session value and two folders', () => {
    expect(parseAttachArgs(['--bogus'], '/p').ok).toBe(false);
    expect(parseAttachArgs(['--session'], '/p').ok).toBe(false);
    expect(parseAttachArgs(['--session='], '/p').ok).toBe(false);
    expect(parseAttachArgs(['/a', '/b'], '/p').ok).toBe(false);
  });
});

/**
 * A real front (TLS + HTTP/2 + the loopback hop that attests the peer) in
 * front of the real route, over a fake pool. This is the path `qwen-rc
 * attach` takes, short of the live gateway.
 */
async function bootFront(token: string, known: string[] = []) {
  const workspace = join(rcDir, 'proj');
  await mkdir(workspace, { recursive: true });
  const tracked = new Set(known);
  const daemon = {
    createOrAttachSession: async () => {
      tracked.add(SESSION);
      return { sessionId: SESSION, workspaceCwd: workspace, attached: false };
    },
    resumeSession: async (id: string) => {
      tracked.add(id);
      return { sessionId: id };
    },
    daemonEndpointForSession: (id: string) => {
      if (!tracked.has(id)) throw new UnknownSessionError(id);
      return {
        url: 'http://127.0.0.1:46135',
        token: 'daemon-secret',
        workspaceCwd: workspace,
      };
    },
  } as unknown as HostAttachDaemon;
  const routes = createHostAttachRoutes({
    daemon,
    token,
    planOpts: { qwenArgv: ['fake-qwen'] },
  });
  const app = express();
  app.use(express.json());
  app.post('/rc/host/attach', routes.create);
  app.post('/rc/host/attach/:sessionId', routes.attach);
  const port = await getFreePort();
  front = createHttp2Front(app, {
    cert: GW_TEST_LEAF_CERT + TEST_INTERMEDIATE_CERT,
    key: GW_TEST_LEAF_KEY,
  });
  await new Promise<void>((r) => front!.listen(port, '127.0.0.1', r));
  return { port, workspace };
}

describe('postHostAttach over the pinned loopback front', () => {
  it('reaches the route through a leaf-only pin and the cert host as servername', async () => {
    const { port, workspace } = await bootFront('tok');
    const target: GatewayLoopbackTarget = {
      host: '127.0.0.1',
      port,
      ca: GW_TEST_LEAF_CERT,
      servername: 'gw.test',
    };
    const res = await postHostAttach(target, 'tok', '/rc/host/attach', {
      cwd: workspace,
    });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(SESSION);
  });

  it('refuses a server whose cert the pin does not cover', async () => {
    const { port, workspace } = await bootFront('tok');
    const target: GatewayLoopbackTarget = {
      host: '127.0.0.1',
      port,
      ca: OTHER_TEST_LEAF_CERT,
      servername: 'gw.test',
    };
    await expect(
      postHostAttach(target, 'tok', '/rc/host/attach', { cwd: workspace }),
    ).rejects.toMatchObject({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });
  });

  it('refuses a pinned cert presented under the wrong name', async () => {
    const { port, workspace } = await bootFront('tok');
    const target: GatewayLoopbackTarget = {
      host: '127.0.0.1',
      port,
      ca: GW_TEST_LEAF_CERT,
      servername: 'other.test',
    };
    await expect(
      postHostAttach(target, 'tok', '/rc/host/attach', { cwd: workspace }),
    ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });
});

function fakeSpawn(
  status: number | null,
  extra: Partial<SpawnSyncReturns<Buffer>> = {},
) {
  const calls: Array<{
    cmd: string;
    args: string[];
    cwd?: string;
    stdio?: unknown;
  }> = [];
  const spawn = ((
    cmd: string,
    args: string[],
    opts: { cwd?: string; stdio?: unknown },
  ) => {
    calls.push({ cmd, args, cwd: opts.cwd, stdio: opts.stdio });
    return {
      status,
      signal: null,
      pid: 1,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      ...extra,
    };
  }) as unknown as HostAttachRunDeps['spawn'];
  return { spawn, calls };
}

async function run(
  argv: string[],
  over: Partial<HostAttachRunDeps> = {},
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runHostAttach({
    argv,
    cwd: rcDir,
    rcDir,
    stderr: (l) => lines.push(l),
    spawn: fakeSpawn(0).spawn,
    shieldSignals: () => () => {},
    ...over,
  });
  return { code, lines };
}

describe('runHostAttach', () => {
  it('says what is missing and how to fix it when there is no token file', async () => {
    const { code, lines } = await run([]);
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(hostAttachTokenPath(rcDir));
    expect(lines[0]).toContain('systemctl --user start qwen-rc-gateway');
  });

  it('says no gateway is answering, with the fix, when the port is closed', async () => {
    await loadOrCreateLocalToken(hostAttachTokenPath(rcDir));
    const port = await getFreePort();
    await writeLauncherState({ host: 'gw.test', port });
    const { code, lines } = await run([]);
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`https://127.0.0.1:${port}`);
    expect(lines[0]).toContain('systemctl --user start qwen-rc-gateway');
  });

  it('attaches end to end: one stderr line, then the TUI in the workspace, its exit code passed on', async () => {
    const token = await loadOrCreateLocalToken(hostAttachTokenPath(rcDir));
    const { port, workspace } = await bootFront(token);
    await writeLauncherState({ host: 'gw.test', port });
    await writeCert('gw.test.crt', GW_TEST_LEAF_CERT + TEST_INTERMEDIATE_CERT);
    const { spawn, calls } = fakeSpawn(7);
    let shielded = 0;
    let restored = 0;
    const { code, lines } = await run([workspace], {
      spawn,
      shieldSignals: () => {
        shielded++;
        return () => void restored++;
      },
    });
    expect(lines).toEqual([`attached ${SESSION} in ${workspace}`]);
    expect(calls).toEqual([
      {
        cmd: 'fake-qwen',
        args: [
          '--attach-daemon',
          'http://127.0.0.1:46135',
          '--daemon-token',
          'daemon-secret',
          '--attach-session',
          SESSION,
        ],
        cwd: workspace,
        stdio: 'inherit',
      },
    ]);
    expect(code).toBe(7);
    // Ctrl-C belongs to the TUI while it runs, and only while it runs.
    expect([shielded, restored]).toEqual([1, 1]);
  });

  it('re-attaches by id with --session', async () => {
    const token = await loadOrCreateLocalToken(hostAttachTokenPath(rcDir));
    const { port, workspace } = await bootFront(token, [SESSION]);
    await writeLauncherState({ host: 'gw.test', port });
    await writeCert('gw.test.crt', GW_TEST_LEAF_CERT);
    const { spawn, calls } = fakeSpawn(0);
    const { code, lines } = await run(['--session', SESSION, workspace], {
      spawn,
    });
    expect(code).toBe(0);
    expect(lines).toEqual([`attached ${SESSION} in ${workspace}`]);
    expect(calls[0]?.args.slice(-1)).toEqual([SESSION]);
  });

  it('reports a refused token in one line and never spawns', async () => {
    await writeFile(hostAttachTokenPath(rcDir), 'stale-token\n');
    const { port, workspace } = await bootFront('the-real-token');
    await writeLauncherState({ host: 'gw.test', port });
    await writeCert('gw.test.crt', GW_TEST_LEAF_CERT);
    const { spawn, calls } = fakeSpawn(0);
    const { code, lines } = await run([workspace], { spawn });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('refused');
    expect(lines[0]).toContain('systemctl --user restart qwen-rc-gateway');
    expect(calls).toHaveLength(0);
  });

  it('reports a session the gateway cannot find in one line', async () => {
    const token = await loadOrCreateLocalToken(hostAttachTokenPath(rcDir));
    const { port, workspace } = await bootFront(token);
    await writeLauncherState({ host: 'gw.test', port });
    await writeCert('gw.test.crt', GW_TEST_LEAF_CERT);
    const lines: string[] = [];
    const code = await runHostAttach({
      argv: ['--session', SESSION, workspace],
      cwd: rcDir,
      rcDir,
      stderr: (l) => lines.push(l),
      spawn: fakeSpawn(0).spawn,
      shieldSignals: () => () => {},
      request: async () => ({
        status: 404,
        body: { error: 'Session not found', code: 'session_not_found' },
      }),
    });
    expect(code).toBe(1);
    expect(lines).toEqual([
      `qwen-rc attach: no conversation ${SESSION} in ${workspace} (session_not_found)`,
    ]);
  });

  it('reports a TUI that could not start', async () => {
    const token = await loadOrCreateLocalToken(hostAttachTokenPath(rcDir));
    const { port, workspace } = await bootFront(token);
    await writeLauncherState({ host: 'gw.test', port });
    await writeCert('gw.test.crt', GW_TEST_LEAF_CERT);
    const { spawn } = fakeSpawn(null, {
      error: Object.assign(new Error('spawnSync fake-qwen ENOENT'), {
        code: 'ENOENT',
      }),
    });
    const { code, lines } = await run([workspace], { spawn });
    expect(code).toBe(1);
    expect(lines[1]).toContain('could not run fake-qwen');
  });

  it('exits 2 with usage on bad arguments', async () => {
    const { code, lines } = await run(['--bogus']);
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('qwen-rc attach [cwd] [--session <id>]');
  });
});

describe('classifyReattach', () => {
  const args = { cwd: '/srv/w', sessionId: SESSION };
  const target: GatewayLoopbackTarget = { host: '127.0.0.1', port: 8443 };
  const res = (status: number, body: Record<string, unknown> = {}) => ({
    res: { status, body },
  });

  it('is ready on a 200 that names a session and an argv', () => {
    expect(
      classifyReattach(
        res(200, {
          sessionId: SESSION,
          workspaceCwd: '/srv/canon',
          linuxArgv: ['qwen', '--x'],
        }),
        args,
        target,
      ),
    ).toEqual({
      kind: 'ready',
      linuxArgv: ['qwen', '--x'],
      workspaceCwd: '/srv/canon',
    });
  });

  it('retries 502 and 503', () => {
    for (const status of [502, 503]) {
      expect(classifyReattach(res(status), args, target).kind).toBe('retry');
    }
  });

  it('retries when no gateway is answering yet', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']) {
      const err = Object.assign(new Error('x'), { code });
      expect(classifyReattach({ err }, args, target).kind).toBe('retry');
    }
  });

  it('stops on a 404 with the session_not_found line', () => {
    const got = classifyReattach(
      res(404, { code: 'session_not_found', error: 'Session not found' }),
      args,
      target,
    );
    expect(got).toEqual({
      kind: 'stop',
      message: `qwen-rc attach: no conversation ${SESSION} in /srv/w (session_not_found)`,
    });
  });

  it('stops on 401, 403, 400 and 409', () => {
    for (const status of [401, 403, 400, 409]) {
      expect(classifyReattach(res(status), args, target).kind).toBe('stop');
    }
  });

  it('stops on a 200 with no session in it', () => {
    expect(classifyReattach(res(200, {}), args, target).kind).toBe('stop');
  });

  it('stops on a TLS verification failure rather than waiting on it', () => {
    const err = Object.assign(new Error('bad cert'), {
      code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    });
    const got = classifyReattach({ err }, args, target);
    expect(got.kind).toBe('stop');
  });
});

describe('runHostAttach re-attach', () => {
  const READY = (tag: string) => ({
    status: 200,
    body: {
      sessionId: SESSION,
      workspaceCwd: '/srv/w',
      linuxArgv: ['fake-qwen', `--${tag}`],
    },
  });

  async function reattachRun(opts: {
    statuses: Array<number | null>;
    answers: Array<{ status: number; body: Record<string, unknown> } | Error>;
    deps?: Partial<HostAttachRunDeps>;
  }) {
    await loadOrCreateLocalToken(hostAttachTokenPath(rcDir));
    const statuses = [...opts.statuses];
    const answers = [...opts.answers];
    const spawned: string[][] = [];
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const slept: number[] = [];
    const lines: string[] = [];
    let clock = 0;
    const code = await runHostAttach({
      argv: ['--session', SESSION, '/srv/w'],
      cwd: rcDir,
      rcDir,
      stderr: (l) => lines.push(l),
      spawn: ((cmd: string, args: string[]) => {
        spawned.push([cmd, ...args]);
        clock += 60_000;
        return {
          status: statuses.shift() ?? 0,
          signal: null,
          pid: 1,
          output: [],
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      }) as unknown as HostAttachRunDeps['spawn'],
      request: (async (
        _t: unknown,
        _tok: string,
        path: string,
        body: unknown,
      ) => {
        paths.push(path);
        bodies.push(body);
        const a = answers.shift();
        if (a === undefined) throw new Error('unscripted request');
        if (a instanceof Error) throw a;
        return a;
      }) as unknown as HostAttachRunDeps['request'],
      shieldSignals: () => () => {},
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      now: () => clock,
      watchInterrupt: () => () => {},
      ...opts.deps,
    });
    return { code, spawned, paths, bodies, slept, lines };
  }

  it('relaunches the TUI with the new argv after it exits 75', async () => {
    const out = await reattachRun({
      statuses: [75, 0],
      answers: [READY('first'), READY('second')],
    });
    expect(out.code).toBe(0);
    expect(out.spawned).toEqual([
      ['fake-qwen', '--first'],
      ['fake-qwen', '--second'],
    ]);
    // The re-attach asks by id with the workspace it already has.
    expect(out.paths).toEqual([
      `/rc/host/attach/${SESSION}`,
      `/rc/host/attach/${SESSION}`,
    ]);
    expect(out.bodies[1]).toEqual({ cwd: '/srv/w' });
    expect(out.lines).toEqual([
      `attached ${SESSION} in /srv/w`,
      `daemon gone, re-attaching ${SESSION}…`,
    ]);
  });

  it('waits through 503s, 502s and a closed port, then relaunches', async () => {
    const out = await reattachRun({
      statuses: [75, 3],
      answers: [
        READY('first'),
        { status: 503, body: { code: 'workspace_pool_full' } },
        { status: 502, body: { code: 'daemon_unavailable' } },
        Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
        READY('second'),
      ],
    });
    expect(out.code).toBe(3);
    expect(out.slept).toEqual([1000, 2000, 4000]);
    expect(out.spawned[1]).toEqual(['fake-qwen', '--second']);
  });

  it('exits 1 with the reason when the session is gone (404)', async () => {
    const out = await reattachRun({
      statuses: [75],
      answers: [
        READY('first'),
        { status: 404, body: { code: 'session_not_found' } },
      ],
    });
    expect(out.code).toBe(1);
    expect(out.lines.at(-1)).toBe(
      `qwen-rc attach: no conversation ${SESSION} in /srv/w (session_not_found)`,
    );
    expect(out.spawned).toHaveLength(1);
  });

  it('exits 1 when the gateway refuses the token (401) mid-wait', async () => {
    const out = await reattachRun({
      statuses: [75],
      answers: [READY('first'), { status: 401, body: {} }],
    });
    expect(out.code).toBe(1);
    expect(out.lines.at(-1)).toContain('refused the host-attach token');
  });

  it('passes a non-75 TUI exit straight through without asking the gateway again', async () => {
    const out = await reattachRun({
      statuses: [7],
      answers: [READY('first')],
    });
    expect(out.code).toBe(7);
    expect(out.paths).toHaveLength(1);
  });

  it('exits 130 on Ctrl-C during the wait', async () => {
    let interrupt: (() => void) | undefined;
    const out = await reattachRun({
      statuses: [75],
      answers: [READY('first'), { status: 503, body: {} }],
      deps: {
        watchInterrupt: (fn) => {
          interrupt = fn;
          return () => {};
        },
        sleep: async () => interrupt?.(),
      },
    });
    expect(out.code).toBe(130);
    expect(out.spawned).toHaveLength(1);
  });
});
