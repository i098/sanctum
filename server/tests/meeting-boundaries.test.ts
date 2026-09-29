import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { CaptureEpochId, MeetingId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { evaluateBoundary, LOW_CONFIDENCE } from '../src/boundaries.ts';
import { closeMeeting, finalizeMeeting, getMeeting, meetingRanges, onCaptureEnded, onFinalSegments } from '../src/meetings.ts';
import { claimed, hear, jobsOf, meetingsOf, RATE, rangesOf, seedConnection, seedEpoch, seedGroup, seedListener } from './support/capture.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const setup = Effect.gen(function* () {
  const [owner, device] = yield* seedWorkspace('Boundaries', ['owner', 'device']);
  const listener = yield* seedListener(device!);
  const epoch = yield* seedEpoch(listener);
  return { owner: owner!, listener, epoch };
});

const MIN = 60;
const source = { epoch_id: CaptureEpochId.make(randomUUID()), track: 0, sample_start: 0, sample_end: 1 };
const said = (text: string, speaker_label: string | null = 'SPEAKER_00') => ({ text, speaker_label, provider_connection_id: 'c1' });

describe('boundary decisions', () => {
  it('needs corroborating evidence; silence or a topic change alone never starts a meeting', () => {
    const tail = [said('we should look at the budget numbers')];
    const decide = (gap_ms: number, incoming = said('now about the office party next week')) => evaluateBoundary({ source, incoming, tail, gap_ms });
    expect(decide(30_000)).toMatchObject({ decision: 'continue', evidence: [], uncertainty: 0 });
    expect(decide(6 * MIN * 1000)).toMatchObject({ decision: 'continue', evidence: ['long_gap'], uncertainty: 0.3 });
    const gapAndVoices = decide(6 * MIN * 1000, said('hello is this the design room', 'SPEAKER_03'));
    expect(gapAndVoices).toMatchObject({ decision: 'start', evidence: ['long_gap', 'speaker_change'], uncertainty: 0.5 });
    expect(gapAndVoices.uncertainty).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
    // Labels from another provider connection are not comparable, so they are not a speaker change.
    expect(evaluateBoundary({ source, tail, gap_ms: 6 * MIN * 1000, incoming: { ...said('hello there everyone', 'SPEAKER_03'), provider_connection_id: 'c2' } }).decision).toBe('continue');
    const backToBack = evaluateBoundary({ source, tail: [said('thanks everyone, see you next time')], gap_ms: 20_000, incoming: said('welcome everyone, let us look at hiring') });
    expect(backToBack).toMatchObject({ decision: 'start', evidence: ['explicit_end', 'explicit_start'], uncertainty: 0.2 });
    expect(evaluateBoundary({ source, tail: [], gap_ms: null, incoming: said('uh') }).decision).toBe('continue');
  });
});

