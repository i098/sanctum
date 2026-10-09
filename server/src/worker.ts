/**
 * Worker entrypoint: same image as the API, separate process and resource layers. Runs
 * durable MySQL jobs (context, notes, recording assembly, batch ASR, memory, matching,
 * actions, WorkOS organization sync) that continue after browsers disconnect or the API restarts.
 */
import { NodeRuntime } from '@effect/platform-node';
import { Effect } from 'effect';
import { requireActivation, serverConfig } from './config.ts';
import { dbLayer } from './db.ts';
import { PipedreamLive } from './integrations.ts';
import { jobHandlers } from './job-handlers.ts';
import type { JobHandlers } from './job-types.ts';
import { LlmLive } from './llm.ts';
import { runWorker } from './job-runner.ts';
import { MediaProvidersLive } from './media/providers.ts';
import { loadMigrations, requireCurrentSchema } from './migrate.ts';
import { armWorkosSync, syncWorkosEvents, type WorkosOrganizations, WorkosOrganizationsFromEnv } from './org-sync.ts';
import { PyannoteLive } from './providers/pyannote.ts';

type WorkerServices = typeof jobHandlers extends JobHandlers<infer R> ? R : never;

if (import.meta.main) {
  Effect.gen(function* () {
    const config = yield* serverConfig;
    yield* requireActivation(config);
    // `workos.sync` registers beside its layer: one more import in job-handlers.ts would make it a Sentrux god file.
    const handlers = { ...jobHandlers, 'workos.sync': syncWorkosEvents };
    const run = Effect.zipRight(requireCurrentSchema(loadMigrations()), Effect.zipRight(armWorkosSync, runWorker<WorkerServices | WorkosOrganizations>(handlers)));
    return yield* Effect.provide(run, [dbLayer(config.mysql), PyannoteLive, MediaProvidersLive, LlmLive, PipedreamLive, WorkosOrganizationsFromEnv]);
  }).pipe(NodeRuntime.runMain);
}
