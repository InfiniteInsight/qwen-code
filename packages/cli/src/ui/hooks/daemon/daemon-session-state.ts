/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Readers for the ACP state a daemon `session/load` returns
 * (`DaemonSessionClient.state`). The state is opaque across the SDK boundary
 * (`models` and `modes` are typed `unknown`), so these read defensively, the
 * same way the web shell's `parseContext` does: a missing or malformed field
 * yields "unknown", never a throw.
 *
 * Shapes (verified against a live daemon):
 * - `models: { currentModelId, availableModels: [{ modelId, name, description? }] }`
 * - `modes:  { currentModeId,  availableModes:  [{ id, name, description? }] }`
 */

export interface DaemonSessionStateLike {
  models?: unknown;
  modes?: unknown;
}

/**
 * What the slash-command layer and the pickers need from an attached daemon
 * session: its load state (current choice and the options) and the two routes
 * that change it. An attached `DaemonSessionClient` satisfies it structurally.
 * Each route is optional so an older client or a test double can lack one; the
 * callers say so rather than falling back to the tab's own Config, which is not
 * what the session runs on.
 */
export interface DaemonSessionControl {
  readonly state?: DaemonSessionStateLike;
  /** `POST /session/:id/model`; the daemon answers with `model_switched`. */
  setModel?(modelId: string): Promise<unknown>;
  /** `POST /session/:id/approval-mode`; answers with `approval_mode_changed`. */
  setApprovalMode?(mode: string): Promise<unknown>;
}

export interface DaemonModelOption {
  modelId: string;
  name: string;
  description?: string;
}

export interface DaemonModeOption {
  id: string;
  name: string;
  description?: string;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

export function readDaemonModels(
  state: DaemonSessionStateLike | null | undefined,
): {
  currentModelId: string | undefined;
  availableModels: DaemonModelOption[];
} {
  const models = asRecord(asRecord(state)['models']);
  const raw = models['availableModels'];
  const availableModels: DaemonModelOption[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const e = asRecord(entry);
      const modelId = str(e['modelId']);
      if (!modelId) continue;
      const description = str(e['description']);
      availableModels.push({
        modelId,
        name: str(e['name']) ?? modelId,
        ...(description ? { description } : {}),
      });
    }
  }
  return { currentModelId: str(models['currentModelId']), availableModels };
}

export function readDaemonModes(
  state: DaemonSessionStateLike | null | undefined,
): {
  currentModeId: string | undefined;
  availableModes: DaemonModeOption[];
} {
  const modes = asRecord(asRecord(state)['modes']);
  const raw = modes['availableModes'];
  const availableModes: DaemonModeOption[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const e = asRecord(entry);
      const id = str(e['id']);
      if (!id) continue;
      const description = str(e['description']);
      availableModes.push({
        id,
        name: str(e['name']) ?? id,
        ...(description ? { description } : {}),
      });
    }
  }
  return { currentModeId: str(modes['currentModeId']), availableModes };
}

export type DaemonModelResolution =
  | { kind: 'ok'; modelId: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'unknown' };

/**
 * Resolve what a user typed after `/model` against the daemon's list: an exact
 * `modelId` first (`flint(openai)`), else a bare name that identifies exactly
 * one entry (`flint`).
 */
export function resolveDaemonModelArg(
  available: readonly DaemonModelOption[],
  arg: string,
): DaemonModelResolution {
  const wanted = arg.trim();
  const exact = available.find((m) => m.modelId === wanted);
  if (exact) return { kind: 'ok', modelId: exact.modelId };
  const byName = available.filter(
    (m) => m.name === wanted || m.modelId.split('(', 1)[0] === wanted,
  );
  if (byName.length === 1) return { kind: 'ok', modelId: byName[0]!.modelId };
  if (byName.length > 1) {
    return { kind: 'ambiguous', matches: byName.map((m) => m.modelId) };
  }
  return { kind: 'unknown' };
}
