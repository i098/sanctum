/**
 * Test-side stand-in for the media slice: listeners, capture epochs and final transcript
 * segments inserted the way media's session persists them before calling the meeting hooks.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import {
  type AccessScope,
  CaptureEpochId,
  JobId,
  type JobKind,
  ProviderConnectionId,
  type TranscriptSegment,
  TranscriptSegmentId,
  UtcTimestamp,
  type WorkspaceId,
} from '@sanctum/contracts';
import { Effect } from 'effect';
import type { ClaimedJob } from '../../src/job-types.ts';
import { onFinalSegments } from '../../src/meetings.ts';

export const RATE = 16_000;
const T0 = '2026-09-28 16:00:00.000000';

export interface Listener {
  readonly workspace_id: WorkspaceId;
  readonly listener_id: string;
  readonly capture_group_id: string | null;
}

export const seedListener = (device: AccessScope, options: { readonly group?: string } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const listener_id = randomUUID();
    yield* sql`INSERT INTO listeners (id, workspace_id, principal_id, capture_group_id, name, mode, state, capabilities, created_at)
      VALUES (${listener_id}, ${device.workspace_id}, ${device.principal.id}, ${options.group ?? null}, 'Room', 'room', 'listening', '{}', UTC_TIMESTAMP(6))`;
    return { workspace_id: device.workspace_id, listener_id, capture_group_id: options.group ?? null } satisfies Listener;
  });

export const seedGroup = (workspace_id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = randomUUID();
    yield* sql`INSERT INTO capture_groups (id, workspace_id, name, created_at) VALUES (${id}, ${workspace_id}, 'Room A', UTC_TIMESTAMP(6))`;
    return id;
  });

/** A capture epoch whose sample 0 was captured at `captured_at`; becomes the listener's current epoch. */
export const seedEpoch = (listener: Listener, captured_at = T0, live_sample_end = 0) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = CaptureEpochId.make(randomUUID());
    yield* sql`INSERT INTO capture_epochs (id, workspace_id, listener_id, lease_generation, sample_rate, channels, encoding, sample_start, captured_at, timezone, start_reason, started_at, live_sample_end)
      VALUES (${id}, ${listener.workspace_id}, ${listener.listener_id}, 1, ${RATE}, 1, 'pcm_s16le', 0, ${captured_at}, 'America/Los_Angeles', 'start', ${captured_at}, ${live_sample_end})`;
    yield* sql`UPDATE listeners SET current_epoch_id = ${id} WHERE id = ${listener.listener_id}`;
    return id;
  });

export const seedConnection = (listener: Listener, epoch_id: CaptureEpochId, purpose = 'asr', provider = 'deepgram') =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = ProviderConnectionId.make(randomUUID());
    yield* sql`INSERT INTO provider_connections (id, workspace_id, epoch_id, track, purpose, provider, model, anchor_sample, sample_rate, opened_at)
      VALUES (${id}, ${listener.workspace_id}, ${epoch_id}, 0, ${purpose}, ${provider}, 'fixture', 0, ${RATE}, UTC_TIMESTAMP(6))`;
    return id;
  });

/** Final segment over seconds `[from, to)` of the epoch, persisted with its final coverage like media does. */
export const speak = (
  listener: Listener,
  epoch_id: CaptureEpochId,
  from: number,
  to: number,
  text: string,
  options: { readonly label?: string; readonly connection?: ProviderConnectionId } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const segment: TranscriptSegment = {
      id: TranscriptSegmentId.make(randomUUID()),
      source: { epoch_id, track: 0, sample_start: Math.round(from * RATE), sample_end: Math.round(to * RATE) },
      text,
      status: 'final',
      revision: 1,
      origin: 'live',
      provider: 'deepgram',
      model: 'fixture',
      provider_connection_id: options.connection ?? null,
      speaker_label: options.label ?? null,
      speaker_track_id: null,
      confidence: 0.9,
      created_at: UtcTimestamp.make('2026-09-28T16:00:00Z'),
    };
    yield* sql`INSERT INTO transcript_segments (id, workspace_id, epoch_id, track, sample_start, sample_end, text, status, revision, origin, provider, model, provider_connection_id, speaker_label, confidence, created_at)
      VALUES (${segment.id}, ${listener.workspace_id}, ${epoch_id}, 0, ${segment.source.sample_start}, ${segment.source.sample_end}, ${text}, 'final', 1, 'live', 'deepgram', 'fixture',
        ${segment.provider_connection_id}, ${segment.speaker_label}, 0.9, UTC_TIMESTAMP(6))`;
    yield* sql`INSERT INTO transcript_coverage (workspace_id, epoch_id, track, sample_start, sample_end, origin, created_at)
      VALUES (${listener.workspace_id}, ${epoch_id}, 0, ${segment.source.sample_start}, ${segment.source.sample_end}, 'live', UTC_TIMESTAMP(6))`;
    return segment;
  });

/** Persists and delivers one final segment through the meetings hook. */
export const hear = (...args: Parameters<typeof speak>) =>
  Effect.gen(function* () {
    const segment = yield* speak(...args);
    yield* onFinalSegments({ ...args[0], segments: [segment] });
    return segment;
  });

export const meetingsOf = (workspace_id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ id: string; state: string; started_at: string; ended_at: string | null; boundary_revision: number }>`SELECT id, state, CAST(started_at AS CHAR) AS started_at, CAST(ended_at AS CHAR) AS ended_at, boundary_revision
      FROM meetings WHERE workspace_id = ${workspace_id} ORDER BY started_at, created_at`;
  });

export const rangesOf = (meeting_id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ epoch_id: string; sample_start: string; sample_end: string }>`SELECT r.epoch_id, r.sample_start, r.sample_end FROM meeting_ranges r
      JOIN meetings m ON m.id = r.meeting_id AND m.boundary_revision = r.boundary_revision WHERE r.meeting_id = ${meeting_id} ORDER BY r.epoch_id, r.sample_start`;
    return rows.map(row => ({ epoch_id: row.epoch_id, sample_start: Number(row.sample_start), sample_end: Number(row.sample_end) }));
  });

export const jobsOf = (workspace_id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ kind: string; work_key: string; status: string }>`SELECT kind, work_key, status FROM jobs WHERE workspace_id = ${workspace_id} ORDER BY kind, work_key`;
  });

export const claimed = (workspace_id: WorkspaceId, kind: JobKind, payload: unknown): ClaimedJob => ({
  id: JobId.make(randomUUID()),
  workspace_id,
  kind,
  work_key: 'test',
  payload,
  requested_by: null,
  source_revision: null,
  attempt: 1,
  lease_generation: 1,
});
