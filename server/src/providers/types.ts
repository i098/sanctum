/** Provider-neutral request shape shared by the model provider clients and `llm.ts`. */

export interface ProviderRequest {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  /** Cerebras `reasoning_effort`; `null` leaves the provider default. */
  readonly reasoning: 'none' | 'low' | 'medium' | 'high' | null;
  /** Strict JSON Schema output; absent means plain text. */
  readonly json?: { readonly name: string; readonly schema: Record<string, unknown> };
}

export interface ResearchSource {
  readonly url: string;
  readonly title: string | null;
}

export interface ResearchResult {
  readonly text: string;
  /** Cited web results, deduplicated by URL. */
  readonly sources: ReadonlyArray<ResearchSource>;
}

/** One provider's calls; `signal` aborts the underlying HTTP request. */
export interface ModelProvider {
  readonly complete: (request: ProviderRequest, signal: AbortSignal) => Promise<string>;
  readonly stream: (request: ProviderRequest, signal: AbortSignal) => AsyncIterable<string>;
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
