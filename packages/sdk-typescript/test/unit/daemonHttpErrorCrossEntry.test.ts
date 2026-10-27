/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isSessionLevelNotFound,
  isSubagentSessionNotFound,
} from '../../src/daemon/DaemonHttpError.js';

/**
 * A second copy of `DaemonHttpError`, for the one difference that matters in
 * production: object identity.
 *
 * The SDK bundles this class once per entry point (`scripts/build.js` runs an
 * independent esbuild bundle for `.` and for `./daemon`), so a client built
 * through one entry throws a class object that the other entry's copy is not.
 * `instanceof` across that line answers false for a perfectly ordinary daemon
 * 404, which is the defect these tests exist to pin. The existing
 * `isSubagentSessionNotFound.test.ts` cannot see it: it imports the class and
 * the guards from the same module, so both sides are always the same object.
 */
class DaemonHttpErrorFromTheOtherEntry extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'DaemonHttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * The body the daemon actually sends. `toolCallId` is what the guards were
 * written against and what the shipped unit test asserts; neither appears in
 * any daemon response. The route names the missing child under its own route
 * parameter, `subagentRef`
 * (`packages/cli/src/serve/routes/session.ts:5481` for the read and `:5538`
 * for the cancel), and `toolCallId` does not appear anywhere in that file.
 */
const realMissingAgentBody = {
  error: 'Subagent session not found',
  code: 'session_not_found',
  sessionId: 'session-1',
  subagentRef: 'call-1',
};

/** The body for a missing PARENT: no key names a child at all. */
const realSessionLevelBody = {
  error: `No session with id "session-1"`,
  code: 'session_not_found',
  sessionId: 'session-1',
};

describe('the guards must not depend on which bundle threw', () => {
  it('reads a child 404 thrown through the other entry', () => {
    const error = new DaemonHttpErrorFromTheOtherEntry(
      404,
      realMissingAgentBody,
      'not found',
    );
    expect(isSubagentSessionNotFound(error, 'call-1')).toBe(true);
  });

  it('reads a parent 404 thrown through the other entry', () => {
    const error = new DaemonHttpErrorFromTheOtherEntry(
      404,
      realSessionLevelBody,
      'not found',
    );
    expect(isSessionLevelNotFound(error)).toBe(true);
  });

  it('still rejects a non-404 from the other entry', () => {
    const error = new DaemonHttpErrorFromTheOtherEntry(
      500,
      realMissingAgentBody,
      'server error',
    );
    expect(isSubagentSessionNotFound(error, 'call-1')).toBe(false);
    expect(isSessionLevelNotFound(error)).toBe(false);
  });

  it('rejects an error that carries the name but no numeric status', () => {
    // `status` is required alongside the name so an unrelated Error that
    // happens to be called DaemonHttpError cannot be read as a daemon answer.
    const impostor = Object.assign(new Error('not found'), {
      name: 'DaemonHttpError',
      body: realMissingAgentBody,
    });
    expect(isSubagentSessionNotFound(impostor, 'call-1')).toBe(false);
    expect(isSessionLevelNotFound(impostor)).toBe(false);
  });

  it('rejects a plain Error that carries neither name nor status', () => {
    expect(isSubagentSessionNotFound(new Error('not found'), 'call-1')).toBe(
      false,
    );
    expect(isSessionLevelNotFound(new Error('not found'))).toBe(false);
  });
});

describe('the guards must read the key the daemon actually writes', () => {
  it('matches a child 404 that names the child under subagentRef', () => {
    const error = new DaemonHttpErrorFromTheOtherEntry(
      404,
      realMissingAgentBody,
      'not found',
    );
    expect(isSubagentSessionNotFound(error, 'call-1')).toBe(true);
  });

  it('does not treat a named child as a session-level 404', () => {
    // The whole point of the split: a gone child must not read as "the parent
    // is unreachable", which is the reversible answer.
    const error = new DaemonHttpErrorFromTheOtherEntry(
      404,
      realMissingAgentBody,
      'not found',
    );
    expect(isSessionLevelNotFound(error)).toBe(false);
  });

  it('does not let one child absence answer for another', () => {
    const error = new DaemonHttpErrorFromTheOtherEntry(
      404,
      realMissingAgentBody,
      'not found',
    );
    expect(isSubagentSessionNotFound(error, 'call-other')).toBe(false);
  });

  it('still matches the toolCallId spelling these guards were written against', () => {
    const error = new DaemonHttpErrorFromTheOtherEntry(
      404,
      {
        code: 'session_not_found',
        sessionId: 'session-1',
        toolCallId: 'call-1',
      },
      'not found',
    );
    expect(isSubagentSessionNotFound(error, 'call-1')).toBe(true);
    expect(isSessionLevelNotFound(error)).toBe(false);
  });

  it('treats an explicit null child reference as absent', () => {
    const error = new DaemonHttpErrorFromTheOtherEntry(
      404,
      {
        code: 'session_not_found',
        sessionId: 'session-1',
        toolCallId: null,
        subagentRef: null,
      },
      'not found',
    );
    expect(isSessionLevelNotFound(error)).toBe(true);
  });
});
