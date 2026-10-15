/** Cerebras strict chat completions (https://inference-docs.cerebras.ai/capabilities/structured-outputs), checked 2026-10-10. */
import { type ModelProvider, ProviderError, postJson } from './types.ts';

interface Completion {
  readonly choices?: ReadonlyArray<{ readonly finish_reason?: string | null; readonly message?: { readonly content?: string | null } }>;
}

/** Cerebras answers `429 queue_exceeded` under load; the queue drains in seconds, so such a retry waits this long when no Retry-After came. */
const QUEUE_BACKOFF_MS = 2_000;

/** The spoken classifier and extraction select Cerebras; no streaming or research client is needed. */
export const cerebras = (options: { readonly apiKey: string; readonly baseUrl?: string }): ModelProvider => ({
  complete: async (request, signal) => {
    const response = await postJson('Cerebras', `${options.baseUrl ?? 'https://api.cerebras.ai'}/v1/chat/completions`, options.apiKey, {
      model: request.model,
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }],
      max_completion_tokens: request.maxOutputTokens,
      ...(request.reasoning ? { reasoning_effort: request.reasoning } : {}),
      ...(request.json ? { response_format: { type: 'json_schema', json_schema: { name: request.json.name, strict: true, schema: request.json.schema } } } : {}),
    }, signal).catch((error: unknown) => {
      throw error instanceof ProviderError && error.retryAfterMs === undefined && error.message.includes('queue_exceeded')
        ? new ProviderError(error.message, true, QUEUE_BACKOFF_MS)
        : error;
    });
    const completion = await response.json() as Completion;
    const choice = completion.choices?.[0];
    if (choice?.finish_reason === 'length') throw new ProviderError('Cerebras output was truncated at max_completion_tokens', false);
    if (typeof choice?.message?.content !== 'string') throw new ProviderError('Cerebras response had no message content', false);
    return choice.message.content;
  },
});
