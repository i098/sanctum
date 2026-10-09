/**
 * Automatic meeting lifecycle (plan section 06, T12). Media's live session calls the two hooks
 * below; meetings open, promote, seal and finalize from transcript evidence, independently of
 * listener lifetime. Source ownership lives in `meeting_ranges` per boundary revision.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient, SqlSchema } from '@effect/sql';
import {
  type AccessScope,
  type BoundaryDecision,
  type EpochEndReason,
  type ListMeetingsParams,
  type Meeting,
  MeetingId,
  type MeetingPage,
  type MeetingRange,
  NotFound,
  type PrincipalId,
  type SourceRange,
  type TranscriptSegment,
  Unavailable,
  type WorkspaceId,
} from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { authorizeMeeting, listVisibleMeetingIds, requireScope } from './auth.ts';
import { evaluateBoundary, LOW_CONFIDENCE, PROMOTE_AFTER_MS, type Utterance } from './boundaries.ts';
import { engineeringDefaults } from './config.ts';
import { DbUtc } from './db.ts';
import { enqueueJob } from './jobs.ts';
import {
  asJobResult,
  currentRanges,
  dbFailures,
  dbTime,
  type EpochClock,
  type TimedRange,
  loadEpochs,
  MeetingJobPayload,
  type MeetingJob,
  MeetingRow,
  meetingColumns,
  nextOwnedStart,
  OPEN_STATES,
  PENDING_PROCESSING,
  recordBoundary,
  sampleMs,
  scheduleFinalize,
  selectMeeting,
  toMeeting,
  msToSample,
} from './meeting-store.ts';

interface CaptureKey {
  readonly workspace_id: WorkspaceId;
  readonly listener_id: string;
  readonly capture_group_id: string | null;
}

interface OpenMeeting {
  readonly row: MeetingRow;
  readonly last: { readonly epoch: EpochClock; readonly track: number; readonly sample_end: number } | null;
  readonly tail: ReadonlyArray<Utterance>;
  readonly opening_uncertainty: number;
}

/** Serializes hooks and manual closes for one listener, or for the capture group its devices share. */
const lockCaptureKey = (key: CaptureKey) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    key.capture_group_id === null
      ? sql`SELECT id FROM listeners WHERE workspace_id = ${key.workspace_id} AND id = ${key.listener_id} FOR UPDATE`
      : sql`SELECT id FROM capture_groups WHERE workspace_id = ${key.workspace_id} AND id = ${key.capture_group_id} FOR UPDATE`,
  );

