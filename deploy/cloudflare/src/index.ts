/**
 * Sanctum on Cloudflare: this Worker serves two hosts. The app host forwards every request,
 * including the listener WebSocket, to the API container; the apex serves the
 * landing page and sends every other request to the app host.
 * A second container from the same image runs the job worker; the cron restarts it after a crash or
 * rollout, so jobs keep running while nobody has the site open. State lives in MySQL and R2, never
 * on container disk.
 */
import { Container, getContainer } from '@cloudflare/containers';
import { type AppSettings, containerEnv, retireStaleContainer } from './settings.ts';

interface Env extends AppSettings {
  readonly API: DurableObjectNamespace<SanctumApi>;
  readonly JOBS: DurableObjectNamespace<SanctumJobs>;
  /** The landing page build (web-app/landing); 404 for any path it does not contain. */
  readonly LANDING: Fetcher;
}

/** The app, `/api/v1`, `/mcp`, `/auth/*` and the rest of the site. */
const APP_HOST = 'app.sanctum.42nights.dev';
const APEX_HOST = 'sanctum.42nights.dev';

/** The landing page loads only its own script, styles and images, sends no referrer and is never framed. */
const LANDING_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'permissions-policy': 'microphone=(), camera=(), geolocation=(), display-capture=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
};

/** GET and HEAD for the landing page and its assets answer from the static build; anything else, and any path the build does not contain, returns undefined. */
async function landing(request: Request, env: Env): Promise<Response | undefined> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
  const asset = await env.LANDING.fetch(request);
  if (asset.status === 404) return undefined;
  const response = new Response(asset.body, asset);
  for (const [name, value] of Object.entries(LANDING_HEADERS)) response.headers.set(name, value);
  return response;
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

/** The apex: 308 to the same path and query on the app host, so old links keep working. MCP tokens issued for the apex resource no longer match the audience, so MCP clients must authorize again. */
const apex = (request: Request) => {
  const url = new URL(request.url);
  url.host = APP_HOST;
  return Response.redirect(url.toString(), 308);
};

export default {
  fetch: async (request, env) => {
    if (new URL(request.url).hostname !== APEX_HOST) return getContainer(env.API).fetch(request);
    return (await landing(request, env)) ?? apex(request);
  },
  scheduled: async (_controller, env) => {
    await getContainer(env.JOBS).start();
  },
} satisfies ExportedHandler<Env>;
