export interface LlamaSwapModelStatus {
  id: string;
  aliases: string[];
  loaded: boolean;
}

export interface LlamaSwapStatusResponse {
  available: boolean;
  models: LlamaSwapModelStatus[];
}

export async function probeLlamaSwapStatus(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LlamaSwapStatusResponse> {
  try {
    const res = await fetchImpl(`${baseUrl}/v1/models`);
    if (!res.ok) return { available: false, models: [] };
    const body = await res.json();
    if (!body || !Array.isArray(body.data)) {
      return { available: false, models: [] };
    }
    const models = body.data
      .filter(
        (m: unknown) => m && typeof (m as { id?: unknown }).id === 'string',
      )
      .map(
        (m: {
          id: string;
          aliases?: unknown;
          status?: { value?: unknown };
        }) => ({
          id: m.id,
          aliases: Array.isArray(m.aliases)
            ? m.aliases.filter((a) => typeof a === 'string')
            : [],
          loaded: m.status?.value === 'loaded',
        }),
      );
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}
