/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import {
  isGoneSessionError,
  type RecoveryState,
  type SessionDaemon,
} from '../daemonPool.js';
import type { ConnectionRegistry } from '../connectionRegistry.js';
import type { AuditRecorder } from '../auditLog.js';
import type { UsageTickBroadcaster } from '../cost/usageTickBroadcaster.js';
import type { UsageTick } from '../cost/ingester.js';
import type { PromptEventBroadcaster } from './promptEventBroadcaster.js';
import type { WatchPresence } from '../webpush/watchPresence.js';
import { computeBridgeHints } from '../bridges/hints.js';
import { BRIDGE } from '../scopes.js';
import { getSharedWal } from '../wal.js';
import type { ReplayResult, WalFrame } from '../wal.js';
import {
  CONSERVATIVE_EPOCH,
  resolveEpochState,
  saveEpochState,
  type EpochState,
} from '../walEpoch.js';
import { isValidSessionId } from '../sessions/chatsPath.js';

/**
 * GET /session/:id/events: relay the daemon's SSE stream downstream.
 * Aborts the watcher when the client disconnects OR when the caller's token is
 * revoked (the registry fires the same abort controller). Audits attach/detach.
 *
 * Two shapes, chosen by whether a session WAL is wired:
 *
 * - WAL dark (`walDir` undefined): one daemon subscription per connection,
 *   raw ids and the client's Last-Event-ID passed straight through, exactly as
 *   before the WAL existed.
 * - WAL wired: one daemon subscription per SESSION, owned by a
 *   {@link SessionEventsHub} and shared by every watcher (#174). The hub
 *   appends each raw frame to the WAL exactly once under a gateway id, and fans
 *   it out. A watcher resumes from its own Last-Event-ID, in the gateway's
 *   numbering, out of the WAL; the daemon is only ever handed the hub's own
 *   cursor, in the daemon's numbering. When a watcher's Last-Event-ID is older
 *   than the WAL holds, the route answers 412 `replay_truncated`.
 */
/** Default grace period before an idle-but-reachable session gets its 200. */
const DEFAULT_IDLE_ATTACH_MS = 2000;

/**
 * How long a session's shared upstream subscription outlives its last
 * watcher. A page reconnecting after a stall, a network blip or a reload lands
 * inside this and reuses the subscription instead of paying a daemon
 * resubscribe (and its catch-up replay) each time.
 */
const DEFAULT_HUB_GRACE_MS = 5_000;

/**
 * Heartbeat cadence for the watched-session relay, matching the owner feed in
 * `ownerEvents.ts`.
 *
 * Every write on this route is reactive to a daemon frame, so an idle watched
 * session emits zero bytes. A socket that has half-opened (a suspended phone
 * radio, a closed laptop lid, an idle tailnet or proxy path) then looks exactly
 * like a healthy one: the browser reader parked on `read()` receives neither a
 * rejection nor `{done: true}`, so the client's retry path is never reached and
 * the transcript stops updating until the user re-selects the conversation or
 * reloads the page.
 *
 * A comment line is the right primitive here. It forces a byte down the socket
 * without advancing the client's `Last-Event-ID` cursor and without reaching
 * its event parser.
 */
const HEARTBEAT_MS = 25_000;

/**
 * Arm the per-connection heartbeat and return its teardown. Every attach path
 * calls the teardown from its `finally`, so the timer cannot outlive the
 * response and hold a closed session open.
 */
function startHeartbeat(res: Response, ms: number): () => void {
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(': ping\n\n');
    } catch {
      // Socket already gone; the route's own close/abort path owns teardown.
    }
  }, ms);
  // Never let the heartbeat keep the process, or a test, alive.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  return () => clearInterval(heartbeat);
}

/**
 * Default hold before a watcher on a recovering session gives up and gets its
 * 502 (add-mid-turn-recovery §3). Independent of the saga's own pace: a stuck
 * saga can never wedge a watcher forever.
 */
const DEFAULT_RECOVERY_ATTACH_MS = 60_000;

type FirstFrame<T> =
  | { first: IteratorResult<T> }
  | { pending: Promise<IteratorResult<T>> };

/**
 * Await the first daemon frame, but never hang on a reachable-but-idle session.
 *
 * The daemon sends SSE headers + `retry:` on connect but no *frame* until the
 * session has activity — so a freshly-created idle session yields nothing, and
 * gating `res.writeHead(200)` on the first frame leaves a watcher stuck at
 * "connecting" forever (the composer never opens). This resolves:
 *  - `{ first }` when a frame (or `{done:true}`) arrives first — normal path;
 *  - `{ pending }` (the still-live `next()`) when neither a frame nor an error
 *    arrives within `idleMs` — the caller sends headers now and writes that
 *    frame if/when it lands, dropping nothing;
 * and REJECTS (rethrows) on a real connection error, so the caller still sends
 * a pre-header `502` when the daemon is genuinely unreachable.
 */
function firstFrameOrIdle<T>(
  next: Promise<IteratorResult<T>>,
  idleMs: number,
): Promise<FirstFrame<T>> {
  const idle = Symbol('idle');
  return Promise.race([
    next.then((first): FirstFrame<T> => ({ first })),
    new Promise<never>((_, reject) => setTimeout(() => reject(idle), idleMs)),
  ]).catch((e): FirstFrame<T> => {
    if (e === idle) return { pending: next };
    throw e;
  });
}

