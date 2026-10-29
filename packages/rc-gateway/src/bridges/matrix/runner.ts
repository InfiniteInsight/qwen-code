/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeClient, BridgeEvent } from '../client.js';
import { BanCache } from '../banCache.js';
import type { MatrixRoomStore } from './roomStore.js';
import { runHeartbeatLoop, heartbeatIntervalMsOf } from '../heartbeat.js';
import type { CursorStore } from '../cursorStore.js';
import { SubscriptionCursors } from '../sessionCursors.js';
import { extractAgentText } from '../sessionUpdateText.js';
import { markdownToHtml } from './markdownHtml.js';
import { MatrixStreamRouter, type MatrixStreamPoster } from './streamRouter.js';
import {
  handleMessage,
  handleReaction,
  ENCRYPTED_ROOM_NOTICE,
  type MatrixDispatchDeps,
  type MatrixResponder,
  type NormalizedMatrixMessage,
  type NormalizedMatrixReaction,
  type TrackedEvent,
  type ExpiredEvent,
} from './dispatch.js';
import {
  extractSync,
  type RoomStateCtx,
  type PowerLevelsContent,
} from './normalize.js';
import {
  renderPermissionRequest,
  renderResolveEdit,
  tracksReactions,
} from './render.js';
import type { MatrixHealthState } from './health.js';
import { SubActorRateLimiter } from '../subActorRateLimiter.js';

/** The inbound Matrix surface the runner needs (subset of MatrixRestApi). */
export interface MatrixInbound extends MatrixResponder {
  joinRoom(roomId: string): Promise<{ ok: boolean; status: number }>;
}

/** A single `/sync` long-poll (injected so the runner is testable offline). */
export type SyncOnce = (
  since: string | undefined,
  signal: AbortSignal,
) => Promise<unknown>;

export interface MatrixBridgeConfig {
  client: BridgeClient;
  rest: MatrixInbound;
  rooms: MatrixRoomStore;
  /** The bot's own MXID (already whoami-validated by the caller). */
  botUserId: string;
  /** User-facing gateway URL for deeplinks (QWEN_DAEMON_URL). */
  baseUrl: string;
  /** Command prefix (default `!qwen`). */
  commandPrefix?: string;
  syncOnce: SyncOnce;
  /**
   * Optional inbound transport that SUBSUMES the fetch `/sync` loop. When the
   * Matrix E2EE crypto adapter is active it owns the single `/sync` (a second
   * sync on the same device would race it for the to-device megolm keys), so it
   * is wired here and `start()` runs it instead of {@link syncLoop}. When absent
   * (the default, E2EE off), the tested fetch loop runs unchanged.
   */
  runInbound?: (signal: AbortSignal) => Promise<void>;
  /** Injectable backoff sleep (tests). Resolves early on abort. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable clock for request expiry (tests); defaults to `Date.now`. */
  now?: () => number;
  /** Injectable idle-flush timer for the stream router (tests). */
  setTimer?: (ms: number, fn: () => void) => () => void;
  /**
   * Optional liveness state the runner updates for the `/healthz` endpoint:
   * `registeredId`/`daemonReachable` on a successful register, `homeserverReachable`
   * on sync success/failure. On the E2EE adapter path the SDK owns `/sync`, so
   * `homeserverReachable` is set by the caller at adapter start (not live here).
   */
  health?: MatrixHealthState;
  log?: (msg: string) => void;
  /**
   * Durable cursor store for SSE resume positions. When provided, the bridge
   * persists `lastEventId` per session so cursors survive restarts.
   */
  cursors?: CursorStore;
  /**
   * The bridge's own token id (used as the cursor-store partition key). Required
   * when `cursors` is set.
   */
  tokenId?: string;
}