const findOpenRow = (key: CaptureKey) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: MeetingRow,
      execute: () => sql`SELECT ${sql.literal(meetingColumns())} FROM meetings WHERE workspace_id = ${key.workspace_id} AND state IN ${sql.in(OPEN_STATES)} AND ${
          key.capture_group_id === null ? sql`listener_id = ${key.listener_id} AND capture_group_id IS NULL` : sql`capture_group_id = ${key.capture_group_id}`
        } ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
    })(undefined),
  );

const TailRow = Schema.Struct({ text: Schema.String, speaker_label: Schema.NullOr(Schema.String), provider_connection_id: Schema.NullOr(Schema.String) });

/** The open meeting with its last speech position, recent utterances and how confidently it was opened. */
const loadOpen = (key: CaptureKey) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const found = yield* findOpenRow(key);
    if (found._tag === 'None') return null;
    const row = found.value;
    const last = (yield* currentRanges(row.workspace_id, row.id)).reduce<TimedRange | null>((latest, range) => (latest === null || range.end_ms > latest.end_ms ? range : latest), null);
    const tail = last === null ? [] : yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: TailRow,
      execute: () => sql`SELECT text, speaker_label, provider_connection_id FROM transcript_segments
        WHERE workspace_id = ${row.workspace_id} AND epoch_id = ${last.epoch_id} AND track = ${last.track} AND status = 'final'
          AND sample_start >= ${last.sample_start} AND sample_end <= ${last.sample_end} ORDER BY sample_end DESC LIMIT 2`,
    })(undefined);
    const [opening] = yield* sql<{ uncertainty: number | null }>`SELECT JSON_EXTRACT(decision, '$.uncertainty') AS uncertainty FROM boundary_events
      WHERE meeting_id = ${row.id} AND operation IN ('start', 'split') ORDER BY created_at LIMIT 1`;
    return {
      row,
      last: last === null ? null : { epoch: last.epoch, track: last.track, sample_end: last.sample_end },
      tail: [...tail].reverse(),
      opening_uncertainty: Number(opening?.uncertainty ?? 0),
    } satisfies OpenMeeting;
  });

const OwnerRow = Schema.Struct({ meeting_id: MeetingId, sample_start: Schema.Number, sample_end: Schema.Number });

/** Current-revision range covering the first sample of `source`, if any meeting owns it. */
const ownerOf = (workspace_id: WorkspaceId, source: SourceRange) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: OwnerRow,
      execute: () => sql`SELECT r.meeting_id, CAST(r.sample_start AS DOUBLE) AS sample_start, CAST(r.sample_end AS DOUBLE) AS sample_end FROM meeting_ranges r
        JOIN meetings m ON m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision
        WHERE r.workspace_id = ${workspace_id} AND r.epoch_id = ${source.epoch_id} AND r.track = ${source.track}
          AND r.sample_start <= ${source.sample_start} AND r.sample_end > ${source.sample_start} LIMIT 1`,
    })(undefined),
  );

interface Span {
  readonly sample_start: number;
  readonly sample_end: number;
}

/** Claim bounds for `source`: clipped before the next other owner; `extend` names the latest range to stretch when nothing else sits between. */
const planClaim = (source: SourceRange, latest: Span | undefined, next: number | null) => {
  const end = Math.min(source.sample_end, next ?? Number.MAX_SAFE_INTEGER);
  if (latest === undefined) return { from: source.sample_start, end, extend: null };
  return { from: Math.max(latest.sample_end, source.sample_start), end, extend: next === null || next >= source.sample_end ? latest.sample_start : null };
};

/**
 * Makes the meeting own `[sample_start, sample_end)`: bridges the pause after its latest range on
 * the same epoch/track when nothing else owns the gap, otherwise inserts a range clipped so it
 * never overlaps another owner. Returns the owned end.
 */
const claimSource = (row: Pick<MeetingRow, 'id' | 'workspace_id' | 'boundary_revision'>, source: SourceRange) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [latest] = yield* sql<Span>`SELECT CAST(sample_start AS DOUBLE) AS sample_start, CAST(sample_end AS DOUBLE) AS sample_end
      FROM meeting_ranges WHERE meeting_id = ${row.id} AND boundary_revision = ${row.boundary_revision} AND epoch_id = ${source.epoch_id} AND track = ${source.track}
        AND sample_start <= ${source.sample_start} ORDER BY sample_start DESC LIMIT 1`;
    const plan = planClaim(source, latest, yield* nextOwnedStart(row.workspace_id, source, latest?.sample_start ?? source.sample_start));
    if (plan.end <= plan.from) return plan.from;
    const owned = sql.and([sql`meeting_id = ${row.id}`, sql`boundary_revision = ${row.boundary_revision}`, sql`epoch_id = ${source.epoch_id}`, sql`track = ${source.track}`]);
    yield* plan.extend === null
      ? sql`INSERT INTO meeting_ranges ${sql.insert({ workspace_id: row.workspace_id, meeting_id: row.id, boundary_revision: row.boundary_revision, ...source, sample_start: plan.from, sample_end: plan.end })}`
      : sql`UPDATE meeting_ranges SET sample_end = ${plan.end} WHERE ${owned} AND sample_start = ${plan.extend}`;
    return plan.end;
  });

type Cue = Pick<BoundaryDecision, 'evidence' | 'reason' | 'uncertainty'>;

/** Terminal capture position; the meeting's last range on that epoch/track is extended up to it. */
type Watermark = Pick<SourceRange, 'epoch_id' | 'track' | 'sample_end'>;

/**
 * Seals an open meeting: extends its range to the terminal capture watermark when given, records
 * the close and schedules final work. The listener is untouched and can open the next meeting.
 */
const sealMeeting = (
  row: MeetingRow,
  input: { readonly watermark: Watermark | null; readonly state: 'closing' | 'interrupted'; readonly cue: Cue; readonly actor: PrincipalId | null },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* currentRanges(row.workspace_id, row.id);
    const { watermark } = input;
    const tail = watermark === null ? undefined : before.filter(range => range.epoch_id === watermark.epoch_id && range.track === watermark.track).at(-1);
    if (watermark !== null && tail !== undefined && watermark.sample_end > tail.sample_end) {
      yield* claimSource(row, { ...watermark, sample_start: tail.sample_end });
    }
    const ranges = yield* currentRanges(row.workspace_id, row.id);
    const last = ranges.reduce((latest, range) => (range.end_ms > latest.end_ms ? range : latest), ranges[0]!);
    yield* sql`UPDATE meetings SET state = ${input.state}, ended_at = ${dbTime(last.end_ms)}, updated_at = UTC_TIMESTAMP(6)
      WHERE id = ${row.id} AND state IN ${sql.in(OPEN_STATES)}`;
    const { epoch: _epoch, start_ms: _start, end_ms: _end, ...source } = last;
    const operation = input.state === 'closing' ? 'close' : 'interrupt';
    yield* recordBoundary({ meeting: row, revision: row.boundary_revision, operation, decision: { decision: 'close', source, ...input.cue }, actor: input.actor });
    yield* scheduleFinalize(row, input.actor);
  });

const promoteIfEstablished = (open: OpenMeeting, decision: BoundaryDecision, endMs: number) =>
  Effect.gen(function* () {
    const established = decision.evidence.includes('explicit_start') || endMs - Date.parse(open.row.started_at) >= PROMOTE_AFTER_MS;
    if (open.row.state !== 'provisional' || open.opening_uncertainty >= LOW_CONFIDENCE || !established) return open;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE meetings SET state = 'active', updated_at = UTC_TIMESTAMP(6) WHERE id = ${open.row.id} AND state = 'provisional'`;
    yield* recordBoundary({ meeting: open.row, revision: open.row.boundary_revision, operation: 'promote', decision, actor: null });
    return { ...open, row: { ...open.row, state: 'active' as const } };
  });