/**
 * Map a failed upstream subscribe onto a response before any headers went out.
 *
 * A session the daemon no longer knows must be a 404, not the generic 502:
 * the web UI treats only 401/403/404 as terminal, so a masked 404 leaves it
 * re-subscribing to a dead id indefinitely (#59 — 9.4k 404s/hour on the live
 * gateway after a restart, which kills every session id). Same mapping as the
 * sibling GET /session/:id/status; the gone-vs-transient test itself lives in
 * `isGoneSessionError` so the push pump cannot drift from it.
 */
function respondSubscribeFailure(res: Response, err: unknown): void {
  if (isGoneSessionError(err)) {
    res
      .status(404)
      .json({ error: 'Session not found', code: 'session_not_found' });
    return;
  }
  res
    .status(502)
    .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
}

/** A frame as the daemon yields it, before or after renumbering. */
type RelayFrame = {
  id?: number;
  v?: number;
  type?: string;
  data?: unknown;
  _meta?: Record<string, unknown>;
};

/** How a watcher's stream ends: a clean end writes `client_left` first. */
type WatcherEnd = 'graceful' | 'error';

/** Placeholder in a watcher's buffer for its own `replay_complete`. */
const REPLAY_COMPLETE = Symbol('replay_complete');

/**
 * One downstream connection attached to a {@link SessionEventsHub}.
 *
 * Frames the hub fans out before this connection's headers are written (the
 * hub can already be relaying while the route waits for the upstream to
 * answer) are buffered and written after the watcher's own WAL replay, in
 * order. The route reads that replay and joins the hub in one synchronous
 * step, so every frame is in exactly one of the two.
 *
 * A watcher that sent a cursor asked for a replay, and the page closes a
 * replay on the id-less `replay_complete` sentinel (the daemon sends one per
 * subscriber). The daemon's own sentinel belongs to the hub's subscription, so
 * each watcher gets one of its own: after its WAL replay, or, when it joined
 * while the hub was still catching up on what the gateway missed, after that.
 */
class HubWatcher {
  private res: Response | undefined;
  private pending: Array<string | typeof REPLAY_COMPLETE> = [];
  private replayCompleteQueued = false;
  private replayedCount = 0;
  private lastReplayedId: number | undefined;
  /** Joined while the hub's upstream was still replaying its catch-up. */
  awaitingCatchUp = false;
  private ended: WatcherEnd | undefined;
  private finished = false;
  private resolveDone!: () => void;
  /** Settles when the hub ends this watcher or the client goes away. */
  readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(
    private readonly wantsReplay: boolean,
    private readonly actorTokenId: string | undefined,
    /**
     * Frames at or below this id are already on the client: set only when the
     * WAL held nothing to replay from the watcher's cursor (see the route).
     */
    private readonly skipThrough?: number,
  ) {}

  /**
   * Fan-out entry: one serialized SSE block, with its id when it has one.
   * `gap` marks a resync marker, which is never skipped: it is about the
   * hole, not about frames the client already has.
   */
  deliver(chunk: string, id?: number, gap = false): void {
    if (this.finished) return;
    if (
      !gap &&
      id !== undefined &&
      this.skipThrough !== undefined &&
      id <= this.skipThrough
    ) {
      return;
    }
    if (id !== undefined && this.wantsReplay && !this.replayCompleteQueued) {
      this.noteReplayed(id, 1);
    }
    if (this.res === undefined) this.pending.push(chunk);
    else this.write(chunk);
  }

  /** The hub's upstream has finished replaying what the gateway missed. */
  catchUpDone(): void {
    this.awaitingCatchUp = false;
    if (this.res !== undefined) this.queueReplayComplete();
  }

  /** Headers are out: write the WAL replay, then everything buffered. */
  open(res: Response, replay: readonly WalFrame[]): void {
    this.res = res;
    for (const ev of replay) this.write(serializeFrame(ev));
    if (replay.length > 0) {
      // Replay ids are all below anything buffered, which the hub appended
      // after the join, so the buffered ones are already the later maxima.
      this.replayedCount += replay.length;
      this.lastReplayedId = Math.max(
        this.lastReplayedId ?? 0,
        replay[replay.length - 1]!.id,
      );
    }
    for (const item of this.pending) {
      if (item === REPLAY_COMPLETE) this.writeReplayComplete();
      else this.write(item);
    }
    this.pending = [];
    if (!this.awaitingCatchUp) this.queueReplayComplete();
    if (this.ended !== undefined) this.finish();
  }

  end(kind: WatcherEnd): void {
    if (this.ended !== undefined) return;
    this.ended = kind;
    if (this.res !== undefined) this.finish();
    this.resolveDone();
  }

  private noteReplayed(id: number, n: number): void {
    this.replayedCount += n;
    this.lastReplayedId = Math.max(this.lastReplayedId ?? 0, id);
  }

  private queueReplayComplete(): void {
    if (!this.wantsReplay || this.replayCompleteQueued) return;
    this.replayCompleteQueued = true;
    if (this.res === undefined) this.pending.push(REPLAY_COMPLETE);
    else this.writeReplayComplete();
  }

  /** Same shape as the daemon's sentinel, in the gateway's numbering. */
  private writeReplayComplete(): void {
    const last = this.lastReplayedId;
    this.write(
      serializeFrame({
        v: 1,
        type: 'replay_complete',
        data: {
          ...(last !== undefined
            ? { lastReplayedEventId: last, lastEventId: last }
            : {}),
          replayedCount: this.replayedCount,
        },
      }),
    );
  }

