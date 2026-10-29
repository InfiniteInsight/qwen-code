/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  KIND_SCOPE,
  QUIET_HOURS_BYPASS_KINDS,
  SNOOZE_BYPASS_KINDS,
} from './notifier.js';
import { SESSION_READ } from '../scopes.js';

describe('agent notification kinds', () => {
  it('scope-gates all five agent kinds at session:read', () => {
    for (const kind of [
      'agent.spawned',
      'agent.completed',
      'agent.failed',
      'agent.blocked',
      'agent.cancelled',
    ]) {
      expect(KIND_SCOPE[kind]).toBe(SESSION_READ);
    }
  });

  it('no agent kind bypasses snooze or quiet hours (issue #166)', () => {
    // agent.blocked used to bypass both, which paged a snoozed operator for a
    // blocked agent while the permission.required push for the SAME request
    // honoured the snooze. Only session.died and policy.deny stay critical.
    for (const kind of [
      'agent.spawned',
      'agent.completed',
      'agent.failed',
      'agent.blocked',
      'agent.cancelled',
    ]) {
      expect(SNOOZE_BYPASS_KINDS.has(kind)).toBe(false);
      expect(QUIET_HOURS_BYPASS_KINDS.has(kind)).toBe(false);
    }
    expect(SNOOZE_BYPASS_KINDS.has('session.died')).toBe(true);
  });
});
