import { describe, expect, it } from 'vitest';
import { HttpApi, HttpApiSchema, OpenApi } from '@effect/platform';
import { Either, JSONSchema, Schema } from 'effect';
import * as Contracts from '../src/index.ts';
import { HealthApi, SanctumApi } from '../src/api.ts';
import { syntheticPcm } from '../src/fixtures.ts';

const {
  ClientControlMessage,
  ServerControlMessage,
  NotFound,
  RevisionConflict,
  decodePcmFrame,
  encodePcmFrame,
  FRAME_HEADER_BYTES,
  MAX_FRAME_SAMPLES,
  UtcTimestamp,
  IanaTimeZone,
  SourceRange,
  WorkspaceId,
  SearchIntegrationActionsInput,
} = Contracts;

const uuid = '0b8f5c1e-3a52-4c1b-9d0e-5f7a2b6c8d90';
const epoch = '6c1d4e2f-8a3b-4c5d-9e6f-7a8b9c0d1e2f';

describe('wire contracts are JSON-representable', () => {
  const schemas = Object.entries(Contracts).filter(([, value]) => Schema.isSchema(value));

  it.each(schemas)('%s produces a JSON Schema', (_name, schema) => {
    expect(() => JSONSchema.make(schema as Schema.Schema<unknown, unknown>)).not.toThrow();
  });

  it('covers every seam named by the foundation', () => {
    expect(schemas.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'AccessScope', 'Listener', 'CaptureEpoch', 'SourceClock', 'RecordingChunkManifest', 'RecordingChunkReceipt',
        'TranscriptSegment', 'Meeting', 'MeetingRange', 'SpeakerTrack', 'ContextItem', 'ContextEvent',
        'ExtractionCandidate', 'SearchIntegrationActionsInput', 'GetIntegrationActionInput', 'RequestActionInput',
        'ActionGrant', 'ActionReceipt', 'Job', 'StartMessage',
      ]),
    );
  });
});

describe('primitives', () => {
  const accepts = <A, I>(schema: Schema.Schema<A, I>, value: unknown) => Either.isRight(Schema.decodeUnknownEither(schema)(value));

  it('branded IDs require UUIDs', () => {
    expect(accepts(WorkspaceId, uuid)).toBe(true);
    expect(accepts(WorkspaceId, 'workspace-1')).toBe(false);
  });

  it('UTC timestamps keep microseconds and require Z', () => {
    expect(accepts(UtcTimestamp, '2026-09-26T17:08:16.123456Z')).toBe(true);
    expect(accepts(UtcTimestamp, '2026-09-26T17:08:16Z')).toBe(true);
    expect(accepts(UtcTimestamp, '2026-09-26T17:08:16.1234567Z')).toBe(false);
    expect(accepts(UtcTimestamp, '2026-09-26T17:08:16+02:00')).toBe(false);
    expect(accepts(UtcTimestamp, '2026-13-40T17:08:16Z')).toBe(false);
  });

  it('time zones must be IANA names', () => {
    expect(accepts(IanaTimeZone, 'America/Los_Angeles')).toBe(true);
    expect(accepts(IanaTimeZone, 'UTC')).toBe(true);
    expect(accepts(IanaTimeZone, 'PST')).toBe(false);
    expect(accepts(IanaTimeZone, 'Mars/Olympus_Mons')).toBe(false);
  });

  it('source ranges are non-empty half-open intervals within safe integers', () => {
    expect(accepts(SourceRange, { epoch_id: epoch, track: 0, sample_start: 0, sample_end: 480 })).toBe(true);
    expect(accepts(SourceRange, { epoch_id: epoch, track: 0, sample_start: 480, sample_end: 480 })).toBe(false);
    expect(accepts(SourceRange, { epoch_id: epoch, track: 0, sample_start: 0, sample_end: 2 ** 53 })).toBe(false);
  });

  it('integration search defaults to three and caps at five', () => {
    expect(Schema.decodeUnknownSync(SearchIntegrationActionsInput)({ intent: 'create issue' }).limit).toBe(3);
    expect(accepts(SearchIntegrationActionsInput, { intent: 'create issue', limit: 6 })).toBe(false);
  });
});

