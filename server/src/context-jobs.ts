/**
 * Durable context work on the job ledger (plan section 08). `context.refresh` turns bounded new
 * final transcript into provisional, source-validated items; `memory.commit` drains the rest and
 * distills settled items into committed memory at close or an explicit checkpoint. The ledger's
 * work key is the meeting, so one job per meeting and kind is active and new arrivals coalesce
 * into it. Model calls run outside every transaction, so a slow model never blocks capture.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient, type SqlError } from '@effect/sql';
import {
 CaptureEpochId,
 ContextItemId,
 type ContextItem,
 type ExtractionCandidate,
 JobFailure,
 Meeting,
 MeetingId,
 MeetingProcessing,
 type PrincipalId,
 type TranscriptSegment,
 type Unavailable,
 type WorkspaceId,
} from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { decodeRows, type SegmentRow, segmentRows } from './context-changes.ts';
import { resolveTime } from './context-time.ts';
import { lockMeeting, meetingItems, type NewItem, writeItem } from './context.ts';
import { DbJson, DbSafeInt, DbUtc } from './db.ts';
import type { ExtractionInput } from './extraction.ts';
import { EpochAnchorRow, MeetingRow, toSegment } from './meeting-evidence.ts';

/** The ledger fields a context job reads; `jobHandlers` checks it against the full `ClaimedJob` contract. */
interface LedgerJob {
 readonly workspace_id: WorkspaceId;
 readonly payload: unknown;
 readonly requested_by: PrincipalId | null;
}

/** Structured extraction as context consumes it (the models slice's `extractCandidates`). */
export type Extractor<R> = (input: ExtractionInput) => Effect.Effect<ReadonlyArray<ExtractionCandidate>, Unavailable, R>;


/** Final segments one refresh reads; the rest wait for the next round. */
const BATCH_SEGMENTS = 100;

const Payload = Schema.Struct({ meeting_id: MeetingId });


interface Target {
 readonly workspace_id: WorkspaceId;
 readonly meeting_id: MeetingId;
 readonly actor: PrincipalId;
}

const words = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * Keeps a candidate only if every cited segment is in this batch and any quote appears in the
 * cited text. A "spoken" claim without a quote is kept as an inference. Relative time is
 * re-resolved against the first cited utterance in the meeting timezone.
 */
function grounded(candidate: ExtractionCandidate, batch: ReadonlyMap<string, SegmentRow>, meeting: Meeting, actor: PrincipalId): ReadonlyArray<NewItem> {
 const segments = candidate.sources.flatMap(source => batch.get(source.segment_id) ?? []);
 if (segments.length !== candidate.sources.length) return [];
 if (candidate.quote !== null && !words(segments.map(segment => segment.text).join(' ')).includes(words(candidate.quote))) return [];
 const event_at = segments.map(segment => segment.event_at).sort()[0]!;
 return [{
  id: ContextItemId.make(randomUUID()),
  revision: 1,
  meeting_id: meeting.id,
  kind: candidate.kind,
  text: candidate.text,
  state: 'provisional',
  derivation: candidate.quote === null ? 'inferred' : candidate.derivation,
  event_at,
  valid_from: null,
  valid_until: null,
  time: candidate.time === null ? null : resolveTime(candidate.time.phrase, event_at, meeting.timezone),
  author: { type: 'system', id: actor },
  sources: segments.map(segment => ({ segment_id: segment.id, start_ms: segment.start_ms, end_ms: segment.end_ms })),
  supersedes: null,
 }];
}


/**
 * One refresh round: the next unprocessed final segments of the meeting, extraction outside
 * any transaction, then items and processed marks committed together. A retry of a committed
 * round finds its segments marked and writes nothing; a boundary change mid-round retries.
 */
