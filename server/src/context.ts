/**
 * Versioned, time-aware, source-linked shared context (plan section 08). Items are immutable
 * `(id, revision)` rows; every change appends a committed-order event in the same transaction.
 * Lock order inside a change: meeting row (or workspace row for workspace-level items), then
 * the workspace counter in `nextContextSeq`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { HttpApiBuilder } from '@effect/platform';
import { SqlClient, SqlError, type Statement } from '@effect/sql';
import {
 type AccessScope,
 CurrentAccess,
 Unavailable,
 type AddContextItem,
 Author,
 type ContextChangeKind,
 type ContextItem,
 ContextItemId,
 ContextKind,
 type ContextSearchPage,
 type ContextSnapshot,
 type SearchContextParams,
 ContextState,
 Derivation,
 Forbidden,
 HashConflict,
 IanaTimeZone,
 MeetingId,
 type WorkspaceId,
 NotFound,
 PrincipalId,
 Revision,
 type ReviseContextItem,
 RevisionConflict,
 SourceRef,
 TimeExpression,
 UtcTimestamp,
 CaptureEpochId,
} from '@sanctum/contracts';
import { SanctumApi } from '@sanctum/contracts/api';
import { Effect, Schema } from 'effect';
import { authorizeMeeting, requireScope } from './auth.ts';
import { scopedCacheKey } from './cache.ts';
import { decodeRows, encodeCursor, getContextChanges, getSource, resolveSources, type VisibleScope, visibleScope, visibleWhere } from './context-changes.ts';
import { appendContextEvent } from './context-events.ts';
import { DbJson, DbSafeInt, DbSha256, DbUtc } from './db.ts';

/** Most items one snapshot or search returns; `truncated` reports the rest. */
const ITEM_LIMIT = 200;

const ItemRow = Schema.Struct({
 id: ContextItemId,
 revision: Revision,
 meeting_id: Schema.NullOr(MeetingId),
 kind: ContextKind,
 text: Schema.String,
 state: ContextState,
 derivation: Derivation,
 event_at: Schema.NullOr(DbUtc),
 valid_from: Schema.NullOr(DbUtc),
 valid_until: Schema.NullOr(DbUtc),
 time_expression: Schema.NullOr(DbJson(TimeExpression)),
 sources: DbJson(Schema.Array(SourceRef)),
 author_type: Author.fields.type,
 author_principal_id: PrincipalId,
 supersedes_id: Schema.NullOr(ContextItemId),
 supersedes_revision: Schema.NullOr(Revision),
 payload_sha256: Schema.NullOr(DbSha256),
 created_at: DbUtc,
});
type ItemRow = typeof ItemRow.Type;

const toItem = (row: ItemRow): ContextItem => ({
 id: row.id,
 revision: row.revision,
 meeting_id: row.meeting_id,
 kind: row.kind,
 text: row.text,
 state: row.state,
 derivation: row.derivation,
 event_at: row.event_at,
 valid_from: row.valid_from,
 valid_until: row.valid_until,
 time: row.time_expression,
 author: { type: row.author_type, id: row.author_principal_id },
 sources: row.sources,
 supersedes: row.supersedes_id === null ? null : { id: row.supersedes_id, revision: row.supersedes_revision! },
 created_at: row.created_at,
});

/** Latest revision of each item matching `where` (over alias `ci`), newest event first unless `order` says otherwise, at most `limit`. */
const latestItems = (workspace_id: string, where: Statement.Fragment, limit: number, order?: Statement.Fragment) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* decodeRows(
   ItemRow,
   sql`SELECT ci.* FROM context_items ci
        WHERE ci.workspace_id = ${workspace_id} AND ${where}
          AND ci.revision = (SELECT MAX(x.revision) FROM context_items x WHERE x.id = ci.id)
        ORDER BY ${order ?? sql`COALESCE(ci.event_at, ci.created_at) DESC, ci.id`}
        LIMIT ${limit}`,
  );
  return rows.map(toItem);
 });

