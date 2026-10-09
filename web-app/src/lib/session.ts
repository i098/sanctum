/**
 * Website sign-in state over the server's `/auth` routes (sign-in plan section 4.3) and
 * `GET /api/v1/session`. Sign-in always starts with a same-origin navigation, never a cross-origin
 * form post: the page CSP allows only `form-action 'self'`.
 */
import { type AccessScope, createClient, type SanctumClient, SanctumError } from '@sanctum/sdk';

/** The session opener's script-readable double-submit cookie, echoed as `x-csrf-token`; none before sign-in. */
export function csrfHeader(): Record<string, string> {
  const token = globalThis.document?.cookie.split('; ').find((pair) => pair.startsWith('sanctum_csrf='))?.slice('sanctum_csrf='.length);
  return token === undefined ? {} : { 'x-csrf-token': decodeURIComponent(token) };
}

/** Same-origin v1 client: the session cookie authenticates every call, and mutations carry the CSRF header. */
export function sessionClient(): SanctumClient {
  return createClient({
    baseUrl: window.location.origin,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(csrfHeader())) headers.set(name, value);
      return fetch(input, { ...init, headers });
    },
  });
}

export const SIGN_IN_URL = '/auth/login?return_to=/';

/**
 * `issuer`: `GET /auth/config` reports a complete sign-in issuer. Without one, a session can only
 * come from the operator's login link. A server without the route counts as not configured.
 */
export type SignInState =
  | { status: 'signed_in'; access: AccessScope; issuer: boolean }
  | { status: 'checking' | 'unconfigured' | 'signed_out' | 'unavailable' };

/** How the last sign-in redirect ended (`/?signin=<code>`), read once from the landing URL. */
export type SignInNotice = { code: 'not_member'; issuer: string; subject: string } | { code: 'failed' | 'unconfigured' };

/** `false`: no route, a non-JSON body (a server before the route may answer with the SPA index) or a 4xx; `'unavailable'`: network error or 5xx. */
async function configured(): Promise<boolean | 'unavailable'> {
  try {
    const response = await fetch('/auth/config', { headers: { accept: 'application/json' } });
    if (response.status >= 500) return 'unavailable';
    return response.ok && (await response.json()).sign_in === true;
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

export async function readSignIn(client: SanctumClient): Promise<SignInState> {
  const [issuer, current] = await Promise.all([configured(), session(client)]);
  if (typeof current === 'object') return { status: 'signed_in', access: current, issuer: issuer !== false };
  if (current === 'unavailable' || issuer === 'unavailable') return { status: 'unavailable' };
  return { status: issuer ? current : 'unconfigured' };
}

/** Clears the query off the address bar so a reload does not repeat the notice; the callback lands on `/`. */
export function takeSignInNotice(location: Location, history: History): SignInNotice | null {
  const params = new URLSearchParams(location.search);
  const [code, issuer, subject] = ['signin', 'issuer', 'subject'].map(name => params.get(name));
  if (code === null) return null;
  history.replaceState(history.state, '', location.pathname);
  if (code === 'not_member') return { code, issuer: issuer ?? '', subject: subject ?? '' };
  return { code: code === 'unconfigured' ? 'unconfigured' : 'failed' };
}

async function post(path: string): Promise<Response> {
  const response = await fetch(path, { method: 'POST', headers: csrfHeader() });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
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
