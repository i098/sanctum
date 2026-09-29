// stand-in: replaced by the meetings, context, actions, pipedream and kernel slices at integration
/**
 * Minimal v1 groups for the routes the SDKs, MCP tools and Agents dialog call (plan section 12).
 * Each owning slice defines the real group in its contracts area file; delete this file then.
 */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';
import {
  AgentCredentialId,
  ArtifactId,
  Cursor,
  IdempotencyKey,
  MeetingId,
  PageLimit,
  PrincipalId,
  Revision,
  UtcTimestamp,
} from './common.ts';
import { AccessScopeName, Authenticated } from './auth.ts';
import { ContextEvent, ContextItem, ContextSnapshot, AddContextItem, SourceRef } from './context.ts';
import { Meeting, MeetingState, RecordingAccess } from './meetings.ts';
import { TranscriptSegment } from './transcripts.ts';
import { ActionReceipt } from './actions.ts';
import {
  ActionKey,
  AppSlug,
  GetIntegrationActionOutput,
  RequestActionInput,
  RequestActionOutput,
  SEARCH_MAX_LIMIT,
  SearchIntegrationActionsOutput,
} from './integrations.ts';

/** Opaque cursor page: `next_cursor` is null on the last page. */
const Page = <A, I, R>(item: Schema.Schema<A, I, R>) =>
  Schema.Struct({ items: Schema.Array(item), next_cursor: Schema.NullOr(Cursor) });

const PageParams = {
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.compose(PageLimit))),
};

const meetingId = HttpApiSchema.param('meeting_id', MeetingId);

export class MeetingsApi extends HttpApiGroup.make('meetings')
  .add(
    HttpApiEndpoint.get('listMeetings', '/meetings')
      .setUrlParams(Schema.Struct({ state: Schema.optional(MeetingState), ...PageParams }))
      .addSuccess(Page(Meeting)),
  )
  .add(HttpApiEndpoint.get('getMeeting')`/meetings/${meetingId}`.addSuccess(Meeting))
  .add(
    HttpApiEndpoint.get('getTranscript')`/meetings/${meetingId}/transcript`
      .setUrlParams(Schema.Struct(PageParams))
      .addSuccess(Page(TranscriptSegment)),
  )
  .add(HttpApiEndpoint.post('recordingAccess')`/meetings/${meetingId}/recording-access`.addSuccess(RecordingAccess))
  .middleware(Authenticated)
  .prefix('/api/v1') {}

/** `PATCH /api/v1/context/items/{id}`: a new revision that supersedes `expected_revision`. */
export const ReviseContextItem = Schema.Struct({
  expected_revision: Revision,
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(20_000)),
  sources: Schema.Array(SourceRef).pipe(Schema.minItems(1)),
  idempotency_key: IdempotencyKey,
});

/** `GET /api/v1/sources/{id}`: exact cited text; a segment or an attached artifact. */
export const SourceRecord = Schema.Struct({
  id: Schema.UUID,
  kind: Schema.Literal('segment', 'artifact'),
  meeting_id: Schema.NullOr(MeetingId),
  text: Schema.String,
  segment: Schema.NullOr(TranscriptSegment),
});

const itemId = HttpApiSchema.param('item_id', ContextItem.fields.id);

export class ContextApi extends HttpApiGroup.make('context')
  .add(HttpApiEndpoint.get('getContext')`/meetings/${meetingId}/context`.addSuccess(ContextSnapshot))
  .add(
    HttpApiEndpoint.get('searchContext', '/context/search')
      .setUrlParams(
        Schema.Struct({
          q: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)),
          meeting_id: Schema.optional(MeetingId),
          ...PageParams,
        }),
      )
      .addSuccess(Page(ContextItem)),
  )
  .add(HttpApiEndpoint.post('addContextItem', '/context/items').setPayload(AddContextItem).addSuccess(ContextItem, { status: 201 }))
  .add(HttpApiEndpoint.patch('reviseContextItem')`/context/items/${itemId}`.setPayload(ReviseContextItem).addSuccess(ContextItem))
  .add(
    HttpApiEndpoint.get('getContextChanges', '/context/changes')
      .setUrlParams(Schema.Struct({ meeting_id: Schema.optional(MeetingId), ...PageParams }))
      .addSuccess(Page(ContextEvent)),
  )
  .add(HttpApiEndpoint.get('getSource')`/sources/${HttpApiSchema.param('source_id', Schema.UUID)}`.addSuccess(SourceRecord))
  .middleware(Authenticated)
  .prefix('/api/v1') {}

