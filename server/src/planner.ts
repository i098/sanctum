/**
 * Planner and requested speech (plan sections 09 and 10). `planActions` turns a direct request
 * into action request proposals using only actions already inspected through the integration
 * gateway; each proposal still goes through `requestAction`, which checks stored grants.
 * `respondToRequest` streams the reply text for a requested spoken response.
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
  /** Actions already inspected with `get_integration_action`; only complete ones can be proposed. */
  readonly actions?: ReadonlyArray<InspectedAction>;
}

const PLANNER_SYSTEM = `You fill in integration actions that a person directly asked for in a meeting.
Propose only actions the request asks for, choosing from the offered actions; return an empty list when none fits.
Give every argument as a field name and its value encoded as JSON text in value_json.
Use only recipients, accounts, links and values stated in the request; never invent them.`;

const VOICE_SYSTEM = `You answer a direct spoken request from people in a meeting.
Reply in one to three short spoken sentences of plain text, without markdown or lists.
Use only the meeting context provided; when it does not contain the answer, say you do not know.`;

/** Recursively key-sorted JSON, so equal arguments always hash equally. */
const canonicalJson = (value: unknown) =>
  JSON.stringify(value, (_, nested: unknown) =>
    nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : 1))) : nested,
  );

/** The action request, or why the proposal was rejected. */
function toRequest(proposal: { readonly arguments: ReadonlyArray<{ readonly name: string; readonly value_json: string }> }, action: InspectedAction, access: AccessScope, meeting_id: MeetingId): ActionRequest | string {
  const declared = new Set(action.fields.map(field => field.name));
  const args = new Map<string, unknown>();
  for (const { name, value_json } of proposal.arguments) {
    if (!declared.has(name) || args.has(name)) return `undeclared or repeated argument ${name}`;
    try {
      args.set(name, JSON.parse(value_json));
    } catch {
      return `argument ${name} is not JSON`;
    }
  }
  const missing = action.fields.filter(field => field.required && !args.has(field.name)).map(field => field.name);
  if (missing.length > 0) return `missing required ${missing.join(', ')}`;
  const argumentsRecord = Object.fromEntries(args);
  // The same action with the same arguments in the same meeting maps to one request, so a retried plan cannot act twice.
  const digest = createHash('sha256').update([access.workspace_id, meeting_id, action.action_key, action.version, canonicalJson(argumentsRecord)].join('\n')).digest('hex');
  return { action_key: action.action_key, configuration_ref: action.configuration_ref, version: action.version, arguments: argumentsRecord, meeting_id, idempotency_key: `plan-${digest}` };
}

/**
 * Action request proposals for a direct request. The model may only pick offered action keys
 * and declared fields; the meeting, configuration and idempotency key come from code.
 */
export const planActions = (access: AccessScope, input: PlanInput): Effect.Effect<ReadonlyArray<ActionRequest>, Unavailable | Forbidden, LlmClient> =>
  Effect.gen(function* () {
    if (!access.scopes.includes('actions:request')) return yield* new Forbidden({ message: 'planning actions requires actions:request', required_scope: 'actions:request' });
    if (access.meetings.kind === 'allowlist' && !access.meetings.meeting_ids.includes(input.meeting_id)) return yield* new Forbidden({ message: 'meeting is outside this access scope' });
    const offered = new Map((input.actions ?? []).filter(action => action.complete && action.missing.length === 0).map(action => [action.action_key, action]));
    const keys = [...offered.keys()];
    if (keys.length === 0) return [];
    const output = Schema.Struct({
      actions: Schema.Array(Schema.Struct({ action_key: Schema.Literal(...(keys as [string, ...string[]])), arguments: Schema.Array(Schema.Struct({ name: Schema.String, value_json: Schema.String })) })),
    });
    const catalog = [...offered.values()].map(action => ({ action_key: action.action_key, fields: action.fields.map(({ name, type, required, description }) => ({ name, type, required, description })) }));
    const llm = yield* LlmClient;
    const { value } = yield* llm.generate('planner', { name: 'action_plan', output, system: PLANNER_SYSTEM, prompt: `Request: ${input.request}\n\nOffered actions:\n${JSON.stringify(catalog, null, 2)}` });
    const results = value.actions.map(proposal => toRequest(proposal, offered.get(proposal.action_key)!, access, input.meeting_id));
    const rejected = results.filter((result): result is string => typeof result === 'string');
    if (rejected.length > 0) yield* Effect.logWarning('planner dropped invalid proposals', rejected);
    return results.filter((result): result is ActionRequest => typeof result !== 'string');
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