/** Current, non-retracted items of one meeting, chronological; `truncated` when more than `ITEM_LIMIT` exist. */
export const meetingItems = (workspace_id: string, meeting_id: string) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const items = yield* latestItems(workspace_id, sql`ci.meeting_id = ${meeting_id} AND ci.state <> 'superseded'`, ITEM_LIMIT + 1);
  return { items: items.slice(0, ITEM_LIMIT).reverse(), truncated: items.length > ITEM_LIMIT };
 });

/**
 * Candidates to show an extraction prompt, chronological: the meeting's newest `recent` current items plus the
 * `matching` current items of any age that best match `prefixes` (word prefixes, as FULLTEXT `prefix*` terms).
 */
export const relevantItems = (workspace_id: string, meeting_id: string, prefixes: ReadonlyArray<string>, recent: number, matching: number) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const current = sql`ci.meeting_id = ${meeting_id} AND ci.state <> 'superseded'`;
  const newest = yield* latestItems(workspace_id, current, recent);
  const against = sql`MATCH(ci.text) AGAINST (${prefixes.map(prefix => `${prefix}*`).join(' ')} IN BOOLEAN MODE)`;
  const shared = prefixes.length === 0 ? [] : yield* latestItems(workspace_id, sql.and([current, against]), matching, sql`${against} DESC, COALESCE(ci.event_at, ci.created_at) DESC, ci.id`);
  const at = (item: ContextItem) => Date.parse(item.event_at ?? item.created_at);
  return [...new Map([...shared, ...newest].map(item => [item.id, item])).values()].sort((a, b) => at(a) - at(b));
 });

const ItemText = Schema.Struct({ kind: ContextKind, text: Schema.String });

/** Kind and text of every current item of one meeting: all of them, but only the two columns a repeat check needs. */
export const meetingItemTexts = (workspace_id: string, meeting_id: string) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeRows(
   ItemText,
   sql`SELECT ci.kind, ci.text FROM context_items ci
        WHERE ci.workspace_id = ${workspace_id} AND ci.meeting_id = ${meeting_id} AND ci.state <> 'superseded'
          AND ci.revision = (SELECT MAX(x.revision) FROM context_items x WHERE x.id = ci.id)`,
  );
 });

/** Fields of a new revision; the database assigns `created_at`. */
export type NewItem = Omit<ContextItem, 'created_at'>;

/** Column encodings of an item's timestamps and JSON fields. */
const ItemColumns = Schema.Struct({
 event_at: Schema.NullOr(DbUtc),
 valid_from: Schema.NullOr(DbUtc),
 valid_until: Schema.NullOr(DbUtc),
 time: Schema.NullOr(Schema.parseJson(TimeExpression)),
 sources: Schema.parseJson(Schema.Array(SourceRef)),
});

/** Inserts `item` and its event inside the caller's transaction; the event actor defaults to the author. */
export const writeItem = (
 workspace_id: WorkspaceId,
 item: NewItem,
 options: {
  readonly change: ContextChangeKind;
  readonly actor?: PrincipalId;
  readonly idempotency?: { readonly key: string; readonly sha256: string };
  readonly source_revision?: number;
 },
) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const columns = Schema.encodeSync(ItemColumns)(item);
  const supersedes = item.supersedes ?? { id: null, revision: null };
  const idempotency = options.idempotency ?? { key: null, sha256: null };
  yield* sql`INSERT INTO context_items (id, revision, workspace_id, meeting_id, kind, text, state, derivation, event_at, valid_from, valid_until,
        time_expression, sources, author_type, author_principal_id, supersedes_id, supersedes_revision, idempotency_key, payload_sha256, created_at)
      VALUES (${item.id}, ${item.revision}, ${workspace_id}, ${item.meeting_id}, ${item.kind}, ${item.text}, ${item.state}, ${item.derivation},
        ${columns.event_at}, ${columns.valid_from}, ${columns.valid_until}, ${columns.time}, ${columns.sources}, ${item.author.type}, ${item.author.id},
        ${supersedes.id}, ${supersedes.revision}, ${idempotency.key}, ${idempotency.sha256 && Buffer.from(idempotency.sha256, 'hex')}, UTC_TIMESTAMP(6))`;
  yield* appendContextEvent({
   workspace_id,
   meeting_id: item.meeting_id,
   item: { id: item.id, revision: item.revision },
   change: options.change,
   actor: options.actor ?? item.author.id,
   source_revision: options.source_revision,
  });
  const [row] = yield* decodeRows(ItemRow, sql`SELECT * FROM context_items WHERE id = ${item.id} AND revision = ${item.revision}`);
  return toItem(row!);
 });

