import { SqlClient } from '@effect/sql';
import { expect, layer } from '@effect/vitest';
import { type AccessScope, IanaTimeZone, type MeetingId, UtcTimestamp } from '@sanctum/contracts';
import { Effect, Layer } from 'effect';
import { refreshContext } from '../src/context-jobs.ts';
import { getContextSnapshot } from '../src/context.ts';
import type { ExtractionInput } from '../src/extraction.ts';
import { serverLayer } from '../src/main.ts';
import { claimed, meetingsOf } from './support/capture.ts';
import { api, claimListener, eventually, fakeSpeech, MigratedDatabase, newEpochId, openSocket, pcmFrame, seedDevice, serveApi, startMessage } from './support/media.ts';
import { memoryObjectStore } from './support/object-store.ts';

const RATE = 16_000;

layer(MigratedDatabase, { timeout: 120_000 })('client clock source time', it => {
  it.scoped('keeps the client clock anchor as source time when it is years ahead of the server clock', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tokens = new Map<string, AccessScope>();
      const speech = fakeSpeech();
      const host = yield* serveApi(serverLayer, tokens, Layer.merge(memoryObjectStore().layer, speech.layer));
      const access = yield* seedDevice('Room A');
      tokens.set('device', access);
      const reader = { ...access, scopes: ['context:read' as const] };
      tokens.set('reader', reader);
      const { listener_id, lease_generation } = yield* claimListener(host, 'device');
      // 01:30:00.123 PDT on Friday 14 March 2031, years after the server's UTC_TIMESTAMP(6).
      const anchor = '2031-03-14T08:30:00.123Z';
      const epoch_id = newEpochId();
      const socket = yield* openSocket(host, listener_id, 'device');
      socket.send(startMessage({ listener_id, epoch_id, lease_generation, captured_at: anchor }));
      yield* socket.take('accepted');

      const [epoch] = yield* sql<{ captured_at: string; server_gap_ms: number }>`
        SELECT CAST(captured_at AS CHAR) AS captured_at, ABS(TIMESTAMPDIFF(MICROSECOND, started_at, UTC_TIMESTAMP(6))) DIV 1000 AS server_gap_ms FROM capture_epochs WHERE id = ${epoch_id}`;
      expect(epoch!.captured_at).toBe('2031-03-14 08:30:00.123000');
      expect(Number(epoch!.server_gap_ms)).toBeLessThan(60_000);

      for (let sequence = 0; sequence < 40; sequence++) {
        socket.send(pcmFrame(sequence, sequence * 1_600));
        yield* socket.take('ack');
      }
      const stream = (yield* eventually(Effect.sync(() => speech.streams[0]), stream => stream?.received === 4 * RATE))!;
      // The later span arrives first; the speech time is the sample position, not arrival order.
      stream.emit({ start_s: 3, end_s: 4, is_final: true, text: 'Sounds good.', confidence: 0.9, speaker: '0' });
      yield* socket.take('transcript');
      stream.emit({ start_s: 1, end_s: 2, is_final: true, text: 'I will send the pilot plan tomorrow.', confidence: 0.9, speaker: '0' });
      yield* socket.take('transcript');

      const [meeting] = yield* meetingsOf(access.workspace_id);
      expect(meeting!.started_at).toBe('2031-03-14 08:30:01.123000');
      const transcript = yield* api(host, 'reader', 'GET', `/meetings/${meeting!.id}/transcript`);
      expect(transcript.body.segments.map((segment: { text: string }) => segment.text)).toEqual(['I will send the pilot plan tomorrow.', 'Sounds good.']);

      const [said] = transcript.body.segments;
      let anchors: unknown;
      const extract = (input: ExtractionInput) => {
        anchors = input.epochs;
        return Effect.succeed([
          {
            kind: 'commitment' as const,
            text: 'Dana sends the pilot plan',
            quote: 'send the pilot plan tomorrow',
            derivation: 'spoken' as const,
            sources: [{ segment_id: said.id, start_ms: 0, end_ms: 0 }],
            time: { phrase: 'tomorrow', normalized: null, anchor: UtcTimestamp.make('2026-01-01T00:00:00Z'), timezone: IanaTimeZone.make('America/Los_Angeles'), ambiguous: true },
          },
        ]);
      };
      const outcome = yield* refreshContext(extract)(claimed(access.workspace_id, 'context.refresh', { meeting_id: meeting!.id }));
      expect(outcome).toMatchObject({ status: 'succeeded', result: { processed: 2, added: 1 } });
      expect(anchors).toMatchObject([{ epoch_id, sample_rate: RATE, sample_start: 0 }]);
      expect(Date.parse((anchors as [{ captured_at: string }])[0].captured_at)).toBe(Date.parse(anchor));
      const { items } = yield* getContextSnapshot(reader, meeting!.id as MeetingId);
      // "tomorrow" resolves from the client-clock utterance time in the meeting timezone: Saturday 15 March, local midnight.
      const utterance = Date.parse('2031-03-14T08:30:01.123Z');
      expect(items[0]).toMatchObject({ time: { phrase: 'tomorrow', normalized: '2031-03-15T07:00:00.000Z', timezone: 'America/Los_Angeles', ambiguous: true } });
      expect(Date.parse(items[0]!.event_at)).toBe(utterance);
      expect(Date.parse(items[0]!.time!.anchor)).toBe(utterance);
    }),
  );
});
