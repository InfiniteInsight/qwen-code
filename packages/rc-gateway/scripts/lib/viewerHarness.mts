/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared Playwright harness for the manual viewer scripts (NOT a CI test).
 * Boots the real gateway (`createGatewayApp`) against the stub daemon, issues
 * an owner token and pre-seeds it into `localStorage['qwen-rc-token']`, and
 * launches headless Chromium (`CHROMIUM_PATH` overrides the browser binary).
 *
 * The page is returned un-navigated: callers `page.goto(url + '/ui/')` (or a
 * route of their own) after attaching whatever listeners/CDP sessions they
 * need. `url` is the gateway origin, e.g. `http://127.0.0.1:41234`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon } from '../../src/testing/stubDaemon.js';
import { TokenStore } from '../../src/tokenStore.js';
import { PairingService } from '../../src/pairing.js';
import { createGatewayApp } from '../../src/server.js';
import { UiPrefsStore } from '../../src/uiPrefsStore.js';

/**
 * `_meta` is the envelope the real EventBus stamps when it publishes
 * (`serverTimestamp`, `usage`). The stub echoes it verbatim, so a page scenario
 * can drive a send time without inventing a clock inside the ACP payload.
 */
export type Frame = {
  id: number;
  type: string;
  data: unknown;
  _meta?: Record<string, unknown>;
};

