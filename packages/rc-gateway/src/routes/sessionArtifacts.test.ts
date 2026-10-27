/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { UnknownSessionError, type SessionDaemon } from '../daemonPool.js';
import {
  createSessionArtifactContentRoute,
  createSessionArtifactListRoute,
} from './sessionArtifacts.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/**
 * The relay paths run a real `DaemonClient` against the stub, so the request
 * the daemon receives is built by the SDK rather than by this file. For the
 * content read that matters more than usual: the SDK's own `res.text()` read
 * is what throws away the daemon's headers, and only a live client can show
 * what survives that trip.
 */
async function mountGateway(
  handler: express.RequestHandler,
  path: string,
): Promise<string> {
  const app = express();
  app.get(path, handler);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';
const AID = 'art-web-1';

/**
 * A daemon that answers with a chosen outcome, for the verdicts a live client
 * cannot produce - chiefly `UnknownSessionError`, which the pool raises before
 * any request leaves the process.
 */
function fakeDaemon(
  which: 'listSessionArtifacts' | 'readSessionArtifactContent',
  behaviour: { result?: unknown; thrown?: unknown } = {},
): SessionDaemon {
  return {
    [which]: async () => {
      if (behaviour.thrown !== undefined) throw behaviour.thrown;
      return behaviour.result ?? {};
    },
  } as unknown as SessionDaemon;
}

async function callRoute(
  handler: express.RequestHandler,
  params: Record<string, string>,
) {
  const res = {
    status(code: number) {
      this.code = code;
      return this;
    },
    set(headers: Record<string, string>) {
      this.headers = headers;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    send(body: unknown) {
      this.sent = body;
      return this;
    },
  } as unknown as express.Response & {
    code?: number;
    body?: unknown;
    sent?: unknown;
    headers?: Record<string, string>;
  };
  const req = { params } as unknown as express.Request;
  await handler(req, res, () => {});
  return {
    status: res.code,
    body: res.body,
    sent: res.sent,
    headers: res.headers,
  };
}

describe('GET /session/:id/artifacts', () => {
  it('relays the envelope the page reads, untouched', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(
      createSessionArtifactListRoute(daemon),
      '/session/:id/artifacts',
    );

    const res = await fetch(`${url}/session/${SID}/artifacts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      v: number;
      sessionId: string;
      limits: { maxArtifacts: number };
      artifacts: Array<{
        id: string;
        kind: string;
        title: string;
        status: string;
        sizeBytes?: number;
      }>;
    };
    // Nothing is re-shaped on the way through: the envelope stays the
    // daemon's, including the fields this file never names.
    expect(body.v).toBe(1);
    expect(body.sessionId).toBe(SID);
    expect(body.limits.maxArtifacts).toBe(64);
    expect(body.artifacts).toHaveLength(2);
    expect(body.artifacts[0]).toMatchObject({
      id: 'art-web-1',
      kind: 'html',
      status: 'available',
      sizeBytes: 2048,
    });
    expect(body.artifacts[1]).toMatchObject({ id: 'art-file-1', kind: 'file' });
  });

  it('carries the watched id through to the daemon', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(
      createSessionArtifactListRoute(daemon),
      '/session/:id/artifacts',
    );

    await fetch(`${url}/session/${SID}/artifacts`);
    expect(stub.lastArtifactListSessionId).toBe(SID);
  });

  it('404s a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(
      createSessionArtifactListRoute(daemon),
      '/session/:id/artifacts',
    );

    const res = await fetch(`${url}/session/zzz-not-a-valid-id/artifacts`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
    // The local check is only real if nothing left the process.
    expect(stub.lastArtifactListSessionId).toBeUndefined();
  });

  it('relays a daemon 404 as a missing conversation, not a missing capability', async () => {
    // `session_artifacts` is advertised since v1
    // (packages/cli/src/serve/capabilities.ts:91), so there is no daemon
    // version without these routes. The recap read's `*_unsupported` mapping
    // must NOT be copied here.
    stub = await startStubDaemon({ artifactListStatus: 404 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(
      createSessionArtifactListRoute(daemon),
      '/session/:id/artifacts',
    );

    const res = await fetch(`${url}/session/${SID}/artifacts`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
  });

  it('says session_not_loaded when the pool no longer holds the session', async () => {
    const out = await callRoute(
      createSessionArtifactListRoute(
        fakeDaemon('listSessionArtifacts', {
          thrown: new UnknownSessionError(SID),
        }),
      ),
      { id: SID },
    );
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: 'Open this conversation before reading its artifacts',
      code: 'session_not_loaded',
    });
  });

  it('falls through to 502 for a daemon failure that is not a verdict', async () => {
    const out = await callRoute(
      createSessionArtifactListRoute(
        fakeDaemon('listSessionArtifacts', {
          thrown: new DaemonHttpError(500, {}, 'boom'),
        }),
      ),
      { id: SID },
    );
    expect(out.status).toBe(502);
    expect(out.body).toEqual({
      error: 'Daemon unavailable',
      code: 'daemon_unavailable',
    });
  });
});

describe('GET /session/:id/artifacts/:artifactId/content', () => {
  it('serves the snapshot with the four headers that keep it from rendering', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(
      createSessionArtifactContentRoute(daemon),
      '/session/:id/artifacts/:artifactId/content',
    );

    const res = await fetch(`${url}/session/${SID}/artifacts/${AID}/content`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<!doctype html><p>saved snapshot</p>');

    // The load-bearing assertion in this file. The body is HTML the daemon
    // saved off the web and it is served from an origin that holds the
    // operator's token, on a gateway that sets no CSP at all. `attachment`
    // plus `nosniff` are what stop that body executing there, so a route that
    // "just sent the string" and let Express default to text/html would pass
    // every other test in this file while being the vulnerability.
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="saved-webpage.html"',
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('carries both ids through to the daemon', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(
      createSessionArtifactContentRoute(daemon),
      '/session/:id/artifacts/:artifactId/content',
    );

    await fetch(`${url}/session/${SID}/artifacts/${AID}/content`);
    expect(stub.lastArtifactContent).toEqual({
      sessionId: SID,
      artifactId: AID,
    });
  });

  it("relays the daemon's artifact_snapshot_unavailable pair verbatim", async () => {
    // A missing snapshot is a specific verdict about one artifact, not a
    // daemon that failed to answer. Folding it into 502 would tell a reader to
    // retry something that can never succeed.
    stub = await startStubDaemon({ artifactContentStatus: 404 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(
      createSessionArtifactContentRoute(daemon),
      '/session/:id/artifacts/:artifactId/content',
    );

    const res = await fetch(`${url}/session/${SID}/artifacts/${AID}/content`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('artifact_snapshot_unavailable');
    expect(body.message).toBe(
      'Saved webpage version is missing or has changed.',
    );
  });

  it('calls a bare 404 a capability answer, not a verdict about the artifact', async () => {
    // A 404 with no envelope behind it is a daemon with no artifact routes,
    // which is a different fact than "this snapshot is gone".
    const out = await callRoute(
      createSessionArtifactContentRoute(
        fakeDaemon('readSessionArtifactContent', {
          thrown: new DaemonHttpError(404, {}, 'no route'),
        }),
      ),
      { id: SID, artifactId: AID },
    );
    expect(out.status).toBe(502);
    expect(out.body).toEqual({
      error: 'This daemon cannot read artifact snapshots',
      code: 'artifact_snapshot_unsupported',
    });
  });

  it('refuses a traversal-shaped artifact id before any daemon call', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(
      createSessionArtifactContentRoute(daemon),
      '/session/:id/artifacts/:artifactId/content',
    );

    // Express collapses `..` in a path, so the shaped id is sent encoded; the
    // point is that nothing reaches the daemon with it.
    const res = await fetch(
      `${url}/session/${SID}/artifacts/${encodeURIComponent(
        '../../etc/passwd',
      )}/content`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_artifact_id');
    expect(stub.lastArtifactContent).toBeUndefined();
  });

  it('says session_not_loaded when the pool no longer holds the session', async () => {
    const out = await callRoute(
      createSessionArtifactContentRoute(
        fakeDaemon('readSessionArtifactContent', {
          thrown: new UnknownSessionError(SID),
        }),
      ),
      { id: SID, artifactId: AID },
    );
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: 'Open this conversation before reading its artifacts',
      code: 'session_not_loaded',
    });
  });

  it('refuses to serve a body that is not a string', async () => {
    // The SDK's contract is `res.text()`. A shape change one layer down must
    // not become `undefined` in a response body.
    const out = await callRoute(
      createSessionArtifactContentRoute(
        fakeDaemon('readSessionArtifactContent', { result: { html: 'x' } }),
      ),
      { id: SID, artifactId: AID },
    );
    expect(out.status).toBe(502);
    expect(out.sent).toBeUndefined();
    expect(out.body).toEqual({
      error: 'Daemon returned an unreadable artifact',
      code: 'daemon_unavailable',
    });
  });
});
