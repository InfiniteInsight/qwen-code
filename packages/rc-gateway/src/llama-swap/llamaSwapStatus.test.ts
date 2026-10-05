import { describe, it, expect, vi } from 'vitest';
import { probeLlamaSwapStatus } from './llamaSwapStatus';

describe('probeLlamaSwapStatus', () => {
  it('parses a successful /v1/models response', async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'qwen-32b', aliases: ['q32'], status: { value: 'loaded' } },
            { id: 'qwen-7b', aliases: [], status: { value: 'unloaded' } },
          ],
        }),
        { status: 200 },
      );
    const result = await probeLlamaSwapStatus('http://x', fakeFetch);
    expect(result).toEqual({
      available: true,
      models: [
        { id: 'qwen-32b', aliases: ['q32'], loaded: true },
        { id: 'qwen-7b', aliases: [], loaded: false },
      ],
    });
  });

  it('resolves available: false when the fetch rejects', async () => {
    const fakeFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await probeLlamaSwapStatus('http://x', fakeFetch);
    expect(result).toEqual({ available: false, models: [] });
  });

  it('resolves available: false on a non-200 response', async () => {
    const fakeFetch = async () => new Response('', { status: 500 });
    const result = await probeLlamaSwapStatus('http://x', fakeFetch);
    expect(result).toEqual({ available: false, models: [] });
  });

  it('resolves available: false on malformed JSON', async () => {
    const fakeFetch = async () => new Response('not json', { status: 200 });
    const result = await probeLlamaSwapStatus('http://x', fakeFetch);
    expect(result).toEqual({ available: false, models: [] });
  });

  it('resolves available: false when data entries are missing/malformed', async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ data: 'not-an-array' }), { status: 200 });
    const result = await probeLlamaSwapStatus('http://x', fakeFetch);
    expect(result).toEqual({ available: false, models: [] });
  });

  it('resolves available: false when the connection hangs past the timeout', async () => {
    // AbortSignal.timeout(5000) is implemented natively (not via JS
    // setTimeout), so vi.useFakeTimers() can't fast-forward it. Instead,
    // stub AbortSignal.timeout itself to return a controller we fire
    // immediately, proving probeLlamaSwapStatus wires the signal into the
    // fetch call and handles the resulting abort — without a real 5s wait.
    const controller = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms: number) => {
        expect(ms).toBe(5000);
        return controller.signal;
      });

    try {
      // Never resolves on its own; only rejects once the signal passed in
      // by probeLlamaSwapStatus fires.
      const hangingFetch = (
        _url: string,
        opts?: { signal?: AbortSignal },
      ): Promise<Response> =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });

      const resultPromise = probeLlamaSwapStatus(
        'http://x',
        hangingFetch as unknown as typeof fetch,
      );

      // Simulate the timeout firing, instead of waiting 5 real seconds.
      controller.abort();

      const result = await resultPromise;
      expect(result).toEqual({ available: false, models: [] });
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
