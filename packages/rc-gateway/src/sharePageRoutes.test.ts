/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The gateway mounts the session stream and the permission vote under bare
// /session/:id/... (src/server.ts). share.html must call those same paths.
const here = dirname(fileURLToPath(import.meta.url));
const sharePage = readFileSync(
  join(here, '..', 'public', 'share.html'),
  'utf8',
);

describe('public/share.html route prefixes', () => {
  it('does not use the stale /rc/session/ prefix', () => {
    expect(sharePage).not.toContain('/rc/session/');
  });

  it('calls the bare /session/:id/events stream route', () => {
    expect(sharePage).toContain(
      "authed('/session/' + encodeURIComponent(sessionId) + '/events')",
    );
  });

  it('calls the bare /session/:id/permission/:rid vote route', () => {
    expect(sharePage).toContain("'/session/' +");
    expect(sharePage).toContain("'/permission/' +");
  });
});
