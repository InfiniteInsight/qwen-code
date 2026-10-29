/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir, hostname } from 'node:os';
import type { RequestHandler } from 'express';
import type { DaemonCapabilities } from '@qwen-code/sdk';
import { RC_PROTOCOL_VERSION } from '../mdns/advert.js';
import type { NativeShellsCapability } from '../nativePush/nativeShells.js';
import { WRITE, hasScope } from '../scopes.js';

/**
 * Who is asking, as far as this route's answer is concerned (#165).
 *
 *  - `full`: a token holding WRITE (owner, write, bridge). Gets today's
 *    shape, unchanged. WRITE is the line because the workspace paths this
 *    route used to hand to everyone are already a WRITE-floor fact elsewhere:
 *    `GET /rc/workspaces` sits at WRITE.
 *  - `reader`: a paired token without WRITE (read-only, approve-only). No
 *    paths and no ssh details; the workspace list keeps its ids and flags so
 *    a reader can still tell runtimes apart.
 *  - `guest`: a session-locked share token, whatever its scopes. Only what
 *    the page needs to render its one conversation.
 *
 * A client with no scopes array is a reader at best: the route fails closed.
 */
type Audience = 'full' | 'reader' | 'guest';

function audienceOf(client: {
  scopes?: unknown;
  sessionLockId?: unknown;
}): Audience {
  if (client.sessionLockId !== undefined) return 'guest';
  const scopes = Array.isArray(client.scopes)
    ? (client.scopes as string[])
    : [];
  return hasScope(scopes, WRITE) ? 'full' : 'reader';
}

/**
 * Daemon envelope keys a reader or a guest may see. An allowlist rather than
 * a list of what to strip, so a field the daemon adds tomorrow reaches owner
 * and write tokens at once (the #96 point of passing it through verbatim) but
 * reaches nobody else until someone decides it is safe to.
 */
const GUEST_DAEMON_KEYS: readonly string[] = [
  'v',
  'protocolVersions',
  'sessionLiveStatePollIntervalMs',
  'mode',
  'features',
  'limits',
  'transports',
  'available',
];
const READER_DAEMON_KEYS: readonly string[] = [
  ...GUEST_DAEMON_KEYS,
  'qwenCodeVersion',
  'modelServices',
];
/** Per-workspace keys a reader may see: never `cwd`, never `ssh`. */
const READER_WORKSPACE_KEYS: readonly string[] = [
  'id',
  'displayName',
  'primary',
  'trusted',
  'agentCollaborationEnabled',
  'workflowsEnabled',
  'removable',
  'kind',
];