describe('error envelope', () => {
  it('encodes code, message and retryable', () => {
    const encoded = Schema.encodeSync(NotFound)(new NotFound({ message: 'meeting not found' }));
    expect(encoded).toEqual({ _tag: 'NotFound', code: 'not_found', retryable: false, message: 'meeting not found' });
  });

  it('revision conflicts carry the current revision', () => {
    const decoded = Schema.decodeUnknownSync(RevisionConflict)({
      _tag: 'RevisionConflict', code: 'revision_conflict', retryable: false, message: 'stale', current_revision: 7,
    });
    expect(decoded.current_revision).toBe(7);
  });

  it('assigns an HTTP status to every typed failure', () => {
    const statuses = [
      [Contracts.Unauthenticated, 401], [Contracts.Forbidden, 403], [Contracts.NotFound, 404],
      [Contracts.RevisionConflict, 409], [Contracts.HashConflict, 409], [Contracts.Unavailable, 503],
    ] as const;
    for (const [schema, status] of statuses) expect(HttpApiSchema.getStatusError(schema)).toBe(status);
  });
});

describe('PCM frames', () => {
  const header = { track: 2, sequence: 7, sample_start: 2 ** 40 + 3, sample_count: 4 };
  const samples = Int16Array.from([0, 1, -1, -32768]);

  it('matches the documented byte layout', () => {
    const bytes = encodePcmFrame(header, samples);
    expect(Buffer.from(bytes).toString('hex')).toBe(
      '01010200' + '07000000' + '0300000000010000' + '04000000' + '00000000' + '0000' + '0100' + 'ffff' + '0080',
    );
  });

  it('round-trips synthetic audio without copying aligned payloads', () => {
    const pcm = syntheticPcm({ sampleRate: 48_000, seconds: 0.02, toneHz: 440 });
    const bytes = encodePcmFrame({ track: 0, sequence: 0, sample_start: 0, sample_count: pcm.length }, pcm);
    const decoded = decodePcmFrame(bytes);
    if (!('frame' in decoded)) throw new Error(decoded.error);
    expect(decoded.frame.samples).toEqual(pcm);
    expect(decoded.frame.samples.buffer).toBe(bytes.buffer);
  });

  it('copies misaligned payloads correctly', () => {
    const bytes = encodePcmFrame(header, samples);
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    const decoded = decodePcmFrame(shifted.subarray(1));
    if (!('frame' in decoded)) throw new Error(decoded.error);
    expect(Array.from(decoded.frame.samples)).toEqual(Array.from(samples));
    expect(decoded.frame.sample_start).toBe(header.sample_start);
  });

  it('rejects malformed frames with a specific reason', () => {
    const valid = encodePcmFrame(header, samples);
    const mutate = (offset: number, value: number) => {
      const copy = valid.slice();
      copy[offset] = value;
      return decodePcmFrame(copy);
    };
    expect(decodePcmFrame(valid.subarray(0, FRAME_HEADER_BYTES - 1))).toEqual({ error: 'too_short' });
    expect(decodePcmFrame(valid.subarray(0, valid.length - 1))).toEqual({ error: 'length_mismatch' });
    expect(decodePcmFrame(new Uint8Array(FRAME_HEADER_BYTES + MAX_FRAME_SAMPLES * 2 + 2))).toEqual({ error: 'too_long' });
    expect(mutate(0, 2)).toEqual({ error: 'unsupported_version' });
    expect(mutate(1, 9)).toEqual({ error: 'unsupported_kind' });
    expect(mutate(20, 1)).toEqual({ error: 'reserved_not_zero' });
    expect(mutate(15, 0x01)).toEqual({ error: 'unsafe_sample_start' });
    const empty = valid.slice(0, FRAME_HEADER_BYTES);
    empty[16] = 0;
    expect(decodePcmFrame(empty)).toEqual({ error: 'empty_frame' });
  });

  it('refuses to encode inconsistent headers', () => {
    expect(() => encodePcmFrame({ ...header, sample_count: 3 }, samples)).toThrow(RangeError);
    expect(() => encodePcmFrame({ ...header, sample_start: -1 }, samples)).toThrow(RangeError);
    expect(() => encodePcmFrame({ ...header, track: 0x1_0000 }, samples)).toThrow(/track/);
    expect(() => encodePcmFrame({ ...header, sequence: 2 ** 32 }, samples)).toThrow(/sequence/);
  });
});