/** SSE reconnect backoff per the spec: initial 1s, max 30s, jitter ±20%. */
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Cap on room-invite auto-joins the bot will accept within the rolling window
 * (reuses {@link SubActorRateLimiter}'s default 60 s window). Anyone can invite
 * the bot to arbitrary rooms with no allowlist gate, so an unbounded auto-join
 * is a DoS/probing surface (the bot joining — and thus syncing state for —
 * unboundedly many rooms). Binding a session still requires an operator-minted
 * token posted IN the room, so this bounds probing/DoS, not session
 * compromise. Declining an invite is always safe (fail-safe): a legitimate
 * operator can just re-invite once the window rolls over.
 *
 * ACCEPTED TRADEOFF: the bucket is GLOBAL (one bot-wide counter, see
 * {@link MATRIX_INVITE_AUTOJOIN_KEY}), not per-inviter — `invite_state` does
 * not expose a trustworthy inviter identity to key on. A sustained attacker
 * who spends the full cap every window can therefore starve a legitimate
 * operator's invite for as long as the flood continues (re-invite-on-cooldown
 * only helps once the flood stops). 20/60s is chosen to comfortably clear any
 * plausible legitimate invite burst (operators bind sessions one room at a
 * time) while still being a real ceiling against a flood; it is not a
 * fairness mechanism between a flooder and a legitimate inviter racing the
 * same window.
 */
export const MATRIX_INVITE_AUTOJOIN_CAP = 20;
/**
 * Single global bucket key for the invite auto-join limiter: `invite_state`
 * exposes the bot's own membership event, not a reliable per-inviter identity,
 * so the bound is bot-wide (total auto-joins per window), not per-sender. The
 * E2EE adapter applies the same cap with its own limiter (#168).
 */
export const MATRIX_INVITE_AUTOJOIN_KEY = '__matrix_invite_autojoin__';

/** Where a rendered permission_request landed (for the resolve edit). */
interface SentRequest {
  roomId: string;
  eventId: string;
  body: string;
}

/**
 * The Matrix bridge runner (`add-matrix-bridge`): a `/sync` long-poll loop feeds
 * dispatch (messages → prompts/commands, reactions → votes, invites → auto-join,
 * encrypted rooms → a one-time refusal notice), while an outbound SSE echo loop
 * per bound session renders permission_request frames into room messages and
 * edits them (via `m.replace`) on resolve. It holds NO gateway internals — every
 * daemon interaction goes through the injected {@link BridgeClient} over the
 * loopback contract, so the bridge is sidecar-extractable by config.
 *
 * VERIFICATION CEILING: the outbound (deliverEvent), the sync EXTRACTION, and the
 * dispatch are unit-tested; the live `/sync` long-poll against a homeserver is not
 * CI-exercised. E2EE rooms are detect-and-refused, not decrypted (no crypto).
 */
/** This bridge's stable id (registration + invite-redeem route path). */
const MATRIX_BRIDGE_ID = 'matrix';

/** How long an unresolved permission request stays tracked when it names no timeout. */
const DEFAULT_REQUEST_TTL_MS = 60 * 60 * 1000;
/** How many expired requests are remembered to answer a late reaction. */
const EXPIRED_KEEP = 500;

export class MatrixBridge {
  private readonly cfg: MatrixBridgeConfig;
  private readonly commandPrefix: string;
  /** Expiring, bounded mirror of gateway bans (#168). */
  private readonly bans = new BanCache();
  private readonly encryptedRooms = new Set<string>();
  private readonly subscribed = new Set<string>();
  /** Resume cursors and per-session stream handles (dropped on unbind, #204). */
  private readonly cursors: SubscriptionCursors;
  /** eventId → tracked permission_request (reaction → vote lookup). */
  private readonly tracked = new Map<string, TrackedEvent>();
  /** eventId → a request dropped unresolved (newest {@link EXPIRED_KEEP}). */
  private readonly expired = new Map<string, ExpiredEvent>();
  /** requestId → the sent messages that rendered it (for the resolve edit). */
  private readonly sent = new Map<string, SentRequest[]>();
  /** requestIds for which the deeplink-guidance reply has already been sent. */
  private readonly deeplinkGuidanceSent = new Set<string>();
  /** Streams agent prose into rooms (buffer + m.thread on long streams). */
  private readonly stream: MatrixStreamRouter;
  /** Bounds room-invite auto-joins per rolling window (DoS/probing guard). */
  private readonly inviteLimiter = new SubActorRateLimiter();
  private readonly ctx: RoomStateCtx;
  /**
   * roomId → tail of that room's in-flight message dispatch (#159). A prompt
   * POST answers only when the whole turn ends, so messages run OFF the sync
   * loop (otherwise the reaction that approves a tool call is never read).
   * Chaining per room keeps one room's messages in order: a second message
   * queues behind the running turn. Entries delete themselves when drained.
   */
  private readonly roomChains = new Map<string, Promise<void>>();
  private readonly log: (msg: string) => void;
  /** The run signal, stored so decrypted-path dispatch can reconcile subscriptions. */
  private signal?: AbortSignal;

