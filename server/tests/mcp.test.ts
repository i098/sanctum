import { randomUUID } from 'node:crypto';
import { SqlClient } from '@effect/sql';
import { describe, expect, it } from '@effect/vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { AccessScope } from '@sanctum/contracts';
import { createClient } from '@sanctum/sdk';
import { Effect, Option, TestClock } from 'effect';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { type JsonSchema, deref, operations } from '../../scripts/generate-sdks.ts';
import { MCP_SESSION_IDLE_MS, MCP_TOOL_NAMES, mcpTools } from '../src/mcp.ts';
import { addMember, linkWorkspaceOrg } from '../src/store.ts';
import { HOLD_SOURCE_ID } from './support/fake-domain.ts';
import { seedWorkspace } from './support/fixtures.ts';
import { serveFake } from './support/serve.ts';

const ISSUER = 'https://issuer.fixture.test';
const RESOURCE = 'https://sanctum.fixture.test/mcp';
const { publicKey, privateKey } = await generateKeyPair('ES256');
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256' }] });

const sign = (subject: string, scope: string, claims: { aud?: string; exp?: number; workspace_id?: string; org_id?: string } = {}) =>
  new SignJWT({ scope, ...(claims.workspace_id ? { workspace_id: claims.workspace_id } : {}), ...(claims.org_id ? { org_id: claims.org_id } : {}) })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(ISSUER)
    .setSubject(subject)
    .setAudience(claims.aud ?? RESOURCE)
    .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 600)
    .sign(privateKey);

/** Links a fixture issuer subject to a seeded principal, as sign-in would after verification. */
const identify = (access: AccessScope) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const subject = `sub-${access.principal.id}`;
    yield* sql`INSERT INTO principal_identities (issuer, subject, principal_id, verified_at) VALUES (${ISSUER}, ${subject}, ${access.principal.id}, UTC_TIMESTAMP(6))`;
    return subject;
  });

const connect = (url: string, token: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
      const client = new Client({ name: 'sanctum-test', version: '1.0.0' });
      // The SDK's own transport class; its optional sessionId trips exactOptionalPropertyTypes only.
      await client.connect(transport as Transport);
      return { client, transport };
    }),
    ({ client }) => Effect.promise(() => client.close()),
  );

const configured = Option.some({ resource: RESOURCE, issuer: ISSUER, keys, defaultScopes: [] });
const post = (url: string, token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
const initialize = (protocolVersion: string) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
});

/** Resolves refs and drops prose/meta keys so two JSON Schema renderings of one contract compare equal. */
function normalize(schema: unknown, defs: Record<string, JsonSchema>): unknown {
  if (Array.isArray(schema)) return schema.map(item => normalize(item, defs));
  if (typeof schema !== 'object' || schema === null) return schema;
  const record = schema as JsonSchema & Record<string, unknown>;
  if (record.$ref) {
    const name = record.$ref.split('/').pop()!;
    return normalize(defs[name] ?? deref(record), defs);
  }
  const skip = new Set(['description', 'title', '$schema', '$id', '$defs']);
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !skip.has(key))
      .map(([key, value]) => [key, key === 'required' ? [...(value as string[])].sort() : normalize(value, defs)]),
  );
}

describe('MCP tool surface', () => {
  it('exposes exactly the eleven plan tools and no admin or capture route', () => {
    expect(MCP_TOOL_NAMES).toEqual([
      'list_meetings', 'get_context', 'search_context', 'get_source', 'get_context_changes', 'add_context',
      'revise_context', 'request_action', 'get_action', 'search_integration_actions', 'get_integration_action',
    ]);
    const groups = mcpTools().map(route => route.operation.split('.')[0]);
    expect(groups.filter(group => !['meetings', 'context', 'actions', 'integrations'].includes(group!))).toEqual([]);
  });

  it('gives every tool the same input schema as its v1 REST operation', () => {
    const byId = new Map(operations.map(op => [op.id, op]));
    for (const route of mcpTools()) {
      const operation = byId.get(route.operation);
      expect(operation, route.tool.name).toBeDefined();
      const tool = route.tool.inputSchema as JsonSchema & { $defs?: Record<string, JsonSchema> };
      const mcp = normalize(tool, tool.$defs ?? {}) as { properties: Record<string, { type?: string }> };
      const rest = normalize(operation!.input, {}) as typeof mcp;
      // REST query numbers are text (bounds checked on decode); MCP takes the decoded integer with its bounds.
      for (const [name, schema] of Object.entries(rest.properties)) {
        if (JSON.stringify(schema) !== '{"type":"integer"}') continue;
        expect(mcp.properties[name]?.type, `${route.tool.name}.${name}`).toBe('integer');
        mcp.properties[name] = schema;
      }
      expect(mcp, route.tool.name).toEqual(rest);
      expect(route.tool.annotations?.readOnlyHint, route.tool.name).toBe(route.method === 'GET');
    }
  });

  it('pins the SDK protocol baseline', () => {
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(expect.arrayContaining(['2025-11-25', '2025-06-18', '2025-03-26']));
  });
});

