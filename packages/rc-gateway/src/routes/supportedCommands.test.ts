/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import type { RcScope } from '../scopes.js';
import { SESSION_READ, WRITE } from '../scopes.js';
import {
  createSupportedCommandsRoute,
  createSessionCommandInvokeRoute,
} from './supportedCommands.js';

class FakeAudit implements AuditRecorder {
  entries: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

/** Inject a stub req.rcClient with the given scopes, before the route. */
function fakeClient(scopes: RcScope[]): RequestHandler {
  return (req, _res, next) => {
    req.rcClient = { id: 'tok-1', scopes };
    next();
  };
}

async function listen(app: express.Express): Promise<string> {
  const s: Server = await new Promise((resolve) => {
    const x = app.listen(0, '127.0.0.1', () => resolve(x));
  });
  gateway = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const SID = '11111111-1111-1111-1111-111111111111';

/** The session's own list, as the daemon would advertise it. */
const sessionCommands = [
  {
    name: 'diff',
    description: 'Show working-tree change stats versus HEAD',
    input: null,
    _meta: { source: 'builtin-command', sourceLabel: 'Built-in' },
  },
  {
    name: 'clear',
    description: 'Clear conversation history and free up context',
    input: null,
    _meta: { source: 'builtin-command', sourceLabel: 'Built-in' },
  },
];

describe('GET /session/:id/supported-commands', () => {
  it('relays the daemon list and marks a WRITE caller able to invoke', async () => {
    stub = await startStubDaemon({ supportedCommands: sessionCommands });
    const app = express();
    app.get(
      '/session/:id/supported-commands',
      fakeClient([SESSION_READ, WRITE]),
      createSupportedCommandsRoute(new DaemonClient({ baseUrl: stub.baseUrl })),
    );
    const url = await listen(app);

    const res = await fetch(`${url}/session/${SID}/supported-commands`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      v: number;
      sessionId: string;
      availableCommands: Array<{
        name: string;
        _meta?: { sourceLabel?: string };
      }>;
      invocableByYou: boolean;
    };
    expect(body.v).toBe(1);
    expect(body.sessionId).toBe(SID);
    expect(body.availableCommands.map((c) => c.name)).toEqual([
      'diff',
      'clear',
    ]);
    expect(body.availableCommands[0]?._meta?.sourceLabel).toBe('Built-in');
    expect(body.invocableByYou).toBe(true);
  });

  it('lists the rows to a read-only caller with invocableByYou false', async () => {
    stub = await startStubDaemon({ supportedCommands: sessionCommands });
    const app = express();
    app.get(
      '/session/:id/supported-commands',
      fakeClient([SESSION_READ]),
      createSupportedCommandsRoute(new DaemonClient({ baseUrl: stub.baseUrl })),
    );
    const url = await listen(app);

    const res = await fetch(`${url}/session/${SID}/supported-commands`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      availableCommands: unknown[];
      invocableByYou: boolean;
    };
    // List-don't-hide: the rows are still there, the flag says they can't run.
    expect(body.availableCommands).toHaveLength(2);
    expect(body.invocableByYou).toBe(false);
  });

  it('404s a malformed session id before any daemon call', async () => {
    stub = await startStubDaemon({ supportedCommands: sessionCommands });
    const app = express();
    app.get(
      '/session/:id/supported-commands',
      createSupportedCommandsRoute(new DaemonClient({ baseUrl: stub.baseUrl })),
    );
    const url = await listen(app);

    const res = await fetch(
      `${url}/session/zzz-not-a-valid-id/supported-commands`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('session_not_found');
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ supportedCommandsStatus: 500 });
    const app = express();
    app.get(
      '/session/:id/supported-commands',
      createSupportedCommandsRoute(new DaemonClient({ baseUrl: stub.baseUrl })),
    );
    const url = await listen(app);

    const res = await fetch(`${url}/session/${SID}/supported-commands`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('daemon_unavailable');
  });
});

describe('POST /session/:id/supported-commands/:name', () => {
  async function mountInvoke(
    opts: Parameters<typeof startStubDaemon>[0],
    scopes: RcScope[],
    audit?: AuditRecorder,
  ): Promise<string> {
    stub = await startStubDaemon(opts);
    const app = express();
    app.use(express.json());
    app.post(
      '/session/:id/supported-commands/:name',
      fakeClient(scopes),
      createSessionCommandInvokeRoute(
        new DaemonClient({ baseUrl: stub.baseUrl }),
        audit,
      ),
    );
    return listen(app);
  }

  it('posts the bare /name as the session prompt and returns stopReason', async () => {
    const url = await mountInvoke({ supportedCommands: sessionCommands }, [
      WRITE,
    ]);

    const res = await fetch(`${url}/session/${SID}/supported-commands/diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stopReason: string }).stopReason).toBe(
      'end_turn',
    );
    const sent = stub!.lastPromptBody as {
      prompt: Array<{ type: string; text: string }>;
    };
    expect(sent.prompt).toEqual([{ type: 'text', text: '/diff' }]);
  });

  it('appends args after the name, verbatim', async () => {
    const url = await mountInvoke({ supportedCommands: sessionCommands }, [
      WRITE,
    ]);

    const res = await fetch(`${url}/session/${SID}/supported-commands/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: 'hello world' }),
    });
    expect(res.status).toBe(200);
    const sent = stub!.lastPromptBody as {
      prompt: Array<{ type: string; text: string }>;
    };
    expect(sent.prompt).toEqual([{ type: 'text', text: '/clear hello world' }]);
  });

