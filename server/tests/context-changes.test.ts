import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { expect, layer } from '@effect/vitest';
import {
  type AccessScope,
  type ContextItem,
  type ExtractionCandidate,
  IanaTimeZone,
  JobFailure,
  JobId,
  type PrincipalId,
  TranscriptSegmentId,
  Unavailable,
  UtcTimestamp,
} from '@sanctum/contracts';
import { Effect, Either, Layer, Ref } from 'effect';
import { getContextChanges } from '../src/context-changes.ts';
import { type ExtractionInput, commitMemory, refreshContext } from '../src/context-jobs.ts';
import { requestContextRefresh, requestMemoryCommit } from '../src/context-schedule.ts';
import { addContextItem, appendContextEvent, getContextSnapshot, reviseContextItem } from '../src/context.ts';
import { jobHandlers } from '../src/job-handlers.ts';
import { LlmClient } from '../src/llm.ts';
import { type FixtureMeeting, migratedDatabase, seedMeeting, seedSegment } from './support/context.ts';
import { seedWorkspace } from './support/fixtures.ts';

const LA = IanaTimeZone.make('America/Los_Angeles');

const add = (access: AccessScope, meeting: FixtureMeeting, segment: string, key: string, expected_revision: number) =>
  addContextItem(access, {
    meeting_id: meeting.meeting_id,
    expected_revision,
    kind: 'decision',
    text: `Decision ${key}`,
    sources: [{ segment_id: TranscriptSegmentId.make(segment), start_ms: 0, end_ms: 0 }],
    idempotency_key: key,
  });

const job = (meeting: FixtureMeeting, requested_by: PrincipalId | null) => ({ workspace_id: meeting.workspace_id, payload: { meeting_id: meeting.meeting_id }, requested_by });

/** Fake extractor: records its inputs and answers from `respond`, like the models slice's fixture LLM. */
const fakeExtractor = (respond: (input: ExtractionInput) => ReadonlyArray<ExtractionCandidate> | Unavailable) =>
  Effect.map(Ref.make<ReadonlyArray<ExtractionInput>>([]), calls => ({
    calls,
    extract: (input: ExtractionInput) =>
      Effect.flatMap(Ref.update(calls, list => [...list, input]), () => {
        const answer = respond(input);
        return answer instanceof Unavailable ? Effect.fail(answer) : Effect.succeed(answer);
      }),
  }));

const candidate = (segment: string, fields: Partial<ExtractionCandidate> = {}): ExtractionCandidate => ({
  kind: 'commitment',
  text: 'Dana sends the pilot plan',
  quote: 'send the pilot plan tomorrow',
  derivation: 'spoken',
  sources: [{ segment_id: TranscriptSegmentId.make(segment), start_ms: 0, end_ms: 0 }],
  time: { phrase: 'tomorrow', normalized: null, anchor: UtcTimestamp.make('2030-01-01T00:00:00Z'), timezone: LA, ambiguous: true },
  ...fields,
});