describe('control messages', () => {
  const start = {
    _tag: 'start',
    protocol_version: 1,
    listener_id: uuid,
    epoch_id: epoch,
    track: 0,
    lease_generation: 3,
    clock: { sample_rate: 48_000, channels: 1, encoding: 'pcm_s16le', sample_start: 0, captured_at: '2026-09-26T17:08:16.000125Z', timezone: 'America/New_York' },
  };

  it('decodes a versioned start message', () => {
    expect(Schema.decodeUnknownSync(ClientControlMessage)(start)._tag).toBe('start');
  });

  it('rejects unknown protocol versions and rates', () => {
    expect(() => Schema.decodeUnknownSync(ClientControlMessage)({ ...start, protocol_version: 2 })).toThrow();
    expect(() => Schema.decodeUnknownSync(ClientControlMessage)({ ...start, clock: { ...start.clock, sample_rate: 11_025 } })).toThrow();
  });

  it('distinguishes live acknowledgement from archive durability', () => {
    const ack = Schema.decodeUnknownSync(ServerControlMessage)({ _tag: 'ack', sequence: 4, sample_end: 9_600 });
    expect(ack).toEqual({ _tag: 'ack', sequence: 4, sample_end: 9_600 });
  });
});

describe('synthetic PCM fixture', () => {
  it('is deterministic and silent at 0 Hz', () => {
    expect(syntheticPcm({ sampleRate: 16_000, seconds: 0.01, toneHz: 1_000 })).toEqual(syntheticPcm({ sampleRate: 16_000, seconds: 0.01, toneHz: 1_000 }));
    expect(syntheticPcm({ sampleRate: 16_000, seconds: 0.01, toneHz: 0 }).every(sample => sample === 0)).toBe(true);
  });
});

describe('HTTP API contract', () => {
  it('exports OpenAPI for the registered API and the listener device group', () => {
    const spec = OpenApi.fromApi(HttpApi.make('sanctum').add(HealthApi).add(Contracts.SessionApi).add(Contracts.ListenersApi));
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/api/v1/listeners',
      '/api/v1/listeners/{listener_id}/chunks/{chunk_id}',
      '/api/v1/listeners/{listener_id}/heartbeat',
      '/api/v1/session',
      '/healthz',
      '/readyz',
    ]);
    expect(spec.paths['/api/v1/listeners/{listener_id}/chunks/{chunk_id}']?.put?.operationId).toBe('listeners.putChunk');
    expect(Object.keys(OpenApi.fromApi(SanctumApi).paths)).toEqual([
      '/healthz',
      '/readyz',
      '/api/v1/session',
      '/api/v1/listeners',
      '/api/v1/listeners/{listener_id}/heartbeat',
      '/api/v1/listeners/{listener_id}/chunks/{chunk_id}',
      '/api/v1/meetings',
      '/api/v1/meetings/merge',
      '/api/v1/meetings/{meeting_id}',
      '/api/v1/meetings/{meeting_id}/close',
      '/api/v1/meetings/{meeting_id}/split',
      '/api/v1/meetings/{meeting_id}/transcript',
      '/api/v1/meetings/{meeting_id}/recording-access',
      '/api/v1/meetings/{meeting_id}/notes',
      '/api/v1/meetings/{meeting_id}/export',
      '/api/v1/meetings/{meeting_id}/speakers/map',
      '/api/v1/meetings/{meeting_id}/context',
      '/api/v1/context/search',
      '/api/v1/context/items',
      '/api/v1/context/items/{item_id}',
      '/api/v1/context/changes',
      '/api/v1/sources/{source_id}',
      '/api/v1/integrations/actions',
      '/api/v1/integrations/actions/{action_key}/schema',
      '/api/v1/actions',
      '/api/v1/actions/{action_id}',
      '/api/v1/actions/{action_id}/resolve',
      '/api/v1/action-grants',
      '/api/v1/action-grants/{grant_id}',
      '/api/v1/profiles/{profile_id}/matches',
      '/api/v1/agents',
      '/api/v1/agents/{agent_id}/credentials/{key_id}',
    ]);
    expect(OpenApi.fromApi(SanctumApi).paths['/api/v1/integrations/actions']?.get?.operationId).toBe('integrations.searchIntegrationActions');
  });
});