  private finish(): void {
    if (this.finished || this.res === undefined) return;
    this.finished = true;
    if (this.ended === 'graceful') {
      writePresenceLeft(this.res, this.actorTokenId, 'disconnect');
    }
    if (!this.res.writableEnded) this.res.end();
  }

  private write(chunk: string): void {
    const res = this.res;
    if (res === undefined || res.writableEnded || res.destroyed) return;
    try {
      res.write(chunk);
    } catch {
      // Socket already gone; the route's close/abort path owns teardown.
    }
  }
}

interface HubDeps {
  daemon: SessionDaemon;
  walDir: string;
  sessionId: string;
  idleAttachMs: number;
  graceMs: number;
  onClosed: (hub: SessionEventsHub) => void;
}

/**
 * The one daemon subscription for a watched session, shared by every watcher
 * (#174).
 *
 * Before this, every watcher ran its own daemon subscription while all of them
 * appended to the one shared WAL and renumbered against the one shared epoch
 * state. The real bus hands every subscriber the same raw ids, so the second
 * relay to see raw id N found `N <= lastOutId`, took it for a new daemon epoch,
 * re-anchored, and appended N again under the next gateway id: one device saw
 * 1,3,5, the other 2,4,6, and the WAL held every frame twice.
 *
 * Here the hub alone talks to the daemon, appends each raw frame to the WAL
 * once, and fans the renumbered frame out. Watchers are reference counted: the
 * last one leaving starts a grace timer, and the subscription is closed only
 * if nobody has come back when it fires. When the upstream ends or fails, every
 * watcher's stream ends with it, which is what each watcher saw when it had a
 * subscription of its own, and the page reconnects onto a fresh hub.
 */
class SessionEventsHub {
  private readonly watchers = new Set<HubWatcher>();
  private readonly upstream = new AbortController();
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly state: EpochState;
  /** The bus epoch token this subscription's daemon reported, if any. */
  private liveEpoch: string | undefined;
  /** The daemon said its replay restarts at its epoch's start (no token). */
  private epochResetSeen = false;
  closed = false;
  /** Subscribed with a cursor and the daemon's `replay_complete` not yet seen. */
  catchingUp: boolean;
  /** Settles once the upstream answered (a frame, an idle grace) or failed. */
  readonly ready: Promise<void>;

  constructor(
    private readonly deps: HubDeps,
    firstCursor: number | undefined,
  ) {
    this.state = resolveEpochState(deps.walDir, deps.sessionId);
    const cursor = this.upstreamCursor(firstCursor);
    this.catchingUp = cursor !== undefined;
    let resolveReady!: () => void;
    let rejectReady!: (err: unknown) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Every waiting watcher handles the rejection; a hub whose watchers all
    // left before it failed must not surface it as an unhandled rejection.
    this.ready.catch(() => {});
    void this.pump(cursor, resolveReady, rejectReady);
  }

  join(watcher: HubWatcher): void {
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    watcher.awaitingCatchUp = this.catchingUp;
    this.watchers.add(watcher);
  }

