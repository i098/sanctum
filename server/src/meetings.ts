// stand-in: replaced by the meetings slice at integration
/** Meeting lifecycle hooks the media session calls (docs/ARCHITECTURE.md, meetings slice). */
import type { SqlClient, SqlError } from '@effect/sql';
import type { CaptureEpochId, EpochEndReason, ListenerId, TranscriptSegment, WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';

/** Final transcript evidence for meeting assignment; the stand-in assigns nothing. */
export const onFinalSegments = (_event: {
  readonly workspace_id: WorkspaceId;
  readonly listener_id: ListenerId;
  readonly capture_group_id: string | null;
  readonly segments: ReadonlyArray<TranscriptSegment>;
}): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> => Effect.void;

/** A capture epoch ended; the stand-in closes no meeting ranges. */
export const onCaptureEnded = (_event: {
  readonly workspace_id: WorkspaceId;
  readonly listener_id: ListenerId;
  readonly epoch_id: CaptureEpochId;
  readonly track: number;
  readonly sample_end: number;
  readonly reason: typeof EpochEndReason.Type;
}): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> => Effect.void;