const MeetingLock = Schema.Struct({ context_revision: DbSafeInt, boundary_revision: Schema.Number });

/** Row-locks a meeting for a context change; take it first inside the transaction. Undefined when absent. */
export const lockMeeting = (workspace_id: string, meeting_id: string) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const [meeting] = yield* decodeRows(MeetingLock, sql`SELECT context_revision, boundary_revision FROM meetings WHERE workspace_id = ${workspace_id} AND id = ${meeting_id} FOR UPDATE`);
  return meeting;
 });

/**
 * Locks the container of a change. Returns the revision `expected_revision` is checked against
 * (the meeting's context revision, or 0 for workspace-level items, which have no shared snapshot)
 * and the source revision its event records.
 */
const lockContainer = (workspace_id: string, meeting_id: string | null) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  if (meeting_id === null) {
   yield* sql`SELECT id FROM workspaces WHERE id = ${workspace_id} FOR UPDATE`;
   return { context_revision: 0, source: {} };
  }
  const meeting = (yield* lockMeeting(workspace_id, meeting_id))!;
  return { context_revision: meeting.context_revision, source: { source_revision: meeting.boundary_revision } };
 });

/** A write needs `context:write` plus write access to the meeting, or workspace-wide access for workspace-level items. */
const authorizeWrite = (access: AccessScope, meeting_id: MeetingId | null) =>
 Effect.gen(function*() {
  yield* requireScope(access, 'context:write');
  if (meeting_id !== null) return yield* authorizeMeeting(access, meeting_id, 'write');
  if (access.meetings.kind !== 'accessible') return yield* new Forbidden({ message: 'Workspace-level context needs workspace-wide access' });
 });

/** A retried write with the same key returns the stored revision; the same key with other content is a conflict. */
const replayed = (access: AccessScope, key: string, payload_sha256: string) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* decodeRows(
   ItemRow,
   sql`SELECT * FROM context_items WHERE workspace_id = ${access.workspace_id} AND author_principal_id = ${access.principal.id} AND idempotency_key = ${key}`,
  );
  if (row === undefined) return null;
  if (row.payload_sha256 !== payload_sha256) return yield* new HashConflict({ message: 'Idempotency key reused with different content', existing_sha256: row.payload_sha256 ?? '' });
  return toItem(row);
 });

const authorOf = (access: AccessScope) => ({
 type: access.principal.kind === 'device' ? ('system' as const) : access.principal.kind,
 id: access.principal.id,
});

