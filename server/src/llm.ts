/**
 * Model roles (plan section 09): `LlmClient` routes each role to its explicitly configured
 * provider and model, bounds every attempt with a timeout, retries only transient transport
 * failures a bounded number of times, and decodes structured output with Effect Schema.
 * A missing key or provider failure is a visible `Unavailable`; no other provider, fixture or
 * demo content is ever substituted.
 */
import { Context, Effect, JSONSchema, Layer, Option, Redacted, Schedule, Schema, Stream } from 'effect';
import { Unavailable } from '@sanctum/contracts';
import { engineeringDefaults, type ModelRoleName, type ServerConfig, serverConfig } from './config.ts';
import { anthropic } from './providers/anthropic.ts';
import { cerebras } from './providers/cerebras.ts';
import { type ModelProvider, ProviderError, type ProviderRequest, type ResearchResult } from './providers/types.ts';

/** Model output plus the model ID that produced it, recorded with generated artifacts. */
export interface Generated<A> {
  readonly value: A;
  readonly model: string;
}

interface Prompt {
  readonly system: string;
  readonly prompt: string;
}

export interface Llm {
  /** Strict-schema JSON from the role's model, decoded with `output` (which must have no refinements). */
  readonly generate: <A, I>(role: ModelRoleName, request: Prompt & { readonly name: string; readonly output: Schema.Schema<A, I> }) => Effect.Effect<Generated<A>, Unavailable>;
  /** Text deltas; interruption aborts the request, and a stalled stream fails. Never retried, so no text repeats. */
  readonly stream: (role: ModelRoleName, request: Prompt) => Stream.Stream<string, Unavailable>;
  /** Hosted web research with cited sources (research role only). */
  readonly research: (request: Prompt) => Effect.Effect<Generated<ResearchResult>, Unavailable>;
}

export class LlmClient extends Context.Tag('sanctum/LlmClient')<LlmClient, Llm>() {}

type Roles = ServerConfig['modelRoles'];
type Providers = { readonly [P in Roles[ModelRoleName]['provider']]?: ModelProvider | undefined };
type Budget = { readonly [K in keyof typeof engineeringDefaults.modelRequest]: number };

const toUnavailable = (role: ModelRoleName) => (error: unknown) => {
  if (error instanceof Unavailable) return error;
  const retryable = error instanceof ProviderError && error.retryable;
  const retry = error instanceof ProviderError && error.retryAfterMs !== undefined ? { retry_after_ms: error.retryAfterMs } : {};
  return new Unavailable({ message: `${role} model: ${error instanceof Error ? error.message : String(error)}`, retryable, ...retry });
};

/** Builds the service from explicit role settings and the providers that have keys. */
export function makeLlm(roles: Roles, providers: Providers, budget: Budget = engineeringDefaults.modelRequest): Llm {
  const select = (role: ModelRoleName) => {
    const setting = roles[role];
    const provider = providers[setting.provider];
    if (!provider) {
      return Effect.fail(new Unavailable({ message: `${role} model provider ${setting.provider} is not configured (${setting.provider.toUpperCase()}_API_KEY)`, retryable: false }));
    }
    const base: ProviderRequest = { model: setting.model, reasoning: setting.reasoning, maxOutputTokens: budget.maxOutputTokens, system: '', prompt: '' };
    return Effect.succeed({ provider, base });
  };

  const retries = Schedule.exponential('250 millis').pipe(Schedule.jittered, Schedule.intersect(Schedule.recurs(budget.maxAttempts - 1)));

  const call = <T>(role: ModelRoleName, timeoutMs: number, run: (provider: ModelProvider, base: ProviderRequest, signal: AbortSignal) => Promise<T>) =>
    Effect.flatMap(select(role), ({ provider, base }) =>
      Effect.tryPromise({ try: signal => run(provider, base, signal), catch: toUnavailable(role) }).pipe(
        Effect.timeoutFail({ duration: timeoutMs, onTimeout: () => new Unavailable({ message: `${role} model timed out after ${timeoutMs} ms`, retryable: true }) }),
        Effect.retry({ schedule: retries, while: error => error.retryable }),
        Effect.map(value => ({ value, model: base.model })),
      ),
    );

  return {
    generate: (role, { name, output, ...prompt }) => {
      const { $schema: _, ...schema }: Record<string, unknown> = { ...JSONSchema.make(output) };
      return call(role, budget.timeoutMs, (provider, base, signal) => provider.complete({ ...base, ...prompt, json: { name, schema } }, signal)).pipe(
        Effect.flatMap(({ value, model }) =>
          Schema.decodeUnknown(Schema.parseJson(output))(value).pipe(
            Effect.mapError(error => new Unavailable({ message: `${role} model output failed the ${name} schema: ${error.message.slice(0, 400)}`, retryable: false })),
            Effect.map(decoded => ({ value: decoded, model })),
          ),
        ),
      );
    },
    stream: (role, prompt) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const { provider, base } = yield* select(role);
          const controller = new AbortController();
          yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
          return Stream.fromAsyncIterable(provider.stream({ ...base, ...prompt }, controller.signal), toUnavailable(role)).pipe(
            Stream.timeoutFail(() => new Unavailable({ message: `${role} model stream stalled for ${budget.timeoutMs} ms`, retryable: true }), budget.timeoutMs),
          );
        }),
      ),
    research: prompt =>
      call('research', budget.timeoutMs * (budget.researchMaxContinuations + 1), (provider, base, signal) => {
        if (!provider.research) throw new ProviderError('research provider has no hosted web search', false);
        return provider.research({ ...base, ...prompt }, { maxSearches: budget.researchMaxSearches, maxContinuations: budget.researchMaxContinuations }, signal);
      }),
  };
}

/** Production service from `serverConfig`; a provider without a key stays unconfigured. */
export const LlmLive = Layer.effect(
  LlmClient,
  Effect.map(serverConfig, ({ modelRoles, modelKeys }) =>
    makeLlm(modelRoles, {
      cerebras: Option.getOrUndefined(Option.map(modelKeys.cerebras, key => cerebras({ apiKey: Redacted.value(key) }))),
      anthropic: Option.getOrUndefined(Option.map(modelKeys.anthropic, key => anthropic({ apiKey: Redacted.value(key) }))),
    }),
  ),
);

/**
 * Test service replaying recorded or synthetic raw model responses in order through the same
 * decoding, timeout and retry path; an `Unavailable` entry is thrown as that failure. Every
 * provider request is appended to `requests`. Running out of responses fails visibly.
 */
export function fixtureLlm(responses: ReadonlyArray<string | Unavailable>, requests: ProviderRequest[] = []) {
  const queue = [...responses];
  const next = (request: ProviderRequest) => {
    requests.push(request);
    const response = queue.shift() ?? new Unavailable({ message: 'fixture LLM has no recorded response left', retryable: false });
    if (typeof response !== 'string') throw response;
    return response;
  };
  const provider: ModelProvider = {
    complete: async request => next(request),
    stream: async function* (request) {
      yield* next(request).split(/(?<= )/);
    },
    research: async request => ({ text: next(request), sources: [] }),
  };
  return Layer.succeed(LlmClient, makeLlm(engineeringDefaults.modelRoles, { cerebras: provider, anthropic: provider }));
}
