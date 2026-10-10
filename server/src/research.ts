/**
 * `research.run` work (plan section 10): the requester's granted actions found and inspected
 * through the same search and inspect gateways agents use (the catalog stays server-side), and
 * paid web research held to daily allowances per workspace and across all workspaces, reserved in
 * `paid_model_calls` before each request is sent. Research lands as a `research` artifact the meeting context cites.
 */
import { createHash, randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { type AccessScope, ArtifactId, ContextItemId, type IntegrationAccountId, type JobId, type MeetingId, type PrincipalId, SEARCH_MAX_LIMIT, type WorkspaceId } from '@sanctum/contracts';
import { Data, Effect, Schema } from 'effect';
import { activeActionGrants } from './actions.ts';
import { paidResearchAllowance } from './config.ts';
import { lockMeeting, writeItem } from './context.ts';
import { getIntegrationAction, searchIntegrationActions } from './integrations.ts';
import { LlmClient } from './llm.ts';

/** The claimed `research.run` fields used here, for a run someone asked for. */
interface ResearchJob {
  readonly id: JobId;
  readonly workspace_id: WorkspaceId;
  readonly requested_by: PrincipalId;
}

/** Inspected actions the requester holds a grant for in this meeting, among the search matches for the request. */
export const offeredActions = (access: AccessScope, meeting_id: MeetingId, request: string) =>
  Effect.gen(function* () {
    const grants = (yield* activeActionGrants(access)).filter(grant => grant.meeting_id === null || grant.meeting_id === meeting_id);
    if (grants.length === 0) return [];
    // Grants arrive meeting-specific first, then newest, the order `requestAction` matches them in; the
    // inspected schema must be the one of that grant's account or execution rejects it as stale.
    const accounts = new Map<string, IntegrationAccountId>();
    for (const grant of grants) if (!accounts.has(grant.action_key)) accounts.set(grant.action_key, grant.account_id);
    const { matches } = yield* searchIntegrationActions(access, { intent: request.slice(0, 500), limit: SEARCH_MAX_LIMIT });
    const inspected = yield* Effect.forEach(
      matches.filter(match => accounts.has(match.action_key)),
      match => getIntegrationAction(access, { action_key: match.action_key, account_id: accounts.get(match.action_key)! }).pipe(Effect.catchTag('NotFound', () => Effect.succeed(null))),
      { concurrency: 4 },
    );
    return inspected.filter(action => action !== null);
  });

class AllowanceSpent extends Data.TaggedError('AllowanceSpent')<{ readonly message: string }> {}

/**
 * Claims one of today's (UTC) paid calls when neither the workspace's nor the install-wide allowance
 * is spent; the locking read over today's calls serializes reservations from every workspace.
 */
const reservePaidCall = (job: ResearchJob, call_id: string, model: string) =>
  Effect.gen(function* () {
    const { perWorkspace, total } = yield* paidResearchAllowance;
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(Effect.gen(function* () {
      const [today] = yield* sql<{ used: number; workspace: number }>`SELECT COUNT(*) AS used, COALESCE(SUM(workspace_id = ${job.workspace_id}), 0) AS workspace
        FROM paid_model_calls WHERE started_at >= UTC_DATE() FOR UPDATE`;
      if (Number(today!.workspace) >= perWorkspace) {
        return yield* new AllowanceSpent({ message: `Paid web research allowance of ${perWorkspace} calls per workspace per day (UTC) is spent` });
      }
      if (Number(today!.used) >= total) {
        return yield* new AllowanceSpent({ message: `Paid web research allowance of ${total} calls per day (UTC) across all workspaces is spent` });
      }
      yield* sql`INSERT INTO paid_model_calls (id, workspace_id, job_id, model, started_at) VALUES (${call_id}, ${job.workspace_id}, ${job.id}, ${model}, UTC_TIMESTAMP(6))`;
    }));
  });

const RESEARCH_SYSTEM = `You research a request someone made in a meeting, using web search.
Answer in a few short plain-text paragraphs, cite the pages you used, and say so when the web has no clear answer.`;

/** The `research` artifact's content. */
const StoredResearch = Schema.parseJson(Schema.Struct({ text: Schema.String, sources: Schema.Array(Schema.Struct({ url: Schema.String, title: Schema.NullOr(Schema.String) })) }));

/**
 * Web research for the original request, stored once per job: a retried job that stored its
 * research reuses the artifact without paying again; each further paid attempt counts against the
 * allowance. Fails with `AllowanceSpent` before sending when today's allowance is used.
 */
const research = (job: ResearchJob, meeting_id: MeetingId, request: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [stored] = yield* sql<{ id: ArtifactId; content: string }>`
      SELECT id, content FROM artifacts WHERE workspace_id = ${job.workspace_id} AND kind = 'research' AND provenance->>'$.job_id' = ${job.id} LIMIT 1`;
    if (stored) return { artifact_id: stored.id, ...(yield* Schema.decodeUnknown(StoredResearch)(stored.content)) };
    const llm = yield* LlmClient;
    const call_id = randomUUID();
    const prompt = `Today (UTC): ${new Date().toISOString().slice(0, 10)}\n\nRequest: ${request}`;
    const { value, model } = yield* llm.research(
      { system: RESEARCH_SYSTEM, prompt },
      model => reservePaidCall(job, call_id, model),
      usage => Effect.gen(function* () {
        yield* sql`UPDATE paid_model_calls SET finished_at = UTC_TIMESTAMP(6), input_tokens = ${usage.input_tokens}, output_tokens = ${usage.output_tokens},
          web_searches = ${usage.web_searches} WHERE workspace_id = ${job.workspace_id} AND id = ${call_id}`;
        yield* Effect.logInfo('paid web research call', { workspace_id: job.workspace_id, job_id: job.id, ...usage });
      }),
    );
    const content = Schema.encodeSync(StoredResearch)({ text: value.text, sources: value.sources });
    const artifact_id = ArtifactId.make(randomUUID());
    yield* sql`INSERT INTO artifacts (id, workspace_id, meeting_id, kind, title, content_type, content, sha256, provenance, created_by, created_at)
      VALUES (${artifact_id}, ${job.workspace_id}, ${meeting_id}, 'research', ${`Research: ${request.slice(0, 200)}`}, 'application/json',
        ${content}, ${createHash('sha256').update(content).digest()}, ${JSON.stringify({ job_id: job.id, model, request })}, ${job.requested_by}, UTC_TIMESTAMP(6))`;
    return { artifact_id, text: value.text, sources: value.sources };
  });

