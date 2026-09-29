/**
 * In-memory stand-in for the v1 slice handlers (meetings, context, integrations, actions,
 * agents), used to test adapters: SDKs, MCP and the website all call these through REST.
 * Behavior follows plan section 12: scoped reads, expected-revision conflicts, idempotent
 * writes, cursor pages and durable change cursors. Test-only; never used by the server.
 */
import { createHash, randomUUID } from 'node:crypto';
import { HttpApiBuilder, type HttpApiGroup } from '@effect/platform';
import type { SqlClient } from '@effect/sql';
import {
  type AccessScope,
  type AccessScopeName,
  ActionReceipt,
  AgentCredential,
  ContextEvent,
  ContextItem,
  CurrentAccess,
  Forbidden,
  HashConflict,
  Meeting,
  NotFound,
  RecordingAccess,
  RevisionConflict,
  SanctumApi,
  SourceRecord,
  TranscriptSegment,
  Unauthenticated,
} from '@sanctum/contracts';
import { Effect, Layer, Schema } from 'effect';
import { AuthenticatedLive, Authenticator, SessionLive } from '../../src/auth.ts';
import { HealthLive } from '../../src/health.ts';
import { loadMigrations } from '../../src/migrate.ts';

const wire = <A, I>(schema: Schema.Schema<A, I>, value: I): A => Schema.decodeSync(schema)(value);
const now = () => new Date().toISOString();
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface Workspace {
  readonly meetings: Array<Meeting>;
  readonly items: Map<string, ContextItem>;
  readonly events: Array<ContextEvent>;
  readonly segments: Map<string, TranscriptSegment>;
  readonly actions: Map<string, ActionReceipt>;
  readonly agents: Map<string, AgentCredential>;
  readonly receipts: Map<string, { readonly hash: string; readonly value: unknown }>;
}

/** Integration catalog fixture: search returns compact matches, inspection returns one schema. */
const CATALOG = [
  { action_key: 'linear-create-issue', app: 'linear', purpose: 'Create a tracking issue', connection: 'connected', effect: 'write' },
  { action_key: 'gmail-send-email', app: 'gmail', purpose: 'Send an email', connection: 'not_connected', effect: 'send' },
] as const;

/** Source ID whose read never finishes, so cancellation can be observed. */
export const HOLD_SOURCE_ID = '00000000-0000-4000-8000-00000000cafe';

const offsetPage = <A>(all: ReadonlyArray<A>, cursor: string | undefined, limit = 50) => {
  const start = cursor === undefined ? 0 : Number(cursor.slice(1));
  const items = all.slice(start, start + limit);
  return { items, next_cursor: start + limit < all.length ? `o${start + limit}` : null };
};

/** Per-test in-memory state and the rules every fake handler shares. */
function createStore() {
  const workspaces = new Map<string, Workspace>();
  const tokens = new Map<string, AccessScope>();
  const interrupted: Array<string> = [];

  const space = (access: AccessScope) => {
    let found = workspaces.get(access.workspace_id);
    if (found === undefined) {
      found = { meetings: [], items: new Map(), events: [], segments: new Map(), actions: new Map(), agents: new Map(), receipts: new Map() };
      workspaces.set(access.workspace_id, found);
    }
    return found;
  };
  const need = (access: AccessScope, scope: AccessScopeName) =>
    access.scopes.includes(scope) ? Effect.void : Effect.fail(new Forbidden({ message: `Requires ${scope}`, required_scope: scope }));
  const meetingOf = (access: AccessScope, id: string) => {
    const meeting = space(access).meetings.find(m => m.id === id);
    return meeting ? Effect.succeed(meeting) : Effect.fail(new NotFound({ message: 'Meeting not found' }));
  };
  const revisionOf = (w: Workspace, meeting_id: string | null) =>
    w.events.filter(e => e.meeting_id === meeting_id).length;
  /** Replays a stored result for the same key and payload; the same key with other content conflicts. */
  const once = <A, E, R>(access: AccessScope, operation: string, key: string, payload: unknown, run: Effect.Effect<A, E, R>) =>
    Effect.suspend((): Effect.Effect<A, E | HashConflict, R> => {
      const receipts = space(access).receipts;
      const id = `${access.principal.id}:${operation}:${key}`;
      const hash = sha256(payload);
      const stored = receipts.get(id);
      if (stored?.hash === hash) return Effect.succeed(stored.value as A);
      if (stored) return Effect.fail(new HashConflict({ message: 'Idempotency key reused with different content', existing_sha256: stored.hash }));
      return Effect.tap(run, value => receipts.set(id, { hash, value }));
    });
  const record = (access: AccessScope, item: ContextItem, change: 'item_added' | 'item_revised') => {
    const w = space(access);
    w.items.set(item.id, item);
    const seq = w.events.length + 1;
    w.events.push(
      wire(ContextEvent, {
        seq,
        meeting_id: item.meeting_id,
        item: { id: item.id, revision: item.revision },
        change,
        actor: access.principal.id,
        permission_revision: access.permission_revision,
        created_at: now(),
      }),
    );
  };

  return { tokens, interrupted, space, need, meetingOf, revisionOf, once, record };
}
type Store = ReturnType<typeof createStore>;