  constructor(cfg: MatrixBridgeConfig) {
    this.cfg = cfg;
    this.cursors = new SubscriptionCursors(cfg.cursors, cfg.tokenId);
    this.commandPrefix = cfg.commandPrefix ?? '!qwen';
    this.log = cfg.log ?? (() => {});
    this.ctx = {
      botUserId: cfg.botUserId,
      powerLevels: new Map<string, PowerLevelsContent>(),
    };
    const poster: MatrixStreamPoster = {
      sendStream: async (roomId, opts) => {
        const content: Record<string, unknown> = {
          msgtype: 'm.text',
          body: opts.text,
          format: 'org.matrix.custom.html',
          formatted_body: markdownToHtml(opts.text),
        };
        if (opts.threadRootEventId) {
          content['m.relates_to'] = {
            rel_type: 'm.thread',
            event_id: opts.threadRootEventId,
          };
        }
        const r = await this.send(roomId, content);
        return r.ok && r.eventId ? r.eventId : null;
      },
    };
    this.stream = new MatrixStreamRouter({
      poster,
      roomsFor: (sessionId) => this.cfg.rooms.roomsFor(sessionId),
      ...(cfg.setTimer ? { setTimer: cfg.setTimer } : {}),
    });
  }

  private dispatchDeps(): MatrixDispatchDeps {
    this.expireTracked();
    return {
      bridge: this.cfg.client,
      rest: { sendMessage: (roomId, content) => this.send(roomId, content) },
      rooms: this.cfg.rooms,
      bridgeId: MATRIX_BRIDGE_ID,
      bans: this.bans,
      encryptedRooms: this.encryptedRooms,
      tracked: this.tracked,
      expired: this.expired,
      deeplinkGuidanceSent: this.deeplinkGuidanceSent,
      commandPrefix: this.commandPrefix,
      onTurnBoundary: (sessionId) => this.stream.bumpTurn(sessionId),
      log: this.log,
    };
  }

  /**
   * Route a crypto-adapter-decrypted message through the SAME dispatch as the
   * plain `/sync` path (add-matrix-bridge E2EE). This is the routing seam the
   * crypto adapter feeds: normalize `{roomId, sender, body}` (computing `isBot`
   * from the bot's MXID) and hand it to the shared {@link handleMessage}, so a
   * decrypted prompt reaches a bound session exactly like a cleartext one.
   *
   * `powerLevel` defaults to 0 — sufficient for plain prompts (un-gated); command
   * power-gating (`!qwen attach`) needs the room's `m.room.power_levels`, which the
   * adapter resolves and passes. `startBridge` wires a STARTED adapter's `onMessage`
   * to this method and lets the SDK client SUBSUME the fetch `/sync` (one sync owner
   * — see startBridge); this seam is also unit-tested directly.
   */
  async dispatchDecryptedMessage(
    m: { roomId: string; sender: string; body: string },
    powerLevel = 0,
  ): Promise<void> {
    // Resolves when this message's dispatch (the whole turn, for a prompt) is
    // done; the crypto adapter's caller must not await it (see startBridge),
    // or a turn waiting on an approval blocks the sync that carries the vote.
    await this.dispatchMessage({
      roomId: m.roomId,
      sender: m.sender,
      isBot: m.sender === this.cfg.botUserId,
      body: m.body,
      powerLevel,
    });
  }

  /**
   * Queue one message behind its room's earlier ones and run it (#159). Never
   * rejects (dispatchSafely logs). A `!qwen attach` in the message may have
   * bound a new session. The crypto path has no per-batch reconcile (the fetch
   * syncLoop is subsumed by the SDK client), so reconcile once it finishes, or
   * the freshly bound session never gets its outbound SSE echo loop.
   * Idempotent (subscribed set).
   */
  private dispatchMessage(msg: NormalizedMatrixMessage): Promise<void> {
    const prev = this.roomChains.get(msg.roomId) ?? Promise.resolve();
    const next = prev
      .then(() =>
        this.dispatchSafely('message', () =>
          handleMessage(msg, this.dispatchDeps()),
        ),
      )
      .then(() => {
        if (this.signal) this.reconcileSubscriptions(this.signal);
      });
    this.roomChains.set(msg.roomId, next);
    void next.then(() => {
      if (this.roomChains.get(msg.roomId) === next)
        this.roomChains.delete(msg.roomId);
    });
    return next;
  }

