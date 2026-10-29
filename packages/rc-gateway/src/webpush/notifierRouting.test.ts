/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
import { TokenStore } from '../tokenStore.js';
import { PushStore } from '../pushStore.js';
import { VapidStore } from './vapid.js';
import { PushSender, type PushTransport } from './sender.js';
import { PushNotifier } from './notifier.js';
import { ApnsStore } from '../nativePush/apnsStore.js';
import { SESSION_READ, APPROVE } from '../scopes.js';
import { WorkingDeviceTracker } from '../routing/workingDevice.js';
import { compileRouting, loadRoutingConfig } from '../routing/rules.js';

/**
 * Issue #166: the routing event the notifier builds must carry the fields a
 * rule can match on, and the per-subscription pass must be told whether the
 * subscription's token is a working device.
 */

let dir: string;
let tokens: TokenStore;
let store: PushStore;
let audit: AuditRecorder & { calls: AuditEntry[] };
let sent: string[];
let sender: PushSender;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rc-notifier-routing-'));
  tokens = await TokenStore.open(join(dir, 'tokens.json'));
  store = await PushStore.open(join(dir, 'push.json'));
  const vapid = await VapidStore.open(join(dir, 'vapid.json'));
  const calls: AuditEntry[] = [];
  audit = { calls, record: async (e: AuditEntry) => void calls.push(e) };
  sent = [];
  const transport: PushTransport = async (sub) => {
    sent.push(sub.endpoint);
    return { statusCode: 201 };
  };
  sender = new PushSender(vapid, store, audit, {
    transport,
    backoffMs: [0, 0, 0, 0, 0],
    sleep: async () => {},
  });
});

const COMPLETED = {
  type: 'agent_completed',
  data: { agentType: 'general-purpose', status: 'completed' },
};
const PERM = {
  type: 'permission_request',
  data: { toolCall: { kind: 'execute', title: 'bash' }, requestId: 'r1' },
};

function matcher(yaml: string) {
  return compileRouting(loadRoutingConfig(yaml, { warn: () => {} }));
}

async function sub(label: string) {
  const t = await tokens.issue([SESSION_READ, APPROVE], label);
  await store.add(t.id, {
    endpoint: `https://push.example.com/${label}`,
    keys: { p256dh: 'p', auth: 'a' },
  });
  return t;
}

describe('suppressIfWorkingDevice reaches the matcher (issue #166)', () => {
  const RULE = `
rules:
  - id: quiet-when-working
    match: { kind: agent.completed, suppressIfWorkingDevice: true }
    route: { drop: true }
`;

  it('drops the push for a working device only', async () => {
    const working = await sub('working');
    await sub('idle');
    const tracker = new WorkingDeviceTracker();
    tracker.touch(working.id);
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      tracker,
      matcher(RULE),
    );
    await notifier.notify(COMPLETED, { sessionId: 's1' });
    expect(sent).toEqual(['https://push.example.com/idle']);
    expect(
      audit.calls.find((c) => c.action === 'push_suppressed')?.detail,
    ).toMatchObject({ reason: 'routing_rule', ruleId: 'quiet-when-working' });
  });

  it('with no tracker wired the rule never drops (device is not working)', async () => {
    await sub('a');
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      matcher(RULE),
    );
    await notifier.notify(COMPLETED, { sessionId: 's1' });
    expect(sent).toHaveLength(1);
  });

  it('a suppressIfWorkingDevice:false rule drops only the idle device', async () => {
    const working = await sub('working');
    await sub('idle');
    const tracker = new WorkingDeviceTracker();
    tracker.touch(working.id);
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      tracker,
      matcher(`
rules:
  - match: { kind: agent.completed, suppressIfWorkingDevice: false }
    route: { drop: true }
`),
    );
    await notifier.notify(COMPLETED, { sessionId: 's1' });
    expect(sent).toEqual(['https://push.example.com/working']);
  });

  it('applies to APNs devices too (an explicit operator rule)', async () => {
    const t = await tokens.issue([SESSION_READ, APPROVE], 'ios');
    const apnsStore = await ApnsStore.open(join(dir, 'apns.json'));
    await apnsStore.register({
      tokenId: t.id,
      deviceToken: 'dev',
      bundleId: 'b',
      shellVersion: '1',
    });
    const apnsSent: string[] = [];
    const tracker = new WorkingDeviceTracker();
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      tracker,
      matcher(RULE),
      undefined,
      undefined,
      undefined,
      {
        store: apnsStore,
        sender: {
          send: async (s) => {
            apnsSent.push(s.deviceToken);
            return { ok: true };
          },
        },
      },
    );
    await notifier.notify(COMPLETED, { sessionId: 's1' });
    expect(apnsSent).toEqual(['dev']); // idle: not dropped
    tracker.touch(t.id);
    await notifier.notify(COMPLETED, { sessionId: 's2' });
    expect(apnsSent).toEqual(['dev']); // working: dropped
  });
});

describe('policy fields on the routing event (issue #166)', () => {
  const RULE = `
rules:
  - id: silence-fallthrough-prompts
    match: { kind: permission.required, policy.decisionSource: fallthrough, policy.action: prompt }
    route: { drop: true }
`;

  it('a rule on policy.action / policy.decisionSource matches when the source stamps them', async () => {
    await sub('a');
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      matcher(RULE),
    );
    await notifier.notify(PERM, {
      sessionId: 's1',
      routing: { policyAction: 'prompt', policyDecisionSource: 'fallthrough' },
    });
    expect(sent).toHaveLength(0);
    expect(
      audit.calls.find((c) => c.action === 'push_suppressed')?.detail,
    ).toMatchObject({
      reason: 'routing_rule',
      ruleId: 'silence-fallthrough-prompts',
    });
  });

  it('does not match a different decision, or an event that carries none', async () => {
    await sub('a');
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      matcher(RULE),
    );
    await notifier.notify(PERM, {
      sessionId: 's1',
      routing: { policyAction: 'prompt', policyDecisionSource: 'rule' },
    });
    await notifier.notify(PERM, { sessionId: 's1' });
    expect(sent).toHaveLength(2);
  });

  it('per-subscription rules see the policy fields too', async () => {
    const t = await sub('a');
    const notifier = new PushNotifier(
      tokens,
      store,
      sender,
      undefined,
      audit,
      undefined,
      matcher(`
rules:
  - match: { kind: permission.required, policy.action: prompt, tokenIdsIn: ["${t.id}"] }
    route: { drop: true }
`),
    );
    await notifier.notify(PERM, {
      sessionId: 's1',
      routing: { policyAction: 'prompt', policyDecisionSource: 'rule' },
    });
    expect(sent).toHaveLength(0);
  });
});