  it('refuses a name the session does not advertise, and never prompts', async () => {
    const audit = new FakeAudit();
    const url = await mountInvoke(
      { supportedCommands: sessionCommands },
      [WRITE],
      audit,
    );

    const res = await fetch(
      `${url}/session/${SID}/supported-commands/not-a-command`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      'command_not_available',
    );
    // The guard's whole point: nothing reached the model-shaped path.
    expect(stub!.promptCallLog).toHaveLength(0);
    expect(audit.entries.map((e) => e.action)).toEqual([
      'session_command_unavailable',
    ]);
  });

  it('fails closed when the list read itself errors, and never prompts', async () => {
    const audit = new FakeAudit();
    const url = await mountInvoke(
      { supportedCommandsStatus: 500 },
      [WRITE],
      audit,
    );

    const res = await fetch(`${url}/session/${SID}/supported-commands/diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe(
      'daemon_unavailable',
    );
    expect(stub!.promptCallLog).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('audits the invoke with the name and stopReason, never the args', async () => {
    const audit = new FakeAudit();
    const url = await mountInvoke(
      { supportedCommands: sessionCommands },
      [WRITE],
      audit,
    );

    const res = await fetch(`${url}/session/${SID}/supported-commands/diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: 'keep-me-out-of-the-log' }),
    });
    expect(res.status).toBe(200);
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0]!;
    expect(entry.action).toBe('session_command_invoked');
    expect(entry.target).toBe(SID);
    expect(entry.detail).toEqual({ name: 'diff', stopReason: 'end_turn' });
    expect(JSON.stringify(entry)).not.toContain('keep-me-out-of-the-log');
  });

  it('400s non-string args', async () => {
    const url = await mountInvoke({ supportedCommands: sessionCommands }, [
      WRITE,
    ]);

    const res = await fetch(`${url}/session/${SID}/supported-commands/diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['a', 'b'] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_args');
    expect(stub!.promptCallLog).toHaveLength(0);
  });

  it('404s a malformed session id before any daemon call', async () => {
    const url = await mountInvoke({ supportedCommands: sessionCommands }, [
      WRITE,
    ]);

    const res = await fetch(
      `${url}/session/zzz-not-a-valid-id/supported-commands/diff`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      'session_not_found',
    );
  });
});