/** Adds an attributed item citing authorized sources; meeting items start provisional until distilled. */
export const addContextItem = (access: AccessScope, input: AddContextItem) =>
 Effect.gen(function*() {
  yield* authorizeWrite(access, input.meeting_id);
  const sql = yield* SqlClient.SqlClient;
  const payload = createHash('sha256').update(JSON.stringify(['add', input.meeting_id, input.kind, input.text, input.sources])).digest('hex');
  return yield* sql.withTransaction(
   Effect.gen(function*() {
    const container = yield* lockContainer(access.workspace_id, input.meeting_id);
    const previous = yield* replayed(access, input.idempotency_key, payload);
    if (previous) return previous;
    if (container.context_revision !== input.expected_revision) {
     return yield* new RevisionConflict({ message: 'Context changed since expected_revision', current_revision: container.context_revision });
    }
    const cited = yield* resolveSources(access, input.sources);
    const author = authorOf(access);
    const external = input.sources.every(source => 'artifact_id' in source);
    return yield* writeItem(access.workspace_id, {
     id: ContextItemId.make(randomUUID()),
     revision: 1,
     meeting_id: input.meeting_id,
     kind: input.kind,
     text: input.text,
     state: input.meeting_id === null ? 'committed' : 'provisional',
     derivation: author.type === 'human' ? 'human_correction' : external ? 'external' : 'inferred',
     event_at: cited.event_at,
     valid_from: null,
     valid_until: null,
     time: null,
     author,
     sources: cited.sources,
     supersedes: null,
    }, { change: 'item_added', idempotency: { key: input.idempotency_key, sha256: payload }, ...container.source });
   }),
  );
 });

/** The revision after `latest` with `input`'s edits; a non-human rewrite becomes an inference. */
const nextRevision = (latest: ContextItem, input: ReviseContextItem, author: ContextItem['author'], cited: Pick<ContextItem, 'sources' | 'event_at'>): NewItem => {
 const rewritten = input.text !== undefined || input.sources !== undefined || input.kind !== undefined;
 return {
  ...latest,
  ...cited,
  revision: latest.revision + 1,
  kind: input.kind ?? latest.kind,
  text: input.text ?? latest.text,
  state: input.state ?? latest.state,
  derivation: author.type === 'human' ? 'human_correction' : rewritten ? 'inferred' : latest.derivation,
  author,
  supersedes: { id: latest.id, revision: latest.revision },
 };
};

/**
 * Adds the next immutable revision of an item. Actor, time and untouched sources carry over;
 * `state: superseded` retracts it. A stale `expected_revision` fails with the current one.
 */
export const reviseContextItem = (access: AccessScope, item_id: ContextItemId, input: ReviseContextItem) =>
 Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;
  const [head] = yield* latestItems(access.workspace_id, sql`ci.id = ${item_id}`, 1);
  if (head === undefined || (head.meeting_id === null && access.meetings.kind !== 'accessible')) return yield* new NotFound({ message: 'Context item not found' });
  yield* authorizeWrite(access, head.meeting_id);
  const payload = createHash('sha256').update(JSON.stringify(['revise', item_id, input])).digest('hex');
  return yield* sql.withTransaction(
   Effect.gen(function*() {
    const container = yield* lockContainer(access.workspace_id, head.meeting_id);
    const previous = yield* replayed(access, input.idempotency_key, payload);
    if (previous) return previous;
    const [latest] = yield* latestItems(access.workspace_id, sql`ci.id = ${item_id}`, 1);
    if (latest!.revision !== input.expected_revision) {
     return yield* new RevisionConflict({ message: 'Item changed since expected_revision', current_revision: latest!.revision });
    }
    const cited = input.sources ? yield* resolveSources(access, input.sources) : latest!;
    return yield* writeItem(access.workspace_id, nextRevision(latest!, input, authorOf(access), { sources: cited.sources, event_at: cited.event_at }), {
     change: input.state === 'superseded' ? 'item_superseded' : 'item_revised',
     idempotency: { key: input.idempotency_key, sha256: payload },
     ...container.source,
    });
   }),
  );
 });

const SnapshotHead = Schema.Struct({
 now: DbUtc,
 context_revision: DbSafeInt,
 boundary_revision: Schema.Number,
 timezone: IanaTimeZone,
 context_seq: DbSafeInt,
});
const Watermark = Schema.Struct({ epoch_id: CaptureEpochId, sample_end: DbSafeInt });

// ponytail: per-process FIFO cache; keys carry every revision, so no invalidation is ever needed.
const snapshotCache = new Map<string, { readonly items: ReadonlyArray<ContextItem>; readonly truncated: boolean }>();
const CACHE_ENTRIES = 500;

