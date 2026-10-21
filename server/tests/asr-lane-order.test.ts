import { expect, layer } from '@effect/vitest';
import { ListenerId, type ServerControlMessage, StartMessage } from '@sanctum/contracts';
import { Deferred, Effect, Layer, Schema, Stream } from 'effect';
import { liveLimits, openLiveSession } from '../src/media/session.ts';
import { makeSpeechGate, SpeechGate, SpeechReplies, SpeechWorkRequests } from '../src/media/speech-gate.ts';
import { SpeechSynthesizer } from '../src/providers/speech.ts';
import { SpeechToText } from '../src/providers/whisper.ts';
import { seedEpoch, seedListener } from './support/capture.ts';
import { eventually, fakeSpeech, MigratedDatabase, pcmFrame, seedDevice, startMessage } from './support/media.ts';

layer(MigratedDatabase)('rotated ASR lanes', it => {
  it.scoped('orders delayed old-lane finals before completing a direct request and still cancels speech', () =>
    Effect.gen(function* () {
      const access = yield* seedDevice('Lane ordering');
      const listener = yield* seedListener(access);
      const listener_id = ListenerId.make(listener.listener_id);
      const epoch_id = yield* seedEpoch(listener);
      const release = yield* Deferred.make<void>();
      const speech = fakeSpeech();
      const provider = yield* Effect.provide(SpeechToText, speech.layer);
      let opened = 0;
      const messages: ServerControlMessage[] = [];
      const requests: string[] = [];
      const work: string[] = [];
      const oldRetry = liveLimits.providerRetryMs;
      liveLimits.providerRetryMs = 0;
      yield* Effect.addFinalizer(() => Effect.sync(() => { liveLimits.providerRetryMs = oldRetry; }));
      const session = yield* openLiveSession({
        access, listener: { id: listener_id, capture_group_id: null }, resume_from_sample: 0,
        start: Schema.decodeUnknownSync(StartMessage)(JSON.parse(startMessage({ listener_id, epoch_id, lease_generation: 1 }))),
        send: message => Effect.sync(() => { messages.push(message); }),
      }).pipe(Effect.provide(Layer.mergeAll(
        Layer.succeed(SpeechToText, { ...provider, openStream: (...args) => provider.openStream(...args).pipe(
          Effect.map(stream => opened++ === 0 ? { ...stream, finish: Effect.zipRight(Deferred.await(release), stream.finish) } : stream)),
        }),
        Layer.succeed(SpeechGate, makeSpeechGate()),
        Layer.succeed(SpeechReplies, () => request => { requests.push(request); return Stream.never; }),
        Layer.succeed(SpeechWorkRequests, () => request => Effect.sync(() => { work.push(request); return false; })),
        Layer.succeed(SpeechSynthesizer, { synthesize: () => Stream.empty }),
      )));
      for (let i = 0; i < 40; i++) yield* session.frame(pcmFrame(i, i * 1_600));
      const old = speech.streams[0]!;
      old.emit({ start_s: 0, end_s: 1.5, is_final: true, text: 'Sanctum, please', confidence: 1, speaker: null });
      yield* eventually(Effect.sync(() => messages.filter(message => message._tag === 'transcript').length), count => count === 1);
      old.pending.push({ start_s: 1.5, end_s: 4, is_final: true, text: 'send', confidence: 1, speaker: null });
      old.backlog = liveLimits.asrBacklogMs * 16 * 2;
      for (let i = 40; i < 60; i++) yield* session.frame(pcmFrame(i, i * 1_600));
      speech.streams[1]!.emitBatch({ start_s: 0, end_s: 2, results: [
        { start_s: 0, end_s: 1, is_final: true, text: 'the notes', confidence: 1, speaker: null },
      ] });
      yield* eventually(Effect.sync(() => messages.filter(message => message._tag === 'transcript').length), count => count === 2);
      expect(work).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* eventually(Effect.sync(() => requests), values => values.length === 1);
      expect(requests).toEqual(['please send the notes']);
      expect(work).toEqual(requests);
      yield* session.frame(pcmFrame(60, 60 * 1_600));
      speech.streams[1]!.emit({ start_s: 2, end_s: 2.1, is_final: false, text: 'wait', confidence: 1, speaker: null });
      yield* eventually(Effect.sync(() => messages.filter(message => message._tag === 'speech_cancel')), values => values.length === 1);
      expect(messages.find(message => message._tag === 'speech_cancel')).toMatchObject({ reason: 'barge_in' });
      yield* session.stop('pause');
      expect(work).toEqual(['please send the notes']);
    }),
  );
});
