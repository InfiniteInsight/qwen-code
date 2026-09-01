/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { PromptContentBlock } from '@qwen-code/sdk';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { PromptQueue, QueueTimeoutError } from './promptQueue.js';
import type { PromptEventBroadcaster } from './promptEventBroadcaster.js';

/**
 * POST /session/:id/prompt — proxy the SDK's daemon.prompt(). Accepts either
 * `{ prompt: string }` (turned into a single text block) or
 * `{ blocks: PromptContentBlock[] }` (forwarded verbatim). Long-lived: awaits
 * the daemon's turn and returns its stopReason. A client disconnect does NOT
 * abort the daemon prompt (#38): mobile clients get backgrounded routinely
 * (screen off, app switch) and the OS kills their sockets, but the turn must
 * keep running in the daemon — its events keep landing in the per-session
 * event bus ring, so when the client returns it resumes + watches from the
 * event watermark and the live turn streams to completion. When the client is
 * gone the 200 response is simply skipped; the audit record is written
 * regardless. The prompt-execution timeout below remains the only
 * cancellation. The prompt text is NEVER audited.
 *
 * Session FIFO + timeouts (spec "Per-session FIFO preserved"):
 *  - Each session has a single-slot queue (`PromptQueue`). A prompt that
 *    cannot acquire the slot within `queueWaitMs` receives 503 `queue_timeout`.
 *  - Once executing, if the daemon call does not complete within `promptTimeoutMs`
 *    the turn is cancelled via AbortController, a synthetic `stream_error` event
 *    with `{ code: "prompt_timeout" }` is broadcast to all SSE subscribers via
 *    the `PromptEventBroadcaster`, and the queue slot is released.
 */
/** Records the originator of a session's turn, for cost attribution. */
export type PromptAcceptedHook = (
  sessionId: string,
  attribution: { attributionTokenId: string; subActor: string | null },
) => void;

/** Shared singleton queue (module-level so all route instances share state). */
const sharedQueue = new PromptQueue();

export interface PromptRouteOptions {
  /** ms to wait for the per-session slot before returning 503 (default: 120_000). */
  queueWaitMs?: number;
  /** ms budget for the daemon turn before it is cancelled (default: 600_000). */
  promptTimeoutMs?: number;
  /**
   * Broadcaster for gateway-injected SSE events (e.g. `stream_error` on prompt
   * timeout). When omitted, timeout cancellation still happens but no synthetic
   * event is emitted to SSE subscribers.
   */
  promptEventBroadcaster?: PromptEventBroadcaster;
  /**
   * Override the shared PromptQueue (for tests that need isolated queues).
   */
  queue?: PromptQueue;
  /**
   * Fired exactly once at the turn's terminal point — success, timeout, or
   * daemon error — with the outcome (#40). server.ts wires it to the push
   * notifier so a backgrounded client hears that the turn ended. Must be
   * sync-safe and never throw: it is called with the queue slot still held.
   */
  onTurnEnd?: (
    sessionId: string,
    outcome:
      | { ok: true; stopReason: string }
      | { ok: false; reason: 'timeout' | 'error' },
  ) => void;
}

export function createPromptRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  onAccepted?: PromptAcceptedHook,
  opts: PromptRouteOptions = {},
): RequestHandler {
  const queueWaitMs = opts.queueWaitMs ?? 120_000;
  const promptTimeoutMs = opts.promptTimeoutMs ?? 600_000;
  const broadcaster = opts.promptEventBroadcaster;
  const queue = opts.queue ?? sharedQueue;

  return async (req, res) => {
    const sessionId = req.params.id;
    const body = (req.body ?? {}) as { prompt?: unknown; blocks?: unknown };

    let blocks: PromptContentBlock[];
    if (typeof body.prompt === 'string' && body.prompt.length > 0) {
      blocks = [{ type: 'text', text: body.prompt }];
    } else if (Array.isArray(body.blocks) && body.blocks.length > 0) {
      blocks = body.blocks as PromptContentBlock[];
    } else {
      res.status(400).json({ error: 'Invalid prompt', code: 'invalid_prompt' });
      return;
    }

    // ── Queue-wait: acquire the per-session FIFO slot ────────────────────────
    let release: (() => void) | undefined;
    try {
      release = await queue.acquire(sessionId, queueWaitMs);
    } catch (err) {
      if (err instanceof QueueTimeoutError) {
        res.status(503).json({ error: 'queue_timeout', code: 'queue_timeout' });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    // ── We hold the slot — run the daemon turn ───────────────────────────────
    try {
      // Capture attribution BEFORE the turn: the usage events the ingester
      // prices arrive WHILE daemon.prompt() is awaited, so the session→(tokenId,
      // subActor) mapping must be set first.
      if (onAccepted && req.rcClient?.id) {
        onAccepted(sessionId, {
          attributionTokenId: req.rcClient.id,
          subActor: req.rcClient.subActor ?? null,
        });
      }

      // Prompt-execution timeout: cancel the daemon turn if it takes too long.
      // This is the ONLY abort signal passed to the daemon — a client
      // disconnect deliberately does NOT cancel the turn (see the module doc
      // above, #38): the route keeps awaiting daemon.prompt() after the
      // response closes, and the queue slot below is held until the turn
      // actually completes, so a backgrounded mobile client's turn survives.
      const timeoutAbort = new AbortController();
      const promptTimer = setTimeout(() => {
        timeoutAbort.abort();
      }, promptTimeoutMs);

      let result;
      let timedOut = false;
      try {
        result = await daemon.prompt(
          sessionId,
          { prompt: blocks },
          timeoutAbort.signal,
        );
      } catch {
        if (timeoutAbort.signal.aborted) {
          timedOut = true;
        } else {
          // Daemon error unrelated to the timeout. Respond only if the client
          // is still connected; the slot is released in the finally below.
          if (!res.closed) {
            res.status(502).json({
              error: 'Daemon unavailable',
              code: 'daemon_unavailable',
            });
          }
          // #40: the turn ended in failure — a backgrounded client should
          // still hear about it (fires even when the client is gone).
          opts.onTurnEnd?.(sessionId, { ok: false, reason: 'error' });
          return;
        }
      } finally {
        clearTimeout(promptTimer);
      }

      if (timedOut) {
        // Broadcast a synthetic stream_error to all SSE subscribers so they
        // know the turn was cancelled by the gateway.
        broadcaster?.emit(sessionId, {
          type: 'stream_error',
          data: { code: 'prompt_timeout' },
        });
        // #40: the turn ended in failure (gateway timeout).
        opts.onTurnEnd?.(sessionId, { ok: false, reason: 'timeout' });
        if (!res.closed) {
          res
            .status(504)
            .json({ error: 'prompt_timeout', code: 'prompt_timeout' });
        }
        return;
      }

      // The turn completed. The audit record reflects the daemon's work, so
      // it is written even when the client disconnected mid-turn; only the
      // HTTP response is skipped in that case.
      void audit?.record({
        action: 'prompt_sent',
        actorTokenId: req.rcClient?.id,
        subActor: req.rcClient?.subActor,
        target: sessionId,
        detail: { stopReason: result!.stopReason, blocks: blocks.length },
      });

      // #40: the turn completed — notify backgrounded clients (the push is
      // suppressed in the notifier when the session is live-watched).
      opts.onTurnEnd?.(sessionId, {
        ok: true,
        stopReason:
          typeof result!.stopReason === 'string' ? result!.stopReason : '',
      });

      if (!res.closed) {
        res.status(200).json({ stopReason: result!.stopReason });
      }
    } finally {
      // Always release the queue slot, even on timeout or error.
      release();
    }
  };
}