/** A detected meeting starts restricted; only the principal of the capturing listener gets `owner` access. */
const createMeeting = (key: CaptureKey, epoch: EpochClock, segment: TranscriptSegment, decision: BoundaryDecision) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = MeetingId.make(randomUUID());
    const started = dbTime(sampleMs(epoch, segment.source.sample_start));
    yield* sql`INSERT INTO meetings (id, workspace_id, capture_group_id, listener_id, state, timezone, started_at, boundary_revision, visibility, processing, created_at, updated_at)
      VALUES (${id}, ${key.workspace_id}, ${key.capture_group_id}, ${key.listener_id}, 'provisional', ${epoch.timezone}, ${started}, 1, 'restricted',
        ${JSON.stringify(PENDING_PROCESSING)}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    yield* sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
      SELECT workspace_id, ${id}, principal_id, 'owner', principal_id, UTC_TIMESTAMP(6) FROM listeners WHERE workspace_id = ${key.workspace_id} AND id = ${key.listener_id}`;
    const row = Schema.decodeUnknownSync(MeetingRow)({
      id, workspace_id: key.workspace_id, listener_id: key.listener_id, capture_group_id: key.capture_group_id, state: 'provisional', title: null,
      started_at: started, ended_at: null, timezone: epoch.timezone, boundary_revision: 1, visibility: 'restricted', processing: PENDING_PROCESSING,
    });
    const end = yield* claimSource(row, segment.source);
    yield* recordBoundary({ meeting: row, revision: 1, operation: 'start', decision, actor: null });
    return { row, last: { epoch, track: segment.source.track, sample_end: end }, tail: [], opening_uncertainty: decision.uncertainty } satisfies OpenMeeting;
  });

const utteranceOf = (segment: TranscriptSegment): Utterance => ({
  text: segment.text,
  speaker_label: segment.speaker_label,
  provider_connection_id: segment.provider_connection_id,
});

/** Silence between the open meeting's last speech and `sample`: sample arithmetic on one epoch, anchored wall clock across epochs. */
const gapMs = (open: OpenMeeting, epoch: EpochClock, sample: number) => {
  if (open.last === null) return 0;
  return open.last.epoch.id === epoch.id
    ? ((sample - open.last.sample_end) * 1000) / epoch.sample_rate
    : sampleMs(epoch, sample) - sampleMs(open.last.epoch, open.last.sample_end);
};