function pick(
  obj: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function scopeDaemonBlock(
  block: Record<string, unknown>,
  audience: Audience,
): Record<string, unknown> {
  if (audience === 'full') return block;
  if (audience === 'guest') return pick(block, GUEST_DAEMON_KEYS);
  const out = pick(block, READER_DAEMON_KEYS);
  if (Array.isArray(block.workspaces)) {
    out.workspaces = (block.workspaces as unknown[])
      .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
      .map((w) => pick(w, READER_WORKSPACE_KEYS));
  }
  // `available` last, as readDaemonStatus does, so nothing can shadow it.
  if ('available' in out) {
    const { available, ...rest } = out;
    return { ...rest, available };
  }
  return out;
}

/**
 * How long discovery waits for the daemon's own list before answering without
 * it. The SDK's own fetch timeout is 30s, which is far too long to sit in
 * front of a page load: this route is what the viewer awaits before it shows
 * anything.
 */
const DEFAULT_DAEMON_BUDGET_MS = 2000;

async function readDaemonStatus(
  read: () => Promise<DaemonCapabilities>,
  budgetMs: number,
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const caps = await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('budget')), budgetMs);
      }),
    ]);
    // Marker last: a daemon field must not be able to shadow it.
    return { ...caps, available: true };
  } catch {
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /rc/capabilities — the gateway's capability surface. The daemon's own
 * `/capabilities` is un-editable under the fork boundary, so the gateway serves
 * its own `remoteControl` block. Always mounted (mDNS reports here even when cost
 * tracking is off); any authenticated token; no secrets. What a token sees is
 * scoped by who it is (#165, see {@link Audience}): owner and write tokens get
 * the whole answer, a reader loses host paths and ssh details, and a share
 * guest gets only the flags the page needs for its one conversation.
 *
 * Composes optional sub-blocks from deps:
 *  - `costTracking` — only when a usage store is wired (`add-cost-tracking`).
 *  - `mdns` — `{ advertising, instanceName? }` (`add-mdns-discovery`); the spec's
 *    `version` is sourced from {@link RC_PROTOCOL_VERSION}, the same constant the
 *    mDNS TXT record advertises, so the two never drift.
 *
 * `workspaceControl` is STATIC: the `/rc/workspace/*` routes are always
 * mounted, so the gateway always offers the surface. The flags exist so an
 * older UI can degrade gracefully and so a future gateway can disable a
 * sub-surface without removing the routes.
 *
 * The daemon's own list is passed through VERBATIM under `remoteControl.daemon`
 * (#96). Nothing here names a single flag: a hand-picked field list is how the
 * surface got narrow in the first place, since each capability would then have
 * to be carried across the boundary by hand twice. A flag the daemon adds
 * tomorrow therefore reaches the UI with no gateway edit. The envelope is
 * copied rather than summarized for the same reason.
 *
 * The daemon read is bounded by {@link DEFAULT_DAEMON_BUDGET_MS} and never
 * turns this response into a 5xx: the block is what mDNS reports and what an
 * older UI refuses to render without, so a daemon that is down or slow must
 * cost the daemon's list and nothing else. Absence of the list is reported as
 * `daemon: { available: false }` rather than by omitting the key, so a UI can
 * tell "the daemon supports nothing" apart from "we could not ask" — the
 * second must not hide the sections that only the gateway serves.
 */
export function createCapabilityRoute(deps: {
  costTracking?: { currencyLabel: () => string };
  mdnsStatus?: () => { advertising: boolean; instanceName?: string };
  nativeShells?: () => NativeShellsCapability;
  /** True when the loopback `POST /rc/host/attach` routes are mounted. */
  hostAttach?: boolean;
  /**
   * The upload size limit the attachment route enforces (#196), so the page
   * can shrink an image to fit before sending it. Omitted when not wired; the
   * page then assumes the old 8 MiB. A function is read per request, because
   * the enforced number follows the cap the daemon advertises.
   */
  maxAttachmentBytes?: number | (() => Promise<number>);
  /**
   * The resolved path of the `qwen` the daemons are spawned as (`--qwen-bin`),
   * never its version. Omitted when not wired.
   */
  daemonQwenBin?: string;
  /** #190: the host's name and home directory; os.hostname() and os.homedir()
   * when omitted (tests pin them). Reported to owner and write tokens only. */
  hostName?: string;
  homeDir?: string;
  /**
   * Whether the boot import probe of that binary passed (#191). Reported as
   * `daemonQwenBinHealthy`; `false` means its build is inconsistent. Omitted
   * when not probed or inconclusive.
   */
  daemonQwenBinHealthy?: boolean;
  /** Read of the daemon's own `/capabilities` envelope (see #96). */
  daemonStatus?: () => Promise<DaemonCapabilities>;
  /** Test seam for the daemon read's bound. */
  daemonBudgetMs?: number;
}): RequestHandler {
  return async (req, res) => {
    if (!req.rcClient) {
      res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      return;
    }
    const audience = audienceOf(req.rcClient);
    const remoteControl: Record<string, unknown> = {
      version: RC_PROTOCOL_VERSION,
      // Only what is served and mintable: SSE is the one transport, and the
      // read scope is spelled `session:read` (`read` is rejected at minting).
      supportedTransports: ['sse'],
      supportedScopes: ['owner', 'write', 'approve', 'session:read'],
      pairingEnabled: true,
      auditEnabled: true,
      walHorizonSec: 86400,
      walMaxEvents: 10000,
      workspaceControl: {
        permissions: true,
        trust: true,
        tools: true,
        mcp: true,
      },
      // #190: /rc/sessions/live-state takes `spawn=0`. The page is served
      // from public/ on disk, so a new page can meet a gateway still running
      // the old route, which ignores the switch and starts a daemon for every
      // folder it is asked about. The page reads other folders only when this
      // says the switch is honoured.
      liveStateNoSpawn: true,
      // #194: POST /rc/terminals answers 200 `{ alreadyMirrored: true }`
      // instead of queueing a second tab when one is already attached. An old
      // gateway answers 202 every time, so the page can tell the two apart.
      hostTerminalAlreadyMirrored: true,
      // #150: whether this token holds WRITE, which POST /session/:id/resume
      // requires. A watch that 412s past the WAL horizon recovers by resuming
      // the conversation, and the page asks only when this says it may.
      writeScope: hasScope(
        Array.isArray(req.rcClient.scopes) ? (req.rcClient.scopes as string[]) : [],
        WRITE,
      ),
      // #194 slice D: a terminal on this host can start a conversation the
      // phone then sees (`qwen-rc attach`). The route itself is loopback-only
      // and never reachable from the phone; the flag is here so the page can
      // tell the user the command exists. True only when the gateway mounted
      // it, which the boot wiring always does.
      hostAttach: deps.hostAttach === true,
      // #196: the largest upload `POST /session/:id/attachments` accepts.
      ...(deps.maxAttachmentBytes !== undefined
        ? {
            maxAttachmentBytes:
              typeof deps.maxAttachmentBytes === 'number'
                ? deps.maxAttachmentBytes
                : await deps.maxAttachmentBytes(),
          }
        : {}),
      // #130: the attachment-uploads routes (begin, chunks, status, complete,
      // cancel) are mounted, so a phone can resume a dropped upload. An old
      // gateway omits this and the page uses the single POST.
      resumableAttachmentUploads: true,
      // #131: GET /session/:id/turns/current is mounted, so the status line's
      // sheet can show the running turn. An old gateway omits this and the
      // sheet shows no "This turn" row.
      currentTurn: true,
      // #190: the host's name and $HOME, for the list's folder line (`on
      // lovelace`, `~/projects`). Host facts, so owner and write only, as the
      // paths below (#165).
      ...(audience === 'full'
        ? { hostName: deps.hostName ?? hostname(), homeDir: deps.homeDir ?? homedir() }
        : {}),
      // A host path: owner and write only (#165).
      ...(deps.daemonQwenBin !== undefined && audience === 'full'
        ? { daemonQwenBin: deps.daemonQwenBin }
        : {}),
      // Same audience as the path it describes (#191).
      ...(deps.daemonQwenBinHealthy !== undefined && audience === 'full'
        ? { daemonQwenBinHealthy: deps.daemonQwenBinHealthy }
        : {}),
      // #110: GET /session/:id/agents, /agent-trace and
      // /saved-workflows/:name are mounted. The page draws the agents strip,
      // the Agents sheet and the trace only when this is set AND the daemon
      // advertises `session_agents`, so an old gateway shows nothing new and
      // an old daemon is never asked.
      sessionAgents: true,
      // #123: /rc/workspace/{stat,file/write,file/edit,file/upload,file/delete}
      // are mounted. The page draws its file-write controls only when this is
      // true, the token holds write (`writeScope`), and the daemon advertises
      // the route's own tag, so an old gateway, a reader and an old daemon
      // each see none.
      workspaceFileWrites: true,
    };
    if (deps.costTracking) {
      remoteControl.costTracking = {
        enabled: true,
        currencyLabel: deps.costTracking.currencyLabel(),
        ...(audience === 'full'
          ? { rateTablePath: '~/.qwen/rc/model-rates.yaml' }
          : {}),
      };
    }
    if (deps.mdnsStatus) {
      const m = deps.mdnsStatus();
      // The instance name is usually the host's name; a guest has no use for it.
      remoteControl.mdns =
        m.advertising && audience !== 'guest'
          ? { advertising: true, instanceName: m.instanceName }
          : { advertising: m.advertising };
    }
    if (deps.nativeShells) {
      remoteControl.nativeShells = deps.nativeShells();
    }
    if (deps.daemonStatus) {
      remoteControl.daemon = scopeDaemonBlock(
        await readDaemonStatus(
          deps.daemonStatus,
          deps.daemonBudgetMs ?? DEFAULT_DAEMON_BUDGET_MS,
        ),
        audience,
      );
    }
    res.status(200).json({ remoteControl });
  };
}
