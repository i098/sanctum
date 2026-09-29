/**
 * Plan section 18 "Silence": ordinary speech, background research and actions, pause, reconnect
 * and echo emit zero audio; a direct request is the positive control. Speech is counted where
 * it leaves the server: the messages the controller hands to the socket.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { type CaptureEpochId, type ListenerId, type SpeechCancelMessage, type SpeechChunkMessage, type TranscriptSegment } from '@sanctum/contracts';
import { Effect, Schedule, Stream, TestClock } from 'effect';
import { vi } from 'vitest';
import { createActionGrant, requestAction } from '../src/actions.ts';
import { engineeringDefaults } from '../src/config.ts';
import { executeAction, runResearch } from '../src/executor.ts';
import { directRequest, makeSpeechGate, SpeechGate, speechController } from '../src/media/speech-gate.ts';
import { planActions } from '../src/planner.ts';
import { SpeechSynthesizer } from '../src/providers/cartesia.ts';
import { provider, queuedJob, seedAccount } from './support/actions.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

vi.mock('../src/integrations.ts', async importOriginal => {
  const { fakeIntegrations } = await import('./support/actions.ts');
  return fakeIntegrations(importOriginal as never);
});
vi.mock('../src/planner.ts', () => ({ planActions: vi.fn() }));

const LISTENER = randomUUID() as ListenerId;
const EPOCH = randomUUID() as CaptureEpochId;
const RATE = 16_000;
const { endOfTurnMs, windowMs } = engineeringDefaults.speech;

/** Final (or partial) transcript segment spanning `[startMs, endMs)` of the epoch. */
const heard = (text: string, startMs: number, endMs: number, status: 'final' | 'partial' = 'final') =>
  ({
    id: randomUUID(),
    source: { epoch_id: EPOCH, track: 0, sample_start: (startMs * RATE) / 1000, sample_end: (endMs * RATE) / 1000 },
    text,
    status,
    revision: 1,
    origin: 'live',
    provider: 'fixture',
    model: 'fixture',
    provider_connection_id: null,
    speaker_label: null,
    speaker_track_id: null,
    confidence: null,
    created_at: '2026-09-29T12:00:00Z',
  }) as unknown as TranscriptSegment;

/** 100 ms of 24 kHz PCM16 per chunk, two chunks per sentence. */
const synthesized: string[] = [];
const fakeSynthesizer = SpeechSynthesizer.of({
  synthesize: text => Stream.suspend(() => (synthesized.push(text), Stream.make(new Uint8Array(4_800), new Uint8Array(4_800)))),
});

/** A controller on a fake wall clock; `reply` streams the planner's answer for a request. */
const listen = (reply: (request: string) => Stream.Stream<string>, gate = makeSpeechGate(() => clock.now)) =>
  Effect.gen(function* () {
    const sent: Array<SpeechChunkMessage | SpeechCancelMessage> = [];
    const requests: string[] = [];
    const controller = yield* speechController({
      listener_id: LISTENER,
      sample_rate: RATE,
      send: message => Effect.sync(() => void sent.push(message)),
      respond: request => (requests.push(request), reply(request)),
    }).pipe(Effect.provideService(SpeechGate, gate), Effect.provideService(SpeechSynthesizer, fakeSynthesizer));
    const chunks = () => sent.filter((message): message is SpeechChunkMessage => message._tag === 'speech_chunk');
    return { ...controller, gate, sent, requests, chunks };
  });

const clock = { now: 1_000_000 };
/** Lets forked turn/speech fibers run after the test clock moves. */
const settle = (ms: number) =>
  Effect.forEach(Array.from({ length: Math.ceil(ms / 50) }), () => Effect.zipRight(TestClock.adjust('50 millis'), Effect.repeatN(Effect.yieldNow(), 20)), { discard: true });

const slowly = (...parts: string[]) => () => Stream.fromIterable(parts.map(part => `${part} `)).pipe(Stream.schedule(Schedule.spaced('1 second')));