/** Stored web research for a job and the context item that cites it. */
export interface WebResearch {
  readonly artifact_id: ArtifactId;
  readonly context_item_id: ContextItemId;
  readonly text: string;
  readonly sources: ReadonlyArray<{ readonly url: string; readonly title: string | null }>;
}

/**
 * Researches the request and adds the answer to the meeting context once per job, as an external
 * observation citing its artifact. Like extraction, the worker is the author and the requester the actor.
 */
export const webResearch = (job: ResearchJob, meeting_id: MeetingId, request: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const found = yield* research(job, meeting_id, request);
    const key = `research-${job.id}`;
    const context_item_id = yield* sql.withTransaction(Effect.gen(function* () {
      const lock = yield* lockMeeting(job.workspace_id, meeting_id);
      const [existing] = yield* sql<{ id: ContextItemId }>`SELECT id FROM context_items
        WHERE workspace_id = ${job.workspace_id} AND author_principal_id = ${job.requested_by} AND idempotency_key = ${key} LIMIT 1`;
      if (existing) return existing.id;
      const text = (found.text.trim() || 'Web research found no answer.').slice(0, 20_000);
      const item = yield* writeItem(job.workspace_id, {
        id: ContextItemId.make(randomUUID()),
        revision: 1,
        meeting_id,
        kind: 'research_observation',
        text,
        state: 'provisional',
        derivation: 'external',
        event_at: null,
        valid_from: null,
        valid_until: null,
        time: null,
        author: { type: 'system', id: job.requested_by },
        sources: [{ artifact_id: found.artifact_id }],
        supersedes: null,
      }, { change: 'item_added', idempotency: { key, sha256: createHash('sha256').update(text).digest('hex') }, ...(lock ? { source_revision: lock.boundary_revision } : {}) });
      return item.id;
    }));
    return { artifact_id: found.artifact_id, context_item_id, text: found.text, sources: found.sources };
  });