export class IntegrationsApi extends HttpApiGroup.make('integrations')
  .add(
    HttpApiEndpoint.get('searchIntegrationActions', '/integrations/actions')
      .setUrlParams(
        Schema.Struct({
          intent: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)),
          app: Schema.optional(AppSlug),
          limit: Schema.optional(Schema.NumberFromString.pipe(Schema.compose(Schema.Int.pipe(Schema.between(1, SEARCH_MAX_LIMIT))))),
        }),
      )
      .addSuccess(SearchIntegrationActionsOutput),
  )
  .add(
    HttpApiEndpoint.post('getIntegrationAction')`/integrations/actions/${HttpApiSchema.param('action_key', ActionKey)}/schema`
      .setPayload(
        Schema.Struct({
          account_id: Schema.optional(Schema.UUID),
          configuration: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
          field: Schema.optional(Schema.String),
          options_cursor: Schema.optional(Schema.String),
        }),
      )
      .addSuccess(GetIntegrationActionOutput),
  )
  .middleware(Authenticated)
  .prefix('/api/v1') {}

export class ActionsApi extends HttpApiGroup.make('actions')
  .add(HttpApiEndpoint.post('requestAction', '/actions').setPayload(RequestActionInput).addSuccess(RequestActionOutput, { status: 202 }))
  .add(HttpApiEndpoint.get('getAction')`/actions/${HttpApiSchema.param('action_id', ActionReceipt.fields.action_id)}`.addSuccess(ActionReceipt))
  .middleware(Authenticated)
  .prefix('/api/v1') {}

/** One agent credential as its owner sees it; the plain token is returned only at creation. */
export const AgentCredential = Schema.Struct({
  credential_id: AgentCredentialId,
  agent_id: PrincipalId,
  display_name: Schema.String,
  scopes: Schema.Array(AccessScopeName),
  meeting_ids: Schema.NullOr(Schema.Array(MeetingId)),
  created_at: UtcTimestamp,
  expires_at: Schema.NullOr(UtcTimestamp),
  revoked_at: Schema.NullOr(UtcTimestamp),
  last_used_at: Schema.NullOr(UtcTimestamp),
});
export type AgentCredential = typeof AgentCredential.Type;

export const CreateAgent = Schema.Struct({
  display_name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  scopes: Schema.Array(AccessScopeName).pipe(Schema.minItems(1)),
  meeting_ids: Schema.NullOr(Schema.Array(MeetingId)),
  expires_at: Schema.NullOr(UtcTimestamp),
});
export type CreateAgent = typeof CreateAgent.Type;

export class AgentsApi extends HttpApiGroup.make('agents')
  .add(HttpApiEndpoint.get('listAgents', '/agents').setUrlParams(Schema.Struct(PageParams)).addSuccess(Page(AgentCredential)))
  .add(
    HttpApiEndpoint.post('createAgent', '/agents')
      .setPayload(CreateAgent)
      .addSuccess(Schema.Struct({ credential: AgentCredential, token: Schema.String }), { status: 201 }),
  )
  .add(
    HttpApiEndpoint.del('revokeCredential')`/agents/${HttpApiSchema.param('agent_id', PrincipalId)}/credentials/${HttpApiSchema.param('credential_id', AgentCredentialId)}`.addSuccess(
      AgentCredential,
    ),
  )
  .middleware(Authenticated)
  .prefix('/api/v1') {}