layer(migratedDatabase, { timeout: 120_000 })('context change feed', it => {
  it.effect('pages committed-order events through access-bound cursors', () =>
    Effect.gen(function*() {
      const [owner, agent, device] = yield* seedWorkspace('Feed', ['owner', 'agent', 'device']);
      const open = yield* seedMeeting(device!, { started_at: '2026-09-26 17:00:00' });
      const restricted = yield* seedMeeting(device!, { started_at: '2026-09-26 17:00:00', visibility: 'restricted' });
      const segment = yield* seedSegment(open, 1, 2, 'Point one.');
      const secret = yield* seedSegment(restricted, 1, 2, 'Secret.');
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
        VALUES (${owner!.workspace_id}, ${restricted.meeting_id}, ${owner!.principal.id}, 'owner', ${owner!.principal.id}, UTC_TIMESTAMP(6))`;
      const first = yield* add(agent!, open, segment, 'a', 0);
      yield* add(owner!, restricted, secret, 'hidden', 0);
      yield* reviseContextItem(owner!, first.id, { expected_revision: 1, idempotency_key: 'b', text: 'Revised' });

      const page = yield* getContextChanges(agent!, { limit: 1 });
      expect(page.events).toMatchObject([{ seq: 1, change: 'item_added', meeting_id: open.meeting_id, item: { id: first.id, revision: 1 }, actor: agent!.principal.id, permission_revision: 1 }]);
      const rest = yield* getContextChanges(agent!, { cursor: page.next_cursor });
      expect(rest.events.map(event => [event.seq, event.change])).toEqual([[3, 'item_revised']]);
      expect((yield* getContextChanges(agent!, { cursor: rest.next_cursor })).events).toEqual([]);
      expect((yield* getContextChanges(owner!, {})).events.map(event => event.seq)).toEqual([1, 2, 3]);

      const snapshot = yield* getContextSnapshot(agent!, open.meeting_id);
      yield* add(agent!, open, segment, 'c', snapshot.revision);
      expect((yield* getContextChanges(agent!, { cursor: snapshot.changes_cursor })).events.map(event => event.seq)).toEqual([4]);

      expect(yield* Effect.flip(getContextChanges(owner!, { cursor: page.next_cursor }))).toMatchObject({ _tag: 'NotFound' });
      expect(yield* Effect.flip(getContextChanges(agent!, { cursor: 'not-a-cursor' }))).toMatchObject({ _tag: 'NotFound' });
      const revoked = yield* Effect.flip(getContextChanges({ ...agent!, permission_revision: 2 }, { cursor: page.next_cursor }));
      expect(revoked).toMatchObject({ _tag: 'RevisionConflict', current_revision: 2 });
    }));

  it.effect('allocates gap-free sequences under concurrent appends and records boundary changes', () =>
    Effect.gen(function*() {
      const [owner, device] = yield* seedWorkspace('Seq', ['owner', 'device']);
      const meeting = yield* seedMeeting(device!, { started_at: '2026-09-26 17:00:00' });
      const sql = yield* SqlClient.SqlClient;
      const append = appendContextEvent({ workspace_id: owner!.workspace_id, meeting_id: meeting.meeting_id, item: null, change: 'meeting_boundary_changed', actor: owner!.principal.id, source_revision: 2 });
      const seqs = yield* Effect.all(Array.from({ length: 8 }, () => sql.withTransaction(append)), { concurrency: 8 });
      expect([...seqs].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      yield* Effect.either(sql.withTransaction(Effect.zipRight(append, Effect.fail('rolled back'))));
      const [row] = yield* sql<{ seq: string; revision: string }>`SELECT w.context_seq AS seq, m.context_revision AS revision FROM workspaces w
        JOIN meetings m ON m.workspace_id = w.id WHERE m.id = ${meeting.meeting_id}`;
      expect(row).toEqual({ seq: '8', revision: '8' });
      expect((yield* getContextChanges(owner!, {})).events.map(event => event.change)).toEqual(Array(8).fill('meeting_boundary_changed'));
    }));
});

layer(Layer.merge(migratedDatabase, Layer.succeed(LlmClient, null)), { timeout: 120_000 })('context jobs', it => {
  it.effect('extracts grounded candidates once, resolving delayed-upload time against the utterance', () =>
    Effect.gen(function*() {
      const [owner, device] = yield* seedWorkspace('Refresh', ['owner', 'device']);
      // 23:59:50 PDT on 29 September; the job runs long afterwards.
      const meeting = yield* seedMeeting(device!, { started_at: '2026-09-30 06:59:50' });
      const said = yield* seedSegment(meeting, 0, 5, 'I will send the pilot plan tomorrow.');
      const other = yield* seedSegment(meeting, 5, 8, 'Sounds good.');
      yield* seedSegment(meeting, 8, 9, 'Maybe', 'partial');
      const fake = yield* fakeExtractor(input => [
        candidate(said),
        candidate(other, { quote: 'we cancel the pilot', text: 'Pilot cancelled' }),
        candidate(randomUUID(), { text: 'Invented source' }),
        candidate(other, { quote: null, time: null, kind: 'open_question', text: 'Who reviews the plan?' }),
        ...(input.segments.length > 2 ? [candidate(said, { text: 'unexpected' })] : []),
      ]);
      const refresh = refreshContext(fake.extract);
      const outcome = yield* refresh(job(meeting, owner!.principal.id));
      expect(outcome).toEqual({ status: 'succeeded', result: { processed: 2, added: 2, rejected: 2, backlog: false } });
      const [call] = yield* Ref.get(fake.calls);
      expect(call!.segments.map(segment => segment.id)).toEqual([said, other]);
      expect(call!.meeting).toMatchObject({ id: meeting.meeting_id, timezone: 'America/Los_Angeles', started_at: '2026-09-30T06:59:50Z' });

      const snapshot = yield* getContextSnapshot(owner!, meeting.meeting_id);
      expect(snapshot.source_watermark).toEqual({ epoch_id: meeting.epoch_id, sample_end: 8 * 16_000 });
      const [spoken, question] = snapshot.items;
      expect(spoken).toMatchObject({
        kind: 'commitment',
        state: 'provisional',
        derivation: 'spoken',
        author: { type: 'system', id: owner!.principal.id },
        event_at: '2026-09-30T06:59:50Z',
        time: { phrase: 'tomorrow', normalized: '2026-09-30T07:00:00.000Z', anchor: '2026-09-30T06:59:50Z', timezone: 'America/Los_Angeles', ambiguous: false },
        sources: [{ segment_id: said, start_ms: 0, end_ms: 5000 }],
      });
      expect(question).toMatchObject({ derivation: 'inferred', time: null, text: 'Who reviews the plan?' });

      expect(yield* refresh(job(meeting, owner!.principal.id))).toEqual({ status: 'succeeded', result: { processed: 0, added: 0, rejected: 0, backlog: false } });
      expect(yield* Ref.get(fake.calls)).toHaveLength(1);
      const sql = yield* SqlClient.SqlClient;
      const [text] = yield* sql<{ text: string }>`SELECT text FROM transcript_segments WHERE id = ${said}`;
      expect(text).toEqual({ text: 'I will send the pilot plan tomorrow.' });
    }));

  it.effect('keeps sources and reports provider failures without fake success', () =>
    Effect.gen(function*() {
      const [owner, device] = yield* seedWorkspace('Failure', ['owner', 'device']);
      const meeting = yield* seedMeeting(device!, { started_at: '2026-09-26 17:00:00' });
      yield* seedSegment(meeting, 0, 3, 'We decided to pause hiring.');
      const down = yield* fakeExtractor(() => new Unavailable({ message: 'model provider unavailable', retryable: true }));
      const failed = yield* Effect.flip(refreshContext(down.extract)(job(meeting, owner!.principal.id)));
      expect(failed).toEqual(new JobFailure({ message: 'model provider unavailable', retryable: true }));
      expect((yield* getContextSnapshot(owner!, meeting.meeting_id)).source_watermark).toBeNull();
      expect(yield* Effect.flip(refreshContext(down.extract)(job(meeting, null)))).toMatchObject({ retryable: false });
      expect(yield* Effect.flip(refreshContext(down.extract)({ ...job(meeting, owner!.principal.id), payload: {} }))).toMatchObject({ retryable: false });
      // The unconfigured extractor in the worker registry reports Unavailable, never invented candidates.
      const registered = yield* Effect.flip(jobHandlers['context.refresh']!({ ...job(meeting, owner!.principal.id), workspace_id: owner!.workspace_id, id: JobId.make(randomUUID()), kind: 'context.refresh', work_key: meeting.meeting_id, source_revision: null, attempt: 1, lease_generation: 1 }));
      expect(registered).toMatchObject({ _tag: 'JobFailure', retryable: true });
      const recovered = yield* fakeExtractor(input => [candidate(input.segments[0]!.id, { quote: 'pause hiring', time: null, kind: 'decision', text: 'Hiring paused' })]);
      expect(yield* refreshContext(recovered.extract)(job(meeting, owner!.principal.id))).toMatchObject({ status: 'succeeded', result: { added: 1 } });
    }));

  it.effect('processes a long backlog in bounded rounds', () =>
    Effect.gen(function*() {
      const [owner, device] = yield* seedWorkspace('Backlog', ['owner', 'device']);
      const meeting = yield* seedMeeting(device!, { started_at: '2026-09-26 17:00:00' });
      yield* Effect.forEach(Array.from({ length: 105 }, (_, index) => index), index => seedSegment(meeting, index, index + 1, `Turn ${index}.`), { discard: true });
      const fake = yield* fakeExtractor(() => []);
      const refresh = refreshContext(fake.extract);
      expect(yield* refresh(job(meeting, owner!.principal.id))).toMatchObject({ status: 'paused', resume_after_ms: 0 });
      expect(yield* refresh(job(meeting, owner!.principal.id))).toMatchObject({ status: 'succeeded', result: { processed: 5 } });
      expect((yield* Ref.get(fake.calls)).map(call => call.segments.length)).toEqual([100, 5]);
    }));

  it.effect('distills settled items into memory at close and is safe to retry', () =>
    Effect.gen(function*() {
      const [owner, agent, device] = yield* seedWorkspace('Distill', ['owner', 'agent', 'device']);
      const meeting = yield* seedMeeting(device!, { started_at: '2026-09-26 17:00:00' });
      const early = yield* seedSegment(meeting, 0, 4, 'Pilot stays with the current test group.');
      const manual = yield* add(agent!, meeting, early, 'manual', 0);
      const late = yield* seedSegment(meeting, 4, 8, 'Should we invite finance?');
      const fake = yield* fakeExtractor(input =>
        input.segments.some(segment => segment.id === late)
          ? [candidate(late, { quote: 'invite finance', kind: 'open_question', text: 'Invite finance?', time: null })]
          : [],
      );
      const commit = commitMemory(fake.extract);
      const outcome = yield* commit(job(meeting, owner!.principal.id));
      expect(outcome).toMatchObject({ status: 'succeeded', result: { processed: 2, added: 1, committed: 1 } });
      const snapshot = yield* getContextSnapshot(owner!, meeting.meeting_id);
      const byText = Object.fromEntries(snapshot.items.map(item => [item.text, item] as const)) as Record<string, ContextItem>;
      expect(byText[manual.text]).toMatchObject({ revision: 2, state: 'committed', author: manual.author, sources: manual.sources, event_at: manual.event_at, supersedes: { id: manual.id, revision: 1 } });
      expect(byText['Invite finance?']).toMatchObject({ state: 'provisional' });
      const changes = yield* getContextChanges(owner!, {});
      expect(changes.events.at(-1)).toMatchObject({ change: 'item_revised', actor: owner!.principal.id, item: { id: manual.id, revision: 2 } });

      expect(yield* commit(job(meeting, owner!.principal.id))).toMatchObject({ status: 'succeeded', result: { processed: 0, committed: 0 } });
      expect((yield* getContextChanges(owner!, {})).events).toHaveLength(changes.events.length);
      const sql = yield* SqlClient.SqlClient;
      const [processing] = yield* sql<{ memory: string }>`SELECT processing->>'$.memory' AS memory FROM meetings WHERE id = ${meeting.meeting_id}`;
      expect(processing).toEqual({ memory: 'complete' });
    }));

  it.effect('coalesces context jobs to one active row per meeting', () =>
    Effect.gen(function*() {
      const [owner, device] = yield* seedWorkspace('Coalesce', ['owner', 'device']);
      const meeting = yield* seedMeeting(device!, { started_at: '2026-09-26 17:00:00' });
      const request = { workspace_id: meeting.workspace_id, meeting_id: meeting.meeting_id, requested_by: owner!.principal.id };
      const ids = yield* Effect.all([1, 1, 4].map(new_turns => requestContextRefresh({ ...request, new_turns })));
      expect(new Set(ids).size).toBe(1);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ kind: string; due: string }>`SELECT kind, CAST(available_at <= UTC_TIMESTAMP(6) AS CHAR) AS due FROM jobs WHERE workspace_id = ${meeting.workspace_id}`;
      expect(rows).toEqual([{ kind: 'context.refresh', due: '1' }]);
      yield* sql`UPDATE jobs SET status = 'running' WHERE id = ${ids[0]!}`;
      yield* requestContextRefresh({ ...request, new_turns: 1 });
      yield* requestMemoryCommit(request);
      const after = yield* sql<{ kind: string; status: string }>`SELECT kind, status FROM jobs WHERE workspace_id = ${meeting.workspace_id} ORDER BY kind`;
      expect(after).toEqual([{ kind: 'context.refresh', status: 'running' }, { kind: 'memory.commit', status: 'pending' }]);
      const both = yield* Effect.all([requestMemoryCommit(request), requestMemoryCommit(request)], { concurrency: 2 }).pipe(Effect.either);
      expect(Either.isRight(both) && new Set(both.right).size).toBe(1);
    }));
});