export interface BootViewerOptions {
  /** Frames the stub daemon replays on /session/:id/events. */
  frames?: Frame[];
  /** Keep the stub's SSE response open this long after the frames (ms). */
  holdOpenMs?: number;
  /** Status the stub answers POST /session/:id/prompt with (default 200). */
  promptStatus?: number;
  /**
   * Status the stub daemon answers a permission vote with. The gateway turns a
   * throw from the SDK into 502, so any non-2xx here reaches the page as a
   * failed vote, which is how a scenario drives the retry path.
   */
  permissionStatus?: number;
  /**
   * Body the stub serves on GET /session/:id/status. A card scenario sets this
   * to keep its request listed as pending, because the default body reports no
   * pending interactions and the page's 5s sweep would retire the card on its
   * own, leaving the vote path untested.
   */
  sessionStatus?: unknown;
  /** ms the stub holds a prompt open before answering (models a long turn). */
  promptDelayMs?: number;
  /**
   * Body the stub serves on GET /session/:id/transcript. Left unset it serves
   * its own default page; a scenario that asserts a specific number of paged
   * rows sets this, because otherwise it would be measuring whatever the stub
   * happened to invent rather than what it asked for.
   */
  transcriptPage?: unknown;
  /** Status the stub answers GET /session/:id/transcript with (default 200). */
  transcriptStatusCode?: number;
  /**
   * Body the stub serves on GET /session/:id/turn-index. Left unset it serves
   * its own two-turn default, so a scenario that asserts which turns a reader
   * is shown has to name them, or it is checking the stub's invention rather
   * than its own. The `snapshot` in this body is the value a consumer has to
   * echo back on the anchored transcript read, so a scenario that drives a jump
   * asserts the pair it asked for rather than a guess.
   */
  turnIndexPage?: unknown;
  /**
   * Status the stub answers GET /session/:id/turn-index with (default 200). Set
   * it to drive the refusal note, because there is no other way to make a daemon
   * refuse an index read, and the page prints the reason code it was given.
   */
  turnIndexStatusCode?: number;
  /**
   * Daemon feature tags the stub advertises on GET /capabilities (default:
   * none). The page hides whole panels behind these tags, so a scenario that
   * drives one of them has to advertise it or it is asserting against markup
   * that never becomes visible.
   */
  capabilitiesFeatures?: string[];
  /**
   * Status the stub answers GET /session/:id/export with (default 200). A
   * scenario that drives the refusal note sets this, because the page reads
   * the reason off the response body and there is no other way to make the
   * daemon refuse.
   */
  exportStatusCode?: number;
  /**
   * Status the stub answers POST /session/:id/attachments with (default 201).
   * A scenario that drives the attach failure note sets this, because the page
   * reads the reason off the response body and there is no other way to make
   * the daemon refuse a file.
   */
  attachmentUploadStatus?: number;
  /**
   * Body the stub answers a refused upload with. Left unset the stub says
   * `stub error`, which is not a code the real daemon ever sends, so a
   * scenario asserting the page names a reason has to supply one.
   */
  attachmentUploadErrorBody?: unknown;
  /**
   * Body the stub answers GET /session/:id/attachments with. A scenario that
   * drives the stored list sets this, because the list a reader sees has to be
   * what the daemon holds, and the stub's own default is one file the test
   * never chose.
   */
  attachmentListResult?: unknown;
  /**
   * Status the stub answers the attachment list with (default 200). Set it to
   * drive the refusal note. Leave the body unset to see the gateway's own
   * mapping of that status, which is what a reader actually gets, rather than
   * a body this file composed.
   */
  attachmentListStatus?: number;
  /**
   * Status the stub answers GET /session/:id/stats with (default 200). Set it
   * to drive the failure row, because there is no other way to make a daemon
   * refuse a stats read, and the page prints the reason code it was given.
   */
  statsStatusCode?: number;
  /**
   * Body the stub answers GET /session/:id/stats with. Left unset the stub
   * serves its own default roll-up, which is fine for a scenario that only
   * needs a panel to fill, but a scenario that asserts a printed number has to
   * supply the payload it expects to see, or it is checking the stub's
   * invention rather than its own.
   */
  statsResult?: unknown;
  /**
   * Body the stub answers GET /session/:id/resources with. Left unset the stub
   * serves its own default skills-and-servers payload, so a scenario that
   * asserts a drawn row, or that an unknown level or status still reaches the
   * page, has to supply its own payload or it is checking the two names the
   * stub invented.
   */
  resourcesResult?: unknown;
  /**
   * Status the stub answers GET /session/:id/resources with (default 200). Set
   * it to drive the failure row, since there is no other way to make a daemon
   * refuse a resources read, and the page prints the reason code it was given.
   */
  resourcesStatusCode?: number;
  /**
   * Body the stub answers GET /workspace/permissions with. Left unset the stub
   * serves its own settings object, which now carries the shape the daemon
   * really sends ({ path, rules } per scope, one { allow, ask, deny } merged
   * set). A scenario that asserts a drawn rule chip has to supply its own
   * payload, or it is checking the rules this file invented.
   */
  workspacePermissionsResult?: unknown;
  /**
   * Status the stub answers GET /workspace/permissions with (default 200). Set
   * it to drive the refusal the page reports, since there is no other way to
   * make a daemon refuse a rules read.
   */
  workspacePermissionsStatus?: number;
  /**
   * Body the stub answers GET /workspace/env and /workspace/preflight with.
   * The two diagnostics reads share one envelope, so a scenario that asserts a
   * drawn cell has to name the cell itself: left unset, the stub serves its own
   * default fixture and the assertion would be checking this file's invention.
   */
  workspaceEnvResult?: unknown;
  /** Status the stub answers GET /workspace/env with (default 200). */
  workspaceEnvStatus?: number;
  /** Body the stub answers GET /workspace/preflight with. */
  workspacePreflightResult?: unknown;
  /** Status the stub answers GET /workspace/preflight with (default 200). */
  workspacePreflightStatus?: number;
  /** Body the stub answers GET /workspace/skills with. */
  workspaceSkillsResult?: unknown;
  /** Status the stub answers GET /workspace/skills with. */
  workspaceSkillsStatus?: number;
  /** Body the stub answers GET /workspace/providers with. */
  workspaceProvidersResult?: unknown;
  /** Status the stub answers GET /workspace/providers with. */
  workspaceProvidersStatus?: number;
  /** Body the stub answers GET /workspace/hooks with. */
  workspaceHooksResult?: unknown;
  /** Status the stub answers GET /workspace/hooks with. */
  workspaceHooksStatus?: number;
  /** Body the stub answers GET /workspace/memory with. */
  workspaceMemoryResult?: unknown;
  /** Status the stub answers GET /workspace/memory with. */
  workspaceMemoryStatus?: number;
  /** Body the stub answers GET /workspace/agents with. */
  workspaceAgentsResult?: unknown;
  /** Status the stub answers GET /workspace/agents with. */
  workspaceAgentsStatus?: number;
  /**
   * Body the stub answers GET /session/:id/artifacts with. Left unset the stub
   * serves its own default envelope, so a scenario that asserts a drawn row is
   * checking the stub's invention rather than its own unless it sets this.
   */
  artifactListResult?: unknown;
  /**
   * Status the stub answers GET /session/:id/artifacts with (default 200). Set
   * it to drive the failure row, since there is no other way to make a daemon
   * refuse a list, and the page prints the reason code it was given.
   */
  artifactListStatus?: number;
  /**
   * Status the stub answers the artifact content read with (default 200). Set
   * it to 404 to drive the refusal the page reports when a snapshot is gone.
   */
  artifactContentStatus?: number;
}

