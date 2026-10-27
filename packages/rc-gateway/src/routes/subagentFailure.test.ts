/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
// Built through the package ROOT on purpose. `DaemonClient` is constructed the
// same way (`daemonPool.ts:43`), so an error made here is the error a real
// request actually throws. The sibling route tests import this class from the
// `/daemon` subpath, which is a different class object, and that is exactly why
// they stayed green while production answered every gone child as a gateway
// outage. Do not "tidy" this import into matching theirs.
import { DaemonHttpError } from '@qwen-code/sdk';
import { DaemonHttpError as SubpathDaemonHttpError } from '@qwen-code/sdk/daemon';
import { classifySubagentFailure } from './subagentFailure.js';

const SESS = '11111111111111111111111111111111';
const REF = 'toolu_01AbCdEf';

/** The child-gone 404 exactly as `session.ts:5484-5489` sends it. */
function childGone(ref: string = REF) {
  return new DaemonHttpError(
    404,
    { code: 'session_not_found', sessionId: SESS, subagentRef: ref },
    'Subagent session not found',
  );
}

/** The parent-level 404: same code, nothing naming a child. */
function parentGone() {
  return new DaemonHttpError(
    404,
    { code: 'session_not_found', sessionId: SESS },
    'No such session',
  );
}

describe('classifySubagentFailure (#139)', () => {
  it('states the hazard this file is written around, so the fixture cannot drift', () => {
    // If the SDK ever dedupes its class copies this fails, and the structural
    // read can then be simplified in the open rather than by accident.
    const err = childGone();
    expect(err).not.toBeInstanceOf(SubpathDaemonHttpError);
    expect(err.name).toBe('DaemonHttpError');
    expect(err.status).toBe(404);
  });

  it('calls a gone child gone, rather than blaming the gateway', () => {
    expect(classifySubagentFailure(childGone(), REF)).toBe(
      'subagent_not_found',
    );
  });

  it('calls a parent 404 reversible, not permanent', () => {
    expect(classifySubagentFailure(parentGone(), REF)).toBe(
      'session_unreachable',
    );
  });

  it('will not let one agent absence settle another row', () => {
    const other = classifySubagentFailure(childGone('toolu_09ZzYyXx'), REF);
    expect(other).toBe('daemon_unavailable');
  });

  it('keeps an unrelated failure the gateway problem it is', () => {
    expect(classifySubagentFailure(new Error('read refused'), REF)).toBe(
      'daemon_unavailable',
    );
    expect(
      classifySubagentFailure(
        new DaemonHttpError(500, { code: 'boom' }, 'blew up'),
        REF,
      ),
    ).toBe('daemon_unavailable');
  });

  it('does not treat a 404 from a different contract as a missing child', () => {
    const notTheChild = new DaemonHttpError(
      404,
      { code: 'workspace_not_found' },
      'no such workspace',
    );
    expect(classifySubagentFailure(notTheChild, REF)).toBe(
      'daemon_unavailable',
    );
  });

  it('reads a plain object with the same fields to the same verdict', () => {
    // The point of the structural read: nothing here depends on which copy of
    // the class produced the error.
    const shaped = {
      name: 'DaemonHttpError',
      status: 404,
      body: { code: 'session_not_found', sessionId: SESS, subagentRef: REF },
    };
    expect(classifySubagentFailure(shaped, REF)).toBe('subagent_not_found');
  });

  it('refuses to classify a name-only impostor as a daemon response', () => {
    const impostor = { name: 'DaemonHttpError', message: 'not really' };
    expect(classifySubagentFailure(impostor, REF)).toBe('daemon_unavailable');
  });
});
