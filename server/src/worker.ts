/**
 * Worker entrypoint: same image as the API, separate process and resource layers. Runs
 * durable MySQL jobs (context, notes, recording assembly, batch ASR, memory, matching,
 * actions) that continue after browsers disconnect or the API restarts.
 */
import { NodeRuntime } from '@effect/platform-node';
import { Effect } from 'effect';
import { requireActivation, serverConfig } from './config.ts';
import { dbLayer } from './db.ts';
import { jobHandlers } from './job-handlers.ts';
import { runWorker } from './jobs.ts';
import { MediaProvidersLive } from './media/providers.ts';
import { loadMigrations, requireCurrentSchema } from './migrate.ts';
import { PyannoteLive } from './providers/pyannote.ts';

if (import.meta.main) {
  Effect.gen(function* () {
    const config = yield* serverConfig;
    yield* requireActivation(config);
    const run = Effect.zipRight(requireCurrentSchema(loadMigrations()), runWorker(jobHandlers));
    return yield* Effect.provide(run, [dbLayer(config.mysql), PyannoteLive, MediaProvidersLive]);
  }).pipe(NodeRuntime.runMain);
}