export interface Viewer {
  page: Page;
  /** Gateway origin, without a trailing slash. */
  url: string;
  /** A session id the page can `startWatch()` (the stub serves any id). */
  sessionId: string;
  close(): Promise<void>;
}

export const SESSION_ID = '11111111-2222-3333-4444-555555555555';

export async function bootViewer(
  opts: BootViewerOptions = {},
): Promise<Viewer> {
  const stub = await startStubDaemon({
    frames: opts.frames,
    holdOpenMs: opts.holdOpenMs,
    promptStatus: opts.promptStatus,
    permissionStatus: opts.permissionStatus,
    sessionStatus: opts.sessionStatus,
    promptDelayMs: opts.promptDelayMs,
    transcriptPage: opts.transcriptPage,
    transcriptStatusCode: opts.transcriptStatusCode,
    turnIndexPage: opts.turnIndexPage,
    turnIndexStatusCode: opts.turnIndexStatusCode,
    capabilitiesFeatures: opts.capabilitiesFeatures,
    exportStatusCode: opts.exportStatusCode,
    attachmentUploadStatus: opts.attachmentUploadStatus,
    attachmentUploadErrorBody: opts.attachmentUploadErrorBody,
    attachmentListResult: opts.attachmentListResult,
    attachmentListStatus: opts.attachmentListStatus,
    statsStatusCode: opts.statsStatusCode,
    statsResult: opts.statsResult,
    resourcesResult: opts.resourcesResult,
    resourcesStatusCode: opts.resourcesStatusCode,
    workspacePermissionsResult: opts.workspacePermissionsResult,
    workspacePermissionsStatus: opts.workspacePermissionsStatus,
    workspaceEnvResult: opts.workspaceEnvResult,
    workspaceEnvStatus: opts.workspaceEnvStatus,
    workspacePreflightResult: opts.workspacePreflightResult,
    workspacePreflightStatus: opts.workspacePreflightStatus,
    workspaceSkillsResult: opts.workspaceSkillsResult,
    workspaceSkillsStatus: opts.workspaceSkillsStatus,
    workspaceProvidersResult: opts.workspaceProvidersResult,
    workspaceProvidersStatus: opts.workspaceProvidersStatus,
    workspaceHooksResult: opts.workspaceHooksResult,
    workspaceHooksStatus: opts.workspaceHooksStatus,
    workspaceMemoryResult: opts.workspaceMemoryResult,
    workspaceMemoryStatus: opts.workspaceMemoryStatus,
    workspaceAgentsResult: opts.workspaceAgentsResult,
    workspaceAgentsStatus: opts.workspaceAgentsStatus,
    artifactListResult: opts.artifactListResult,
    artifactListStatus: opts.artifactListStatus,
    artifactContentStatus: opts.artifactContentStatus,
  });
  const dir = mkdtempSync(join(tmpdir(), 'rc-viewer-'));
  const store = await TokenStore.open(join(dir, 'tokens.json'));
  const { token } = await store.issue(['owner'], 'viewer-harness');
  const { app } = createGatewayApp({
    daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
    store,
    pairing: new PairingService(),
    auditPath: join(dir, 'audit.log'),
    // The page reads /rc/ui-prefs at boot. Left unmounted, every scenario
    // would silently run the fallback path and the saved-zone feature could
    // never be observed, so the harness carries it the way cli.ts does.
    uiPrefs: await UiPrefsStore.open(join(dir, 'ui-prefs.json')),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const browser = await chromium.launch({
    args: ['--enable-precise-memory-info'],
    executablePath: process.env['CHROMIUM_PATH'] || undefined,
  });
  // An explicit context rather than browser.newPage(), which would create an
  // implicit one that refuses a second page. A scenario that needs two windows
  // on the same origin takes them from page.context(): they then share
  // localStorage and do not share sessionStorage, which is the seam #50 turns
  // on. Separate contexts would not model it, since each gets its own storage.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('qwen-rc-token', t);
  }, token);

  let closed = false;
  return {
    page,
    url,
    sessionId: SESSION_ID,
    async close() {
      if (closed) return;
      closed = true;
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