  leave(watcher: HubWatcher): void {
    this.watchers.delete(watcher);
    if (this.closed || this.watchers.size > 0 || this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      if (this.watchers.size === 0) this.close('graceful');
    }, this.deps.graceMs);
    if (typeof this.graceTimer.unref === 'function') this.graceTimer.unref();
  }

  private close(kind: WatcherEnd): void {
    if (this.closed) return;
    this.closed = true;
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    this.upstream.abort();
    this.deps.onClosed(this);
    for (const w of this.watchers) w.end(kind);
    this.watchers.clear();
  }

  /**
   * The daemon cursor for this subscription, always in the DAEMON's numbering.
   * A watcher's Last-Event-ID is in the gateway's numbering and is answered out
   * of the WAL, so it is never forwarded.
   */
  private upstreamCursor(firstCursor: number | undefined): number | undefined {
    // Relayed before: resume from the last raw id this gateway relayed, so the
    // daemon replays exactly what the WAL is missing.
    if (this.state.lastOutId !== CONSERVATIVE_EPOCH.lastOutId) {
      return this.state.lastOutId;
    }
    // Never relayed: the numbering is still the daemon's own (the first frame
    // anchors at offset 0), so the first watcher's cursor is a daemon cursor,
    // exactly as the WAL-dark relay forwarded it: 0 replays the daemon's ring
    // into the WAL, a load watermark resumes after it, none is live only.
    return firstCursor;
  }

  private async pump(
    cursor: number | undefined,
    resolveReady: () => void,
    rejectReady: (err: unknown) => void,
  ): Promise<void> {
    const { daemon, sessionId, idleAttachMs } = this.deps;
    let iterator: AsyncGenerator<RelayFrame>;
    let attach: FirstFrame<RelayFrame>;
    try {
      const epoch = this.state.daemonEpoch;
      iterator = daemon.subscribeEvents(sessionId, {
        ...(cursor !== undefined ? { lastEventId: cursor } : {}),
        // The token the cursor was minted under: a daemon whose bus has since
        // been rebuilt answers with an epoch_reset resync and replays its new
        // epoch from the start, instead of serving "after N" out of a
        // numbering that restarted.
        ...(cursor !== undefined && epoch !== undefined ? { epoch } : {}),
        onEpoch: (learned: string) => {
          this.liveEpoch = learned;
        },
        signal: this.upstream.signal,
      });
      // Confirm reachability without hanging on an idle session (see
      // firstFrameOrIdle); a real error rejects and the waiting watchers 502.
      attach = await firstFrameOrIdle(iterator.next(), idleAttachMs);
    } catch (err) {
      rejectReady(err);
      this.close('error');
      return;
    }
    resolveReady();
    try {
      const first = 'first' in attach ? attach.first : await attach.pending;
      if (!first.done) {
        this.relay(first.value);
        for await (const ev of iterator) {
          if (this.closed) break;
          this.relay(ev);
        }
      }
      this.close('graceful');
    } catch {
      this.close(this.upstream.signal.aborted ? 'graceful' : 'error');
    }
  }

  /**
   * Append a daemon frame to the WAL under its gateway id, then fan it out
   * (add-mid-turn-recovery §4 renumbering, now done once per raw frame).
   *
   * Gateway id = raw id + the epoch's offset, with three rules:
   *
   * - A new daemon epoch is recognised by its bus epoch token when both sides
   *   have one. Only without a token does the relay fall back to the old guess
   *   (`raw <= lastOutId`), which a restart whose ids have already passed the
   *   old cursor defeats; a daemon `epoch_reset` resync also counts there.
   * - In the same epoch, a raw id at or below `lastOutId` is already in the WAL
   *   (resubscribing below the end replays it), so it is dropped, not appended
   *   a second time under the id it already has.
   * - The gateway id is always above the WAL's end. A new epoch anchors at
   *   `max(0, latest + 1 - raw)`, keeping the daemon's own numbering while it
   *   can (gaps are fine, the daemon's own ids have them); and a marker that
   *   took the next slot through the shared handle (rewind, recovery, a resync
   *   gap) moves the offset up past it instead of being collided with.
   */
  private relay(ev: RelayFrame): void {
    if (this.closed) return;
    const { walDir, sessionId } = this.deps;
    if (ev.id === undefined) {
      // The daemon's replay sentinel answers the hub's cursor, not any
      // watcher's; each watcher gets its own (see HubWatcher).
      if (ev.type === 'replay_complete') {
        this.finishCatchUp();
        return;
      }
      if (ev.type === 'state_resync_required') {
        this.recordGap(ev);
        return;
      }
      this.broadcast(serializeFrame(ev));
      return;
    }
    // The registry handle, fetched per frame, so this appends through the same
    // instance the rewind, fork and recovery markers use even if the registry
    // dropped and rebuilt it while this subscription was open.
    const wal = getSharedWal(walDir, sessionId);
    const state = this.state;
    const raw = ev.id;
    const tokens =
      this.liveEpoch !== undefined && state.daemonEpoch !== undefined;
    const newEpoch = tokens
      ? this.liveEpoch !== state.daemonEpoch
      : this.epochResetSeen || raw <= state.lastOutId;
    if (!newEpoch && raw <= state.lastOutId) return;
    const latest = wal.latestId() ?? 0;
    if (newEpoch) state.epochOffset = Math.max(0, latest + 1 - raw);
    if (raw + state.epochOffset <= latest) state.epochOffset = latest + 1 - raw;
    this.epochResetSeen = false;
    const outId = raw + state.epochOffset;
    state.lastOutId = raw;
    if (this.liveEpoch !== undefined) state.daemonEpoch = this.liveEpoch;
    else delete state.daemonEpoch;
    wal.append({
      id: outId,
      v: ev.v ?? 1,
      type: ev.type ?? 'unknown',
      data: ev.data,
      ...(ev._meta !== undefined ? { _meta: ev._meta } : {}),
      _rc: {
        raw,
        ...(this.liveEpoch !== undefined ? { epoch: this.liveEpoch } : {}),
      },
    });
    // Persist per frame. The WAL's own stamps are authoritative (see
    // resolveEpochState); this is the fallback for a log that holds none.
    saveEpochState(walDir, sessionId, state);
    this.broadcast(serializeFrame({ ...ev, id: outId }), outId);
  }

  /**
   * The daemon could not replay what this subscription asked for: its ring
   * rolled, a load reseeded it, or its bus is a new epoch. The WAL now has a
   * hole at this point, and every watcher whose view runs through it has to
   * reload. The daemon's resync frame is id-less and reaches only the
   * subscribers present right now, so a later watcher replaying across the
   * hole out of the WAL would never hear of it and render a silently partial
   * transcript (#150). Written into the WAL under a gateway id instead, at the
   * hole, it is replayed to exactly the watchers whose cursor is before it,
   * and to none after. The daemon's own ids in its data are dropped: they are
   * in its numbering, not the one a watcher's cursor is in.
   */
  private recordGap(ev: RelayFrame): void {
    const { walDir, sessionId } = this.deps;
    const data = (ev.data ?? {}) as Record<string, unknown>;
    if (data['reason'] === 'epoch_reset') this.epochResetSeen = true;
    const wal = getSharedWal(walDir, sessionId);
    const frame: WalFrame = {
      id: (wal.latestId() ?? 0) + 1,
      v: ev.v ?? 1,
      type: 'state_resync_required',
      data: {
        reason: typeof data['reason'] === 'string' ? data['reason'] : 'unknown',
        ...(typeof data['detail'] === 'string'
          ? { detail: data['detail'] }
          : {}),
      },
    };
    wal.append(frame);
    this.broadcast(serializeFrame(frame), frame.id, true);
  }

  private finishCatchUp(): void {
    if (!this.catchingUp) return;
    this.catchingUp = false;
    for (const w of this.watchers) w.catchUpDone();
  }

  private broadcast(chunk: string, id?: number, gap = false): void {
    for (const w of this.watchers) w.deliver(chunk, id, gap);
  }
}