  /**
   * Route a crypto-adapter-decrypted REACTION through the same vote path as the
   * plain `/sync` reactions (add-matrix-bridge E2EE). The adapter normalizes an
   * `m.reaction` timeline event into {@link NormalizedMatrixReaction}; this hands
   * it to the shared {@link handleReaction}, so a 👍/👎 on a tracked
   * permission_request casts a vote exactly like a cleartext reaction.
   */
  async dispatchReaction(reaction: NormalizedMatrixReaction): Promise<void> {
    await handleReaction(reaction, this.dispatchDeps());
  }

  /**
   * Every message the bot sends goes out here, marked as mentioning nobody
   * (`m.mentions: {}`, Matrix intentional mentions, #168). Without it, clients
   * fall back to matching the body, so model text or tool args containing a
   * display name, an MXID or `@room` pinged people. An edit carries it in
   * `m.new_content` too.
   */
  private send(
    roomId: string,
    content: unknown,
  ): ReturnType<MatrixInbound['sendMessage']> {
    return this.cfg.rest.sendMessage(roomId, withoutMentions(content));
  }

  /** Register (or re-register) this bridge's capabilities with the gateway. */
  private registerSelf(): Promise<import('../client.js').WriteResult> {
    return this.cfg.client.register({
      id: MATRIX_BRIDGE_ID,
      displayName: 'Matrix',
      supportsActions: false, // reactions, not buttons
      supportsMarkdown: 'full', // streamed prose sent as formatted_body (HTML)
      supportsThreads: true, // m.thread relation on long streams
      supportsEdits: true, // m.replace edit on resolve
      maxMessageBytes: 65536,
    });
  }

  /** Register, heartbeat, subscribe to bound sessions, then run the sync loop. */
  async start(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    // Load durable cursors so SSE subscriptions resume from where they left off.
    this.cursors.load(this.cfg.rooms.boundSessions());
    const reg = await this.registerSelf();
    if (reg.ok && this.cfg.health) {
      this.cfg.health.registeredId = MATRIX_BRIDGE_ID;
      this.cfg.health.daemonReachable = true;
    }
    this.log(
      reg.ok
        ? 'matrix bridge: registered with the gateway'
        : `matrix bridge: registration returned ${reg.status} (continuing)`,
    );
    // The heartbeat loop uses its OWN (abort-aware) timer, not cfg.sleep — keeping
    // it independent of the /sync reconnect-backoff sleep.
    void runHeartbeatLoop({
      heartbeat: (id) => this.cfg.client.heartbeat(id),
      reRegister: () => this.registerSelf(),
      bridgeId: MATRIX_BRIDGE_ID,
      intervalMs: heartbeatIntervalMsOf(reg.body),
      signal,
      log: this.log,
    });
    this.reconcileSubscriptions(signal);
    // E2EE: the crypto adapter owns /sync (subsumes the fetch loop). Otherwise
    // the tested fetch sync loop runs unchanged.
    await (this.cfg.runInbound ?? ((s) => this.syncLoop(s)))(signal);
  }

