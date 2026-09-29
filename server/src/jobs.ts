// stand-in: replaced by the kernel slice at integration
/** Job ledger core: enqueue, SKIP LOCKED claim, lease, fenced completion, bounded retry, worker loop. */
import { Unavailable } from '@sanctum/contracts';
import { Effect } from 'effect';
import type { JobHandler } from './job-handlers.ts';

export const runWorker = (handlers: Partial<Record<string, JobHandler>>) =>
  Effect.fail(new Unavailable({ message: `Job ledger not implemented; ${Object.keys(handlers).length} handlers registered`, retryable: false }));