/** Bounded, source-linked snapshot of one meeting's working context, read at one consistent point. */
export const getContextSnapshot = (access: AccessScope, meeting_id: MeetingId) =>
 Effect.gen(function*() {
  yield* requireScope(access, 'context:read');
  yield* authorizeMeeting(access, meeting_id, 'read');
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
   Effect.gen(function*() {
    const [head] = yield* decodeRows(
     SnapshotHead,
     sql`SELECT UTC_TIMESTAMP(6) AS now, m.context_revision, m.boundary_revision, m.timezone, w.context_seq
            FROM meetings m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ${access.workspace_id} AND m.id = ${meeting_id}`,
    );
    const key = scopedCacheKey(access, 'context', meeting_id, head!.context_revision, head!.boundary_revision);
    const current = snapshotCache.get(key) ?? (yield* meetingItems(access.workspace_id, meeting_id));
    snapshotCache.set(key, current);
    if (snapshotCache.size > CACHE_ENTRIES) snapshotCache.delete(snapshotCache.keys().next().value!);
    const [watermark] = yield* decodeRows(
     Watermark,
     sql`SELECT s.epoch_id, s.sample_end FROM context_processed_segments p
            JOIN transcript_segments s ON s.workspace_id = p.workspace_id AND s.id = p.segment_id
            JOIN capture_epochs e ON e.workspace_id = s.workspace_id AND e.id = s.epoch_id
            WHERE p.workspace_id = ${access.workspace_id} AND p.meeting_id = ${meeting_id}
            ORDER BY e.captured_at DESC, s.sample_end DESC LIMIT 1`,
    );
    return {
     meeting_id,
     revision: head!.context_revision,
     as_of: head!.now,
     timezone: head!.timezone,
     source_watermark: watermark ?? null,
     items: current.items,
     changes_cursor: encodeCursor(access, head!.context_seq),
     truncated: current.truncated,
    } satisfies ContextSnapshot;
   }),
  );
 });

const SearchCursor = Schema.parseJson(Schema.Tuple(UtcTimestamp, ContextItemId));

const utc = Schema.encodeSync(DbUtc);

/** Filters on kind, event-time range and the resume position of a cursor. */
const rangeFilters = (sql: SqlClient.SqlClient, input: SearchContextParams, after: typeof SearchCursor.Type | null) => {
 const at = sql`COALESCE(ci.event_at, ci.created_at)`;
 return [
  ...(input.kind === undefined ? [] : [sql`ci.kind = ${input.kind}`]),
  ...(input.from === undefined ? [] : [sql`${at} >= ${utc(input.from)}`]),
  ...(input.to === undefined ? [] : [sql`${at} < ${utc(input.to)}`]),
  ...(after === null ? [] : [sql`(${at} < ${utc(after[0])} OR (${at} = ${utc(after[0])} AND ci.id > ${after[1]}))`]),
 ];
};

const decodeSearchCursor = (cursor: string) =>
 Schema.decode(SearchCursor)(Buffer.from(cursor, 'base64url').toString()).pipe(Effect.mapError(() => new NotFound({ message: 'Unknown cursor' })));

/**
 * Every word is required: FULLTEXT for three or more characters, `LOCATE` for shorter ones. A hyphenated word matches its
 * spaced form as a phrase and its joined form as a word; `text_joined` (text without hyphens) lets "offsite" find "off-site".
 * Hyphenated words whose parts are all shorter than three characters have no FULLTEXT tokens, so they use `LOCATE`.
 */
