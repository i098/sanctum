import { randomUUID } from 'node:crypto';
import { HttpServer } from '@effect/platform';
import { SqlClient } from '@effect/sql';
import { expect, layer } from '@effect/vitest';
import { type AccessScope, ArtifactId, type MeetingId, TranscriptSegmentId, Unauthenticated } from '@sanctum/contracts';
import { Context, Effect, Either, Layer } from 'effect';
import { Authenticator } from '../src/auth.ts';
import { addContextItem, getContextSnapshot, reviseContextItem, searchContext, termFilter } from '../src/context.ts';
import { getSource } from '../src/context-changes.ts';
import { serverLayer } from '../src/main.ts';
import { migratedDatabase, grantMeeting, seedMeeting, seedSegment } from './support/context.ts';
import { createTestDatabase } from './support/database.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { dbLayer } from '../src/db.ts';
import { loadMigrations, migrate } from '../src/migrate.ts';

const STARTED = '2026-09-26 17:00:00';

const decision = (meeting_id: MeetingId | null, segment: string, key: string, expected_revision = 0) => ({
  meeting_id,
  expected_revision,
  kind: 'decision' as const,
  text: `Decision ${key}`,
  sources: [{ segment_id: TranscriptSegmentId.make(segment), start_ms: 0, end_ms: 0 }],
  idempotency_key: key,
});

const seedArtifact = (access: AccessScope, meeting_id: MeetingId | null) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    const id = ArtifactId.make(randomUUID());
    yield* sql`INSERT INTO artifacts (id, workspace_id, meeting_id, kind, title, content_type, content, sha256, provenance, created_by, created_at)
      VALUES (${id}, ${access.workspace_id}, ${meeting_id}, 'research', 'Vendor pricing', 'text/plain', 'Tier two costs 40 per seat.', ${Buffer.alloc(32, 7)}, '{}', ${access.principal.id}, UTC_TIMESTAMP(6))`;
    return id;
  });