  private async syncLoop(signal: AbortSignal): Promise<void> {
    let since: string | undefined;
    let backoff = RECONNECT_INITIAL_MS;
    while (!signal.aborted) {
      let sync: unknown;
      try {
        sync = await this.cfg.syncOnce(since, signal);
      } catch {
        if (this.cfg.health) this.cfg.health.homeserverReachable = false;
        if (signal.aborted) break;
        await this.backoff(signal, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
        continue;
      }
      const initial = since === undefined; // first sync: load state, skip history
      const ex = extractSync(sync, this.ctx);
      // A `/sync` that doesn't advance (no next_batch) is a failure — `syncOnce`
      // resolves (not rejects) on 401/429/network via the REST client, so without
      // this guard the loop would busy-spin and hammer the homeserver on exactly
      // the normal operational failures. Back off; a healthy sync resets it.
      if (!ex.nextBatch) {
        if (this.cfg.health) this.cfg.health.homeserverReachable = false;
        if (signal.aborted) break;
        await this.backoff(signal, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
        continue;
      }
      since = ex.nextBatch;
      backoff = RECONNECT_INITIAL_MS;
      if (this.cfg.health) this.cfg.health.homeserverReachable = true;

      for (const roomId of ex.invites) {
        const { allowed } = this.inviteLimiter.tryConsume(
          MATRIX_INVITE_AUTOJOIN_KEY,
          MATRIX_INVITE_AUTOJOIN_CAP,
          Date.now(),
        );
        if (!allowed) {
          this.log(
            `matrix bridge: declined invite to ${roomId} (auto-join rate limit exceeded)`,
          );
          continue;
        }
        await this.cfg.rest.joinRoom(roomId);
        this.log(`matrix bridge: joined room ${roomId}`);
      }
      for (const roomId of ex.encryptedRooms) {
        if (this.encryptedRooms.has(roomId)) continue;
        this.encryptedRooms.add(roomId);
        await this.send(roomId, {
          msgtype: 'm.text',
          body: ENCRYPTED_ROOM_NOTICE,
        });
      }

      // Skip replaying timeline history on the initial full sync — state
      // (power levels, encryption, invites) is applied above regardless.
      if (!initial) {
        // Off the loop: a prompt holds its POST open for the whole turn, and
        // the reactions below (and later syncs) carry the approvals it awaits.
        for (const msg of ex.messages) void this.dispatchMessage(msg);
        for (const reaction of ex.reactions)
          await this.dispatchSafely('reaction', () =>
            handleReaction(reaction, this.dispatchDeps()),
          );
      }
      // A !qwen attach this batch may have bound a new session → pick it up.
      this.reconcileSubscriptions(signal);
    }
  }

  /**
   * Run one event's dispatch; a failure is logged and dropped so the sync loop
   * moves on to the next event (#155). Without this, one rejected gateway call
   * (BridgeClient rejects when its fetch fails) ended the loop for good while
   * the heartbeat and SSE loops kept the bridge looking alive. Matches the
   * Telegram poll loop, whose handleUpdate swallows per update.
   */
  private async dispatchSafely(
    kind: 'message' | 'reaction',
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch (err) {
      this.log(
        `matrix bridge: ${kind} dispatch failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  /** Self-healing SSE echo loop per bound session (backoff reconnect to abort). */
  private reconcileSubscriptions(signal: AbortSignal): void {
    const bound = this.cfg.rooms.boundSessions();
    // A session whose binding went (detach, or a room re-attached elsewhere)
    // loses its stream and its cursor entry.
    for (const sessionId of this.cursors.release(bound)) {
      this.log(`matrix bridge: session ${sessionId} unbound, cursor dropped`);
    }
    for (const sessionId of bound) {
      if (this.subscribed.has(sessionId)) continue;
      this.subscribed.add(sessionId);
      void this.subscriptionLoop(sessionId, signal);
    }
  }

  private async subscriptionLoop(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let backoff = RECONNECT_INITIAL_MS;
    const stream = this.cursors.signalFor(sessionId, signal);
    try {
      while (!stream.aborted) {
        // Resume from the last frame id seen so a reconnect catches frames that
        // arrived during the blip (the daemon replays only id > cursor).
        await this.cfg.client.subscribeEvents(
          sessionId,
          (ev) => {
            if (typeof ev.id === 'number') {
              // Persist the cursor so restarts resume from here (not for a
              // stream whose session was unbound meanwhile).
              this.cursors.record(sessionId, ev.id, stream);
            }
            this.deliverEvent(sessionId, ev);
          },
          stream,
          this.cursors.lastEventId.get(sessionId),
        );
        if (stream.aborted) break;
        await this.backoff(stream, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      }
    } finally {
      this.subscribed.delete(sessionId);
    }
  }

  private backoff(
    signal: AbortSignal,
    base = RECONNECT_INITIAL_MS,
  ): Promise<void> {
    const sleep = this.cfg.sleep ?? defaultSleep;
    const ms = Math.round(base * (0.8 + Math.random() * 0.4));
    return sleep(ms, signal);
  }

  /**
   * Outbound: permission_request → room message (edited via m.replace on
   * resolve); permission_resolved → the edit AND a turn boundary so the next
   * stream chunk starts a fresh turn; session_update → stream the agent's prose
   * (Markdown→HTML, m.thread on long turns). Fire-and-forget. Exposed for testing.
   */
  deliverEvent(sessionId: string, ev: BridgeEvent): void {
    if (ev.type === 'permission_request') {
      void this.deliverPermissionRequest(sessionId, ev.data);
    } else if (ev.type === 'permission_resolved') {
      this.stream.notePermissionResolved(sessionId); // next chunk = new turn
      void this.deliverPermissionResolved(ev.data);
    } else if (ev.type === 'session_update') {
      const text = extractAgentText(ev.data);
      if (text) this.stream.onChunk(sessionId, text);
    }
  }

  private async deliverPermissionRequest(
    sessionId: string,
    data: unknown,
  ): Promise<void> {
    const d = (data ?? {}) as Record<string, unknown>;
    const requestId = typeof d['requestId'] === 'string' ? d['requestId'] : '';
    const content = renderPermissionRequest(data, {
      baseUrl: this.cfg.baseUrl,
    });
    // `tracksReactions` is false for deeplink (sensitive) surface. We still
    // track deeplink events with surface:'deeplink' so handleReaction can send
    // a one-time guidance reply when a user reacts on them.
    const isDeeplink = !tracksReactions(data);
    this.expireTracked();
    const timeoutMs = d['timeoutMs'];
    const expiresAt =
      this.now() +
      (typeof timeoutMs === 'number' &&
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0
        ? timeoutMs
        : DEFAULT_REQUEST_TTL_MS);
    for (const roomId of this.cfg.rooms.roomsFor(sessionId)) {
      const r = await this.send(roomId, content);
      if (!r.ok || !r.eventId) continue;
      if (requestId) {
        const list = this.sent.get(requestId) ?? [];
        list.push({ roomId, eventId: r.eventId, body: content.body });
        this.sent.set(requestId, list);
        this.tracked.set(r.eventId, {
          requestId,
          sessionId,
          roomId, // a reaction votes only from this room (#168)
          surface: isDeeplink ? 'deeplink' : 'inline',
          expiresAt,
        });
      }
    }
  }

  private now(): number {
    return (this.cfg.now ?? Date.now)();
  }

  /**
   * Stop tracking permission requests that outlived their deadline without a
   * `permission_resolved` (the session ended, or the frame was missed): without
   * this they stay in memory for the bridge's lifetime (#204). Each is logged
   * once and remembered (newest {@link EXPIRED_KEEP}) so a late reaction on it
   * is answered rather than silently dropped. Run before every dispatch and
   * every new request, which bounds the tracked set without a timer.
   */
  private expireTracked(): void {
    const now = this.now();
    const logged = new Set<string>();
    for (const [eventId, t] of this.tracked) {
      if (t.expiresAt === undefined || now < t.expiresAt) continue;
      this.tracked.delete(eventId);
      this.sent.delete(t.requestId);
      this.deeplinkGuidanceSent.delete(t.requestId);
      this.expired.delete(eventId); // re-insert as the newest
      this.expired.set(eventId, { requestId: t.requestId, roomId: t.roomId });
      if (!logged.has(t.requestId)) {
        logged.add(t.requestId);
        this.log(
          `matrix bridge: permission request ${t.requestId} (session ` +
            `${t.sessionId}) expired unresolved; no longer tracked`,
        );
      }
    }
    while (this.expired.size > EXPIRED_KEEP) {
      const oldest = this.expired.keys().next().value;
      if (oldest === undefined) break;
      this.expired.delete(oldest);
    }
  }

  private async deliverPermissionResolved(data: unknown): Promise<void> {
    const d = (data ?? {}) as Record<string, unknown>;
    const requestId = typeof d['requestId'] === 'string' ? d['requestId'] : '';
    const targets = this.sent.get(requestId);
    if (!targets) return;
    this.sent.delete(requestId);
    const outcome =
      typeof d['outcome'] === 'string' ? (d['outcome'] as string) : 'resolved';
    for (const t of targets) {
      this.tracked.delete(t.eventId); // stop accepting reactions on a resolved req
      await this.send(t.roomId, renderResolveEdit(t.body, t.eventId, outcome));
    }
  }
}

/** `content` with an empty `m.mentions` (and in `m.new_content`, for an edit). */
function withoutMentions(content: unknown): unknown {
  if (!content || typeof content !== 'object') return content;
  const c = content as Record<string, unknown>;
  const out: Record<string, unknown> = { ...c, 'm.mentions': {} };
  const edited = c['m.new_content'];
  if (edited && typeof edited === 'object')
    out['m.new_content'] = { ...edited, 'm.mentions': {} };
  return out;
}

/** Sleep `ms`, resolving early if `signal` aborts (so shutdown is prompt). */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