export const termFilter = (sql: SqlClient.SqlClient, words: ReadonlyArray<string>) => {
 const word = (w: string) => {
  const parts = w.split('-');
  if (parts.length > 1 && parts.every(part => part.length < 3)) return sql`LOCATE(${w}, ci.text) > 0`;
  // The joined prefix must precede the phrase: MySQL 8.4 boolean mode drops rows matching only the wildcard when a phrase comes first.
  if (parts.length > 1) return sql`MATCH(ci.text, ci.text_joined) AGAINST (${`${parts.join('')}* "${parts.join(' ')}"`} IN BOOLEAN MODE)`;
  return w.length >= 3 ? sql`MATCH(ci.text, ci.text_joined) AGAINST (${`+${w}*`} IN BOOLEAN MODE)` : sql`LOCATE(${w}, ci.text) > 0`;
 };
 return sql.and(words.map(word));
};

/**
 * MySQL's default InnoDB FULLTEXT stopwords, which are never indexed (so a required one matches no row), plus the question
 * and helper words of a spoken question that rarely appear in the fact that answers it.
 */
const QUESTION_WORDS = new Set(['a', 'about', 'an', 'are', 'as', 'at', 'be', 'by', 'com', 'de', 'en', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'la',
 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'who', 'will', 'with', 'und', 'www',
 'which', 'whom', 'whose', 'why', 'do', 'does', 'did', 'has', 'have', 'had', 'were', 'been', 'any', 'many', 'much', 'there',
 'we', 'our', 'us', 'you', 'your', 'they', 'their', 'can', 'could', 'would', 'should', 'and', 'its', 'not']);
/** Words that name the kind of answer ("which vendor", "any restrictions"); the fact names the answer, not its kind. */
const DETERMINERS = new Set(['which', 'what', 'whose', 'any']);
/** A word after these is the question's verb ("who owns", "was chosen", "we decide"), which the fact often words differently. */
const VERB_LEADS = new Set(['who', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'has', 'have', 'had', 'will', 'would', 'can', 'could',
 'should', 'we', 'you', 'they', 'i']);
/** Time words and clock times ("as of T0+04:00") ask for an order or a window; `from`, `to` and newest-first carry those. */
const TIME_WORDS = new Set(['current', 'currently', 'now', 'latest', 'newest', 'recent', 'start', 'history', 'order', 'before', 'after', 'since', 'until', 'between']);
const CLOCK = /\S*\d{1,2}:\d{2}\S*/g;
const TOKEN = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;

// ponytail: one-suffix stemmer for the prefix match ("speaking" -> "speak*"); swap for a real stemmer when recall measures need it.
const stem = (word: string) => {
 const root = word.replace(/ies$|ing$|(?<!e)ed$|en$|(?<!s)s$/, '');
 return root.length >= 3 && !QUESTION_WORDS.has(root) ? root : word;
};

/**
 * The words of a question, without question, helper, time and negated ("not Northwood") words. Names (a capital letter after
 * the first word, or a digit) are kept as written; other words of three or more letters lose one inflection ending. A word
 * is soft when it is the question's verb, or names the answer's kind (the words after "which"/"what"). Every other word is
 * required.
 */
const questionTerms = (q: string) => {
 const names: string[] = [], required: string[] = [], soft: string[] = [];
 let previous = '', kind = false;
 for (const [index, token] of (q.replace(CLOCK, ' ').match(TOKEN) ?? []).entries()) {
  const word = token.toLowerCase();
  const before = previous;
  previous = word;
  if (QUESTION_WORDS.has(word)) kind = DETERMINERS.has(word);
  else if (before === 'not' || TIME_WORDS.has(word)) continue;
  else if ((index > 0 && /^\p{Lu}/u.test(token)) || /\p{N}/u.test(token)) names.push(word);
  else if (word.length >= 3) (kind || VERB_LEADS.has(before) ? soft : required).push(stem(word));
 }
 return { names, required, soft };
};

/**
 * A query without question or helper words is a keyword query: every word is required. A question requires its names and
 * half of its required words; with no required word it needs one soft word. `null` when nothing is left to match.
 */
