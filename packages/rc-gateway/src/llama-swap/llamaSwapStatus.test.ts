import { describe, it, expect } from 'vitest';
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
});