describe('speech gate', () => {
  it.effect('stays silent through ordinary conversation, partial wake words and passive transitions', () =>
    Effect.gen(function* () {
      const session = yield* listen(() => Stream.make('Should not be heard.'));
      yield* session.onSegment(heard('Let us review the budget for next quarter.', 0, 3_000));
      yield* session.onSegment(heard('We could ask Sanctum about it later.', 3_100, 5_000));
      yield* session.onSegment(heard('Sanctum', 6_000, 6_400, 'partial'));
      yield* session.onSegment(heard('Sanctum', 6_000, 6_500));
      yield* settle(endOfTurnMs * 3);
      yield* session.onEnd('pause');
      yield* session.onEnd('disconnect');
      expect(session.sent).toEqual([]);
      expect(session.requests).toEqual([]);
      expect(synthesized).toEqual([]);
    }));

  it.effect('speaks a direct request once its turn completes, and only then', () =>
    Effect.gen(function* () {
      const session = yield* listen(() => Stream.make('The next item ', 'is hiring. Then budget.'));
      yield* session.onSegment(heard('Sanctum, what is', 10_000, 10_800));
      yield* settle(endOfTurnMs / 2);
      yield* session.onSegment(heard('next on the agenda?', 11_000, 11_900));
      yield* settle(endOfTurnMs / 2);
      expect(session.sent).toEqual([]); // turn still open
      yield* settle(endOfTurnMs);
      expect(session.requests).toEqual(['what is next on the agenda?']);
      const chunks = session.chunks();
      expect(chunks).toHaveLength(4);
      expect(new Set(chunks.map(chunk => `${chunk.request_id}/${chunk.generation}`)).size).toBe(1);
      expect(chunks.map(chunk => chunk.sequence)).toEqual([0, 1, 2, 3]);
      expect(chunks[0]).toMatchObject({ sample_rate: 24_000, audio: Buffer.alloc(4_800).toString('base64') });
      expect(synthesized.slice(-2)).toEqual(['The next item is hiring.', 'Then budget.']);
    }));

  it.effect('does not hear its own speech as a request or a barge-in', () =>
    Effect.gen(function* () {
      const session = yield* listen(() => Stream.make('Sanctum can send the notes to Alex.'));
      yield* session.onSegment(heard('Sanctum, who gets the notes?', 20_000, 21_000));
      yield* settle(endOfTurnMs);
      expect(session.chunks()).toHaveLength(2);
      // The room microphone picks up the reply.
      yield* session.onSegment(heard('sanctum can send the notes', 21_500, 22_500, 'partial'));
      yield* session.onSegment(heard('Sanctum can send the notes to Alex', 21_500, 23_000));
      yield* settle(endOfTurnMs * 2);
      expect(session.requests).toHaveLength(1);
      expect(session.sent.filter(message => message._tag === 'speech_cancel')).toEqual([]);
      // Once the echo tail has passed, the same words from a person are a real request.
      clock.now += 60_000;
      yield* session.onSegment(heard('Sanctum can send the notes to Alex', 90_000, 91_000));
      yield* settle(endOfTurnMs);
      expect(session.requests).toEqual(['who gets the notes?', 'can send the notes to Alex']);
    }));

  it.effect('stops on barge-in and never emits the interrupted generation again', () =>
    Effect.gen(function* () {
      const session = yield* listen(slowly('First point.', 'Second point.', 'Third point.'));
      yield* session.onSegment(heard('Sanctum, summarize the meeting', 30_000, 31_000));
      yield* settle(endOfTurnMs + 1_500);
      const before = session.chunks().length;
      expect(before).toBeGreaterThan(0);
      const { generation, request_id } = session.chunks()[0]!;
      yield* session.onSegment(heard('wait, hold on', 33_000, 33_400, 'partial'));
      expect(session.sent.at(-1)).toEqual({ _tag: 'speech_cancel', generation, reason: 'barge_in' });
      expect(session.gate.mayEmit(request_id, generation)).toBe(false);
      yield* settle(5_000);
      expect(session.chunks()).toHaveLength(before);
    }));

  it.effect('rejects the older generation when a person asks something new over it', () =>
    Effect.gen(function* () {
      const session = yield* listen(slowly('One.', 'Two.', 'Three.', 'Four.'));
      yield* session.onSegment(heard('Sanctum, read the action items', 40_000, 41_000));
      yield* settle(endOfTurnMs + 1_500);
      const first = session.chunks()[0]!;
      clock.now += 1;
      yield* session.onSegment(heard('Sanctum, stop and tell me the time', 42_000, 43_000));
      yield* settle(endOfTurnMs);
      const cancels = session.sent.filter(message => message._tag === 'speech_cancel');
      expect(cancels).toContainEqual({ _tag: 'speech_cancel', generation: first.generation, reason: 'barge_in' });
      yield* settle(10_000);
      const later = session.chunks().filter(chunk => chunk.request_id !== first.request_id);
      expect(later.length).toBeGreaterThan(0);
      expect(later.every(chunk => chunk.generation > first.generation)).toBe(true);
      expect(session.gate.mayEmit(first.request_id, first.generation)).toBe(false);
    }));

  it.effect('stops at the end of the speech window', () =>
    Effect.gen(function* () {
      const session = yield* listen(slowly('One.', 'Two.', 'Three.'));
      yield* session.onSegment(heard('Sanctum, list everything', 50_000, 51_000));
      yield* settle(endOfTurnMs + 1_500);
      const emitted = session.chunks().length;
      clock.now += windowMs + 1;
      yield* settle(5_000);
      expect(session.chunks()).toHaveLength(emitted);
      expect(session.sent.at(-1)).toMatchObject({ _tag: 'speech_cancel', reason: 'expired' });
    }));

  it.effect('cancels on disconnect and does not resume after reconnecting', () =>
    Effect.gen(function* () {
      const gate = makeSpeechGate(() => clock.now);
      const first = yield* listen(slowly('One.', 'Two.', 'Three.'), gate);
      yield* first.onSegment(heard('Sanctum, walk me through the plan', 60_000, 61_000));
      yield* settle(endOfTurnMs + 1_500);
      const { request_id, generation } = first.chunks()[0]!;
      const before = first.chunks().length;
      yield* first.onEnd('disconnect');
      expect(first.sent.at(-1)).toEqual({ _tag: 'speech_cancel', generation, reason: 'disconnect' });
      const reconnected = yield* listen(slowly('One.', 'Two.', 'Three.'), gate);
      yield* reconnected.onSegment(heard('okay we are back', 62_000, 63_000));
      yield* settle(10_000);
      expect(first.chunks()).toHaveLength(before);
      expect(reconnected.sent).toEqual([]);
      expect(gate.mayEmit(request_id, generation)).toBe(false);
    }));

  it('recognizes only a leading direct address', () => {
    expect(directRequest('Hey Sanctum, book the room')).toBe('book the room');
    expect(directRequest('okay sanctum: what time is it')).toBe('what time is it');
    expect(directRequest('Sanctum')).toBeNull();
    expect(directRequest('ask sanctum later')).toBeNull();
    expect(directRequest('Sanctuary is a word')).toBeNull();
  });
});