const searchFilter = (sql: SqlClient.SqlClient, q: string) => {
 const words = q.toLowerCase().match(TOKEN) ?? [];
 if (!words.some(word => QUESTION_WORDS.has(word))) return words.length === 0 ? null : termFilter(sql, words);
 const { names, required, soft } = questionTerms(q);
 const terms = required.length > 0 ? required : soft;
 if (terms.length === 0) return names.length === 0 ? null : termFilter(sql, names);
 // ponytail: OR-style count scans the caller's items instead of the FULLTEXT index; bounded by workspace scope and filters.
 const matched = terms.map(word => sql`(${termFilter(sql, [word])} > 0)`).reduce((sum, term) => sql`${sum} + ${term}`);
 return sql.and([termFilter(sql, names), sql`${matched} >= ${Math.ceil(required.length / 2) || 1}`]);
};

/** The first `limit` of `limit + 1` fetched rows, with a cursor after the last one when a further row exists. */
const searchPage = (rows: ReadonlyArray<ContextItem>, limit: number) => {
 const items = rows.slice(0, limit);
 const last = rows.length > limit ? items.at(-1) : undefined;
 const next_cursor = last === undefined ? null : Buffer.from(Schema.encodeSync(SearchCursor)([last.event_at ?? last.created_at, last.id])).toString('base64url');
 return { items, next_cursor } satisfies ContextSearchPage;
};

/**
 * Authorized lexical retrieval over current items, newest event first. Without `q` it lists by the other filters.
 * `from` (inclusive) and `to` (exclusive) bound `COALESCE(event_at, created_at)`; `next_cursor` resumes after the last item.
 */
export const searchContext = (access: AccessScope, input: SearchContextParams) =>
 Effect.gen(function*() {
  yield* requireScope(access, 'context:read');
  if (input.meeting_id) yield* authorizeMeeting(access, input.meeting_id, 'read');
  const scope: VisibleScope = input.meeting_id ? { meetings: [input.meeting_id], workspaceLevel: false } : yield* visibleScope(access);
  const sql = yield* SqlClient.SqlClient;
  const terms = input.q === undefined ? sql`1=1` : searchFilter(sql, input.q);
  if (terms === null) return searchPage([], 1);
  const after = input.cursor === undefined ? null : yield* decodeSearchCursor(input.cursor);
  const where = sql.and([sql`ci.state <> 'superseded'`, visibleWhere(sql, scope, 'ci.meeting_id'), ...rangeFilters(sql, input, after), terms]);
  const limit = Math.min(input.limit ?? 20, ITEM_LIMIT);
  return searchPage(yield* latestItems(access.workspace_id, where, limit + 1), limit);
 });

/** HTTP handlers for `ContextApi`; SDK and MCP adapters call the same domain functions. */
/** Runs a domain call as the authenticated caller; database failures surface as retryable Unavailable. */
const asCaller = <A, E>(call: (access: AccessScope) => Effect.Effect<A, E | SqlError.SqlError, SqlClient.SqlClient>) =>
 Effect.flatMap(CurrentAccess, call).pipe(
  Effect.catchIf(
   (error): error is SqlError.SqlError => error instanceof SqlError.SqlError,
   () => new Unavailable({ message: 'Database unavailable', retryable: true }),
  ),
 );

export const ContextLive = HttpApiBuilder.group(SanctumApi, 'context', handlers =>
 handlers
  .handle('getContext', ({ path }) => asCaller(access => getContextSnapshot(access, path.meeting_id)))
  .handle('searchContext', ({ urlParams }) => asCaller(access => searchContext(access, urlParams)))
  .handle('addContextItem', ({ payload }) => asCaller(access => addContextItem(access, payload)))
  .handle('reviseContextItem', ({ path, payload }) => asCaller(access => reviseContextItem(access, path.item_id, payload)))
  .handle('getContextChanges', ({ urlParams }) => asCaller(access => getContextChanges(access, urlParams)))
  .handle('getSource', ({ path }) => asCaller(access => getSource(access, path.source_id))),
);