/** The open meeting after it claimed `segment` up to `end`: latest speech position and recent utterances. */
const advance = (open: OpenMeeting, epoch: EpochClock, segment: TranscriptSegment, end: number): OpenMeeting => {
  const keep = open.last !== null && open.last.epoch.id === epoch.id && open.last.sample_end > end;
  return { ...open, last: keep ? open.last : { epoch, track: segment.source.track, sample_end: end }, tail: [...open.tail, utteranceOf(segment)].slice(-2) };
};

/** A segment starting inside owned audio only extends the open meeting past its range; anyone else's audio is left alone. */
const extendOwned = (open: OpenMeeting | null, owner: typeof OwnerRow.Type, epoch: EpochClock, segment: TranscriptSegment) =>
  open === null || owner.meeting_id !== open.row.id || segment.source.sample_end <= owner.sample_end
    ? Effect.succeed(open)
    : Effect.map(claimSource(open.row, segment.source), end => advance(open, epoch, segment, end));

/** Speech that belongs to the open meeting; audio from before it started (late ASR of a sealed meeting) is not taken. */
const continueMeeting = (open: OpenMeeting, epoch: EpochClock, segment: TranscriptSegment, decision: BoundaryDecision) =>
  Effect.gen(function* () {
    if (sampleMs(epoch, segment.source.sample_start) < Date.parse(open.row.started_at)) return open;
    const advanced = advance(open, epoch, segment, yield* claimSource(open.row, segment.source));
    return yield* promoteIfEstablished(advanced, decision, sampleMs(epoch, segment.source.sample_end));
  });

const placeUnowned = (key: CaptureKey, epoch: EpochClock, segment: TranscriptSegment, open: OpenMeeting | null) =>
  Effect.gen(function* () {
    const gap = open === null ? null : gapMs(open, epoch, segment.source.sample_start);
    const decision = evaluateBoundary({ source: segment.source, incoming: utteranceOf(segment), tail: open?.tail ?? [], gap_ms: gap });
    if (open !== null && decision.decision === 'continue') return yield* continueMeeting(open, epoch, segment, decision);
    if (decision.decision !== 'start') return open;
    if (open !== null) yield* sealMeeting(open.row, { watermark: null, state: 'closing', cue: decision, actor: null });
    const created = yield* createMeeting(key, epoch, segment, decision);
    return yield* promoteIfEstablished({ ...created, tail: [utteranceOf(segment)] }, decision, sampleMs(epoch, segment.source.sample_end));
  });

const placeSegment = (key: CaptureKey, epoch: EpochClock, segment: TranscriptSegment, open: OpenMeeting | null) =>
  Effect.flatMap(ownerOf(key.workspace_id, segment.source), owner =>
    owner._tag === 'Some' ? extendOwned(open, owner.value, epoch, segment) : placeUnowned(key, epoch, segment, open),
  );

/** Media hook: final transcript segments for one listener, in any order; replays of owned sources are no-ops. */
export const onFinalSegments = (event: {
  readonly workspace_id: WorkspaceId;
  readonly listener_id: string;
  readonly capture_group_id: string | null;
  readonly segments: ReadonlyArray<TranscriptSegment>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const finals = event.segments.filter(segment => segment.status === 'final');
    if (finals.length === 0) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockCaptureKey(event);
        const epochs = yield* loadEpochs(event.workspace_id, [...new Set(finals.map(segment => segment.source.epoch_id))]);
        const known = finals.filter(segment => epochs.has(segment.source.epoch_id));
        const at = (segment: TranscriptSegment) => sampleMs(epochs.get(segment.source.epoch_id)!, segment.source.sample_start);
        let open: OpenMeeting | null = yield* loadOpen(event);
        for (const segment of known.sort((a, b) => at(a) - at(b))) {
          open = yield* placeSegment(event, epochs.get(segment.source.epoch_id)!, segment, open);
        }
      }),
    );
  }).pipe(Effect.catchTag('ParseError', error => Effect.die(error)));

