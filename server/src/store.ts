// stand-in: replaced by the kernel slice at integration
/** Workspace counters that order context changes (plan section 07). */
import { SqlClient, type SqlError } from '@effect/sql';
import { Effect, Schema } from 'effect';
import { DbSafeInt } from './db.ts';

/** Increments the workspace's context-event counter under its row lock; call inside the change's transaction. */
export const nextContextSeq = (workspace_id: string): Effect.Effect<number, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE workspaces SET context_seq = context_seq + 1 WHERE id = ${workspace_id}`;
    const [row] = yield* sql<{ seq: unknown }>`SELECT context_seq AS seq FROM workspaces WHERE id = ${workspace_id}`;
    return yield* Schema.decodeUnknown(DbSafeInt)(row?.seq).pipe(Effect.orDie);
  });
