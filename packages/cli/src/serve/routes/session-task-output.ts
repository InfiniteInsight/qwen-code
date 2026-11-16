/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { openSyncNoFollow } from '@qwen-code/qwen-code-core/noFollowOpen';
import type {
  ServeSessionAgentMessage,
  ServeSessionAgentTaskStatus,
  ServeSessionTaskStatus,
  ServeSessionWorkflowTaskStatus,
} from '@qwen-code/acp-bridge/status';

export const DEFAULT_TASK_OUTPUT_MAX_BYTES = 65_536;
export const MAX_TASK_OUTPUT_MAX_BYTES = 262_144;

export type TaskOutputKind = 'agent' | 'shell' | 'monitor' | 'workflow';

export type TaskOutputUnavailableReason =
  | 'no_output_file'
  | 'missing_output_file'
  | 'unreadable_output_file';

export interface ServeSessionTaskOutputStatus {
  v: 1;
  sessionId: string;
  taskId: string;
  kind: TaskOutputKind;
  label: string;
  status: string;
  available: boolean;
  reason?: TaskOutputUnavailableReason;
  content: string;
  truncated: boolean;
  byteLength: number;
  totalBytes: number;
}

function isBidiControlChar(code: number): boolean {
  return (
    code === 0x061c ||
    (code >= 0x200e && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

export function stripTaskOutputControlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += text[i];
      continue;
    }
    if (code < 0x20) continue;
    if (code >= 0x80 && code <= 0x9f) continue;
    if (isBidiControlChar(code)) continue;
    out += text[i];
  }
  return out;
}

export function parseTaskOutputMaxBytes(
  raw: unknown,
): { ok: true; maxBytes: number } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, maxBytes: DEFAULT_TASK_OUTPUT_MAX_BYTES };
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return {
      ok: false,
      error: `\`maxBytes\` must be an integer between 1 and ${MAX_TASK_OUTPUT_MAX_BYTES}`,
    };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_TASK_OUTPUT_MAX_BYTES) {
    return {
      ok: false,
      error: `\`maxBytes\` must be an integer between 1 and ${MAX_TASK_OUTPUT_MAX_BYTES}`,
    };
  }
  return { ok: true, maxBytes: n };
}

export function parseTaskOutputKind(
  raw: unknown,
): { ok: true; kind: TaskOutputKind | undefined } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, kind: undefined };
  }
  if (
    raw === 'agent' ||
    raw === 'shell' ||
    raw === 'monitor' ||
    raw === 'workflow'
  ) {
    return { ok: true, kind: raw };
  }
  return {
    ok: false,
    error: '`kind` must be "agent", "shell", "monitor", or "workflow"',
  };
}

function truncateUtf8Tail(
  text: string,
  maxBytes: number,
): { content: string; truncated: boolean; byteLength: number; totalBytes: number } {
  const cleaned = stripTaskOutputControlChars(text);
  const buf = Buffer.from(cleaned, 'utf8');
  const totalBytes = buf.byteLength;
  if (totalBytes <= maxBytes) {
    return {
      content: cleaned,
      truncated: false,
      byteLength: totalBytes,
      totalBytes,
    };
  }
  const start = totalBytes - maxBytes;
  let offset = start;
  while (offset < totalBytes && (buf[offset]! & 0xc0) === 0x80) {
    offset++;
  }
  const slice = buf.subarray(offset, totalBytes);
  const content = slice.toString('utf8');
  return {
    content,
    truncated: true,
    byteLength: Buffer.byteLength(content, 'utf8'),
    totalBytes,
  };
}

function readRegisteredFileTail(
  filePath: string,
  maxBytes: number,
):
  | {
      available: true;
      content: string;
      truncated: boolean;
      byteLength: number;
      totalBytes: number;
    }
  | {
      available: false;
      reason: TaskOutputUnavailableReason;
    } {
  let fd: number | undefined;
  try {
    fd = openSyncNoFollow(filePath);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return { available: false, reason: 'unreadable_output_file' };
    }
    const totalBytes = stat.size;
    if (totalBytes <= 0) {
      return {
        available: true,
        content: '',
        truncated: false,
        byteLength: 0,
        totalBytes: 0,
      };
    }
    const length = Math.min(totalBytes, maxBytes);
    const start = totalBytes - length;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    let sliceOffset = 0;
    if (start > 0) {
      while (
        sliceOffset < bytesRead &&
        (buffer[sliceOffset]! & 0xc0) === 0x80
      ) {
        sliceOffset++;
      }
    }
    const content = stripTaskOutputControlChars(
      buffer.subarray(sliceOffset, bytesRead).toString('utf8'),
    );
    return {
      available: true,
      content,
      truncated: start > 0,
      byteLength: Buffer.byteLength(content, 'utf8'),
      totalBytes,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return { available: false, reason: 'missing_output_file' };
    }
    return { available: false, reason: 'unreadable_output_file' };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

function formatAgentMessages(messages: readonly ServeSessionAgentMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const tag =
      msg.role === 'assistant' && msg.thought
        ? 'thinking'
        : msg.role === 'tool_call'
          ? `tool ${msg.toolName || 'call'}`
          : msg.role === 'tool_result'
            ? `result ${msg.toolName || ''}`.trim()
            : msg.role;
    const body = (msg.content || msg.description || '').trim();
    if (!body) continue;
    lines.push(`[${tag}] ${body}`);
  }
  return lines.join('\n\n');
}

