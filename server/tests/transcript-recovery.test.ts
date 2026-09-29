import { SqlClient } from '@effect/sql';
import { expect, layer } from '@effect/vitest';
import { type AccessScope, type CaptureEpochId, Unavailable } from '@sanctum/contracts';
import { syntheticPcm } from '@sanctum/contracts/fixtures';
import { Effect, Either, Layer } from 'effect';
import { heartbeat, registerListener, startEpoch } from '../src/listeners.ts';
import { reconcileTranscript } from '../src/media/reconcile.ts';
import { putChunk } from '../src/recordings.ts';
import { finalSegments, getSegments, recordFinalWindow } from '../src/transcripts.ts';
import { chunk, fakeSpeech, MigratedDatabase, newEpochId, seedDevice } from './support/media.ts';
import { memoryObjectStore } from './support/object-store.ts';

const RATE = 16_000;

/** A device with one open epoch, an archive holding `seconds` of uploaded audio, and fake providers. */
const setup = (seconds: number) =>
  Effect.gen(function* () {
    const access = yield* seedDevice('Room');
    const listener = yield* registerListener(access, { name: 'Room', mode: 'room', capabilities: {} });
    const { lease_generation } = yield* heartbeat(access, listener.id, { lease_generation: 0, state: 'starting', epoch_id: null, buffered_chunks: 0, storage_bytes_free: null });
    const epoch_id = newEpochId();
    const clock = { sample_rate: RATE, channels: 1, encoding: 'pcm_s16le', sample_start: 0, captured_at: '2026-09-26T17:00:00Z', timezone: 'America/Los_Angeles' } as const;
    yield* startEpoch(access, { _tag: 'start', protocol_version: 1, listener_id: listener.id, epoch_id, track: 0, clock: clock as never, lease_generation, start_reason: 'start' });
    const store = memoryObjectStore();
    const speech = fakeSpeech();
    const providers = Layer.merge(store.layer, speech.layer);
    for (let second = 0; second < seconds; second++) {
      const upload = chunk({ listener_id: listener.id, epoch_id, sequence: second, sample_start: second * RATE, samples: syntheticPcm({ sampleRate: RATE, seconds: 1, toneHz: 300 }) });
      yield* Effect.provide(putChunk(access, listener.id, upload.manifest.chunk_id, upload.manifest, upload.body), providers);
    }
    const reconcile = (sample_start: number, sample_end: number) =>
      Effect.provide(reconcileTranscript({ workspace_id: access.workspace_id, payload: { epoch_id, track: 0, sample_start, sample_end } }), providers);
    return { access, epoch_id, speech, reconcile };
  });

const liveFinal = (access: AccessScope, epoch_id: CaptureEpochId, sample_start: number, sample_end: number, text: string) =>
  recordFinalWindow({
    workspace_id: access.workspace_id,
    epoch_id,
    track: 0,
    window: { sample_start, sample_end },
    segments: [{ sample_start, sample_end, text, confidence: 0.9, speaker_label: '0' }],
    origin: 'live',
    provider: 'fake',
    model: 'fake-1',
    provider_connection_id: null,
  });

const texts = (access: AccessScope, epoch_id: CaptureEpochId, sample_end = 10 * RATE) =>
  Effect.map(finalSegments(access, { epoch_id, track: 0, sample_start: 0, sample_end }), segments =>
    segments.map(segment => [segment.origin, segment.source.sample_start, segment.source.sample_end, segment.text, segment.revision]),
  );

/**
 * Recovered offline audio: an archive-only epoch journaled with `end_reason` and 5 s of audio, uploaded
 * and reconciled one chunk job at a time. Returns the meeting states before the last job and after it.
 */
