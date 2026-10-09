/**
 * Cloudflare Workers AI chat completions through its OpenAI-compatible endpoint, checked
 * 2026-10-08 (https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/):
 * `POST <base>/v1/chat/completions` with a Bearer API token, strict `json_schema` response format
 * (https://developers.cloudflare.com/workers-ai/features/json-mode/; the model input schema of
 * `@cf/qwen/qwen3.8-27b` lists `response_format`), and SSE streaming ending in `[DONE]`.
 * Qwen 3.8 takes `reasoning_effort` `low`/`medium`/`xhigh`; `chat_template_kwargs.enable_thinking`
 * `false` disables reasoning.
 */
import { type ModelProvider, ProviderError, type ProviderRequest, retryableStatus, retryAfterMs } from './types.ts';

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
  ...(request.reasoning === 'none' ? { chat_template_kwargs: { enable_thinking: false } } : request.reasoning ? { reasoning_effort: request.reasoning } : {}),
  ...(request.json ? { response_format: { type: 'json_schema', json_schema: { name: request.json.name, strict: true, schema: request.json.schema } } } : {}),
});

async function post(options: WorkersAiOptions, payload: object, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ProviderError(`Workers AI request failed: ${String(error)}`, true);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new ProviderError(`Workers AI HTTP ${response.status}: ${detail}`, retryableStatus(response.status), retryAfterMs(response.headers.get('retry-after')));
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

export interface WorkersAiOptions {
  /** `https://api.cloudflare.com/client/v4/accounts/<account id>/ai` (`serverConfig.workersAi`). */
  readonly baseUrl: string;
  readonly apiToken: string;
}

export const workersAi = (options: WorkersAiOptions): ModelProvider => ({
  complete: async (request, signal) => {
    const completion = (await (await post(options, body(request, false), signal)).json()) as Completion;
    const choice = completion.choices?.[0];
    if (choice?.finish_reason === 'length') throw new ProviderError('Workers AI output was truncated at max_completion_tokens', false);
    if (typeof choice?.message?.content !== 'string') throw new ProviderError('Workers AI response had no message content', false);
    return choice.message.content;
  },
  stream: async function* (request, signal) {
    const response = await post(options, body(request, true), signal);
    for await (const data of sseData(response.body!)) {
      if (data === '[DONE]') return;
      const chunk = JSON.parse(data) as Completion;
      if (chunk.error) throw new ProviderError(`Workers AI stream error: ${chunk.error.message ?? 'unknown'}`, false);
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) yield text;
    }
    throw new ProviderError('Workers AI stream ended before [DONE]', false);
  },
});
