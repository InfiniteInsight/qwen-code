/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildPayload,
  buildDigestPayload,
  enforcePayloadBudget,
  MAX_PAYLOAD_BYTES,
  AGENT_EVENT_KINDS,
} from './payload.js';
import {
  KIND_SCOPE,
  SNOOZE_BYPASS_KINDS,
  QUIET_HOURS_BYPASS_KINDS,
} from './notifier.js';
import { SESSION_READ } from '../scopes.js';

describe('buildDigestPayload', () => {
  it('summarizes the total with a metadata-only payload (no session content)', () => {
    const p = buildDigestPayload({
      subscriptionId: 'sub-1',
      total: 3,
      byKind: { 'permission.required': 2, 'task.completed': 1 },
    });
    expect(p).toEqual({
      v: 1,
      kind: 'digest',
      sessionId: '',
      summary: '3 notifications while you were away',
      url: '/ui/',
    });
    // Privacy: the serialized payload must not carry the subscription id or any
    // per-kind/session detail beyond the count baked into the summary string.
    const json = JSON.stringify(p);
    expect(json).not.toContain('sub-1');
    expect(json).not.toContain('permission.required');
  });

  it('uses the singular for a count of one', () => {
    const p = buildDigestPayload({
      subscriptionId: 's',
      total: 1,
      byKind: { 'task.completed': 1 },
    });
    expect(p.summary).toBe('1 notification while you were away');
  });
});

describe('buildPayload', () => {
  it('maps permission_request to permission.required using the toolCall title', () => {
    const p = buildPayload(
      {
        type: 'permission_request',
        // The REAL ACP frame shape: { toolCallId, title, kind, rawInput }.
        data: {
          toolCall: {
            toolCallId: 't7',
            kind: 'execute',
            title: 'Run: npm test',
          },
          requestId: 'req-7',
        },
      },
      { sessionId: 's1', sessionName: 'My Session' },
    );
    expect(p).not.toBeNull();
    expect(p!.v).toBe(1);
    expect(p!.kind).toBe('permission.required');
    expect(p!.sessionId).toBe('s1');
    expect(p!.sessionName).toBe('My Session');
    expect(p!.summary).toBe('Permission needed: Run: npm test');
    expect(p!.url).toBe('/ui/?session=s1');
    expect(p!.requestId).toBe('req-7');
  });

  it('ignores the nonexistent toolCall.name field (wire-mismatch regression)', () => {
    // The daemon never sends `toolCall.name`; a frame carrying only it (the old
    // synthetic test shape) must NOT surface it — it falls back to the generic
    // label, proving the dead `.name` branch is gone.
    const p = buildPayload(
      {
        type: 'permission_request',
        data: { toolCall: { name: 'run_shell_command' }, requestId: 'req-x' },
      },
      { sessionId: 's1' },
    );
    expect(p!.summary).toBe('Permission needed: a tool call');
  });

  it('falls back to "a tool call" when the frame carries no title', () => {
    const p = buildPayload(
      { type: 'permission_request', data: { requestId: 'req-1' } },
      { sessionId: 's2' },
    );
    expect(p!.summary).toBe('Permission needed: a tool call');
  });

  it('truncates summary to <=140 chars with an ellipsis', () => {
    const longTitle = 'x'.repeat(300);
    const p = buildPayload(
      { type: 'permission_request', data: { toolCall: { title: longTitle } } },
      { sessionId: 's3' },
    );
    expect(p!.summary.length).toBe(140);
    expect(p!.summary.endsWith('…')).toBe(true);
  });

  it('returns null for an unknown event type', () => {
    const p = buildPayload(
      { type: 'something_else', data: {} },
      { sessionId: 's4' },
    );
    expect(p).toBeNull();
  });

  it('never leaks rawInput/secrets into the summary or payload', () => {
    const SECRET = 'SUPER-SECRET-API-KEY-9f3a';
    const p = buildPayload(
      {
        type: 'permission_request',
        // Real frame: the secret lives in rawInput (the actual leak vector),
        // and the rendered summary comes only from the humanized `title`.
        data: {
          toolCall: {
            toolCallId: 'tc9',
            kind: 'execute',
            title: 'Run a shell command',
            rawInput: {
              command: `curl -H "auth: ${SECRET}"`,
              directory: '/etc/passwd',
            },
          },
          requestId: 'req-9',
        },
      },
      { sessionId: 's5' },
    );
    expect(p!.summary).toBe('Permission needed: Run a shell command');
    expect(p!.summary).not.toContain(SECRET);
    expect(p!.summary).not.toContain('/etc/passwd');
    expect(JSON.stringify(p)).not.toContain(SECRET);
  });

  it('carries approveOptionId from the first option; omits it when absent; never leaks rawInput', () => {
    const SECRET = 'SUPER-SECRET-API-KEY-9f3a';
    const withOptions = buildPayload(
      {
        type: 'permission_request',
        data: {
          toolCall: {
            toolCallId: 'tc12',
            kind: 'execute',
            title: 'Run a shell command',
            rawInput: {
              command: `curl -H "auth: ${SECRET}"`,
              directory: '/etc/passwd',
            },
          },
          requestId: 'req-12',
          // allow_always at [0] must NOT be chosen; the allow_once one is.
          options: [
            { optionId: 'opt-always', kind: 'allow_always' },
            { optionId: 'opt-allow', kind: 'allow_once' },
            { optionId: 'opt-deny', kind: 'reject_once' },
          ],
        },
      },
      { sessionId: 's6' },
    );
    expect(withOptions!.approveOptionId).toBe('opt-allow');
    expect(JSON.stringify(withOptions)).not.toContain(SECRET);
    expect(JSON.stringify(withOptions)).not.toContain('/etc/passwd');

    const noOptions = buildPayload(
      { type: 'permission_request', data: { requestId: 'req-13' } },
      { sessionId: 's7' },
    );
    expect(noOptions!.approveOptionId).toBeUndefined();
    expect('approveOptionId' in noOptions!).toBe(false);
  });

  it('encodes the sessionId in the url', () => {
    const p = buildPayload(
      { type: 'permission_request', data: {} },
      { sessionId: 'a/b c' },
    );
    expect(p!.url).toBe('/ui/?session=a%2Fb%20c');
  });
});