describe('background work', () => {
  it.live('emits no audio while actions succeed or fail and research completes during capture', () =>
    withDatabase(
      Effect.gen(function* () {
        const session = yield* listen(() => Stream.make('Should not be heard.'));
        const [owner, agent] = yield* seedWorkspace('Silent', ['owner', 'agent']);
        const account = yield* seedAccount(owner!);
        yield* createActionGrant(owner!, { grantee: agent!.principal.id, action_key: 'gmail-send-email', account_id: account, meeting_id: null, restrictions: {}, expires_at: null });
        const input = (key: string) => ({ action_key: 'gmail-send-email', configuration_ref: 'cfg', version: '1', arguments: {}, meeting_id: null, idempotency_key: key });
        yield* session.onSegment(heard('The customer call went well.', 0, 2_000));
        const ok = yield* requestAction(agent!, input('ok'));
        const rejected = yield* requestAction(agent!, input('rejected'));
        yield* Effect.flatMap(queuedJob(agent!.workspace_id, 'action.execute', ok.action_id), executeAction);
        provider.mode = 'reject';
        yield* Effect.flatMap(queuedJob(agent!.workspace_id, 'action.execute', rejected.action_id), executeAction);
        vi.mocked(planActions).mockReturnValue(Effect.succeed([input('planned')]));
        yield* runResearch({ ...(yield* queuedJob(agent!.workspace_id, 'action.execute', ok.action_id)), payload: { meeting_id: null, request: 'follow up' } });
        yield* session.onSegment(heard('Let us wrap up.', 3_000, 4_000));
        yield* Effect.sleep(`${endOfTurnMs * 2} millis`);
        yield* session.onEnd('pause');
        expect(session.sent).toEqual([]);
      }),
      { migrated: true },
    ));
});