/**
 * Media hook: a capture epoch ended. Closing or an interruption seals the open meeting at the capture end;
 * pauses leave it open. A meeting holding audio captured after the ended epoch (a late archive epoch) stays open.
 */
export const onCaptureEnded = (event: {
  readonly workspace_id: WorkspaceId;
  readonly listener_id: string;
  readonly epoch_id: string;
  readonly track: number;
  readonly sample_end: number;
  readonly reason: typeof EpochEndReason.Type;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (event.reason !== 'close' && event.reason !== 'interrupted') return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [listener] = yield* sql<{ capture_group_id: string | null }>`SELECT capture_group_id FROM listeners WHERE workspace_id = ${event.workspace_id} AND id = ${event.listener_id}`;
        if (listener === undefined) return;
        const key = { workspace_id: event.workspace_id, listener_id: event.listener_id, capture_group_id: listener.capture_group_id };
        yield* lockCaptureKey(key);
        if (key.capture_group_id !== null) {
          const [lease] = yield* sql<{ holder: string | null; live: number }>`SELECT lease_listener_id AS holder, COALESCE(lease_expires_at > UTC_TIMESTAMP(6), 0) AS live
            FROM capture_groups WHERE id = ${key.capture_group_id}`;
          if (lease !== undefined && lease.holder !== event.listener_id && Number(lease.live) === 1) return;
        }
        const open = yield* findOpenRow(key);
        if (open._tag === 'None') return;
        const later = yield* sql`
          SELECT 1 FROM meeting_ranges r
          JOIN capture_epochs e ON e.workspace_id = r.workspace_id AND e.id = r.epoch_id
          JOIN capture_epochs ended ON ended.workspace_id = r.workspace_id AND ended.id = ${event.epoch_id}
          WHERE r.workspace_id = ${event.workspace_id} AND r.meeting_id = ${open.value.id} AND r.boundary_revision = ${open.value.boundary_revision}
            AND e.captured_at > ended.captured_at
          LIMIT 1`;
        if (later.length > 0) return;
        const watermark = { epoch_id: event.epoch_id as SourceRange['epoch_id'], track: event.track, sample_end: event.sample_end };
        yield* sealMeeting(open.value, {
          watermark,
          state: event.reason === 'close' ? 'closing' : 'interrupted',
          cue: { evidence: [`capture_${event.reason}`], reason: `capture ${event.reason}`, uncertainty: 0 },
          actor: null,
        });
      }),
    );
  }).pipe(Effect.catchTag('ParseError', error => Effect.die(error)));

/** Open meetings whose latest owned audio ended more than `idleMs` ago; `only` narrows the scan to one meeting. */
const idleMeetings = (idleMs: number, only: MeetingId | null) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    sql<{ workspace_id: WorkspaceId; id: MeetingId; listener_id: string; capture_group_id: string | null }>`SELECT m.workspace_id, m.id, m.listener_id, m.capture_group_id FROM meetings m
      JOIN meeting_ranges r ON r.meeting_id = m.id AND r.boundary_revision = m.boundary_revision
      JOIN capture_epochs e ON e.workspace_id = r.workspace_id AND e.id = r.epoch_id
      WHERE m.state IN ${sql.in(OPEN_STATES)} AND m.listener_id IS NOT NULL ${only === null ? sql`` : sql`AND m.id = ${only}`}
      GROUP BY m.workspace_id, m.id, m.listener_id, m.capture_group_id
      HAVING MAX(e.captured_at + INTERVAL ROUND((r.sample_end - e.sample_start) * 1000000 / e.sample_rate) MICROSECOND)
        < UTC_TIMESTAMP(6) - INTERVAL ${idleMs * 1000} MICROSECOND`,
  );

/** End of the run of `spans` (sorted by `sample_start`) that reaches contiguously from `from`. */
const coveredThrough = (from: number, spans: ReadonlyArray<Span>) =>
  spans.reduce((end, span) => (span.sample_start <= end ? Math.max(end, span.sample_end) : end), from);

/**
 * Whether an idle-candidate meeting is quiet, not lagging: ASR finished `idleMs` of audio past its last speech (silence), or its
 * listeners are all stopped or paused for `idleMs` and every epoch's audio after the last speech is transcribed and uploaded.
 * Audio still waiting for ASR or upload never counts, so an outage or backlog cannot close a meeting that is still talking.
 */
