/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Top-level command resolution for the fall-through of cli.ts's dispatch:
 * what `qwen-rc` does when no subcommand branch claimed argv. Kept pure so the
 * exit-code contract (0 for an asked-for help or version, 2 for a usage error)
 * is unit-tested without evaluating cli.ts.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const USAGE_TEXT = [
  'usage: qwen-rc <command> [options]',
  '',
  'commands:',
  '  serve                       run the gateway',
  '  up | down | status          bring the local launcher stack up, down, or report on it',
  '  policy lint <file>          check a policy file',
  '  policy explain <tool>       dry-run the layered policy for a tool call',
  '  routing rules | test        inspect or test routing rules',
  '  search <query>              search session transcripts',
  '  terminals                   list and manage terminals',
  '  attach                      attach to a session',
  '  reindex                     rebuild the transcript index',
  '  usage [reprice | prune]     query, reprice or prune cost-tracking data',
  '  daemons <sub>               manage the registered daemons (discover, add, remove, ...)',
  '  fork                        fork a session',
  '  sessions                    list sessions',
  '  audit verify [--dir <path>] verify the audit log hash chains',
  '',
  'options:',
  '  -h, --help, help            show this message',
  '  -v, --version               print the version',
].join('\n');

export type TopLevelAction =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'usage-error'; message: string };

/**
 * Resolve argv[2] when no subcommand branch matched. `help`, `--help`, `-h` and
 * `--version` / `-v` are answers (exit 0); a bare invocation or an unknown word
 * is a usage error (exit 2).
 */
const NEEDS_SUBCOMMAND: Record<string, string> = {
  policy: 'lint | explain',
  routing: 'rules | test',
  audit: 'verify',
};

export function resolveTopLevel(
  sub: string | undefined,
  next?: string,
): TopLevelAction {
  switch (sub) {
    case 'help':
    case '--help':
    case '-h':
      return { kind: 'help' };
    case '--version':
    case '-v':
      return { kind: 'version' };
    case undefined:
      return { kind: 'usage-error', message: 'missing command' };
    default:
      if (Object.hasOwn(NEEDS_SUBCOMMAND, sub)) {
        return {
          kind: 'usage-error',
          message:
            next === undefined
              ? `'${sub}' needs a subcommand (${NEEDS_SUBCOMMAND[sub]})`
              : `unknown ${sub} subcommand '${next}' (expected ${NEEDS_SUBCOMMAND[sub]})`,
        };
      }
      return { kind: 'usage-error', message: `unknown command '${sub}'` };
  }
}

/**
 * Whether this module's entry file is the running program, as opposed to being
 * imported (index.ts re-exports runServe from cli.ts, and tests import it).
 * The fall-through must only fire for a real `qwen-rc` invocation, never for a
 * host process that merely imports the package.
 */
export function isRunAsCli(
  argv1: string | undefined,
  moduleUrl: string,
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
