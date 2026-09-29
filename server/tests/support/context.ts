/** Synthetic meetings, capture epochs and final transcript for context tests; never real data. */
import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { type AccessScope, MeetingId, TranscriptSegmentId, type WorkspaceId } from '@sanctum/contracts';
import { Effect, Layer } from 'effect';
import { dbLayer } from '../../src/db.ts';
import { loadMigrations, migrate } from '../../src/migrate.ts';
import { createTestDatabase } from './database.ts';

/** One migrated database shared by a suite; each test seeds its own workspace. */
export const migratedDatabase = Layer.unwrapScoped(
 Effect.map(Effect.acquireRelease(Effect.promise(createTestDatabase), database => Effect.promise(database.drop)), database =>
  Layer.effectDiscard(migrate(loadMigrations())).pipe(Layer.provideMerge(dbLayer(database.mysql)))),
);

const SAMPLE_RATE = 16_000;

export interface FixtureMeeting {
 readonly workspace_id: WorkspaceId;
 readonly meeting_id: MeetingId;
 readonly epoch_id: string;
}

/**
 * A meeting owning track 0 of one capture epoch from sample 0, started at `started_at`
 * (`YYYY-MM-DD HH:MM:SS` UTC); the listener belongs to `device`.
 */
export const seedMeeting = (device: AccessScope, options: { readonly started_at: string; readonly timezone?: string; readonly visibility?: 'restricted' | 'workspace' }) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const workspace_id = device.workspace_id;
  const [listener, epoch_id, meeting_id] = [randomUUID(), randomUUID(), MeetingId.make(randomUUID())];
  const timezone = options.timezone ?? 'America/Los_Angeles';
  yield* sql`INSERT INTO listeners (id, workspace_id, principal_id, name, mode, capabilities, created_at)
      VALUES (${listener}, ${workspace_id}, ${device.principal.id}, 'Room', 'room', '{}', UTC_TIMESTAMP(6))`;
  yield* sql`INSERT INTO capture_epochs (id, workspace_id, listener_id, lease_generation, sample_rate, channels, encoding, sample_start, captured_at, timezone, start_reason, started_at, live_sample_end)
      VALUES (${epoch_id}, ${workspace_id}, ${listener}, 1, ${SAMPLE_RATE}, 1, 'pcm_s16le', 0, ${options.started_at}, ${timezone}, 'start', ${options.started_at}, 0)`;
  yield* sql`INSERT INTO meetings (id, workspace_id, listener_id, state, timezone, started_at, processing, visibility, created_at, updated_at)
      VALUES (${meeting_id}, ${workspace_id}, ${listener}, 'active', ${timezone}, ${options.started_at},
        '{"transcript":"partial","notes":"pending","memory":"pending","recording":"pending"}', ${options.visibility ?? 'workspace'}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
  yield* sql`INSERT INTO meeting_ranges (workspace_id, meeting_id, boundary_revision, epoch_id, track, sample_start, sample_end)
      VALUES (${workspace_id}, ${meeting_id}, 1, ${epoch_id}, 0, 0, ${SAMPLE_RATE * 36_000})`;
  return { workspace_id, meeting_id, epoch_id } satisfies FixtureMeeting;
 });

/** A transcript segment `[from, to)` seconds into the meeting's epoch. */
export const seedSegment = (meeting: FixtureMeeting, from: number, to: number, text: string, status: 'final' | 'partial' = 'final') =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const id = TranscriptSegmentId.make(randomUUID());
  yield* sql`INSERT INTO transcript_segments (id, workspace_id, epoch_id, track, sample_start, sample_end, text, status, revision, origin, provider, model, created_at)
      VALUES (${id}, ${meeting.workspace_id}, ${meeting.epoch_id}, 0, ${from * SAMPLE_RATE}, ${to * SAMPLE_RATE}, ${text}, ${status}, 1, 'live', 'fixture', 'fixture-asr', UTC_TIMESTAMP(6))`;
  return id;
 });

/** Grants `access` explicit `level` access to a restricted meeting. */
export const grantMeeting = (access: AccessScope, meeting: FixtureMeeting, level: 'read' | 'write' | 'owner') =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
      VALUES (${meeting.workspace_id}, ${meeting.meeting_id}, ${access.principal.id}, ${level}, ${access.principal.id}, UTC_TIMESTAMP(6))`;
 });
