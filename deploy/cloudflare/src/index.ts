/**
 * Sanctum on Cloudflare: this Worker serves two hosts. The app host forwards every request,
 * including the listener WebSocket, to the API container; the apex sends visitors to the app host.
 * A second container from the same image runs the job worker; the cron restarts it after a crash or
 * rollout, so jobs keep running while nobody has the site open. State lives in MySQL and R2, never
 * on container disk.
 */
import { Container, getContainer } from '@cloudflare/containers';
import { type AppSettings, containerEnv, retireStaleContainer } from './settings.ts';

interface Env extends AppSettings {
  readonly API: DurableObjectNamespace<SanctumApi>;
  readonly JOBS: DurableObjectNamespace<SanctumJobs>;
}

/** Both processes run the same image with the same settings, restarted when those settings change. */
class SanctumContainer extends Container<Env> {
  override envVars = containerEnv(this.env);
  #envChecked = false;

  /** Once per object instance: a deploy or secret change starts a new instance with no open socket. */
  async #useCurrentEnv() {
    if (this.#envChecked) return;
    await retireStaleContainer(this.ctx, this.envVars);
    this.#envChecked = true;
  }

  override async fetch(request: Request) {
    await this.#useCurrentEnv();
    return super.fetch(request);
  }

  override async start(...args: Parameters<Container<Env>['start']>) {
    await this.#useCurrentEnv();
    return super.start(...args);
  }
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

/** The app, `/api/v1`, `/mcp`, `/auth/*` and the rest of the site. */
const APP_HOST = 'app.sanctum.42nights.dev';
const APEX_HOST = 'sanctum.42nights.dev';

/** The apex: 308 to the same path and query on the app host, so old links and the old MCP address keep working. */
const apex = (request: Request) => {
  const url = new URL(request.url);
  url.host = APP_HOST;
  return Response.redirect(url.toString(), 308);
};

export default {
  fetch: (request, env) => (new URL(request.url).hostname === APEX_HOST ? apex(request) : getContainer(env.API).fetch(request)),
  scheduled: async (_controller, env) => {
    await getContainer(env.JOBS).start();
  },
} satisfies ExportedHandler<Env>;
