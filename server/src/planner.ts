/**
 * Planner and requested speech (plan sections 09 and 10). `planWork` turns a direct request into
 * a web-research decision and action request proposals using only actions already inspected
 * through the integration gateway; each proposal still goes through `requestAction`, which checks
 * stored grants. `respondToRequest` streams the reply text for a requested spoken response.
 */
import { createHash } from 'node:crypto';
import { type AccessScope, type ContextSnapshot, Forbidden, type GetIntegrationActionOutput, type MeetingId, type RequestActionInput, Unavailable } from '@sanctum/contracts';
import { Effect, Schema, Stream } from 'effect';
import { LlmClient } from './llm.ts';

type InspectedAction = typeof GetIntegrationActionOutput.Type;
type ActionRequest = typeof RequestActionInput.Type;

export interface PlanInput {
  readonly meeting_id: MeetingId;
  readonly request: string;
  /** Actions already inspected with `get_integration_action`; only those whose missing fields the plan can fill are offered. */
  readonly actions: ReadonlyArray<InspectedAction>;
  /** Web research already done for this request; action arguments take researched facts from it. */
  readonly research?: { readonly text: string; readonly sources: ReadonlyArray<{ readonly url: string; readonly title: string | null }> };
}

export interface Plan {
  /** The request asks to look something up on the web (a paid call). */
  readonly web_research: boolean;
  readonly actions: ReadonlyArray<ActionRequest>;
}

const PLANNER_SYSTEM = `You plan the background work a person directly asked for in a meeting.
Set web_research true only when the request asks to look up current or public information on the web; it is a paid search, so set it false otherwise.
Propose only actions the request asks for, choosing from the offered actions; return an empty list when none fits.
Give every argument as a field name and its value encoded as JSON text in value_json.
Give every action a short title people in the meeting can read, such as "Email the notes to Maria".
Use only recipients, accounts, links and values stated in the request; never invent them.
When web research is given, take researched facts in arguments only from it and cite the source URLs they came from.`;

const VOICE_SYSTEM = `You answer a direct spoken request from people in a meeting.
Reply in one to three short spoken sentences of plain text, without markdown or lists.
Use only the meeting context provided; when it does not contain the answer, say you do not know.`;

/** Recursively key-sorted JSON, so equal arguments always hash equally. */
const canonicalJson = (value: unknown) =>
  JSON.stringify(value, (_, nested: unknown) =>
    nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : 1))) : nested,
  );

/** Fields the plan fills; the `app` field is bound by code to the grant's account, never chosen by the model. */
const plannable = (action: InspectedAction) => action.fields.filter(field => field.type !== 'app');

/** The action request, or why the proposal was rejected. */
function toRequest(proposal: { readonly title: string; readonly arguments: ReadonlyArray<{ readonly name: string; readonly value_json: string }> }, action: InspectedAction, access: AccessScope, meeting_id: MeetingId): ActionRequest | string {
  const fields = plannable(action);
  const declared = new Set(fields.map(field => field.name));
  const args = new Map<string, unknown>();
  for (const { name, value_json } of proposal.arguments) {
    if (!declared.has(name) || args.has(name)) return `undeclared or repeated argument ${name}`;
    try {
      args.set(name, JSON.parse(value_json));
    } catch {
      return `argument ${name} is not JSON`;
    }
  }
  const missing = fields.filter(field => field.required && !args.has(field.name)).map(field => field.name);
  if (missing.length > 0) return `missing required ${missing.join(', ')}`;
  const argumentsRecord = Object.fromEntries(args);
  // The same action with the same arguments in the same meeting maps to one request, so a retried plan cannot act twice.
  const digest = createHash('sha256').update([access.workspace_id, meeting_id, action.action_key, action.version, canonicalJson(argumentsRecord)].join('\n')).digest('hex');
  const title = proposal.title.trim().slice(0, 300);
  return { action_key: action.action_key, configuration_ref: action.configuration_ref, version: action.version, arguments: argumentsRecord, meeting_id, idempotency_key: `plan-${digest}`, ...(title ? { title } : {}) };
}

