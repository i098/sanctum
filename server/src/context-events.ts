/** Committed-order context events; imported by any slice that changes context inside its own transaction. */
import { SqlClient } from '@effect/sql';
import type { ContextChangeKind, ContextItemId, MeetingId, PrincipalId, WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { nextContextSeq } from './db.ts';

/**
 * Appends one committed-order event inside the caller's transaction and returns its sequence.
 * A meeting event also advances that meeting's context revision, so snapshots and caches move on.
 */
export const appendContextEvent = (input: {
 readonly workspace_id: WorkspaceId;
 readonly meeting_id: MeetingId | null;
 readonly item: { readonly id: ContextItemId; readonly revision: number } | null;
 readonly change: ContextChangeKind;
 readonly actor: PrincipalId;
 readonly source_revision?: number | undefined;
}) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  if (input.meeting_id !== null) {
   yield* sql`UPDATE meetings SET context_revision = context_revision + 1 WHERE workspace_id = ${input.workspace_id} AND id = ${input.meeting_id}`;
  }
  const seq = yield* nextContextSeq(input.workspace_id);
  yield* sql`INSERT INTO context_events (workspace_id, seq, meeting_id, item_id, item_revision, change_kind, actor_principal_id, source_revision, permission_revision, created_at)
      SELECT id, ${seq}, ${input.meeting_id}, ${input.item?.id ?? null}, ${input.item?.revision ?? null}, ${input.change}, ${input.actor},
        ${input.source_revision ?? null}, permission_revision, UTC_TIMESTAMP(6)
      FROM workspaces WHERE id = ${input.workspace_id}`;
  return seq;
 });

/** A boundary revision of a meeting entering the committed-order context feed; shared by split, merge and late joins. */
export const boundaryChanged = (meeting: { readonly id: MeetingId; readonly workspace_id: WorkspaceId }, revision: number, actor: PrincipalId) =>
 appendContextEvent({ workspace_id: meeting.workspace_id, meeting_id: meeting.id, item: null, change: 'meeting_boundary_changed', actor, source_revision: revision });
