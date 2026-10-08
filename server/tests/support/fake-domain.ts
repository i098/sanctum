/**
 * In-memory stand-in for the v1 slice handlers (meetings, context, integrations, actions,
 * agents), used to test adapters: SDKs, MCP and the website all call these through REST.
 * Behavior follows plan section 12: scoped reads, expected-revision conflicts, idempotent
 * writes, cursor pages and durable change cursors. Test-only; never used by the server.
 */
import { createHash, randomUUID } from 'node:crypto';
import { HttpApiBuilder, type HttpApiGroup, HttpServerRequest } from '@effect/platform';
import type { SqlClient } from '@effect/sql';
import {
  type AccessScope,
  type AccessScopeName,
  ActionReceipt,
  AgentWithCredential,
  ContextEvent,
  ContextItem,
  CurrentAccess,
  Forbidden,
  HashConflict,
  Meeting,
  MeetingAccess,
  type MeetingId,
  MeetingNotes,
  NotFound,
  RecordingAccess,
  RevisionConflict,
  Source,
  TranscriptSegment,
  Unauthenticated,
  Unavailable,
  WorkspaceOwner,
} from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect, Layer, Schema } from 'effect';
import { AuthenticatedLive, Authenticator } from '../../src/auth.ts';
import { HealthLive } from '../../src/health.ts';
import { loadMigrations } from '../../src/migrate.ts';

const wire = <A, I>(schema: Schema.Schema<A, I>, value: I): A => Schema.decodeSync(schema)(value);
const now = () => new Date().toISOString();
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface Workspace {
  readonly meetings: Array<Meeting>;
  readonly items: Map<string, ContextItem>;
  readonly events: Array<ContextEvent>;
  readonly segments: Map<string, { readonly meeting_id: Meeting['id']; readonly segment: TranscriptSegment }>;
  readonly actions: Map<string, ActionReceipt>;
  readonly agents: Map<string, AgentWithCredential>;
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
  const record = (access: AccessScope, item: ContextItem, change: 'item_added' | 'item_revised' | 'item_superseded') => {
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

const unmodeled = Effect.fail(new Unavailable({ message: 'Not modeled by the fake domain', retryable: false }));

/** Closed meetings summarize their fake transcript; open ones have no notes yet, as in the real service. */
const fakeNotes = ({ space, need, meetingOf }: Store, access: AccessScope, meeting_id: MeetingId) =>
  Effect.gen(function* () {
    yield* need(access, 'context:read');
    const meeting = yield* meetingOf(access, meeting_id);
    if (meeting.state !== 'closed') return yield* new Unavailable({ message: 'Notes are not ready yet', retryable: true });
    const points = [...space(access).segments.values()]
      .filter(s => s.meeting_id === meeting.id)
      .map(s => ({ text: s.segment.text, sources: [{ segment_id: s.segment.id, start_ms: 0, end_ms: 1_000 }] }));
    return wire(MeetingNotes, {
      meeting_id: meeting.id,
      revision: 1,
      boundary_revision: meeting.boundary_revision,
      model: 'fake-notes',
      title: meeting.title ?? 'Meeting',
      summary: `${points.length} points discussed`,
      sections: [{ heading: 'Discussion', points }],
      generated_at: now(),
    });
  });

const meetingsGroup = (store: Store) => {
  const { space, need, meetingOf } = store;
  return HttpApiBuilder.group(SanctumApi, 'meetings', handlers =>
    handlers
      .handle('listMeetings', ({ urlParams }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'context:read');
          const all = space(access).meetings.filter(m => urlParams.state === undefined || m.state === urlParams.state);
          const { items, next_cursor } = offsetPage(all, urlParams.cursor, urlParams.limit);
          return { meetings: items, next_cursor };
        }),
      )
      .handle('getMeeting', ({ path }) => Effect.flatMap(CurrentAccess, access => meetingOf(access, path.meeting_id)))
      .handle('getTranscript', ({ path, urlParams }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          const meeting = yield* meetingOf(access, path.meeting_id);
          const own = [...space(access).segments.values()].filter(s => s.meeting_id === meeting.id).map(s => s.segment);
          const { items, next_cursor } = offsetPage(own, urlParams.cursor, urlParams.limit);
          return { meeting_id: meeting.id, boundary_revision: meeting.boundary_revision, segments: items, speakers: [], next_cursor };
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
            pieces: [],
            sample_rate: 16_000,
          });
        }),
      )
      .handle('closeMeeting', ({ path }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'context:write');
          const meeting = yield* meetingOf(access, path.meeting_id);
          const closed = { ...meeting, state: 'closed' as const, ended_at: meeting.ended_at ?? wire(ContextItem.fields.created_at, now()) };
          const meetings = space(access).meetings;
          meetings[meetings.indexOf(meeting)] = closed;
          return closed;
        }),
      )
      .handle('getNotes', ({ path }) => Effect.flatMap(CurrentAccess, access => fakeNotes(store, access, path.meeting_id)))
      .handle('exportMeeting', ({ path }) =>
        Effect.flatMap(CurrentAccess, access =>
          Effect.map(fakeNotes(store, access, path.meeting_id), notes => ({
            meeting_id: notes.meeting_id,
            notes_revision: notes.revision,
            format: 'markdown' as const,
            filename: `meeting-${notes.meeting_id}-notes-r${notes.revision}.md`,
            content: `# ${notes.title}\n\n## Summary\n\n${notes.summary}\n`,
          })),
        ),
      )
      // ponytail: boundary edits are the meetings slice's job (tested against MySQL); adapters only need the routes.
      .handle('mergeMeetings', () => unmodeled)
      .handle('splitMeeting', () => unmodeled)
      .handle('mapSpeaker', () => unmodeled),
  );
};

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
          return { items: hits.slice(0, urlParams.limit ?? 50) };
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
                kind: payload.kind ?? current.kind,
                text: payload.text ?? current.text,
                sources: payload.sources ?? current.sources,
                state: payload.state ?? current.state,
                supersedes: { id: current.id, revision: current.revision },
                author: { type: access.principal.kind === 'device' ? ('system' as const) : access.principal.kind, id: access.principal.id },
              };
              record(access, next, next.state === 'superseded' ? 'item_superseded' : 'item_revised');
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
          return { events: changes, next_cursor: `c${changes.at(-1)?.seq ?? after}` };
        }),
      )
      .handle('getSource', ({ path }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'context:read');
          if (path.source_id === HOLD_SOURCE_ID) {
            return yield* Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interrupted.push(path.source_id))));
          }
          const found = space(access).segments.get(path.source_id);
          if (found === undefined) return yield* new NotFound({ message: 'Source not found' });
          const segment = Schema.encodeSync(TranscriptSegment)(found.segment);
          return wire(Source, {
            kind: 'segment',
            id: segment.id,
            meeting_id: found.meeting_id,
            text: segment.text,
            revision: segment.revision,
            speaker_label: segment.speaker_label,
            source: segment.source,
            event_at: segment.created_at,
            start_ms: segment.source.sample_start / 16,
            end_ms: segment.source.sample_end / 16,
          });
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