export function createSessionEventsRoute(
  daemon: SessionDaemon,
  registry: ConnectionRegistry,
  audit?: AuditRecorder,
  usageBroadcaster?: UsageTickBroadcaster,
  walDir?: string,
  promptEventBroadcaster?: PromptEventBroadcaster,
  /**
   * Live-watch presence for push suppression (#40): each attached stream
   * joins on attach and leaves in the teardown, so the notifier can skip
   * turn-end pushes while the session is watched live. Absent → no
   * presence tracking.
   */
  watchPresence?: WatchPresence,
  idleAttachMs: number = DEFAULT_IDLE_ATTACH_MS,
  recoveryAttachMs: number = DEFAULT_RECOVERY_ATTACH_MS,
  /**
   * Heartbeat cadence for this connection. Injectable so a test can observe a
   * ping without waiting out the production 25s or faking timers around a real
   * socket.
   */
  heartbeatMs: number = HEARTBEAT_MS,
  /**
   * How long a session's shared upstream outlives its last watcher (WAL wired
   * only). Injectable so a test can watch it close without a 5s wait.
   */
  hubGraceMs: number = DEFAULT_HUB_GRACE_MS,
): RequestHandler {
  // One hub per session for this route instance. Per instance rather than
  // module-wide so two apps in one process (tests) never share an upstream.
  const hubs = new Map<string, SessionEventsHub>();
  const acquireHub = (
    dir: string,
    sessionId: string,
    firstCursor: number | undefined,
  ): SessionEventsHub => {
    const live = hubs.get(sessionId);
    if (live !== undefined && !live.closed) return live;
    const hub = new SessionEventsHub(
      {
        daemon,
        walDir: dir,
        sessionId,
        idleAttachMs,
        graceMs: hubGraceMs,
        onClosed: (closed) => {
          if (hubs.get(sessionId) === closed) hubs.delete(sessionId);
        },
      },
      firstCursor,
    );
    hubs.set(sessionId, hub);
    return hub;
  };

  return async (req, res) => {
    const sessionId = req.params.id;
    // Reject a malformed/path-traversal-shaped id BEFORE any WAL path join
    // (getWal/SessionWal joins the raw id into a file path) or daemon call —
    // mirrors every sibling session route (fork.ts, rewind.ts, lineage.ts,
    // idleToggle.ts). Unconditional (not gated on walDir being set) so this
    // stays correct if a future deploy wires walDir where it's undefined today.
    if (!isValidSessionId(sessionId)) {
      res
        .status(404)
        .json({ error: 'Session not found', code: 'session_not_found' });
      return;
    }
    const actorTokenId = req.rcClient?.id;
    const shareId = req.rcClient?.shareId;
    const shareLabel = req.rcClient?.shareLabel;
    // Bridge presence (add-bridge-protocol): tag attach/detach so the owner's
    // /rc/events feed distinguishes a bridge joining/leaving from a normal client
    // ("Telegram-bridge attached"). The bridge attaches once per stream (not per
    // chat user), so no subActor here.
    const kind = req.rcClient?.scopes.includes(BRIDGE) ? 'bridge' : 'client';
    const lastEventIdRaw = req.headers['last-event-id'];
    const lastEventId =
      typeof lastEventIdRaw === 'string' && lastEventIdRaw.length > 0
        ? Number(lastEventIdRaw)
        : undefined;

    // Recovery-pending attach (add-mid-turn-recovery §3): while a recovery
    // saga is in flight for this session the pool cannot resolve it (the dead
    // entry is gone, ownerOf was scrubbed), so hold the connection — no 404,
    // no 502, no headers yet — until the saga settles or the deadline hits.
    // The outcome is sticky (recovered / unrecoverable), so a late reconnect
    // lands on the right branch instead of re-holding.
    const recoveryProbe = daemon.recoveryState?.bind(daemon);
    if (recoveryProbe) {
      let recoveryState: RecoveryState = recoveryProbe(sessionId);
      if (recoveryState === 'recovering') {
        const deadline = Date.now() + recoveryAttachMs;
        let clientGone = false;
        const onHoldClose = () => {
          clientGone = true;
        };
        req.on('close', onHoldClose);
        try {
          while (recoveryProbe(sessionId) === 'recovering') {
            if (clientGone || Date.now() >= deadline) break;
            await new Promise((r) =>
              setTimeout(r, Math.min(100, deadline - Date.now())),
            );
          }
        } finally {
          req.off('close', onHoldClose);
        }
        if (clientGone) return; // socket gone during the hold; nothing to send
        recoveryState = recoveryProbe(sessionId);
        if (recoveryState === 'recovering') {
          // Deadline hit before the saga settled: the session is still
          // unresolvable and the hold is over.
          res.status(502).json({
            error: 'Daemon unavailable',
            code: 'daemon_unavailable',
          });
          return;
        }
      }
      if (recoveryState === 'unrecoverable') {
        // Terminal branch (§3): the session's daemon is gone for good. Serve
        // what the WAL retains (incl. the terminal session_interrupted marker)
        // and end the stream; with no WAL wired the common case is headers +
        // close. No 412: a dead session cannot honor a re-subscribe, so a
        // truncated resume point is best-effort, not an error.
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const replayed =
          walDir !== undefined &&
          lastEventId !== undefined &&
          Number.isFinite(lastEventId)
            ? getSharedWal(walDir, sessionId).replayFrom(lastEventId).events
            : [];
        for (const ev of replayed) writeFrame(res, ev);
        writePresenceLeft(res, actorTokenId, 'disconnect');
        res.end();
        return;
      }
      // 'recovered' → fall through to the normal attach below (WAL replay
      // first, as usual).
    }

    /**
     * Headers, heartbeat, presence, the attach audit row, the gateway-side
     * injectors and `client_joined`, in that order. Returns the teardown, which
     * also writes the detach audit row.
     */
    const openStream = (): (() => void) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Armed here rather than per-frame: the whole point is to cover the gap
      // where the session has nothing to send, which is exactly the state a
      // freshly-created session is in when the attach resolves idle.
      const stopHeartbeat = startHeartbeat(res, heartbeatMs);
      const leaveWatch = watchPresence?.join(sessionId) ?? (() => {});
      void audit?.record({
        action: 'session_attached',
        actorTokenId,
        target: sessionId,
        shareId,
        shareLabel,
        detail: { kind },
      });
      // Inject coalesced usage_tick frames for this session (add-cost-tracking):
      // the ingester pushes ticks to the broadcaster on its 500ms timer (an await
      // boundary, never mid-frame), so a single synchronous write here can't
      // interleave with a frame write.
      const unregisterUsage =
        usageBroadcaster?.register(sessionId, (tick) =>
          writeUsageTick(res, tick),
        ) ?? (() => {});
      // Inject gateway-side events (e.g. stream_error / prompt_timeout) emitted
      // by the prompt route when the execution deadline fires.
      const unregisterPromptEvents =
        promptEventBroadcaster?.register(sessionId, (ev) =>
          writeGatewayEvent(res, ev),
        ) ?? (() => {});
      // Emit synthetic client_joined as the first SSE frame on this stream.
      // No id: line — synthetic frames must not advance the Last-Event-ID cursor.
      writePresenceJoined(res, actorTokenId, req.rcClient?.scopes ?? []);
      return () => {
        stopHeartbeat();
        unregisterPromptEvents();
        unregisterUsage();
        leaveWatch();
        void audit?.record({
          action: 'session_detached',
          actorTokenId,
          target: sessionId,
          shareId,
          shareLabel,
          detail: { kind },
        });
      };
    };

    const tokenId = req.rcClient?.id;

    if (walDir !== undefined) {
      // WAL wired: replay this watcher's gap out of the WAL, then put it on the
      // session's one shared upstream subscription.
      const cursor =
        lastEventId !== undefined && Number.isFinite(lastEventId)
          ? lastEventId
          : undefined;
      let replayed: WalFrame[] = [];
      let skipThrough: number | undefined;
      let hub: SessionEventsHub;
      let watcher: HubWatcher;
      try {
        if (cursor !== undefined) {
          const wal = getSharedWal(walDir, sessionId);
          const replay = wal.replayFrom(cursor);
          if (replay.truncated && replay.reason === 'older_than_wal_horizon') {
            res.status(412).json(replayTruncatedBody(replay, wal.latestId()));
            return;
          }
          if (replay.truncated) {
            // An empty WAL ('no_wal'): the gateway has relayed nothing of
            // this session, so it has nothing to replay and no hole it could
            // vouch for. The cursor came from the daemon's own numbering (the
            // WAL-dark relay passed raw ids through; a load response hands
            // out its watermark), which a never-relayed session still shares,
            // so it is honoured the way the WAL-dark relay honoured it: the
            // session's subscription resumes the daemon from it, and nothing
            // at or below it is handed to this watcher. A 412 here sent a
            // reloading page to a null cursor that blanked the transcript it
            // had just rendered, and sends a resuming one round the resume
            // again.
            skipThrough = cursor;
          } else {
            replayed = replay.events;
          }
        }
        // Same synchronous step as the replay read above, with no await
        // between: a frame the hub appends from here on lands in this
        // watcher's buffer, and one appended before it is in `replayed`.
        // Nothing falls between.
        watcher = new HubWatcher(
          cursor !== undefined,
          actorTokenId,
          skipThrough,
        );
        hub = acquireHub(walDir, sessionId, cursor);
        hub.join(watcher);
      } catch {
        // The log could not be read or opened (permissions, a full disk).
        // Answered rather than thrown: Express 4 does not catch a rejected
        // async handler, and the request would hang until the socket timed
        // out. Retryable, like the daemon's 502.
        res
          .status(500)
          .json({ error: 'Session log unavailable', code: 'wal_unavailable' });
        return;
      }

      const abort = new AbortController();
      const unregister = tokenId ? registry.register(tokenId, abort) : () => {};
      // Client gone or token revoked: this watcher leaves; the subscription
      // stays up for the others (and for the grace, if it was the last).
      const onAbort = () => {
        hub.leave(watcher);
        watcher.end('graceful');
      };
      abort.signal.addEventListener('abort', onAbort);
      req.on('close', () => abort.abort());
      let closeStream: (() => void) | undefined;
      try {
        try {
          await hub.ready;
        } catch (err) {
          if (!abort.signal.aborted && !res.headersSent) {
            respondSubscribeFailure(res, err);
          }
          return;
        }
        if (abort.signal.aborted) return;
        closeStream = openStream();
        watcher.open(res, replayed);
        await watcher.done;
      } finally {
        abort.signal.removeEventListener('abort', onAbort);
        hub.leave(watcher);
        closeStream?.();
        unregister();
      }
      return;
    }

    // WAL dark: one daemon subscription per connection, raw ids and the
    // client's cursor passed straight through.
    const abort = new AbortController();
    const unregister = tokenId ? registry.register(tokenId, abort) : () => {};
    req.on('close', () => abort.abort());
    let closeStream: (() => void) | undefined;
    try {
      const iterator = daemon.subscribeEvents(sessionId, {
        lastEventId: Number.isFinite(lastEventId) ? lastEventId : undefined,
        signal: abort.signal,
      });
      // Confirm the daemon is reachable, but don't hang on a reachable-but-idle
      // session (a freshly-created session emits no frame). A real connection
      // error rejects here → the outer catch sends a pre-header 502.
      const attach = await firstFrameOrIdle(iterator.next(), idleAttachMs);
      closeStream = openStream();
      // The first live frame: the one already peeked, or — on an idle attach —
      // the one that eventually arrives on the still-pending next() (headers are
      // already out, so the watcher's composer opens immediately either way).
      const first = 'first' in attach ? attach.first : await attach.pending;
      if (!first.done) writeFrame(res, first.value);
      for await (const ev of iterator) writeFrame(res, ev);
      // Daemon stream ended gracefully: emit client_left before closing.
      writePresenceLeft(res, actorTokenId, 'disconnect');
      res.end();
    } catch (err) {
      if (abort.signal.aborted) {
        // Client disconnected (or token evicted): try to emit client_left
        // before the socket disappears. Guard: socket may already be gone.
        writePresenceLeft(res, actorTokenId, 'disconnect');
        res.end();
      } else if (!res.headersSent) {
        respondSubscribeFailure(res, err);
      } else {
        res.end();
      }
    } finally {
      closeStream?.();
      unregister();
    }
  };
}

