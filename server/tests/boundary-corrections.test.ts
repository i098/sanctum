import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { type AccessScope, MeetingId } from '@sanctum/contracts';
import { Effect } from 'effect';
import { mergeMeetings, splitMeeting } from '../src/meeting-corrections.ts';
import { closeMeeting, getMeeting, listMeetings, onFinalSegments } from '../src/meetings.ts';
import { hear, jobsOf, meetingsOf, RATE, rangesOf, seedEpoch, seedListener, speak } from './support/capture.ts';
import { withDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';

const MIN = 60;

/** Two consecutive automatically detected meetings on one epoch: [0, 100 s) and [460 s, 520 s). */
const twoMeetings = Effect.gen(function* () {
  const [owner, device, member] = yield* seedWorkspace('Corrections', ['owner', 'device', 'member']);
  const listener = yield* seedListener(device!);
  const epoch = yield* seedEpoch(listener);
  yield* hear(listener, epoch, 0, 95, 'budget review for the quarter is first');
  yield* hear(listener, epoch, 95, 100, 'thanks everyone, see you next time');
  yield* hear(listener, epoch, 100 + 6 * MIN, 160 + 6 * MIN, "good morning everyone, let's get started with the design review");
  const [first, second] = (yield* meetingsOf(listener.workspace_id)).map(row => MeetingId.make(row.id));
  return { owner: owner!, member: member!, listener, epoch, first: first!, second: second! };
});

const totalSamples = (ranges: ReadonlyArray<{ sample_start: number; sample_end: number }>) => ranges.reduce((sum, range) => sum + range.sample_end - range.sample_start, 0);

describe('split and merge', () => {
  it.effect('split reassigns sample ownership exactly, keeps the listening part open and audits the change', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner, listener, epoch, second } = yield* twoMeetings;
        const before = yield* rangesOf(second);
        const { earlier, later } = yield* splitMeeting(owner, second, { expected_revision: 1, at: { epoch_id: epoch, sample: (130 + 6 * MIN) * RATE } });
        expect(earlier).toMatchObject({ id: second, boundary_revision: 2, state: 'closing', ended_at: '2026-09-28T16:08:10Z' });
        expect(later).toMatchObject({ boundary_revision: 1, state: 'active', started_at: '2026-09-28T16:08:10Z', ended_at: null });
        const [a, b] = [yield* rangesOf(earlier.id), yield* rangesOf(later.id)];
        expect(a).toEqual([{ epoch_id: epoch, sample_start: (100 + 6 * MIN) * RATE, sample_end: (130 + 6 * MIN) * RATE }]);
        expect(b).toEqual([{ epoch_id: epoch, sample_start: (130 + 6 * MIN) * RATE, sample_end: (160 + 6 * MIN) * RATE }]);
        expect(totalSamples(a) + totalSamples(b)).toBe(totalSamples(before));
        // Revision 1 ranges stay for audit; only the current revision owns samples.
        const [history] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM meeting_ranges WHERE meeting_id = ${second}`;
        expect(Number(history!.total)).toBe(2);
        const audit = yield* sql<{ operation: string; boundary_revision: number }>`SELECT operation, boundary_revision FROM boundary_events WHERE meeting_id IN ${sql.in([second, later.id])} AND operation = 'split'`;
        expect(audit).toHaveLength(2);
        const events = yield* sql<{ meeting_id: string; change_kind: string; source_revision: string }>`SELECT meeting_id, change_kind, source_revision FROM context_events WHERE workspace_id = ${listener.workspace_id} ORDER BY seq`;
        expect(events.map(event => [event.meeting_id, event.change_kind, Number(event.source_revision)])).toEqual([
          [second, 'meeting_boundary_changed', 2],
          [later.id, 'meeting_boundary_changed', 1],
        ]);
        // New speech keeps flowing into the part that is still open.
        yield* hear(listener, epoch, 161 + 6 * MIN, 170 + 6 * MIN, 'next slide shows the mobile layout');
        expect((yield* rangesOf(later.id)).at(-1)!.sample_end).toBe((170 + 6 * MIN) * RATE);
        expect(yield* rangesOf(earlier.id)).toEqual(a);
      }),
      { migrated: true },
    ),
  );

  it.effect('rejects stale revisions and split points outside the meeting', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, epoch, first, second } = yield* twoMeetings;
        yield* splitMeeting(owner, second, { expected_revision: 1, at: { epoch_id: epoch, sample: (130 + 6 * MIN) * RATE } });
        const stale = yield* Effect.flip(splitMeeting(owner, second, { expected_revision: 1, at: { epoch_id: epoch, sample: (120 + 6 * MIN) * RATE } }));
        expect(stale).toMatchObject({ _tag: 'RevisionConflict', current_revision: 2 });
        const outside = yield* Effect.flip(splitMeeting(owner, first, { expected_revision: 1, at: { epoch_id: epoch, sample: 200 * RATE } }));
        expect(outside).toMatchObject({ _tag: 'RevisionConflict', current_revision: 1 });
        const staleMerge = yield* Effect.flip(mergeMeetings(owner, { target: { meeting_id: first, expected_revision: 1 }, source: { meeting_id: second, expected_revision: 1 } }));
        expect(staleMerge).toMatchObject({ _tag: 'RevisionConflict', current_revision: 2 });
        expect(yield* getMeeting(owner, first)).toMatchObject({ boundary_revision: 1 });
      }),
      { migrated: true },
    ),
  );

  it.effect('merge preserves coverage, leaves the absorbed meeting without ranges and keeps action receipts untouched', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner, listener, epoch, first, second } = yield* twoMeetings;
        const action = randomUUID();
        yield* sql`INSERT INTO actions (id, workspace_id, meeting_id, requested_by, action_key, idempotency_key, args, args_sha256, state, provider_receipt, attempts, created_at, updated_at)
          VALUES (${action}, ${listener.workspace_id}, ${second}, ${owner.principal.id}, 'gmail-send', 'send-1', '{}', ${Buffer.alloc(32)}, 'succeeded', '{"message_id":"m-1"}', 1,
            UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`;
        const before = totalSamples(yield* rangesOf(first)) + totalSamples(yield* rangesOf(second));
        yield* closeMeeting(owner, second);
        const merged = yield* mergeMeetings(owner, { target: { meeting_id: first, expected_revision: 1 }, source: { meeting_id: second, expected_revision: 1 } });
        expect(merged).toMatchObject({ id: first, boundary_revision: 2, state: 'closing', started_at: '2026-09-28T16:00:00Z' });
        const ranges = yield* rangesOf(first);
        expect(totalSamples(ranges)).toBe(before);
        expect(ranges).toHaveLength(2);
        expect(yield* rangesOf(second)).toEqual([]);
        expect(yield* getMeeting(owner, second)).toMatchObject({ state: 'closed', boundary_revision: 2 });
        expect((yield* listMeetings(owner, {})).meetings.map(meeting => meeting.id)).toEqual([first]);
        const [receipt] = yield* sql<{ meeting_id: string; state: string; attempts: number; provider_receipt: unknown }>`SELECT meeting_id, state, attempts, provider_receipt FROM actions WHERE id = ${action}`;
        expect(receipt).toEqual({ meeting_id: second, state: 'succeeded', attempts: 1, provider_receipt: { message_id: 'm-1' } });
        const [audit] = yield* sql<{ decision: { linked_actions: Array<string> } }>`SELECT decision FROM boundary_events WHERE meeting_id = ${first} AND operation = 'merge'`;
        expect(audit!.decision.linked_actions).toEqual([action]);
        expect((yield* jobsOf(listener.workspace_id)).filter(job => job.kind.startsWith('action'))).toEqual([]);
        // A split back out of the merge restores the original ownership without touching the receipt.
        yield* splitMeeting(owner, first, { expected_revision: 2, at: { epoch_id: epoch, sample: (100 + 6 * MIN) * RATE } });
        expect(totalSamples(yield* rangesOf(first))).toBe(100 * RATE);
      }),
      { migrated: true },
    ),
  );

  it.effect('meetings with incompatible access cannot merge; unauthorized callers see NotFound', () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner, member, first, second } = yield* twoMeetings;
        const grant = (meeting: MeetingId, access: 'read' | 'write') =>
          sql`INSERT INTO meeting_access (workspace_id, meeting_id, principal_id, access, granted_by, created_at)
            VALUES (${owner.workspace_id}, ${meeting}, ${member.principal.id}, ${access}, ${owner.principal.id}, UTC_TIMESTAMP(6))`;
        yield* grant(first, 'write');
        const input = { target: { meeting_id: first, expected_revision: 1 }, source: { meeting_id: second, expected_revision: 1 } };
        expect(yield* Effect.flip(mergeMeetings(member, input))).toMatchObject({ _tag: 'NotFound' });
        yield* grant(second, 'read');
        expect(yield* Effect.flip(mergeMeetings(member, input))).toMatchObject({ _tag: 'NotFound' });
        const refused = yield* Effect.flip(mergeMeetings(owner, input));
        expect(refused).toMatchObject({ _tag: 'Forbidden', message: 'Meetings have different access; align access explicitly before merging' });
        yield* sql`UPDATE meeting_access SET access = 'write' WHERE meeting_id = ${second} AND principal_id = ${member.principal.id}`;
        expect(yield* mergeMeetings(member, input)).toMatchObject({ id: first, boundary_revision: 2 });
        const readOnly: AccessScope = { ...member, scopes: ['context:read'] };
        expect(yield* Effect.flip(splitMeeting(readOnly, first, { expected_revision: 2, at: { epoch_id: (yield* rangesOf(first))[0]!.epoch_id as never, sample: 10 } }))).toMatchObject({ _tag: 'Forbidden' });
        const [otherTeam] = yield* seedWorkspace('Other', ['owner']);
        expect(yield* Effect.flip(getMeeting(otherTeam!, first))).toMatchObject({ _tag: 'NotFound' });
      }),
      { migrated: true },
    ),
  );

  it.effect('replayed segments after a split stay with their corrected owner', () =>
    withDatabase(
      Effect.gen(function* () {
        const { owner, listener, epoch, second } = yield* twoMeetings;
        const { later } = yield* splitMeeting(owner, second, { expected_revision: 1, at: { epoch_id: epoch, sample: (130 + 6 * MIN) * RATE } });
        const replay = yield* speak(listener, epoch, 120 + 6 * MIN, 125 + 6 * MIN, 'a late batch transcript for the first half');
        yield* onFinalSegments({ ...listener, segments: [replay] });
        expect(totalSamples(yield* rangesOf(second))).toBe(30 * RATE);
        expect(totalSamples(yield* rangesOf(later.id))).toBe(30 * RATE);
      }),
      { migrated: true },
    ),
  );
});
