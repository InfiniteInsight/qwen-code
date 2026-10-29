/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadOrCreateLocalToken } from '../localCredential.js';

/**
 * Load (or mint exactly once) the dedicated hook-ingest token (design:
 * "minted once on first startup and persisted — regenerating per start
 * would invalidate existing hook config — written 0600"). The docs snippet
 * that configures core's HTTP hook runner interpolates this value; it is
 * NOT a TokenStore token and grants nothing beyond POST /rc/hooks/ingest.
 * The file handling is the shared host-local credential helper.
 */
export async function loadOrCreateHookIngestToken(
  filePath: string,
): Promise<string> {
  return loadOrCreateLocalToken(filePath);
}
