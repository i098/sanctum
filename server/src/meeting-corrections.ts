/**
 * Manual boundary corrections (plan section 06, T13): revision-checked split and merge as one
 * transaction each. Sources are reassigned under a new boundary revision with an audit event;
 * original evidence, action IDs and receipts are never deleted, replayed or re-executed.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import {
  type AccessScope,
  Forbidden,
  type MeetingId,
  type MergeMeetings,
  MeetingId as MeetingIdSchema,
  RevisionConflict,
  type SourceRange,
  type SplitMeeting,
  type SplitResult,
  Unavailable,
} from '@sanctum/contracts';
import { Effect } from 'effect';
import { authorizeMeeting, requireScope } from './auth.ts';
import { appendContextEvent } from './context.ts';
import {
  currentRanges,
  dbFailures,
  dbTime,
  insertRanges,
  type MeetingRow,
  msToSample,
  OPEN_STATES,
  readMeeting,
  recordBoundary,
  scheduleFinalize,
  selectMeeting,
  type TimedRange,
} from './meeting-store.ts';

const lockedAtRevision = (access: AccessScope, meeting_id: MeetingId, expected: number) =>
  Effect.gen(function* () {
    const found = yield* selectMeeting(access.workspace_id, meeting_id, true);
    if (found._tag === 'None') return yield* Effect.die(new Error(`meeting ${meeting_id} vanished after authorization`));
    if (found.value.boundary_revision !== expected) {
      return yield* new RevisionConflict({ message: `Meeting ${meeting_id} is at boundary revision ${found.value.boundary_revision}`, current_revision: found.value.boundary_revision });
    }
    return found.value;
  });

/** Action IDs attached to the meetings, recorded in the audit so moved boundaries stay linked to their receipts. */
const linkedActions = (access: AccessScope, meeting_ids: ReadonlyArray<MeetingId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ id: string }>`SELECT id FROM actions WHERE workspace_id = ${access.workspace_id} AND meeting_id IN ${sql.in(meeting_ids)} ORDER BY id`;
    return rows.map(row => row.id);
  });

const source = ({ epoch_id, track, sample_start, sample_end }: TimedRange): SourceRange => ({ epoch_id, track, sample_start, sample_end });

/** Cuts every range at the split instant: same epoch by sample, other epochs (a second group device) by their sample clock. */
const partition = (ranges: ReadonlyArray<TimedRange>, at: SplitMeeting['at'], splitMs: number) => {
  const earlier: Array<TimedRange> = [];
  const later: Array<TimedRange> = [];
  for (const range of ranges) {
    const cut = range.epoch_id === at.epoch_id ? at.sample : msToSample(range.epoch, splitMs);
    if (cut > range.sample_start) earlier.push({ ...range, sample_end: Math.min(range.sample_end, cut) });
    if (cut < range.sample_end) later.push({ ...range, sample_start: Math.max(range.sample_start, cut) });
  }
  return { earlier, later };
};