describe('enforcePayloadBudget', () => {
  function makePayload(summary: string) {
    return {
      v: 1 as const,
      kind: 'permission.required',
      sessionId: 'ses-1',
      summary,
      url: '/ui/?session=ses-1',
    };
  }

  it('returns the payload unchanged when it is within budget', () => {
    const payload = makePayload('short summary');
    const result = enforcePayloadBudget(payload);
    expect(result.truncated).toBe(false);
    expect(result.payload).toBe(payload); // same reference (not mutated)
    expect(
      Buffer.byteLength(JSON.stringify(result.payload), 'utf8'),
    ).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it('truncates the summary with … when the payload exceeds 3800 bytes', () => {
    // Build an oversized summary: ~4000 chars will push the payload well over
    const bigSummary = 'x'.repeat(4000);
    const payload = makePayload(bigSummary);
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeGreaterThan(
      MAX_PAYLOAD_BYTES,
    );

    const result = enforcePayloadBudget(payload);
    expect(result.truncated).toBe(true);
    expect(result.payload.summary.endsWith('…')).toBe(true);
    expect(result.payload.summary.length).toBeLessThan(bigSummary.length);
    expect(
      Buffer.byteLength(JSON.stringify(result.payload), 'utf8'),
    ).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it('does not mutate the original payload', () => {
    const bigSummary = 'y'.repeat(4000);
    const payload = makePayload(bigSummary);
    enforcePayloadBudget(payload);
    expect(payload.summary).toBe(bigSummary); // original unchanged
  });

  it('returns truncated:false for a normal-length summary', () => {
    const payload = makePayload('Permission needed: run_shell_command');
    const result = enforcePayloadBudget(payload);
    expect(result.truncated).toBe(false);
  });
});

describe('agent lifecycle payloads', () => {
  it('maps each lifecycle event type to its dot-kind with a metadata-only summary', () => {
    const data = {
      agentId: 'a1',
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 'sekrit task text',
      status: 'completed',
      costMicrocents: 5000,
    };
    const p = buildPayload(
      { type: 'agent_completed', data },
      { sessionId: 's1', sessionName: 'agent run' },
    );
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('agent.completed');
    expect(p!.sessionId).toBe('s1');
    // Metadata only — the task text must NEVER reach a push payload.
    expect(JSON.stringify(p)).not.toContain('sekrit task text');
    expect(AGENT_EVENT_KINDS['agent_blocked']).toBe('agent.blocked');
    for (const t of [
      'agent_spawned',
      'agent_failed',
      'agent_blocked',
      'agent_cancelled',
    ]) {
      const built = buildPayload(
        { type: t, data: { ...data, status: t.slice(6) } },
        { sessionId: 's1' },
      );
      expect(built?.kind).toBe(AGENT_EVENT_KINDS[t]);
    }
  });
});

describe('review lifecycle push payloads', () => {
  it('maps review_completed to kind review.completed with a metadata-only summary', () => {
    const p = buildPayload(
      {
        type: 'review_completed',
        data: {
          reviewId: 'r',
          sessionId: 's',
          target: { kind: 'local' },
          status: 'completed',
        },
      },
      { sessionId: 's' },
    );
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('review.completed');
    expect(p!.sessionId).toBe('s');
    expect(p!.summary.length).toBeGreaterThan(0);
    expect(p!.url).toBe('/ui/?session=s');
  });

  it('maps review_failed to kind review.failed', () => {
    const p = buildPayload(
      {
        type: 'review_failed',
        data: {
          reviewId: 'r',
          sessionId: 's',
          target: { kind: 'local' },
          status: 'failed',
        },
      },
      { sessionId: 's' },
    );
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('review.failed');
  });

  it('does NOT map review_started/review_cancelled (stream-only, not notification kinds)', () => {
    const started = buildPayload(
      {
        type: 'review_started',
        data: {
          reviewId: 'r',
          sessionId: 's',
          target: { kind: 'local' },
          status: 'running',
        },
      },
      { sessionId: 's' },
    );
    expect(started).toBeNull();

    const cancelled = buildPayload(
      {
        type: 'review_cancelled',
        data: {
          reviewId: 'r',
          sessionId: 's',
          target: { kind: 'local' },
          status: 'cancelled',
        },
      },
      { sessionId: 's' },
    );
    expect(cancelled).toBeNull();
  });

  it('notes a PR number in the summary for a pr target, but NEVER a filesystem path for a path target', () => {
    const prPayload = buildPayload(
      {
        type: 'review_completed',
        data: {
          reviewId: 'r',
          sessionId: 's',
          target: { kind: 'pr', number: 42 },
          status: 'completed',
        },
      },
      { sessionId: 's' },
    );
    expect(prPayload!.summary).toContain('42');

    const SECRET_PATH = '/Users/alice/secret-project/src/creds.ts';
    const pathPayload = buildPayload(
      {
        type: 'review_completed',
        data: {
          reviewId: 'r',
          sessionId: 's',
          target: { kind: 'path', path: SECRET_PATH },
          status: 'completed',
        },
      },
      { sessionId: 's' },
    );
    expect(JSON.stringify(pathPayload)).not.toContain(SECRET_PATH);
    expect(JSON.stringify(pathPayload)).not.toContain('secret-project');
  });

  it('scope-gates review.completed/review.failed at session:read and does NOT bypass snooze', () => {
    expect(KIND_SCOPE['review.completed']).toBe(SESSION_READ);
    expect(KIND_SCOPE['review.failed']).toBe(SESSION_READ);
    expect(SNOOZE_BYPASS_KINDS.has('review.completed')).toBe(false);
    expect(SNOOZE_BYPASS_KINDS.has('review.failed')).toBe(false);
  });
});

describe('session_rewound push payload', () => {
  it('maps to kind session.rewound with a turn-number summary, no content', () => {
    const payload = buildPayload(
      { type: 'session_rewound', data: { toTurn: 3, truncatedEventId: 7 } },
      { sessionId: 's-1', sessionName: 'My Session' },
    );
    expect(payload).toMatchObject({
      kind: 'session.rewound',
      sessionId: 's-1',
      sessionName: 'My Session',
    });
    expect(payload?.summary).toContain('3');
    expect(JSON.stringify(payload)).not.toContain('truncatedEventId');
  });

  it('scope-gates at session:read and does NOT bypass snooze', () => {
    expect(KIND_SCOPE['session.rewound']).toBe(SESSION_READ);
    expect(SNOOZE_BYPASS_KINDS.has('session.rewound')).toBe(false);
  });
});

describe('approval_mode_changed push payload', () => {
  it('maps approval_mode_changed to session.approval_mode_changed with the next mode', () => {
    const p = buildPayload(
      {
        type: 'approval_mode_changed',
        data: {
          sessionId: 's1',
          previous: 'default',
          next: 'plan',
          persisted: false,
        },
      },
      { sessionId: 's1' },
    );
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('session.approval_mode_changed');
    expect(p!.summary).toBe('Approval mode → plan');
  });

  it('gives approval_mode_changed a generic summary when next is absent', () => {
    const p = buildPayload(
      { type: 'approval_mode_changed', data: { sessionId: 's1' } },
      { sessionId: 's1' },
    );
    expect(p!.kind).toBe('session.approval_mode_changed');
    expect(p!.summary).toBe('Approval mode changed');
  });
});

describe('session_interrupted push payload', () => {
  it('maps a recovered interruption to session.interrupted with the exit code', () => {
    const p = buildPayload(
      {
        type: 'session_interrupted',
        data: {
          sessionId: 's1',
          recovered: true,
          hadInFlightTurn: true,
          exitCode: 1,
        },
      },
      { sessionId: 's1', sessionName: 'My Session' },
    );
    expect(p).toMatchObject({
      kind: 'session.interrupted',
      sessionId: 's1',
      sessionName: 'My Session',
    });
    expect(p!.summary).toBe('Daemon restarted; session recovered (exit 1)');
    expect(p!.url).toBe('/ui/?session=s1');
  });

  it('omits the exit-code suffix when exitCode is absent', () => {
    const p = buildPayload(
      {
        type: 'session_interrupted',
        data: { sessionId: 's1', recovered: true, hadInFlightTurn: false },
      },
      { sessionId: 's1' },
    );
    expect(p!.kind).toBe('session.interrupted');
    expect(p!.summary).toBe('Daemon restarted; session recovered');
  });

  it('maps an unrecovered interruption to a crash summary', () => {
    const p = buildPayload(
      {
        type: 'session_interrupted',
        data: {
          sessionId: 's1',
          recovered: false,
          hadInFlightTurn: true,
          exitCode: 137,
        },
      },
      { sessionId: 's1' },
    );
    expect(p!.kind).toBe('session.interrupted');
    expect(p!.summary).toBe(
      'Daemon crashed and session was not recovered (exit 137)',
    );
  });

  it('maps an unrecovered interruption without an exit code (signal death)', () => {
    const p = buildPayload(
      {
        type: 'session_interrupted',
        data: { sessionId: 's1', recovered: false, hadInFlightTurn: false },
      },
      { sessionId: 's1' },
    );
    expect(p!.kind).toBe('session.interrupted');
    expect(p!.summary).toBe('Daemon crashed and session was not recovered');
  });
});

describe('session_recovered push payload', () => {
  it('maps to session.recovered with a fixed summary (tookMs is never shown)', () => {
    const p = buildPayload(
      { type: 'session_recovered', data: { sessionId: 's1', tookMs: 42 } },
      { sessionId: 's1' },
    );
    expect(p).toMatchObject({
      kind: 'session.recovered',
      sessionId: 's1',
    });
    expect(p!.summary).toBe('Session recovered');
    expect(p!.url).toBe('/ui/?session=s1');
  });

  it('scope-gates both kinds at session:read; interrupted bypasses quiet hours, recovered does not; neither bypasses snooze', () => {
    expect(KIND_SCOPE['session.interrupted']).toBe(SESSION_READ);
    expect(KIND_SCOPE['session.recovered']).toBe(SESSION_READ);
    expect(SNOOZE_BYPASS_KINDS.has('session.interrupted')).toBe(false);
    expect(SNOOZE_BYPASS_KINDS.has('session.recovered')).toBe(false);
    expect(QUIET_HOURS_BYPASS_KINDS.has('session.interrupted')).toBe(true);
    expect(QUIET_HOURS_BYPASS_KINDS.has('session.recovered')).toBe(false);
  });
});

describe('turn-end push payloads (#40)', () => {
  it('maps prompt_completed to session.turn_complete with a fixed summary', () => {
    const p = buildPayload(
      { type: 'prompt_completed', data: { stopReason: 'end_turn' } },
      { sessionId: 's1', sessionName: 'My Session' },
    );
    expect(p).toMatchObject({
      v: 1,
      kind: 'session.turn_complete',
      sessionId: 's1',
      sessionName: 'My Session',
      summary: 'Reply ready',
      url: '/ui/?session=s1',
    });
    // Metadata only — a stop reason is never surfaced in the summary.
    expect(JSON.stringify(p)).not.toContain('end_turn');
  });

  it('omits sessionName when absent (direct call sites pass sessionId only)', () => {
    const p = buildPayload(
      { type: 'prompt_completed', data: {} },
      { sessionId: 's2' },
    );
    expect(p).not.toBeNull();
    expect('sessionName' in p!).toBe(false);
  });

  it('maps prompt_failed reason timeout to session.turn_failed "Turn timed out"', () => {
    const p = buildPayload(
      { type: 'prompt_failed', data: { reason: 'timeout' } },
      { sessionId: 's1' },
    );
    expect(p).toMatchObject({
      v: 1,
      kind: 'session.turn_failed',
      sessionId: 's1',
      summary: 'Turn timed out',
      url: '/ui/?session=s1',
    });
  });

  it('maps prompt_failed error (and missing/blank/non-string reason) to "Turn failed"', () => {
    for (const data of [
      { reason: 'error' },
      {},
      { reason: '' },
      { reason: 42 },
    ]) {
      const p = buildPayload(
        { type: 'prompt_failed', data },
        { sessionId: 's1' },
      );
      expect(p!.kind).toBe('session.turn_failed');
      expect(p!.summary).toBe('Turn failed');
    }
  });

  it('does NOT map the daemon-prefixed turn events (pump double-push guard)', () => {
    // The pump forwards EVERY daemon event to the notifier. The daemon's
    // own turn-end events are pending_prompt_completed / turn_error — never
    // the bare prompt_* types the onTurnEnd hook emits — so these must
    // produce no payload, or every turn would push twice.
    for (const type of ['pending_prompt_completed', 'turn_error']) {
      expect(buildPayload({ type, data: {} }, { sessionId: 's1' })).toBeNull();
    }
  });

  it('scope-gates both kinds at session:read; neither bypasses snooze or quiet hours', () => {
    expect(KIND_SCOPE['session.turn_complete']).toBe(SESSION_READ);
    expect(KIND_SCOPE['session.turn_failed']).toBe(SESSION_READ);
    expect(SNOOZE_BYPASS_KINDS.has('session.turn_complete')).toBe(false);
    expect(SNOOZE_BYPASS_KINDS.has('session.turn_failed')).toBe(false);
    expect(QUIET_HOURS_BYPASS_KINDS.has('session.turn_complete')).toBe(false);
    expect(QUIET_HOURS_BYPASS_KINDS.has('session.turn_failed')).toBe(false);
  });
});
