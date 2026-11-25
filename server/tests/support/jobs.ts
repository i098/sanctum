import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';
import { type EnqueueJob, enqueueJob } from '../../src/jobs.ts';

/** Enqueues, then reads the id of the active row for the key: enqueueJob itself reads nothing, so it may follow a transaction's writes. */
export const enqueuedId = (input: EnqueueJob) =>
  Effect.gen(function* () {
    yield* enqueueJob(input);
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ id: string }>`SELECT id FROM jobs WHERE workspace_id = ${input.workspace_id} AND kind = ${input.kind} AND work_key = ${input.work_key} ORDER BY created_at DESC, rowid DESC LIMIT 1`;
    return row!.id;
  });
