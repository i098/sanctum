/**
 * Durable job handler registry. Each slice adds exactly one entry per job kind it owns;
 * the kernel's `runWorker` (jobs.ts) claims ledger rows and dispatches here. Handler types
 * live in job-types.ts so handler modules and jobs.ts never import this registry.
 */
import type { SqlClient } from '@effect/sql';
import type { JobHandlers } from './job-types.ts';
import { finalizeMeeting } from './meetings.ts';
import type { ObjectStore } from './object-store.ts';
import { assembleRecording } from './playback.ts';
import type { PyannoteClient } from './providers/pyannote.ts';
import { refineSpeakers } from './speakers.ts';

/** Services every worker handler may use; a slice adds its provider tag here and its layer in worker.ts. */
export type WorkerServices = SqlClient.SqlClient | ObjectStore | PyannoteClient;

export const jobHandlers: JobHandlers<WorkerServices> = {
  // One line per slice, e.g. 'context.refresh': refreshContext,
  'meeting.finalize': finalizeMeeting,
  'recording.assemble': assembleRecording,
  'speakers.refine': refineSpeakers,
};