const copyMeeting = (row: MeetingRow, input: { readonly state: MeetingRow['state']; readonly started_ms: number; readonly ended_at: string | null }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = MeetingIdSchema.make(randomUUID());
    yield* sql`INSERT INTO meetings (id, workspace_id, capture_group_id, listener_id, state, title, timezone, started_at, ended_at, boundary_revision, visibility, processing, created_at, updated_at)
      SELECT ${id}, workspace_id, capture_group_id, listener_id, ${input.state}, title, timezone, ${dbTime(input.started_ms)}, ${input.ended_at}, 1, visibility, processing,
        UTC_TIMESTAMP(6), UTC_TIMESTAMP(6) FROM meetings WHERE id = ${row.id}`;
    yield* sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
      SELECT workspace_id, ${id}, principal_id, access, granted_by, UTC_TIMESTAMP(6) FROM meeting_access WHERE meeting_id = ${row.id}`;
    return id;
  });

const boundaryChanged = (access: AccessScope, meeting_id: MeetingId, revision: number) =>
  appendContextEvent({ workspace_id: access.workspace_id, meeting_id, item: null, change: 'meeting_boundary_changed', actor: access.principal.id, source_revision: revision });

/**
 * Splits one meeting at a source position. The earlier part keeps the meeting ID under the next
 * boundary revision; the later part becomes a new meeting with the same access. An open meeting's
 * earlier part is sealed while the later part keeps listening.
 */
export const splitMeeting = (access: AccessScope, meeting_id: MeetingId, input: SplitMeeting) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* requireScope(access, 'context:write');
    yield* authorizeMeeting(access, meeting_id, 'write');
    const later_id = yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* lockedAtRevision(access, meeting_id, input.expected_revision);
        const ranges = yield* currentRanges(access.workspace_id, meeting_id);
        const anchor = ranges.find(range => range.epoch_id === input.at.epoch_id);
        const splitMs = anchor === undefined ? Number.NaN : anchor.start_ms + ((input.at.sample - anchor.sample_start) * 1000) / anchor.epoch.sample_rate;
        const { earlier, later } = partition(ranges, input.at, splitMs);
        if (anchor === undefined || earlier.length === 0 || later.length === 0) {
          return yield* new RevisionConflict({ message: 'Split point is outside the meeting at this boundary revision', current_revision: row.boundary_revision });
        }
        const revision = row.boundary_revision + 1;
        const open = OPEN_STATES.includes(row.state);
        const earlierEnd = Math.max(...earlier.map(range => range.start_ms + ((range.sample_end - range.sample_start) * 1000) / range.epoch.sample_rate));
        const later_id = yield* copyMeeting(row, { state: row.state, started_ms: Math.min(...later.map(range => Math.max(range.start_ms, splitMs))), ended_at: row.ended_at === null ? null : row.ended_at.slice(0, -1).replace('T', ' ') });
        yield* sql`UPDATE meetings SET boundary_revision = ${revision}, state = ${open || row.state === 'interrupted' ? 'closing' : row.state},
          ended_at = ${dbTime(earlierEnd)}, updated_at = UTC_TIMESTAMP(6) WHERE id = ${meeting_id}`;
        yield* insertRanges(access.workspace_id, meeting_id, revision, earlier.map(source));
        yield* insertRanges(access.workspace_id, later_id, 1, later.map(source));
        const decision = {
          decision: 'split' as const,
          source: { epoch_id: input.at.epoch_id, track: anchor.track, sample_start: input.at.sample, sample_end: input.at.sample + 1 },
          evidence: ['manual_split'],
          reason: `split by ${access.principal.display_name}`,
          uncertainty: 0,
          earlier_meeting_id: meeting_id,
          later_meeting_id: later_id,
          linked_actions: yield* linkedActions(access, [meeting_id]),
        };
        yield* recordBoundary({ meeting: row, revision, operation: 'split', decision, actor: access.principal.id });
        yield* recordBoundary({ meeting: { id: later_id, workspace_id: access.workspace_id }, revision: 1, operation: 'split', decision, actor: access.principal.id });
        yield* boundaryChanged(access, meeting_id, revision);
        yield* boundaryChanged(access, later_id, 1);
        yield* scheduleFinalize(row, access.principal.id);
        if (!open) yield* scheduleFinalize({ id: later_id, workspace_id: access.workspace_id }, access.principal.id);
        return later_id;
      }),
    );
    return { earlier: yield* readMeeting(access.workspace_id, meeting_id), later: yield* readMeeting(access.workspace_id, later_id) } satisfies SplitResult;
  }).pipe(dbFailures);

/** Explicit per-principal grants plus visibility; meetings merge only when these match exactly. */
const accessSignature = (row: MeetingRow) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const grants = yield* sql<{ principal_id: string; access: string }>`SELECT principal_id, access FROM meeting_access WHERE meeting_id = ${row.id} ORDER BY principal_id`;
    return JSON.stringify([row.visibility, grants.map(grant => [grant.principal_id, grant.access])]);
  });

/** Merges adjacent pieces on the same epoch/track so the merged meeting has one range per continuous span. */
const coalesce = (ranges: ReadonlyArray<SourceRange>) =>
  [...ranges]
    .sort((a, b) => a.epoch_id.localeCompare(b.epoch_id) || a.track - b.track || a.sample_start - b.sample_start)
    .reduce<Array<SourceRange>>((merged, range) => {
      const last = merged.at(-1);
      if (last !== undefined && last.epoch_id === range.epoch_id && last.track === range.track && last.sample_end === range.sample_start) {
        merged[merged.length - 1] = { ...last, sample_end: range.sample_end };
      } else merged.push(range);
      return merged;
    }, []);

/**
 * Folds `source` into `target` under new boundary revisions of both. The source meeting keeps its
 * ID (actions and context still reference it) but owns no ranges afterwards. Meetings whose access
 * differs are refused until an authorized person aligns it.
 */
export const mergeMeetings = (access: AccessScope, input: MergeMeetings) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* requireScope(access, 'context:write');
    const { target, source: from } = input;
    if (target.meeting_id === from.meeting_id) {
      return yield* new RevisionConflict({ message: 'A meeting cannot merge with itself', current_revision: target.expected_revision });
    }
    yield* authorizeMeeting(access, target.meeting_id, 'write');
    yield* authorizeMeeting(access, from.meeting_id, 'write');
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [first, second] = [target, from].sort((a, b) => a.meeting_id.localeCompare(b.meeting_id));
        const locked = [yield* lockedAtRevision(access, first!.meeting_id, first!.expected_revision), yield* lockedAtRevision(access, second!.meeting_id, second!.expected_revision)];
        const into = locked.find(row => row.id === target.meeting_id)!;
        const folded = locked.find(row => row.id === from.meeting_id)!;
        if ((yield* accessSignature(into)) !== (yield* accessSignature(folded))) {
          return yield* new Forbidden({ message: 'Meetings have different access; align access explicitly before merging' });
        }
        const ranges = [...(yield* currentRanges(access.workspace_id, into.id)), ...(yield* currentRanges(access.workspace_id, folded.id))];
        const open = OPEN_STATES.includes(into.state) || OPEN_STATES.includes(folded.state);
        const ended = open ? null : dbTime(Math.max(...ranges.map(range => range.end_ms)));
        const revision = into.boundary_revision + 1;
        yield* sql`UPDATE meetings SET boundary_revision = ${revision}, state = ${open ? 'active' : 'closing'}, ended_at = ${ended},
          started_at = ${dbTime(Math.min(...ranges.map(range => range.start_ms)))}, updated_at = UTC_TIMESTAMP(6) WHERE id = ${into.id}`;
        yield* sql`UPDATE meetings SET boundary_revision = ${folded.boundary_revision + 1}, state = 'closed', updated_at = UTC_TIMESTAMP(6) WHERE id = ${folded.id}`;
        yield* insertRanges(access.workspace_id, into.id, revision, coalesce(ranges.map(source)));
        const decision = {
          decision: 'continue' as const,
          source: source(ranges[0]!),
          evidence: ['manual_merge'],
          reason: `merged by ${access.principal.display_name}`,
          uncertainty: 0,
          target_meeting_id: into.id,
          merged_meeting_id: folded.id,
          linked_actions: yield* linkedActions(access, [into.id, folded.id]),
        };
        yield* recordBoundary({ meeting: into, revision, operation: 'merge', decision, actor: access.principal.id });
        yield* recordBoundary({ meeting: folded, revision: folded.boundary_revision + 1, operation: 'merge', decision, actor: access.principal.id });
        yield* boundaryChanged(access, into.id, revision);
        yield* boundaryChanged(access, folded.id, folded.boundary_revision + 1);
        if (!open) yield* scheduleFinalize(into, access.principal.id);
      }),
    );
    return yield* readMeeting(access.workspace_id, target.meeting_id);
  }).pipe(dbFailures);