const isQuiet = (meeting: { readonly workspace_id: WorkspaceId; readonly id: MeetingId; readonly listener_id: string; readonly capture_group_id: string | null }, idleMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const last = (yield* currentRanges(meeting.workspace_id, meeting.id)).reduce<TimedRange | null>((latest, range) => (latest === null || range.end_ms > latest.end_ms ? range : latest), null);
    if (last === null) return false;
    const epochEnd = sql`GREATEST(e.live_sample_end, COALESCE(e.archive_sample_end, 0))`;
    const epochs = yield* sql<{ id: string; live: number; settled: number; epoch_end: number }>`SELECT e.id, e.ended_at IS NULL AS live,
        COALESCE(e.ended_at <= UTC_TIMESTAMP(6) - INTERVAL ${idleMs * 1000} MICROSECOND, 0) AS settled, CAST(${epochEnd} AS DOUBLE) AS epoch_end
      FROM capture_epochs e JOIN listeners l ON l.workspace_id = e.workspace_id AND l.id = e.listener_id
      WHERE e.workspace_id = ${meeting.workspace_id}
        AND ${meeting.capture_group_id === null ? sql`l.id = ${meeting.listener_id}` : sql`l.capture_group_id = ${meeting.capture_group_id}`}
        AND (e.ended_at IS NULL OR e.captured_at + INTERVAL ROUND((${epochEnd} - e.sample_start) * 1000000 / e.sample_rate) MICROSECOND > ${dbTime(last.end_ms)})`;
    const clocks = yield* loadEpochs(meeting.workspace_id, epochs.map(epoch => epoch.id));
    let silent = false;
    let live = false;
    let settled = true;
    let uploaded = true;
    for (const epoch of epochs) {
      const clock = clocks.get(epoch.id)!;
      const from = Math.max(clock.sample_start, msToSample(clock, last.end_ms));
      const through = coveredThrough(from, yield* sql<Span>`SELECT CAST(sample_start AS DOUBLE) AS sample_start, CAST(sample_end AS DOUBLE) AS sample_end
        FROM transcript_coverage WHERE workspace_id = ${meeting.workspace_id} AND epoch_id = ${epoch.id} AND track = ${last.track} AND sample_end > ${from} ORDER BY sample_start`);
      silent ||= through > from && sampleMs(clock, through) - last.end_ms >= idleMs;
      if (Number(epoch.live) === 1) {
        live = true;
        continue;
      }
      if (through < epoch.epoch_end) return false;
      settled &&= Number(epoch.settled) === 1;
      if (from < epoch.epoch_end) {
        const chunks = yield* sql<Span>`SELECT CAST(sample_start AS DOUBLE) AS sample_start, CAST(sample_start + sample_count AS DOUBLE) AS sample_end
          FROM recording_chunks WHERE workspace_id = ${meeting.workspace_id} AND epoch_id = ${epoch.id} AND track = ${last.track} AND upload_state = 'committed'
            AND sample_start + sample_count > ${from} ORDER BY sample_start`;
        uploaded &&= coveredThrough(from, chunks) >= epoch.epoch_end;
      }
    }
    return silent || (!live && settled && uploaded);
  });

/**
 * Worker sweep: an open meeting with no speech for `idleMs` that is quiet (see `isQuiet`: silent, or its listener paused or
 * stopped with nothing left to transcribe or upload) seals at its last speech and schedules the same final work as an explicit close.
 * ponytail: scans `meetings` by state every sweep; add a state index if the table grows large.
 */
export const sweepIdleMeetings = (idleMs: number = engineeringDefaults.meetingIdleCloseMs) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const meeting of yield* idleMeetings(idleMs, null)) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lockCaptureKey(meeting);
          // Speech placed since the scan, or audio still waiting for ASR or upload, keeps the meeting open.
          if ((yield* idleMeetings(idleMs, meeting.id)).length === 0 || !(yield* isQuiet(meeting, idleMs))) return;
          const row = yield* selectMeeting(meeting.workspace_id, meeting.id, true);
          if (row._tag === 'None') return;
          yield* sealMeeting(row.value, {
            watermark: null,
            state: 'closing',
            cue: { evidence: ['idle_close'], reason: `no speech for ${Math.round(idleMs / 60_000)} minutes`, uncertainty: 0 },
            actor: null,
          });
        }),
      );
    }
  }).pipe(Effect.catchTag('ParseError', error => Effect.die(error)));

