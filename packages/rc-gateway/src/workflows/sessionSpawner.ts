/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentSpawner,
  AgentSpawnRequest,
  AgentSpawnResult,
} from '@qwen-code/qwen-code-core';
import { validateAgainstSchema } from '@qwen-code/qwen-code-core';
import type { AgentRegistry, AgentStatus } from '../agents/agentRegistry.js';
import type { SessionDaemon } from '../daemonPool.js';
import { extractAgentText } from '../bridges/sessionUpdateText.js';
import { extractUsage } from '../cost/ingester.js';

const SCHEMA_RETRIES = 2;

/**
 * How long to keep reading the event stream after `prompt()` has already
 * settled, waiting for its end-of-turn frame. A daemon that ends a turn without
 * ever putting `turn_complete` on the stream must not hang the workflow, so the
 * text collected by then is what gets returned.
 */
const TURN_DRAIN_GRACE_MS = 2_000;

export interface SessionSpawnerDeps {
  daemon: SessionDaemon;
  registry: AgentRegistry;
  runId: string;
  spawnedByTokenId: string;
  /** Called with (agentId, sessionId) as each workflow agent is registered. */
  onAgentSpawned?: (agentId: string, sessionId: string) => void;
}

/** Resolve `p`, or `fallback` if it has not settled within `ms`. Never rejects. */
function settleWithin<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Read one turn's reply off the session's own event stream.
 *
 * `prompt()` answers with `{ stopReason }` and nothing else. The SDK's
 * `PromptResult` has no text field, and its `[key: string]: unknown` index
 * signature is precisely what let the previous `extractText(turn)` compile while
 * returning '' on every real turn; `turn_complete` carries no text either. The
 * assistant's prose exists only as `agent_message_chunk` updates, the same
 * frames the chat surface renders, so a caller that never read the stream saw an
 * empty reply and any agent with a schema failed validation against that empty
 * string.
 *
 * Started BEFORE the prompt is sent, because the chunks arrive during the turn.
 */
function startTurnCollector(daemon: SessionDaemon, sessionId: string) {
  const collected = { text: '', tokens: 0 };
  const abort = new AbortController();
  const settled = (async () => {
    try {
      for await (const ev of daemon.subscribeEvents(sessionId, {
        signal: abort.signal,
      })) {
        if (ev.type === 'session_update') {
          collected.text += extractAgentText(ev.data);
          // The ingester's single locus, for the reason it states there: taking
          // usage off every frame that happens to carry it double-charges a turn.
          const usage = extractUsage(ev.data);
          if (usage !== null) {
            collected.tokens += usage.tokensIn + usage.tokensOut;
          }
        } else if (ev.type === 'turn_complete' || ev.type === 'turn_error') {
          break;
        }
      }
    } catch {
      // A dropped stream is not a failed turn. `prompt()`'s own result decides
      // whether the turn worked, and whatever text did arrive is still the best
      // reading of the reply that exists.
    }
  })();
  return {
    collected,
    settled,
    stop: (): void => {
      abort.abort();
    },
  };
}

/**
 * Gateway spawner (design: "SessionSpawner"). Each workflow agent IS a real
 * daemon session — observable, cost-tracked, searchable — tagged with the
 * workflow's runId on its AgentRecord. On abort (workflow cancel) the session
 * is ended.
 */
export class SessionSpawner implements AgentSpawner {
  constructor(private readonly deps: SessionSpawnerDeps) {}