const refreshMeeting = <R>(extract: Extractor<R>, target: Target) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const { workspace_id, meeting_id } = target;
  const [meeting] = yield* decodeRows(MeetingRow, sql`SELECT * FROM meetings WHERE workspace_id = ${workspace_id} AND id = ${meeting_id}`);
  if (meeting === undefined) return yield* new JobFailure({ message: 'Meeting not found', retryable: false });
  const pending = yield* segmentRows(
   workspace_id,
   sql`m.id = ${meeting_id} AND s.status = 'final' AND NOT EXISTS (SELECT 1 FROM context_processed_segments p
        WHERE p.workspace_id = s.workspace_id AND p.meeting_id = m.id AND p.segment_id = s.id)`,
   BATCH_SEGMENTS + 1,
  );
  const batch = pending.slice(0, BATCH_SEGMENTS);
  if (batch.length === 0) return { processed: 0, added: 0, rejected: 0, backlog: false };
  const { items } = yield* meetingItems(workspace_id, meeting_id);
  const epochs = yield* decodeRows(
   EpochAnchorRow,
   sql`SELECT id AS epoch_id, sample_rate, sample_start, captured_at FROM capture_epochs
          WHERE workspace_id = ${workspace_id} AND ${sql.in('id', [...new Set(batch.map(segment => segment.epoch_id))])}`,
  );
  const candidates = yield* extract({ meeting, segments: batch.map(toSegment), snapshot: items, epochs }).pipe(
   Effect.mapError(error => new JobFailure({ message: error.message, retryable: error.retryable })),
  );
  const byId = new Map(batch.map(segment => [segment.id as string, segment]));
  const accepted = candidates.flatMap(candidate => grounded(candidate, byId, meeting, target.actor));
  const ids = batch.map(segment => segment.id);
  const added = yield* sql.withTransaction(
   Effect.gen(function*() {
    const lock = yield* lockMeeting(workspace_id, meeting_id);
    if (lock?.boundary_revision !== meeting.boundary_revision) return yield* new JobFailure({ message: 'Meeting boundaries changed during extraction', retryable: true });
    const [marked] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM context_processed_segments
          WHERE workspace_id = ${workspace_id} AND meeting_id = ${meeting_id} AND ${sql.in('segment_id', ids)}`;
    if (Number(marked!.n) > 0) return 0;
    yield* sql`INSERT INTO context_processed_segments (workspace_id, meeting_id, segment_id, processed_at)
          SELECT workspace_id, ${meeting_id}, id, UTC_TIMESTAMP(6) FROM transcript_segments WHERE workspace_id = ${workspace_id} AND ${sql.in('id', ids)}`;
    yield* Effect.forEach(accepted, item => writeItem(workspace_id, item, { change: 'item_added', source_revision: meeting.boundary_revision }), { discard: true });
    return accepted.length;
   }),
  );
  return { processed: batch.length, added, rejected: candidates.length - accepted.length, backlog: pending.length > BATCH_SEGMENTS };
 });

/**
 * Commits every settled provisional item (all but open questions) as a new revision that keeps
 * its author, text, sources and time; the event records the distilling actor. Re-running finds
 * nothing provisional and changes nothing.
 */
const distill = (target: Target) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const { workspace_id, meeting_id } = target;
  return yield* sql.withTransaction(
   Effect.gen(function*() {
    const lock = yield* lockMeeting(workspace_id, meeting_id);
    if (lock === undefined) return yield* new JobFailure({ message: 'Meeting not found', retryable: false });
    const { items } = yield* meetingItems(workspace_id, meeting_id);
    const settled = items.filter(item => item.state === 'provisional' && item.kind !== 'open_question');
    yield* Effect.forEach(
     settled,
     item =>
      writeItem(
       workspace_id,
       { ...item, revision: item.revision + 1, state: 'committed', supersedes: { id: item.id, revision: item.revision } },
       { change: 'item_revised', actor: target.actor, source_revision: lock.boundary_revision },
      ),
     { discard: true },
    );
    yield* sql`UPDATE meetings SET processing = JSON_SET(processing, '$.memory', 'complete'), updated_at = UTC_TIMESTAMP(6)
          WHERE workspace_id = ${workspace_id} AND id = ${meeting_id}`;
    return settled.length;
   }),
  );
 });

/** Decodes the job's meeting and acting principal, runs `work`, and turns database failures into retries. */
const contextJob = <A, R>(work: (target: Target) => Effect.Effect<A, JobFailure | SqlError.SqlError, R>) => (job: LedgerJob) =>
 Effect.gen(function*() {
  const { meeting_id } = yield* Schema.decodeUnknown(Payload)(job.payload).pipe(Effect.mapError(() => new JobFailure({ message: 'Invalid context job payload', retryable: false })));
  if (job.requested_by === null) return yield* new JobFailure({ message: 'Context jobs act for a principal; requested_by is missing', retryable: false });
  return yield* work({ workspace_id: job.workspace_id, meeting_id, actor: job.requested_by });
 }).pipe(Effect.catchTag('SqlError', error => new JobFailure({ message: error.message, retryable: true })));

/** A bounded round left segments behind: run again right away rather than wait for new speech. */
const BACKLOG = { status: 'paused', resume_after_ms: 0, reason: 'More transcript is waiting for context extraction' } as const;

export const refreshContext = <R>(extract: Extractor<R>) =>
 contextJob(target => Effect.map(refreshMeeting(extract, target), round => (round.backlog ? BACKLOG : { status: 'succeeded' as const, result: round })));

export const commitMemory = <R>(extract: Extractor<R>) =>
 contextJob(target =>
  Effect.gen(function*() {
   const round = yield* refreshMeeting(extract, target);
   if (round.backlog) return BACKLOG;
   return { status: 'succeeded' as const, result: { ...round, committed: yield* distill(target) } };
  }),
 );