const meetingsGroup = ({ space, need, meetingOf }: Store) =>
  HttpApiBuilder.group(SanctumApi, 'meetings', handlers =>
    handlers
      .handle('listMeetings', ({ urlParams }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'context:read');
          const all = space(access).meetings.filter(m => urlParams.state === undefined || m.state === urlParams.state);
          return offsetPage(all, urlParams.cursor, urlParams.limit);
        }),
      )
      .handle('getMeeting', ({ path }) => Effect.flatMap(CurrentAccess, access => meetingOf(access, path.meeting_id)))
      .handle('getTranscript', ({ path, urlParams }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* meetingOf(access, path.meeting_id);
          return offsetPage([...space(access).segments.values()], urlParams.cursor, urlParams.limit);
        }),
      )
      .handle('recordingAccess', ({ path }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'recordings:read');
          const meeting = yield* meetingOf(access, path.meeting_id);
          return wire(RecordingAccess, {
            meeting_id: meeting.id,
            boundary_revision: meeting.boundary_revision,
            url: `https://objects.test/${meeting.id}.wav?expires=300`,
            expires_at: new Date(Date.now() + 300_000).toISOString(),
            gaps: [],
          });
        }),
      ),
  );

const contextGroup = ({ space, need, meetingOf, revisionOf, once, record, interrupted }: Store) =>
  HttpApiBuilder.group(SanctumApi, 'context', handlers =>
    handlers
      .handle('getContext', ({ path }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'context:read');
          const meeting = yield* meetingOf(access, path.meeting_id);
          const w = space(access);
          return {
            meeting_id: meeting.id,
            revision: revisionOf(w, meeting.id),
            as_of: wire(ContextItem.fields.created_at, now()),
            timezone: meeting.timezone,
            source_watermark: null,
            items: [...w.items.values()].filter(item => item.meeting_id === meeting.id && item.state !== 'superseded'),
            changes_cursor: `c${w.events.length}`,
            truncated: false,
          };
        }),
      )
      .handle('searchContext', ({ urlParams }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'context:read');
          const q = urlParams.q.toLowerCase();
          const hits = [...space(access).items.values()].filter(
            item => item.text.toLowerCase().includes(q) && (urlParams.meeting_id === undefined || item.meeting_id === urlParams.meeting_id),
          );
          return offsetPage(hits, urlParams.cursor, urlParams.limit);
        }),
      )
      .handle('addContextItem', ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'context:write');
          const w = space(access);
          if (payload.meeting_id !== null) yield* meetingOf(access, payload.meeting_id);
          return yield* once(
            access,
            'addContextItem',
            payload.idempotency_key,
            payload,
            Effect.suspend(() => {
              const current = revisionOf(w, payload.meeting_id);
              if (payload.expected_revision !== current) {
                return Effect.fail(new RevisionConflict({ message: 'Context changed; rebase on current_revision', current_revision: current }));
              }
              const item = wire(ContextItem, {
                id: randomUUID(),
                revision: 1,
                meeting_id: payload.meeting_id,
                kind: payload.kind,
                text: payload.text,
                state: 'provisional',
                derivation: access.principal.kind === 'human' ? 'human_correction' : 'external',
                event_at: null,
                valid_from: null,
                valid_until: null,
                time: null,
                author: { type: access.principal.kind === 'device' ? 'system' : access.principal.kind, id: access.principal.id },
                sources: payload.sources,
                supersedes: null,
                created_at: now(),
              });
              record(access, item, 'item_added');
              return Effect.succeed(item);
            }),
          );
        }),
      )
      .handle('reviseContextItem', ({ path, payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'context:write');
          const previous = space(access).items.get(path.item_id);
          if (previous === undefined) return yield* new NotFound({ message: 'Context item not found' });
          return yield* once(
            access,
            'reviseContextItem',
            payload.idempotency_key,
            { ...payload, item_id: path.item_id },
            Effect.suspend(() => {
              const current = space(access).items.get(path.item_id)!;
              if (payload.expected_revision !== current.revision) {
                return Effect.fail(new RevisionConflict({ message: 'Item was revised; rebase', current_revision: current.revision }));
              }
              const next = {
                ...current,
                revision: current.revision + 1,
                text: payload.text,
                sources: payload.sources,
                supersedes: { id: current.id, revision: current.revision },
                author: { type: access.principal.kind === 'device' ? ('system' as const) : access.principal.kind, id: access.principal.id },
              };
              record(access, next, 'item_revised');
              return Effect.succeed(next);
            }),
          );
        }),
      )
      .handle('getContextChanges', ({ urlParams }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'context:read');
          const after = urlParams.cursor === undefined ? 0 : Number(urlParams.cursor.slice(1));
          const changes = space(access)
            .events.filter(e => e.seq > after && (urlParams.meeting_id === undefined || e.meeting_id === urlParams.meeting_id))
            .slice(0, urlParams.limit ?? 50);
          return { items: changes, next_cursor: `c${changes.at(-1)?.seq ?? after}` };
        }),
      )
      .handle('getSource', ({ path }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'context:read');
          if (path.source_id === HOLD_SOURCE_ID) {
            return yield* Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interrupted.push(path.source_id))));
          }
          const segment = space(access).segments.get(path.source_id);
          if (segment === undefined) return yield* new NotFound({ message: 'Source not found' });
          return wire(SourceRecord, { id: segment.id, kind: 'segment', meeting_id: null, text: segment.text, segment: Schema.encodeSync(TranscriptSegment)(segment) });
        }),
      ),
  );

