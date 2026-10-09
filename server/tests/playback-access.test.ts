import { createHash, randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, type CaptureEpochId, MeetingId, type WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { splitMeeting } from '../src/meeting-corrections.ts';
import { closeMeeting, finalizeMeeting } from '../src/meetings.ts';
import { assembleRecording, issueRecordingAccess } from '../src/playback.ts';
import { claimed, commitChunk, hear, jobsOf, meetingsOf, RATE, seedEpoch, seedListener } from './support/capture.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { memoryObjectStore } from './support/object-store.ts';

/** Distinct sample values (chunk sequence + 1) present in an assembled WAV, with their counts. */
const contents = (wav: Uint8Array) => {
  const samples = new Int16Array(wav.slice(44).buffer);
  const counts = new Map<number, number>();
  for (const sample of samples) counts.set(sample, (counts.get(sample) ?? 0) + 1);
  return Object.fromEntries(counts);
};

const assemble = (workspace_id: WorkspaceId, meeting_id: MeetingId) => assembleRecording(claimed(workspace_id, 'recording.assemble', { meeting_id }));

const setup = (store: ReturnType<typeof memoryObjectStore>) =>
  Effect.gen(function* () {
    const [owner, device, member] = yield* seedWorkspace('Playback', ['owner', 'device', 'member']);
    const listener = yield* seedListener(device!);
    const epoch = yield* seedEpoch(listener);
    // Chunks 0-5 cover [0, 60 s); chunk 3 ([30, 40 s)) never reached R2.
    for (const sequence of [0, 1, 2, 4, 5]) yield* commitChunk(listener, epoch, sequence, store);
    yield* hear(listener, epoch, 0, 55, 'we are reviewing the launch checklist today');
    const [row] = yield* meetingsOf(listener.workspace_id);
    const meeting = MeetingId.make(row!.id);
    return { owner: owner!, member: member!, listener, epoch, meeting };
  });

describe('meeting recording playback', () => {
  it.effect('assembles only the meeting cut, reports missing audio as gaps and signs a short-lived URL', () => {
    const store = memoryObjectStore();
    return withDatabase(
      Effect.gen(function* () {
        const { owner, listener, meeting } = yield* setup(store);
        expect(yield* Effect.flip(issueRecordingAccess(owner, meeting))).toMatchObject({ _tag: 'Unavailable', message: 'The recording is assembled after the meeting closes' });
        yield* closeMeeting(owner, meeting);
        expect(yield* Effect.flip(issueRecordingAccess(owner, meeting))).toMatchObject({ _tag: 'Unavailable', retryable: true });
        yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id: meeting }));
        const outcome = yield* assemble(listener.workspace_id, meeting);
        expect(outcome).toMatchObject({ status: 'succeeded', result: { object_key: `meetings/${listener.workspace_id}/${meeting}/r1.wav`, status: 'partial' } });
        const cut = store.objects.get(`meetings/${listener.workspace_id}/${meeting}/r1.wav`)!;
        expect(contents(cut.body)).toEqual({ 1: 10 * RATE, 2: 10 * RATE, 3: 10 * RATE, 5: 10 * RATE, 6: 5 * RATE });
        expect(new TextDecoder().decode(cut.body.slice(0, 4))).toBe('RIFF');
        expect(cut.sha256).toBe(createHash('sha256').update(cut.body).digest('hex'));
        const access = yield* issueRecordingAccess(owner, meeting);
        expect(access).toMatchObject({ meeting_id: meeting, boundary_revision: 1 });
        expect(access.gaps.map(gap => [gap.sample_start / RATE, gap.sample_end / RATE])).toEqual([[30, 40]]);
        // Saved audio in play order: the file's second 30 is source second 40.
        expect(access.pieces.map(piece => [piece.sample_start / RATE, piece.sample_end / RATE])).toEqual([[0, 30], [40, 55]]);
        expect(access.sample_rate).toBe(RATE);
        expect(Date.parse(access.expires_at) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
        expect(store.verifySignedUrl(access.url)).toBe(`meetings/${listener.workspace_id}/${meeting}/r1.wav`);
        store.now = () => Date.now() + 5 * 60_000 + 1;
        expect(store.verifySignedUrl(access.url)).toBeNull();
        expect((yield* jobsOf(listener.workspace_id)).map(job => job.kind)).toContain('speakers.refine');
        const again = yield* assemble(listener.workspace_id, meeting);
        expect(again).toMatchObject({ result: { object_key: `meetings/${listener.workspace_id}/${meeting}/r1.wav` } });
        // Finalizing the same revision again keeps its cut's status instead of resetting it to pending.
        const refinalized = yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id: meeting }));
        expect(refinalized).toMatchObject({ result: { processing: { recording: 'partial' } } });
      }).pipe(Effect.provide(store.layer)),
      { migrated: true },
    );
  });

  it.effect('after a split, new URLs reference only the revised cut; the old cut is never re-signed', () => {
    const store = memoryObjectStore();
    return withDatabase(
      Effect.gen(function* () {
        const { owner, listener, epoch, meeting } = yield* setup(store);
        yield* closeMeeting(owner, meeting);
        yield* assemble(listener.workspace_id, meeting);
        const old = yield* issueRecordingAccess(owner, meeting);
        const { later } = yield* splitMeeting(owner, meeting, { expected_revision: 1, at: { epoch_id: epoch, sample: 20 * RATE } });
        expect(yield* Effect.flip(issueRecordingAccess(owner, meeting))).toMatchObject({ _tag: 'Unavailable', message: 'The recording for boundary revision 2 is not assembled yet' });
        yield* assemble(listener.workspace_id, meeting);
        yield* assemble(listener.workspace_id, later.id);
        const earlier = yield* issueRecordingAccess(owner, meeting);
        const laterAccess = yield* issueRecordingAccess(owner, later.id);
        expect(store.verifySignedUrl(earlier.url)).toBe(`meetings/${listener.workspace_id}/${meeting}/r2.wav`);
        expect(contents(store.objects.get(`meetings/${listener.workspace_id}/${meeting}/r2.wav`)!.body)).toEqual({ 1: 10 * RATE, 2: 10 * RATE });
        expect(contents(store.objects.get(`meetings/${listener.workspace_id}/${later.id}/r1.wav`)!.body)).toEqual({ 3: 10 * RATE, 5: 10 * RATE, 6: 5 * RATE });
        expect(laterAccess.gaps.map(gap => [gap.sample_start / RATE, gap.sample_end / RATE])).toEqual([[30, 40]]);
        expect(earlier.gaps).toEqual([]);
        // The earlier-issued URL still works until it expires, which is why its lifetime is short.
        expect(store.verifySignedUrl(old.url)).toBe(`meetings/${listener.workspace_id}/${meeting}/r1.wav`);
      }).pipe(Effect.provide(store.layer)),
      { migrated: true },
    );
  });

  it.effect('checks access fresh on every request: scopes, meeting grants, allowlists and workspaces', () => {
    const store = memoryObjectStore();
    return withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner, member, listener, meeting } = yield* setup(store);
        yield* closeMeeting(owner, meeting);
        yield* assemble(listener.workspace_id, meeting);
        expect(yield* Effect.flip(issueRecordingAccess(member, meeting))).toMatchObject({ _tag: 'NotFound' });
        yield* sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
          VALUES (${owner.workspace_id}, ${meeting}, ${member.principal.id}, 'read', ${owner.principal.id}, UTC_TIMESTAMP(6))`;
        expect((yield* issueRecordingAccess(member, meeting)).boundary_revision).toBe(1);
        const writeOnlyAgent: AccessScope = { ...member, scopes: ['context:read', 'context:write'] };
        expect(yield* Effect.flip(issueRecordingAccess(writeOnlyAgent, meeting))).toMatchObject({ _tag: 'Forbidden', required_scope: 'recordings:read' });
        const allowlisted: AccessScope = { ...owner, meetings: { kind: 'allowlist', meeting_ids: [MeetingId.make(randomUUID())] } };
        expect(yield* Effect.flip(issueRecordingAccess(allowlisted, meeting))).toMatchObject({ _tag: 'NotFound' });
        yield* sql`DELETE FROM meeting_access WHERE principal_id = ${member.principal.id}`;
        expect(yield* Effect.flip(issueRecordingAccess(member, meeting))).toMatchObject({ _tag: 'NotFound' });
        const [stranger] = yield* seedWorkspace('Other team', ['owner']);
        expect(yield* Effect.flip(issueRecordingAccess({ ...stranger!, workspace_id: stranger!.workspace_id }, meeting))).toMatchObject({ _tag: 'NotFound' });
        store.failNext('presign');
        expect(yield* Effect.flip(issueRecordingAccess(owner, meeting))).toMatchObject({ _tag: 'Unavailable', message: 'Recording storage unavailable' });
      }).pipe(Effect.provide(store.layer)),
      { migrated: true },
    );
  });

  it.effect('a meeting without any saved audio fails assembly visibly instead of producing a file', () => {
    const store = memoryObjectStore();
    return withDatabase(
      Effect.gen(function* () {
        const [owner, device] = yield* seedWorkspace('Silent', ['owner', 'device']);
        const listener = yield* seedListener(device!);
        const epoch = yield* seedEpoch(listener);
        yield* hear(listener, epoch, 0, 20, 'this audio never made it to storage');
        const meeting = MeetingId.make((yield* meetingsOf(listener.workspace_id))[0]!.id);
        yield* closeMeeting(owner!, meeting);
        expect(yield* assemble(listener.workspace_id, meeting)).toMatchObject({ result: { missing: 'no committed audio inside the meeting ranges' } });
        expect(store.objects.size).toBe(0);
        expect(yield* Effect.flip(issueRecordingAccess(owner!, meeting))).toMatchObject({ _tag: 'Unavailable', message: 'No saved audio exists for this meeting', retryable: false });
      }).pipe(Effect.provide(store.layer)),
      { migrated: true },
    );
  });
});