  async spawn(req: AgentSpawnRequest): Promise<AgentSpawnResult> {
    // Cancel handling is wired up before the first await. It used to be attached
    // only after BOTH createOrAttachSession and register had resolved, so a
    // cancel landing in either window closed nothing at all and the session ran
    // on with nobody watching it.
    let sessionId: string | undefined;
    let agentId: string | undefined;
    let sessionClosed = false;
    // A signal that already fired never invokes the listener, so read it here.
    const cancelled = { value: req.signal?.aborted === true };
    const closeSession = (): void => {
      if (sessionId === undefined || sessionClosed) return;
      sessionClosed = true;
      void this.deps.daemon.closeSession(sessionId).catch(() => {});
    };
    const onAbort = (): void => {
      cancelled.value = true;
      closeSession();
    };
    if (cancelled.value) {
      throw new Error('workflow cancelled before the session was created');
    }
    req.signal?.addEventListener('abort', onAbort, { once: true });

    // Best effort. A registry write must never mask the spawn's own outcome; a
    // record left non-terminal is caught by startup reconciliation instead.
    const settle = async (status: AgentStatus): Promise<void> => {
      if (agentId === undefined) return;
      try {
        await this.deps.registry.setStatus(agentId, status);
      } catch {
        // Ignored on purpose, for the reason above.
      }
    };

    try {
      const session = await this.deps.daemon.createOrAttachSession({
        sessionScope: 'thread',
        ...(req.model !== undefined ? { modelServiceId: req.model } : {}),
        ...(req.cwd ? { workspaceCwd: req.cwd } : {}),
      });
      // No mid-create cancel branch here on purpose. The handler fires with no
      // id to close yet, but `sessionId` is assigned the moment the create
      // resolves and the finally below closes unconditionally, so the window is
      // covered by that one path rather than a second copy of the same call.
      sessionId = session.sessionId;
      const record = await this.deps.registry.register({
        sessionId,
        parentSessionId: null,
        agentType: req.agentType ?? 'general',
        task: req.prompt,
        spawnedByTokenId: this.deps.spawnedByTokenId,
        workflowRunId: this.deps.runId,
      });
      agentId = record.agentId;
      this.deps.onAgentSpawned?.(record.agentId, sessionId);

      let tokens = 0;
      const attempts = req.schema ? SCHEMA_RETRIES + 1 : 1;
      let promptText = req.schema
        ? `${req.prompt}\n\nReply with ONLY JSON conforming to:\n${JSON.stringify(req.schema)}`
        : req.prompt;
      // No system-prompt field exists on CreateSessionRequest/PromptRequest,
      // so fold systemContext into the prompt text itself, mirroring how
      // HeadlessSpawner combines systemContext with the task (spawner.ts).
      promptText = req.systemContext
        ? `${req.systemContext}\n\n${promptText}`
        : promptText;
      let lastError = '';
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (cancelled.value) throw new Error('workflow cancelled');
        // Subscribed BEFORE the send. The reply exists only as frames that
        // arrive during the turn, so a reader opened after prompt() settles
        // would see none of them.
        const collector = startTurnCollector(this.deps.daemon, sessionId);
        try {
          await this.deps.daemon.prompt(
            sessionId,
            {
              prompt: [{ type: 'text', text: promptText }],
            },
            req.signal,
          );
        } catch (err) {
          // The turn failed, so there is nothing left to read. Do not make the
          // caller wait out a drain grace that can never be satisfied.
          collector.stop();
          throw err;
        }
        await settleWithin(collector.settled, TURN_DRAIN_GRACE_MS, undefined);
        collector.stop();
        tokens += collector.collected.tokens;
        const text = collector.collected.text;
        if (!req.schema) {
          await settle('completed');
          return { text, tokens };
        }
        const check = validateAgainstSchema(text, req.schema);
        if (check.valid) {
          await settle('completed');
          return { structured: check.value, tokens };
        }
        lastError = check.error;
        promptText = `Your reply was invalid (${lastError}). Return corrected JSON only.`;
      }
      throw new Error(
        `schema validation failed after ${attempts} attempts: ${lastError}`,
      );
    } catch (err) {
      await settle(cancelled.value ? 'cancelled' : 'failed');
      throw err;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
      // Every path, not just cancel: a workflow that ran fifty agents to
      // completion used to leave all fifty sessions attached.
      closeSession();
    }
  }
}
