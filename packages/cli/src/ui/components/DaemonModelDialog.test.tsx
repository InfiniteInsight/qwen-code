/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { DaemonModelDialog } from './DaemonModelDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));
const mockedUseKeypress = vi.mocked(useKeypress);

const MODELS = [
  { modelId: 'flint(openai)', name: 'flint' },
  { modelId: 'qwen3-coder(openai)', name: 'qwen3-coder' },
];

describe('DaemonModelDialog', () => {
  beforeEach(() => {
    mockedUseKeypress.mockClear();
  });

  it('lists the daemon models and marks the current one', () => {
    const { lastFrame } = renderWithProviders(
      <DaemonModelDialog
        models={MODELS}
        currentModelId="flint(openai)"
        onSelect={vi.fn()}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('flint (flint(openai)) *');
    expect(frame).toContain('qwen3-coder (qwen3-coder(openai))');
    expect(frame).not.toContain('qwen3-coder(openai)) *');
  });

  it('says so when the daemon lists nothing', () => {
    const { lastFrame } = renderWithProviders(
      <DaemonModelDialog models={[]} onSelect={vi.fn()} />,
    );
    expect(lastFrame() ?? '').toContain('did not list any models');
  });

  it('cancels with undefined on Escape', () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <DaemonModelDialog models={MODELS} onSelect={onSelect} />,
    );
    // The list registers its own keypress handlers too; Escape reaches all.
    for (const [handler] of mockedUseKeypress.mock.calls) {
      handler({ name: 'escape' } as never);
    }
    expect(onSelect).toHaveBeenCalledWith(undefined);
  });
});
