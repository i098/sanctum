// stand-in: replaced by the context slice at integration
/** Committed-order context change events (plan section 07): the workspace row lock orders `seq`. */
import { SqlClient } from '@effect/sql';
import type { ContextChangeKind, ContextItemId, MeetingId, PrincipalId, WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';

export const appendContextEvent = (input: {
  readonly workspace_id: WorkspaceId;
  readonly meeting_id: MeetingId | null;
  readonly item: { readonly id: ContextItemId; readonly revision: number } | null;
  readonly change: typeof ContextChangeKind.Type;
  readonly actor: PrincipalId;
  readonly source_revision?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [workspace] = yield* sql<{ seq: string; permission_revision: string }>`SELECT context_seq + 1 AS seq, permission_revision FROM workspaces WHERE id = ${input.workspace_id} FOR UPDATE`;
    const seq = Number(workspace!.seq);
    yield* sql`UPDATE workspaces SET context_seq = ${seq} WHERE id = ${input.workspace_id}`;
    yield* sql`INSERT INTO context_events (workspace_id, seq, meeting_id, item_id, item_revision, change_kind, actor_principal_id, source_revision, permission_revision, created_at)
      VALUES (${input.workspace_id}, ${seq}, ${input.meeting_id}, ${input.item?.id ?? null}, ${input.item?.revision ?? null}, ${input.change}, ${input.actor},
        ${input.source_revision ?? null}, ${workspace!.permission_revision}, UTC_TIMESTAMP(6))`;
    return seq;
  });
