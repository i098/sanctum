/**
 * Reading and exporting the canonical meeting notes (plan sections 08 and 09) that
 * notes-job.ts stores on the meeting; notes and exports render from that one summary.
 */
import { SqlClient, SqlSchema } from '@effect/sql';
import { type AccessScope, type MeetingExport, type MeetingId, MeetingNotes, MeetingProcessing, Unavailable } from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { authorizeMeeting, requireScope } from './auth.ts';
import { DbJson, DbSafeInt } from './db.ts';

const StoredNotes = MeetingNotes.pipe(Schema.omit('revision'));
const NotesRow = Schema.Struct({
  notes: Schema.NullOr(DbJson(StoredNotes)),
  notes_revision: DbSafeInt,
  processing: DbJson(MeetingProcessing),
  title: Schema.NullOr(Schema.String),
  timezone: Schema.String,
  started_at: Schema.String,
});

/** The current canonical notes, after a fresh scope and meeting access check. */
export const getMeetingNotes = (access: AccessScope, meeting_id: MeetingId) =>
  Effect.gen(function* () {
    yield* requireScope(access, 'context:read');
    yield* authorizeMeeting(access, meeting_id, 'read');
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* SqlSchema.findAll({ Request: Schema.Void, Result: NotesRow, execute: () => sql`SELECT notes, notes_revision, processing, title, timezone, DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%sZ') AS started_at
        FROM meetings WHERE workspace_id = ${access.workspace_id} AND id = ${meeting_id}` })(undefined);
    if (row === undefined || row.notes === null) {
      const failed = row?.processing.notes === 'failed';
      return yield* new Unavailable({ message: failed ? 'Notes generation failed; all sources are kept' : 'Notes are not ready yet', retryable: !failed });
    }
    return { notes: { ...row.notes, revision: row.notes_revision } satisfies MeetingNotes, meeting: row };
  }).pipe(
    Effect.catchTags({ SqlError: () => new Unavailable({ message: 'Database unavailable', retryable: true }), ParseError: error => Effect.die(error) }),
  );

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Markdown for the summary's sections: one heading per section, one cited bullet per point. */
const renderSections = (notes: Pick<MeetingNotes, 'sections'>) =>
  notes.sections
    .map(section => [`## ${section.heading}`, ...section.points.map(point => `- ${point.text} (${point.sources.map(source => clock(source.start_ms)).join(', ')})`)].join('\n'))
    .join('\n\n');

/** Markdown export of the canonical notes; source timestamps are meeting-relative (m:ss). */
export const exportMeeting = (access: AccessScope, meeting_id: MeetingId) =>
  Effect.map(getMeetingNotes(access, meeting_id), ({ notes, meeting }): MeetingExport => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: meeting.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(meeting.started_at));
    const content = [`# ${notes.title}`, `${date} (${meeting.timezone})`, `## Summary\n\n${notes.summary}`, renderSections(notes)].join('\n\n');
    return { meeting_id, notes_revision: notes.revision, format: 'markdown', filename: `meeting-${meeting_id}-notes-r${notes.revision}.md`, content: `${content}\n` };
  });
