/** Provider-neutral request shape shared by the model provider clients and `llm.ts`. */

export interface ProviderRequest {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  /** Reasoning effort; `none` disables reasoning and `null` leaves the provider default. */
  readonly reasoning: 'none' | 'low' | 'medium' | 'high' | null;
  /** Strict JSON Schema output; absent means plain text. */
  readonly json?: { readonly name: string; readonly schema: Record<string, unknown> };
}

export interface ResearchSource {
  readonly url: string;
  readonly title: string | null;
}

/** What one research call consumed, as the provider reported it; null when it reported nothing. */
export interface ResearchUsage {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly web_searches: number;
}

export interface ResearchResult {
  readonly text: string;
  /** Cited web results, deduplicated by URL. */
  readonly sources: ReadonlyArray<ResearchSource>;
  readonly usage: ResearchUsage;
}

/** One provider's calls; `signal` aborts the underlying HTTP request. A research-only provider has no text calls. */
export interface ModelProvider {
  readonly complete?: (request: ProviderRequest, signal: AbortSignal) => Promise<string>;
  readonly stream?: (request: ProviderRequest, signal: AbortSignal) => AsyncIterable<string>;
  /** Hosted web search with continuation handling; only providers that host search implement it. */
  readonly research?: (request: ProviderRequest, budget: { maxSearches: number; maxContinuations: number }, signal: AbortSignal) => Promise<ResearchResult>;
}

/** Transport, HTTP or response-shape failure; `retryable` only when repeating the request can help. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Timeout, lock conflict, rate limit and server errors are transient (provider SDK retry policy). */
export const retryableStatus = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;

/** `Retry-After` in seconds, when the provider sends one. */
export function retryAfterMs(value: string | null | undefined): number | undefined {
  const seconds = Number(value);
  return value && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/** POSTs JSON with a Bearer token: a transport failure is retryable, an HTTP error carries the status retry policy, a caller abort is rethrown. */
export async function postJson(provider: string, url: string, token: string, payload: object, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ProviderError(`${provider} request failed: ${String(error)}`, true);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new ProviderError(`${provider} HTTP ${response.status}: ${detail}`, retryableStatus(response.status), retryAfterMs(response.headers.get('retry-after')));
  }
  return response;
}