const integrationsGroup = (_store: Store) =>
  HttpApiBuilder.group(SanctumApi, 'integrations', handlers =>
    handlers
      .handle('searchIntegrationActions', ({ urlParams }) =>
        Effect.succeed({
          matches: CATALOG.filter(entry => entry.purpose.toLowerCase().includes(urlParams.intent.toLowerCase()) && (urlParams.app ?? entry.app) === entry.app).slice(0, urlParams.limit ?? 3),
          refinement_hint: null,
        }),
      )
      .handle('getIntegrationAction', ({ path }) => {
        const entry = CATALOG.find(e => e.action_key === path.action_key);
        if (entry === undefined) return Effect.fail(new NotFound({ message: 'Unknown action' }));
        return Effect.succeed({
          action_key: entry.action_key,
          version: '1.0.0',
          configuration_ref: `cfg-${entry.action_key}`,
          fields: [{ name: 'title', type: 'string', required: true, description: 'Issue title', remote_options: false }],
          missing: [],
          options: null,
          complete: true,
        });
      }),
  );

const actionsGroup = ({ space, need, once }: Store) =>
  HttpApiBuilder.group(SanctumApi, 'actions', handlers =>
    handlers
      .handle('requestAction', ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'actions:request');
          if (!CATALOG.some(e => e.action_key === payload.action_key)) return yield* new NotFound({ message: 'Unknown action' });
          return yield* once(
            access,
            'requestAction',
            payload.idempotency_key,
            payload,
            Effect.sync(() => {
              const receipt = wire(ActionReceipt, {
                action_id: randomUUID(),
                action_key: payload.action_key,
                meeting_id: payload.meeting_id,
                state: 'queued',
                args_sha256: sha256(payload.arguments),
                grant: null,
                provider_receipt: null,
                attempts: 0,
                reconciliation: 'none',
                updated_at: now(),
              });
              space(access).actions.set(receipt.action_id, receipt);
              return { action_id: receipt.action_id, state: receipt.state };
            }),
          );
        }),
      )
      .handle('getAction', ({ path }) =>
        Effect.flatMap(CurrentAccess, access => {
          const receipt = space(access).actions.get(path.action_id);
          return receipt ? Effect.succeed(receipt) : Effect.fail(new NotFound({ message: 'Action not found' }));
        }),
      ),
  );