describe('automatic meeting lifecycle', () => {
  it.effect('keeps one meeting across pauses and promotes it once a conversation is established', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, listener, epoch } = yield* setup;
        yield* hear(listener, epoch, 0, 5, 'we should review the budget numbers today');
        let [meeting] = yield* meetingsOf(listener.workspace_id);
        expect(meeting).toMatchObject({ state: 'provisional', started_at: '2026-09-28 16:00:00.000000' });
        yield* hear(listener, epoch, 125, 130, 'okay where were we with the budget');
        yield* hear(listener, epoch, 130 + 7 * MIN, 135 + 7 * MIN, 'sorry about that, back to the budget');
        const meetings = yield* meetingsOf(listener.workspace_id);
        expect(meetings).toHaveLength(1);
        [meeting] = meetings;
        expect(meeting!.state).toBe('active');
        const ranges = yield* meetingRanges(owner, MeetingId.make(meeting!.id));
        expect(ranges.map(range => [range.source.sample_start, range.source.sample_end])).toEqual([[0, (135 + 7 * MIN) * RATE]]);
      }),
      { migrated: true },
    ),
  );

  it.effect('starts a new meeting at a true boundary and seals the previous one at its last speech', () =>
    withDatabase(
      Effect.gen(function* () {
        const { listener, epoch } = yield* setup;
        yield* hear(listener, epoch, 0, 90, 'the quarterly plan needs two more hires');
        yield* hear(listener, epoch, 95, 100, 'thanks everyone, see you next time');
        yield* hear(listener, epoch, 100 + 6 * MIN, 105 + 6 * MIN, "good morning everyone, let's get started with the design review");
        const [first, second] = yield* meetingsOf(listener.workspace_id);
        expect(first).toMatchObject({ state: 'closing', ended_at: '2026-09-28 16:01:40.000000' });
        expect(second).toMatchObject({ state: 'active', ended_at: null });
        expect(yield* rangesOf(first!.id)).toEqual([{ epoch_id: epoch, sample_start: 0, sample_end: 100 * RATE }]);
        expect(yield* rangesOf(second!.id)).toEqual([{ epoch_id: epoch, sample_start: (100 + 6 * MIN) * RATE, sample_end: (105 + 6 * MIN) * RATE }]);
        expect(yield* jobsOf(listener.workspace_id)).toEqual([{ kind: 'meeting.finalize', work_key: `meeting:${first!.id}`, status: 'pending' }]);
      }),
      { migrated: true },
    ),
  );

  it.effect('separates back-to-back conversations with explicit end and start cues and no long gap', () =>
    withDatabase(
      Effect.gen(function* () {
        const { listener, epoch } = yield* setup;
        yield* hear(listener, epoch, 0, 40, 'last item is the vendor contract renewal');
        yield* hear(listener, epoch, 41, 44, "that's all for today, thanks everyone");
        yield* hear(listener, epoch, 60, 64, 'welcome everyone, shall we begin the hiring sync');
        expect((yield* meetingsOf(listener.workspace_id)).map(meeting => meeting.state)).toEqual(['closing', 'active']);
      }),
      { migrated: true },
    ),
  );

  it.effect('keeps a low-confidence boundary provisional for review', () =>
    withDatabase(
      Effect.gen(function* () {
        const { listener, epoch } = yield* setup;
        const connection = yield* seedConnection(listener, epoch);
        yield* hear(listener, epoch, 0, 30, 'we will ship the release on friday', { label: 'SPEAKER_00', connection });
        yield* hear(listener, epoch, 30 + 6 * MIN, 35 + 6 * MIN, 'is anyone using this room right now', { label: 'SPEAKER_01', connection });
        yield* hear(listener, epoch, 35 + 6 * MIN, 35 + 8 * MIN, 'we booked it for the partner call', { label: 'SPEAKER_01', connection });
        expect((yield* meetingsOf(listener.workspace_id)).map(meeting => meeting.state)).toEqual(['closing', 'provisional']);
      }),
      { migrated: true },
    ),
  );

  it.effect('explicit close seals at the live watermark, keeps the listener active and never drains actions', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner, listener, epoch } = yield* setup;
        yield* hear(listener, epoch, 0, 30, 'please send the summary to the whole team');
        const [meeting] = yield* meetingsOf(listener.workspace_id);
        const id = MeetingId.make(meeting!.id);
        const action = randomUUID();
        yield* sql`INSERT INTO actions (id, workspace_id, meeting_id, requested_by, action_key, idempotency_key, args, args_sha256, state, created_at, updated_at)
          VALUES (${action}, ${listener.workspace_id}, ${id}, ${owner.principal.id}, 'gmail-send', 'k1', '{}', ${Buffer.alloc(32)}, 'running', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
        yield* sql`UPDATE capture_epochs SET live_sample_end = ${40 * RATE} WHERE id = ${epoch}`;
        const closed = yield* closeMeeting(owner, id);
        expect(closed).toMatchObject({ state: 'closing', ended_at: '2026-09-28T16:00:40Z' });
        expect(yield* rangesOf(id)).toEqual([{ epoch_id: epoch, sample_start: 0, sample_end: 40 * RATE }]);
        const [actionRow] = yield* sql<{ state: string }>`SELECT state FROM actions WHERE id = ${action}`;
        expect(actionRow!.state).toBe('running');
        expect(yield* jobsOf(listener.workspace_id)).toEqual([{ kind: 'meeting.finalize', work_key: `meeting:${id}`, status: 'pending' }]);
        // Late ASR for audio before the watermark stays with the closed meeting; later speech opens the next one.
        yield* hear(listener, epoch, 35, 39, 'and copy the finance lead on it');
        expect(yield* meetingsOf(listener.workspace_id)).toHaveLength(1);
        yield* hear(listener, epoch, 50, 55, 'can someone help me with the projector');
        const meetings = yield* meetingsOf(listener.workspace_id);
        expect(meetings.map(row => row.state)).toEqual(['closing', 'provisional']);
        expect(yield* closeMeeting(owner, id)).toMatchObject({ state: 'closing', boundary_revision: 1 });
      }),
      { migrated: true },
    ),
  );

  it.effect('sealing a meeting that began mid-epoch extends only its last range to the watermark', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner, listener, epoch } = yield* setup;
        yield* hear(listener, epoch, 100, 130, 'this meeting starts well after capture began');
        const [meeting] = yield* meetingsOf(listener.workspace_id);
        yield* sql`UPDATE capture_epochs SET live_sample_end = ${140 * RATE} WHERE id = ${epoch}`;
        yield* closeMeeting(owner, MeetingId.make(meeting!.id));
        expect(yield* rangesOf(meeting!.id)).toEqual([{ epoch_id: epoch, sample_start: 100 * RATE, sample_end: 140 * RATE }]);
        yield* hear(listener, epoch, 200, 230, 'a later conversation about the offsite plans');
        const [, later] = yield* meetingsOf(listener.workspace_id);
        yield* onCaptureEnded({ workspace_id: listener.workspace_id, listener_id: listener.listener_id, epoch_id: epoch, track: 0, sample_end: 250 * RATE, reason: 'interrupted' });
        expect(yield* rangesOf(later!.id)).toEqual([{ epoch_id: epoch, sample_start: 200 * RATE, sample_end: 250 * RATE }]);
        expect(yield* rangesOf(meeting!.id)).toEqual([{ epoch_id: epoch, sample_start: 100 * RATE, sample_end: 140 * RATE }]);
      }),
      { migrated: true },
    ),
  );

  it.effect('new speech during old meeting processing goes to a new meeting; finalize leaves it alone', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, listener, epoch } = yield* setup;
        yield* hear(listener, epoch, 0, 30, 'agenda item one is the roadmap');
        const [old] = yield* meetingsOf(listener.workspace_id);
        yield* closeMeeting(owner, MeetingId.make(old!.id));
        const early = yield* hear(listener, epoch, 31, 36, 'while that processes, a quick question about lunch');
        const outcome = yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id: old!.id }));
        expect(outcome).toMatchObject({ status: 'succeeded', result: { state: 'closed', processing: { transcript: 'complete', notes: 'pending', recording: 'pending' } } });
        const [closed, current] = yield* meetingsOf(listener.workspace_id);
        expect(closed!.state).toBe('closed');
        expect(current!.state).toBe('provisional');
        expect(yield* rangesOf(old!.id)).toEqual([{ epoch_id: epoch, sample_start: 0, sample_end: 30 * RATE }]);
        expect(yield* rangesOf(current!.id)).toEqual([{ epoch_id: epoch, sample_start: 31 * RATE, sample_end: 36 * RATE }]);
        const kinds = (yield* jobsOf(listener.workspace_id)).map(job => `${job.kind}:${job.status}`);
        expect(kinds).toEqual(['meeting.finalize:pending', 'memory.commit:pending', 'recording.assemble:pending']);
        // Replayed segments (reconnect or batch reconciliation) are already owned and change nothing.
        yield* onFinalSegments({ ...listener, segments: [early] });
        yield* hear(listener, epoch, 36, 40, 'is the cafeteria open');
        expect(yield* rangesOf(current!.id)).toEqual([{ epoch_id: epoch, sample_start: 31 * RATE, sample_end: 40 * RATE }]);
        expect(yield* getMeeting(owner, MeetingId.make(old!.id))).toMatchObject({ state: 'closed' });
      }),
      { migrated: true },
    ),
  );

  it.effect('capture end: pause keeps the meeting open, interruption seals it, a live group owner keeps it going', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { listener, epoch } = yield* setup;
        yield* hear(listener, epoch, 0, 30, 'reviewing the incident timeline now');
        const end = { workspace_id: listener.workspace_id, listener_id: listener.listener_id, epoch_id: epoch, track: 0, sample_end: 45 * RATE };
        yield* onCaptureEnded({ ...end, reason: 'pause' });
        expect((yield* meetingsOf(listener.workspace_id))[0]!.state).toBe('provisional');
        yield* onCaptureEnded({ ...end, reason: 'interrupted' });
        const [meeting] = yield* meetingsOf(listener.workspace_id);
        expect(meeting).toMatchObject({ state: 'interrupted', ended_at: '2026-09-28 16:00:45.000000' });

        const [, device] = yield* seedWorkspace('Group', ['owner', 'device']);
        const group = yield* seedGroup(device!.workspace_id);
        const room = yield* seedListener(device!, { group });
        const laptop = yield* seedListener(device!, { group });
        const roomEpoch = yield* seedEpoch(room);
        yield* hear(room, roomEpoch, 0, 30, 'room and laptop share this meeting');
        yield* sql`UPDATE capture_groups SET lease_listener_id = ${laptop.listener_id}, lease_expires_at = UTC_TIMESTAMP(6) + INTERVAL 45 SECOND WHERE id = ${group}`;
        yield* onCaptureEnded({ workspace_id: room.workspace_id, listener_id: room.listener_id, epoch_id: roomEpoch, track: 0, sample_end: 31 * RATE, reason: 'interrupted' });
        const laptopEpoch = yield* seedEpoch(laptop, '2026-09-28 16:00:32.000000');
        yield* hear(laptop, laptopEpoch, 0, 5, 'the laptop picks up where the room left off');
        const groupMeetings = yield* meetingsOf(device!.workspace_id);
        expect(groupMeetings).toHaveLength(1);
        expect(groupMeetings[0]!.state).toBe('provisional');
        expect((yield* rangesOf(groupMeetings[0]!.id)).map(range => range.epoch_id).sort()).toEqual([roomEpoch, laptopEpoch].sort());
      }),
      { migrated: true },
    ),
  );
});
