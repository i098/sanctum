/**
 * End-to-end agent workflow with the TypeScript SDK (plan section 13): read a meeting, cite a
 * source, append research, recover from a stale-revision conflict, consume changes, request an
 * action and read its receipt, then create and revoke a scoped agent credential.
 *
 *   SANCTUM_URL=https://sanctum.example SANCTUM_TOKEN=... node sdk/examples/typescript/context-workflow.ts <meeting_id>
 *
 * The token must carry `workspace:admin` for the agent steps. The action is only requested:
 * it executes later, and only under a stored grant.
 */
import { randomUUID } from 'node:crypto';
import { createClient, pages, SanctumError, type SanctumClient } from '@sanctum/sdk';

export interface Workflow {
  readonly admin: SanctumClient;
  /** Opens a client for another bearer token (the created agent credential). */
  readonly connect: (token: string) => SanctumClient;
  readonly meetingId: string;
  /** Prefix of every idempotency key, so a rerun with the same ID repeats no write. */
  readonly runId: string;
}

export async function contextWorkflow({ admin, connect, meetingId, runId }: Workflow) {
  // 1. Read the meeting and the first transcript segment; cite it by ID.
  const meeting = await admin.meetings.getMeeting({ meeting_id: meetingId });
  const firstPage = (await pages(admin, 'meetings.getTranscript', { meeting_id: meetingId, limit: 1 }).next()).value;
  const segment = firstPage?.segments[0];
  if (segment === undefined) throw new Error('Meeting has no final transcript yet');
  const source = await admin.context.getSource({ source_id: segment.id });
  if (source.kind !== 'segment') throw new Error('Segment IDs resolve to segment sources');

  // 2. Append a research observation at the snapshot revision; a retry with the same key is a no-op.
  const context = await admin.context.getContext({ meeting_id: meetingId });
  const observation = {
    meeting_id: meetingId,
    expected_revision: context.revision,
    kind: 'research_observation' as const,
    text: `Cited: ${source.text}`,
    sources: [{ segment_id: segment.id, start_ms: 0, end_ms: 1_000 }],
    idempotency_key: `${runId}:observation`,
  };
  const added = await admin.context.addContextItem(observation);
  const retried = await admin.context.addContextItem(observation);

  // 3. A write against the old revision conflicts; rebase on current_revision instead of overwriting.
  let rebasedRevision: unknown = null;
  try {
    await admin.context.addContextItem({ ...observation, text: 'Stale follow-up', idempotency_key: `${runId}:stale` });
  } catch (error) {
    if (!(error instanceof SanctumError && error.code === 'revision_conflict')) throw error;
    rebasedRevision = error.body['current_revision'];
    await admin.context.addContextItem({ ...observation, expected_revision: Number(rebasedRevision), text: 'Rebased follow-up', idempotency_key: `${runId}:rebased` });
  }

  // 4. Consume durable changes after the snapshot's cursor.
  const changes = await admin.context.getContextChanges({ cursor: context.changes_cursor });

  // 5. Discover one integration action, inspect it, request it and read the receipt.
  const { matches } = await admin.integrations.searchIntegrationActions({ intent: 'tracking issue', limit: 1 });
  const action = matches[0];
  if (action === undefined) throw new Error('No integration action matches');
  const inspected = await admin.integrations.getIntegrationAction({ action_key: action.action_key });
  const requested = await admin.actions.requestAction({
    action_key: inspected.action_key,
    configuration_ref: inspected.configuration_ref,
    version: inspected.version,
    arguments: { title: `Follow up: ${meeting.title ?? 'meeting'}` },
    meeting_id: meetingId,
    idempotency_key: `${runId}:action`,
  });
  const receipt = await admin.actions.getAction({ action_id: requested.action_id });

  // 6. Create a read-only agent credential for this meeting, use it, revoke it, and observe the refusal.
  const created = await admin.agents.createAgent({
    display_name: `Reader ${runId}`,
    scopes: ['context:read'],
    meetings: { kind: 'allowlist', meeting_ids: [meetingId] },
    expires_at: null,
  });
  const agent = connect(created.token);
  const agentRevision = (await agent.context.getContext({ meeting_id: meetingId })).revision;
  await admin.agents.revokeCredential({ agent_id: created.agent.id, key_id: created.credential.id });
  const afterRevoke = await agent.context.getContext({ meeting_id: meetingId }).then(
    () => 'still allowed',
    (error: unknown) => (error instanceof SanctumError ? error.code : String(error)),
  );

  return {
    meeting: meeting.title,
    cited: source.text,
    added_id: added.id,
    retry_returned_same_item: retried.id === added.id,
    rebased_revision: rebasedRevision,
    changes: changes.events.map(change => change.change),
    action_state: receipt.state,
    agent_saw_revision: agentRevision,
    after_revoke: afterRevoke,
  };
}

if (import.meta.main) {
  const baseUrl = process.env['SANCTUM_URL'];
  const meetingId = process.argv[2];
  if (baseUrl === undefined || meetingId === undefined) throw new Error('Usage: SANCTUM_URL=... SANCTUM_TOKEN=... context-workflow.ts <meeting_id>');
  const connect = (token: string) => createClient({ baseUrl, token });
  const result = await contextWorkflow({ admin: connect(process.env['SANCTUM_TOKEN'] ?? ''), connect, meetingId, runId: randomUUID() });
  console.log(JSON.stringify(result, null, 2));
}
