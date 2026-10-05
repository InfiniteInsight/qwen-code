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
    const body = (await res.json()) as { data?: unknown } | null;
    if (!body || !Array.isArray(body.data)) {
      return { available: false, models: [] };
    }
    const models = (body.data as unknown[])
      .filter(
        (m: unknown) => m && typeof (m as { id?: unknown }).id === 'string',
      )
      .map((m: unknown) => {
        const model = m as {
          id: string;
          aliases?: unknown;
          status?: { value?: unknown };
        };
        return {
          id: model.id,
          aliases: Array.isArray(model.aliases)
            ? model.aliases.filter((a) => typeof a === 'string')
            : [],
          loaded: model.status?.value === 'loaded',
        };
      });
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}
