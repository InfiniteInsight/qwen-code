/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Code-fence state for streamed agent markdown, shared by the Discord and
 * Matrix stream routers (#168). The routers flush a turn in pieces (paragraph
 * break, size cap, idle timer); each piece is a separate chat message, so a
 * piece that ends inside a ``` block has to close it and the NEXT piece has to
 * reopen it with the same language. Before, the second half never reopened:
 * its closing ``` was read as an opener, and prose and code swapped from there
 * on (Discord) or rendered as literal backticks (Matrix).
 *
 * Fences are line-oriented: a line whose trimmed form starts with ``` toggles
 * the state; the opener's language tag is the rest of that line.
 */

export const FENCE = '```';

/** Whether text is inside a fenced block, and the open block's language. */
export interface FenceState {
  inFence: boolean;
  lang: string;
}

/** Outside any fence (the start of a turn). */
export const NO_FENCE: FenceState = Object.freeze({ inFence: false, lang: '' });

/** A line that toggles fenced-code state, plus the opener's language tag. */
export function fenceToggle(line: string): { toggle: boolean; lang: string } {
  const t = line.trimStart();
  if (!t.startsWith(FENCE)) return { toggle: false, lang: '' };
  return { toggle: true, lang: t.slice(FENCE.length).trim() };
}

/** The fence state after `text`, given the state it starts in. */
export function fenceStateAfter(
  text: string,
  start: FenceState = NO_FENCE,
): FenceState {
  let { inFence, lang } = start;
  for (const line of text.split('\n')) {
    const t = fenceToggle(line);
    if (!t.toggle) continue;
    lang = inFence ? '' : t.lang;
    inFence = !inFence;
  }
  return { inFence, lang };
}

/**
 * Whether buffered text has reached a natural flush point: it ends OUTSIDE a
 * fence and either closed a block or holds a paragraph break. Inside an open
 * fence a blank line is code, not a paragraph, so it does not flush (that cut
 * every block with a blank line in it across messages).
 */
export function atFlushPoint(
  text: string,
  start: FenceState = NO_FENCE,
): boolean {
  let inFence = start.inFence;
  let toggles = 0;
  for (const line of text.split('\n')) {
    if (!fenceToggle(line).toggle) continue;
    inFence = !inFence;
    toggles++;
  }
  if (inFence) return false;
  return toggles > 0 || text.includes('\n\n');
}

/**
 * When a flush starts inside a carried block and its first line is that
 * block's closing fence, drop the line and start outside: the previous message
 * already closed the block, so reopening it here would only render an empty
 * one.
 */
export function skipCarriedClose(
  text: string,
  start: FenceState,
): { text: string; start: FenceState } {
  if (!start.inFence) return { text, start };
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  if (!fenceToggle(first).toggle) return { text, start };
  return { text: nl < 0 ? '' : text.slice(nl + 1), start: NO_FENCE };
}

/**
 * One flush made self-contained for a chat that renders each message on its
 * own (Matrix): reopen a carried block at the top, close one left open at the
 * bottom. Discord's splitter does the same per message it cuts.
 */
export function balanceFences(text: string, start: FenceState): string {
  const s = skipCarriedClose(text, start);
  if (s.text === '') return '';
  const end = fenceStateAfter(s.text, s.start);
  const head = s.start.inFence ? `${FENCE}${s.start.lang}\n` : '';
  const tail = end.inFence ? `\n${FENCE}` : '';
  return `${head}${s.text}${tail}`;
}