function readAgentTaskOutput(
  sessionId: string,
  task: ServeSessionAgentTaskStatus,
  maxBytes: number,
): ServeSessionTaskOutputStatus {
  const base = {
    v: 1 as const,
    sessionId,
    taskId: task.id,
    kind: 'agent' as const,
    label: task.label || task.id,
    status: task.status,
  };
  const messages = task.messages;
  if (messages && messages.length > 0) {
    const tail = truncateUtf8Tail(formatAgentMessages(messages), maxBytes);
    return { ...base, available: true, ...tail };
  }
  if (task.latestText || task.latestThought) {
    const parts: string[] = [];
    if (task.latestThought) parts.push(`[thinking] ${task.latestThought}`);
    if (task.latestText) parts.push(`[assistant] ${task.latestText}`);
    const tail = truncateUtf8Tail(parts.join('\n\n'), maxBytes);
    return { ...base, available: true, ...tail };
  }
  if (!task.outputFile) {
    return {
      ...base,
      available: false,
      reason: 'no_output_file',
      content: '',
      truncated: false,
      byteLength: 0,
      totalBytes: 0,
    };
  }
  const fileTail = readRegisteredFileTail(task.outputFile, maxBytes);
  if (!fileTail.available) {
    return {
      ...base,
      available: false,
      reason: fileTail.reason,
      content: '',
      truncated: false,
      byteLength: 0,
      totalBytes: 0,
    };
  }
  return { ...base, ...fileTail };
}

export function buildSessionTaskOutputStatus(
  sessionId: string,
  task: ServeSessionTaskStatus | ServeSessionWorkflowTaskStatus,
  maxBytes: number,
): ServeSessionTaskOutputStatus {
  const base = {
    v: 1 as const,
    sessionId,
    taskId: task.id,
    kind: task.kind,
    label: task.label || task.id,
    status: task.status,
  };
  if (task.kind === 'monitor') {
    return {
      ...base,
      available: false,
      reason: 'no_output_file',
      content: '',
      truncated: false,
      byteLength: 0,
      totalBytes: 0,
    };
  }
  if (task.kind === 'agent') {
    return readAgentTaskOutput(sessionId, task, maxBytes);
  }
  if (task.kind === 'workflow') {
    if (task.outputFile) {
      const fileTail = readRegisteredFileTail(task.outputFile, maxBytes);
      if (fileTail.available) {
        return { ...base, ...fileTail };
      }
      if (Array.isArray(task.recentLogs) && task.recentLogs.length > 0) {
        const tail = truncateUtf8Tail(task.recentLogs.join('\n'), maxBytes);
        return { ...base, available: true, ...tail };
      }
      return {
        ...base,
        available: false,
        reason: fileTail.reason,
        content: '',
        truncated: false,
        byteLength: 0,
        totalBytes: 0,
      };
    }
    if (Array.isArray(task.recentLogs) && task.recentLogs.length > 0) {
      const tail = truncateUtf8Tail(task.recentLogs.join('\n'), maxBytes);
      return { ...base, available: true, ...tail };
    }
    return {
      ...base,
      available: false,
      reason: 'no_output_file',
      content: '',
      truncated: false,
      byteLength: 0,
      totalBytes: 0,
    };
  }
  // shell
  if (!task.outputFile) {
    return {
      ...base,
      available: false,
      reason: 'no_output_file',
      content: '',
      truncated: false,
      byteLength: 0,
      totalBytes: 0,
    };
  }
  const fileTail = readRegisteredFileTail(task.outputFile, maxBytes);
  if (!fileTail.available) {
    return {
      ...base,
      available: false,
      reason: fileTail.reason,
      content: '',
      truncated: false,
      byteLength: 0,
      totalBytes: 0,
    };
  }
  return { ...base, ...fileTail };
}
