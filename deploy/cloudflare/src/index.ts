/**
 * Sanctum on Cloudflare: this Worker answers the secret login link and forwards every other
 * request, including the listener WebSocket, to the API container. A second container from the
 * same image runs the job worker; the cron restarts it after a crash or rollout, so jobs keep
 * running while nobody has the site open. State lives in MySQL and R2, never on container disk.
 */
import { Container, getContainer } from '@cloudflare/containers';
import { type LoginSecrets, loginResponse } from './login.ts';
import { type AppSettings, containerEnv } from './settings.ts';

interface Env extends LoginSecrets, AppSettings {
  readonly API: DurableObjectNamespace<SanctumApi>;
  readonly JOBS: DurableObjectNamespace<SanctumJobs>;
}

/** Both processes run the same image with the same settings. */
class SanctumContainer extends Container<Env> {
  override envVars = containerEnv(this.env);
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