const recoverArchive = (end_reason: 'close' | 'interrupted' | 'pause', takeover_at: string | null = null) =>
  Effect.gen(function* () {
    const access = yield* seedDevice('Room');
    const listener = yield* registerListener(access, { name: 'Room', mode: 'room', capabilities: {} });
    const { lease_generation } = yield* heartbeat(access, listener.id, { lease_generation: 0, state: 'starting', epoch_id: null, buffered_chunks: 0, storage_bytes_free: null });
    const epoch_id = newEpochId();
    const clock = { sample_rate: RATE, channels: 1, encoding: 'pcm_s16le', sample_start: 0, captured_at: '2026-09-26T17:00:00Z', timezone: 'America/Los_Angeles' } as const;
    const start = { _tag: 'start', protocol_version: 1, listener_id: listener.id, epoch_id, track: 0, clock: clock as never, lease_generation, start_reason: 'start', archive_only: true, end_reason, sample_end: 5 * RATE } as const;
    expect(yield* startEpoch(access, start)).toMatchObject({ _tag: 'accepted' });
    const store = memoryObjectStore();
    const speech = fakeSpeech();
    speech.controls.batch = (samples, sample_rate) =>
      Effect.succeed([{ start_s: 0, end_s: samples.length / sample_rate, is_final: true, text: 'We will review the hiring budget today.', confidence: 0.9, speaker: '0' }]);
    const providers = Layer.merge(store.layer, speech.layer);
    const sql = yield* SqlClient.SqlClient;
    // Another device claimed the next generation while this one was still recording offline.
    if (takeover_at !== null) {
      yield* sql`INSERT INTO listener_lease_claims (workspace_id, listener_id, lease_generation, claimed_at) VALUES (${access.workspace_id}, ${listener.id}, ${lease_generation + 1}, ${takeover_at})`;
    }
    const uploaded: Array<boolean> = [];
    for (let second = 0; second < 5; second++) {
      const samples = syntheticPcm({ sampleRate: RATE, seconds: 1, toneHz: 300 });
      const upload = chunk({ listener_id: listener.id, epoch_id, sequence: second, sample_start: second * RATE, samples, captured_at: `2026-09-26T17:00:0${second}Z` });
      uploaded.push(Either.isRight(yield* Effect.either(Effect.provide(putChunk(access, listener.id, upload.manifest.chunk_id, upload.manifest, upload.body), providers))));
    }
    const states = () => Effect.map(sql<{ state: string }>`SELECT state FROM meetings WHERE listener_id = ${listener.id}`, rows => rows.map(row => row.state));
    const reconcile = (second: number) =>
      Effect.provide(reconcileTranscript({ workspace_id: access.workspace_id, payload: { epoch_id, track: 0, sample_start: second * RATE, sample_end: (second + 1) * RATE } }), providers);
    for (const second of [4, 0, 1, 2]) yield* reconcile(second);
    const before = yield* states();
    yield* reconcile(3);
    return { before, after: yield* states(), uploaded };
  });