/**
 * The web-research decision and action request proposals for a direct request. The model may
 * only pick offered action keys and declared fields; the meeting, configuration and idempotency
 * key come from code. Without offered actions the model still decides on web research.
 */
export const planWork = (access: AccessScope, input: PlanInput): Effect.Effect<Plan, Unavailable | Forbidden, LlmClient> =>
  Effect.gen(function* () {
    if (!access.scopes.includes('actions:request')) return yield* new Forbidden({ message: 'planning actions requires actions:request', required_scope: 'actions:request' });
    if (access.meetings.kind === 'allowlist' && !access.meetings.meeting_ids.includes(input.meeting_id)) return yield* new Forbidden({ message: 'meeting is outside this access scope' });
    // An action whose missing fields were cut from the inspected output cannot be filled in.
    const fillable = input.actions.filter(action => action.missing.every(name => plannable(action).some(field => field.name === name)));
    const offered = new Map(fillable.map(action => [action.action_key, action]));
    const keys = [...offered.keys()];
    const catalog = [...offered.values()].map(action => ({ action_key: action.action_key, fields: plannable(action).map(({ name, type, required, description }) => ({ name, type, required, description })) }));
    const researched = input.research
      ? `\n\nWeb research:\n${input.research.text}\n\nSources:\n${input.research.sources.map(source => `- ${source.title ?? source.url}: ${source.url}`).join('\n') || '(none)'}`
      : '';
    const prompt = `Request: ${input.request}${researched}\n\nOffered actions:\n${keys.length === 0 ? '(none)' : JSON.stringify(catalog, null, 2)}`;
    const llm = yield* LlmClient;
    if (keys.length === 0) {
      const { value } = yield* llm.generate('planner', { name: 'research_plan', output: Schema.Struct({ web_research: Schema.Boolean }), system: PLANNER_SYSTEM, prompt });
      return { web_research: value.web_research, actions: [] };
    }
    const output = Schema.Struct({
      web_research: Schema.Boolean,
      actions: Schema.Array(Schema.Struct({ action_key: Schema.Literal(...(keys as [string, ...string[]])), title: Schema.String, arguments: Schema.Array(Schema.Struct({ name: Schema.String, value_json: Schema.String })) })),
    });
    const { value } = yield* llm.generate('planner', { name: 'action_plan', output, system: PLANNER_SYSTEM, prompt });
    const results = value.actions.map(proposal => toRequest(proposal, offered.get(proposal.action_key)!, access, input.meeting_id));
    const rejected = results.filter((result): result is string => typeof result === 'string');
    if (rejected.length > 0) yield* Effect.logWarning('planner dropped invalid proposals', rejected);
    return { web_research: value.web_research, actions: results.filter((result): result is ActionRequest => typeof result !== 'string') };
  });

/** Most recent context items given to a spoken reply. */
const REPLY_CONTEXT_ITEMS = 40;

/** Reply text for a requested spoken response; the speech gate decides whether any of it is spoken. */
export const respondToRequest = (input: { readonly request: string; readonly context: ContextSnapshot }): Stream.Stream<string, Unavailable, LlmClient> =>
  Stream.unwrap(
    Effect.map(LlmClient, llm => {
      const items = input.context.items.filter(item => item.state !== 'superseded').slice(-REPLY_CONTEXT_ITEMS);
      const context = items.map(item => `- ${item.kind} (${item.state}): ${item.text}`).join('\n') || '(no context yet)';
      return llm.stream('voice', { system: VOICE_SYSTEM, prompt: `Now: ${input.context.as_of} (meeting timezone ${input.context.timezone})\n\nMeeting context:\n${context}\n\nRequest: ${input.request}` });
    }),
  );
