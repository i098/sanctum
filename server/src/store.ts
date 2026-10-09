/**
 * Workspace ownership repositories (plan sections 07 and 11). Every statement is parameterized
 * and names its workspace, so tenant isolation starts at this first query layer.
 *
 * Semantics: identifiers compare byte-for-byte (ascii_bin); membership and meeting grants are
 * upserts that bump the workspace permission revision (cache keys include it); profile edits
 * are revision-checked and fail with the current revision instead of overwriting.
 */
import { randomUUID } from 'node:crypto';
import { SqlClient, type SqlError } from '@effect/sql';
import { Data, Effect, Option, Schema } from 'effect';
import {
  NotFound,
  ProfileId,
  RevisionConflict,
  type MeetingId,
  type PrincipalId,
  type WorkspaceId,
  type WorkspaceRole,
} from '@sanctum/contracts';
import { defaultSeatLimit } from './config.ts';
import { DbSafeInt } from './db.ts';

interface WriteResult { readonly affectedRows: number; readonly insertId: number | string }

/** Runs DML and returns mysql2's result header (affected rows, LAST_INSERT_ID). */
export const write = (statement: { readonly raw: Effect.Effect<unknown, SqlError.SqlError> }) =>
  Effect.map(statement.raw, result => result as WriteResult);

/**
 * `LAST_INSERT_ID(expr)` makes the increment and its read one statement; the row lock it takes
 * lasts until the caller's transaction commits, which serializes allocation per workspace.
 */
const increment = (column: 'context_seq' | 'permission_revision') => (workspace_id: WorkspaceId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const result = yield* write(sql`UPDATE workspaces SET ${sql(column)} = LAST_INSERT_ID(${sql(column)} + 1) WHERE id = ${workspace_id}`);
    if (result.affectedRows !== 1) return yield* Effect.dieMessage(`Unknown workspace ${workspace_id}`);
    return Schema.decodeUnknownSync(DbSafeInt)(result.insertId);
  });

/** Next committed-order context sequence number; call inside the change's transaction. */
export const nextContextSeq: (workspace_id: WorkspaceId) => Effect.Effect<number, SqlError.SqlError, SqlClient.SqlClient> = increment('context_seq');

/** Invalidates every access-derived cache entry of the workspace; returns the new revision. */
export const bumpPermissionRevision: (workspace_id: WorkspaceId) => Effect.Effect<number, SqlError.SqlError, SqlClient.SqlClient> =
  increment('permission_revision');

/**
 * True while the workspace is not deleted. The share lock holds until the caller's transaction ends,
 * so a delete waits for the write in flight and a write after the delete sees it.
 */
export const workspaceIsLive = (workspace_id: WorkspaceId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    sql => sql`SELECT 1 FROM workspaces WHERE id = ${workspace_id} AND deleted_at IS NULL FOR SHARE`,
  ).pipe(Effect.map(rows => rows.length > 0));

/** Roles that take a seat; agents and devices never count against the limit. */
const seatRoles: ReadonlyArray<WorkspaceRole> = ['owner', 'admin', 'member'];

class SeatLimitReached extends Data.TaggedError('SeatLimitReached')<{ readonly limit: number; readonly message: string }> {}

const SeatRow = Schema.Struct({ seat_limit: Schema.NullOr(DbSafeInt), used: DbSafeInt, held: DbSafeInt });

/**
 * Refuses a new seat once active seats reach the workspace's `seat_limit`, else the configured
 * default (NULL default: no limit). Holders keep their seat and may change role even over the limit.
 * Locks the workspace row, so concurrent additions in one workspace cannot overshoot.
 */
const claimSeat = (workspace_id: WorkspaceId, principal_id: PrincipalId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fallback = yield* Effect.orDie(defaultSeatLimit);
    const seated = sql`m.workspace_id = w.id AND m.revoked_at IS NULL AND m.role IN ${sql.in(seatRoles)}`;
    const [row] = yield* sql`SELECT w.seat_limit,
        (SELECT COUNT(*) FROM workspace_members m WHERE ${seated}) AS used,
        (SELECT COUNT(*) FROM workspace_members m WHERE ${seated} AND m.principal_id = ${principal_id}) AS held
      FROM workspaces w WHERE w.id = ${workspace_id} FOR UPDATE OF w`;
    if (row === undefined) return;
    const seats = Schema.decodeUnknownSync(SeatRow)(row);
    const limit = seats.seat_limit ?? fallback;
    if (limit !== null && seats.held === 0 && seats.used >= limit) {
      return yield* new SeatLimitReached({ limit, message: `Workspace seat limit of ${limit} reached` });
    }
  });

