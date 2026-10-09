/**
 * Durable job handler registry. Each slice adds exactly one entry per job kind it owns;
 * the kernel's `runWorker` (jobs.ts) claims ledger rows and dispatches here. Handler types
 * live in job-types.ts so handler modules and jobs.ts never import this registry.
 */
import type { Effect } from 'effect';
import { commitMemory, refreshContext } from './context-jobs.ts';
import { executeAction, runResearch } from './executor.ts';
import { extractCandidates } from './extraction.ts';
import type { JobHandlers } from './job-types.ts';
import { reconcileTranscript } from './media/reconcile.ts';
import { rankMatchesJob } from './matching.ts';
import { finalizeMeeting } from './meetings.ts';
import { summarizeNotes } from './notes-job.ts';
import { assembleRecording } from './playback.ts';
import { refineSpeakers } from './speakers.ts';
import { purgeWorkspace } from './workspaces.ts';

const handlers = {
  'meeting.finalize': finalizeMeeting,
  'recording.assemble': assembleRecording,
  'speakers.refine': refineSpeakers,
  'transcript.reconcile': reconcileTranscript,
  'context.refresh': refreshContext(extractCandidates),
  'memory.commit': commitMemory(extractCandidates),
  'notes.summarize': summarizeNotes,
  'matching.rank': rankMatchesJob,
  'action.execute': executeAction,
  'research.run': runResearch,
  'workspace.purge': purgeWorkspace,
};

/** The services the handlers use are inferred from them; `runWorker` requires exactly those, and worker.ts provides their layers. */
type WorkerServices = { [K in keyof typeof handlers]: (typeof handlers)[K] extends (...args: never[]) => Effect.Effect<unknown, unknown, infer R> ? R : never }[keyof typeof handlers];

export const jobHandlers: JobHandlers<WorkerServices> = handlers;
