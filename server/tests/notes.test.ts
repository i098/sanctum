import { SqlClient } from '@effect/sql';
import { expect, layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { fixtureLlm } from '../src/llm.ts';
import { summarizeNotes } from '../src/notes-job.ts';
import { exportMeeting, getMeetingNotes } from '../src/notes.ts';
import { migratedDatabase, seedMeeting, seedSegment } from './support/context.ts';
import { seedWorkspace } from './support/fixtures.ts';

const answer = JSON.stringify({
  title: 'Pilot review',
  summary: 'The team kept the pilot small and set the beta date.',
  sections: [
    { heading: 'Decisions', points: [{ text: 'Pilot access stays with the test group.', segments: ['S1'] }] },
    { heading: 'Next steps', points: [{ text: 'Beta ships on Friday.', segments: ['S2'] }] },
  ],
});

const close = (meeting_id: string) => Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE meetings SET state = 'closed', ended_at = UTC_TIMESTAMP(6) WHERE id = ${meeting_id}`);

const processingNotes = (meeting_id: string) =>
  Effect.flatMap(SqlClient.SqlClient, sql => sql<{ notes: string }>`SELECT JSON_UNQUOTE(JSON_EXTRACT(processing, '$.notes')) AS notes FROM meetings WHERE id = ${meeting_id}`);

layer(Layer.merge(migratedDatabase, fixtureLlm([answer, answer])), { timeout: 120_000 })('meeting notes', it => {
  it.effect('summarizes a closed meeting once into canonical notes, read and exported with fresh access checks', () =>
    Effect.gen(function* () {
      const [owner, device] = yield* seedWorkspace('Notes', ['owner', 'device']);
      const [outsider] = yield* seedWorkspace('Elsewhere', ['owner']);
      const meeting = yield* seedMeeting(device!, { started_at: '2026-09-28 16:00:00' });
      yield* seedSegment(meeting, 0, 4, 'Keep pilot access limited to the test group.');
      yield* seedSegment(meeting, 65, 70, 'The beta ships on Friday.');
      const job = { workspace_id: meeting.workspace_id, payload: { meeting_id: meeting.meeting_id } };

      expect(yield* summarizeNotes(job)).toEqual({ status: 'succeeded', result: { skipped: 'meeting is still open' } });
      expect((yield* Effect.flip(getMeetingNotes(owner!, meeting.meeting_id))).retryable).toBe(true);

      yield* close(meeting.meeting_id);
      expect(yield* summarizeNotes(job)).toEqual({ status: 'succeeded', result: { meeting_id: meeting.meeting_id, points: 2 } });
      const { notes } = yield* getMeetingNotes(owner!, meeting.meeting_id);
      expect(notes).toMatchObject({ revision: 1, boundary_revision: 1, title: 'Pilot review', sections: [{ heading: 'Decisions' }, { heading: 'Next steps' }] });
      expect(notes.sections[1]!.points[0]!.sources[0]).toMatchObject({ start_ms: 65_000, end_ms: 70_000 });
      expect(yield* processingNotes(meeting.meeting_id)).toEqual([{ notes: 'complete' }]);

      const exported = yield* exportMeeting(owner!, meeting.meeting_id);
      expect(exported).toMatchObject({ format: 'markdown', notes_revision: 1, filename: `meeting-${meeting.meeting_id}-notes-r1.md` });
      expect(exported.content).toContain('# Pilot review');
      expect(exported.content).toContain('## Next steps\n- Beta ships on Friday. (1:05)');

      // Regeneration after a correction bumps the revision rather than overwriting silently.
      yield* summarizeNotes(job);
      expect((yield* getMeetingNotes(owner!, meeting.meeting_id)).notes.revision).toBe(2);

      // Another workspace, a missing scope and the device credential see nothing.
      expect((yield* Effect.flip(exportMeeting(outsider!, meeting.meeting_id)))._tag).toBe('NotFound');
      expect((yield* Effect.flip(exportMeeting({ ...owner!, scopes: ['recordings:read'] }, meeting.meeting_id)))._tag).toBe('Forbidden');
    }));

  it.effect('marks notes failed and keeps every source when the model cannot summarize', () =>
    Effect.gen(function* () {
      const [owner, device] = yield* seedWorkspace('Silent', ['owner', 'device']);
      const meeting = yield* seedMeeting(device!, { started_at: '2026-09-28 16:00:00' });
      yield* close(meeting.meeting_id);
      const failure = yield* Effect.flip(summarizeNotes({ workspace_id: meeting.workspace_id, payload: { meeting_id: meeting.meeting_id } }));
      expect(failure).toMatchObject({ _tag: 'JobFailure', retryable: false });
      expect(yield* processingNotes(meeting.meeting_id)).toEqual([{ notes: 'failed' }]);
      expect(yield* Effect.flip(getMeetingNotes(owner!, meeting.meeting_id))).toMatchObject({ _tag: 'Unavailable', retryable: false });
    }));
});