layer(MigratedDatabase, { timeout: 120_000 })('offline transcript reconciliation', it => {
  it.effect('seals the meeting of recovered offline audio with the journaled end reason once it is reconciled', () =>
    Effect.gen(function* () {
      // Chunk jobs finish out of order; the meeting seals only once the last gap is reconciled.
      expect(yield* recoverArchive('close')).toMatchObject({ before: ['provisional'], after: ['closing'] });
      expect(yield* recoverArchive('interrupted')).toMatchObject({ before: ['provisional'], after: ['interrupted'] });
      // A takeover mid-epoch: audio after it is refused, and the meeting seals once the held audio is reconciled.
      expect(yield* recoverArchive('close', '2026-09-26 17:00:03')).toEqual({ before: ['closing'], after: ['closing'], uploaded: [true, true, true, false, false] });
      // A pause is not an end of the meeting: it stays open for the next capture.
      expect((yield* recoverArchive('pause')).after).toEqual(['provisional']);
    }));

  it.effect('batch-transcribes an upload that arrives before live ASR, and later live finals do not duplicate it', () =>
    Effect.gen(function* () {
      const { access, epoch_id, speech, reconcile } = yield* setup(1);
      const outcome = yield* reconcile(0, RATE);
      expect(outcome.result).toEqual({ transcribed: [{ sample_start: 0, sample_end: RATE }], missing_audio: [] });
      expect(speech.batches.map(batch => batch.samples.length)).toEqual([RATE]);
      expect(yield* liveFinal(access, epoch_id, 1_000, 9_000, 'live duplicate')).toEqual([]);
      expect(yield* texts(access, epoch_id)).toEqual([['batch', 0, RATE, 'batch text', 1]]);
    }),
  );

  it.effect('transcribes only the part of an upload that live ASR did not finish', () =>
    Effect.gen(function* () {
      const { access, epoch_id, speech, reconcile } = yield* setup(1);
      yield* liveFinal(access, epoch_id, 0, 8_000, 'live words');
      const outcome = yield* reconcile(0, RATE);
      expect(outcome.result).toMatchObject({ transcribed: [{ sample_start: 8_000, sample_end: RATE }] });
      expect(speech.batches[0]!.samples.length).toBe(8_000);
      expect(speech.batches[0]!.samples[0]).toBe(syntheticPcm({ sampleRate: RATE, seconds: 1, toneHz: 300 })[8_000]);
      expect(yield* texts(access, epoch_id)).toEqual([
        ['live', 0, 8_000, 'live words', 1],
        ['batch', 8_000, RATE, 'batch text', 1],
      ]);
    }),
  );

  it.effect('retries a provider failure without recording coverage, then completes', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { access, epoch_id, speech, reconcile } = yield* setup(1);
      speech.controls.batch = () => Effect.fail(new Unavailable({ message: 'Deepgram: batch responded 503', retryable: true }));
      const failure = yield* Effect.flip(reconcile(0, RATE));
      expect(failure).toMatchObject({ _tag: 'JobFailure', retryable: true });
      const [coverage] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM transcript_coverage WHERE epoch_id = ${epoch_id}`;
      expect(Number(coverage!.count)).toBe(0);

      speech.controls.batch = (samples, rate) => Effect.succeed([{ start_s: 0, end_s: samples.length / rate, is_final: true, text: 'after retry', confidence: 0.7, speaker: null }]);
      yield* reconcile(0, RATE);
      expect(yield* texts(access, epoch_id)).toEqual([['batch', 0, RATE, 'after retry', 1]]);
    }),
  );

  it.effect('treats a duplicate delivery of the same job as a no-op', () =>
    Effect.gen(function* () {
      const { access, epoch_id, speech, reconcile } = yield* setup(1);
      yield* reconcile(0, RATE);
      const again = yield* reconcile(0, RATE);
      expect(again.result).toEqual({ transcribed: [], missing_audio: [] });
      expect(speech.batches).toHaveLength(1);
      expect(yield* texts(access, epoch_id)).toHaveLength(1);
    }),
  );

  it.effect('resumes after a crash mid-reconciliation without repeating finished ranges', () =>
    Effect.gen(function* () {
      const { access, epoch_id, speech, reconcile } = yield* setup(2);
      const answer = speech.controls.batch;
      speech.controls.batch = (samples, rate) => (speech.batches.length === 2 ? Effect.die('worker process killed') : answer(samples, rate));
      yield* Effect.exit(reconcile(0, 2 * RATE));
      expect(yield* texts(access, epoch_id)).toEqual([['batch', 0, RATE, 'batch text', 1]]);

      speech.controls.batch = answer;
      const resumed = yield* reconcile(0, 2 * RATE);
      expect(resumed.result).toMatchObject({ transcribed: [{ sample_start: RATE, sample_end: 2 * RATE }] });
      expect(speech.batches.map(batch => batch.samples[0])).toEqual([speech.batches[0]!.samples[0], speech.batches[1]!.samples[0], speech.batches[1]!.samples[0]]);
      expect(yield* texts(access, epoch_id)).toHaveLength(2);
    }),
  );

  it.effect('reports ranges without archived audio as gaps and never opens speech or action work', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { access, epoch_id, reconcile } = yield* setup(1);
      const outcome = yield* reconcile(0, 3 * RATE);
      expect(outcome.result).toEqual({ transcribed: [{ sample_start: 0, sample_end: RATE }], missing_audio: [{ sample_start: RATE, sample_end: 3 * RATE }] });
      expect(yield* texts(access, epoch_id)).toHaveLength(1);
      const kinds = yield* sql<{ kind: string }>`SELECT DISTINCT kind FROM jobs WHERE workspace_id = ${access.workspace_id}`;
      expect(kinds.map(row => row.kind)).toEqual(['transcript.reconcile']);
    }),
  );

  it.effect('keeps correction history when a replayed final changes the text of a range', () =>
    Effect.gen(function* () {
      const { access, epoch_id } = yield* setup(0);
      yield* liveFinal(access, epoch_id, 0, 8_000, 'first hearing');
      expect(yield* liveFinal(access, epoch_id, 0, 8_000, 'first hearing')).toEqual([]);
      const [revised] = yield* liveFinal(access, epoch_id, 0, 8_000, 'corrected hearing');
      expect(revised).toMatchObject({ revision: 2, text: 'corrected hearing' });
      expect(yield* texts(access, epoch_id)).toEqual([['live', 0, 8_000, 'corrected hearing', 2]]);
      const sql = yield* SqlClient.SqlClient;
      const history = yield* sql<{ text: string }>`SELECT text FROM transcript_segments WHERE epoch_id = ${epoch_id} ORDER BY revision`;
      expect(history.map(row => row.text)).toEqual(['first hearing', 'corrected hearing']);

      expect(yield* getSegments(access, [revised!.id])).toEqual([revised]);
      const outsider = yield* seedDevice('Other room');
      expect(yield* getSegments(outsider, [revised!.id])).toEqual([]);
    }),
  );
});
