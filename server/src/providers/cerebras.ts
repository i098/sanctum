/**
 * Cerebras chat completions over its documented HTTP API (https://inference-docs.cerebras.ai),
 * checked 2026-09-29: `POST /v1/chat/completions`, `reasoning_effort` (`none` disables Qwen
 * reasoning), strict `json_schema` response format, and SSE streaming ending in `[DONE]`.
 * API version 2 is pinned with `X-Cerebras-Version-Patch`.
 */
import { type ModelProvider, ProviderError, type ProviderRequest, retryableStatus, retryAfterMs } from './types.ts';

const DEFAULT_BASE_URL = 'https://api.cerebras.ai';

interface Completion {
  readonly choices?: ReadonlyArray<{ readonly finish_reason?: string | null; readonly message?: { readonly content?: string | null }; readonly delta?: { readonly content?: string | null } }>;
  readonly error?: { readonly message?: string };
}

const body = (request: ProviderRequest, stream: boolean) => ({
  model: request.model,
  messages: [
    { role: 'system', content: request.system },
    { role: 'user', content: request.prompt },
  ],
  max_completion_tokens: request.maxOutputTokens,
  stream,
  ...(request.reasoning ? { reasoning_effort: request.reasoning } : {}),
  ...(request.json ? { response_format: { type: 'json_schema', json_schema: { name: request.json.name, strict: true, schema: request.json.schema } } } : {}),
});

async function post(options: CerebrasOptions, payload: object, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl ?? DEFAULT_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json', 'x-cerebras-version-patch': '2' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ProviderError(`Cerebras request failed: ${String(error)}`, true);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new ProviderError(`Cerebras HTTP ${response.status}: ${detail}`, retryableStatus(response.status), retryAfterMs(response.headers.get('retry-after')));
  }
  return response;
}

/** `data:` payloads of a server-sent event stream. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffer = '';
  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    buffer = (buffer + text).replaceAll('\r\n', '\n');
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const data = buffer.slice(0, end).split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      buffer = buffer.slice(end + 2);
      if (data) yield data;
    }
  }
}

export interface CerebrasOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export const cerebras = (options: CerebrasOptions): ModelProvider => ({
  complete: async (request, signal) => {
    const completion = (await (await post(options, body(request, false), signal)).json()) as Completion;
    const choice = completion.choices?.[0];
    if (choice?.finish_reason === 'length') throw new ProviderError('Cerebras output was truncated at max_completion_tokens', false);
    if (typeof choice?.message?.content !== 'string') throw new ProviderError('Cerebras response had no message content', false);
    return choice.message.content;
  },
  stream: async function* (request, signal) {
    const response = await post(options, body(request, true), signal);
    for await (const data of sseData(response.body!)) {
      if (data === '[DONE]') return;
      const chunk = JSON.parse(data) as Completion;
      if (chunk.error) throw new ProviderError(`Cerebras stream error: ${chunk.error.message ?? 'unknown'}`, false);
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) yield text;
    }
    throw new ProviderError('Cerebras stream ended before [DONE]', false);
  },
});