layer(migratedDatabase, { timeout: 120_000 })('context items', it => {
  it.effect('adds attributed, source-linked items and replays retried writes', () =>
    Effect.gen(function*() {
      const [owner, agent, device] = yield* seedWorkspace('Items', ['owner', 'agent', 'device']);
      const meeting = yield* seedMeeting(device!, { started_at: STARTED });
      const segment = yield* seedSegment(meeting, 496, 501, 'Keep pilot access limited to the current test group.');
      const input = decision(meeting.meeting_id, segment, 'add-1');
      const item = yield* addContextItem(agent!, input);
      expect(item).toMatchObject({
        revision: 1,
        state: 'provisional',
        derivation: 'inferred',
        author: { type: 'agent', id: agent!.principal.id },
        event_at: '2026-09-26T17:08:16Z',
        sources: [{ segment_id: segment, start_ms: 496_000, end_ms: 501_000 }],
        supersedes: null,
      });
      expect(yield* addContextItem(agent!, input)).toEqual(item);
      expect(yield* Effect.flip(addContextItem(agent!, { ...input, text: 'Something else' }))).toMatchObject({ _tag: 'HashConflict' });
      const snapshot = yield* getContextSnapshot(owner!, meeting.meeting_id);
      expect(snapshot).toMatchObject({ meeting_id: meeting.meeting_id, revision: 1, timezone: 'America/Los_Angeles', items: [item], truncated: false, source_watermark: null });
    }));

  it.effect('lets exactly one of two agents writing from the same revision win', () =>
    Effect.gen(function*() {
      const [owner, first, second, device] = yield* seedWorkspace('Conflict', ['owner', 'agent', 'agent', 'device']);
      const meeting = yield* seedMeeting(device!, { started_at: STARTED });
      const segment = yield* seedSegment(meeting, 10, 12, 'We ship the beta on Friday.');
      const results = yield* Effect.all(
        [first!, second!].map((access, index) => Effect.either(addContextItem(access, decision(meeting.meeting_id, segment, `agent-${index}`)))),
        { concurrency: 2 },
      );
      expect(results.filter(Either.isLeft).map(result => result.left)).toMatchObject([{ _tag: 'RevisionConflict', current_revision: 1 }]);
      const [item] = results.filter(Either.isRight).map(result => result.right);
      yield* reviseContextItem(first!, item!.id, { expected_revision: 1, idempotency_key: 'first', text: 'Beta ships Friday' });
      const stale = yield* Effect.flip(reviseContextItem(second!, item!.id, { expected_revision: 1, idempotency_key: 'second', text: 'Beta ships Monday' }));
      expect(stale).toMatchObject({ _tag: 'RevisionConflict', current_revision: 2 });
      const rebased = yield* reviseContextItem(second!, item!.id, { expected_revision: 2, idempotency_key: 'second-rebased', text: 'Beta ships Monday' });
      expect(rebased).toMatchObject({ revision: 3, supersedes: { id: item!.id, revision: 2 } });
      expect((yield* getContextSnapshot(owner!, meeting.meeting_id)).items.map(entry => entry.text)).toEqual(['Beta ships Monday']);
    }));

  it.effect('keeps revisions immutable and carries actor, source and time through corrections', () =>
    Effect.gen(function*() {
      const [owner, agent, device] = yield* seedWorkspace('Revisions', ['owner', 'agent', 'device']);
      const meeting = yield* seedMeeting(device!, { started_at: STARTED });
      const segment = yield* seedSegment(meeting, 60, 64, 'Pilot stays with the current test group.');
      const item = yield* addContextItem(agent!, decision(meeting.meeting_id, segment, 'original'));
      const fix = { expected_revision: 1, idempotency_key: 'fix', text: 'Pilot stays with the test group' };
      const corrected = yield* reviseContextItem(owner!, item.id, fix);
      expect(corrected).toMatchObject({
        revision: 2,
        derivation: 'human_correction',
        author: { type: 'human', id: owner!.principal.id },
        event_at: item.event_at,
        sources: item.sources,
        supersedes: { id: item.id, revision: 1 },
      });
      expect(yield* reviseContextItem(owner!, item.id, fix)).toEqual(corrected);
      const retracted = yield* reviseContextItem(owner!, item.id, { expected_revision: 2, idempotency_key: 'retract', state: 'superseded' });
      expect(retracted).toMatchObject({ revision: 3, state: 'superseded', text: corrected.text, derivation: 'human_correction' });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ revision: number; text: string; state: string }>`SELECT revision, text, state FROM context_items WHERE id = ${item.id} ORDER BY revision`;
      expect(rows).toEqual([
        { revision: 1, text: item.text, state: 'provisional' },
        { revision: 2, text: corrected.text, state: 'provisional' },
        { revision: 3, text: corrected.text, state: 'superseded' },
      ]);
      const snapshot = yield* getContextSnapshot(owner!, meeting.meeting_id);
      expect(snapshot).toMatchObject({ revision: 3, items: [] });
    }));

  it.effect('reads and cites only sources the caller may see', () =>
    Effect.gen(function*() {
      const [owner, agent, device] = yield* seedWorkspace('Sources', ['owner', 'agent', 'device']);
      const open = yield* seedMeeting(device!, { started_at: STARTED });
      const restricted = yield* seedMeeting(device!, { started_at: STARTED, visibility: 'restricted' });
      const visible = yield* seedSegment(open, 10, 12, 'Ship on Friday.');
      const partial = yield* seedSegment(open, 12, 13, 'Ship on', 'partial');
      const hidden = yield* seedSegment(restricted, 10, 12, 'Salary bands for the pilot.');
      const missing = randomUUID();
      for (const source of [hidden, partial, missing]) {
        expect(yield* Effect.flip(addContextItem(agent!, decision(open.meeting_id, source, `cite-${source}`)))).toMatchObject({ _tag: 'NotFound' });
      }
      expect(yield* getSource(agent!, visible)).toMatchObject({ kind: 'segment', meeting_id: open.meeting_id, text: 'Ship on Friday.', start_ms: 10_000, end_ms: 12_000 });
      expect(yield* Effect.flip(getSource(agent!, hidden))).toMatchObject({ _tag: 'NotFound' });
      expect(yield* Effect.flip(getContextSnapshot(agent!, restricted.meeting_id))).toMatchObject({ _tag: 'NotFound' });

      yield* grantMeeting(agent!, restricted, 'read');
      expect(yield* getSource(agent!, hidden)).toMatchObject({ kind: 'segment', meeting_id: restricted.meeting_id });
      expect((yield* getContextSnapshot(agent!, restricted.meeting_id)).items).toEqual([]);
      expect(yield* Effect.flip(addContextItem(agent!, decision(restricted.meeting_id, hidden, 'read-only')))).toMatchObject({ _tag: 'NotFound' });

      const allowlisted: AccessScope = { ...agent!, meetings: { kind: 'allowlist', meeting_ids: [] } };
      expect(yield* Effect.flip(getSource(allowlisted, visible))).toMatchObject({ _tag: 'NotFound' });
      const readOnly: AccessScope = { ...agent!, scopes: ['context:read'] };
      expect(yield* Effect.flip(addContextItem(readOnly, decision(open.meeting_id, visible, 'no-scope')))).toMatchObject({ _tag: 'Forbidden', required_scope: 'context:write' });

      const artifact = yield* seedArtifact(owner!, null);
      const cite = { meeting_id: null, expected_revision: 0, kind: 'project_fact' as const, text: 'Tier two is 40 per seat', sources: [{ artifact_id: artifact }] };
      expect(yield* addContextItem(agent!, { ...cite, idempotency_key: 'external' })).toMatchObject({ state: 'committed', derivation: 'external', event_at: null });
      expect(yield* Effect.flip(addContextItem(allowlisted, { ...cite, idempotency_key: 'allowlisted' }))).toMatchObject({ _tag: 'Forbidden' });
      expect(yield* getSource(agent!, artifact)).toMatchObject({ kind: 'artifact', content: 'Tier two costs 40 per seat.', sha256: '07'.repeat(32) });
      expect(yield* Effect.flip(getSource(allowlisted, artifact))).toMatchObject({ _tag: 'NotFound' });
    }));

  it.effect('searches current authorized items with FULLTEXT and short-term fallback', () =>
    Effect.gen(function*() {
      const [owner, agent, device] = yield* seedWorkspace('Search', ['owner', 'agent', 'device']);
      const open = yield* seedMeeting(device!, { started_at: STARTED });
      const restricted = yield* seedMeeting(device!, { started_at: STARTED, visibility: 'restricted' });
      const segment = yield* seedSegment(open, 1, 3, 'Budget talk.');
      const secret = yield* seedSegment(restricted, 1, 3, 'Budget cuts.');
      yield* grantMeeting(owner!, restricted, 'write');
      const add = (access: AccessScope, meeting_id: MeetingId, source: string, text: string, expected = 0) =>
        addContextItem(access, { ...decision(meeting_id, source, text, expected), text });
      const budget = yield* add(agent!, open.meeting_id, segment, 'Q3 budget review moved to Thursday');
      yield* add(owner!, restricted.meeting_id, secret, 'Budget cuts for the hiring plan');
      const retracted = yield* add(agent!, open.meeting_id, segment, 'Budget freeze for vendors', 1);
      yield* reviseContextItem(agent!, retracted.id, { expected_revision: 1, idempotency_key: 'drop', state: 'superseded' });

      expect((yield* searchContext(agent!, { q: 'budget' })).items.map(item => item.id)).toEqual([budget.id]);
      expect((yield* searchContext(owner!, { q: 'BUDGET' })).items).toHaveLength(2);
      expect((yield* searchContext(agent!, { q: 'q3 thursday' })).items.map(item => item.id)).toEqual([budget.id]);
      expect((yield* searchContext(agent!, { q: 'hiring' })).items).toEqual([]);
      expect((yield* searchContext(agent!, { q: '?!' })).items).toEqual([]);
      expect(yield* Effect.flip(searchContext(agent!, { q: 'budget', meeting_id: restricted.meeting_id }))).toMatchObject({ _tag: 'NotFound' });
    }));

  it.effect('finds a hyphenated word by its joined and spaced spellings, and the reverse for hyphenated text', () =>
    Effect.gen(function*() {
      const [, agent, device] = yield* seedWorkspace('SearchHyphen', ['owner', 'agent', 'device']);
      const open = yield* seedMeeting(device!, { started_at: STARTED });
      const segment = yield* seedSegment(open, 1, 3, 'Planning.');
      const hyphen = yield* addContextItem(agent!, { ...decision(open.meeting_id, segment, 'Team off-site is in May', 0), text: 'Team off-site is in May' });
      const joined = yield* addContextItem(agent!, { ...decision(open.meeting_id, segment, 'Offsite dinner booked', 1), text: 'Offsite dinner booked' });
      const spaced = yield* addContextItem(agent!, { ...decision(open.meeting_id, segment, 'Plan the off site agenda', 2), text: 'Plan the off site agenda' });
      yield* addContextItem(agent!, { ...decision(open.meeting_id, segment, 'Airplane tickets booked', 3), text: 'Airplane tickets booked' });
      const ids = (q: string) => searchContext(agent!, { q }).pipe(Effect.map(page => page.items.map(item => item.id).sort()));

      expect(yield* ids('offsite')).toEqual([hyphen.id, joined.id].sort());
      expect(yield* ids('off-site')).toEqual([hyphen.id, joined.id, spaced.id].sort());
      expect(yield* ids('off site')).toEqual([hyphen.id, spaced.id].sort());
      expect(yield* ids('plan')).toEqual([spaced.id]);
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<{ type: string; key: string | null }>`EXPLAIN SELECT ci.id FROM context_items ci WHERE ${termFilter(sql, ['team', 'off-site'])}`;
      expect(plan[0]).toMatchObject({ type: 'fulltext', key: 'context_items_text_joined' });
    }));

  it.effect('filters search by time range and kind and pages it newest first without gaps', () =>
    Effect.gen(function*() {
      const [owner, agent, device] = yield* seedWorkspace('SearchRange', ['owner', 'agent', 'device']);
      const open = yield* seedMeeting(device!, { started_at: STARTED });
      const restricted = yield* seedMeeting(device!, { started_at: STARTED, visibility: 'restricted' });
      yield* grantMeeting(owner!, restricted, 'write');
      for (const minute of [1, 2, 3, 4, 5]) {
        const segment = yield* seedSegment(open, minute * 60, minute * 60 + 1, `Launch fact ${minute}.`);
        yield* addContextItem(agent!, { ...decision(open.meeting_id, segment, `range-${minute}`, minute - 1), text: `Launch fact ${minute}`, kind: minute === 4 ? 'commitment' : 'decision' });
      }
      const hidden = yield* seedSegment(restricted, 60, 61, 'Launch secret.');
      yield* addContextItem(owner!, { ...decision(restricted.meeting_id, hidden, 'range-hidden'), text: 'Launch secret' });
      const texts = (params: Parameters<typeof searchContext>[1]) => searchContext(agent!, params).pipe(Effect.map(page => page.items.map(item => item.text)));

      expect(yield* texts({ q: 'launch' })).toEqual(['Launch fact 5', 'Launch fact 4', 'Launch fact 3', 'Launch fact 2', 'Launch fact 1']);
      expect(yield* texts({ from: '2026-09-26T17:02:00Z' as never, to: '2026-09-26T17:04:00Z' as never })).toEqual(['Launch fact 3', 'Launch fact 2']);
      expect(yield* texts({ q: 'launch', kind: 'commitment' })).toEqual(['Launch fact 4']);
      expect(yield* texts({ kind: 'open_question' })).toEqual([]);

      const seen: Array<string> = [];
      let cursor: string | undefined;
      do {
        const page = yield* searchContext(agent!, { q: 'launch', limit: 2, cursor });
        seen.push(...page.items.map(item => item.text));
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      expect(seen).toEqual(['Launch fact 5', 'Launch fact 4', 'Launch fact 3', 'Launch fact 2', 'Launch fact 1']);
      expect(yield* Effect.flip(searchContext(agent!, { q: 'launch', cursor: 'bogus' }))).toMatchObject({ _tag: 'NotFound' });
    }));

  it.effect('serves snapshots per revision and re-checks access after revocation', () =>
    Effect.gen(function*() {
      const [owner, agent, device] = yield* seedWorkspace('Cache', ['owner', 'agent', 'device']);
      const meeting = yield* seedMeeting(device!, { started_at: STARTED, visibility: 'restricted' });
      yield* grantMeeting(owner!, meeting, 'owner');
      yield* grantMeeting(agent!, meeting, 'read');
      const segment = yield* seedSegment(meeting, 5, 6, 'First point.');
      yield* addContextItem(owner!, decision(meeting.meeting_id, segment, 'one'));
      expect((yield* getContextSnapshot(agent!, meeting.meeting_id)).items).toHaveLength(1);
      yield* addContextItem(owner!, decision(meeting.meeting_id, segment, 'two', 1));
      expect((yield* getContextSnapshot(agent!, meeting.meeting_id)).items).toHaveLength(2);

      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM meeting_access WHERE principal_id = ${agent!.principal.id}`;
      yield* sql`UPDATE workspaces SET permission_revision = permission_revision + 1 WHERE id = ${agent!.workspace_id}`;
      expect(yield* Effect.flip(getContextSnapshot({ ...agent!, permission_revision: 2 }, meeting.meeting_id))).toMatchObject({ _tag: 'NotFound' });
    }));
});

layer(Layer.empty, { timeout: 120_000 })('context HTTP API', it => {
  it.scoped('serves the context routes with the shared error envelope', () =>
    Effect.gen(function*() {
      const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
      const db = dbLayer(database.mysql);
      yield* Effect.provide(migrate(loadMigrations()), db);
      const [owner, device] = yield* Effect.provide(seedWorkspace('Http', ['owner', 'device']), db);
      const meeting = yield* Effect.provide(seedMeeting(device!, { started_at: STARTED }), db);
      const segment = yield* Effect.provide(seedSegment(meeting, 496, 501, 'Keep pilot access limited.'), db);
      const auth = Layer.succeed(Authenticator, {
        authenticate: request => (request.headers.authorization === 'Bearer owner' ? Effect.succeed(owner!) : Effect.fail(new Unauthenticated({ message: 'no credentials' }))),
      });
      const server = yield* Layer.build(serverLayer({ apiPort: 0, mysql: database.mysql }, auth));
      const address = Context.get(server, HttpServer.HttpServer).address;
      const base = `http://127.0.0.1:${address._tag === 'TcpAddress' ? address.port : 0}/api/v1`;
      const call = (method: string, path: string, body?: unknown) =>
        Effect.promise(async () => {
          const response = await fetch(`${base}${path}`, {
            method,
            headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return { status: response.status, body: (await response.json()) as Record<string, unknown> };
        });

      const added = yield* call('POST', '/context/items', decision(meeting.meeting_id, segment, 'http'));
      const id = added.body['id'];
      expect(added).toMatchObject({ status: 201, body: { revision: 1, sources: [{ segment_id: segment, start_ms: 496_000, end_ms: 501_000 }] } });
      const snapshot = yield* call('GET', `/meetings/${meeting.meeting_id}/context`);
      expect(snapshot).toMatchObject({ status: 200, body: { revision: 1, items: [{ id: id }] } });
      const stale = yield* call('PATCH', `/context/items/${id}`, { expected_revision: 3, idempotency_key: 'stale', text: 'Late edit' });
      expect(stale).toEqual({ status: 409, body: { _tag: 'RevisionConflict', code: 'revision_conflict', retryable: false, message: 'Item changed since expected_revision', current_revision: 1 } });
      const changes = yield* call('GET', '/context/changes?limit=10');
      expect(changes).toMatchObject({ status: 200, body: { events: [{ seq: 1, change: 'item_added', item: { id: id, revision: 1 } }] } });
      expect(yield* call('GET', `/context/search?q=pilot`)).toMatchObject({ status: 200, body: { items: [] } });
      expect(yield* call('GET', `/sources/${segment}`)).toMatchObject({ status: 200, body: { kind: 'segment', text: 'Keep pilot access limited.' } });
      expect((yield* call('GET', `/sources/${randomUUID()}`)).status).toBe(404);
    }));

  it.scoped('answers full questions with the facts that answer them, only in the caller workspace', () =>
    Effect.gen(function*() {
      const database = yield* Effect.acquireRelease(Effect.promise(createTestDatabase), db => Effect.promise(db.drop));
      const db = dbLayer(database.mysql);
      yield* Effect.provide(migrate(loadMigrations()), db);
      const [owner, device] = yield* Effect.provide(seedWorkspace('Questions', ['owner', 'device']), db);
      const [stranger] = yield* Effect.provide(seedWorkspace('Stranger', ['owner']), db);
      const meeting = yield* Effect.provide(seedMeeting(device!, { started_at: STARTED }), db);
      const segment = yield* Effect.provide(seedSegment(meeting, 270, 275, 'For the record, the Falcon project owner is Peter.'), db);
      const tokens: Record<string, AccessScope> = { 'Bearer owner': owner!, 'Bearer stranger': stranger! };
      const auth = Layer.succeed(Authenticator, {
        authenticate: request => {
          const access = tokens[request.headers.authorization ?? ''];
          return access === undefined ? Effect.fail(new Unauthenticated({ message: 'no credentials' })) : Effect.succeed(access);
        },
      });
      const server = yield* Layer.build(serverLayer({ apiPort: 0, mysql: database.mysql }, auth));
      const address = Context.get(server, HttpServer.HttpServer).address;
      const base = `http://127.0.0.1:${address._tag === 'TcpAddress' ? address.port : 0}/api/v1`;
      const request = (token: string, path: string, body?: unknown) =>
        Effect.promise(async () => {
          const response = await fetch(`${base}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return { status: response.status, body: (await response.json()) as { items: ReadonlyArray<{ text: string }> } };
        });
      // Planted facts and questions of the 24-hour soak corpus (scripts/soak/build-corpus.ts).
      const facts = ['The Falcon project owner is Peter.', 'The Harbor project owner is Anna.', 'The Falcon offsite is in Lisbon.', 'The Falcon team has five engineers.',
        'The Falcon tickets live in Trello.', 'The Falcon mascot is the otter.', 'Priya owns onboarding.', 'Dana sends the signed contract by Friday.',
        'The release is coming in May.', 'Northwood Freight quoted nine thousand dollars for shipping, and we rejected that quote.',
        'We chose Northwind Freight for shipping.', 'Falcon budget approved at 40k.', 'Marcus takes over onboarding.',
        'We decided the launch date is November 3.', 'The launch has moved to November 17.', 'The launch is now December 1.'];
      // Later facts cite later segments, so their event time is newer.
      const later = new Map([['We chose Northwind Freight for shipping.', 500], ['Marcus takes over onboarding.', 900], ['The launch has moved to November 17.', 600],
        ['The launch is now December 1.', 1200]]);
      for (const [revision, text] of facts.entries()) {
        const at = later.get(text);
        const cited = at === undefined ? segment : yield* Effect.provide(seedSegment(meeting, at, at + 5, `For the record, ${text}`), db);
        expect((yield* request('owner', '/context/items', { ...decision(meeting.meeting_id, cited, `fact-${revision}`, revision), text })).status).toBe(201);
      }
      const search = (q: string, token = 'owner', window = {}) =>
        request(token, `/context/search?${new URLSearchParams({ q, ...window })}`).pipe(Effect.map(({ status, body }) => ({ status, texts: body.items.map(item => item.text) })));
      const launches = ['The launch is now December 1.', 'The launch has moved to November 17.', 'We decided the launch date is November 3.'];
      const onboarding = ['Marcus takes over onboarding.', 'Priya owns onboarding.'];

      expect(yield* search('Falcon owner')).toEqual({ status: 200, texts: ['The Falcon project owner is Peter.'] });
      for (const [q, texts] of [
        ['Who owns the Falcon project?', ['The Falcon project owner is Peter.']],
        ['Where is the Falcon offsite?', ['The Falcon offsite is in Lisbon.']],
        ['How many engineers are on the Falcon team?', ['The Falcon team has five engineers.']],
        ['Where do the Falcon tickets live?', ['The Falcon tickets live in Trello.']],
        ['When does Dana send the contract?', ['Dana sends the signed contract by Friday.']],
        ['When is it coming?', ['The release is coming in May.']],
        ['Which vendor was chosen at the start?', ['We chose Northwind Freight for shipping.']],
        ['Which shipping vendor was chosen (not Northwood)?', ['We chose Northwind Freight for shipping.']],
        ['Who owns onboarding now?', onboarding],
        ['Who is in charge of onboarding now?', onboarding],
        ['Who is the owner of onboarding?', onboarding],
        ['Who is the onboarding owner?', onboarding],
        ['Which shipping company did we pick?', ['We chose Northwind Freight for shipping.', 'Northwood Freight quoted nine thousand dollars for shipping, and we rejected that quote.']],
        ["What's the launch date now?", launches],
        ['What is the current launch date, and what is its history in order?', launches],
        ['What is the Falcon mascot?', ['The Falcon mascot is the otter.']],
        ['Where is the launch offsite?', []],
        ['What color is the onboarding banner?', []],
        ['Who approved the Q3 audit?', []],
        ['Who signed the lease?', []],
        ['Who is it?', []],
        ['Does it?', []],
        ['?!', []],
      ] as const) {
        expect(yield* search(q), q).toEqual({ status: 200, texts });
      }
      expect(yield* search('What was the launch date as of T0+04:00?', 'owner', { to: '2026-09-26T17:09:00Z' })).toEqual({ status: 200, texts: ['We decided the launch date is November 3.'] });
      expect(yield* search('Who owns the Falcon project?', 'stranger')).toEqual({ status: 200, texts: [] });
    }));
});
