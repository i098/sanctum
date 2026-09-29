/**
 * Durable job handler registry. Each slice adds exactly one entry per job kind it owns;
 * the kernel's `runWorker` (jobs.ts) claims ledger rows and dispatches here. Handler types
 * live in job-types.ts so handler modules and jobs.ts never import this registry.
 */
import type { SqlClient } from '@effect/sql';
import { commitMemory, refreshContext } from './context-jobs.ts';
import { executeAction, runResearch } from './executor.ts';
import { extractCandidates } from './extraction.ts';
import type { JobHandlers } from './job-types.ts';
import type { LlmClient } from './llm.ts';
import type { PipedreamClient } from './providers/pipedream.ts';
import type { SpeechToText } from './media/providers.ts';
import { reconcileTranscript } from './media/reconcile.ts';
import { rankMatchesJob } from './matching.ts';
import { finalizeMeeting } from './meetings.ts';
import type { ObjectStore } from './providers/object-store.ts';
import { summarizeNotes } from './notes-job.ts';
import { assembleRecording } from './playback.ts';
import type { PyannoteClient } from './providers/pyannote.ts';
import { refineSpeakers } from './speakers.ts';

/** Services every worker handler may use; a slice adds its provider tag here and its layer in worker.ts. */
export type WorkerServices = SqlClient.SqlClient | ObjectStore | PyannoteClient | SpeechToText | LlmClient | PipedreamClient;

export const jobHandlers: JobHandlers<WorkerServices> = {
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
};
