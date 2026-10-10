/**
 * OpenAI Responses API hosted web search, for the research role only (the paid key buys nothing
 * else here). Checked 2026-10-10 (https://developers.openai.com/api/docs/guides/tools-web-search,
 * https://developers.openai.com/api/reference/resources/responses/methods/create): `POST /v1/responses`
 * with the `web_search` tool and `max_tool_calls`; the `message` output's `output_text` parts carry
 * the answer and their `url_citation` annotations the sources. `store: false` keeps meeting requests
 * out of OpenAI's stored responses. The key is server-only.
 */
import { Schema } from 'effect';
import { type ModelProvider, ProviderError, postJson, type ResearchResult } from './types.ts';

const list = <A, I>(item: Schema.Schema<A, I>) => Schema.optionalWith(Schema.Array(item), { default: () => [] });
const Citation = Schema.Struct({ type: Schema.String, url: Schema.optional(Schema.String), title: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }) });
const Part = Schema.Struct({ type: Schema.String, text: Schema.optionalWith(Schema.String, { default: () => '' }), annotations: list(Citation) });

/** The fields of a Responses API answer this client reads; absent lists read as empty. */
const ResponsesBody = Schema.Struct({
  status: Schema.String,
  incomplete_details: Schema.optional(Schema.NullOr(Schema.Struct({ reason: Schema.optional(Schema.String) }))),
  error: Schema.optional(Schema.NullOr(Schema.Struct({ message: Schema.optional(Schema.String) }))),
  output: list(Schema.Struct({ type: Schema.String, content: list(Part) })),
  usage: Schema.optionalWith(Schema.NullOr(Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number })), { default: () => null }),
});

/** The answer text, its cited sources deduplicated by URL, and the reported usage of a completed response; an unfinished one fails with its usage. */
function toResearch(body: typeof ResponsesBody.Type): ResearchResult {
  const usage = { ...(body.usage ?? { input_tokens: null, output_tokens: null }), web_searches: body.output.filter(item => item.type === 'web_search_call').length };
  if (body.status !== 'completed') throw new ProviderError(`OpenAI research ended ${body.status}: ${body.incomplete_details?.reason ?? body.error?.message ?? 'no reason given'}`, false, undefined, usage);
  const parts = body.output.flatMap(item => (item.type === 'message' ? item.content : [])).filter(part => part.type === 'output_text');
  const cited = parts.flatMap(part => part.annotations).flatMap(note => (note.type === 'url_citation' && note.url ? [{ url: note.url, title: note.title }] : []));
  return { text: parts.map(part => part.text).join(''), sources: [...new Map(cited.map(source => [source.url, source])).values()], usage };
}

export interface OpenAiOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export const openAi = (options: OpenAiOptions): ModelProvider => ({
  research: async (request, budget, signal) => {
    const payload = {
      model: request.model,
      instructions: request.system,
      input: request.prompt,
      tools: [{ type: 'web_search' }],
      max_tool_calls: budget.maxSearches,
      max_output_tokens: request.maxOutputTokens,
      store: false,
    };
    const response = await postJson('OpenAI', `${options.baseUrl ?? 'https://api.openai.com'}/v1/responses`, options.apiKey, payload, signal);
    return toResearch(Schema.decodeUnknownSync(ResponsesBody)(await response.json()));
  },
});