const agentsGroup = ({ space, need, tokens }: Store) =>
  HttpApiBuilder.group(SanctumApi, 'agents', handlers =>
    handlers
      .handle('listAgents', ({ urlParams }) =>
        Effect.flatMap(CurrentAccess, access =>
          Effect.as(need(access, 'workspace:admin'), offsetPage([...space(access).agents.values()], urlParams.cursor, urlParams.limit)),
        ),
      )
      .handle('createAgent', ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'workspace:admin');
          const credential = wire(AgentCredential, {
            credential_id: randomUUID(),
            agent_id: randomUUID(),
            display_name: payload.display_name,
            scopes: payload.scopes.filter(scope => access.scopes.includes(scope)),
            meeting_ids: payload.meeting_ids,
            created_at: now(),
            expires_at: payload.expires_at,
            revoked_at: null,
            last_used_at: null,
          });
          const token = `agent_${randomUUID()}`;
          space(access).agents.set(credential.credential_id, credential);
          tokens.set(token, {
            workspace_id: access.workspace_id,
            principal: { id: credential.agent_id, kind: 'agent', display_name: credential.display_name },
            role: 'agent',
            scopes: credential.scopes,
            meetings: credential.meeting_ids === null ? { kind: 'accessible' } : { kind: 'allowlist', meeting_ids: credential.meeting_ids },
            permission_revision: access.permission_revision,
          });
          return { credential, token };
        }),
      )
      .handle('revokeCredential', ({ path }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'workspace:admin');
          const credential = space(access).agents.get(path.credential_id);
          if (credential === undefined || credential.agent_id !== path.agent_id) return yield* new NotFound({ message: 'Credential not found' });
          const revoked = { ...credential, revoked_at: credential.revoked_at ?? wire(ContextItem.fields.created_at, now()) };
          space(access).agents.set(revoked.credential_id, revoked);
          for (const [token, scope] of tokens) if (scope.principal.id === revoked.agent_id) tokens.delete(token);
          return revoked;
        }),
      ),
  );

export function fakeDomain() {
  const store = createStore();
  const { space, tokens, interrupted } = store;
  return {
    groups: Layer.mergeAll(meetingsGroup(store), contextGroup(store), integrationsGroup(store), actionsGroup(store), agentsGroup(store)),
    /** Bearer tokens issued by `token()` or `createAgent`; revocation deletes them. */
    authenticator: Layer.succeed(Authenticator, {
      authenticate: request => {
        const access = tokens.get(request.headers['authorization']?.replace(/^Bearer /, '') ?? '');
        return access ? Effect.succeed(access) : Effect.fail(new Unauthenticated({ message: 'Unknown or revoked token' }));
      },
    }),
    token: (access: AccessScope) => {
      const token = `human_${randomUUID()}`;
      tokens.set(token, access);
      return token;
    },
    addMeeting: (access: AccessScope, title: string) => {
      const meeting = wire(Meeting, {
        id: randomUUID(),
        workspace_id: access.workspace_id,
        state: 'active',
        title,
        started_at: now(),
        ended_at: null,
        timezone: 'America/Los_Angeles',
        boundary_revision: 1,
        visibility: 'workspace',
        processing: { transcript: 'partial', notes: 'pending', memory: 'pending', recording: 'partial' },
      });
      space(access).meetings.push(meeting);
      return meeting;
    },
    addSegment: (access: AccessScope, text: string) => {
      const segment = wire(TranscriptSegment, {
        id: randomUUID(),
        source: { epoch_id: randomUUID(), track: 0, sample_start: 0, sample_end: 16_000 },
        text,
        status: 'final',
        revision: 1,
        origin: 'live',
        provider: 'fixture',
        model: 'fixture',
        provider_connection_id: null,
        speaker_label: null,
        speaker_track_id: null,
        confidence: null,
        created_at: now(),
      });
      space(access).segments.set(segment.id, segment);
      return segment;
    },
    settleAction: (access: AccessScope, action_id: string, state: 'succeeded' | 'failed', provider_receipt: Record<string, unknown>) => {
      const receipt = space(access).actions.get(action_id)!;
      space(access).actions.set(action_id, { ...receipt, state, provider_receipt, attempts: receipt.attempts + 1, updated_at: wire(ContextItem.fields.created_at, now()) });
    },
    interrupted,
  };
}

/** Full v1 API over a fake domain; health and session keep their real handlers unless `health` is replaced. */
export const fakeApi = <R = SqlClient.SqlClient>(
  domain: ReturnType<typeof fakeDomain>,
  health: Layer.Layer<HttpApiGroup.ApiGroup<'sanctum', 'health'>, never, R> = HealthLive(loadMigrations()) as never,
) =>
  HttpApiBuilder.api(SanctumApi).pipe(Layer.provide([health, SessionLive, domain.groups]), Layer.provide(AuthenticatedLive));