export const getMeeting = (access: AccessScope, meeting_id: MeetingId) =>
  Effect.gen(function* () {
    yield* authorizeMeeting(access, meeting_id, 'read');
    const row = yield* Effect.orDie(selectMeeting(access.workspace_id, meeting_id));
    if (row._tag === 'None') return yield* new NotFound({ message: 'Meeting not found' });
    return toMeeting(row.value);
  });

export const meetingRanges = (access: AccessScope, meeting_id: MeetingId) =>
  Effect.gen(function* () {
    const meeting = yield* getMeeting(access, meeting_id);
    const ranges = yield* Effect.orDie(currentRanges(access.workspace_id, meeting_id));
    return ranges.map(({ epoch_id, track, sample_start, sample_end }): MeetingRange => ({
      meeting_id,
      boundary_revision: meeting.boundary_revision,
      source: { epoch_id, track, sample_start, sample_end },
    }));
  });

/** Explicit close: seals at the listener's capture watermark (its live epoch, else the latest ended one the meeting uses) and schedules final work; the listener keeps listening. */
export const closeMeeting = (access: AccessScope, meeting_id: MeetingId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* requireScope(access, 'context:write');
    yield* authorizeMeeting(access, meeting_id, 'write');
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const before = yield* selectMeeting(access.workspace_id, meeting_id);
        if (before._tag === 'None' || !OPEN_STATES.includes(before.value.state) || before.value.listener_id === null) return;
        yield* lockCaptureKey({ workspace_id: access.workspace_id, listener_id: before.value.listener_id, capture_group_id: before.value.capture_group_id });
        const row = yield* selectMeeting(access.workspace_id, meeting_id, true);
        if (row._tag === 'None' || !OPEN_STATES.includes(row.value.state)) return;
        const [live] = yield* sql<{ epoch_id: SourceRange['epoch_id']; track: number; live_sample_end: string }>`SELECT e.id AS epoch_id, r.track, e.live_sample_end
          FROM listeners l JOIN capture_epochs e ON e.workspace_id = l.workspace_id AND e.id = COALESCE(l.current_epoch_id, (
            SELECT p.id FROM capture_epochs p JOIN meeting_ranges q ON q.epoch_id = p.id AND q.meeting_id = ${meeting_id} AND q.boundary_revision = ${row.value.boundary_revision}
            WHERE p.workspace_id = l.workspace_id AND p.listener_id = l.id AND p.ended_at IS NOT NULL ORDER BY p.ended_at DESC, p.started_at DESC LIMIT 1))
          JOIN meeting_ranges r ON r.meeting_id = ${meeting_id} AND r.boundary_revision = ${row.value.boundary_revision} AND r.epoch_id = e.id
          WHERE l.workspace_id = ${access.workspace_id} AND l.id = ${row.value.listener_id} LIMIT 1`;
        const watermark = live === undefined ? null : { epoch_id: live.epoch_id, track: live.track, sample_end: Number(live.live_sample_end) };
        yield* sealMeeting(row.value, {
          watermark,
          state: 'closing',
          cue: { evidence: ['explicit_close'], reason: `closed by ${access.principal.display_name}`, uncertainty: 0 },
          actor: access.principal.id,
        });
      }),
    );
    return yield* getMeeting(access, meeting_id);
  }).pipe(dbFailures);

const CursorKey = Schema.parseJson(Schema.Tuple(DbUtc.to, MeetingId));