/**
 * The 412 `replay_truncated` body, for a watcher whose Last-Event-ID is older
 * than anything the WAL still holds:
 *
 *     {
 *       "type": "replay_truncated",
 *       "data": {
 *         "reason": "older_than_wal_horizon",
 *         "earliestAvailableId": 500,
 *         "recovery": "reload",
 *         "lastEventId": 742
 *       }
 *     }
 *
 * - `earliestAvailableId`: the oldest gateway id still retained. Retrying the
 *   watch from `earliestAvailableId - 1` replays what the WAL has, and only
 *   that: the conversation from the boundary on, with everything before it
 *   missing and nothing on screen saying so.
 * - `recovery: "reload"`: what the page should do instead (#150). Reload the
 *   whole conversation from the load response (POST /session/:id/resume
 *   renders `compactedReplay` + `liveJournal` in-band), then watch from that
 *   response's `lastEventId`, which the gateway hands back already mapped into
 *   its own numbering and never below the WAL head, so the watch that follows
 *   cannot land behind the boundary and 412 again.
 * - `lastEventId`: the WAL head right now, in the gateway's numbering: the
 *   cursor to watch from after that reload if its response carries no
 *   watermark (an older daemon). Null when the WAL is empty.
 *
 * Fields are additive: a page that reads only `earliestAvailableId` keeps its
 * boundary retry.
 */
