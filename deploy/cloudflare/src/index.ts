/**
 * Sanctum on Cloudflare: this Worker answers the secret login link and forwards every other
 * request, including the listener WebSocket, to the API container. A second container from the
 * same image runs the job worker; the cron restarts it after a crash or rollout, so jobs keep
 * running while nobody has the site open. State lives in MySQL and R2, never on container disk.
 */
import { Container, getContainer } from '@cloudflare/containers';
import { type LoginSecrets, loginResponse } from './login.ts';

/** Settings the image reads (docs/operations.md); MySQL and R2 values are Worker secrets. */
const APP_SETTINGS = [
  'SANCTUM_ENV',
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_DATABASE',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_CA_CERT',
  'MYSQL_POOL_SIZE',
  'R2_ENDPOINT',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

interface Env extends LoginSecrets, Partial<Record<(typeof APP_SETTINGS)[number], string>> {
  readonly API: DurableObjectNamespace<SanctumApi>;
  readonly JOBS: DurableObjectNamespace<SanctumJobs>;
}

/** Both processes run the same image with the same settings. */
class SanctumContainer extends Container<Env> {
  override envVars = Object.fromEntries(APP_SETTINGS.flatMap(name => (this.env[name] === undefined ? [] : [[name, this.env[name]]])));
}

/** `node server/dist/main.js` on its port; sleeps after the default idle period and starts on the next request. */
export class SanctumApi extends SanctumContainer {
  override defaultPort = 7102;
}

/** `node server/dist/worker.js`: no port, never put to sleep for inactivity. */
export class SanctumJobs extends SanctumContainer {
  override entrypoint = ['node', 'server/dist/worker.js'];
  override async onActivityExpired() {}
}

export default {
  fetch: (request, env) => loginResponse(new URL(request.url), env) ?? getContainer(env.API).fetch(request),
  scheduled: async (_controller, env) => {
    await getContainer(env.JOBS).start();
  },
} satisfies ExportedHandler<Env>;