/** Upsert: adds the member or reactivates a revoked one with the given role, within the seat limit. */
export const addMember = (input: { readonly workspace_id: WorkspaceId; readonly principal_id: PrincipalId; readonly role: WorkspaceRole }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (seatRoles.includes(input.role)) yield* claimSeat(input.workspace_id, input.principal_id);
        yield* sql`INSERT INTO workspace_members (workspace_id, principal_id, role, created_at)
          VALUES (${input.workspace_id}, ${input.principal_id}, ${input.role}, UTC_TIMESTAMP(6)) AS new
          ON DUPLICATE KEY UPDATE role = new.role, revoked_at = NULL`;
        return yield* bumpPermissionRevision(input.workspace_id);
      }),
    );
  });

/** The workspace linked to an issuer organization (`workspace_orgs`), if any. */
export const workspaceForOrg = (input: { readonly issuer: string; readonly org_id: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ workspace_id: WorkspaceId }>`SELECT workspace_id FROM workspace_orgs WHERE issuer = ${input.issuer} AND org_id = ${input.org_id}`;
    return Option.fromNullable(row?.workspace_id);
  });

/** Idempotent link of a workspace to its issuer organization; a clash with another link is a defect. */
export const linkWorkspaceOrg = (input: { readonly workspace_id: WorkspaceId; readonly issuer: string; readonly org_id: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO workspace_orgs (issuer, org_id, workspace_id, created_at)
      VALUES (${input.issuer}, ${input.org_id}, ${input.workspace_id}, UTC_TIMESTAMP(6))
      ON DUPLICATE KEY UPDATE issuer = issuer`;
    const linked = yield* workspaceForOrg(input);
    if (Option.getOrUndefined(linked) !== input.workspace_id) {
      return yield* Effect.dieMessage(`Organization ${input.org_id} or workspace ${input.workspace_id} is already linked differently at ${input.issuer}`);
    }
  });

/** Upsert: explicitly assigns a principal's access to one meeting of the same workspace. */
export const grantMeetingAccess = (input: {
  readonly workspace_id: WorkspaceId;
  readonly meeting_id: MeetingId;
  readonly principal_id: PrincipalId;
  readonly access: 'read' | 'write' | 'owner';
  readonly granted_by: PrincipalId;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
        VALUES (${input.workspace_id}, ${input.meeting_id}, ${input.principal_id}, ${input.access}, ${input.granted_by}, UTC_TIMESTAMP(6)) AS new
        ON DUPLICATE KEY UPDATE access = new.access, granted_by = new.granted_by`.pipe(Effect.zipRight(bumpPermissionRevision(input.workspace_id))),
    );
  });

interface ProfileFields {
  readonly display_name: string;
  readonly details: Record<string, unknown>;
}

export const createProfile = (
  workspace_id: WorkspaceId,
  input: ProfileFields & { readonly kind: 'person' | 'organization'; readonly principal_id: PrincipalId | null },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = ProfileId.make(randomUUID());
    yield* sql`INSERT INTO profiles (id, workspace_id, principal_id, kind, display_name, details, created_at, updated_at)
      VALUES (${id}, ${workspace_id}, ${input.principal_id}, ${input.kind}, ${input.display_name}, ${JSON.stringify(input.details)}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
    return id;
  });

/** Replaces a profile's fields only at `expected_revision`; returns the new revision. */
export const reviseProfile = (workspace_id: WorkspaceId, input: ProfileFields & { readonly id: ProfileId; readonly expected_revision: number }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const updated = yield* write(sql`UPDATE profiles
      SET display_name = ${input.display_name}, details = ${JSON.stringify(input.details)}, revision = revision + 1, updated_at = UTC_TIMESTAMP(6)
      WHERE workspace_id = ${workspace_id} AND id = ${input.id} AND revision = ${input.expected_revision}`);
    if (updated.affectedRows === 1) return input.expected_revision + 1;
    const [current] = yield* sql<{ revision: number }>`SELECT revision FROM profiles WHERE workspace_id = ${workspace_id} AND id = ${input.id}`;
    return yield* current
      ? new RevisionConflict({ message: 'Profile changed since it was read', current_revision: current.revision })
      : new NotFound({ message: 'Profile not found' });
  });