/** Accessible meetings, newest first; meetings merged into another (no current ranges) are omitted. */
export const listMeetings = (access: AccessScope, params: ListMeetingsParams) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const visible = yield* listVisibleMeetingIds(access);
    const limit = params.limit ?? 50;
    const after = params.cursor === undefined ? null : yield* Schema.decode(CursorKey)(Buffer.from(params.cursor, 'base64url').toString()).pipe(
      Effect.mapError(() => new NotFound({ message: 'Unknown cursor' })),
    );
    if (visible.length === 0) return { meetings: [], next_cursor: null } satisfies MeetingPage;
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: MeetingRow,
      execute: () => sql`SELECT ${sql.literal(meetingColumns('m.'))}
        FROM meetings m WHERE m.workspace_id = ${access.workspace_id} AND m.id IN ${sql.in(visible)}
          AND EXISTS (SELECT 1 FROM meeting_ranges r WHERE r.meeting_id = m.id AND r.boundary_revision = m.boundary_revision)
          ${params.state === undefined ? sql`` : sql`AND m.state = ${params.state}`}
          ${params.from === undefined ? sql`` : sql`AND m.started_at >= ${Schema.encodeSync(DbUtc)(params.from)}`}
          ${params.to === undefined ? sql`` : sql`AND m.started_at < ${Schema.encodeSync(DbUtc)(params.to)}`}
          ${params.participant === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM meeting_ranges r JOIN speaker_tracks t ON t.workspace_id = r.workspace_id
            AND t.epoch_id = r.epoch_id AND t.track = r.track AND t.sample_start < r.sample_end AND t.sample_end > r.sample_start
            WHERE r.meeting_id = m.id AND r.boundary_revision = m.boundary_revision AND t.profile_id = ${params.participant})`}
          ${after === null ? sql`` : sql`AND (m.started_at, m.id) < (${Schema.encodeSync(DbUtc)(after[0])}, ${after[1]})`}
        ORDER BY m.started_at DESC, m.id DESC LIMIT ${limit + 1}`,
    })(undefined);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const next_cursor = rows.length > limit && last !== undefined ? Buffer.from(Schema.encodeSync(CursorKey)([last.started_at, last.id])).toString('base64url') : null;
    return { meetings: page.map(toMeeting), next_cursor } satisfies MeetingPage;
  }).pipe(dbFailures);

/** Share of the meeting's current ranges with final transcript coverage. */
const transcriptProgress = (row: MeetingRow) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ranges = yield* currentRanges(row.workspace_id, row.id);
    let total = 0;
    let covered = 0;
    for (const range of ranges) {
      total += range.sample_end - range.sample_start;
      const rows = yield* sql<{ sample_start: number; sample_end: number }>`SELECT CAST(sample_start AS DOUBLE) AS sample_start, CAST(sample_end AS DOUBLE) AS sample_end
        FROM transcript_coverage WHERE workspace_id = ${row.workspace_id} AND epoch_id = ${range.epoch_id} AND track = ${range.track}
          AND sample_start < ${range.sample_end} AND sample_end > ${range.sample_start}`;
      covered += rows.reduce((sum, cover) => sum + Math.min(cover.sample_end, range.sample_end) - Math.max(cover.sample_start, range.sample_start), 0);
    }
    return covered >= total ? 'complete' : covered > 0 ? 'partial' : 'pending';
  });

/**
 * `meeting.finalize`: a sealed meeting becomes closed, its transcript coverage is measured and
 * derived work (recording cut, memory commit) is re-queued for the current boundary revision.
 */
export const finalizeMeeting = (job: MeetingJob) =>
  asJobResult(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { meeting_id } = yield* Schema.decodeUnknown(MeetingJobPayload)(job.payload);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const found = yield* selectMeeting(job.workspace_id, meeting_id, true);
          if (found._tag === 'None' || OPEN_STATES.includes(found.value.state)) return { skipped: 'meeting is open or missing' };
          const row = found.value;
          const processing = { ...PENDING_PROCESSING, transcript: yield* transcriptProgress(row) };
          const state = row.state === 'closing' ? 'closed' : row.state;
          yield* sql`UPDATE meetings SET state = ${state}, processing = ${JSON.stringify(processing)}, updated_at = UTC_TIMESTAMP(6) WHERE id = ${row.id}`;
          const derived = { workspace_id: row.workspace_id, work_key: `meeting:${row.id}`, payload: { meeting_id: row.id }, requested_by: job.requested_by, source_revision: row.boundary_revision };
          yield* enqueueJob({ ...derived, kind: 'recording.assemble' });
          yield* enqueueJob({ ...derived, kind: 'memory.commit' });
          yield* enqueueJob({ ...derived, kind: 'notes.summarize' });
          return { state, processing, boundary_revision: row.boundary_revision };
        }),
      );
    }),
  );
