/**
 * Anthropic Messages API through the official TypeScript SDK (`@anthropic-ai/sdk`), checked
 * 2026-09-29: structured output via `output_config.format`, streaming text deltas, and the
 * hosted `web_search_20250305` tool whose long turns stop with `pause_turn` and continue by
 * sending the paused assistant content back unchanged. Web search must be enabled for the
 * organization in the Claude Console. Retries and timeouts belong to `llm.ts`, so the SDK's are off.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, MessageCreateParamsNonStreaming, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { type ModelProvider, ProviderError, type ProviderRequest, type ResearchSource, retryableStatus, retryAfterMs } from './types.ts';

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

const params = (request: ProviderRequest): MessageCreateParamsNonStreaming => ({
  model: request.model,
  max_tokens: request.maxOutputTokens,
  system: request.system,
  messages: [{ role: 'user', content: request.prompt }],
  ...(request.json ? { output_config: { format: { type: 'json_schema', schema: request.json.schema } } } : {}),
});

/** SDK errors become ProviderErrors; a caller abort is rethrown untouched. */
function mapError(error: unknown, signal: AbortSignal): never {
  if (signal.aborted || error instanceof ProviderError) throw error;
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    throw new ProviderError(`Anthropic HTTP ${error.status}: ${error.message}`, retryableStatus(error.status), retryAfterMs(error.headers?.get('retry-after')));
  }
  throw new ProviderError(`Anthropic request failed: ${String(error)}`, error instanceof Anthropic.APIConnectionError);
}

const textOf = (content: ReadonlyArray<ContentBlock>) => content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');

const citationsOf = (content: ReadonlyArray<ContentBlock>): ResearchSource[] =>
  content.flatMap(block =>
    block.type === 'text'
      ? (block.citations ?? []).flatMap(citation => (citation.type === 'web_search_result_location' ? [{ url: citation.url, title: citation.title ?? null }] : []))
      : [],
  );

export const anthropic = (options: AnthropicOptions): ModelProvider => {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 0, ...(options.baseUrl ? { baseURL: options.baseUrl } : {}) });
  const create = (body: MessageCreateParamsNonStreaming, signal: AbortSignal) => client.messages.create(body, { signal }).catch(error => mapError(error, signal));
  return {
    complete: async (request, signal) => {
      const message = await create(params(request), signal);
      if (message.stop_reason === 'max_tokens') throw new ProviderError('Anthropic output was truncated at max_tokens', false);
      if (message.stop_reason === 'refusal') throw new ProviderError('Anthropic model refused the request', false);
      return textOf(message.content);
    },
    stream: async function* (request, signal) {
      try {
        for await (const event of client.messages.stream(params(request), { signal })) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
        }
      } catch (error) {
        mapError(error, signal);
      }
    },
    research: async (request, budget, signal) => {
      const tools = [{ type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: budget.maxSearches }];
      const content: ContentBlock[] = [];
      const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
      for (let turn = 0; turn <= budget.maxContinuations; turn++) {
        const messages: MessageParam[] = [{ role: 'user', content: request.prompt }, ...(content.length > 0 ? [{ role: 'assistant' as const, content }] : [])];
        const message = await create({ ...params(request), messages, tools }, signal);
        content.push(...message.content);
        usage.input_tokens += message.usage.input_tokens;
        usage.output_tokens += message.usage.output_tokens;
        usage.web_searches += message.usage.server_tool_use?.web_search_requests ?? 0;
        if (message.stop_reason !== 'pause_turn') {
          if (message.stop_reason === 'max_tokens') throw new ProviderError('Anthropic research was truncated at max_tokens', false);
          const sources = new Map(citationsOf(content).map(source => [source.url, source]));
          return { text: textOf(content), sources: [...sources.values()], usage };
        }
      }
      throw new ProviderError(`Anthropic research still paused after ${budget.maxContinuations} continuations`, false);
    },
  };
};
