import { createHash, randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, type CaptureEpochId, MeetingId, type WorkspaceId } from '@sanctum/contracts';
import { Deferred, Effect, Fiber } from 'effect';
import { splitMeeting } from '../src/meeting-corrections.ts';
import { closeMeeting, finalizeMeeting } from '../src/meetings.ts';
import { assembleRecording, issueRecordingAccess } from '../src/playback.ts';
import { ObjectStore } from '../src/providers/object-store.ts';
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
    return { owner: owner!, device: device!, member: member!, listener, epoch, meeting };
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
        expect(outcome).toMatchObject({ status: 'succeeded', result: { status: 'partial' } });
        const access = yield* issueRecordingAccess(owner, meeting);
        const object_key = store.verifySignedUrl(access.url)!;
        expect(outcome).toMatchObject({ result: { object_key } });
        const cut = store.objects.get(object_key)!;
        expect(contents(cut.body)).toEqual({ 1: 10 * RATE, 2: 10 * RATE, 3: 10 * RATE, 5: 10 * RATE, 6: 5 * RATE });
        expect(new TextDecoder().decode(cut.body.slice(0, 4))).toBe('RIFF');
        expect(cut.sha256).toBe(createHash('sha256').update(cut.body).digest('hex'));
        expect(access).toMatchObject({ meeting_id: meeting, boundary_revision: 1 });
        expect(access.gaps.map(gap => [gap.sample_start / RATE, gap.sample_end / RATE])).toEqual([[30, 40]]);
        // Saved audio in play order: the file's second 30 is source second 40.
        expect(access.pieces.map(piece => [piece.sample_start / RATE, piece.sample_end / RATE])).toEqual([[0, 30], [40, 55]]);
        expect(access.sample_rate).toBe(RATE);
        expect(Date.parse(access.expires_at) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
        expect(store.verifySignedUrl(access.url)).toBe(object_key);
        store.now = () => Date.now() + 5 * 60_000 + 1;
        expect(store.verifySignedUrl(access.url)).toBeNull();
        expect((yield* jobsOf(listener.workspace_id)).map(job => job.kind)).toContain('speakers.refine');
        const again = yield* assemble(listener.workspace_id, meeting);
        expect(again).toMatchObject({ result: { object_key } });
        // Finalizing the same revision again keeps its cut's status instead of resetting it to pending.
        const refinalized = yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id: meeting }));
        expect(refinalized).toMatchObject({ result: { processing: { recording: 'partial' } } });
      }).pipe(Effect.provide(store.layer)),
      { migrated: true },
    );
  });

  it.effect('retries the full cut when a late final joins after assembly reads the ranges', () => {
    const store = memoryObjectStore();
    return withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [device] = yield* seedWorkspace('Late final', ['device']);
        const listener = yield* seedListener(device!);
        const epoch = yield* seedEpoch(listener);
        for (let sequence = 0; sequence < 5; sequence++) yield* commitChunk(listener, epoch, sequence, store);
        yield* hear(listener, epoch, 0, 30, 'please send the summary to the whole team');
        const meeting = MeetingId.make((yield* meetingsOf(listener.workspace_id))[0]!.id);
        yield* sql`UPDATE capture_epochs SET live_sample_end = ${40 * RATE} WHERE id = ${epoch}`;
        yield* closeMeeting(device!, meeting, { epoch_id: epoch, fence_sample: 50 * RATE });
        yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id: meeting }));
        const objectStore = yield* ObjectStore;
        const first = yield* Effect.either(assemble(listener.workspace_id, meeting).pipe(
          Effect.provideService(ObjectStore, {
            ...objectStore,
            put: (...args) => objectStore.put(...args).pipe(Effect.tap(() =>
              hear(listener, epoch, 41, 46, 'and include the revised deadline').pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie))),
          }),
        ));
        expect(first).toMatchObject({ _tag: 'Left', left: { _tag: 'JobFailure', retryable: true } });
        expect(yield* sql`SELECT id FROM meeting_recordings WHERE meeting_id = ${meeting}`).toEqual([]);
        expect(yield* sql`SELECT processing->>'$.recording' AS recording FROM meetings WHERE id = ${meeting}`).toEqual([{ recording: 'pending' }]);
        expect((yield* jobsOf(listener.workspace_id)).map(job => job.kind)).not.toContain('speakers.refine');
        expect((yield* meetingsOf(listener.workspace_id)).map(row => row.boundary_revision)).toEqual([1]);
        const refinalized = yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id: meeting }));
        expect(refinalized).toMatchObject({ result: { processing: { recording: 'pending' } } });
        expect(yield* assemble(listener.workspace_id, meeting)).toMatchObject({ status: 'succeeded', result: { status: 'complete', boundary_revision: 1 } });
        const access = yield* issueRecordingAccess(device!, meeting);
        expect(access.pieces).toEqual([{ epoch_id: epoch, track: 0, sample_start: 0, sample_end: 46 * RATE }]);
        expect(access.gaps).toEqual([]);
        expect(contents(store.objects.get(store.verifySignedUrl(access.url)!)!.body)).toEqual({
          1: 10 * RATE, 2: 10 * RATE, 3: 10 * RATE, 4: 10 * RATE, 5: 6 * RATE,
        });
        expect((yield* jobsOf(listener.workspace_id)).map(job => job.kind)).toContain('speakers.refine');
      }).pipe(Effect.provide(store.layer)),
      { migrated: true },
    );
  });

  it.effect('a stale overlapping assembly cannot overwrite the published recording', () => {
    const store = memoryObjectStore();
    return withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [device] = yield* seedWorkspace('Overlapping assembly', ['device']);
        const listener = yield* seedListener(device!);
        const epoch = yield* seedEpoch(listener);
        for (let sequence = 0; sequence < 5; sequence++) yield* commitChunk(listener, epoch, sequence, store);
        yield* hear(listener, epoch, 0, 30, 'please send the summary to the whole team');
        const meeting = MeetingId.make((yield* meetingsOf(listener.workspace_id))[0]!.id);
        yield* sql`UPDATE capture_epochs SET live_sample_end = ${40 * RATE} WHERE id = ${epoch}`;
        yield* closeMeeting(device!, meeting, { epoch_id: epoch, fence_sample: 50 * RATE });
        yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id: meeting }));
        const uploading = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const objectStore = yield* ObjectStore;
        const stale = yield* assemble(listener.workspace_id, meeting).pipe(
          Effect.provideService(ObjectStore, {
            ...objectStore,
            put: (...args) => Deferred.succeed(uploading, undefined).pipe(
              Effect.zipRight(Deferred.await(resume)),
              Effect.zipRight(objectStore.put(...args)),
            ),
          }),
          Effect.either,
          Effect.fork,
        );
        yield* Deferred.await(uploading);
        yield* hear(listener, epoch, 41, 46, 'and include the revised deadline');
        expect((yield* meetingsOf(listener.workspace_id)).map(row => row.boundary_revision)).toEqual([1]);
        expect(yield* assemble(listener.workspace_id, meeting)).toMatchObject({ result: { status: 'complete', boundary_revision: 1 } });
        const published = yield* issueRecordingAccess(device!, meeting);
        const object_key = store.verifySignedUrl(published.url)!;
        const recording = store.objects.get(object_key)!;
        yield* Deferred.succeed(resume, undefined);
        expect(yield* Fiber.join(stale)).toMatchObject({ _tag: 'Left', left: { _tag: 'JobFailure', retryable: true } });
        expect(store.objects.get(object_key)).toEqual(recording);
        expect(contents(store.objects.get(object_key)!.body)).toEqual({
          1: 10 * RATE, 2: 10 * RATE, 3: 10 * RATE, 4: 10 * RATE, 5: 6 * RATE,
        });
        expect(yield* sql`SELECT object_key, LOWER(HEX(sha256)) AS sha256 FROM meeting_recordings WHERE meeting_id = ${meeting}`)
          .toEqual([{ object_key, sha256: recording.sha256 }]);
        expect(yield* sql`SELECT processing->>'$.recording' AS recording FROM meetings WHERE id = ${meeting}`)
          .toEqual([{ recording: 'complete' }]);
        const access = yield* issueRecordingAccess(device!, meeting);
        expect(store.verifySignedUrl(access.url)).toBe(object_key);
        expect(access.pieces).toEqual([{ epoch_id: epoch, track: 0, sample_start: 0, sample_end: 46 * RATE }]);
        expect(access.gaps).toEqual([]);
        expect(yield* assemble(listener.workspace_id, meeting)).toMatchObject({ result: { object_key, boundary_revision: 1 } });
      }).pipe(Effect.provide(store.layer)),
      { migrated: true },
    );
  });

  it.effect('keeps the first published cut and its status when a late chunk completes an overlapping assembly', () => {
    const store = memoryObjectStore();
    return withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner, listener, epoch, meeting } = yield* setup(store);
        yield* closeMeeting(owner, meeting);
        const objectStore = yield* ObjectStore;
        const partialUpload = yield* Deferred.make<void>();
        const publishPartial = yield* Deferred.make<void>();
        const partial = yield* assemble(listener.workspace_id, meeting).pipe(
          Effect.provideService(ObjectStore, {
            ...objectStore,
            put: (...args) => Deferred.succeed(partialUpload, undefined).pipe(
              Effect.zipRight(Deferred.await(publishPartial)),
              Effect.zipRight(objectStore.put(...args)),
            ),
          }),
          Effect.fork,
        );
        yield* Deferred.await(partialUpload);
        yield* commitChunk(listener, epoch, 3, store);
        const completeUpload = yield* Deferred.make<void>();
        const publishComplete = yield* Deferred.make<void>();
        const complete = yield* assemble(listener.workspace_id, meeting).pipe(
          Effect.provideService(ObjectStore, {
            ...objectStore,
            put: (...args) => Deferred.succeed(completeUpload, undefined).pipe(
              Effect.zipRight(Deferred.await(publishComplete)),
              Effect.zipRight(objectStore.put(...args)),
            ),
          }),
          Effect.fork,
        );
        yield* Deferred.await(completeUpload);
        yield* Deferred.succeed(publishPartial, undefined);
        expect(yield* Fiber.join(partial)).toMatchObject({ result: { status: 'partial', boundary_revision: 1 } });
        const published = yield* issueRecordingAccess(owner, meeting);
        const object_key = store.verifySignedUrl(published.url)!;
        yield* Deferred.succeed(publishComplete, undefined);
        const result = yield* Fiber.join(complete);
        expect(result).toEqual(yield* assemble(listener.workspace_id, meeting));
        expect(result).toMatchObject({ result: { object_key, boundary_revision: 1 } });
        expect(yield* sql`SELECT object_key FROM meeting_recordings WHERE meeting_id = ${meeting}`).toEqual([{ object_key }]);
        expect(yield* sql`SELECT processing->>'$.recording' AS recording FROM meetings WHERE id = ${meeting}`).toEqual([{ recording: 'partial' }]);
        const access = yield* issueRecordingAccess(owner, meeting);
        expect(store.verifySignedUrl(access.url)).toBe(object_key);
        expect(access.gaps.map(gap => [gap.sample_start / RATE, gap.sample_end / RATE])).toEqual([[30, 40]]);
        expect(contents(store.objects.get(object_key)!.body)).toEqual({
          1: 10 * RATE, 2: 10 * RATE, 3: 10 * RATE, 5: 10 * RATE, 6: 5 * RATE,
        });
      }).pipe(Effect.provide(store.layer)),
      { migrated: true },
    );
  });

  it.effect('an overlapping empty cut cannot replace a published recording status', () => {
    const store = memoryObjectStore();
    return withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [owner] = yield* seedWorkspace('Empty overlapping cut', ['owner']);
        const listener = yield* seedListener(owner!);
        const epoch = yield* seedEpoch(listener);
        yield* commitChunk(listener, epoch, 0, store);
        yield* hear(listener, epoch, 0, 20, 'please send the summary to the whole team');
        const meeting = MeetingId.make((yield* meetingsOf(listener.workspace_id))[0]!.id);
        yield* closeMeeting(owner!, meeting);
        const reading = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const objectStore = yield* ObjectStore;
        const empty = yield* assemble(listener.workspace_id, meeting).pipe(
          Effect.provideService(ObjectStore, {
            ...objectStore,
            get: key => objectStore.get(key).pipe(
              Effect.as(new Uint8Array()),
              Effect.tap(() => Deferred.succeed(reading, undefined).pipe(Effect.zipRight(Deferred.await(resume)))),
            ),
          }),
          Effect.fork,
        );
        yield* Deferred.await(reading);
        yield* commitChunk(listener, epoch, 1, store);
        expect(yield* assemble(listener.workspace_id, meeting)).toMatchObject({ result: { status: 'complete' } });
        const published = yield* issueRecordingAccess(owner!, meeting);
        const object_key = store.verifySignedUrl(published.url)!;
        yield* Deferred.succeed(resume, undefined);
        expect(yield* Fiber.join(empty)).toMatchObject({ result: { object_key, boundary_revision: 1 } });
        expect(yield* sql`SELECT object_key FROM meeting_recordings WHERE meeting_id = ${meeting}`).toEqual([{ object_key }]);
        expect(yield* sql`SELECT processing->>'$.recording' AS recording FROM meetings WHERE id = ${meeting}`).toEqual([{ recording: 'complete' }]);
        expect(contents(store.objects.get(object_key)!.body)).toEqual({ 1: 10 * RATE, 2: 10 * RATE });
        expect((yield* issueRecordingAccess(owner!, meeting)).gaps).toEqual([]);
      }).pipe(Effect.provide(store.layer)),
      { migrated: true },
    );
  });

  it.effect('a late-final transaction sees a cut published after its first read', () => {
    const store = memoryObjectStore();
    return withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { device, listener, epoch, meeting } = yield* setup(store);
        yield* closeMeeting(device, meeting, { epoch_id: epoch, fence_sample: 60 * RATE });
        yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id: meeting }));
        const snapshot = yield* Deferred.make<void>();
        const published = yield* Deferred.make<void>();
        const lateFinal = yield* sql.withTransaction(Effect.gen(function* () {
          yield* sql`SELECT id FROM meeting_recordings WHERE meeting_id = ${meeting}`;
          yield* Deferred.succeed(snapshot, undefined);
          yield* Deferred.await(published);
          yield* hear(listener, epoch, 56, 59, 'and include the revised deadline');
        })).pipe(Effect.fork);
        yield* Deferred.await(snapshot);
        yield* assemble(listener.workspace_id, meeting);
        yield* Deferred.succeed(published, undefined);
        yield* Fiber.join(lateFinal);
        expect((yield* meetingsOf(listener.workspace_id)).map(row => row.boundary_revision)).toEqual([2]);
        yield* finalizeMeeting(claimed(listener.workspace_id, 'meeting.finalize', { meeting_id: meeting }));
        expect(yield* assemble(listener.workspace_id, meeting)).toMatchObject({ result: { boundary_revision: 2, status: 'partial' } });
        const access = yield* issueRecordingAccess(device, meeting);
        expect(access.pieces.map(piece => [piece.sample_start / RATE, piece.sample_end / RATE])).toEqual([[0, 30], [40, 59]]);
        expect(contents(store.objects.get(store.verifySignedUrl(access.url)!)!.body)).toEqual({
          1: 10 * RATE, 2: 10 * RATE, 3: 10 * RATE, 5: 10 * RATE, 6: 9 * RATE,
        });
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
        const oldKey = store.verifySignedUrl(old.url);
        const { later } = yield* splitMeeting(owner, meeting, { expected_revision: 1, at: { epoch_id: epoch, sample: 20 * RATE } });
        expect(yield* Effect.flip(issueRecordingAccess(owner, meeting))).toMatchObject({ _tag: 'Unavailable', message: 'The recording for boundary revision 2 is not assembled yet' });
        yield* assemble(listener.workspace_id, meeting);
        yield* assemble(listener.workspace_id, later.id);
        const earlier = yield* issueRecordingAccess(owner, meeting);
        const laterAccess = yield* issueRecordingAccess(owner, later.id);
        expect(store.verifySignedUrl(earlier.url)).not.toBe(oldKey);
        expect(contents(store.objects.get(store.verifySignedUrl(earlier.url)!)!.body)).toEqual({ 1: 10 * RATE, 2: 10 * RATE });
        expect(contents(store.objects.get(store.verifySignedUrl(laterAccess.url)!)!.body)).toEqual({ 3: 10 * RATE, 5: 10 * RATE, 6: 5 * RATE });
        expect(laterAccess.gaps.map(gap => [gap.sample_start / RATE, gap.sample_end / RATE])).toEqual([[30, 40]]);
        expect(earlier.gaps).toEqual([]);
        // The earlier-issued URL still works until it expires, which is why its lifetime is short.
        expect(store.verifySignedUrl(old.url)).toBe(oldKey);
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