function replayTruncatedBody(
  replay: Extract<ReplayResult, { truncated: true }>,
  head: number | null,
): {
  type: 'replay_truncated';
  data: {
    earliestAvailableId: number | null;
    reason: string;
    recovery: 'reload';
    lastEventId: number | null;
  };
} {
  return {
    type: 'replay_truncated',
    data: {
      earliestAvailableId: replay.earliestAvailableId,
      reason: replay.reason,
      recovery: 'reload',
      lastEventId: head,
    },
  };
}

/**
 * The resume route's daemon, with its response's `lastEventId` mapped from the
 * daemon's numbering into the gateway's (see gatewayCursorForDaemonCursor).
 *
 * With a WAL wired the events route reads a Last-Event-ID in the gateway's
 * numbering, but the page watches from the resume response's watermark, which
 * the daemon minted in its own. After a daemon restart the two differ, and a
 * raw watermark replayed history the page had just rendered from the response,
 * or landed behind the WAL's boundary and 412'd back into another resume.
 * Wired by server.ts only when a WAL is.
 */
export function withGatewayResumeCursor(
  daemon: Pick<SessionDaemon, 'resumeSession'>,
  walDir: string,
): Pick<SessionDaemon, 'resumeSession'> {
  return {
    resumeSession: async (sessionId, req) => {
      const restored = await daemon.resumeSession(sessionId, req);
      if (
        typeof restored.lastEventId !== 'number' ||
        !isValidSessionId(sessionId)
      ) {
        return restored;
      }
      return {
        ...restored,
        lastEventId: gatewayCursorForDaemonCursor(
          walDir,
          sessionId,
          restored.lastEventId,
          restored.eventEpoch,
        ),
      };
    },
  };
}

