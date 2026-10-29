/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createInterface } from 'node:readline';

export interface PromptIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Ask one question and resolve the line typed. `readline`'s `question` callback
 * never fires when the input ends first, so a prompt under cron or `< /dev/null`
 * used to leave the promise pending and let the process exit 0 having done
 * nothing. EOF with no answer now rejects, and the caller's error path exits
 * nonzero with the message below.
 */
export function askLine(
  question: string,
  io: PromptIo = { input: process.stdin, output: process.stdout },
): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output });
  return new Promise<string>((resolve, reject) => {
    let answered = false;
    rl.once('close', () => {
      if (!answered) {
        reject(
          new Error(
            'no answer: stdin closed before a response (pass --yes to skip the prompt)',
          ),
        );
      }
    });
    rl.question(question, (answer) => {
      answered = true;
      resolve(answer);
      rl.close();
    });
  });
}

/** y/N confirmation on stdin; rejects on EOF (see {@link askLine}). */
export async function confirmPrompt(
  question: string,
  io?: PromptIo,
): Promise<boolean> {
  return /^y(es)?$/i.test((await askLine(question, io)).trim());
}
