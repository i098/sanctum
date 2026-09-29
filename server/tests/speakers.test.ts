import { randomUUID } from 'node:crypto';
import { HttpClient, HttpClientResponse } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, MeetingId, ProfileId, type ProviderConnectionId, SpeakerTrackId } from '@sanctum/contracts';
import { Effect, Layer, Redacted } from 'effect';
import { evaluateSpeakers } from '../../scripts/evaluate-speakers.ts';
import { getTranscript } from '../src/meetings-api.ts';
import { closeMeeting, getMeeting } from '../src/meetings.ts';
import { issueRecordingAccess } from '../src/playback.ts';
import { LiveDiarization, makePyannote, PyannoteClient, pyannoteLimits, type BatchDiarization } from '../src/providers/pyannote.ts';
import { applyVoiceMatches, enrollVoice, mapSpeaker, openDiarizationConnection, recordSpeakerTurns, refineSpeakers, revokeEnrollment } from '../src/speakers.ts';
import { claimed, hear, meetingsOf, RATE, seedEpoch, seedListener } from './support/capture.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { memoryObjectStore } from './support/object-store.ts';

const seedProfile = (access: AccessScope, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = ProfileId.make(randomUUID());
    yield* sql`INSERT INTO profiles (id, workspace_id, principal_id, kind, display_name, details, created_at, updated_at)
      VALUES (${id}, ${access.workspace_id}, ${access.principal.id}, 'person', ${name}, '{}', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    return id;
  });

const tracksOf = (connection: ProviderConnectionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ id: string; provider_label: string; sample_start: string; profile_id: string | null; mapping_source: string | null; attribution_revision: number }>`SELECT id, provider_label,
      sample_start, profile_id, mapping_source, attribution_revision FROM speaker_tracks WHERE provider_connection_id = ${connection} ORDER BY sample_start`;
  });

/** Closed 60-second meeting with an assembled cut and people: owner (alice), member (bob), admin (carol). */
const meetingWithPeople = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [owner, device, member, admin] = yield* seedWorkspace('Speakers', ['owner', 'device', 'member', 'admin']);
  const listener = yield* seedListener(device!);
  const epoch = yield* seedEpoch(listener);
  yield* hear(listener, epoch, 0, 10, 'alice opens the planning meeting');
  yield* hear(listener, epoch, 17, 21, 'both people talk over each other here');
  yield* hear(listener, epoch, 50, 60, 'someone new asks about the schedule');
  const meeting = MeetingId.make((yield* meetingsOf(listener.workspace_id))[0]!.id);
  yield* closeMeeting(owner!, meeting);
  const pieces = [{ epoch_id: epoch, track: 0, sample_start: 0, sample_end: 60 * RATE }];
  yield* sql`INSERT INTO meeting_recordings (id, workspace_id, meeting_id, boundary_revision, object_key, sha256, byte_length, sample_rate, sample_count, pieces, created_at)
    VALUES (${randomUUID()}, ${listener.workspace_id}, ${meeting}, 1, ${`meetings/${meeting}/r1.wav`}, ${Buffer.alloc(32)}, ${44 + 120 * RATE}, ${RATE}, ${60 * RATE},
      ${JSON.stringify(pieces)}, UTC_TIMESTAMP(6))`;
  const people = { alice: yield* seedProfile(owner!, 'Alice'), bob: yield* seedProfile(member!, 'Bob'), carol: yield* seedProfile(admin!, 'Carol') };
  return { owner: owner!, member: member!, admin: admin!, listener, epoch, meeting, people };
});

const enroll = (access: AccessScope, profile_id: ProfileId) => enrollVoice(access, { profile_id, voiceprint: `vp-${profile_id}`, consent_version: '2026-09' });

const fakePyannote = (result: BatchDiarization, seen: Array<ReadonlyArray<string>> = []) =>
  Layer.succeed(PyannoteClient, {
    configured: true,
    diarize: ({ voiceprints }) => Effect.sync(() => {
      seen.push(voiceprints.map(voiceprint => voiceprint.label));
      return result;
    }),
    createVoiceprint: () => Effect.die('unused'),
    createLiveStream: () => Effect.die('unused'),
  });

describe('speaker attribution', () => {
  it.effect('refinement names only clear enrolled matches; overlap, similar voices and unknown participants stay unnamed', () => {
    const store = memoryObjectStore();
    const seen: Array<ReadonlyArray<string>> = [];
    return withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner, member, admin, listener, meeting, people } = yield* meetingWithPeople;
        yield* enroll(owner, people.alice);
        yield* enroll(member, people.bob);
        const carolEnrollment = yield* enroll(admin, people.carol);
        yield* revokeEnrollment(admin, carolEnrollment);
        const result: BatchDiarization = {
          model: 'precision-3',
          turns: [
            { label: 'SPEAKER_00', start_s: 0, end_s: 20, confidence: 0.9 },
            { label: 'SPEAKER_01', start_s: 18, end_s: 40, confidence: 0.8 },
            { label: 'SPEAKER_02', start_s: 40, end_s: 50, confidence: 0.7 },
            { label: 'SPEAKER_03', start_s: 50, end_s: 60, confidence: 0.9 },
          ],
          matches: [
            { label: 'SPEAKER_00', scores: { [people.alice]: 91, [people.bob]: 30 } },
            { label: 'SPEAKER_01', scores: { [people.alice]: 80, [people.bob]: 76 } },
            { label: 'SPEAKER_02', scores: { [people.alice]: 20, [people.bob]: 35 } },
            { label: 'SPEAKER_03', scores: { [people.carol]: 95 } },
          ],
        };
        const job = claimed(listener.workspace_id, 'speakers.refine', { meeting_id: meeting });
        const outcome = yield* refineSpeakers(job).pipe(Effect.provide(fakePyannote(result, seen)));
        expect(outcome).toMatchObject({ status: 'succeeded', result: { boundary_revision: 1, turns: 4, named: 1 } });
        // Revoked enrollments are never sent to the provider.
        expect(seen.map(labels => [...labels].sort())).toEqual([[people.alice, people.bob].sort()]);
        const [connection] = yield* sql<{ id: ProviderConnectionId }>`SELECT id FROM provider_connections WHERE purpose = 'batch_diarization' AND workspace_id = ${listener.workspace_id}`;
        const tracks = yield* tracksOf(connection!.id);
        expect(tracks.map(track => [track.provider_label, Number(track.sample_start) / RATE, track.profile_id, track.mapping_source])).toEqual([
          ['SPEAKER_00', 0, people.alice, 'enrollment'],
          ['SPEAKER_01', 18, null, null],
          ['SPEAKER_02', 40, null, null],
          ['SPEAKER_03', 50, null, null],
        ]);
        const transcript = yield* getTranscript(owner, meeting, {});
        const attributed = transcript.segments.map(segment => [segment.text, transcript.speakers.find(track => track.id === segment.speaker_track_id)?.provider_label ?? null]);
        expect(attributed).toEqual([
          ['alice opens the planning meeting', 'SPEAKER_00'],
          ['both people talk over each other here', null],
          ['someone new asks about the schedule', 'SPEAKER_03'],
        ]);
        expect(JSON.stringify(transcript)).not.toContain('vp-');
        expect(yield* refineSpeakers(job).pipe(Effect.provide(fakePyannote(result)))).toMatchObject({ result: { skipped: 'already refined for this boundary revision' } });
      }).pipe(Effect.provide(store.layer)),
      { migrated: true },
    );
  });

  it.effect('user corrections are revision-checked, apply to one provider label and are never overridden by voice matches', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner, listener, epoch, meeting, people } = yield* meetingWithPeople;
        const connection = yield* openDiarizationConnection({ workspace_id: listener.workspace_id, source: { epoch_id: epoch, track: 0 }, anchor_sample: 0, sample_rate: RATE, purpose: 'diarization', model: 'live-1' });
        yield* recordSpeakerTurns({ workspace_id: listener.workspace_id, provider_connection_id: connection, turns: [
          { label: 'SPEAKER_01', start_s: 0, end_s: 8, confidence: null },
          { label: 'SPEAKER_01', start_s: 30, end_s: 35, confidence: null },
        ] });
        const [first] = yield* tracksOf(connection);
        const input = { speaker_track_id: SpeakerTrackId.make(first!.id), profile_id: people.bob, expected_revision: 1 };
        const mapped = yield* mapSpeaker(owner, meeting, input);
        expect(mapped.map(track => [track.profile_id, track.mapping_source, track.attribution_revision])).toEqual([
          [people.bob, 'user_confirmed', 2],
          [people.bob, 'user_confirmed', 2],
        ]);
        expect(yield* Effect.flip(mapSpeaker(owner, meeting, input))).toMatchObject({ _tag: 'RevisionConflict', current_revision: 2 });
        expect(yield* applyVoiceMatches(listener.workspace_id, connection, [{ label: 'SPEAKER_01', scores: { [people.alice]: 99 } }], new Map([[people.alice, people.alice]]))).toBe(0);
        const unmapped = yield* mapSpeaker(owner, meeting, { ...input, profile_id: null, expected_revision: 2 });
        expect(unmapped.every(track => track.profile_id === null && track.attribution_revision === 3)).toBe(true);
        const history = yield* sql<{ attribution_revision: number; profile_id: string | null }>`SELECT attribution_revision, profile_id FROM speaker_attributions WHERE provider_connection_id = ${connection} ORDER BY attribution_revision`;
        expect(history.map(row => [row.attribution_revision, row.profile_id])).toEqual([[2, people.bob], [3, null]]);
        // Correcting a closed meeting re-queues its final work so notes and memory are recomputed.
        const [finalize] = yield* sql<{ status: string }>`SELECT status FROM jobs WHERE kind = 'meeting.finalize' AND work_key = ${`meeting:${meeting}`} AND status = 'pending'`;
        expect(finalize).toBeDefined();
        const [stranger] = yield* seedWorkspace('Elsewhere', ['owner']);
        expect(yield* Effect.flip(mapSpeaker(stranger!, meeting, { ...input, expected_revision: 3 }))).toMatchObject({ _tag: 'NotFound' });
      }),
      { migrated: true },
    ),
  );

  it.effect('stream rotation and reconnect never carry a label across provider connections', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, listener, epoch, meeting, people } = yield* meetingWithPeople;
        const open = (anchor: number) => openDiarizationConnection({ workspace_id: listener.workspace_id, source: { epoch_id: epoch, track: 0 }, anchor_sample: anchor, sample_rate: RATE, purpose: 'diarization', model: 'live-1' });
        const before = yield* open(0);
        const turn = { label: 'SPEAKER_00', start_s: 0, end_s: 5, confidence: null };
        expect(yield* recordSpeakerTurns({ workspace_id: listener.workspace_id, provider_connection_id: before, turns: [turn] })).toBe(1);
        yield* recordSpeakerTurns({ workspace_id: listener.workspace_id, provider_connection_id: before, turns: [turn] });
        const [track] = yield* tracksOf(before);
        yield* mapSpeaker(owner, meeting, { speaker_track_id: SpeakerTrackId.make(track!.id), profile_id: people.alice, expected_revision: 1 });
        // Rotation: the replacement stream starts at 30 s and restarts its own labels and clock.
        const after = yield* open(30 * RATE);
        yield* recordSpeakerTurns({ workspace_id: listener.workspace_id, provider_connection_id: after, turns: [turn] });
        yield* recordSpeakerTurns({ workspace_id: listener.workspace_id, provider_connection_id: before, turns: [{ ...turn, start_s: 10, end_s: 12 }] });
        const [rotated] = yield* tracksOf(after);
        expect(rotated).toMatchObject({ provider_label: 'SPEAKER_00', sample_start: String(30 * RATE), profile_id: null, attribution_revision: 1 });
        expect((yield* tracksOf(before)).map(row => [row.profile_id, row.attribution_revision])).toEqual([[people.alice, 2], [people.alice, 2]]);
        expect(yield* tracksOf(before)).toHaveLength(2);
        expect(LiveDiarization.mustRotate(pyannoteLimits.rotateAfterMs - 1)).toBe(false);
        expect(LiveDiarization.mustRotate(pyannoteLimits.rotateAfterMs)).toBe(true);
        expect(pyannoteLimits.rotateAfterMs).toBeLessThan(pyannoteLimits.maxStreamMs);
      }),
      { migrated: true },
    ),
  );

  it.effect('a voice match is never authorization: attribution grants no access and enrollment is self-only', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, member, listener, epoch, meeting, people } = yield* meetingWithPeople;
        const connection = yield* openDiarizationConnection({ workspace_id: listener.workspace_id, source: { epoch_id: epoch, track: 0 }, anchor_sample: 0, sample_rate: RATE, purpose: 'diarization', model: 'live-1' });
        yield* recordSpeakerTurns({ workspace_id: listener.workspace_id, provider_connection_id: connection, turns: [{ label: 'SPEAKER_00', start_s: 0, end_s: 60, confidence: 1 }] });
        expect(yield* applyVoiceMatches(listener.workspace_id, connection, [{ label: 'SPEAKER_00', scores: { [people.bob]: 99 } }], new Map([[people.bob, people.bob]]))).toBe(1);
        // Bob is attributed as the only speaker, yet his membership alone still cannot see this restricted meeting.
        expect(yield* Effect.flip(getMeeting(member, meeting))).toMatchObject({ _tag: 'NotFound' });
        expect(yield* Effect.flip(issueRecordingAccess(member, meeting).pipe(Effect.provide(memoryObjectStore().layer)))).toMatchObject({ _tag: 'NotFound' });
        expect(yield* Effect.flip(enroll(owner, people.bob))).toMatchObject({ _tag: 'Forbidden' });
        const agent: AccessScope = { ...member, principal: { ...member.principal, kind: 'agent' } };
        expect(yield* Effect.flip(enroll(agent, people.bob))).toMatchObject({ _tag: 'Forbidden' });
      }),
      { migrated: true },
    ),
  );
});

describe('pyannote adapter', () => {
  const respond = (routes: Record<string, unknown>, log: Array<{ method: string; url: string; auth: string | undefined; body: unknown }>) =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(request =>
        Effect.sync(() => {
          const body = request.body._tag === 'Uint8Array' ? JSON.parse(new TextDecoder().decode(request.body.body)) : null;
          log.push({ method: request.method, url: request.url, auth: request.headers.authorization, body });
          const path = request.url.replace(pyannoteLimits.apiBase, '');
          return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(routes[path] ?? { message: 'no route' }), { status: path in routes ? 200 : 500 }));
        }),
      ),
    );

  it.effect('fails visibly when not configured and sends nothing', () =>
    Effect.gen(function* () {
      const log: Array<never> = [];
      const client = yield* makePyannote(null).pipe(Effect.provide(respond({}, log)));
      expect(client.configured).toBe(false);
      expect(yield* Effect.flip(client.diarize({ url: 'https://objects.test/a.wav', voiceprints: [] }))).toMatchObject({ _tag: 'Unavailable', retryable: false });
      expect(log).toEqual([]);
    }),
  );

  it.effect('diarizes with precision-3, identifies with voiceprints and maps provider failures to Unavailable', () =>
    Effect.gen(function* () {
      const log: Array<{ method: string; url: string; auth: string | undefined; body: unknown }> = [];
      const routes = {
        '/diarize': { jobId: 'j1', status: 'created' },
        '/jobs/j1': { status: 'succeeded', output: { diarization: [{ speaker: 'SPEAKER_00', start: 0.5, end: 2.25, confidence: 0.8 }] } },
        '/identify': { jobId: 'j2', status: 'created' },
        '/jobs/j2': { status: 'succeeded', output: { diarization: [], voiceprints: [{ speaker: 'SPEAKER_00', match: 'p1', confidence: { p1: 86 } }] } },
        '/live': { id: 's1', url: 'wss://live.test/s1?token=single-use' },
      };
      const client = yield* makePyannote(Redacted.make('fixture-key')).pipe(Effect.provide(respond(routes, log)));
      expect(yield* client.diarize({ url: 'https://objects.test/a.wav', voiceprints: [] })).toEqual({
        model: 'precision-3',
        turns: [{ label: 'SPEAKER_00', start_s: 0.5, end_s: 2.25, confidence: 0.8 }],
        matches: [],
      });
      expect(log[0]).toEqual({ method: 'POST', url: `${pyannoteLimits.apiBase}/diarize`, auth: 'Bearer fixture-key', body: { url: 'https://objects.test/a.wav', model: 'precision-3', turnLevelConfidence: true } });
      const identified = yield* client.diarize({ url: 'https://objects.test/a.wav', voiceprints: [{ label: 'p1', voiceprint: 'vp' }] });
      expect(identified.matches).toEqual([{ label: 'SPEAKER_00', scores: { p1: 86 } }]);
      expect(log.find(entry => entry.url.endsWith('/identify'))!.body).toMatchObject({ voiceprints: [{ label: 'p1', voiceprint: 'vp' }], matching: { exclusive: true } });
      expect(yield* client.createLiveStream()).toEqual({ id: 's1', url: 'wss://live.test/s1?token=single-use' });
      expect(yield* Effect.flip(client.createVoiceprint('https://objects.test/voice.wav'))).toMatchObject({ _tag: 'Unavailable', retryable: true, message: 'pyannote: HTTP 500' });
    }),
  );

  it('streams 16 kHz float32 100 ms messages and keeps overlapping live turns separate', () => {
    const sent: Array<string | ArrayBuffer> = [];
    const live = new LiveDiarization({ send: data => void sent.push(data) }, 48_000);
    live.push(new Int16Array(48_000 * 0.25).fill(16_384));
    expect(sent).toHaveLength(2);
    expect((sent[0] as ArrayBuffer).byteLength).toBe(6_400);
    expect(new Float32Array(sent[0] as ArrayBuffer)[0]).toBe(0.5);
    live.end();
    expect(sent).toHaveLength(4);
    expect(new Float32Array(sent[2] as ArrayBuffer).slice(-1)[0]).toBe(0);
    expect(sent[3]).toBe('{"type":"end_of_stream"}');
    const events = [
      ['diarization_speaker_start', 0.4, 'SPEAKER_00'],
      ['diarization_speaker_start', 1.2, 'SPEAKER_01'],
      ['diarization_speaker_end', 1.9, 'SPEAKER_00'],
      ['diarization_speaker_end', 2.6, 'SPEAKER_01'],
    ] as const;
    for (const [type, timestamp, speaker] of events) live.receive(JSON.stringify({ type, data: { timestamp, speaker } }));
    live.receive('{"type":"error","message":"Invalid chunk size"}');
    expect(live.turns).toEqual([
      { label: 'SPEAKER_00', start_s: 0.4, end_s: 1.9, confidence: null },
      { label: 'SPEAKER_01', start_s: 1.2, end_s: 2.6, confidence: null },
    ]);
    expect(live.errors).toEqual(['Invalid chunk size']);
    expect(() => new LiveDiarization({ send: () => undefined }, 44_100)).toThrow(/multiple of 16 kHz/);
  });
});

describe('speaker evaluation', () => {
  it('measures false identity separately from confusion and honest unknowns', () => {
    const report = evaluateSpeakers(
      [
        { start: 0, end: 10, person: 'alice' },
        { start: 10, end: 20, person: 'bob' },
        { start: 20, end: 30, person: null },
        { start: 30, end: 40, person: 'carol' },
      ],
      [
        { start: 0, end: 10, label: 'A', person: 'alice' },
        { start: 10, end: 20, label: 'A', person: 'alice' },
        { start: 20, end: 30, label: 'B', person: 'dave' },
        { start: 30, end: 36, label: 'C', person: null },
      ],
    );
    expect(report).toEqual({
      speech_s: 40,
      missed_s: 4,
      false_identity_s: 20,
      correct_identity_s: 10,
      unnamed_known_s: 6,
      label_confusion_s: 10,
      false_identity_rate: 0.5,
    });
  });
});