/**
 * One SSE block: the `id:` line only for a frame that carries an id. A WAL
 * frame's relay stamp (`_rc`, see walEpoch.ts) is the gateway's own
 * bookkeeping in the daemon's numbering and never reaches a client.
 */
function serializeFrame(ev: {
  id?: number;
  v?: number;
  type?: string;
  data?: unknown;
  _rc?: unknown;
}): string {
  const idLine = ev.id !== undefined ? `id: ${ev.id}\n` : '';
  let out: { id?: number; type?: string; data?: unknown } = ev;
  if (ev._rc !== undefined) {
    const { _rc: _stamp, ...rest } = ev;
    out = rest;
  }
  return `${idLine}data: ${JSON.stringify(enrich(out))}\n\n`;
}

/**
 * Map a cursor in the DAEMON's numbering (a load or resume response's
 * `lastEventId`, with its `eventEpoch`) into the gateway's, for a page that
 * renders that response's history and then watches from its watermark.
 *
 * - Never relayed: the first relayed frame anchors at offset 0, so the
 *   numbering is the daemon's own.
 * - Same epoch as the WAL's newest relayed frame (by token when both sides
 *   have one, by the raw ids otherwise): raw + that epoch's offset.
 * - An epoch the WAL has not reached yet: the WAL head. The next epoch is
 *   anchored above it.
 *
 * Never below the WAL head either way. A load is a full view as of now, so
 * nothing the WAL already holds is owed to a watcher starting from it, and a
 * cursor below the head would replay a resync gap the load already covers
 * straight back into another resync, which is a loop.
 */
export function gatewayCursorForDaemonCursor(
  walDir: string,
  sessionId: string,
  daemonCursor: number,
  daemonEpoch?: string,
): number {
  const head = getSharedWal(walDir, sessionId).latestId() ?? 0;
  const state = resolveEpochState(walDir, sessionId);
  let mapped = daemonCursor;
  if (state.lastOutId !== CONSERVATIVE_EPOCH.lastOutId) {
    const sameEpoch =
      daemonEpoch !== undefined && state.daemonEpoch !== undefined
        ? daemonEpoch === state.daemonEpoch
        : daemonCursor >= state.lastOutId;
    mapped = sameEpoch ? daemonCursor + state.epochOffset : head;
  }
  return Math.max(mapped, head);
}

function writeFrame(
  res: Response,
  ev: { id?: number; type?: string; data?: unknown },
): void {
  res.write(serializeFrame(ev));
}

/**
 * Write a synthetic `usage_tick` frame (no `id:` — it is gateway-injected, not a
 * daemon event, so it must never advance the client's Last-Event-ID cursor). A
 * single write; fired only on the coalescer's timer, never mid-daemon-frame.
 */
function writeUsageTick(res: Response, tick: UsageTick): void {
  res.write(`data: ${JSON.stringify({ type: 'usage_tick', data: tick })}\n\n`);
}

/**
 * Write a gateway-injected event (no `id:` line — synthetic frames must not
 * advance the Last-Event-ID cursor) to the SSE stream. Used to deliver events
 * such as `stream_error` with `{ code: "prompt_timeout" }` that originate from
 * the gateway rather than the daemon. Guards against writing after stream end.
 */
function writeGatewayEvent(
  res: Response,
  ev: { type: string; data: unknown },
): void {
  if (res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  } catch {
    // Socket already closed; ignore.
  }
}

/**
 * Write a synthetic `client_joined` frame (no `id:` line) as the very first
 * SSE frame on a newly attached stream. The client sees itself join. Synthetic:
 * must not advance the Last-Event-ID cursor.
 */
function writePresenceJoined(
  res: Response,
  tokenId: string | undefined,
  scopes: string[],
): void {
  res.write(
    `data: ${JSON.stringify({
      type: 'client_joined',
      data: {
        tokenId: tokenId ?? null,
        scopes,
        attachedAt: new Date().toISOString(),
      },
    })}\n\n`,
  );
}

/**
 * Write a synthetic `client_left` frame (no `id:` line) just before the stream
 * closes. Must be called BEFORE `res.end()` so the frame reaches the client.
 * Guards against writing to an already-ended response.
 */
function writePresenceLeft(
  res: Response,
  tokenId: string | undefined,
  reason: 'disconnect' | 'revoked' | 'evicted',
): void {
  if (res.writableEnded) return;
  try {
    res.write(
      `data: ${JSON.stringify({
        type: 'client_left',
        data: { tokenId: tokenId ?? null, reason },
      })}\n\n`,
    );
  } catch {
    // Socket already closed; ignore.
  }
}

/**
 * Gateway-side enrichment of a `permission_request` frame with `bridgeHints`
 * (add-bridge-protocol): whether the tool-call args are safe to inline into a
 * chat message. Computed here (not in the daemon — zero-edit) on the proxy path
 * so every subscriber, bridge or not, sees it; non-bridge clients ignore the
 * extra field. Other frame types pass through untouched. Returns a shallow copy
 * for permission_request so the daemon's parsed object isn't mutated.
 */
function enrich(ev: { id?: number; type?: string; data?: unknown }): unknown {
  if (ev.type !== 'permission_request') return ev;
  const data = (ev.data ?? {}) as Record<string, unknown>;
  const bridgeHints = computeBridgeHints(data['toolCall']);
  return { ...ev, data: { ...data, bridgeHints } };
}