const unmodelled = () => Effect.fail(new Unavailable({ message: 'Not modelled by the fake domain', retryable: false }));

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
                resolved_by: null,
                resolved_at: null,
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
      )
      // ponytail: no SDK/MCP/website test drives listing, resolution or grants yet; model them here once one does.
      .handle('listMeetingActions', unmodelled)
      .handle('resolveAction', unmodelled)
      .handle('createActionGrant', unmodelled)
      .handle('revokeActionGrant', unmodelled),
  );

/** The fake directory holds no profile embeddings, so every ranking is empty (the real ranking is tested against MySQL). */
const matchingGroup = ({ need }: Store) =>
  HttpApiBuilder.group(SanctumApi, 'matching', handlers =>
    handlers.handle('rankMatches', ({ path, urlParams }) =>
      Effect.gen(function* () {
        yield* need(yield* CurrentAccess, 'context:read');
        return { profile_id: path.profile_id, kind: urlParams.kind, matches: [] };
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
          const created = wire(AgentWithCredential, {
            agent: { id: randomUUID(), kind: 'agent', display_name: payload.display_name },
            credential: {
              id: randomUUID(),
              scopes: payload.scopes.filter(scope => access.scopes.includes(scope)),
              meetings: Schema.encodeSync(MeetingAccess)(payload.meetings),
              created_at: now(),
              expires_at: payload.expires_at,
              revoked_at: null,
              last_used_at: null,
            },
          });
          const token = `agent_${randomUUID()}`;
          space(access).agents.set(created.credential.id, created);
          tokens.set(token, {
            workspace_id: access.workspace_id,
            principal: created.agent,
            role: 'agent',
            scopes: created.credential.scopes,
            meetings: created.credential.meetings,
            permission_revision: access.permission_revision,
          });
          return { ...created, token };
        }),
      )
      .handle('revokeCredential', ({ path }) =>
        Effect.gen(function* () {
          const access = yield* CurrentAccess;
          yield* need(access, 'workspace:admin');
          const found = space(access).agents.get(path.key_id);
          if (found === undefined || found.agent.id !== path.agent_id) return yield* new NotFound({ message: 'Credential not found' });
          const revoked_at = found.credential.revoked_at ?? wire(ContextItem.fields.created_at, now());
          space(access).agents.set(path.key_id, { ...found, credential: { ...found.credential, revoked_at } });
          for (const [token, scope] of tokens) if (scope.principal.id === found.agent.id) tokens.delete(token);
        }),
      ),
  );

/** Capture is device-to-server, not an adapter surface; its routes exist only so the API layer is complete. */
const listenersGroup = HttpApiBuilder.group(SanctumApi, 'listeners', handlers =>
  handlers.handle('registerListener', () => unmodeled).handle('heartbeat', () => unmodeled).handle('putChunk', () => unmodeled),
);

/** Workspace deletion is an owner surface over MySQL rows, not an adapter surface; modeled only so the API layer is complete. */
const workspaceGroup = HttpApiBuilder.group(SanctumApi, 'workspace', handlers =>
  handlers.handle('getWorkspace', () => unmodeled).handle('deleteWorkspace', () => unmodeled).handle('restoreWorkspace', () => unmodeled),
);
const FakeWorkspaceOwner = Layer.effect(WorkspaceOwner, Effect.map(Authenticator, authenticator => Effect.flatMap(HttpServerRequest.HttpServerRequest, authenticator.authenticate)));

export function fakeDomain() {
  const store = createStore();
  const { space, tokens, interrupted } = store;
  return {
    groups: Layer.mergeAll(listenersGroup, meetingsGroup(store), contextGroup(store), integrationsGroup(store), actionsGroup(store), agentsGroup(store), matchingGroup(store)),
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
    addSegment: (access: AccessScope, meeting_id: Meeting['id'], text: string) => {
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
      space(access).segments.set(segment.id, { meeting_id, segment });
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
  HttpApiBuilder.api(SanctumApi).pipe(Layer.provide([health, SessionLive, workspaceGroup, domain.groups]), Layer.provide([AuthenticatedLive, FakeWorkspaceOwner]));

const SessionLive = HttpApiBuilder.group(SanctumApi, 'session', handlers => handlers.handle('getSession', () => CurrentAccess));
