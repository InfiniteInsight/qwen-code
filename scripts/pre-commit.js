/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import lintStaged from 'lint-staged';

import { main as checkEmDash } from './check-em-dash.mjs';

try {
  // Get repository root
  const root = execSync('git rev-parse --show-toplevel').toString().trim();

  // lint-staged formats whole staged files, so it cannot see that a new line
  // added a typographic dash. Run that rule first, on the added lines only.
  if (checkEmDash() !== 0) {
    process.exit(1);
  }

  // Run lint-staged with API directly
  const passed = await lintStaged({ cwd: root });

  // Exit with appropriate code
  process.exit(passed ? 0 : 1);
} catch {
  // Exit with error code
  process.exit(1);
}
