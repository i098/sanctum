/**
 * Real API server for the website's Team CSP end-to-end test: `serverLayer` from main.ts serving
 * the built website (`argv[2]`) with its real security headers, over a disposable migrated
 * in-memory database. The owner has a WorkOS identity and the workspace a linked
 * organization, so `POST /api/v1/workspace/widget-token` runs for real; WorkOS is faked at the
 * fetch boundary and answers an unsigned token granting the user-management widget. Prints
 * `{ url, session, csrf }` as one JSON line, serves until SIGTERM, then drops its database.
 */
import { HttpServer } from '@effect/platform';
import { Context, Effect, Exit, Layer, Option, Redacted, Scope } from 'effect';
import { KernelAuthenticatorLive, linkIdentity, openSession } from '../../src/auth.ts';
import { dbLayer } from '../../src/db.ts';
import { serverLayer } from '../../src/main.ts';
import { WorkosOrganizations, workosSettings } from '../../src/org-sync.ts';
import { SignInSettings } from '../../src/signin.ts';
import { linkWorkspaceOrg } from '../../src/store.ts';
import { createTestDatabase } from './database.ts';
import { seedWorkspace } from './fixtures.ts';

const ISSUER = 'https://team.authkit.test';
const webRoot = process.argv[2];
if (webRoot === undefined) throw new Error('usage: team-server.ts <built web-app/dist>');

const claims = { sub: 'user_ada', org_id: 'org_acme', permissions: ['widgets:users-table:manage'], exp: Math.floor(Date.now() / 1000) + 3600 };
const token = [{ alg: 'none' }, claims].map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fixture';
const workosFetch = (async (input: string | URL | Request) =>
  String(input) === 'https://api.workos.com/widgets/token' ? Response.json({ token }) : Response.json({ message: 'unexpected request' }, { status: 400 })) as typeof fetch;

const seed = Effect.gen(function* () {
  const [owner] = yield* seedWorkspace('Acme', ['owner']);
  yield* linkIdentity({ issuer: ISSUER, subject: 'user_ada', principal_id: owner!.principal.id });
  yield* linkWorkspaceOrg({ workspace_id: owner!.workspace_id, issuer: ISSUER, org_id: 'org_acme' });
  return yield* openSession({ workspace_id: owner!.workspace_id, principal_id: owner!.principal.id });
});

const { db: dbOptions, drop } = await createTestDatabase();
const scope = Effect.runSync(Scope.make());
/** Closes the server, drops the database and exits; SIGTERM and a failed start both end here. */
const shutdown = () => Effect.runPromise(Scope.close(scope, Exit.void)).then(drop).then(() => process.exit(0));
process.once('SIGTERM', () => void shutdown());
try {
  const session = await Effect.runPromise(Effect.provide(seed, dbLayer(dbOptions)));
  const client = { issuer: new URL(ISSUER), clientId: 'team', clientSecret: Option.none(), redirectUri: new URL('https://team.test/auth/callback'), scopes: 'openid' };
  const layer = serverLayer({ apiPort: 0, db: dbOptions, webRoot }, KernelAuthenticatorLive, {
    signIn: Layer.succeed(SignInSettings, { client: Option.some(client), embeddedIssuer: null }),
    organizations: Layer.succeed(WorkosOrganizations, Option.some(workosSettings({ apiKey: Redacted.make('sk_test_team'), timeoutMs: 5_000, fetch: workosFetch, issuer: ISSUER, selfServe: false }))),
  });
  const address = Context.get(await Effect.runPromise(Scope.extend(Layer.build(layer), scope)), HttpServer.HttpServer).address;
  if (address._tag !== 'TcpAddress') throw new Error('expected TCP');
  console.log(JSON.stringify({ url: `http://localhost:${address.port}`, session: session.token, csrf: session.csrf_token }));
} catch (error) {
  console.error(error);
  await shutdown();
}
