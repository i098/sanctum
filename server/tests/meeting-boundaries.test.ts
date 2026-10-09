import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { CaptureEpochId, ListenerId, MeetingId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { listenerFeed } from '../src/actions.ts';
import { evaluateBoundary, LOW_CONFIDENCE } from '../src/boundaries.ts';
import { closeMeeting, finalizeMeeting, getMeeting, listMeetings, meetingRanges, onCaptureEnded, onFinalSegments, sweepIdleMeetings } from '../src/meetings.ts';
import { claimed, commitChunk, hear, jobsOf, type Listener, meetingsOf, RATE, rangesOf, seedConnection, seedEpoch, seedGroup, seedListener, speak } from './support/capture.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { memoryObjectStore } from './support/object-store.ts';

interface Talked {
  readonly listener: Listener;
  readonly epoch: CaptureEpochId;
}

const setup = Effect.gen(function* () {
  const [owner, device] = yield* seedWorkspace('Boundaries', ['owner', 'device']);
  const listener = yield* seedListener(device!);
  const epoch = yield* seedEpoch(listener);
  return { owner: owner!, device: device!, listener, epoch };
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
  it.effect('gives the capturing principal, and nobody else, access to a detected meeting and its feed', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, device, listener, epoch } = yield* setup;
        yield* onFinalSegments({ ...listener, segments: [yield* speak(listener, epoch, 0, 30, 'first topic is the launch date')] });
        const id = MeetingId.make((yield* meetingsOf(listener.workspace_id))[0]!.id);
        expect(yield* getMeeting(device, id)).toMatchObject({ id, visibility: 'restricted' });
        expect((yield* listMeetings(device, {})).meetings.map(meeting => meeting.id)).toEqual([id]);
        expect(yield* Effect.flip(getMeeting(owner, id))).toMatchObject({ _tag: 'NotFound' });
        expect(yield* listMeetings(owner, {})).toEqual({ meetings: [], next_cursor: null });
        // The capturer's listening feed shows its own work on the meeting; anyone without a grant sees no meeting.
        const sql = yield* SqlClient.SqlClient;
        const action_id = randomUUID();
        yield* sql`INSERT INTO actions (id, workspace_id, meeting_id, requested_by, action_key, idempotency_key, args, args_sha256, version, state, title, created_at, updated_at)
          VALUES (${action_id}, ${listener.workspace_id}, ${id}, ${device.principal.id}, 'gmail-send-email', 'k1', '{}', ${Buffer.alloc(32)}, '1', 'queued', 'Email the notes', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
        const listener_id = ListenerId.make(listener.listener_id);
        expect(yield* listenerFeed(device, listener_id)).toEqual({ meeting_id: id, actions: [{ action_id, action_key: 'gmail-send-email', state: 'queued', title: 'Email the notes' }] });
        expect(yield* listenerFeed(owner, listener_id)).toEqual({ meeting_id: null, actions: [] });
      }),
      { migrated: true },
    ),
  );

  it.effect('lists only the meetings of the listener asked for, even when the principal can read others', () =>
    withDatabase(
      Effect.gen(function* () {
        const { device, listener, epoch } = yield* setup;
        const other = yield* seedListener(device);
        const otherEpoch = yield* seedEpoch(other);
        yield* hear(listener, epoch, 0, 30, 'first topic is the launch date');
        yield* hear(other, otherEpoch, 0, 30, 'second room is talking about hiring');
        const idsFor = (listener_id: string) => listMeetings(device, { listener: ListenerId.make(listener_id) }).pipe(Effect.map(page => page.meetings.map(meeting => meeting.id)));
        const all = (yield* listMeetings(device, {})).meetings.map(meeting => meeting.id);
        expect(all).toHaveLength(2);
        const first = yield* idsFor(listener.listener_id);
        const second = yield* idsFor(other.listener_id);
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
        expect([...first, ...second].sort()).toEqual([...all].sort());
        expect(yield* idsFor(randomUUID())).toEqual([]);
      }),
      { migrated: true },
    ),
  );

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

  it.effect('schedules live context refresh after the quiet period, and at once after four new turns', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { listener, epoch } = yield* setup;
        const refresh = sql<{ work_key: string; due: string }>`SELECT work_key, CAST(available_at <= UTC_TIMESTAMP(6) AS CHAR) AS due
          FROM jobs WHERE workspace_id = ${listener.workspace_id} AND kind = 'context.refresh'`;
        yield* hear(listener, epoch, 0, 5, 'we should review the budget numbers today');
        yield* hear(listener, epoch, 5, 10, 'the travel line is over by ten percent');
        yield* hear(listener, epoch, 10, 15, 'Dana will send the revised sheet');
        const [meeting] = yield* meetingsOf(listener.workspace_id);
        expect(yield* refresh).toEqual([{ work_key: meeting!.id, due: '0' }]);
        yield* hear(listener, epoch, 15, 20, 'by Friday at the latest');
        expect(yield* refresh).toEqual([{ work_key: meeting!.id, due: '1' }]);
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
        const lifecycle = (yield* jobsOf(listener.workspace_id)).filter(job => job.kind !== 'context.refresh');
        expect(lifecycle).toEqual([{ kind: 'meeting.finalize', work_key: `meeting:${first!.id}`, status: 'pending' }]);
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
        yield* sql`INSERT INTO actions (id, workspace_id, meeting_id, requested_by, action_key, idempotency_key, args, args_sha256, state, created_at, updated_at, version)
          VALUES (${action}, ${listener.workspace_id}, ${id}, ${owner.principal.id}, 'gmail-send', 'k1', '{}', ${Buffer.alloc(32)}, 'running', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), '0.1.0')`;
        yield* sql`UPDATE capture_epochs SET live_sample_end = ${40 * RATE} WHERE id = ${epoch}`;
        const closed = yield* closeMeeting(owner, id);
        expect(closed).toMatchObject({ state: 'closing', ended_at: '2026-09-28T16:00:40Z' });
        expect(yield* rangesOf(id)).toEqual([{ epoch_id: epoch, sample_start: 0, sample_end: 40 * RATE }]);
        const [actionRow] = yield* sql<{ state: string }>`SELECT state FROM actions WHERE id = ${action}`;
        expect(actionRow!.state).toBe('running');
        const lifecycle = (yield* jobsOf(listener.workspace_id)).filter(job => job.kind !== 'context.refresh');
        expect(lifecycle).toEqual([{ kind: 'meeting.finalize', work_key: `meeting:${id}`, status: 'pending' }]);
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
        const kinds = (yield* jobsOf(listener.workspace_id)).filter(job => job.kind !== 'context.refresh').map(job => `${job.kind}:${job.status}`);
        expect(kinds).toEqual(['meeting.finalize:pending', 'memory.commit:pending', 'notes.summarize:pending', 'recording.assemble:pending']);
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

  it.effect('capture end of an earlier epoch leaves open a meeting holding later audio', () =>
    withDatabase(
      Effect.gen(function* () {
        const { listener, epoch } = yield* setup;
        const resumed = yield* seedEpoch(listener, '2026-09-28 17:00:00.000000');
        yield* hear(listener, resumed, 0, 30, 'a new conversation after the offline gap');
        const end = { workspace_id: listener.workspace_id, listener_id: listener.listener_id, track: 0 };
        yield* onCaptureEnded({ ...end, epoch_id: epoch, sample_end: 10 * RATE, reason: 'interrupted' });
        expect((yield* meetingsOf(listener.workspace_id)).map(meeting => meeting.state)).toEqual(['provisional']);
        yield* onCaptureEnded({ ...end, epoch_id: resumed, sample_end: 31 * RATE, reason: 'close' });
        expect((yield* meetingsOf(listener.workspace_id)).map(meeting => meeting.state)).toEqual(['closing']);
      }),
      { migrated: true },
    ),
  );

  it.effect('End right after the pause still seals at everything accepted, so late finals stay in the meeting', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner, listener, epoch } = yield* setup;
        yield* hear(listener, epoch, 0, 30, 'one last thing before we finish the planning');
        const [meeting] = yield* meetingsOf(listener.workspace_id);
        const id = MeetingId.make(meeting!.id);
        // Pause ended the epoch with 40 s accepted; a later archive epoch that ended afterwards holds none of this meeting.
        yield* sql`UPDATE capture_epochs SET live_sample_end = ${40 * RATE}, ended_at = UTC_TIMESTAMP(6) - INTERVAL 1 MINUTE, end_reason = 'pause' WHERE id = ${epoch}`;
        const archive = yield* seedEpoch(listener, '2026-09-28 17:00:00.000000', 99 * RATE);
        yield* sql`UPDATE capture_epochs SET ended_at = UTC_TIMESTAMP(6), end_reason = 'pause' WHERE id = ${archive}`;
        yield* sql`UPDATE listeners SET current_epoch_id = NULL WHERE id = ${listener.listener_id}`;
        expect(yield* closeMeeting(owner, id)).toMatchObject({ state: 'closing', ended_at: '2026-09-28T16:00:40Z' });
        expect(yield* rangesOf(id)).toEqual([{ epoch_id: epoch, sample_start: 0, sample_end: 40 * RATE }]);
        yield* hear(listener, epoch, 33, 39, 'and the final segment arrives after the end');
        expect((yield* meetingsOf(listener.workspace_id)).map(row => row.state)).toEqual(['closing']);
        expect(yield* rangesOf(id)).toEqual([{ epoch_id: epoch, sample_start: 0, sample_end: 40 * RATE }]);
      }),
      { migrated: true },
    ),
  );

  /** End meeting while capture is live: the close seals at the lagging watermark (40 s), then the pause it sent ends the epoch at 50 s. */
  const endWhileLive = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { owner, listener, epoch } = yield* setup;
    yield* hear(listener, epoch, 0, 30, 'please send the summary to the whole team');
    const id = MeetingId.make((yield* meetingsOf(listener.workspace_id))[0]!.id);
    yield* sql`UPDATE capture_epochs SET live_sample_end = ${40 * RATE} WHERE id = ${epoch}`;
    expect(yield* closeMeeting(owner, id)).toMatchObject({ state: 'closing', ended_at: '2026-09-28T16:00:40Z' });
    yield* sql`UPDATE capture_epochs SET live_sample_end = ${50 * RATE}, ended_at = UTC_TIMESTAMP(6), end_reason = 'pause' WHERE id = ${epoch}`;
    yield* sql`UPDATE listeners SET current_epoch_id = NULL WHERE id = ${listener.listener_id}`;
    return { owner, listener, epoch, id };
  });

  it.effect('End is final: speech from before the pause joins the closed meeting, or no meeting once finalized', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, listener, epoch, id } = yield* endWhileLive;
        yield* hear(listener, epoch, 41, 46, 'Alice will fish the billing report');
        expect((yield* meetingsOf(listener.workspace_id)).map(row => row.state)).toEqual(['closing']);
        expect(yield* getMeeting(owner, id)).toMatchObject({ state: 'closing', ended_at: '2026-09-28T16:00:46Z' });
        expect(yield* rangesOf(id)).toEqual([{ epoch_id: epoch, sample_start: 0, sample_end: 46 * RATE }]);
        yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id: id }));
        yield* hear(listener, epoch, 47, 49, 'and copy the finance lead on the report');
        expect((yield* meetingsOf(listener.workspace_id)).map(row => row.state)).toEqual(['closed']);
        expect(yield* rangesOf(id)).toEqual([{ epoch_id: epoch, sample_start: 0, sample_end: 46 * RATE }]);
      }),
      { migrated: true },
    ),
  );

  it.effect('after End, speech once listening resumes opens a new meeting', () =>
    withDatabase(
      Effect.gen(function* () {
        const { listener } = yield* endWhileLive;
        const resumed = yield* seedEpoch(listener, '2026-09-28 16:01:00.000000');
        yield* hear(listener, resumed, 0, 5, "good morning everyone, let's go over the hiring plan");
        const meetings = yield* meetingsOf(listener.workspace_id);
        expect(meetings.map(row => row.state)).toEqual(['closing', 'provisional']);
        expect(yield* rangesOf(meetings[1]!.id)).toEqual([{ epoch_id: resumed, sample_start: 0, sample_end: 5 * RATE }]);
      }),
      { migrated: true },
    ),
  );

  it.effect('idle sweep closes true silence and a settled pause, never while ASR or upload lags', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = memoryObjectStore();
        const { device } = yield* setup;
        const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MIN * 1000).toISOString().replace('T', ' ').replace('Z', '');
        /** A listener whose epoch began `began` minutes ago and heard speech over its first 30 seconds. */
        const talked = (began = 15) =>
          Effect.gen(function* () {
            const listener = yield* seedListener(device);
            const epoch = yield* seedEpoch(listener, minutesAgo(began));
            yield* hear(listener, epoch, 0, 30, 'reviewing the quarterly roadmap together');
            return { listener, epoch } satisfies Talked;
          });
        /** ASR finished seconds `[from, to)` (silence included) and the server accepted audio through `to`. */
        const transcribed = ({ listener, epoch }: Talked, from: number, to: number) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO transcript_coverage (workspace_id, epoch_id, track, sample_start, sample_end, origin, created_at)
              VALUES (${listener.workspace_id}, ${epoch}, 0, ${from * RATE}, ${to * RATE}, 'live', UTC_TIMESTAMP(6))`;
            yield* sql`UPDATE capture_epochs SET live_sample_end = GREATEST(live_sample_end, ${to * RATE}) WHERE id = ${epoch}`;
          });
        /** The listener paused `ago` minutes back with `accepted` seconds of audio accepted. */
        const paused = ({ listener, epoch }: Talked, ago: number, accepted: number) =>
          Effect.gen(function* () {
            yield* sql`UPDATE capture_epochs SET live_sample_end = ${accepted * RATE}, ended_at = UTC_TIMESTAMP(6) - INTERVAL ${ago * MIN} SECOND, end_reason = 'pause' WHERE id = ${epoch}`;
            yield* sql`UPDATE listeners SET current_epoch_id = NULL, state = 'paused' WHERE id = ${listener.listener_id}`;
          });
        /** Committed 10-second recording chunks with sequence numbers `[from, to)`. */
        const uploaded = ({ listener, epoch }: Talked, from: number, to: number) =>
          Effect.forEach(Array.from({ length: to - from }, (_, index) => from + index), sequence => commitChunk(listener, epoch, sequence, store));
        const stateOf = ({ listener }: Talked) => Effect.map(sql<{ state: string }>`SELECT state FROM meetings WHERE listener_id = ${listener.listener_id}`, rows => rows[0]!.state);

        const silent = yield* talked();
        yield* transcribed(silent, 30, 700);
        const briefly = yield* talked();
        yield* transcribed(briefly, 30, 500);
        const outage = yield* talked();
        yield* sql`UPDATE capture_epochs SET live_sample_end = ${14 * MIN * RATE} WHERE id = ${outage.epoch}`;
        const gappy = yield* talked();
        yield* transcribed(gappy, 30, 120);
        yield* transcribed(gappy, 300, 840);
        const settled = yield* talked();
        yield* transcribed(settled, 30, 60);
        yield* uploaded(settled, 0, 6);
        yield* paused(settled, 12, 60);
        const untranscribed = yield* talked();
        yield* transcribed(untranscribed, 30, 45);
        yield* uploaded(untranscribed, 0, 6);
        yield* paused(untranscribed, 12, 60);
        const unuploaded = yield* talked();
        yield* transcribed(unuploaded, 30, 60);
        yield* uploaded(unuploaded, 0, 3);
        yield* paused(unuploaded, 12, 60);
        const recent = yield* talked();
        yield* transcribed(recent, 30, 60);
        yield* uploaded(recent, 0, 6);
        yield* paused(recent, 5, 60);
        // Speech 2.5 minutes ago, long after the first words, keeps a live listener's meeting open.
        const talking = yield* talked(20);
        yield* hear(talking.listener, talking.epoch, 17 * MIN, 17 * MIN + 30, 'one more point on the roadmap before we wrap');
        // ASR covered 10 minutes past the last speech, but a final inside that coverage is not placed in a meeting yet.
        const racing = yield* talked();
        yield* transcribed(racing, 30, 640);
        const late = yield* speak(racing.listener, racing.epoch, 640, 660, 'sorry about that, back to the roadmap');

        yield* sweepIdleMeetings();
        expect(yield* Effect.all([silent, briefly, outage, gappy, settled, untranscribed, unuploaded, recent, talking, racing].map(stateOf))).toEqual([
          'closing', 'provisional', 'provisional', 'provisional', 'closing', 'provisional', 'provisional', 'provisional', 'active', 'provisional',
        ]);
        const [closed] = yield* sql<{ id: string }>`SELECT id FROM meetings WHERE listener_id = ${silent.listener.listener_id}`;
        expect(yield* rangesOf(closed!.id)).toEqual([{ epoch_id: silent.epoch, sample_start: 0, sample_end: 30 * RATE }]);
        const [event] = yield* sql<{ evidence: string }>`SELECT JSON_EXTRACT(decision, '$.evidence') AS evidence FROM boundary_events WHERE meeting_id = ${closed!.id} AND operation = 'close'`;
        expect(event!.evidence).toEqual(['idle_close']);
        // Same final work as an explicit close, scheduled once per meeting even when the sweep runs again.
        yield* sweepIdleMeetings();
        expect((yield* jobsOf(device.workspace_id)).filter(job => job.kind !== 'context.refresh')).toHaveLength(2);

        // Once ASR recovers and the backlog uploads, the same meetings are quiet and close.
        yield* transcribed(outage, 30, 14 * MIN);
        yield* transcribed(untranscribed, 45, 60);
        yield* uploaded(unuploaded, 3, 6);
        yield* sweepIdleMeetings();
        expect(yield* Effect.all([outage, untranscribed, unuploaded].map(stateOf))).toEqual(['closing', 'closing', 'closing']);
        expect(yield* Effect.all([briefly, gappy, recent, talking].map(stateOf))).toEqual(['provisional', 'provisional', 'provisional', 'active']);
        // The threshold decides: lowered to five minutes, the shorter silence closes too.
        yield* sweepIdleMeetings(5 * MIN * 1000);
        expect(yield* stateOf(briefly)).toBe('closing');
        expect(yield* stateOf(talking)).toBe('active');
        // Coverage and the final landed together but placement was still in flight: neither sweep closes it, and placing the final keeps the meeting open.
        expect(yield* stateOf(racing)).toBe('provisional');
        yield* onFinalSegments({ ...racing.listener, segments: [late] });
        yield* sweepIdleMeetings();
        // Placed 640 s into the meeting, the final establishes it (promoted to active); it is still open.
        expect(yield* stateOf(racing)).toBe('active');
      }),
      { migrated: true },
    ),
  );
});
