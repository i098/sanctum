/**
 * Website sign-in state over the server's `/auth` routes (sign-in plan section 4.3) and
 * `GET /api/v1/session`. Sign-in always starts with a same-origin navigation, never a cross-origin
 * form post: the page CSP allows only `form-action 'self'`.
 */
import { type AccessScope, createClient, type SanctumClient, SanctumError } from '@sanctum/sdk';

/** The session opener's script-readable double-submit cookie; its value goes back as `x-csrf-token`. */
export const csrfToken = (): string | undefined =>
  globalThis.document?.cookie.split('; ').find((pair) => pair.startsWith('sanctum_csrf='))?.slice('sanctum_csrf='.length);

/** Same-origin v1 client: the session cookie authenticates every call, and mutations carry the CSRF header. */
export function sessionClient(): SanctumClient {
  return createClient({
    baseUrl: window.location.origin,
    fetch: (input, init) => {
      const csrf = csrfToken();
      return fetch(input, csrf === undefined ? init : { ...init, headers: { ...init?.headers, 'x-csrf-token': decodeURIComponent(csrf) } });
    },
  });
}

/** A completed sign-in returns to `/?signin=ok`, so the page can confirm it even when the issuer redirects back instantly. */
export const SIGN_IN_URL = '/auth/login?return_to=/?signin=ok';

/**
 * `issuer`: `GET /auth/config` reports a complete sign-in issuer. Without one, a session can only
 * come from an operator-seeded `browser_sessions` row. A server without the route counts as not configured.
 * `workosTeam`: WorkOS organizations hold the hosted team. `linked`: the workspace has its WorkOS
 * organization and the caller is an owner or admin, so Settings offers Team; `setup`: it has none
 * yet and the caller is its owner, so Team offers "Set up team"; false: no Team.
 * `selfServe`: a signed-in user without a membership may create a workspace.
 * `team`: that issuer is the embedded self-hosted one, whose organizations hold the workspace's team.
 */
export type SignInState =
  | { status: 'signed_in'; access: AccessScope; issuer: boolean; team: boolean; workosTeam: 'linked' | 'setup' | false }
  | { status: 'signed_out'; selfServe: boolean }
  | { status: 'checking' | 'unconfigured' | 'unavailable' };

/** How the last sign-in redirect ended (`/?signin=<code>`), read once from the landing URL. */
export type SignInNotice = { code: 'not_member'; issuer: string; subject: string } | { code: 'failed' | 'unconfigured' };

/** Who the signed-in person is to themself: the provider name, else the email (shown only in their own view); `beneath` is the email next to a name. */
export const accountLabel = ({ display_name, email }: AccessScope['principal']) => ({
  label: display_name ?? email ?? '',
  beneath: display_name === null ? undefined : email,
});

/** `false`: no route, a non-JSON body (a server before the route may answer with the SPA index) or a 4xx; `'unavailable'`: network error or 5xx. `embedded`: the self-hosted Better Auth issuer. */
async function configured(): Promise<false | 'unavailable' | { selfServe: boolean; embedded: boolean; workos: boolean }> {
  try {
    const response = await fetch('/auth/config', { headers: { accept: 'application/json' } });
    if (response.status >= 500) return 'unavailable';
    const config = response.ok ? await response.json() : {};
    return config.sign_in === true && { selfServe: config.self_serve_workspaces === true, embedded: config.embedded_issuer === 'better-auth', workos: config.workos_organizations === true };
  } catch (error) {
    return error instanceof SyntaxError ? false : 'unavailable';
  }
}

async function session(client: SanctumClient): Promise<AccessScope | 'signed_out' | 'unavailable'> {
  try {
    return await client.session.getSession({});
  } catch (error) {
    return error instanceof SanctumError && error.status === 401 ? 'signed_out' : 'unavailable';
  }
}

/** `workosTeam` for an owner or admin on a WorkOS server; a failed read offers no Team. */
async function workosTeam(access: AccessScope): Promise<'linked' | 'setup' | false> {
  if (!access.scopes.includes('workspace:admin')) return false;
  try {
    const response = await fetch('/api/v1/workspace/team', { headers: { accept: 'application/json' } });
    if (!response.ok) return false;
    if ((await response.json()).linked === true) return 'linked';
    return access.role === 'owner' && 'setup';
  } catch {
    return false;
  }
}

export async function readSignIn(client: SanctumClient): Promise<SignInState> {
  const [issuer, current] = await Promise.all([configured(), session(client)]);
  if (typeof current === 'object') {
    const team = typeof issuer === 'object' && issuer.embedded;
    const workos = typeof issuer === 'object' && issuer.workos ? await workosTeam(current) : false;
    return { status: 'signed_in', access: current, issuer: issuer !== false, team, workosTeam: workos };
  }
  if (current === 'unavailable' || issuer === 'unavailable') return { status: 'unavailable' };
  return issuer ? { status: current, selfServe: issuer.selfServe } : { status: 'unconfigured' };
}

/**
 * Clears the query off the address bar so a reload does not repeat the notice; the callback lands on `/`.
 * `'signed_in'`: the return of SIGN_IN_URL; the caller confirms it only if the session reads as signed in.
 */
export function takeSignInNotice(location: Location, history: History): SignInNotice | 'signed_in' | null {
  const params = new URLSearchParams(location.search);
  const [code, issuer, subject] = ['signin', 'issuer', 'subject'].map(name => params.get(name));
  if (code === null) return null;
  history.replaceState(history.state, '', location.pathname);
  if (code === 'not_member') return { code, issuer: issuer ?? '', subject: subject ?? '' };
  return code === 'ok' ? 'signed_in' : { code: code === 'unconfigured' ? 'unconfigured' : 'failed' };
}

/** Same-origin POST with the CSRF header; a refusal throws the error envelope's message, else the status. */
export async function post(path: string, body?: unknown): Promise<Response> {
  const token = csrfToken();
  const headers: Record<string, string> = { ...(token === undefined ? {} : { 'x-csrf-token': decodeURIComponent(token) }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  const response = await fetch(path, { method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? `HTTP ${response.status}`);
  return response;
}

/** End meeting with the fence of the audio this page captured (none after a reload); a website-only route, so it is not in the SDK. */
export async function endMeeting(meeting_id: string, fence: { readonly epoch_id: string; readonly sample: number } | null): Promise<void> {
  await post(`/api/v1/meetings/${meeting_id}/end`, fence === null ? {} : { epoch_id: fence.epoch_id, fence_sample: fence.sample });
}

/** Revokes this browser's session on the server; the issuer's own session is left alone (plan 4.3). */
export async function signOut(): Promise<void> {
  await post('/auth/logout');
}

/** Starts linking another issuer identity to the signed-in principal by navigating to the issuer. */
export async function connectSignIn(): Promise<void> {
  const { url } = (await (await post('/auth/link')).json()) as { url: string };
  window.location.assign(url);
}