describe('MCP over Streamable HTTP', () => {
  it.scoped('refuses every call while the authorization server is unselected', () =>
    Effect.gen(function* () {
      const { url } = yield* serveFake();
      const response = yield* Effect.promise(() => post(url, 'anything', initialize(LATEST_PROTOCOL_VERSION)));
      expect(response.status).toBe(503);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ code: 'unavailable', retryable: false });
      expect((yield* Effect.promise(() => fetch(`${url}/.well-known/oauth-protected-resource/mcp`))).status).toBe(503);
    }),
  );

  it.scoped('publishes resource metadata and rejects missing, expired and wrong-audience tokens', () =>
    Effect.gen(function* () {
      const { url, db } = yield* serveFake(configured);
      const [owner] = yield* Effect.provide(seedWorkspace('Tokens', ['owner']), db);
      const subject = yield* Effect.provide(identify(owner!), db);
      const metadata = yield* Effect.promise(() => fetch(`${url}/.well-known/oauth-protected-resource/mcp`).then(r => r.json()));
      expect(metadata).toEqual({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ['context:read', 'context:write', 'recordings:read', 'actions:request', 'actions:execute'],
        bearer_methods_supported: ['header'],
      });
      const cases = [
        null,
        yield* Effect.promise(() => sign(subject, 'context:read', { aud: 'https://other.test/mcp' })),
        yield* Effect.promise(() => sign(subject, 'context:read', { exp: Math.floor(Date.now() / 1000) - 60 })),
        yield* Effect.promise(() => sign('unknown-subject', 'context:read')),
      ];
      const statuses: number[] = [];
      for (const token of cases) {
        const response = yield* Effect.promise(() => post(url, token, initialize(LATEST_PROTOCOL_VERSION)));
        statuses.push(response.status);
        const header = response.headers.get('www-authenticate');
        expect(header).toContain(`resource_metadata="https://sanctum.fixture.test/.well-known/oauth-protected-resource/mcp"`);
        if (response.status === 401) expect(header).toContain('scope="context:read context:write recordings:read"');
      }
      expect(statuses).toEqual([401, 401, 401, 403]);
    }),
  );

  it.scoped('grants configured default scopes only to tokens that name no Sanctum scope', () =>
    Effect.gen(function* () {
      const { url, db, domain } = yield* serveFake(Option.some({ resource: RESOURCE, issuer: ISSUER, keys, defaultScopes: ['context:read', 'workspace:admin'] }));
      const [owner, member] = yield* Effect.provide(seedWorkspace('Defaults', ['owner', 'member']), db);
      const token = (access: AccessScope, scope: string, claims: { aud?: string } = {}) =>
        Effect.flatMap(Effect.provide(identify(access), db), subject => Effect.promise(() => sign(subject, scope, claims)));
      const metadata = yield* Effect.promise(() => fetch(`${url}/.well-known/oauth-protected-resource/mcp`).then(r => r.json()));
      expect(metadata).toEqual({ resource: RESOURCE, authorization_servers: [ISSUER], bearer_methods_supported: ['header'] });

      const meeting = domain.addMeeting(owner!, 'Defaults review');
      const add = { meeting_id: meeting.id, expected_revision: 0, kind: 'decision', text: 'Ship', sources: [{ artifact_id: randomUUID() }], idempotency_key: 'd-1' };
      const reader = yield* connect(url, yield* token(member!, 'openid profile email offline_access'));
      expect((yield* Effect.promise(() => reader.client.callTool({ name: 'get_context', arguments: { meeting_id: meeting.id } }))).isError).toBeFalsy();
      const refused = yield* Effect.promise(() => reader.client.callTool({ name: 'add_context', arguments: add }));
      expect(refused.isError).toBe(true);
      expect(JSON.parse((refused.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'forbidden', required_scope: 'context:write' });

      // Named Sanctum scopes replace the defaults instead of widening them.
      const writer = yield* connect(url, yield* token(owner!, 'openid context:write'));
      expect((yield* Effect.promise(() => writer.client.callTool({ name: 'add_context', arguments: add }))).isError).toBeFalsy();
      const unread = yield* Effect.promise(() => writer.client.callTool({ name: 'get_context', arguments: { meeting_id: meeting.id } }));
      expect(JSON.parse((unread.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'forbidden', required_scope: 'context:read' });

      const send = (token: string | null) => Effect.promise(() => post(url, token, initialize(LATEST_PROTOCOL_VERSION)));
      const missing = yield* send(null);
      expect(missing.status).toBe(401);
      expect(missing.headers.get('www-authenticate')).not.toContain('scope=');
      expect((yield* send(yield* Effect.promise(() => sign(`sub-${member!.principal.id}`, 'openid', { aud: 'https://other.test/mcp' })))).status).toBe(401);
      expect((yield* send(yield* Effect.promise(() => sign('sub-unknown', 'openid')))).status).toBe(403);
    }),
  );

  it.scoped('negotiates older protocol versions and binds sessions to their principal', () =>
    Effect.gen(function* () {
      const { url, db } = yield* serveFake(configured);
      const [alice, bob] = yield* Effect.provide(seedWorkspace('Sessions', ['member', 'member']), db);
      const aliceToken = yield* Effect.promise(async () => sign(await Effect.runPromise(Effect.provide(identify(alice!), db)), 'context:read'));
      const bobToken = yield* Effect.promise(async () => sign(await Effect.runPromise(Effect.provide(identify(bob!), db)), 'context:read'));
      const response = yield* Effect.promise(() => post(url, aliceToken, initialize('2025-03-26')));
      const body = yield* Effect.promise(() => response.json() as Promise<{ result: { protocolVersion: string } }>);
      expect(body.result.protocolVersion).toBe('2025-03-26');
      const session = response.headers.get('mcp-session-id')!;
      const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
      const headers = { 'mcp-session-id': session, 'mcp-protocol-version': '2025-03-26' };
      yield* Effect.promise(() => post(url, aliceToken, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers));
      const own = yield* Effect.promise(() => post(url, aliceToken, list, headers).then(r => r.json() as Promise<{ result: { tools: unknown[] } }>));
      expect(own.result.tools).toHaveLength(11);
      expect((yield* Effect.promise(() => post(url, bobToken, list, headers))).status).toBe(404);

      const { transport } = yield* connect(url, aliceToken);
      expect(transport.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    }),
  );

  it.scoped('closes sessions left idle when a host re-initializes without DELETE', () =>
    Effect.gen(function* () {
      const { url, db } = yield* serveFake(configured);
      const [member] = yield* Effect.provide(seedWorkspace('Idle', ['member']), db);
      const token = yield* Effect.promise(async () => sign(await Effect.runPromise(Effect.provide(identify(member!), db)), 'context:read'));
      const open = Effect.promise(() => post(url, token, initialize(LATEST_PROTOCOL_VERSION)).then(r => r.headers.get('mcp-session-id')!));
      const list = (session: string) =>
        Effect.promise(() =>
          post(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-session-id': session, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION }).then(r => r.status),
        );
      const first = yield* open;
      expect(yield* list(first)).toBe(200);
      yield* TestClock.adjust(`${MCP_SESSION_IDLE_MS - 1} millis`);
      expect(yield* list(first)).toBe(200);
      yield* TestClock.adjust(`${MCP_SESSION_IDLE_MS + 1} millis`);
      const second = yield* open;
      expect(yield* list(first)).toBe(404);
      expect(yield* list(second)).toBe(200);
    }),
  );

  it.scoped('selects a multi-membership workspace by the org_id linked under the token issuer', () =>
    Effect.gen(function* () {
      const { url, db, domain } = yield* serveFake(configured);
      const [owner] = yield* Effect.provide(seedWorkspace('Home', ['owner']), db);
      const [teamOwner] = yield* Effect.provide(seedWorkspace('Team', ['owner']), db);
      const team = { ...owner!, workspace_id: teamOwner!.workspace_id };
      yield* Effect.provide(
        Effect.all([
          addMember({ workspace_id: team.workspace_id, principal_id: owner!.principal.id, role: 'member' }),
          linkWorkspaceOrg({ workspace_id: team.workspace_id, issuer: ISSUER, org_id: 'org_team' }),
          linkWorkspaceOrg({ workspace_id: team.workspace_id, issuer: ISSUER, org_id: 'org_team' }),
          linkWorkspaceOrg({ workspace_id: owner!.workspace_id, issuer: 'https://other-issuer.fixture.test', org_id: 'org_home' }),
        ]),
        db,
      );
      const meeting = domain.addMeeting(team, 'Team sync');
      const subject = yield* Effect.provide(identify(owner!), db);
      const status = (claims: { org_id?: string }) =>
        Effect.promise(async () => (await post(url, await sign(subject, 'context:read', claims), initialize(LATEST_PROTOCOL_VERSION))).status);
      // Two memberships: no claim is ambiguous, an org linked only at another issuer is unknown here.
      expect([yield* status({}), yield* status({ org_id: 'org_home' }), yield* status({ org_id: 'org_unknown' })]).toEqual([403, 403, 403]);
      const { client } = yield* connect(url, yield* Effect.promise(() => sign(subject, 'context:read', { org_id: 'org_team' })));
      const listed = yield* Effect.promise(() => client.callTool({ name: 'list_meetings', arguments: {} }));
      expect(listed.structuredContent).toMatchObject({ meetings: [{ id: meeting.id }] });
    }),
  );

  it.scoped('shares revisions and receipts with the SDK, enforces scopes, tenants, conflicts and revocation', () =>
    Effect.gen(function* () {
      const { url, db, domain } = yield* serveFake(configured);
      const [owner, agent] = yield* Effect.provide(seedWorkspace('Shared', ['owner', 'agent']), db);
      const [outsider] = yield* Effect.provide(seedWorkspace('Elsewhere', ['owner']), db);
      // Agent members authenticate only while they hold an active credential.
      yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO agent_credentials (id, workspace_id, principal_id, owner_principal_id, token_hash, scopes, created_at)
          VALUES (${randomUUID()}, ${agent!.workspace_id}, ${agent!.principal.id}, ${owner!.principal.id}, UNHEX(SHA2(${randomUUID()}, 256)), '["context:read"]', UTC_TIMESTAMP(6))`),
        db,
      );
      const token = (access: AccessScope, scope: string) =>
        Effect.flatMap(Effect.provide(identify(access), db), subject => Effect.promise(() => sign(subject, scope)));
      const meeting = domain.addMeeting(owner!, 'Shared review');
      const writer = yield* connect(url, yield* token(owner!, 'context:read context:write actions:request'));
      const reader = yield* connect(url, yield* token(agent!, 'context:read'));
      const stranger = yield* connect(url, yield* token(outsider!, 'context:read context:write'));
      const sdk = createClient({ baseUrl: url, token: domain.token(owner!) });
      const call = (who: typeof writer, name: string, args: Record<string, unknown>) =>
        Effect.promise(() => who.client.callTool({ name, arguments: args }));
      /** Error results carry the shared REST error envelope as their text content. */
      const failure = (result: Awaited<ReturnType<typeof writer.client.callTool>>) => {
        expect(result.isError).toBe(true);
        const [content] = result.content as Array<{ type: string; text: string }>;
        return JSON.parse(content!.text) as Record<string, unknown>;
      };

      const listed = yield* Effect.promise(() => reader.client.listTools());
      expect(listed.tools.map(tool => tool.name)).toEqual(MCP_TOOL_NAMES);

      const add = { meeting_id: meeting.id, expected_revision: 0, kind: 'decision', text: 'Ship option B', sources: [{ artifact_id: randomUUID() }], idempotency_key: 'mcp-1' };
      const added = yield* call(writer, 'add_context', add);
      expect(added.isError).toBeFalsy();
      expect(added.structuredContent).toMatchObject({ text: 'Ship option B', revision: 1, author: { type: 'human', id: owner!.principal.id } });
      expect(yield* call(writer, 'add_context', add)).toMatchObject({ structuredContent: { id: (added.structuredContent as { id: string }).id } });

      // The SDK writes the next revision; both MCP principals see it.
      yield* Effect.promise(() => sdk.context.addContextItem({ ...add, expected_revision: 1, text: 'Budget approved', idempotency_key: 'sdk-1' } as never));
      const seen = yield* call(reader, 'get_context', { meeting_id: meeting.id });
      expect(seen.structuredContent).toMatchObject({ revision: 2 });
      expect((seen.structuredContent as { items: Array<{ text: string }> }).items.map(i => i.text)).toEqual(['Ship option B', 'Budget approved']);

      const stale = yield* call(writer, 'add_context', { ...add, text: 'Late', idempotency_key: 'mcp-2' });
      expect(failure(stale)).toMatchObject({ code: 'revision_conflict', current_revision: 2 });
      const invalid = yield* call(writer, 'add_context', { ...add, expected_revision: 'two', idempotency_key: 'mcp-3' });
      expect(invalid.isError).toBe(true);
      expect(failure(yield* call(reader, 'add_context', { ...add, expected_revision: 2, idempotency_key: 'mcp-4' }))).toMatchObject({
        code: 'forbidden',
        required_scope: 'context:write',
      });
      expect(failure(yield* call(stranger, 'get_context', { meeting_id: meeting.id }))).toMatchObject({ code: 'not_found' });
      const tooMany = yield* call(writer, 'list_meetings', { limit: 201 });
      expect(tooMany.isError).toBe(true);
      expect(yield* call(writer, 'list_meetings', { limit: 2 })).toMatchObject({ structuredContent: { meetings: [{ id: meeting.id }], next_cursor: null } });

      const requested = yield* call(writer, 'request_action', {
        action_key: 'linear-create-issue', configuration_ref: 'cfg', version: '1.0.0', arguments: { title: 'B' }, meeting_id: meeting.id, idempotency_key: 'act-1',
      });
      const actionId = (requested.structuredContent as { action_id: string }).action_id;
      domain.settleAction(owner!, actionId, 'succeeded', { issue: 'LIN-7' });
      const viaMcp = yield* call(reader, 'get_action', { action_id: actionId });
      const viaSdk = yield* Effect.promise(() => sdk.actions.getAction({ action_id: actionId }));
      expect(viaMcp.structuredContent).toEqual(viaSdk);
      expect(viaSdk).toMatchObject({ state: 'succeeded', provider_receipt: { issue: 'LIN-7' } });

      const search = yield* call(reader, 'search_integration_actions', { intent: 'issue' });
      expect(search.structuredContent).toMatchObject({ matches: [{ action_key: 'linear-create-issue' }] });

      // Revoking the membership refuses the very next call on the open session.
      yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE workspace_members SET revoked_at = UTC_TIMESTAMP(6) WHERE workspace_id = ${agent!.workspace_id} AND principal_id = ${agent!.principal.id}`),
        db,
      );
      const revoked = yield* Effect.promise(() => reader.client.callTool({ name: 'get_context', arguments: { meeting_id: meeting.id } }).then(() => 'allowed', (e: Error) => e.message));
      expect(revoked).toContain('"code":"forbidden"');
    }),
  );

  it.scoped('cancels the running tool when the client aborts', () =>
    Effect.gen(function* () {
      const { url, db, domain } = yield* serveFake(configured);
      const [member] = yield* Effect.provide(seedWorkspace('Cancel', ['member']), db);
      const subject = yield* Effect.provide(identify(member!), db);
      const { client } = yield* connect(url, yield* Effect.promise(() => sign(subject, 'context:read')));
      const controller = new AbortController();
      const pending = client.callTool({ name: 'get_source', arguments: { source_id: HOLD_SOURCE_ID } }, undefined, { signal: controller.signal }).catch((e: Error) => e);
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 300)));
      controller.abort('user cancelled');
      expect(yield* Effect.promise(() => pending)).toBeInstanceOf(Error);
      yield* Effect.promise(() => expect.poll(() => domain.interrupted).toEqual([HOLD_SOURCE_ID]));
    }),
  );
});
